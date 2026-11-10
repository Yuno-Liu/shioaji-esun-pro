// fork：已實現損益的預估退佣共用核心。價金估算（整張／零股、最低手續費）、空單回補、成交明細（平倉／開倉兩側）、
// 買賣拆分、沒有月退、缺股數或價金、手續費來源說明與合計。金額全為合成值。
import { describe, expect, it } from 'vitest';
import {
    estimateRealizedRebate,
    realizedRebateSourceText,
    realizedRebateTotals,
    type RealizedRebateInput,
} from './realized-rebate';
import { DEFAULT_TRADING_COST_SETTINGS, type TradingCostSettings } from './trading-cost-settings';

const settings = (over: Partial<TradingCostSettings> = {}): TradingCostSettings => ({ ...DEFAULT_TRADING_COST_SETTINGS, ...over });
const m28 = settings({ feeDiscount: 0.28, rebateMode: 'monthly' });
const m60 = settings({ feeDiscount: 0.6, rebateMode: 'monthly' });

/** 預設：多單 2,000 股、平倉價金 200,000、損益 5,000 */
const input = (over: Partial<RealizedRebateInput> = {}): RealizedRebateInput => ({ shares: 2000, closeNotional: 200_000, pnl: 5000, cover: false, ...over });
const fill = (action: 'Buy' | 'Sell' | null, fee: number | null) => ({ action, fee });

describe('estimateRealizedRebate：價金估算', () => {
    it('多單 2,000 股 × 100、損益 5,000（2.8 折月退）→ 平倉 285 退 205、開倉 278 退 200，合計 405；買＝開倉、賣＝平倉', () => {
        expect(estimateRealizedRebate(input(), m28)).toEqual({
            status: 'ok', rebate: 405, closeRebate: 205, openRebate: 200, closeFee: 285, openFee: 278, closeExact: false, openExact: false,
            buyRebate: 200, sellRebate: 205,
        });
    });

    it('最低手續費：1,000 股 × 10 元 → 手續費 20 → 退 14', () => {
        const r = estimateRealizedRebate(input({ shares: 1000, closeNotional: 10_000, pnl: 0 }), m28);
        expect(r.closeFee).toBe(20);
        expect(r.closeRebate).toBe(14);
        expect(r.openFee).toBe(20);
        expect(r.rebate).toBe(28);
    });

    it('空單回補（融券）：開倉價金＝平倉價金＋損益；買＝回補、賣＝開倉', () => {
        // 回補 50,000 → 71 退 51；開倉賣出 51,000 → 72.675 → 73 退 53
        const r = estimateRealizedRebate(input({ shares: 1000, closeNotional: 50_000, pnl: 1000, cover: true }), m28);
        expect(r.closeFee).toBe(71);
        expect(r.closeRebate).toBe(51);
        expect(r.openFee).toBe(73);
        expect(r.openRebate).toBe(53);
        expect(r.rebate).toBe(104);
        expect(r.buyRebate).toBe(51);
        expect(r.sellRebate).toBe(53);
    });

    it('零股：50 股，最低 1 元', () => {
        // 50 × 300 = 15,000 → 21.375 → 21 退 15；開倉 14,500 → 20.66 → 21 退 15
        const r = estimateRealizedRebate(input({ shares: 50, closeNotional: 15_000, pnl: 500 }), m28);
        expect(r.closeFee).toBe(21);
        expect(r.closeRebate).toBe(15);
        expect(r.rebate).toBe(30);
        // 1 股 × 10 元：手續費 0.01425 → 最低 1 元，退 1 − round(0.28) = 1
        expect(estimateRealizedRebate(input({ shares: 1, closeNotional: 10, pnl: 0 }), m28).closeRebate).toBe(1);
    });

    it('整張＋零股：拆兩筆委託各自最低手續費（1,001 股 × 10 → 整股 20 ＋ 零股 1）', () => {
        const r = estimateRealizedRebate(input({ shares: 1001, closeNotional: 10_010, pnl: 0 }), m28);
        expect(r.closeFee).toBe(21);
        expect(r.closeRebate).toBe(15); // 20 → 14、1 → 1
        expect(r.openFee).toBe(21);
        expect(r.rebate).toBe(30);
    });

    it('不同折數：同一筆資料各自估算', () => {
        expect(estimateRealizedRebate(input(), m60).rebate).toBe(114 + 111); // 285−171、278−167
        expect(estimateRealizedRebate(input(), m28).rebate).toBe(405);
    });

    it('股數與價金取絕對值、股數四捨五入到整數', () => {
        expect(estimateRealizedRebate(input({ shares: -2000, closeNotional: -200_000 }), m28).rebate).toBe(405);
        expect(estimateRealizedRebate(input({ shares: 1999.6 }), m28).rebate).toBe(405);
    });
});

describe('estimateRealizedRebate：成交明細', () => {
    /** 玉山一般賣出：1,000 股、價金 600,000、損益 98,000 */
    const esun = (over: Partial<RealizedRebateInput> = {}) => input({ shares: 1000, closeNotional: 600_000, pnl: 98_000, fills: [fill('Sell', 855)], ...over });

    it('平倉手續費用明細 Σfee（closeExact），開倉以價金 − 損益估算', () => {
        const r = estimateRealizedRebate(esun(), m28);
        expect(r.closeExact).toBe(true);
        expect(r.closeFee).toBe(855);
        expect(r.closeRebate).toBe(616); // 855 − round(239.4)
        expect(r.openExact).toBe(false);
        expect(r.openFee).toBe(715); // 502,000 × 0.1425% = 715.35
        expect(r.openRebate).toBe(515); // 715 − round(200.2)
        expect(r.rebate).toBe(1131);
        expect(r.sellRebate).toBe(616);
        expect(r.buyRebate).toBe(515);
    });

    it('fills 買賣兩側都有：開倉也用明細（openExact）', () => {
        const r = estimateRealizedRebate(esun({ fills: [fill('Sell', 500), fill('Sell', 355), fill('Buy', 712)] }), m28);
        expect(r.closeExact).toBe(true);
        expect(r.openExact).toBe(true);
        expect(r.closeFee).toBe(855);
        expect(r.openFee).toBe(712);
        expect(r.openRebate).toBe(513); // 712 − round(199.36)
        expect(r.rebate).toBe(616 + 513);
        expect(r.buyRebate).toBe(513);
    });

    it('fill 沒有買賣別時當平倉側；任一筆缺 fee 時改用價金估算', () => {
        expect(estimateRealizedRebate(esun({ fills: [fill(null, 855)] }), m28).closeExact).toBe(true);
        expect(estimateRealizedRebate(esun({ fills: [{ action: undefined, fee: 855 }] }), m28).closeExact).toBe(true);
        const missing = estimateRealizedRebate(esun({ fills: [fill('Sell', 400), fill('Sell', null)] }), m28);
        expect(missing.closeExact).toBe(false);
        expect(missing.closeFee).toBe(855); // 600,000 × 0.1425%
    });

    it('開倉用明細時不需要損益', () => {
        const r = estimateRealizedRebate(esun({ pnl: null, fills: [fill('Sell', 855), fill('Buy', 712)] }), m28);
        expect(r.status).toBe('ok');
        expect(r.rebate).toBe(616 + 513);
    });

    it('空單回補的明細：買進 fill 是平倉（回補）、賣出 fill 是開倉', () => {
        // 回補價金 50,000、手續費 71（明細）退 51；開倉 51,000 估 73 退 53
        const r = estimateRealizedRebate(input({ shares: 1000, closeNotional: 50_000, pnl: 1000, cover: true, fills: [fill('Buy', 71)] }), m28);
        expect(r.closeExact).toBe(true);
        expect(r.openExact).toBe(false);
        expect(r.buyRebate).toBe(51);
        expect(r.sellRebate).toBe(53);
    });
});

describe('驗算例', () => {
    it('永豐 6 折月退三列：買 868＋賣 920＝1,788', () => {
        const tsmc = estimateRealizedRebate(input({ shares: 1000, closeNotional: 1_085_000, pnl: 82_000 }), m60);
        const hon = estimateRealizedRebate(input({ shares: 2000, closeNotional: 425_000, pnl: 13_000, cover: true }), m60);
        const etf = estimateRealizedRebate(input({ shares: 500, closeNotional: 90_500, pnl: -4600 }), m60);
        expect([tsmc.buyRebate, tsmc.sellRebate]).toEqual([572, 618]);
        expect([hon.buyRebate, hon.sellRebate]).toEqual([242, 250]);
        expect([etf.buyRebate, etf.sellRebate]).toEqual([54, 52]);
        expect(tsmc.rebate).toBe(1190);
        expect(realizedRebateTotals([tsmc, hon, etf])).toEqual({ rebate: 1788, buy: 868, sell: 920, counted: 3, unknown: 0, applies: true });
    });

    it('玉山 2.8 折：2884 一般賣出 1,000 股、價金 26,900、損益 1,450、賣出 fee 38 → 賣 27＋買 26＝53', () => {
        const r = estimateRealizedRebate(input({ shares: 1000, closeNotional: 26_900, pnl: 1450, fills: [fill('Sell', 38)] }), m28);
        expect(r).toMatchObject({ status: 'ok', rebate: 53, sellRebate: 27, buyRebate: 26, closeFee: 38, openFee: 36, closeExact: true, openExact: false });
    });
});

describe('estimateRealizedRebate：不適用與無法估算', () => {
    it('成交即折、10 折 → none', () => {
        expect(estimateRealizedRebate(input(), settings({ feeDiscount: 0.28, rebateMode: 'instant' })).status).toBe('none');
        expect(estimateRealizedRebate(input(), settings({ feeDiscount: 1, rebateMode: 'monthly' })).status).toBe('none');
        expect(estimateRealizedRebate(input({ shares: 0 }), settings()).status).toBe('none');
    });

    it('股數或價金 ≤ 0、需估開倉卻沒有損益、開倉價金 ≤ 0 → unknown', () => {
        expect(estimateRealizedRebate(input({ shares: 0 }), m28).status).toBe('unknown');
        expect(estimateRealizedRebate(input({ shares: Number.NaN }), m28).status).toBe('unknown');
        expect(estimateRealizedRebate(input({ closeNotional: 0 }), m28).status).toBe('unknown');
        expect(estimateRealizedRebate(input({ pnl: null }), m28).status).toBe('unknown');
        // 多單損益 ≥ 平倉價金（不合理）→ 開倉價金 ≤ 0
        expect(estimateRealizedRebate(input({ pnl: 200_000 }), m28).status).toBe('unknown');
        // 空單虧損 ≥ 平倉價金
        expect(estimateRealizedRebate(input({ pnl: -200_000, cover: true }), m28).status).toBe('unknown');
        const r = estimateRealizedRebate(input({ shares: 0 }), m28);
        expect(r.rebate).toBeNull();
        expect(r.buyRebate).toBeNull();
        expect(r.sellRebate).toBeNull();
    });
});

describe('realizedRebateSourceText', () => {
    const ok = (closeExact: boolean, openExact: boolean) => ({ ...estimateRealizedRebate(input(), m28), closeExact, openExact });

    it('一般賣出與空單回補的用語', () => {
        expect(realizedRebateSourceText(ok(true, false), false)).toBe('賣出手續費依成交明細，買進手續費以價金估算（明細未列）。');
        expect(realizedRebateSourceText(ok(true, false), true)).toBe('回補（買進）手續費依成交明細，開倉賣出手續費以價金估算（明細未列）。');
        expect(realizedRebateSourceText(ok(true, true), false)).toBe('賣出、買進手續費皆依成交明細。');
        expect(realizedRebateSourceText(ok(false, true), false)).toBe('買進手續費依成交明細，賣出手續費以價金估算（明細未列）。');
        expect(realizedRebateSourceText(ok(false, false), true)).toBe('回補（買進）、開倉賣出手續費皆以價金估算（明細未列手續費）。');
    });

    it('ok 以外回 null', () => {
        expect(realizedRebateSourceText(estimateRealizedRebate(input({ shares: 0 }), m28), false)).toBeNull();
        expect(realizedRebateSourceText(estimateRealizedRebate(input(), settings()), false)).toBeNull();
    });
});

describe('realizedRebateTotals', () => {
    it('只加總 ok 列（含買賣拆分）；unknown 計數；applies＝有 ok 或 unknown', () => {
        const ok = estimateRealizedRebate(input(), m28);
        const unknown = estimateRealizedRebate(input({ shares: 0 }), m28);
        const none = estimateRealizedRebate(input(), settings());
        expect(realizedRebateTotals([ok, unknown, none, ok])).toEqual({ rebate: 810, buy: 400, sell: 410, counted: 2, unknown: 1, applies: true });
        expect(realizedRebateTotals([unknown])).toEqual({ rebate: 0, buy: 0, sell: 0, counted: 0, unknown: 1, applies: true });
        expect(realizedRebateTotals([none])).toEqual({ rebate: 0, buy: 0, sell: 0, counted: 0, unknown: 0, applies: false });
        expect(realizedRebateTotals([])).toEqual({ rebate: 0, buy: 0, sell: 0, counted: 0, unknown: 0, applies: false });
    });
});
