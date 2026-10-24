// src/lib/esun/report-adapter.test.ts — bridge SSE 回報經轉換後必須能被上游回報管線投影（C-05）
//
// 事件形狀：esun-bridge §5（event_id = <boot_id>-<seq>、seq、ts ISO8601 +08:00、environment、
// account、order_no、op_type）＋ SDK 回報原始欄位（與 get_order_results 同名：ord_no、stock_no、
// buy_sell、ap_code、od_price、org_qty／*_share、mat_qty、cel_qty、err_code…）。

import { describe, expect, it } from 'vitest';
import { normalizeOrderEvent } from '../order-report';
import { projectOrderReport, projectTradeDeal } from '../order-projection';
import { positionFill } from '../portfolio-projection';
import { createReportLedger, parseEventId } from '../report-ledger';
import type { AccountedTrade } from '../types/order';
import type { Account } from '../types/portfolio';
import { esunEventId, toEsunReportWire, type EsunReportContext } from './report-adapter';

const account: Account = {
    account_type: 'S', broker_id: '8840-SIM', account_id: '1234567', signed: true, username: '玉山證券', person_id: '',
};

const ctx = (over: Partial<EsunReportContext> = {}): EsunReportContext => ({
    environment: 'SIMULATION',
    account: { broker_id: '8840', account_id: '1234567' },
    ...over,
});

const ack = (seq: number, over: Record<string, unknown> = {}) => ({
    event_id: `b7f3a2-${seq}`, seq, ts: '2026-10-23T09:05:12.345+08:00', environment: 'SIMULATION',
    account: { broker_id: '8840', account_id: '1234567' }, order_no: 'C0001', op_type: 'New',
    work_date: '20261023', ord_date: '20261023', ord_time: '090512345', ord_no: 'C0001', pre_ord_no: '',
    stock_no: '2884', buy_sell: 'B', ap_code: '1', price_flag: '0', bs_flag: 'R', trade: '0', od_price: 25.5,
    org_qty: 5, org_qty_share: 5000, mat_qty: 0, mat_qty_share: 0, cel_qty: 0, cel_qty_share: 0,
    err_code: '00000000', err_msg: '', user_def: 'grid:1',
    ...over,
});

const mat = (seq: number, over: Record<string, unknown> = {}) => ({
    event_id: `b7f3a2-${seq}`, seq, ts: '2026-10-23T09:06:00+08:00', environment: 'SIMULATION',
    account: { broker_id: '8840', account_id: '1234567' }, order_no: 'C0001', op_type: 'Deal',
    ord_no: 'C0001', stock_no: '2884', buy_sell: 'B', ap_code: '1', trade: '0', mat_price: 25.5, mat_qty: 2,
    mat_qty_share: 2000, mat_no: 'M000123', mat_time: '090600000', work_date: '20261023',
    ...over,
});

function wire(event: string, payload: unknown, c: EsunReportContext = ctx()) {
    const result = toEsunReportWire(event, payload, c);
    if (result.kind !== 'report') throw new Error(`skipped: ${result.reason}`);
    return result.wire;
}

describe('esun event id', () => {
    it('becomes a supported v1 id so dedup and gap detection work', () => {
        const id = esunEventId('b7f3a2-41', 41, 'SIMULATION');
        expect(id).toBe('v1:esun-sim:b7f3a2:41');
        expect(parseEventId(id)).toEqual({ stream: 'v1:esun-sim', reset: 'b7f3a2', sequence: 41n });
        expect(esunEventId('esun-ack-C0001-abcdef12', undefined, 'PRODUCTION')).toBe('');
    });

    it('lets the report ledger detect a skipped sequence', () => {
        const ledger = createReportLedger();
        const env = { base: 'http://127.0.0.1:8080', simulation: true };
        ledger.admit(env, esunEventId('boot-1', 1, 'SIMULATION'), 'order');
        expect(ledger.admit(env, esunEventId('boot-3', 3, 'SIMULATION'), 'order').gapOpened).toBe(true);
        expect(ledger.admit(env, esunEventId('boot-3', 3, 'SIMULATION'), 'order').duplicate).toBe(true);
    });
});

describe('ACK → projected order (C-05)', () => {
    it('projects a New report into a working order of the environment-keyed account', () => {
        const report = normalizeOrderEvent(wire('order', ack(1)));
        expect(report).toMatchObject({ kind: 'order', market: 'stock', opType: 'New', id: 'C0001', failed: false, quantity: 5, price: 25.5 });
        const rows = projectOrderReport([], report!, [account]);
        expect(rows).toHaveLength(1);
        expect(rows![0]).toMatchObject({
            account,
            contract: { code: '2884', security_type: 'STK' },
            order: { id: 'C0001', action: 'Buy', quantity: 5, order_lot: 'Common', custom_field: 'grid:1' },
            status: { status: 'Submitted', cancel_quantity: 0, deal_quantity: 0 },
        });
    });

    it('applies a Cancel report as this cancel (cumulative cancel minus the known cancel)', () => {
        const rows = projectOrderReport([], normalizeOrderEvent(wire('order', ack(1)))!, [account])!;
        // 先減量 1，再刪單：SDK 回報的 cel_qty 是累計值
        const reduced = projectOrderReport(rows, normalizeOrderEvent(wire('order', ack(2, { op_type: 'ModifyQty', cel_qty: 1, cel_qty_share: 1000 }), ctx({
            lookup: () => ({ quantity: 5, dealQuantity: 0, cancelQuantity: 0, price: 25.5 }),
        })))!, [account])!;
        expect(reduced[0]!.status.cancel_quantity).toBe(1);
        const cancelled = projectOrderReport(reduced, normalizeOrderEvent(wire('order', ack(3, { op_type: 'Cancel', cel_qty: 5, cel_qty_share: 5000 }), ctx({
            lookup: () => ({ quantity: 5, dealQuantity: 0, cancelQuantity: 1, price: 25.5 }),
        })))!, [account])!;
        expect(cancelled[0]!.status).toMatchObject({ status: 'Cancelled', cancel_quantity: 5 });
    });

    it('reports a reduction as UpdateQty carrying exactly the reduction (mutation intent can confirm it)', () => {
        const report = normalizeOrderEvent(wire('order', ack(4, { op_type: 'ModifyQty', cel_qty: 4, cel_qty_share: 4000 }), ctx({
            lookup: () => ({ quantity: 5, dealQuantity: 0, cancelQuantity: 0, price: 25.5 }),
        })));
        expect(report).toMatchObject({ opType: 'UpdateQty', cancelQuantity: 4, orderQuantity: 1 });
    });

    it('reports a price change as UpdatePrice with the new price', () => {
        const report = normalizeOrderEvent(wire('order', ack(5, { op_type: 'ModifyPrice', od_price: 26 })));
        expect(report).toMatchObject({ opType: 'UpdatePrice', modifiedPrice: 26, price: 26 });
    });

    it('infers the operation from the known order when the bridge says Unknown', () => {
        const report = normalizeOrderEvent(wire('order', ack(6, { op_type: 'Unknown', cel_qty: 5, cel_qty_share: 5000 }), ctx({
            lookup: () => ({ quantity: 5, dealQuantity: 0, cancelQuantity: 0, price: 25.5 }),
        })));
        expect(report).toMatchObject({ kind: 'order', opType: 'Cancel' });
    });

    it('marks a broker error code as a failed report', () => {
        const report = normalizeOrderEvent(wire('order', ack(7, { err_code: 'AG0003', err_msg: '查無委託' })));
        expect(report).toMatchObject({ failed: true, opCode: 'AG0003' });
    });

    it('keeps odd-lot quantities in shares', () => {
        const report = normalizeOrderEvent(wire('order', ack(8, { ap_code: '5', org_qty: 0.1, org_qty_share: 100 })));
        expect(report).toMatchObject({ quantity: 100, orderLot: 'IntradayOdd' });
    });

    it('accepts the legacy wrapped bridge shape', () => {
        const legacy = { state: 'StockOrder', event_id: 'esun-ack-C0001-1a2b3c4d', data: { StockOrder: { ...ack(9), event_id: undefined, seq: undefined } } };
        const report = normalizeOrderEvent(wire('order_event', legacy));
        expect(report).toMatchObject({ kind: 'order', id: 'C0001', eventId: '' });
    });
});

describe('MAT → projected fill', () => {
    it('adds the fill to the order and to the holding of the same account', () => {
        const rows = projectOrderReport([], normalizeOrderEvent(wire('order', ack(1)))!, [account])! as AccountedTrade[];
        const deal = normalizeOrderEvent(wire('deal', mat(2)));
        expect(deal).toMatchObject({ kind: 'deal', tradeId: 'C0001', quantity: 2, price: 25.5, orderLot: 'Common' });
        const filled = projectTradeDeal(rows, deal!);
        expect(filled![0]!.status).toMatchObject({ status: 'PartFilled', deal_quantity: 2 });
        const fill = positionFill(deal!, [account], filled!);
        expect(fill).toMatchObject({ account, code: '2884', action: 'Buy', quantity: 2000, price: 25.5 });
    });

    it('keeps odd-lot fill quantities in shares', () => {
        const deal = normalizeOrderEvent(wire('deal', mat(3, { ap_code: '5', mat_qty: 0.03, mat_qty_share: 30 })));
        expect(deal).toMatchObject({ quantity: 30, orderLot: 'IntradayOdd' });
    });
});

describe('stale session events', () => {
    it('drops events from the other environment', () => {
        expect(toEsunReportWire('order', ack(1, { environment: 'PRODUCTION' }), ctx())).toEqual({ kind: 'skip', reason: 'environment' });
    });

    it('drops malformed events', () => {
        expect(toEsunReportWire('order', ack(1, { stock_no: '', order_no: '' }), ctx()).kind).toBe('skip');
        expect(toEsunReportWire('deal', mat(1, { mat_qty: 0, mat_qty_share: 0 }), ctx()).kind).toBe('skip');
        expect(toEsunReportWire('order', 'not json', ctx()).kind).toBe('skip');
    });
});
