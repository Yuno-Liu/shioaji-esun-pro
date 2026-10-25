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
    event_id: `b7f3a2-${seq}`, seq, report_stream: 'order', report_seq: seq, session_generation: 1, ts: '2026-10-23T09:05:12.345+08:00', environment: 'SIMULATION',
    account: { broker_id: '8840', account_id: '1234567' }, order_no: 'C0001', op_type: 'New',
    work_date: '20261023', ord_date: '20261023', ord_time: '090512345', ord_no: 'C0001', pre_ord_no: '',
    stock_no: '2884', buy_sell: 'B', ap_code: '1', price_flag: '0', bs_flag: 'R', trade: '0', od_price: 25.5,
    org_qty: 5, org_qty_share: 5000, mat_qty: 0, mat_qty_share: 0, cel_qty: 0, cel_qty_share: 0,
    err_code: '00000000', err_msg: '', user_def: 'grid:1',
    ...over,
});

const mat = (seq: number, over: Record<string, unknown> = {}) => ({
    event_id: `b7f3a2-${seq}`, seq, report_stream: 'deal', report_seq: seq, session_generation: 1, ts: '2026-10-23T09:06:00+08:00', environment: 'SIMULATION',
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

const ids = (stream: 'order' | 'deal', reportSeq: unknown, generation: unknown, sseSeq = 1, boot = 'b7f3a2') => ({
    event_id: `${boot}-${sseSeq}`, report_stream: stream, report_seq: reportSeq, session_generation: generation,
});
const orderEventId = (w: Record<string, unknown>) => (w.data as Record<string, Record<string, unknown>>).StockOrder!.event_id as string;

describe('esun event id', () => {
    it('becomes a v1 id per report stream and session generation (bridge report_seq, not the SSE seq)', () => {
        const id = esunEventId(ids('order', 3, 7, 41), 'SIMULATION');
        expect(id).toBe('v1:esun-sim-order:b7f3a2.g7:3');
        expect(parseEventId(id)).toEqual({ stream: 'v1:esun-sim-order', reset: 'b7f3a2.g7', sequence: 3n });
        expect(esunEventId(ids('deal', 1, 2), 'PRODUCTION')).toBe('v1:esun-prod-deal:b7f3a2.g2:1');
    });

    it('produces no v1 id without report_seq or session_generation (no sequence inference)', () => {
        expect(esunEventId({ event_id: 'b7f3a2-41', seq: 41 }, 'SIMULATION')).toBe('');
        expect(esunEventId(ids('order', undefined, 1), 'SIMULATION')).toBe('');
        expect(esunEventId(ids('order', 1, undefined), 'SIMULATION')).toBe('');
        expect(esunEventId(ids('order', 0, 1), 'SIMULATION')).toBe('');
        expect(esunEventId({ ...ids('order', 1, 1), event_id: 'esun:ack-1' }, 'SIMULATION')).toBe('');
        expect(esunEventId({ ...ids('order', 1, 1), report_stream: 'session' }, 'SIMULATION')).toBe('');
        // 舊版 bridge（只有 SSE 的 event_id／seq）：回報照常轉換，但不帶 v1 id
        expect(orderEventId(wire('order', ack(5, { report_seq: undefined })))).toBe('');
        expect(orderEventId(wire('order', ack(6, { session_generation: undefined })))).toBe('');
    });

    it('lets the report ledger detect a really skipped report', () => {
        const ledger = createReportLedger();
        const env = { base: 'http://127.0.0.1:8080', simulation: true };
        ledger.admit(env, esunEventId(ids('order', 1, 1, 1), 'SIMULATION'), 'order');
        expect(ledger.admit(env, esunEventId(ids('order', 3, 1, 3), 'SIMULATION'), 'order').gapOpened).toBe(true);
        expect(ledger.admit(env, esunEventId(ids('order', 3, 1, 3), 'SIMULATION'), 'order').duplicate).toBe(true);
    });

    it('does not report a gap after a session / resync event took an SSE seq', () => {
        const ledger = createReportLedger();
        const env = { base: 'http://127.0.0.1:8080', simulation: true };
        // SSE seq 1 = order#1、2 = session（重新連線失敗，同一代次）、3 = resync、4 = order#2
        const first = toEsunReportWire('order', ack(1, { event_id: 'b7f3a2-1', report_seq: 1 }), ctx());
        const next = toEsunReportWire('order', ack(4, { event_id: 'b7f3a2-4', report_seq: 2 }), ctx());
        if (first.kind !== 'report' || next.kind !== 'report') throw new Error('skipped');
        ledger.admit(env, orderEventId(first.wire), 'order');
        expect(ledger.admit(env, orderEventId(next.wire), 'order')).toMatchObject({ gapOpened: false, duplicate: false });
    });

    it('keeps order and deal reports in separate ledger streams', () => {
        const ledger = createReportLedger();
        const env = { base: 'http://127.0.0.1:8080', simulation: true };
        ledger.admit(env, esunEventId(ids('order', 1, 1, 1), 'SIMULATION'), 'order');
        ledger.admit(env, esunEventId(ids('deal', 1, 1, 2), 'SIMULATION'), 'deal');
        expect(ledger.admit(env, esunEventId(ids('order', 2, 1, 3), 'SIMULATION'), 'order').gapOpened).toBe(false);
        expect(ledger.admit(env, esunEventId(ids('deal', 3, 1, 4), 'SIMULATION'), 'deal').gapOpened).toBe(true);
        expect(ledger.takeGaps(env.base)).toEqual(new Set(['deal']));
    });

    it('does not report a gap after switching SIM → PROD → SIM (each login is a new generation)', () => {
        const ledger = createReportLedger();
        const env = { base: 'http://127.0.0.1:8080', simulation: true };
        const prod = ctx({ environment: 'PRODUCTION' });
        // SSE seq：1、2 = SIM g1 的委託；3 = session（切到 PROD）；4 = PROD g2 的委託；5、6 = session（切回 SIM）；7 = SIM g3
        const admit = (payload: Record<string, unknown>, c = ctx()) => ledger.admit(env, orderEventId(wire('order', payload, c)), 'order');
        admit(ack(1, { report_seq: 1, session_generation: 1 }));
        admit(ack(2, { report_seq: 2, session_generation: 1 }));
        expect(admit(ack(4, { report_seq: 1, session_generation: 2, environment: 'PRODUCTION' }), prod).gapOpened).toBe(false);
        expect(admit(ack(7, { report_seq: 1, session_generation: 3 })).gapOpened).toBe(false);
        expect(ledger.openGapCount(env.base)).toBe(0);
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
            lookup: () => ({ id: 'C0001', quantity: 5, dealQuantity: 0, cancelQuantity: 0, price: 25.5 }),
        })))!, [account])!;
        expect(reduced[0]!.status.cancel_quantity).toBe(1);
        const cancelled = projectOrderReport(reduced, normalizeOrderEvent(wire('order', ack(3, { op_type: 'Cancel', cel_qty: 5, cel_qty_share: 5000 }), ctx({
            lookup: () => ({ id: 'C0001', quantity: 5, dealQuantity: 0, cancelQuantity: 1, price: 25.5 }),
        })))!, [account])!;
        expect(cancelled[0]!.status).toMatchObject({ status: 'Cancelled', cancel_quantity: 5 });
    });

    it('reports a reduction as UpdateQty carrying exactly the reduction (mutation intent can confirm it)', () => {
        const report = normalizeOrderEvent(wire('order', ack(4, { op_type: 'ModifyQty', cel_qty: 4, cel_qty_share: 4000 }), ctx({
            lookup: () => ({ id: 'C0001', quantity: 5, dealQuantity: 0, cancelQuantity: 0, price: 25.5 }),
        })));
        expect(report).toMatchObject({ opType: 'UpdateQty', cancelQuantity: 4, orderQuantity: 1 });
    });

    it('reports a price change as UpdatePrice with the new price', () => {
        const report = normalizeOrderEvent(wire('order', ack(5, { op_type: 'ModifyPrice', od_price: 26 })));
        expect(report).toMatchObject({ opType: 'UpdatePrice', modifiedPrice: 26, price: 26 });
    });

    it('infers the operation from the known order when the bridge says Unknown', () => {
        const report = normalizeOrderEvent(wire('order', ack(6, { op_type: 'Unknown', cel_qty: 5, cel_qty_share: 5000 }), ctx({
            lookup: () => ({ id: 'C0001', quantity: 5, dealQuantity: 0, cancelQuantity: 0, price: 25.5 }),
        })));
        expect(report).toMatchObject({ kind: 'order', opType: 'Cancel' });
    });

    it('marks a broker error code as a failed report', () => {
        const report = normalizeOrderEvent(wire('order', ack(7, { err_code: 'AG0003', err_msg: '查無委託' })));
        expect(report).toMatchObject({ failed: true, opCode: 'AG0003' });
    });

    describe('a failed report (PB4-1)', () => {
        const known = { id: 'C0001', quantity: 5, dealQuantity: 0, cancelQuantity: 0, price: 25.5 };
        const working = () => projectOrderReport([], normalizeOrderEvent(wire('order', ack(1)))!, [account])!;
        const failedAck = (seq: number, over: Record<string, unknown>) => toEsunReportWire('order',
            ack(seq, { err_code: '00000123', err_msg: '委託已失效', ...over }), ctx({ lookup: () => known }));

        it('whose operation stays unknown after local inference keeps the order and is flagged unresolved', () => {
            // 0→0 被拒的新單與 5→5 被拒的刪改單形狀相同：bridge 說 Unknown，本地量價也推不出
            const result = failedAck(2, { op_type: 'Unknown' });
            if (result.kind !== 'report') throw new Error(result.reason);
            expect(result.unresolvedFailure).toEqual({ opCode: '00000123', opMsg: '委託已失效' });
            const report = normalizeOrderEvent(result.wire)!;
            expect(report).toMatchObject({ failed: true, opType: '' });
            const rows = working();
            expect(projectOrderReport(rows, report, [account])).toBe(rows);
            // 本地沒有這筆委託：不建列（不會變成 Failed 的新列）
            const unknown = toEsunReportWire('order', ack(3, { op_type: 'Unknown', err_code: '00000123' }), ctx());
            if (unknown.kind !== 'report') throw new Error(unknown.reason);
            expect(unknown.unresolvedFailure).toMatchObject({ opCode: '00000123' });
            expect(projectOrderReport([], normalizeOrderEvent(unknown.wire)!, [account])).toEqual([]);
        });

        it('inferred as a cancel or price change keeps the working order without a flag', () => {
            const rows = working();
            for (const [seq, over] of [[4, { op_type: 'Unknown', cel_qty: 5, cel_qty_share: 5000 }], [5, { op_type: 'Unknown', od_price: 26 }], [6, { op_type: 'ModifyQty' }]] as const) {
                const result = failedAck(seq, over);
                if (result.kind !== 'report') throw new Error(result.reason);
                expect(result.unresolvedFailure).toBeUndefined();
                expect(projectOrderReport(rows, normalizeOrderEvent(result.wire)!, [account])).toBe(rows);
            }
        });

        it('of a new order still fails the order without a flag', () => {
            const result = failedAck(7, { op_type: 'New' });
            if (result.kind !== 'report') throw new Error(result.reason);
            expect(result.unresolvedFailure).toBeUndefined();
            const rows = projectOrderReport([], normalizeOrderEvent(result.wire)!, [account])!;
            expect(rows[0]!.status).toMatchObject({ status: 'Failed', status_code: '00000123' });
        });
    });

    it('keeps odd-lot quantities in shares', () => {
        const report = normalizeOrderEvent(wire('order', ack(8, { ap_code: '5', org_qty: 0.1, org_qty_share: 100 })));
        expect(report).toMatchObject({ quantity: 100, orderLot: 'IntradayOdd' });
    });

    describe('the reservation ACK measured in simulation (PB6-2)', () => {
        // 2026-10-25 玉山模擬環境：盤中零股 2 股的預約單 ACK（數量為字串且為股、err_code 空字串）
        const measuredAck = (seq: number, over: Record<string, unknown> = {}) => ({
            event_id: `b7f3a2-${seq}`, seq, report_stream: 'order', report_seq: seq, session_generation: 1,
            ts: '2026-10-25T15:27:10.550+08:00', environment: 'SIMULATION', account: { broker_id: '8840', account_id: '1234567' },
            order_no: 'P0E031V0', op_type: 'New',
            work_date: '20261027', ord_date: '20261025', ord_time: '152710550', ord_no: '', pre_ord_no: 'P0E031V0', ord_status: '1',
            stock_no: '2884', buy_sell: 'B', ap_code: '5', price_flag: '0', bs_flag: 'R', trade: '0', od_price: '25.5',
            org_qty: '2', before_qty: '0', after_qty: '0', mat_qty: '0', cel_qty: '0', action: 'O', err_code: '', err_msg: '', user_def: '',
            ...over,
        });
        const known = { id: 'P0E031V0', quantity: 2, dealQuantity: 0, cancelQuantity: 0, price: 25.5 };

        it('projects a 2-share PreSubmitted reservation, also over the local row from the order response', () => {
            const report = normalizeOrderEvent(wire('order', measuredAck(1)))!;
            expect(report).toMatchObject({ kind: 'order', opType: 'New', id: 'P0E031V0', ordno: '', failed: false, quantity: 2, orderLot: 'IntradayOdd' });
            const rows = projectOrderReport([], report, [account])!;
            expect(rows).toHaveLength(1);
            expect(rows[0]!.order).toMatchObject({ id: 'P0E031V0', ordno: '', quantity: 2 });
            expect(rows[0]!.status).toMatchObject({ status: 'PreSubmitted', order_quantity: 2, deal_quantity: 0, cancel_quantity: 0 });
            // 重播同一筆 ACK（本地已有 PreSubmitted 列）：仍是 PreSubmitted
            expect(projectOrderReport(rows, report, [account])![0]!.status.status).toBe('PreSubmitted');
        });

        it('projects the delete ACK of the reservation as Cancelled', () => {
            const rows = projectOrderReport([], normalizeOrderEvent(wire('order', measuredAck(1)))!, [account])!;
            const cancel = normalizeOrderEvent(wire('order', measuredAck(2, { op_type: 'Cancel', action: 'C', before_qty: '2', cel_qty: '2' }),
                ctx({ lookup: () => known })))!;
            expect(cancel).toMatchObject({ opType: 'Cancel', cancelQuantity: 2, failed: false });
            expect(projectOrderReport(rows, cancel, [account])![0]!.status).toMatchObject({ status: 'Cancelled', cancel_quantity: 2 });
        });

        it('keeps Submitted once the reservation has an exchange order number', () => {
            const opened = normalizeOrderEvent(wire('order', measuredAck(3, { ord_no: 'C0042', ord_status: '2' })))!;
            expect(projectOrderReport([], opened, [account])![0]!.status.status).toBe('Submitted');
        });
    });

    it('accepts the legacy wrapped bridge shape', () => {
        const legacy = { state: 'StockOrder', event_id: 'esun-ack-C0001-1a2b3c4d', data: { StockOrder: { ...ack(9), event_id: undefined, seq: undefined, report_stream: undefined, report_seq: undefined, session_generation: undefined } } };
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

    it('dedups fills by the bridge key mkt_seq_num before the other SDK fields', () => {
        const body = (w: Record<string, unknown>) => (w.data as Record<string, Record<string, unknown>>).StockDeal!;
        expect(body(wire('deal', mat(4, { mkt_seq_num: '000417' }))).exchange_seq).toBe('000417');
        expect(body(wire('deal', mat(5, { mktSeqNum: '000418' }))).exchange_seq).toBe('000418');
        expect(body(wire('deal', mat(6))).exchange_seq).toBe('M000123');
        // 同一筆 MAT 重送（event id 不同、mat_no 不同）仍是同一個成交序號，不會重複計入
        const rows = projectOrderReport([], normalizeOrderEvent(wire('order', ack(1)))!, [account])! as AccountedTrade[];
        const once = projectTradeDeal(rows, normalizeOrderEvent(wire('deal', mat(7, { mkt_seq_num: '000419' })))!)!;
        const again = projectTradeDeal(once, normalizeOrderEvent(wire('deal', mat(2, { event_id: 'c0ffee-2', mkt_seq_num: '000419', mat_no: 'M999' })))!)!;
        expect(again[0]!.status.deal_quantity).toBe(2);
    });

    it('takes mkt_seq_num like the bridge (Python `or`): numeric 0 and empty string mean no key', () => {
        const body = (w: Record<string, unknown>) => (w.data as Record<string, Record<string, unknown>>).StockDeal!;
        // bridge：str(mkt_seq_num or mktSeqNum or "").strip()
        expect(body(wire('deal', mat(4, { mkt_seq_num: 0 }))).exchange_seq).toBe('M000123');
        expect(body(wire('deal', mat(5, { mkt_seq_num: '' }))).exchange_seq).toBe('M000123');
        expect(body(wire('deal', mat(6, { mkt_seq_num: 0, mktSeqNum: '000420' }))).exchange_seq).toBe('000420');
        expect(body(wire('deal', mat(7, { mkt_seq_num: '', mktSeqNum: 0 }))).exchange_seq).toBe('M000123');
        expect(body(wire('deal', mat(8, { mkt_seq_num: 417 }))).exchange_seq).toBe('417');
        // 兩筆 mkt_seq_num 為 0 的不同成交不會被當成同一筆
        const rows = projectOrderReport([], normalizeOrderEvent(wire('order', ack(1)))!, [account])! as AccountedTrade[];
        const first = projectTradeDeal(rows, normalizeOrderEvent(wire('deal', mat(9, { mkt_seq_num: 0, mat_no: 'M1', mat_qty: 1, mat_qty_share: 1000 })))!)!;
        const second = projectTradeDeal(first, normalizeOrderEvent(wire('deal', mat(10, { mkt_seq_num: 0, mat_no: 'M2', mat_qty: 1, mat_qty_share: 1000 })))!)!;
        expect(second[0]!.status.deal_quantity).toBe(2);
    });

    it('matches a fill without pre_ord_no to the local reservation order by ord_no', () => {
        // 預約單：本地 id 為 pre_ord_no（P0001），開盤後的 MAT 只帶 ord_no（C0009）
        const reserved = projectOrderReport([], normalizeOrderEvent(wire('order', ack(1, { pre_ord_no: 'P0001', ord_no: 'C0009', order_no: 'C0009' })))!, [account])! as AccountedTrade[];
        expect(reserved[0]!.order).toMatchObject({ id: 'P0001', ordno: 'C0009' });
        const lookup: EsunReportContext['lookup'] = (orderId, acc, by) => {
            const row = reserved.find(t => (by === 'ordno' ? t.order.ordno : t.order.id) === orderId
                && t.account?.broker_id === acc.broker_id && t.account?.account_id === acc.account_id);
            return row ? { id: row.order.id, quantity: row.order.quantity, dealQuantity: row.status.deal_quantity, cancelQuantity: row.status.cancel_quantity, price: row.order.price } : undefined;
        };
        const deal = normalizeOrderEvent(wire('deal', mat(2, { ord_no: 'C0009', order_no: 'C0009', pre_ord_no: '' }), ctx({ lookup })));
        expect(deal).toMatchObject({ kind: 'deal', tradeId: 'P0001' });
        expect(projectTradeDeal(reserved, deal!)![0]!.status.deal_quantity).toBe(2);
        // 本地找不到時維持 ord_no
        expect(normalizeOrderEvent(wire('deal', mat(3, { ord_no: 'C0010', order_no: 'C0010' }), ctx({ lookup })))).toMatchObject({ tradeId: 'C0010' });
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
