// 已實現損益列的預估退佣（轉接層）：期貨 'na'、從列（quantity × 1000、price × 股數、cond）或玉山成交明細
// （shares、priceQty、action、realizedPnl、fills）取值後交給共用核心 src/lib/realized-rebate（核心案例見該檔測試）。金額全為合成值。
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

describe('realizedRowRebate：從列取值', () => {
    it('永豐現股 2 張 × 100、損益 5,000（2.8 折月退）→ 平倉 285 退 205、開倉 278 退 200，合計 405（買 200＋賣 205）', () => {
        expect(realizedRowRebate(stockRow(), m28)).toEqual({
            status: 'ok', rebate: 405, closeRebate: 205, openRebate: 200, closeFee: 285, openFee: 278, closeExact: false, openExact: false,
            buyRebate: 200, sellRebate: 205,
        });
    });

    it('quantity 為張（可有小數）：0.05 張＝50 股', () => {
        const r = realizedRowRebate(stockRow({ quantity: 0.05, price: 300, pnl: 500 }), m28);
        expect(r.closeFee).toBe(21);
        expect(r.rebate).toBe(30);
    });

    it('cond＝ShortSelling 視為空單回補：買＝回補、賣＝開倉', () => {
        const r = realizedRowRebate(stockRow({ quantity: 1, price: 50, pnl: 1000, cond: 'ShortSelling' }), m28);
        expect(r.openFee).toBe(73); // 51,000
        expect(r.buyRebate).toBe(51);
        expect(r.sellRebate).toBe(53);
    });
});

describe('realizedRowRebate：玉山成交明細', () => {
    const detail = (over: Record<string, unknown> = {}) => ({
        shares: 1000, priceQty: 600_000, action: 'Sell' as const, realizedPnl: 98_000, fills: [fill('Sell', 855)], ...over,
    });
    const esunRow = stockRow({ quantity: 1, price: 600, pnl: 98_000, accountKey: '8840:0011223' });

    it('明細的股數、價金、損益、fills 交給核心', () => {
        const r = realizedRowRebate(esunRow, m28, detail());
        expect(r).toMatchObject({ closeExact: true, closeFee: 855, closeRebate: 616, openExact: false, openFee: 715, openRebate: 515, rebate: 1131 });
        expect(r.sellRebate).toBe(616);
        expect(r.buyRebate).toBe(515);
    });

    it('明細的 action 決定是否為回補（優先於列的 cond）', () => {
        const r = realizedRowRebate(esunRow, m28, detail({ action: 'Buy', fills: [] }));
        // 回補：開倉＝600,000 ＋ 98,000 = 698,000 → 994.65 → 995
        expect(r.openFee).toBe(995);
        expect(r.closeExact).toBe(false);
        expect(r.sellRebate).toBe(r.openRebate);
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
        expect(realizedRowRebate(stockRow({ market: 'F' }), m28).buyRebate).toBeNull();
    });

    it('成交即折、10 折 → none', () => {
        expect(realizedRowRebate(stockRow(), settings({ feeDiscount: 0.28, rebateMode: 'instant' })).status).toBe('none');
        expect(realizedRowRebate(stockRow(), settings({ feeDiscount: 1, rebateMode: 'monthly' })).status).toBe('none');
    });

    it('股數 0、缺成交價 → unknown', () => {
        expect(realizedRowRebate(stockRow({ quantity: 0 }), m28).status).toBe('unknown');
        expect(realizedRowRebate(stockRow({ price: 0 }), m28).status).toBe('unknown');
        expect(realizedRowRebate(stockRow({ price: undefined }), m28).status).toBe('unknown');
        expect(realizedRowRebate(stockRow({ pnl: 200_000 }), m28).status).toBe('unknown');
    });
});

describe('realizedRebateTotals（自核心再匯出）', () => {
    it('期貨 na 與 none 不計入', () => {
        const ok = realizedRowRebate(stockRow(), m28);
        const na = realizedRowRebate(stockRow({ market: 'F' }), m28);
        const none = realizedRowRebate(stockRow(), settings());
        expect(realizedRebateTotals([ok, na, none])).toEqual({ rebate: 405, buy: 200, sell: 205, counted: 1, unknown: 0, applies: true });
        expect(realizedRebateTotals([na, none]).applies).toBe(false);
    });
});
