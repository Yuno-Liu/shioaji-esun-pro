// 委託成交資料的純函式：均價、進度、類別徽章、時間軸、逐筆成交清單與合計。
import { describe, expect, it } from 'vitest';
import { esunAggregateDealSeq, fromEsunOrderResult } from '../../lib/esun/order-mapping';
import type { EsunOrderResult } from '../../lib/esun/types';
import type { Account } from '../../lib/types/portfolio';
import type { Trade } from '../../lib/types/order';
import {
    avgFillPrice,
    avgPriceDigits,
    collectDealRows,
    dealFillTs,
    dealTimeline,
    dealTotals,
    esunCancellableText,
    fillProgress,
    lastDealFillTs,
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

// X3 F2:F1：玉山權威讀取（fromEsunOrderResult）的逐筆成交 ts 是委託時間（esun_fills 沒有成交時間），不可當成交時間
describe('E.SUN fill times after an authoritative read', () => {
    const esunAccount = { account_type: 'S', broker_id: '8840', account_id: '0099887', person_id: '', signed: true } as unknown as Account;
    const esunTrade = () => fromEsunOrderResult({
        ord_no: 'C0001', pre_ord_no: '', stock_no: '2884', buy_sell: 'B', ap_code: '1', price_flag: '0', bs_flag: 'R',
        trade: '0', od_price: 25.5, org_qty: 5, org_qty_share: 5000, mat_qty: 2, mat_qty_share: 2000, cel_qty: 0, cel_qty_share: 0,
        avg_price: 25.4, ord_date: '20261023', ord_time: '090005000',
        esun_fills: [
            { mkt_seq_num: '000417', mat_qty_share: 1000, mat_price: 25.5 },
            { mkt_seq_num: '000418', mat_qty_share: 1000, mat_price: 25.3 },
        ],
    } as unknown as EsunOrderResult, esunAccount)!;

    it('per-fill deals carrying the order time have no fill time (timeline keeps broker order, no 最後成交)', () => {
        const t = esunTrade();
        const orderTs = t.status.order_ts!;
        // 前提：lib 把每一筆逐筆成交的 ts 填成委託時間
        expect(orderTs).toBeGreaterThan(0);
        expect(t.status.deals.map(d => d.ts)).toEqual([orderTs, orderTs]);
        expect(t.status.deals.map(d => dealFillTs(t, d))).toEqual([0, 0]);
        expect(dealTimeline(t).map(d => d.seq)).toEqual(['000417', '000418']);
        expect(lastDealFillTs(t)).toBe(0);
    });

    it('deal rows: untimed E.SUN deals have ts 0 and sort after timed deals (by order time), not by the order time as fill time', () => {
        const t = esunTrade();
        const orderTs = t.status.order_ts!;
        // 永豐成交時間早於玉山委託時間：以委託時間當成交時間排序時，玉山會錯排在前
        const sinopac = trade('s1', { status: { deal_quantity: 1, order_ts: orderTs - 7200, deals: [deal('9', 100, 1, orderTs - 3600)] } });
        const rows = collectDealRows([t, sinopac]);
        expect(rows.map(r => `${r.trade.order.id}:${r.deal?.seq}`)).toEqual(['s1:9', `${t.order.id}:000417`, `${t.order.id}:000418`]);
        expect(rows.map(r => r.ts)).toEqual([orderTs - 3600, 0, 0]);
    });

    it('keeps real fill times: E.SUN SSE deals (mat_time) and SinoPac deals even at the order second', () => {
        const t = esunTrade();
        const orderTs = t.status.order_ts!;
        const live = { ...t, status: { ...t.status, deals: [...t.status.deals, { seq: '000419', price: 25.6, quantity: 1, ts: orderTs + 5400 }] } };
        expect(dealFillTs(live, live.status.deals[2]!)).toBe(orderTs + 5400);
        expect(lastDealFillTs(live)).toBe(orderTs + 5400);
        expect(dealTimeline(live).map(d => d.seq)).toEqual(['000419', '000417', '000418']);
        const sameSecond = trade('s2', { status: { order_ts: 50, deals: [deal('1', 100, 1, 50)] } });
        expect(dealFillTs(sameSecond, sameSecond.status.deals[0]!)).toBe(50);
    });
});

describe('esunCancellableText', () => {
    it('describes the broker hint without hiding cancel', () => {
        expect(esunCancellableText(true)).toBe('券商標示可刪');
        expect(esunCancellableText(false)).toContain('仍可嘗試刪單');
        expect(esunCancellableText(null)).toBe('券商未提供');
    });
});
