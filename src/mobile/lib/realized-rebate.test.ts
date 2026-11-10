// 已實現損益的預估退佣：價金估算（整張／零股、最低手續費）、空單回補、玉山成交明細（平倉／開倉兩側）、
// 期貨不計、沒有月退、缺股數或價金、兩家券商不同折數，以及合計。金額全為合成值。
import { describe, expect, it } from 'vitest';
import { DEFAULT_TRADING_COST_SETTINGS, type TradingCostSettings } from '../../lib/trading-cost-settings';
import type { RealizedPnlRow } from './account-pnl';
import { realizedRebateTotals, realizedRowRebate } from './realized-rebate';

const settings = (over: Partial<TradingCostSettings> = {}): TradingCostSettings => ({ ...DEFAULT_TRADING_COST_SETTINGS, ...over });
const m28 = settings({ feeDiscount: 0.28, rebateMode: 'monthly' });

const stockRow = (over: Record<string, unknown> = {}): RealizedPnlRow => ({
    id: 1, code: '2330', quantity: 2, pnl: 5000, date: '20261110', dseq: 'D1', price: 100, pr_ratio: 0, cond: 'Cash', seqno: 'S1',
    market: 'S', accountKey: '9A95:1234567',
    ...over,
} as RealizedPnlRow);

const fill = (action: 'Buy' | 'Sell' | null, fee: number | null) => ({ action, fee });

describe('realizedRowRebate：價金估算', () => {
    it('驗算例：永豐現股 2 張 × 100、損益 5,000（2.8 折月退）→ 平倉 285 退 205、開倉 278 退 200，合計 405', () => {
        const r = realizedRowRebate(stockRow(), m28);
        expect(r).toEqual({
            status: 'ok', rebate: 405, closeRebate: 205, openRebate: 200, closeFee: 285, openFee: 278, closeExact: false, openExact: false,
        });
    });

    it('最低手續費：1,000 股 × 10 元 → 手續費 20 → 退 14', () => {
        const r = realizedRowRebate(stockRow({ quantity: 1, price: 10, pnl: 0 }), m28);
        expect(r.closeFee).toBe(20);
        expect(r.closeRebate).toBe(14);
        expect(r.openFee).toBe(20);
        expect(r.rebate).toBe(28);
    });

    it('空單回補（融券）：開倉價金＝平倉價金＋損益', () => {
        // 回補 50,000 → 71 退 51；開倉賣出 51,000 → 72.675 → 73 退 53
        const r = realizedRowRebate(stockRow({ quantity: 1, price: 50, pnl: 1000, cond: 'ShortSelling' }), m28);
        expect(r.closeFee).toBe(71);
        expect(r.closeRebate).toBe(51);
        expect(r.openFee).toBe(73);
        expect(r.openRebate).toBe(53);
        expect(r.rebate).toBe(104);
    });

    it('零股：quantity 0.05 張＝50 股，最低 1 元', () => {
        // 50 × 300 = 15,000 → 21.375 → 21 退 15；開倉 14,500 → 20.66 → 21 退 15
        const r = realizedRowRebate(stockRow({ quantity: 0.05, price: 300, pnl: 500 }), m28);
        expect(r.closeFee).toBe(21);
        expect(r.closeRebate).toBe(15);
        expect(r.rebate).toBe(30);
        // 1 股 × 10 元：手續費 0.01425 → 最低 1 元，退 1 − round(0.28) = 1
        expect(realizedRowRebate(stockRow({ quantity: 0.001, price: 10, pnl: 0 }), m28).closeRebate).toBe(1);
    });

    it('整張＋零股：拆兩筆委託各自最低手續費（1,001 股 × 10 → 整股 20 ＋ 零股 1）', () => {
        const r = realizedRowRebate(stockRow({ quantity: 1.001, price: 10, pnl: 0 }), m28);
        expect(r.closeFee).toBe(21);
        expect(r.closeRebate).toBe(15); // 20 → 14、1 → 1
        expect(r.openFee).toBe(21);
        expect(r.rebate).toBe(30);
    });

    it('兩家券商不同折數：同一筆資料各自估算', () => {
        const row = stockRow();
        expect(realizedRowRebate(row, settings({ feeDiscount: 0.6 })).rebate).toBe(114 + 111); // 285−171、278−167
        expect(realizedRowRebate(row, m28).rebate).toBe(405);
    });
});

describe('realizedRowRebate：玉山成交明細', () => {
    const detail = (over: Record<string, unknown> = {}) => ({
        shares: 1000, priceQty: 600_000, action: 'Sell' as const, realizedPnl: 98_000, fills: [fill('Sell', 855)], ...over,
    });
    const esunRow = stockRow({ quantity: 1, price: 600, pnl: 98_000, accountKey: '8840:0011223' });

    it('平倉手續費用明細 Σfee（closeExact），開倉以價金 − 損益估算', () => {
        const r = realizedRowRebate(esunRow, m28, detail());
        expect(r.closeExact).toBe(true);
        expect(r.closeFee).toBe(855);
        expect(r.closeRebate).toBe(616); // 855 − round(239.4)
        expect(r.openExact).toBe(false);
        expect(r.openFee).toBe(715); // 502,000 × 0.1425% = 715.35
        expect(r.openRebate).toBe(515); // 715 − round(200.2)
        expect(r.rebate).toBe(1131);
    });

    it('fills 買賣兩側都有：開倉也用明細（openExact）', () => {
        const r = realizedRowRebate(esunRow, m28, detail({ fills: [fill('Sell', 500), fill('Sell', 355), fill('Buy', 712)] }));
        expect(r.closeExact).toBe(true);
        expect(r.openExact).toBe(true);
        expect(r.closeFee).toBe(855);
        expect(r.openFee).toBe(712);
        expect(r.openRebate).toBe(513); // 712 − round(199.36)
        expect(r.rebate).toBe(616 + 513);
    });

    it('fill 沒有買賣別時當平倉側；任一筆缺 fee 時改用價金估算', () => {
        expect(realizedRowRebate(esunRow, m28, detail({ fills: [fill(null, 855)] })).closeExact).toBe(true);
        const missing = realizedRowRebate(esunRow, m28, detail({ fills: [fill('Sell', 400), fill('Sell', null)] }));
        expect(missing.closeExact).toBe(false);
        expect(missing.closeFee).toBe(855); // 600,000 × 0.1425%
    });

    it('明細的 action 決定是否為回補（優先於列的 cond）', () => {
        const r = realizedRowRebate(esunRow, m28, detail({ action: 'Buy', fills: [] }));
        // 回補：開倉＝600,000 ＋ 98,000 = 698,000 → 994.65 → 995
        expect(r.openFee).toBe(995);
        expect(r.closeExact).toBe(false);
    });

    it('明細缺股數或價金時退回列的 quantity × 1000、price × 股數', () => {
        const r = realizedRowRebate(stockRow(), m28, { shares: null, priceQty: null, action: null, realizedPnl: null, fills: [] });
        expect(r.rebate).toBe(405);
    });
});

describe('realizedRowRebate：不適用與無法估算', () => {
    it('期貨列 → na', () => {
        expect(realizedRowRebate(stockRow({ market: 'F' }), m28).status).toBe('na');
        expect(realizedRowRebate(stockRow({ market: 'F' }), m28).rebate).toBeNull();
    });

    it('成交即折、10 折 → none', () => {
        expect(realizedRowRebate(stockRow(), settings({ feeDiscount: 0.28, rebateMode: 'instant' })).status).toBe('none');
        expect(realizedRowRebate(stockRow(), settings({ feeDiscount: 1, rebateMode: 'monthly' })).status).toBe('none');
    });

    it('股數 0、缺成交價、開倉價金 ≤ 0 → unknown', () => {
        expect(realizedRowRebate(stockRow({ quantity: 0 }), m28).status).toBe('unknown');
        expect(realizedRowRebate(stockRow({ price: 0 }), m28).status).toBe('unknown');
        expect(realizedRowRebate(stockRow({ price: undefined }), m28).status).toBe('unknown');
        // 多單損益 ≥ 平倉價金（不合理）→ 開倉價金 ≤ 0
        expect(realizedRowRebate(stockRow({ pnl: 200_000 }), m28).status).toBe('unknown');
        expect(realizedRowRebate(stockRow({ quantity: 0 }), m28).rebate).toBeNull();
    });
});

describe('realizedRebateTotals', () => {
    it('只加總 ok 列；unknown 計數；applies＝有 ok 或 unknown', () => {
        const ok = realizedRowRebate(stockRow(), m28);
        const unknown = realizedRowRebate(stockRow({ quantity: 0 }), m28);
        const na = realizedRowRebate(stockRow({ market: 'F' }), m28);
        const none = realizedRowRebate(stockRow(), settings());
        expect(realizedRebateTotals([ok, unknown, na, none, ok])).toEqual({ rebate: 810, counted: 2, unknown: 1, applies: true });
        expect(realizedRebateTotals([unknown])).toEqual({ rebate: 0, counted: 0, unknown: 1, applies: true });
        expect(realizedRebateTotals([na, none])).toEqual({ rebate: 0, counted: 0, unknown: 0, applies: false });
        expect(realizedRebateTotals([])).toEqual({ rebate: 0, counted: 0, unknown: 0, applies: false });
    });
});
