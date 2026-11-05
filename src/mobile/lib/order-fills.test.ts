// 委託成交資料的純函式：均價、進度、類別徽章、時間軸、逐筆成交清單與合計。
import { describe, expect, it } from 'vitest';
import { esunAggregateDealSeq } from '../../lib/esun/order-mapping';
import type { Trade } from '../../lib/types/order';
import {
    avgFillPrice,
    avgPriceDigits,
    collectDealRows,
    dealTimeline,
    dealTotals,
    esunCancellableText,
    fillProgress,
    missingDealQuantity,
    orderBadges,
    quantitiesText,
} from './order-fills';

type Over = { order?: Record<string, unknown>; status?: Record<string, unknown>; contract?: Record<string, unknown> };
function trade(id: string, over: Over = {}): Trade {
    return {
        contract: { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', ...over.contract },
        order: { id, seqno: '', ordno: '', action: 'Buy', price: 100, quantity: 5, price_type: 'LMT', order_type: 'ROD', order_lot: 'Common', ...over.order },
        status: { id, status: 'Submitted', status_code: '', order_quantity: 5, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, msg: '', deals: [], ...over.status },
    } as unknown as Trade;
}
const deal = (seq: string, price: number, quantity: number, ts: number) => ({ seq, price, quantity, ts });
const fmt = (n: number) => n.toLocaleString('en-US');

describe('avgFillPrice / fillProgress', () => {
    it('weights deals and ignores invalid ones; null without deals', () => {
        expect(avgFillPrice(trade('a'))).toBeNull();
        const t = trade('a', { status: { deals: [deal('1', 100, 1, 1), deal('2', 103, 2, 2), deal('3', 0, 5, 3), deal('4', 99, 0, 4)] } });
        expect(avgFillPrice(t)).toBeCloseTo(102);
        expect(avgPriceDigits(102)).toBeUndefined();
        expect(avgPriceDigits(1083.333)).toBe(2);
    });

    it('progress uses quantity − cancel_quantity as denominator', () => {
        expect(fillProgress(trade('a', { order: { quantity: 10 }, status: { deal_quantity: 3, cancel_quantity: 2 } }))).toEqual({
            filled: 3, effective: 8, original: 10, cancelled: 2, ratio: 3 / 8,
        });
        expect(fillProgress(trade('a', { status: { cancel_quantity: 5 } })).ratio).toBe(0);
        expect(fillProgress(trade('a', { status: { deal_quantity: 9 } })).ratio).toBe(1);
    });
});

describe('orderBadges', () => {
    const labels = (t: Trade) => orderBadges(t).map(b => `${b.kind}:${b.label}`);
    it('stocks: lot, credit, day-trade, price type, time in force', () => {
        expect(labels(trade('a', { order: { order_lot: 'IntradayOdd' } }))).toEqual(['lot:盤中零股', 'price:限價', 'tif:ROD']);
        expect(labels(trade('a', { order: { order_cond: 'ShortSelling' } }))).toEqual(['lot:整股', 'credit:融券', 'price:限價', 'tif:ROD']);
        expect(labels(trade('a', { order: { daytrade_short: true, price_type: 'MKT', order_type: 'IOC' } }))).toEqual(['lot:整股', 'daytrade:當沖先賣', 'price:市價', 'tif:IOC']);
    });
    it('futures: octype (Auto hidden), price type, time in force', () => {
        const fut = { contract: { security_type: 'FUT' } };
        expect(labels(trade('f', { ...fut, order: { octype: 'Auto', price_type: 'MKP', order_type: 'IOC' } }))).toEqual(['price:範圍市價', 'tif:IOC']);
        expect(labels(trade('f', { ...fut, order: { octype: 'Cover' } }))[0]).toBe('octype:平倉');
        expect(labels(trade('f', { ...fut, order: { octype: 'DayTrade' } }))[0]).toBe('daytrade:當沖');
    });
});

describe('deal timeline and rows', () => {
    it('timeline is oldest first with untimed deals last', () => {
        const t = trade('a', { status: { deals: [deal('x', 1, 1, 0), deal('b', 1, 1, 20), deal('a', 1, 1, 10)] } });
        expect(dealTimeline(t).map(d => d.seq)).toEqual(['a', 'b', 'x']);
    });

    it('missing quantity = deal_quantity − listed deals', () => {
        expect(missingDealQuantity(trade('a', { status: { deal_quantity: 3, deals: [deal('1', 10, 1, 1)] } }))).toBe(2);
        expect(missingDealQuantity(trade('a', { status: { deal_quantity: 1, deals: [deal('1', 10, 2, 1)] } }))).toBe(0);
    });

    it('collects rows newest first, marks aggregates and missing quantity, and totals by side and unit', () => {
        const trades = [
            trade('a', { status: { deal_quantity: 3, deals: [deal('1', 100, 1, 10), deal(esunAggregateDealSeq('a'), 101, 1, 5)] } }),
            trade('b', { order: { action: 'Sell', order_lot: 'IntradayOdd' }, status: { deal_quantity: 50, deals: [deal('2', 99.5, 50, 20)] } }),
            trade('c', { contract: { code: 'TXFL6', security_type: 'FUT' }, status: { deal_quantity: 1, deals: [deal('3', 22800, 1, 15)] } }),
        ];
        const rows = collectDealRows(trades);
        expect(rows.map(r => `${r.trade.order.id}:${r.deal?.seq ?? 'missing'}`)).toEqual(['b:2', 'c:3', 'a:1', 'a:a:agg', 'a:missing']);
        expect(rows.find(r => r.deal?.seq === 'a:agg')!.aggregate).toBe(true);
        const missing = rows.find(r => r.deal === null)!;
        expect(missing.quantity).toBe(1);
        expect(missing.price).toBeNull();

        const totals = dealTotals(rows);
        expect(totals.count).toBe(5);
        expect(totals.Buy.count).toBe(4);
        expect(totals.Buy.quantities).toEqual({ 張: 3, 口: 1 });
        expect(totals.Buy.stockAmount).toBe(100 * 1000 + 101 * 1000);
        expect(totals.Sell.quantities).toEqual({ 股: 50 });
        expect(totals.Sell.stockAmount).toBe(99.5 * 50);
        expect(totals.hasDerivatives).toBe(true);
        expect(totals.amountIncomplete).toBe(true);
        expect(quantitiesText(totals.Buy.quantities, fmt)).toBe('3 張、1 口');
        expect(quantitiesText({}, fmt)).toBe('0');
    });
});

describe('esunCancellableText', () => {
    it('describes the broker hint without hiding cancel', () => {
        expect(esunCancellableText(true)).toBe('券商標示可刪');
        expect(esunCancellableText(false)).toContain('仍可嘗試刪單');
        expect(esunCancellableText(null)).toBe('券商未提供');
    });
});
