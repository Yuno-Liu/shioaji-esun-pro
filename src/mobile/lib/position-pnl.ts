// src/mobile/lib/position-pnl.ts — 股票持倉的含費稅淨損益與損益兩平價（純函式）
//
// 費率一律重用既有計算，不另寫常數：
// - 手續費：與下單面板同一套 trading-cost-settings 的 stockFeeBreakdown(...).net（每筆委託最低整股 20、零股 1）：
//   成交即折＝max(最低, 牌告 0.1425% × 折數)；月退＝交割收 max(最低, 牌告)，退佣後淨額 round(交割手續費 × 折數)。
//   最低手續費生效時兩者不同（月退的最低 20 元也會退佣），所以依使用者設定的退佣方式計算。
//   有券商實際收取的手續費（例如玉山明細）時優先使用；月退設定下再扣 feeRebate 的預估退佣（＝月退淨額）。
//   另輸出交割收取額（openFeeCharged、close.feeCharged）與預估退佣（openRebate、close.rebate、rebate），
//   供畫面顯示「已含預估退佣」；淨損益與兩平價只用淨額，與退佣欄位無關。
// - 證交稅：stockTaxRate（一般 0.3%、ETF／權證 0.1%、債券 ETF 停徵期間 0）；現股當沖的部分用 day-trade-tax（0.15%）。
// - 借券費：shortSellingFee（設定的借券費率 × 賣出價金）；融資利息：marginFinancing＋marginInterestDays＋marginInterest。
//   「以現價平倉」＝今天賣出，利息計到賣出交割日（T+2，sellSettlementYmd）而不是今天；營業日以台北日期的週一至週五推算、
//   週末順延，沒有國定假日資料（遇假日實際天數會較多，明細面板註明）。
//   分批缺成交價時以持倉均價估算（interestStatus 'estimated'）；缺股數時無法計算（'incomplete'，未含利息）。
// - 跳動價位：lib/utils/ticksize 的 tickSizeFor／stepPrice。
// 金額以「分」整數計算（價格 × 100 × 股數），費稅為整數元；對外的淨損益四捨五入到元。
//
// 部位與公式（S＝股數、P＝價格）：
// - 現股／融資多單：成本＝買進價金＋買進手續費；淨損益＝P × S − 賣出手續費 − 賣出證交稅 − 成本 − 融資利息。
//   今天買進、尚未沖銷的股數（可當沖的一般股票）在今天還能沖銷時（台北 13:30 前）賣出稅率用 0.15%，其餘用一般稅率；
//   收盤後今天買進的股數最早下一交易日才能賣，回到一般稅率（closed）。融資（資券當沖）不減半。
// - 融券／現股當沖空單：賣出淨額＝賣出價金 − 賣出手續費 − 賣出證交稅（已發生）；
//   淨損益＝賣出淨額 − (P × S ＋ 回補手續費) − 借券費（只有融券）。現股當沖空單的賣出稅率依當沖規則；
//   收盤後仍未回補（uncovered）就不是當沖，賣出稅以一般稅率估算。
// - 損益兩平價：多單＝淨損益 ≥ 0 的最低合法跳動價位；空單＝淨損益 ≥ 0 的最高合法跳動價位。
//   先以代數解（含最低手續費折點）估計，再取到跳動價位，並逐檔驗證：多單 ≥0 且前一檔 <0；空單 ≥0 且後一檔 <0。
// - 賣出／回補以兩筆委託估算：整張部分一筆（最低 20 元）、零股部分一筆（最低 1 元）。

import { isOddLot, SHARES_PER_LOT } from '../../lib/odd-lot';
import {
    feeRebate,
    marginFinancing,
    marginInterest,
    marginInterestDays,
    shortSellingFee,
    stockFeeBreakdown,
    type TradingCostSettings,
} from '../../lib/trading-cost-settings';
import type { ContractInfo } from '../../lib/types/contract';
import type { Trade } from '../../lib/types/order';
import { priceCents, STOCK_FEE_RATE, stockSellTax } from '../../lib/utils/contract-cost';
import { stepPrice, tickSizeFor } from '../../lib/utils/ticksize';
import { dayTradeHalfTaxActive, dayTradeSellTaxRate, dayTradeSessionOpen, isGeneralStock, sellTaxRate, type TaxContract } from './day-trade-tax';

export type StockPnlKind = 'cash' | 'margin' | 'short' | 'dayShort';

export type PnlContract = TaxContract & Pick<ContractInfo, 'exchange' | 'target_code'> & Partial<Pick<ContractInfo, 'day_trade'>>;

/**
 * 當沖稅率的判斷結果：
 * - applied：有今日買進（或當沖空單）的股數以 0.15% 計（只在台北 13:30 前）
 * - none：已確認今天沒有可當沖的買進
 * - closed：今日已收盤（13:30 後），今天買進的股數最早下一交易日才能賣 → 一般稅率
 * - uncovered：收盤後仍未回補的現股當沖空單 → 不是當沖，賣出稅以一般稅率估算
 * - unknown：取不到成交日 → 全部用一般稅率（畫面標示「未判斷當沖」）
 * - noDayTrade：此股票不可當沖
 * - notReduced：ETF、權證、債券 ETF，或減半已期滿 → 一般稅率
 * - na：融資、融券（資券當沖不適用減半）
 */
export type DayTradeStatus = 'applied' | 'none' | 'closed' | 'uncovered' | 'unknown' | 'noDayTrade' | 'notReduced' | 'na';

/**
 * 融資利息：
 * - included：已計入（各批成交日、價格、股數齊全）
 * - estimated：已計入但為估算（有分批缺成交價以均價計，或分批股數合計與持倉不符；見 interestGaps）
 * - incomplete：有分批缺股數，無法計算 → 未含
 * - noRate：未設定年利率；noDate：取不到成交日（或該市場不可融資）；na：非融資
 */
export type InterestStatus = 'included' | 'estimated' | 'incomplete' | 'noRate' | 'noDate' | 'na';

/** 利息估算的原因：missingPrice 分批缺成交價（以均價計）；sharesMismatch 分批股數合計與持倉股數不同 */
export type InterestGap = 'missingPrice' | 'sharesMismatch';

export interface MarginLot {
    /** 成交日 YYYY-MM-DD（台北） */
    tradeDate: string;
    /** 成交價；缺資料為 null（以均價估算） */
    price: number | null;
    /** 股數；缺資料為 null（無法計算利息） */
    shares: number | null;
}

export interface StockPnlInput {
    kind: StockPnlKind;
    /** 股數（> 0） */
    shares: number;
    /** 均價（元） */
    avgPrice: number;
    /** 現價；沒有時淨損益為 null（兩平價仍可算） */
    lastPrice: number | null | undefined;
    contract: PnlContract;
    settings: TradingCostSettings;
    /** 計算時點（epoch ms），決定稅率期間與「今天」 */
    now: number;
    /** 現股多單：今天買進且仍在部位內、尚未當日沖銷的股數；null＝取不到 */
    todayShares: number | null;
    /** 券商實際資料（元）；有就優先使用 */
    actual?: {
        /** 開倉價金（買進或賣出價金） */
        openNotional?: number | null;
        /** 開倉時券商收取的手續費（月退設定下為牌告；會再扣預估退佣） */
        openFee?: number | null;
        /** 開倉證交稅（空單的賣出稅） */
        openTax?: number | null;
    };
    /** 融資：各批成交日、價格、股數（算利息）；null 或空＝取不到成交日 */
    marginLots?: readonly MarginLot[] | null;
}

export interface StockPnlClose {
    price: number;
    /** 平倉價金（元，四捨五入） */
    notional: number;
    /** 平倉手續費（元；多單為賣出、空單為回補；月退為退佣後淨額） */
    fee: number;
    /** 平倉手續費的交割收取額（元；月退＝牌告，成交即折＝fee） */
    feeCharged: number;
    /** 平倉手續費的預估退佣（元；成交即折或無折扣為 0） */
    rebate: number;
    /** 平倉證交稅（元；空單回補為 0） */
    tax: number;
}

export interface StockPnl {
    kind: StockPnlKind;
    side: 'long' | 'short';
    shares: number;
    feeDiscount: number;
    /** 退佣方式（手續費依此計算） */
    rebateMode: TradingCostSettings['rebateMode'];
    /** 開倉價金（元，四捨五入） */
    openNotional: number;
    /** 開倉手續費（元，已扣預估退佣） */
    openFee: number;
    /** 開倉手續費的交割收取額（元；月退＝牌告或券商實收，成交即折＝openFee） */
    openFeeCharged: number;
    /** 開倉手續費的預估退佣（元；成交即折或無折扣為 0） */
    openRebate: number;
    openFeeEstimated: boolean;
    /** 開倉證交稅（空單；多單為 0） */
    openTax: number;
    openTaxEstimated: boolean;
    /** 借券費（只有融券；其他 null） */
    borrowFee: number | null;
    /** 融資利息（included／estimated 時有值） */
    interest: number | null;
    interestStatus: InterestStatus;
    /** 利息估算的原因（estimated 時非空） */
    interestGaps: readonly InterestGap[];
    /** 利息計到的日期＝以現價賣出的交割日 YYYY-MM-DD（融資才有；週末順延、未計國定假日） */
    interestUntil: string | null;
    /** 一般賣出稅率 */
    taxRate: number;
    /** 當沖賣出稅率（套用時） */
    dayTradeRate: number;
    /** 以當沖稅率計的股數 */
    dayTradeShares: number;
    dayTrade: DayTradeStatus;
    /** 現價平倉的試算；沒有現價為 null */
    close: StockPnlClose | null;
    /** 淨損益（元，四捨五入）；沒有現價為 null */
    net: number | null;
    /** 預估退佣合計（openRebate ＋ close.rebate，已含在 net 內）；沒有現價為 null */
    rebate: number | null;
    /** 淨損益（分，未四捨五入；兩平驗證用） */
    netCents: number | null;
    /** 多單：成本（價金＋手續費）；空單：賣出淨額（價金 − 手續費 − 稅） */
    basis: number;
    breakEven: number | null;
}

const MAX_TICK_STEPS = 2000;

/** 台北日期 YYYY-MM-DD */
export function taipeiYmd(ms: number): string {
    const d = new Date(ms + 8 * 3_600_000);
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const DAY_MS = 86_400_000;
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

/** 1970-01-01 起的日序號是否為週六、週日（1970-01-01 為週四） */
const isWeekendDay = (day: number): boolean => {
    const wd = (((day + 4) % 7) + 7) % 7;
    return wd === 0 || wd === 6;
};

/**
 * 以現價賣出（今天成交）的交割日 YYYY-MM-DD：台北日期起算第 2 個營業日（T+2）。
 * 營業日以週一至週五估算：今天是週末時賣出日順延到下週一，交割日遇週末也順延；沒有國定假日資料（未計入）。
 */
export function sellSettlementYmd(now: number): string {
    let day = Math.floor((now + TAIPEI_OFFSET_MS) / DAY_MS);
    while (isWeekendDay(day)) day += 1;
    let left = 2;
    while (left > 0) {
        day += 1;
        if (!isWeekendDay(day)) left -= 1;
    }
    return taipeiYmd(day * DAY_MS - TAIPEI_OFFSET_MS);
}

/** 往上取到跳動價位（ticksize 的級距；跨級距時以該價位所在級距取整） */
export function ceilToTick(contract: PnlContract, price: number): number {
    const tick = tickSizeFor(contract, price);
    return Number((Math.ceil(price / tick - 1e-9) * tick).toFixed(2));
}

/** 往下取到跳動價位 */
export function floorToTick(contract: PnlContract, price: number): number {
    const tick = tickSizeFor(contract, price);
    return Number((Math.floor(price / tick + 1e-9) * tick).toFixed(2));
}

/** 整張與零股拆成兩筆委託（各自最低手續費） */
function splitShares(shares: number): { whole: number; odd: number } {
    const whole = Math.floor(shares / SHARES_PER_LOT) * SHARES_PER_LOT;
    return { whole, odd: shares - whole };
}

export function computeStockPnl(input: StockPnlInput): StockPnl | null {
    const { kind, contract: c, settings, now } = input;
    const S = input.shares;
    if (!Number.isSafeInteger(S) || S <= 0 || !finite(input.avgPrice) || input.avgPrice <= 0) return null;
    const discount = settings.feeDiscount;
    const side: 'long' | 'short' = kind === 'cash' || kind === 'margin' ? 'long' : 'short';
    const { whole, odd } = splitShares(S);
    /** 單筆委託的實際手續費（依退佣方式；月退為退佣後淨額），與下單面板相同 */
    const fee = (cents: number, isOdd: boolean) => stockFeeBreakdown(cents, { odd: isOdd }, settings).net;
    /** 以價格 P（分）成交 S 股的兩筆委託手續費 */
    const tradeFee = (pc: number) => fee(pc * whole, false) + fee(pc * odd, true);
    /** 兩筆委託的交割收取額與預估退佣（顯示用；淨額＝charged − rebate＝tradeFee） */
    const tradeFeeParts = (wholeC: number, oddC: number) => {
        const a = stockFeeBreakdown(wholeC, { odd: false }, settings);
        const b = stockFeeBreakdown(oddC, { odd: true }, settings);
        return { charged: a.charged + b.charged, rebate: a.rebate + b.rebate };
    };

    // ---- 稅率與當沖 ----
    const taxRate = sellTaxRate(c, now);
    const dtRate = dayTradeSellTaxRate(c, now);
    const sessionOpen = dayTradeSessionOpen(now);
    let dayTrade: DayTradeStatus;
    let dtShares = 0;
    if (kind === 'margin' || kind === 'short') dayTrade = 'na';
    else if (kind === 'dayShort' && !sessionOpen) dayTrade = 'uncovered';
    else if (!isGeneralStock(c) || !dayTradeHalfTaxActive(now)) dayTrade = 'notReduced';
    else if (kind === 'dayShort') { dayTrade = 'applied'; dtShares = S; }
    else if (input.todayShares === 0) dayTrade = 'none';
    else if (!sessionOpen) dayTrade = 'closed';
    else if (input.todayShares === null || !finite(input.todayShares)) dayTrade = 'unknown';
    else if (input.todayShares <= 0) dayTrade = 'none';
    else if (c.day_trade === 'Yes' || c.day_trade === 'OnlyBuy') { dayTrade = 'applied'; dtShares = Math.min(S, Math.floor(input.todayShares)); }
    else if (c.day_trade === 'No') dayTrade = 'noDayTrade';
    else dayTrade = 'unknown';

    // ---- 開倉 ----
    const actualNotional = input.actual?.openNotional;
    const openCents = finite(actualNotional) && actualNotional > 0
        ? Math.round(Math.abs(actualNotional) * 100)
        : Math.round(input.avgPrice * S * 100);
    const wholeCents = whole > 0 ? Math.min(openCents, Math.round((openCents * whole) / S)) : 0;
    const oddCents = openCents - wholeCents;
    const actualFee = input.actual?.openFee;
    const openFeeEstimated = !(finite(actualFee) && actualFee >= 0);
    const openFee = openFeeEstimated
        ? fee(wholeCents, false) + fee(oddCents, true)
        : Math.abs(actualFee!) - feeRebate(Math.abs(actualFee!), settings);
    const openParts = openFeeEstimated
        ? tradeFeeParts(wholeCents, oddCents)
        : { charged: Math.abs(actualFee!), rebate: feeRebate(Math.abs(actualFee!), settings) };
    let openTax = 0;
    let openTaxEstimated = false;
    if (side === 'short') {
        const actualTax = input.actual?.openTax;
        openTaxEstimated = !(finite(actualTax) && actualTax >= 0);
        openTax = openTaxEstimated
            ? stockSellTax(Math.round((openCents * dtShares) / S), dtRate) + stockSellTax(openCents - Math.round((openCents * dtShares) / S), taxRate)
            : Math.abs(actualTax!);
    }
    const borrowFee = kind === 'short' ? shortSellingFee(openCents, settings) : null;

    // ---- 融資利息 ----
    let interest: number | null = null;
    let interestStatus: InterestStatus = 'na';
    const interestGaps: InterestGap[] = [];
    const interestUntil = kind === 'margin' ? sellSettlementYmd(now) : null;
    if (kind === 'margin') {
        if (settings.marginAnnualRate === null) interestStatus = 'noRate';
        else if (!input.marginLots?.length) interestStatus = 'noDate';
        else {
            let sum = 0;
            let lotShares = 0;
            let status: InterestStatus = 'included';
            for (const lot of input.marginLots) {
                // 缺股數：無法得知融資金額 → 不猜，整筆未含利息
                const rawShares = lot.shares;
                if (!finite(rawShares) || rawShares === 0) { status = 'incomplete'; break; }
                const shares = Math.abs(rawShares);
                const lotPrice = lot.price;
                const priceKnown = finite(lotPrice) && lotPrice > 0;
                const price = priceKnown ? lotPrice : input.avgPrice;
                if (!priceKnown && !interestGaps.includes('missingPrice')) interestGaps.push('missingPrice');
                const financing = marginFinancing(priceCents(price) * shares, c.exchange);
                const days = marginInterestDays(lot.tradeDate, interestUntil!);
                const v = financing && days !== null ? marginInterest(financing.financed, days, settings) : null;
                if (v === null) { status = 'noDate'; break; }
                sum += v;
                lotShares += shares;
            }
            if (status === 'included') {
                if (lotShares !== S) interestGaps.push('sharesMismatch');
                interest = sum;
                interestStatus = interestGaps.length ? 'estimated' : 'included';
            } else {
                interestGaps.length = 0;
                interestStatus = status;
            }
        }
    }

    // ---- 淨損益（分）----
    const dtPart = (pc: number) => stockSellTax(pc * dtShares, dtRate) + stockSellTax(pc * (S - dtShares), taxRate);
    const closeOf = (price: number): Omit<StockPnlClose, 'feeCharged' | 'rebate'> & { netCents: number } => {
        const pc = priceCents(price);
        const closeFee = tradeFee(pc);
        if (side === 'long') {
            const tax = dtPart(pc);
            const netCents = pc * S - (closeFee + tax) * 100 - openCents - (openFee + (interest ?? 0)) * 100;
            return { price, notional: Math.round((pc * S) / 100), fee: closeFee, tax, netCents };
        }
        const netCents = openCents - (openFee + openTax + (borrowFee ?? 0)) * 100 - pc * S - closeFee * 100;
        return { price, notional: Math.round((pc * S) / 100), fee: closeFee, tax: 0, netCents };
    };
    const netCentsAt = (price: number) => closeOf(price).netCents;

    const basis = side === 'long'
        ? Math.round(openCents / 100) + openFee
        : Math.round(openCents / 100) - openFee - openTax;

    let close: StockPnlClose | null = null;
    let net: number | null = null;
    let netCents: number | null = null;
    let rebate: number | null = null;
    if (finite(input.lastPrice) && input.lastPrice > 0) {
        const r = closeOf(input.lastPrice);
        const pc = priceCents(input.lastPrice);
        const parts = tradeFeeParts(pc * whole, pc * odd);
        close = { price: r.price, notional: r.notional, fee: r.fee, feeCharged: parts.charged, rebate: parts.rebate, tax: r.tax };
        netCents = r.netCents;
        net = Math.round(r.netCents / 100) || 0; // 避免 -0
        rebate = openParts.rebate + parts.rebate;
    }

    // ---- 損益兩平價 ----
    const fd = STOCK_FEE_RATE * discount;
    // 最低手續費的實際淨額（月退時最低費也會退佣）：以 1 分價金求得
    const minFees = (whole > 0 ? fee(1, false) : 0) + (odd > 0 ? fee(1, true) : 0);
    let breakEven: number | null;
    if (side === 'long') {
        const tEff = (dtShares * dtRate + (S - dtShares) * taxRate) / S;
        const k = openCents + (openFee + (interest ?? 0)) * 100;
        // 最低手續費區段與費率區段各解一次，取較大者（fee = max(最低, 費率 × 價金)）
        const n = Math.max((k + minFees * 100) / (1 - tEff), k / (1 - tEff - fd));
        breakEven = searchLong(c, n / (S * 100), netCentsAt);
    } else {
        const k = openCents - (openFee + openTax + (borrowFee ?? 0)) * 100;
        const n = Math.min(k - minFees * 100, k / (1 + fd));
        breakEven = k > 0 ? searchShort(c, n / (S * 100), netCentsAt) : null;
    }

    return {
        kind,
        side,
        shares: S,
        feeDiscount: discount,
        rebateMode: settings.rebateMode,
        openNotional: Math.round(openCents / 100),
        openFee,
        openFeeCharged: openParts.charged,
        openRebate: openParts.rebate,
        openFeeEstimated,
        openTax,
        openTaxEstimated,
        borrowFee,
        interest,
        interestStatus,
        interestGaps,
        interestUntil,
        taxRate,
        dayTradeRate: dtRate,
        dayTradeShares: dtShares,
        dayTrade,
        close,
        net,
        rebate,
        netCents,
        basis,
        breakEven,
    };
}

/** 多單：淨損益 ≥ 0 的最低跳動價位（取整後 ≥0、前一檔 <0） */
function searchLong(c: PnlContract, estimate: number, netAt: (p: number) => number): number | null {
    if (!finite(estimate) || estimate <= 0) return null;
    let p = Math.max(ceilToTick(c, estimate), 0.01);
    let guard = 0;
    while (netAt(p) < 0) {
        if (++guard > MAX_TICK_STEPS) return null;
        p = stepPrice(c, p, 1);
    }
    while (guard++ <= MAX_TICK_STEPS) {
        const down = stepPrice(c, p, -1);
        if (!(down > 0) || netAt(down) < 0) return p;
        p = down;
    }
    return null;
}

/** 空單：淨損益 ≥ 0 的最高跳動價位（取整後 ≥0、後一檔 <0） */
function searchShort(c: PnlContract, estimate: number, netAt: (p: number) => number): number | null {
    if (!finite(estimate)) return null;
    let p = Math.max(floorToTick(c, Math.max(estimate, 0)), 0.01);
    let guard = 0;
    while (netAt(p) < 0) {
        if (++guard > MAX_TICK_STEPS) return null;
        const down = stepPrice(c, p, -1);
        if (!(down > 0)) return null;
        p = down;
    }
    while (guard++ <= MAX_TICK_STEPS) {
        const up = stepPrice(c, p, 1);
        if (netAt(up) < 0) return p;
        p = up;
    }
    return null;
}

/** 兩平價與現價的關係（文字標示用）：多單現價 ≥ 兩平為 above；空單現價 ≤ 兩平為 above（已過兩平） */
export function breakEvenRelation(pnl: Pick<StockPnl, 'side' | 'breakEven'>, last: number | null | undefined): 'profit' | 'loss' | 'even' | null {
    if (pnl.breakEven === null || !finite(last) || last <= 0) return null;
    const d = priceCents(last) - priceCents(pnl.breakEven);
    if (d === 0) return 'even';
    const good = pnl.side === 'long' ? d > 0 : d < 0;
    return good ? 'profit' : 'loss';
}

// ---- 今日成交（成交回報推得當日買進數量）----

type AccountRef = { broker_id?: string; account_id?: string } | null | undefined;

/** 帳戶＋代碼＋信用條件 */
export function fillKey(account: AccountRef, code: string, cond: string | null | undefined): string {
    return `${account?.broker_id ?? ''}|${account?.account_id ?? ''}|${code}|${cond || 'Cash'}`;
}

/** 台北日序號；ts 可為秒、毫秒或奈秒 */
function taipeiDay(ts: number): number {
    const ms = ts > 1e17 ? ts / 1e6 : ts > 1e14 ? ts / 1e3 : ts > 1e11 ? ts : ts * 1000;
    return Math.floor((ms + 8 * 3_600_000) / 86_400_000);
}

export interface TodayFills { buy: number; sell: number }

/**
 * 今天的股票成交股數（依帳戶＋代碼＋信用條件分別加總買、賣）；資料來源為委託查詢＋成交回報（useTradingState().trades）。
 * 整股 × 1000、零股以股計；成交時間不是今天（台北）的略過。
 */
export function todayStockFills(trades: readonly (Trade & { account?: AccountRef })[], now: number): Map<string, TodayFills> {
    const today = taipeiDay(now);
    const out = new Map<string, TodayFills>();
    for (const t of trades) {
        const o = t.order;
        if ((o.action !== 'Buy' && o.action !== 'Sell') || (o.account && o.account.account_type !== 'S')) continue;
        const unit = isOddLot(o.order_lot) ? 1 : SHARES_PER_LOT;
        const key = fillKey(t.account ?? o.account, t.contract.code, o.order_cond);
        for (const d of t.status?.deals ?? []) {
            if (!(d.quantity > 0) || !(d.price > 0)) continue;
            if (d.ts && taipeiDay(d.ts) !== today) continue;
            const e = out.get(key) ?? { buy: 0, sell: 0 };
            if (o.action === 'Buy') e.buy += d.quantity * unit;
            else e.sell += d.quantity * unit;
            out.set(key, e);
        }
    }
    return out;
}

// ---- 持倉列 → 計算輸入 ----

export interface PositionLike {
    code: string;
    direction: 'Buy' | 'Sell' | string;
    quantity: number;
    price: number;
    last_price: number;
    cond?: string;
    account?: AccountRef;
}

/** 玉山庫存明細的必要欄位（lib/esun/account-details 的 EsunInventoryDetail 子集） */
export interface EsunDetailLike {
    tradeType: string;
    costShares: number | null;
    costSum: number | null;
    priceQtySum: number | null;
    todayBuyFilledShares: number | null;
    todaySellFilledShares: number | null;
    lots: readonly { action: 'Buy' | 'Sell' | null; tradeDate: string; price: number | null; shares: number | null; fee: number | null; tax: number | null }[];
}

/** 持倉條件 → 計算種類；不支援（借券等）回 null */
export function stockPnlKindOf(direction: string, cond: string | null | undefined): StockPnlKind | null {
    const c = cond || 'Cash';
    if (c === 'Cash') return direction === 'Buy' ? 'cash' : direction === 'Sell' ? 'dayShort' : null;
    if (c === 'MarginTrading') return direction === 'Buy' ? 'margin' : null;
    if (c === 'ShortSelling') return direction === 'Sell' ? 'short' : null;
    return null;
}

const ESUN_TRADE_TYPE: Record<StockPnlKind, string | null> = { cash: '0', margin: '3', short: '4', dayShort: null };

function sumAll(values: readonly (number | null)[]): number | null {
    if (values.length === 0 || values.some(v => !finite(v))) return null;
    return (values as number[]).reduce((s, v) => s + Math.abs(v), 0);
}

export interface StockPnlContext {
    settings: TradingCostSettings;
    now: number;
    /** todayStockFills 的結果；委託查詢尚未成功時傳 null（取不到成交日） */
    fills: ReadonlyMap<string, TodayFills> | null;
    /** 與這筆持倉對上的玉山庫存明細（沒有為 null） */
    esun?: EsunDetailLike | null;
}

/**
 * 由持倉列組出計算輸入。玉山明細要與持倉同條件、成本股數相同才採用（明細可能是較早的快照）。
 * 今日股數優先順序：玉山分批明細的成交日 → 玉山今日買賣成交股數 → 今日成交回報；都沒有則 null。
 */
export function stockPnlInputOf(p: PositionLike, contract: PnlContract, ctx: StockPnlContext): StockPnlInput | null {
    const kind = stockPnlKindOf(p.direction, p.cond);
    if (!kind) return null;
    const S = Math.abs(p.quantity);
    const today = taipeiYmd(ctx.now);
    const d = ctx.esun && ESUN_TRADE_TYPE[kind] === ctx.esun.tradeType && ctx.esun.costShares !== null && Math.abs(ctx.esun.costShares) === S
        ? ctx.esun
        : null;

    let actual: StockPnlInput['actual'];
    let todayShares: number | null = null;
    let marginLots: MarginLot[] | null = null;
    let dated = false;
    if (d) {
        const openNotional = finite(d.priceQtySum) && d.priceQtySum !== 0 ? Math.abs(d.priceQtySum) : null;
        let openFee = d.lots.length ? sumAll(d.lots.map(l => l.fee)) : null;
        if (openFee === null && kind === 'cash' && openNotional !== null && finite(d.costSum)) {
            const diff = Math.abs(d.costSum) - openNotional;
            if (diff >= 0) openFee = diff;
        }
        const openTax = kind === 'short' && d.lots.length ? sumAll(d.lots.map(l => l.tax)) : null;
        actual = { openNotional, openFee, openTax };
        const datedLots = d.lots.length > 0 && d.lots.every(l => l.tradeDate !== '');
        if (datedLots) {
            dated = true;
            todayShares = d.lots
                .filter(l => l.action === 'Buy' && l.tradeDate === today)
                .reduce((s, l) => s + Math.abs(l.shares ?? 0), 0);
            if (kind === 'margin') {
                // 缺價或缺股數的分批不濾掉：交給 computeStockPnl 標示估算（缺價）或未含（缺股數）
                marginLots = d.lots
                    .filter(l => l.action !== 'Sell')
                    .map(l => ({
                        tradeDate: l.tradeDate,
                        price: finite(l.price) ? l.price : null,
                        shares: finite(l.shares) ? Math.abs(l.shares) : null,
                    }));
            }
        } else if (finite(d.todayBuyFilledShares) && finite(d.todaySellFilledShares)) {
            dated = true;
            todayShares = Math.max(0, d.todayBuyFilledShares - d.todaySellFilledShares);
        }
    }
    if (!dated && ctx.fills) {
        const f = ctx.fills.get(fillKey(p.account, p.code, p.cond));
        todayShares = f ? Math.max(0, f.buy - f.sell) : 0;
    }
    if (todayShares !== null) todayShares = Math.min(S, todayShares);
    // 融資沒有分批成交日時：整筆都是今天買進的才能確定（利息 0）
    if (kind === 'margin' && !marginLots && todayShares !== null && todayShares >= S) {
        marginLots = [{ tradeDate: today, price: p.price, shares: S }];
    }
    return {
        kind,
        shares: S,
        avgPrice: p.price,
        lastPrice: p.last_price,
        contract,
        settings: ctx.settings,
        now: ctx.now,
        todayShares: kind === 'cash' ? todayShares : null,
        ...(actual ? { actual } : {}),
        marginLots,
    };
}
