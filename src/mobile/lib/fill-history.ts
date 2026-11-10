// src/mobile/lib/fill-history.ts — 帳戶頁「成交明細」的資料轉換與統整（純函式；卡片在 components/account/fill-history-card.tsx）
//
// 資料來源（兩家券商不同）：
// - 玉山：esunTradeService.fetchTransactions（bridge GET /esun/portfolio/profit-loss＝sdk.get_transactions_by_date 的
//   全部成交列，含買進與未實現）。fromEsunDetails 把每列（mat_sums）的逐筆成交（mat_dats）攤平成 FillRecord；
//   手續費、交易稅、證所稅、融券手續費、淨收付都是券商給的值（estimated: false）。
// - 永豐：Shioaji 沒有歷史成交 API，只有今日委託回報裡的成交（order-fills 的 collectDealRows）。fromSinopacDeals
//   只取股票，手續費與交易稅為估算（estimated: true）：
//     手續費＝stockFeeBreakdown(價金, { odd }, 永豐設定).charged（每筆成交各自套最低手續費，可能略高於券商實收）；
//     賣出交易稅＝價金 × sellTaxRate(合約, now)（一般稅率；沒有合約代碼時 0.3%）。不判斷現股當沖減半、不估融券手續費，
//     已實現損益一律 null。券商未提供逐筆明細的差額列（價格未知）不列入。
//
// 淨收付（net）：收為正、付為負。
// - 玉山逐筆有 pay_n 時取其絕對值，賣出為正、買進為負（pay_n 本身的正負號在 bridge／SDK 文件沒有明確定義，故不依賴）；
//   沒有時以價金與費稅推算：賣＝價金 − 手續費 − 交易稅 − 其他費用；買＝−(價金＋手續費)。
//   信用交易（融資、融券）的實際交割金額另含融資金額／保證金，pay_n 為券商值；推算值只是現股公式，僅供參考。
// - 永豐一律用推算公式。
//
// 已實現損益：玉山的「已實現列」（與已實現損益卡片同一個 isEsunRealizedTransaction 判斷：一般賣出、融券買回、
// 信用當沖）才有值；逐筆有 make 用逐筆值，整列逐筆都沒有時把列的 make 記在第一筆（避免多筆重複計入）。其餘為 null。

import type { EsunTransactionDetail } from '../../lib/esun';
import { isOddLot } from '../../lib/odd-lot';
import { stockFeeBreakdown, type TradingCostSettings } from '../../lib/trading-cost-settings';
import { priceCents, stockSellTax } from '../../lib/utils/contract-cost';
import { sellTaxRate } from './day-trade-tax';
import type { DealRow } from './order-fills';

export type FillBroker = 'esun' | 'sinopac';

export interface FillRecord {
    broker: FillBroker;
    /** 成交日（台北，YYYY-MM-DD） */
    tradeDate: string;
    /** 成交時間 HH:MM:SS；券商未提供為 null */
    time: string | null;
    code: string;
    /** 商品名稱；未知為 ''（卡片再查合約快取） */
    name: string;
    action: 'Buy' | 'Sell';
    /** 現股／融資／融券／信用當沖… */
    tradeTypeLabel: string;
    price: number;
    shares: number;
    /** 價金 */
    amount: number;
    fee: number;
    /** 交易稅 */
    tax: number;
    /** 證所稅＋融券手續費 */
    otherFees: number;
    /** 淨收付：收為正、付為負 */
    net: number;
    realizedPnl: number | null;
    /** 委託書號 */
    orderNo: string;
    /** 費稅（與淨收付）是否為估算 */
    estimated: boolean;
}

const fin = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const n0 = (v: number | null | undefined): number => fin(v) ?? 0;

/** 依價金與費稅推算淨收付（賣＝價金 − 費稅；買＝−(價金＋手續費)） */
function derivedNet(action: 'Buy' | 'Sell', amount: number, fee: number, tax: number, otherFees: number): number {
    return action === 'Sell' ? amount - fee - tax - otherFees : -(amount + fee);
}

/** 玉山成交明細（每列＋逐筆）→ 攤平的 FillRecord；沒有買賣別的列略過 */
export function fromEsunDetails(details: readonly EsunTransactionDetail[]): FillRecord[] {
    const out: FillRecord[] = [];
    for (const d of details) {
        const rowPnl = d.realized ? fin(d.realizedPnl) : null;
        const fills = d.fills.length > 0 ? d.fills : [null];
        const fillHasPnl = d.fills.some(f => fin(f.realizedPnl) !== null);
        fills.forEach((f, i) => {
            const action = f?.action ?? d.action;
            if (!action) return;
            const price = n0(f ? f.price : d.avgPrice);
            const shares = n0(f ? f.shares : d.shares);
            const amount = fin(f ? f.priceQty : d.priceQty) ?? price * shares;
            const fee = n0(f?.fee);
            const tax = n0(f?.tax);
            const otherFees = n0(f?.capitalGainsTax) + n0(f?.shortFee);
            const pay = fin(f?.netAmount);
            const net = pay !== null ? (action === 'Sell' ? Math.abs(pay) : -Math.abs(pay)) : derivedNet(action, amount, fee, tax, otherFees);
            let realizedPnl: number | null = null;
            if (d.realized) realizedPnl = fillHasPnl ? fin(f?.realizedPnl) : (i === 0 ? rowPnl : null);
            out.push({
                broker: 'esun',
                tradeDate: f?.tradeDate || d.tradeDate,
                time: f?.tradeTime || null,
                code: d.code || f?.code || '',
                name: d.name || f?.name || '',
                action,
                tradeTypeLabel: d.tradeTypeLabel || f?.tradeTypeLabel || '',
                price,
                shares,
                amount,
                fee,
                tax,
                otherFees,
                net,
                realizedPnl,
                orderNo: f?.orderNo ?? '',
                estimated: false,
            });
        });
    }
    return out;
}

const CREDIT_LABEL: Record<string, string> = {
    MarginTrading: '融資',
    ShortSelling: '融券',
    SBLShort: '借券賣出',
    SBLShortPriceExempt: '借券賣出',
};

function isStockContract(securityType: unknown): boolean {
    return securityType !== 'FUT' && securityType !== 'OPT' && securityType !== 'IND';
}

/** 秒或毫秒 → 台北 { date: YYYY-MM-DD, time: HH:MM:SS }；≤ 0 回 null */
function taipeiDateTime(ts: number): { date: string; time: string } | null {
    if (!(ts > 0) || !Number.isFinite(ts)) return null;
    const ms = ts > 1e12 ? ts : ts * 1000;
    const iso = new Date(ms + 8 * 3600_000).toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

export interface SinopacFillOptions {
    /** 永豐的交易成本設定（useBrokerCostSettings().sinopac） */
    settings: TradingCostSettings;
    /** 稅率判斷與「今天」的時間（ms） */
    now: number;
}

/** 永豐今日成交（collectDealRows 的列）→ FillRecord（只取股票；費稅為估算） */
export function fromSinopacDeals(rows: readonly DealRow[], opts: SinopacFillOptions): FillRecord[] {
    const today = taipeiDateTime(opts.now)!.date;
    const out: FillRecord[] = [];
    for (const r of rows) {
        const { trade } = r;
        if (!isStockContract(trade.contract?.security_type)) continue;
        if (r.price === null || !(r.price > 0) || !(r.quantity > 0)) continue;
        const action = trade.order.action === 'Sell' ? 'Sell' : 'Buy';
        const odd = isOddLot(trade.order.order_lot);
        const shares = r.quantity * (odd ? 1 : 1000);
        const cents = priceCents(r.price) * shares;
        const amount = cents / 100;
        const fee = stockFeeBreakdown(cents, { odd }, opts.settings).charged;
        const code = String(trade.contract?.code ?? '');
        const rate = code ? sellTaxRate({ code, security_type: trade.contract.security_type }, opts.now) : 0.003;
        const tax = action === 'Sell' ? stockSellTax(cents, rate) : 0;
        const at = taipeiDateTime(r.ts);
        const own = (trade.contract as { name?: unknown } | undefined)?.name;
        const cond = trade.order.order_cond;
        const tradeTypeLabel = trade.order.daytrade_short ? '當沖先賣' : (cond && CREDIT_LABEL[cond]) || '現股';
        out.push({
            broker: 'sinopac',
            tradeDate: at?.date ?? today,
            time: at?.time ?? null,
            code,
            name: typeof own === 'string' ? own.trim() : '',
            action,
            tradeTypeLabel,
            price: r.price,
            shares,
            amount,
            fee,
            tax,
            otherFees: 0,
            net: derivedNet(action, amount, fee, tax, 0),
            realizedPnl: null,
            orderNo: String(trade.order.ordno || trade.order.id || ''),
            estimated: true,
        });
    }
    return out;
}

export interface FillTotals {
    count: number;
    buyShares: number;
    buyAmount: number;
    sellShares: number;
    sellAmount: number;
    fee: number;
    tax: number;
    otherFees: number;
    net: number;
    /** 有值的已實現損益加總；全部沒有時 null */
    realizedPnl: number | null;
    /** 含估算值 */
    estimated: boolean;
}

export function fillTotals(records: readonly FillRecord[]): FillTotals {
    const t: FillTotals = {
        count: 0, buyShares: 0, buyAmount: 0, sellShares: 0, sellAmount: 0,
        fee: 0, tax: 0, otherFees: 0, net: 0, realizedPnl: null, estimated: false,
    };
    for (const r of records) {
        t.count += 1;
        if (r.action === 'Buy') {
            t.buyShares += r.shares;
            t.buyAmount += r.amount;
        } else {
            t.sellShares += r.shares;
            t.sellAmount += r.amount;
        }
        t.fee += r.fee;
        t.tax += r.tax;
        t.otherFees += r.otherFees;
        t.net += r.net;
        if (r.realizedPnl !== null) t.realizedPnl = (t.realizedPnl ?? 0) + r.realizedPnl;
        if (r.estimated) t.estimated = true;
    }
    return t;
}

export interface StockSummary extends FillTotals {
    code: string;
    name: string;
}

export interface DateSummary extends FillTotals {
    date: string;
}

/** 依股票統整（每檔一列，依 |淨收付| 由大到小；相同時依代碼） */
export function summarizeByStock(records: readonly FillRecord[]): StockSummary[] {
    const groups = new Map<string, FillRecord[]>();
    for (const r of records) {
        const list = groups.get(r.code);
        if (list) list.push(r);
        else groups.set(r.code, [r]);
    }
    return [...groups.entries()]
        .map(([code, list]) => ({ code, name: list.find(r => r.name)?.name ?? '', ...fillTotals(list) }))
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.code.localeCompare(b.code));
}

/** 依交易日統整（每日一列，日期新的在前） */
export function summarizeByDate(records: readonly FillRecord[]): DateSummary[] {
    const groups = new Map<string, FillRecord[]>();
    for (const r of records) {
        const list = groups.get(r.tradeDate);
        if (list) list.push(r);
        else groups.set(r.tradeDate, [r]);
    }
    return [...groups.entries()]
        .map(([date, list]) => ({ date, ...fillTotals(list) }))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 明細排序：日期新的在前；同日依時間新到舊，沒有時間的排在後面（保持原順序） */
export function sortFillRecords(records: readonly FillRecord[]): FillRecord[] {
    return records
        .map((r, i) => ({ r, i }))
        .sort((a, b) => {
            if (a.r.tradeDate !== b.r.tradeDate) return a.r.tradeDate < b.r.tradeDate ? 1 : -1;
            const ta = a.r.time ?? '';
            const tb = b.r.time ?? '';
            if (ta !== tb) {
                if (!ta) return 1;
                if (!tb) return -1;
                return ta < tb ? 1 : -1;
            }
            return a.i - b.i;
        })
        .map(x => x.r);
}

/** 已排序的明細依交易日分組（保持順序） */
export function groupFillsByDate(sorted: readonly FillRecord[]): { date: string; records: FillRecord[] }[] {
    const out: { date: string; records: FillRecord[] }[] = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && last.date === r.tradeDate) last.records.push(r);
        else out.push({ date: r.tradeDate, records: [r] });
    }
    return out;
}
