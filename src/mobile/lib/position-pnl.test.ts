// 持倉含費稅淨損益與損益兩平價：手續費折數與最低手續費折點、證交稅（一般／ETF／權證／債券 ETF）、
// 現股當沖 0.15%（期內／期滿）、部分今日買進、融券借券費、融資利息、兩平價取到跳動價位的上下邊界與檔位交界。
import { describe, expect, it } from 'vitest';
import { DEFAULT_TRADING_COST_SETTINGS, stockFeeBreakdown, type TradingCostSettings } from '../../lib/trading-cost-settings';
import { stepPrice } from '../../lib/utils/ticksize';
import {
    DAY_TRADE_HALF_TAX_UNTIL,
    dayTradeHalfTaxActive,
    dayTradeSellTaxRate,
    dayTradeSessionOpen,
    isGeneralStock,
} from './day-trade-tax';
import {
    breakEvenRelation,
    ceilToTick,
    computeStockPnl,
    fillKey,
    floorToTick,
    sellSettlementYmd,
    stockPnlInputOf,
    stockPnlKindOf,
    taipeiYmd,
    todayStockFills,
    type PnlContract,
    type StockPnlInput,
} from './position-pnl';

// 2026-11-06（週五）10:00 台北
const NOW = Date.parse('2026-11-06T10:00:00+08:00');

const stk = (over: Partial<PnlContract> = {}): PnlContract => ({ code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null, day_trade: 'Yes', ...over });
const etf = stk({ code: '0050' });
const bondEtf = stk({ code: '00679B', exchange: 'OTC' });
const warrant = stk({ code: '030001', security_type: 'WRT', day_trade: 'No' });

const settings = (over: Partial<TradingCostSettings> = {}): TradingCostSettings => ({ ...DEFAULT_TRADING_COST_SETTINGS, ...over });

const input = (over: Partial<StockPnlInput> = {}): StockPnlInput => ({
    kind: 'cash',
    shares: 1000,
    avgPrice: 100,
    lastPrice: 110,
    contract: stk(),
    settings: settings(),
    now: NOW,
    todayShares: 0,
    ...over,
});

const run = (over: Partial<StockPnlInput> = {}) => {
    const r = computeStockPnl(input(over));
    if (!r) throw new Error('computeStockPnl returned null');
    return r;
};

/** 在某價位的淨損益（分） */
const netCentsAt = (over: Partial<StockPnlInput>, price: number) => run({ ...over, lastPrice: price }).netCents!;

/** 兩平價邊界：多單 BE ≥0 且前一檔 <0；空單 BE ≥0 且後一檔 <0 */
function expectBoundary(over: Partial<StockPnlInput>) {
    const r = run(over);
    const c = (over.contract ?? stk());
    expect(r.breakEven).not.toBeNull();
    const be = r.breakEven!;
    expect(netCentsAt(over, be)).toBeGreaterThanOrEqual(0);
    if (r.side === 'long') expect(netCentsAt(over, stepPrice(c, be, -1))).toBeLessThan(0);
    else expect(netCentsAt(over, stepPrice(c, be, 1))).toBeLessThan(0);
    return be;
}

describe('day-trade-tax：證券交易稅條例第 2 條之 1', () => {
    it('一般股票當沖 0.15%，ETF、權證不減半，債券 ETF 停徵期間 0', () => {
        expect(dayTradeSellTaxRate(stk(), NOW)).toBe(0.0015);
        expect(dayTradeSellTaxRate(etf, NOW)).toBe(0.001);
        expect(dayTradeSellTaxRate(stk({ code: '00878' }), NOW)).toBe(0.001);
        expect(dayTradeSellTaxRate(warrant, NOW)).toBe(0.001);
        expect(dayTradeSellTaxRate(bondEtf, NOW)).toBe(0);
        expect(dayTradeSellTaxRate(bondEtf, Date.parse('2027-06-01T10:00:00+08:00'))).toBe(0.001);
        expect(isGeneralStock(stk())).toBe(true);
        expect(isGeneralStock(etf)).toBe(false);
        expect(isGeneralStock(stk({ underlying_kind: 'E' }))).toBe(false);
    });

    it('以台灣時間判斷期滿：2027-12-31 23:59:59 仍減半，2028-01-01 00:00 起回到 0.3%', () => {
        const last = Date.parse('2027-12-31T23:59:59+08:00');
        const end = Date.parse('2028-01-01T00:00:00+08:00');
        expect(DAY_TRADE_HALF_TAX_UNTIL).toBe(end);
        expect(dayTradeHalfTaxActive(last)).toBe(true);
        expect(dayTradeSellTaxRate(stk(), last)).toBe(0.0015);
        expect(dayTradeHalfTaxActive(end)).toBe(false);
        expect(dayTradeSellTaxRate(stk(), end)).toBe(0.003);
        // UTC 已是 2027-12-31 16:00（台北 2028-01-01 00:00）→ 期滿
        expect(dayTradeSellTaxRate(stk(), Date.UTC(2027, 11, 31, 16, 0, 0))).toBe(0.003);
    });
});

describe('跳動價位取整', () => {
    it('往上／往下取到該價位所在級距', () => {
        expect(ceilToTick(stk(), 100.588)).toBe(101);
        expect(floorToTick(stk(), 99.335)).toBe(99.3);
        expect(ceilToTick(stk(), 9.9951)).toBe(10);
        expect(ceilToTick(stk(), 49.97)).toBe(50);
        expect(floorToTick(stk(), 49.99)).toBe(49.95);
        expect(ceilToTick(stk(), 10.02)).toBe(10.05);
        expect(ceilToTick(etf, 150.579)).toBe(150.6);
        expect(ceilToTick(etf, 30.0859)).toBe(30.09);
        expect(ceilToTick(stk(), 101)).toBe(101);
    });
});

describe('手續費：牌告 × 折數、最低手續費整股 20／零股 1', () => {
    it('無折扣：1,000 股 × 100 → 143；現價 110 淨損益 9,370、兩平 101', () => {
        const r = run();
        expect(r.openFee).toBe(143);
        expect(r.openFeeEstimated).toBe(true);
        expect(r.basis).toBe(100_143);
        expect(r.close).toEqual({ price: 110, notional: 110_000, fee: 157, feeCharged: 157, rebate: 0, tax: 330 });
        expect(r.net).toBe(9_370);
        expect(r.breakEven).toBe(101);
        expect(netCentsAt({}, 100.5)).toBeLessThan(0);
        expect(r.dayTrade).toBe('none');
    });

    it('2.8 折成交即折：整股手續費低於 20 元時以 20 計（折點約價金 50,125 元）', () => {
        const d = settings({ feeDiscount: 0.28, rebateMode: 'instant' });
        expect(run({ settings: d, avgPrice: 10 }).openFee).toBe(20); // 3.99 → 20
        expect(run({ settings: d, avgPrice: 50 }).openFee).toBe(20); // 19.95 → 20
        expect(run({ settings: d, avgPrice: 52.6 }).openFee).toBe(21); // 20.99 → 21
        expect(run({ settings: d, avgPrice: 60 }).openFee).toBe(24); // 23.94 → 24
        // 兩平：10 元 × 1,000 股，成本 10,020；10.05 → 10,000（<0）、10.10 → 10,050
        const be = expectBoundary({ settings: d, avgPrice: 10, lastPrice: 10.1 });
        expect(be).toBe(10.1);
        expect(run({ settings: d, avgPrice: 10, lastPrice: 10.1 }).net).toBe(30);
    });

    it('2.8 折月退：交割收 max(20, 牌告)，退佣後淨額 round(交割 × 折數)，最低 20 元也會退佣', () => {
        const d = settings({ feeDiscount: 0.28, rebateMode: 'monthly' });
        expect(run({ settings: d, avgPrice: 10 }).openFee).toBe(6); // 交割 20 → 5.6 → 6
        expect(run({ settings: d, avgPrice: 50 }).openFee).toBe(20); // 交割 71 → 19.88 → 20
        expect(run({ settings: d, avgPrice: 52.6 }).openFee).toBe(21); // 交割 75 → 21
        expect(run({ settings: d, avgPrice: 60 }).openFee).toBe(24); // 交割 86 → 24.08 → 24
        // 兩平：成本 10,006；10.00 → 10,000 − 6 − 30 <0、10.05 → 10,050 − 6 − 30 = 10,014
        expect(expectBoundary({ settings: d, avgPrice: 10, lastPrice: 10.05 })).toBe(10.05);
    });

    it('估算的開倉與平倉手續費＝下單面板的 stockFeeBreakdown(...).net（月退、即折都一致）', () => {
        for (const rebateMode of ['monthly', 'instant'] as const) {
            for (const feeDiscount of [1, 0.6, 0.28]) {
                const st = settings({ feeDiscount, rebateMode });
                for (const [shares, avgPrice, lastPrice] of [[1000, 10, 10.5], [3500, 1052.5, 1085], [37, 23.45, 24], [1001, 10, 9.9]] as const) {
                    const r = run({ settings: st, shares, avgPrice, lastPrice });
                    const whole = Math.floor(shares / 1000) * 1000;
                    const odd = shares - whole;
                    const net = (cents: number, isOdd: boolean) => stockFeeBreakdown(cents, { odd: isOdd }, st).net;
                    const pc = (v: number) => Math.round(v * 100);
                    expect(r.openFee).toBe(net(pc(avgPrice) * whole, false) + net(pc(avgPrice) * odd, true));
                    expect(r.close!.fee).toBe(net(pc(lastPrice) * whole, false) + net(pc(lastPrice) * odd, true));
                    expect(r.rebateMode).toBe(rebateMode);
                }
            }
        }
    });

    it('最低手續費生效時：玉山（券商實際手續費）與永豐（估算）同一部位結果相同', () => {
        // 1,000 股 @10（明細手續費 max(20, 14) = 20），現價 10.50
        const base = { avgPrice: 10, lastPrice: 10.5 };
        const monthly = settings({ feeDiscount: 0.28, rebateMode: 'monthly' });
        const esunM = run({ ...base, settings: monthly, actual: { openNotional: 10_000, openFee: 20 } });
        const sinoM = run({ ...base, settings: monthly });
        // 月退：開倉 6、平倉 6（交割 20 → 5.6）、稅 32 → 10,500 − 6 − 32 − 10,006 = 456，兩平 10.05
        for (const r of [esunM, sinoM]) {
            expect(r.openFee).toBe(6);
            expect(r.close!.fee).toBe(6);
            expect(r.close!.tax).toBe(32);
            expect(r.net).toBe(456);
            expect(r.breakEven).toBe(10.05);
        }
        expect(esunM.openFeeEstimated).toBe(false);
        expect(sinoM.openFeeEstimated).toBe(true);
        // 成交即折：明細已是折後（最低 20 不打折）→ 開倉 20、平倉 20 → 428，兩平 10.10
        const instant = settings({ feeDiscount: 0.28, rebateMode: 'instant' });
        for (const r of [run({ ...base, settings: instant, actual: { openNotional: 10_000, openFee: 20 } }), run({ ...base, settings: instant })]) {
            expect(r.openFee).toBe(20);
            expect(r.close!.fee).toBe(20);
            expect(r.net).toBe(428);
            expect(r.breakEven).toBe(10.1);
        }
        // 6 折月退：交割 20 → 12；即折 20
        const m6 = settings({ feeDiscount: 0.6, rebateMode: 'monthly' });
        expect(run({ ...base, settings: m6, actual: { openNotional: 10_000, openFee: 20 } }).openFee).toBe(12);
        expect(run({ ...base, settings: m6 }).close!.fee).toBe(12);
        expect(run({ ...base, settings: settings({ feeDiscount: 0.6, rebateMode: 'instant' }) }).close!.fee).toBe(20);
    });

    it('6 折：手續費 = round(價金 × 0.0855%)', () => {
        const d = settings({ feeDiscount: 0.6 });
        const r = run({ settings: d });
        expect(r.openFee).toBe(86); // 85.5 → 86
        expect(r.close!.fee).toBe(94); // 110,000 × 0.000855 = 94.05
        expect(r.net).toBe(110_000 - 94 - 330 - 100_086);
        expect(r.feeDiscount).toBe(0.6);
        expectBoundary({ settings: d });
    });

    it('零股：最低 1 元；整股＋零股拆兩筆委託各自最低手續費', () => {
        // 1 股 × 100：手續費 0.1425 → 1
        const one = run({ shares: 1, avgPrice: 100, lastPrice: 100 });
        expect(one.openFee).toBe(1);
        expect(one.close!.fee).toBe(1);
        // 50 股 × 300：21.375 → 21；6 折 12.825 → 13
        expect(run({ shares: 50, avgPrice: 300 }).openFee).toBe(21);
        expect(run({ shares: 50, avgPrice: 300, settings: settings({ feeDiscount: 0.6 }) }).openFee).toBe(13);
        // 1,001 股 × 10、2.8 折成交即折：整股 20＋零股 1
        expect(run({ shares: 1001, avgPrice: 10, settings: settings({ feeDiscount: 0.28, rebateMode: 'instant' }) }).openFee).toBe(21);
        // 月退：整股交割 20 → 6、零股交割 1 → round(0.28) = 0
        expect(run({ shares: 1001, avgPrice: 10, settings: settings({ feeDiscount: 0.28, rebateMode: 'monthly' }) }).openFee).toBe(6);
    });

    it('零股兩平：稅額四捨五入為 0 的價位，代數解再往下驗證（1 股 × 100 → 102.0）', () => {
        const be = expectBoundary({ shares: 1, avgPrice: 100 });
        expect(be).toBe(102);
        expect(netCentsAt({ shares: 1, avgPrice: 100 }, 102)).toBe(0);
        expect(netCentsAt({ shares: 1, avgPrice: 100 }, 101.5)).toBeLessThan(0);
    });

    it('有券商實際買進手續費時優先使用；月退設定下扣預估退佣，成交即折不扣', () => {
        const monthly = run({ actual: { openNotional: 100_000, openFee: 143 }, settings: settings({ feeDiscount: 0.6, rebateMode: 'monthly' }) });
        expect(monthly.openFeeEstimated).toBe(false);
        expect(monthly.openFee).toBe(86); // 143 − (143 − round(85.8))
        const instant = run({ actual: { openNotional: 100_000, openFee: 86 }, settings: settings({ feeDiscount: 0.6, rebateMode: 'instant' }) });
        expect(instant.openFee).toBe(86);
        // 實際價金與均價 × 股數不同時採實際價金
        expect(run({ actual: { openNotional: 100_050, openFee: 143 } }).basis).toBe(100_193);
    });
});

describe('交割收取額與預估退佣（顯示用；淨損益不變）', () => {
    it('2.8 折月退估算：開倉交割 143 退 103、平倉交割 157 退 113；rebate＝216，淨額＝交割 − 退佣', () => {
        const st = settings({ feeDiscount: 0.28, rebateMode: 'monthly' });
        const r = run({ settings: st });
        expect(r.openFeeCharged).toBe(143);
        expect(r.openRebate).toBe(103); // 143 − round(40.04)
        expect(r.openFee).toBe(40);
        expect(r.close!.feeCharged).toBe(157);
        expect(r.close!.rebate).toBe(113); // 157 − round(43.96)
        expect(r.close!.fee).toBe(44);
        expect(r.rebate).toBe(216);
        expect(r.openFeeCharged - r.openRebate).toBe(r.openFee);
        expect(r.close!.feeCharged - r.close!.rebate).toBe(r.close!.fee);
        // 淨損益：110,000 − 44 − 330 − 100,000 − 40
        expect(r.net).toBe(9_586);
    });

    it('交割收取額＝stockFeeBreakdown(...).charged、退佣＝.rebate（整張＋零股兩筆）', () => {
        for (const rebateMode of ['monthly', 'instant'] as const) {
            for (const feeDiscount of [1, 0.6, 0.28]) {
                const st = settings({ feeDiscount, rebateMode });
                for (const [shares, avgPrice, lastPrice] of [[1000, 10, 10.5], [3500, 1052.5, 1085], [37, 23.45, 24], [1001, 10, 9.9]] as const) {
                    const r = run({ settings: st, shares, avgPrice, lastPrice });
                    const whole = Math.floor(shares / 1000) * 1000;
                    const odd = shares - whole;
                    const b = (cents: number, isOdd: boolean) => stockFeeBreakdown(cents, { odd: isOdd }, st);
                    const pc = (v: number) => Math.round(v * 100);
                    expect(r.openFeeCharged).toBe(b(pc(avgPrice) * whole, false).charged + b(pc(avgPrice) * odd, true).charged);
                    expect(r.openRebate).toBe(b(pc(avgPrice) * whole, false).rebate + b(pc(avgPrice) * odd, true).rebate);
                    expect(r.close!.feeCharged).toBe(b(pc(lastPrice) * whole, false).charged + b(pc(lastPrice) * odd, true).charged);
                    expect(r.close!.rebate).toBe(b(pc(lastPrice) * whole, false).rebate + b(pc(lastPrice) * odd, true).rebate);
                    expect(r.rebate).toBe(r.openRebate + r.close!.rebate);
                    if (rebateMode === 'instant' || feeDiscount === 1) expect(r.rebate).toBe(0);
                }
            }
        }
    });

    it('券商實際手續費：charged＝|實收|、退佣＝feeRebate(實收)；即折不退', () => {
        const monthly = run({ actual: { openNotional: 100_000, openFee: 143 }, settings: settings({ feeDiscount: 0.6, rebateMode: 'monthly' }) });
        expect(monthly.openFeeCharged).toBe(143);
        expect(monthly.openRebate).toBe(57);
        expect(monthly.openFee).toBe(86);
        const instant = run({ actual: { openNotional: 100_000, openFee: 86 }, settings: settings({ feeDiscount: 0.6, rebateMode: 'instant' }) });
        expect(instant.openFeeCharged).toBe(86);
        expect(instant.openRebate).toBe(0);
    });

    it('空單：開倉賣出與回補都有退佣；沒有現價時 rebate 為 null（開倉退佣仍有值）', () => {
        const st = settings({ feeDiscount: 0.28, rebateMode: 'monthly' });
        const over = { kind: 'short' as const, avgPrice: 50, lastPrice: 49, settings: st };
        const r = run(over);
        expect(r.openFeeCharged).toBe(71);
        expect(r.openRebate).toBe(51); // 71 − round(19.88)
        expect(r.close!.feeCharged).toBe(70);
        expect(r.close!.rebate).toBe(50); // 70 − round(19.6)
        expect(r.rebate).toBe(101);
        const noPrice = run({ ...over, lastPrice: null });
        expect(noPrice.rebate).toBeNull();
        expect(noPrice.close).toBeNull();
        expect(noPrice.openRebate).toBe(51);
    });

    it('退佣欄位不影響淨損益與兩平價（與不看退佣欄位時相同）', () => {
        const st = settings({ feeDiscount: 0.28, rebateMode: 'monthly' });
        const r = run({ settings: st, avgPrice: 10, lastPrice: 10.5 });
        expect(r.net).toBe(456);
        expect(r.breakEven).toBe(10.05);
        expect(r.rebate).toBe(28); // 開倉交割 20 退 14＋平倉交割 20 退 14
    });
});

describe('證交稅：一般股票、ETF、權證、債券 ETF', () => {
    it('ETF 0.1%：0050 × 1,000 股均價 150 → 兩平 150.60（150.55 <0）', () => {
        const over = { contract: etf, avgPrice: 150, lastPrice: 150.6, todayShares: 1000 };
        const r = run(over);
        expect(r.taxRate).toBe(0.001);
        expect(r.dayTrade).toBe('notReduced'); // ETF 不減半
        expect(r.dayTradeShares).toBe(0);
        expect(expectBoundary(over)).toBe(150.6);
        expect(r.net).toBe(150_600 - 215 - 151 - 150_214);
    });

    it('權證 0.1%、不減半', () => {
        const r = run({ contract: warrant, avgPrice: 1.5, lastPrice: 1.6, todayShares: 1000 });
        expect(r.taxRate).toBe(0.001);
        expect(r.dayTrade).toBe('notReduced');
        expectBoundary({ contract: warrant, avgPrice: 1.5 });
    });

    it('債券 ETF：停徵期內稅 0（兩平 30.09），期滿後 0.1%（兩平 30.12）', () => {
        const inPeriod = { contract: bondEtf, avgPrice: 30, lastPrice: 30 };
        expect(run(inPeriod).taxRate).toBe(0);
        expect(expectBoundary(inPeriod)).toBe(30.09);
        const after = { ...inPeriod, now: Date.parse('2027-06-01T10:00:00+08:00') };
        expect(run(after).taxRate).toBe(0.001);
        expect(expectBoundary(after)).toBe(30.12);
    });
});

describe('現股當沖 0.15%', () => {
    const mixed = { shares: 3000, avgPrice: 500, lastPrice: 520, todayShares: 1000 };

    it('部分今日買進：今日 1,000 股以 0.15%、其餘 2,000 股以 0.3%', () => {
        const r = run(mixed);
        expect(r.dayTrade).toBe('applied');
        expect(r.dayTradeShares).toBe(1000);
        expect(r.dayTradeRate).toBe(0.0015);
        expect(r.close!.tax).toBe(780 + 3120);
        expect(r.openFee).toBe(2138);
        expect(r.net).toBe(1_560_000 - 2223 - 3900 - 1_502_138);
        expectBoundary(mixed);
        // 全部今日買進的兩平價不高於部分今日買進
        expect(run({ ...mixed, todayShares: 3000 }).breakEven!).toBeLessThanOrEqual(r.breakEven!);
    });

    it('期滿後（台灣時間 2028-01-01）自動回到 0.3%', () => {
        const r = run({ ...mixed, now: Date.parse('2028-01-01T00:00:00+08:00') });
        expect(r.dayTrade).toBe('notReduced');
        expect(r.dayTradeShares).toBe(0);
        expect(r.close!.tax).toBe(4680);
        const before = run({ ...mixed, now: Date.parse('2027-12-31T13:00:00+08:00') });
        expect(before.close!.tax).toBe(3900);
    });

    it('取不到日期：一般稅率並標 unknown；不可當沖的股票 noDayTrade；先買後賣（OnlyBuy）的多單可減半', () => {
        expect(run({ ...mixed, todayShares: null }).dayTrade).toBe('unknown');
        expect(run({ ...mixed, todayShares: null }).close!.tax).toBe(4680);
        expect(run({ ...mixed, contract: stk({ day_trade: 'No' }) }).dayTrade).toBe('noDayTrade');
        expect(run({ ...mixed, contract: stk({ day_trade: 'No' }) }).close!.tax).toBe(4680);
        expect(run({ ...mixed, contract: stk({ day_trade: 'OnlyBuy' }) }).dayTrade).toBe('applied');
        expect(run({ ...mixed, contract: stk({ day_trade: '' }) }).dayTrade).toBe('unknown');
        // 今日股數大於部位時以部位為上限
        expect(run({ ...mixed, todayShares: 9999 }).dayTradeShares).toBe(3000);
    });

    it('現股當沖空單：賣出稅 0.15% 已發生；回補 49 淨損益 784、兩平 49.75（49.80 <0）', () => {
        const over = { kind: 'dayShort' as const, avgPrice: 50, lastPrice: 49, todayShares: null };
        const r = run(over);
        expect(r.side).toBe('short');
        expect(r.dayTrade).toBe('applied');
        expect(r.openFee).toBe(71);
        expect(r.openTax).toBe(75);
        expect(r.borrowFee).toBeNull();
        expect(r.basis).toBe(49_854);
        expect(r.close).toEqual({ price: 49, notional: 49_000, fee: 70, feeCharged: 70, rebate: 0, tax: 0 });
        expect(r.net).toBe(784);
        expect(expectBoundary(over)).toBe(49.75);
        // 期滿後當沖空單賣出稅回到 0.3%
        expect(run({ ...over, now: Date.parse('2028-02-01T10:00:00+08:00') }).openTax).toBe(150);
    });
});

describe('當沖稅率只在今天還能沖銷時適用（台北 13:30 前）', () => {
    const at = (hhmm: string) => Date.parse(`2026-11-06T${hhmm}+08:00`);

    it('dayTradeSessionOpen：13:29:59 可沖銷、13:30:00 起收盤；以台北時間判斷', () => {
        expect(dayTradeSessionOpen(at('09:00:00'))).toBe(true);
        expect(dayTradeSessionOpen(at('13:29:59'))).toBe(true);
        expect(dayTradeSessionOpen(at('13:30:00'))).toBe(false);
        expect(dayTradeSessionOpen(at('20:00:00'))).toBe(false);
        expect(dayTradeSessionOpen(at('23:59:59'))).toBe(false);
        // UTC 05:29 ＝ 台北 13:29；UTC 05:31 ＝ 台北 13:31
        expect(dayTradeSessionOpen(Date.UTC(2026, 10, 6, 5, 29))).toBe(true);
        expect(dayTradeSessionOpen(Date.UTC(2026, 10, 6, 5, 31))).toBe(false);
    });

    // 今天以 1,080 買進 2330 1,000 股（無折扣）、現價 1,085
    const today = { avgPrice: 1080, lastPrice: 1085, todayShares: 1000 };

    it('13:29 仍以 0.15% 計：稅 1,628、淨損益 +287、兩平 1,085', () => {
        const r = run({ ...today, now: at('13:29:00') });
        expect(r.dayTrade).toBe('applied');
        expect(r.dayTradeShares).toBe(1000);
        expect(r.close!.tax).toBe(1628);
        expect(r.net).toBe(287);
        expect(r.breakEven).toBe(1085);
    });

    it('13:30／13:31／20:00 收盤後回到 0.3%：稅 3,255、淨損益 −1,340、兩平 1,090（未達兩平）', () => {
        for (const t of ['13:30:00', '13:31:00', '20:00:00']) {
            const r = run({ ...today, now: at(t) });
            expect(r.dayTrade).toBe('closed');
            expect(r.dayTradeShares).toBe(0);
            expect(r.close!.tax).toBe(3255);
            expect(r.net).toBe(-1340);
            expect(r.breakEven).toBe(1090);
            expect(breakEvenRelation(r, 1085)).toBe('loss');
        }
        // 收盤後：今日買進 0 → none；取不到成交日也一律一般稅率（closed，不再標「未判斷當沖」）
        expect(run({ ...today, todayShares: 0, now: at('20:00:00') }).dayTrade).toBe('none');
        expect(run({ ...today, todayShares: null, now: at('20:00:00') }).dayTrade).toBe('closed');
        // 下一個交易日開盤前：新的一天沒有買進
        expect(run({ ...today, todayShares: 0, now: Date.parse('2026-11-09T08:00:00+08:00') }).dayTrade).toBe('none');
    });

    it('收盤後仍未回補的現股當沖空單：標 uncovered，賣出稅以一般稅率估算', () => {
        const over = { kind: 'dayShort' as const, avgPrice: 50, lastPrice: 49, todayShares: null };
        const open = run({ ...over, now: at('13:29:00') });
        expect(open.dayTrade).toBe('applied');
        expect(open.openTax).toBe(75);
        const after = run({ ...over, now: at('13:31:00') });
        expect(after.dayTrade).toBe('uncovered');
        expect(after.dayTradeShares).toBe(0);
        expect(after.openTax).toBe(150);
        expect(after.net).toBe(open.net! - 75);
        expectBoundary({ ...over, now: at('13:31:00') });
        // ETF 當沖空單收盤後也標未回補
        expect(run({ ...over, contract: etf, now: at('13:31:00') }).dayTrade).toBe('uncovered');
        // 券商已給實際賣出稅時沿用實際值
        expect(run({ ...over, now: at('13:31:00'), actual: { openNotional: 50_000, openFee: 71, openTax: 75 } }).openTax).toBe(75);
    });
});

describe('融券與融資', () => {
    it('融券：賣出費稅與借券費（0.08%）；回補 90 淨損益 9,349、兩平 99.3（99.4 <0）', () => {
        const over = { kind: 'short' as const, avgPrice: 100, lastPrice: 90 };
        const r = run(over);
        expect(r.openFee).toBe(143);
        expect(r.openTax).toBe(300);
        expect(r.dayTrade).toBe('na');
        expect(r.borrowFee).toBe(80);
        expect(r.basis).toBe(99_557);
        expect(r.close!.fee).toBe(128);
        expect(r.net).toBe(9_349);
        expect(expectBoundary(over)).toBe(99.3);
        // 借券費率 0 → 兩平上移
        expect(run({ ...over, settings: settings({ shortFeeRate: 0 }) }).breakEven!).toBeGreaterThanOrEqual(99.3);
        // 券商實際賣出稅
        expect(run({ ...over, actual: { openNotional: 100_000, openFee: 143, openTax: 300 } }).openTaxEstimated).toBe(false);
    });

    it('融資：利息計到以現價賣出的交割日 T+2（週五賣 → 週二 11-10）：60,000 × 6.45% × 36 天 ÷ 365 = 382；不減半當沖稅', () => {
        const over = {
            kind: 'margin' as const,
            todayShares: 1000,
            settings: settings({ marginAnnualRate: 0.0645 }),
            // 2026-10-01（週四）買進 → 買進交割 10-05（週一）；計到 11-10 共 36 天（計到今天 11-06 只有 32 天 = 339）
            marginLots: [{ tradeDate: '2026-10-01', price: 100, shares: 1000 }],
        };
        const r = run(over);
        expect(r.interestStatus).toBe('included');
        expect(r.interestGaps).toEqual([]);
        expect(r.interestUntil).toBe('2026-11-10');
        expect(r.interest).toBe(382);
        expect(r.dayTrade).toBe('na');
        expect(r.close!.tax).toBe(330);
        expect(r.net).toBe(9_370 - 382);
        expectBoundary(over);
        expect(r.breakEven!).toBeGreaterThanOrEqual(run().breakEven!);
        // 週六看盤：賣出日順延到週一 11-09 → 交割 11-11（週三），37 天 = 392
        const sat = run({ ...over, now: Date.parse('2026-11-07T10:00:00+08:00') });
        expect(sat.interestUntil).toBe('2026-11-11');
        expect(sat.interest).toBe(392);
        // 非融資沒有計息終點
        expect(run().interestUntil).toBeNull();
    });

    it('sellSettlementYmd：台北日期 T+2、週末順延（未計國定假日）', () => {
        const at = (iso: string) => sellSettlementYmd(Date.parse(iso));
        expect(at('2026-11-02T09:00:00+08:00')).toBe('2026-11-04'); // 週一 → 週三
        expect(at('2026-11-05T13:00:00+08:00')).toBe('2026-11-09'); // 週四 → 週一
        expect(at('2026-11-06T10:00:00+08:00')).toBe('2026-11-10'); // 週五 → 週二
        expect(at('2026-11-07T10:00:00+08:00')).toBe('2026-11-11'); // 週六 → 週一賣 → 週三
        expect(at('2026-11-08T23:59:59+08:00')).toBe('2026-11-11'); // 週日
        // UTC 週五 16:00 ＝ 台北週六 00:00 → 以台北日期為準
        expect(sellSettlementYmd(Date.UTC(2026, 10, 6, 15, 59, 59))).toBe('2026-11-10');
        expect(sellSettlementYmd(Date.UTC(2026, 10, 6, 16, 0, 0))).toBe('2026-11-11');
        // 跨年：2026-12-31（週四）→ 2027-01-04（週一；元旦假日未計）
        expect(at('2026-12-31T10:00:00+08:00')).toBe('2027-01-04');
    });

    it('融資：分批缺成交價 → 以均價估算並標 estimated；缺股數 → incomplete（未含利息）；股數合計不符 → estimated', () => {
        const base = { kind: 'margin' as const, settings: settings({ marginAnnualRate: 0.0645 }), shares: 2000, avgPrice: 100, lastPrice: 110 };
        const full = run({ ...base, marginLots: [{ tradeDate: '2026-10-01', price: 100, shares: 1000 }, { tradeDate: '2026-10-01', price: 100, shares: 1000 }] });
        expect(full.interestStatus).toBe('included');
        expect(full.interest).toBe(764);
        // 第二批缺價：以均價 100 估算，金額相同但標示估算
        const noPrice = run({ ...base, marginLots: [{ tradeDate: '2026-10-01', price: 100, shares: 1000 }, { tradeDate: '2026-10-01', price: null, shares: 1000 }] });
        expect(noPrice.interestStatus).toBe('estimated');
        expect(noPrice.interestGaps).toEqual(['missingPrice']);
        expect(noPrice.interest).toBe(764);
        expect(noPrice.net).toBe(full.net);
        // 缺股數：不猜 → 未含利息，淨損益不扣利息
        const noShares = run({ ...base, marginLots: [{ tradeDate: '2026-10-01', price: 100, shares: 1000 }, { tradeDate: '2026-10-01', price: 100, shares: null }] });
        expect(noShares.interestStatus).toBe('incomplete');
        expect(noShares.interest).toBeNull();
        expect(noShares.interestGaps).toEqual([]);
        expect(noShares.net).toBe(run({ ...base, kind: 'cash' }).net);
        // 分批股數合計（1,000）與持倉（2,000）不同 → 估算
        const mismatch = run({ ...base, marginLots: [{ tradeDate: '2026-10-01', price: 100, shares: 1000 }] });
        expect(mismatch.interestStatus).toBe('estimated');
        expect(mismatch.interestGaps).toEqual(['sharesMismatch']);
        expect(mismatch.interest).toBe(382);
    });

    it('融資：未設定年利率 noRate、沒有成交日 noDate（都不計利息）', () => {
        const noRate = run({ kind: 'margin', marginLots: [{ tradeDate: '2026-10-01', price: 100, shares: 1000 }] });
        expect(noRate.interestStatus).toBe('noRate');
        expect(noRate.interest).toBeNull();
        expect(noRate.net).toBe(9_370);
        const noDate = run({ kind: 'margin', settings: settings({ marginAnnualRate: 0.0645 }), marginLots: null });
        expect(noDate.interestStatus).toBe('noDate');
        expect(noDate.net).toBe(9_370);
        // 興櫃等不可融資的市場：無法估算 → noDate
        const oes = run({ kind: 'margin', contract: stk({ exchange: 'OES' }), settings: settings({ marginAnnualRate: 0.0645 }), marginLots: [{ tradeDate: '2026-10-01', price: 100, shares: 1000 }] });
        expect(oes.interestStatus).toBe('noDate');
    });
});

describe('兩平價：檔位交界與邊界驗證', () => {
    // 成交即折：最低手續費 20 元不打折（月退見上方「2.8 折月退」）
    const d = settings({ feeDiscount: 0.28, rebateMode: 'instant' });

    it('9.99 與 10：成本 9,950 → 兩平 10.00、前一檔 9.99 <0', () => {
        const over = { settings: d, avgPrice: 9.93, lastPrice: 10 };
        expect(expectBoundary(over)).toBe(10);
        expect(netCentsAt(over, 10)).toBe(0);
        expect(netCentsAt(over, 9.99)).toBe(-1000);
    });

    it('49.95 與 50：成本 49,830 → 兩平 50.00、前一檔 49.95 <0', () => {
        const over = { settings: d, avgPrice: 49.81, lastPrice: 50 };
        expect(expectBoundary(over)).toBe(50);
        expect(netCentsAt(over, 49.95)).toBe(-5000);
    });

    it('ETF 50 元交界前一檔為 49.99', () => {
        // ETF 0.1%：50 → 50,000 − 20 − 50 = 49,930；49.99 → 49,990 − 20 − 50 = 49,920；成本 49,910 ＋ 20
        const over = { contract: etf, settings: d, avgPrice: 49.91 };
        const be = expectBoundary(over);
        expect(be).toBe(50);
        expect(stepPrice(etf, be, -1)).toBe(49.99);
        expect(netCentsAt(over, 49.99)).toBe(-1000);
    });

    it('大量向量：多空、整股零股、各折數、月退／即折都滿足「取整後 ≥0、相鄰檔 <0」', () => {
        const discounts = [1, 0.6, 0.28];
        const modes = ['monthly', 'instant'] as const;
        const prices = [1.23, 9.87, 9.995, 10, 23.45, 49.9, 49.95, 50, 77.7, 99.9, 100, 123.5, 499.5, 500, 812, 999, 1000, 1085];
        const shareSet = [1, 37, 999, 1000, 1001, 3500];
        let checked = 0;
        let nulls = 0;
        for (const rebateMode of modes) {
            for (const feeDiscount of discounts) {
                for (const avgPrice of prices) {
                    for (const shares of shareSet) {
                        for (const kind of ['cash', 'short'] as const) {
                            const over = { kind, shares, avgPrice, settings: settings({ feeDiscount, rebateMode }), todayShares: Math.floor(shares / 2) };
                            if (run(over).breakEven === null) {
                                // 只有空單可能無解：最低價位仍虧損才算正確
                                expect(kind).toBe('short');
                                expect(netCentsAt(over, 0.01)).toBeLessThan(0);
                                nulls += 1;
                            } else expectBoundary(over);
                            checked += 1;
                        }
                    }
                }
            }
        }
        expect(checked).toBe(modes.length * discounts.length * prices.length * shareSet.length * 2);
        expect(nulls).toBeGreaterThan(0);
        // 賣出淨額 0.23 元 < 回補最低手續費 1 元（即折）：任何價位都無法兩平 → null
        expect(run({ kind: 'short', shares: 1, avgPrice: 1.23, settings: settings({ feeDiscount: 0.28, rebateMode: 'instant' }) }).breakEven).toBeNull();
    });

    it('breakEvenRelation：多單現價高於兩平為 profit；空單低於兩平為 profit', () => {
        expect(breakEvenRelation({ side: 'long', breakEven: 101 }, 102)).toBe('profit');
        expect(breakEvenRelation({ side: 'long', breakEven: 101 }, 100.5)).toBe('loss');
        expect(breakEvenRelation({ side: 'long', breakEven: 101 }, 101)).toBe('even');
        expect(breakEvenRelation({ side: 'short', breakEven: 99.3 }, 90)).toBe('profit');
        expect(breakEvenRelation({ side: 'short', breakEven: 99.3 }, 99.4)).toBe('loss');
        expect(breakEvenRelation({ side: 'short', breakEven: null }, 99.4)).toBeNull();
        expect(breakEvenRelation({ side: 'long', breakEven: 101 }, 0)).toBeNull();
    });

    it('缺現價：淨損益為 null、兩平價仍可算；股數或均價不合法回 null', () => {
        const r = run({ lastPrice: 0 });
        expect(r.net).toBeNull();
        expect(r.close).toBeNull();
        expect(r.breakEven).toBe(101);
        expect(computeStockPnl(input({ shares: 0 }))).toBeNull();
        expect(computeStockPnl(input({ avgPrice: Number.NaN }))).toBeNull();
    });
});

describe('今日成交與輸入組裝', () => {
    const acc = { broker_id: '9A95', account_id: '1234567', account_type: 'S' };
    const trade = (action: 'Buy' | 'Sell', qty: number, over: Record<string, unknown> = {}, ts = NOW) => ({
        contract: { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null },
        order: { id: 'x', seqno: '', ordno: '', action, price: 500, quantity: qty, order_lot: 'Common', order_cond: 'Cash', ...over },
        status: { id: 'x', status: 'Filled', status_code: '', order_quantity: qty, deal_quantity: qty, cancel_quantity: 0, modified_price: 0, msg: '', deals: [{ seq: '1', price: 500, quantity: qty, ts }] },
        account: acc,
    }) as never;

    it('todayStockFills：整股 × 1000、零股以股計；昨天的成交略過；依信用條件分開', () => {
        const fills = todayStockFills([
            trade('Buy', 2),
            trade('Buy', 300, { order_lot: 'IntradayOdd' }),
            trade('Sell', 500, { order_lot: 'IntradayOdd' }),
            trade('Buy', 1, {}, NOW - 86_400_000),
            trade('Buy', 1, { order_cond: 'MarginTrading' }),
            trade('Buy', 1, {}, Math.floor(NOW / 1000)), // 秒
        ], NOW);
        expect(fills.get(fillKey(acc, '2330', 'Cash'))).toEqual({ buy: 3300, sell: 500 });
        expect(fills.get(fillKey(acc, '2330', 'MarginTrading'))).toEqual({ buy: 1000, sell: 0 });
    });

    it('taipeiYmd 以台北日期為準', () => {
        expect(taipeiYmd(Date.UTC(2026, 10, 5, 16, 30))).toBe('2026-11-06');
        expect(taipeiYmd(NOW)).toBe('2026-11-06');
    });

    it('stockPnlKindOf：現股多／當沖空、融資多、融券空；不支援的組合回 null', () => {
        expect(stockPnlKindOf('Buy', 'Cash')).toBe('cash');
        expect(stockPnlKindOf('Buy', undefined)).toBe('cash');
        expect(stockPnlKindOf('Sell', 'Cash')).toBe('dayShort');
        expect(stockPnlKindOf('Buy', 'MarginTrading')).toBe('margin');
        expect(stockPnlKindOf('Sell', 'ShortSelling')).toBe('short');
        expect(stockPnlKindOf('Sell', 'MarginTrading')).toBeNull();
        expect(stockPnlKindOf('Buy', 'Lending')).toBeNull();
    });

    const pos = { code: '2330', direction: 'Buy', quantity: 3000, price: 500, last_price: 520, cond: 'Cash', account: acc };
    const ctx = { settings: settings(), now: NOW };

    it('成交回報：今日買 − 今日賣，上限為部位股數；委託查詢未成功時為 null（未判斷當沖）', () => {
        const fills = todayStockFills([trade('Buy', 2), trade('Sell', 500, { order_lot: 'IntradayOdd' })], NOW);
        expect(stockPnlInputOf(pos, stk(), { ...ctx, fills })!.todayShares).toBe(1500);
        expect(stockPnlInputOf(pos, stk(), { ...ctx, fills: new Map() })!.todayShares).toBe(0);
        expect(stockPnlInputOf(pos, stk(), { ...ctx, fills: null })!.todayShares).toBeNull();
        const big = todayStockFills([trade('Buy', 9)], NOW);
        expect(stockPnlInputOf(pos, stk(), { ...ctx, fills: big })!.todayShares).toBe(3000);
    });

    const lot = (tradeDate: string, shares: number, over: Record<string, unknown> = {}) =>
        ({ action: 'Buy' as const, tradeDate, price: 500, shares, fee: 713, tax: 0, ...over });
    const esun = (over: Record<string, unknown> = {}) => ({
        tradeType: '0', costShares: 3000, costSum: 1_502_139, priceQtySum: 1_500_000,
        todayBuyFilledShares: 0, todaySellFilledShares: 0,
        lots: [lot('2026-11-04', 2000, { fee: 1425 }), lot('2026-11-06', 1000)],
        ...over,
    });

    it('玉山明細：以分批成交日拆出今日股數，費用採明細合計；成本股數不符時不採用', () => {
        const fills = todayStockFills([trade('Buy', 3)], NOW);
        const a = stockPnlInputOf(pos, stk(), { ...ctx, fills, esun: esun() })!;
        expect(a.todayShares).toBe(1000);
        expect(a.actual).toEqual({ openNotional: 1_500_000, openFee: 2138, openTax: null });
        const r = computeStockPnl(a)!;
        expect(r.openFeeEstimated).toBe(false);
        expect(r.dayTradeShares).toBe(1000);
        // 明細沒有分批：用 cost_sum − 價金當手續費，今日股數用今日買賣成交
        const b = stockPnlInputOf(pos, stk(), { ...ctx, fills: null, esun: esun({ lots: [], todayBuyFilledShares: 2000, todaySellFilledShares: 500 }) })!;
        expect(b.actual!.openFee).toBe(2139);
        expect(b.todayShares).toBe(1500);
        // 成本股數不符 → 不採用明細，改用成交回報
        const c = stockPnlInputOf(pos, stk(), { ...ctx, fills, esun: esun({ costShares: 2000 }) })!;
        expect(c.actual).toBeUndefined();
        expect(c.todayShares).toBe(3000);
        // 交易類別不符（融資明細配現股持倉）→ 不採用
        expect(stockPnlInputOf(pos, stk(), { ...ctx, fills: null, esun: esun({ tradeType: '3' }) })!.actual).toBeUndefined();
    });

    it('融資：玉山分批成交日組出利息批次；沒有明細但整筆今日買進 → 利息 0', () => {
        const mpos = { ...pos, cond: 'MarginTrading', quantity: 1000, price: 100, last_price: 110 };
        const withRate = { ...ctx, settings: settings({ marginAnnualRate: 0.0645 }) };
        const a = stockPnlInputOf(mpos, stk(), { ...withRate, fills: null, esun: esun({ tradeType: '3', costShares: 1000, priceQtySum: 100_000, lots: [lot('2026-10-01', 1000, { price: 100, fee: 143 })] }) })!;
        expect(a.marginLots).toEqual([{ tradeDate: '2026-10-01', price: 100, shares: 1000 }]);
        expect(computeStockPnl(a)!.interest).toBe(382);
        expect(computeStockPnl(a)!.interestStatus).toBe('included');
        const fills = todayStockFills([trade('Buy', 1, { order_cond: 'MarginTrading' })], NOW);
        const b = stockPnlInputOf(mpos, stk(), { ...withRate, fills })!;
        expect(computeStockPnl(b)!.interestStatus).toBe('included');
        expect(computeStockPnl(b)!.interest).toBe(0);
        const c = stockPnlInputOf(mpos, stk(), { ...withRate, fills: null })!;
        expect(computeStockPnl(c)!.interestStatus).toBe('noDate');
    });

    it('融資：玉山分批缺價或缺股數不先濾掉（不再誤標「已計入」）；缺價 → 估算、缺股數 → 未含', () => {
        const mpos = { ...pos, cond: 'MarginTrading', quantity: 2000, price: 100, last_price: 110 };
        const withRate = { ...ctx, settings: settings({ marginAnnualRate: 0.0645 }), fills: null };
        const detail = (lots: ReturnType<typeof lot>[]) => esun({ tradeType: '3', costShares: 2000, priceQtySum: 200_000, lots });
        // 缺價
        const p = stockPnlInputOf(mpos, stk(), { ...withRate, esun: detail([lot('2026-10-01', 1000, { price: 100 }), lot('2026-10-01', 1000, { price: null })]) })!;
        expect(p.marginLots).toEqual([{ tradeDate: '2026-10-01', price: 100, shares: 1000 }, { tradeDate: '2026-10-01', price: null, shares: 1000 }]);
        const rp = computeStockPnl(p)!;
        expect(rp.interestStatus).toBe('estimated');
        expect(rp.interestGaps).toEqual(['missingPrice']);
        expect(rp.interest).toBe(764);
        // 缺股數（舊版會濾掉這批，只算 1,000 股卻標「已計入」）
        const q = stockPnlInputOf(mpos, stk(), { ...withRate, esun: detail([lot('2026-10-01', 1000, { price: 100 }), lot('2026-10-01', 1000, { price: 100, shares: null })]) })!;
        expect(q.marginLots).toEqual([{ tradeDate: '2026-10-01', price: 100, shares: 1000 }, { tradeDate: '2026-10-01', price: 100, shares: null }]);
        const rq = computeStockPnl(q)!;
        expect(rq.interestStatus).toBe('incomplete');
        expect(rq.interest).toBeNull();
        // 賣出批次仍不計入
        const s = stockPnlInputOf(mpos, stk(), { ...withRate, esun: detail([lot('2026-10-01', 2000, { price: 100 }), lot('2026-10-02', 1000, { action: 'Sell', price: null, shares: null })]) })!;
        expect(s.marginLots).toEqual([{ tradeDate: '2026-10-01', price: 100, shares: 2000 }]);
        expect(computeStockPnl(s)!.interestStatus).toBe('included');
    });

    it('收盤後：玉山分批成交日與成交回報兩條路徑的今日買進都以一般稅率計', () => {
        const night = { ...ctx, now: Date.parse('2026-11-06T20:00:00+08:00') };
        const fromLots = stockPnlInputOf(pos, stk(), { ...night, fills: null, esun: esun() })!;
        expect(fromLots.todayShares).toBe(1000);
        expect(computeStockPnl(fromLots)!.dayTrade).toBe('closed');
        expect(computeStockPnl(fromLots)!.dayTradeShares).toBe(0);
        const fills = todayStockFills([trade('Buy', 1, {}, night.now)], night.now);
        const fromFills = stockPnlInputOf(pos, stk(), { ...night, fills })!;
        expect(fromFills.todayShares).toBe(1000);
        expect(computeStockPnl(fromFills)!.dayTrade).toBe('closed');
        expect(computeStockPnl(fromFills)!.close!.tax).toBe(computeStockPnl({ ...fromFills, todayShares: 0 })!.close!.tax);
    });

    it('不支援的條件（借券等）回 null', () => {
        expect(stockPnlInputOf({ ...pos, cond: 'Lending' }, stk(), { ...ctx, fills: null })).toBeNull();
    });
});
