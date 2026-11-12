// 玉山「估算剩餘」：上限 − 今日買進（已成交＋未成交）。只扣買進；部分成交後刪單、市價以漲停價估、零股以股計、
// 結果未知以未成交計並標示、其他帳戶與其他日期不計；也以 lib 的 fromEsunOrderResult 轉出的列驗證張／股單位。
// 純函式，不打任何 API。
import { afterEach, describe, expect, it } from 'vitest';
import { clearEsunOrderMeta, setEsunOrderMetaSnapshot } from '../../lib/esun/account-details';
import { fromEsunOrderResult } from '../../lib/esun/order-mapping';
import type { EsunOrderResult } from '../../lib/esun/types';
import type { AccountedTrade } from '../../lib/types/order';
import type { Account } from '../../lib/types/portfolio';
import { esunBreakdownText, esunEstimateFlags, estimateEsunRemaining, type EsunLimitEstimateInput } from './esun-limit-estimate';

const esun = { account_type: 'S', broker_id: '8840', account_id: '0099887', person_id: 'A', signed: true, username: '' } as Account;
const other = { ...esun, account_id: '0011111' } as Account;
// 2026-11-09 10:00 台北
const NOW = Date.UTC(2026, 10, 9, 2, 0, 0);
const TODAY_TS = Date.UTC(2026, 10, 9, 1, 0, 0) / 1000;
const YESTERDAY_TS = Date.UTC(2026, 10, 8, 1, 0, 0) / 1000;

interface RowOpts {
    id?: string;
    account?: Account;
    action?: 'Buy' | 'Sell';
    status?: string;
    qty?: number;
    deal?: number;
    cancel?: number;
    price?: number;
    modified?: number;
    priceType?: 'LMT' | 'MKT';
    lot?: string;
    code?: string;
    deals?: { price: number; quantity: number }[];
    ts?: number | null;
}

function row(o: RowOpts = {}): AccountedTrade {
    const id = o.id ?? 'X';
    const account = o.account ?? esun;
    return {
        account,
        contract: { code: o.code ?? '2884', security_type: 'STK', exchange: 'TSE', target_code: null },
        order: {
            id, seqno: id, ordno: id, action: o.action ?? 'Buy', price: o.price ?? 30, quantity: o.qty ?? 1,
            price_type: o.priceType ?? 'LMT', order_lot: o.lot ?? 'Common',
            account: { broker_id: account.broker_id, account_id: account.account_id, account_type: 'S' },
        },
        status: {
            id, status: (o.status ?? 'Submitted') as AccountedTrade['status']['status'], status_code: '',
            ...(o.ts === null ? {} : { order_ts: o.ts ?? TODAY_TS }),
            order_quantity: o.qty ?? 1, deal_quantity: o.deal ?? 0, cancel_quantity: o.cancel ?? 0, modified_price: o.modified ?? 0, msg: '',
            deals: (o.deals ?? []).map((d, i) => ({ seq: `${id}-${i}`, price: d.price, quantity: d.quantity, ts: TODAY_TS })),
        },
    };
}

function est(trades: AccountedTrade[], over: Partial<EsunLimitEstimateInput> = {}) {
    return estimateEsunRemaining({ limit: 1_000_000, account: esun, trades, ordersLoaded: true, now: NOW, ...over });
}

describe('estimateEsunRemaining', () => {
    it('a buy is counted as pending, then partly filled, then cancelled (only the filled part stays)', () => {
        const placed = est([row({ qty: 5, price: 50 })]);
        expect(placed).toMatchObject({ filled: 0, pending: 250_000, remaining: 750_000, buyOrders: 1 });
        const partial = est([row({ status: 'PartFilled', qty: 5, deal: 2, price: 50, deals: [{ price: 49.5, quantity: 2 }] })]);
        expect(partial).toMatchObject({ filled: 99_000, pending: 150_000, remaining: 751_000 });
        const cancelled = est([row({ status: 'Cancelled', qty: 5, deal: 2, cancel: 3, price: 50, deals: [{ price: 49.5, quantity: 2 }] })]);
        expect(cancelled).toMatchObject({ filled: 99_000, pending: 0, remaining: 901_000, unknownOrders: 0 });
    });

    it('a partial cancel (減量) leaves only the rest pending; a price change uses modified_price', () => {
        const r = est([row({ qty: 5, cancel: 2, price: 50, modified: 48 })]);
        expect(r).toMatchObject({ filled: 0, pending: 144_000 });
    });

    it('rejected / failed orders count only their filled part; filled orders count only deals', () => {
        expect(est([row({ status: 'Failed', qty: 3, price: 50 })])).toMatchObject({ filled: 0, pending: 0, remaining: 1_000_000, buyOrders: 1 });
        expect(est([row({ status: 'Filled', qty: 2, deal: 2, price: 50, deals: [{ price: 50, quantity: 1 }, { price: 49, quantity: 1 }] })]))
            .toMatchObject({ filled: 99_000, pending: 0 });
    });

    it('missing deals fall back to the order price for the filled quantity', () => {
        expect(est([row({ status: 'PartFilled', qty: 3, deal: 2, price: 40 })])).toMatchObject({ filled: 80_000, pending: 40_000, unpricedOrders: 0 });
    });

    it('a market buy (or no price) is estimated at the contract limit_up; unknown price is flagged and left out', () => {
        const mkt = row({ qty: 2, price: 0, priceType: 'MKT', code: '2330' });
        expect(est([mkt], { limitUpOf: code => (code === '2330' ? 1_100 : undefined) })).toMatchObject({ pending: 2_200_000, remaining: -1_200_000, unpricedOrders: 0 });
        expect(est([row({ qty: 1, price: 0 })], { limitUpOf: () => 33 })).toMatchObject({ pending: 33_000 });
        const unpriced = est([mkt], { limitUpOf: () => undefined });
        expect(unpriced).toMatchObject({ pending: 0, unpricedOrders: 1, remaining: 1_000_000 });
        expect(esunEstimateFlags(unpriced)).toEqual(['1 筆委託無法判定價格，未計入']);
    });

    it('odd lots are counted in shares, board lots × 1,000', () => {
        const r = est([
            row({ id: 'O1', qty: 300, price: 100, lot: 'IntradayOdd', status: 'PartFilled', deal: 100, deals: [{ price: 99, quantity: 100 }] }),
            row({ id: 'O2', qty: 50, price: 100, lot: 'Odd' }),
            row({ id: 'C1', qty: 2, price: 100, lot: 'Common' }),
        ]);
        // 已成交 100 股 × 99 = 9,900；未成交 200 股 × 100 + 50 股 × 100 + 2 張 × 1000 × 100
        expect(r).toMatchObject({ filled: 9_900, pending: 225_000, buyOrders: 3 });
    });

    it('sells never count', () => {
        const r = est([
            row({ id: 'S1', action: 'Sell', qty: 10, price: 50 }),
            row({ id: 'S2', action: 'Sell', status: 'Filled', qty: 1, deal: 1, price: 50, deals: [{ price: 50, quantity: 1 }] }),
        ]);
        expect(r).toMatchObject({ filled: 0, pending: 0, remaining: 1_000_000, buyOrders: 0 });
    });

    it('unknown-outcome orders count as pending and flag the estimate', () => {
        const r = est([
            row({ id: 'U1', status: 'PendingSubmit', qty: 1, price: 50 }),
            row({ id: 'U2', status: 'Inactive', qty: 2, price: 50 }),
        ]);
        expect(r).toMatchObject({ pending: 150_000, unknownOrders: 2 });
        expect(esunEstimateFlags(r)).toEqual(['含 2 筆結果未知的委託（以未成交計）']);
    });

    it('other accounts and other days are ignored; rows without an order time count as today', () => {
        const r = est([
            row({ id: 'A', account: other, qty: 1, price: 50 }),
            row({ id: 'B', ts: YESTERDAY_TS, qty: 1, price: 50 }),
            row({ id: 'C', ts: null, qty: 1, price: 20 }),
        ]);
        expect(r).toMatchObject({ pending: 20_000, buyOrders: 1 });
    });

    it('flags orders not yet read and a pending reconciliation; breakdown text uses the formatter', () => {
        const r = est([], { ordersLoaded: false, ordersNeedReconcile: true });
        expect(esunEstimateFlags(r)).toEqual(['委託尚未讀取，尚未扣除今日委託', '委託待對帳，估算可能不完整']);
        const s = est([row({ qty: 1, price: 50 })]);
        expect(esunBreakdownText(s, v => `$${v}`)).toBe('上限 $1000000；今日買進 已成交 $0＋未成交 $50000');
        expect(esunBreakdownText(s, () => '•••••')).toBe('上限 •••••；今日買進 已成交 •••••＋未成交 •••••');
    });
});

describe('estimateEsunRemaining uses the E.SUN work_date (EsunOrderMeta.workDate) for "today" when present', () => {
    // 前一日（2026-11-08）20:15 台北
    const PREV_EVENING_TS = Date.UTC(2026, 10, 8, 12, 15, 0) / 1000;
    afterEach(() => clearEsunOrderMeta());

    it('a reservation placed the previous evening for today counts today (order_ts stays the previous day)', () => {
        setEsunOrderMetaSnapshot(esun, [
            // 預約單轉入盤中後 ord_date 仍是前一日，work_date 為今日
            { pre_ord_no: 'R1', ord_no: 'N1', ord_status: '2', work_date: '20261109', ord_date: '20261108', ord_time: '201500000' },
            { pre_ord_no: 'R2', ord_no: '', ord_status: '1', work_date: '20261109', ord_date: '20261108', ord_time: '201600000' },
        ]);
        const r = est([
            row({ id: 'R1', ts: PREV_EVENING_TS, status: 'PartFilled', qty: 2, deal: 1, price: 50, deals: [{ price: 50, quantity: 1 }] }),
            row({ id: 'R2', ts: PREV_EVENING_TS, status: 'PreSubmitted', qty: 1, price: 40 }),
        ]);
        expect(r).toMatchObject({ filled: 50_000, pending: 90_000, buyOrders: 2 });
        // 中繼資料未讀取時沿用 order_ts：前一日，不計入（修正前的行為）
        clearEsunOrderMeta();
        expect(est([row({ id: 'R2', ts: PREV_EVENING_TS, status: 'PreSubmitted', qty: 1, price: 40 })])).toMatchObject({ pending: 0, buyOrders: 0 });
    });

    it('a normal today order with meta is unaffected', () => {
        const trades = [row({ id: 'D1', qty: 3, price: 50 })];
        const without = est(trades);
        setEsunOrderMetaSnapshot(esun, [{ ord_no: 'D1', ord_status: '2', work_date: '20261109', ord_date: '20261109', ord_time: '090000000' }]);
        expect(est(trades)).toEqual(without);
        expect(without).toMatchObject({ pending: 150_000, buyOrders: 1 });
    });

    it('a previous-day order whose work_date is the previous day is not counted', () => {
        setEsunOrderMetaSnapshot(esun, [
            { ord_no: 'Y1', ord_status: '2', work_date: '20261108', ord_date: '20261108', ord_time: '100000000' },
            { pre_ord_no: 'Y2', ord_no: 'N2', ord_status: '2', work_date: '20261108', ord_date: '20261107', ord_time: '201500000' },
        ]);
        const r = est([
            row({ id: 'Y1', ts: YESTERDAY_TS, status: 'Filled', qty: 1, deal: 1, price: 50, deals: [{ price: 50, quantity: 1 }] }),
            row({ id: 'Y2', ts: Date.UTC(2026, 10, 7, 12, 15, 0) / 1000, status: 'Cancelled', qty: 1, cancel: 1, price: 50 }),
        ]);
        expect(r).toMatchObject({ filled: 0, pending: 0, buyOrders: 0 });
    });

    it('meta of another account is not used; a missing work_date falls back to order_ts', () => {
        setEsunOrderMetaSnapshot(other, [{ pre_ord_no: 'R3', ord_status: '1', work_date: '20261109', ord_date: '20261108', ord_time: '201500000' }]);
        setEsunOrderMetaSnapshot(esun, [{ ord_no: 'T1', ord_status: '2', work_date: '', ord_date: '20261109', ord_time: '090000000' }]);
        const r = est([
            row({ id: 'R3', ts: PREV_EVENING_TS, qty: 1, price: 40 }),
            row({ id: 'T1', qty: 1, price: 50 }),
        ]);
        expect(r).toMatchObject({ pending: 50_000, buyOrders: 1 });
    });
});

describe('estimateEsunRemaining with rows mapped by lib fromEsunOrderResult (E.SUN units)', () => {
    const base = { ord_date: '20261109', ord_time: '093000000', buy_sell: 'B', stock_no: '2884', od_price: 30 } as const;
    const map = (raw: Record<string, unknown>) => {
        const t = fromEsunOrderResult(raw as unknown as EsunOrderResult, esun);
        if (!t) throw new Error('row not mapped');
        return { ...t, account: esun } as AccountedTrade;
    };

    it('board lots (ap_code 1) are lots; intraday odd (ap_code 5) uses *_qty_share in shares', () => {
        const lot = map({ ...base, ord_no: 'L1', ap_code: '1', org_qty: 3, mat_qty: 1, cel_qty: 0, avg_price: 29.5 });
        const odd = map({ ...base, ord_no: 'O1', ap_code: '5', org_qty_share: 400, mat_qty_share: 0, cel_qty_share: 0 });
        expect(lot.order.quantity).toBe(3);
        expect(odd.order.quantity).toBe(400);
        // 整股：已成交 1 張以均價彙總成交 29.5 → 29,500；未成交 2 張 × 30 = 60,000；零股 400 股 × 30 = 12,000
        expect(est([lot, odd])).toMatchObject({ filled: 29_500, pending: 72_000 });
    });

    it('partial fill then cancel from the broker snapshot keeps only the filled part', () => {
        const done = map({ ...base, ord_no: 'L2', ap_code: '1', org_qty: 3, mat_qty: 1, cel_qty: 2, avg_price: 30 });
        expect(done.status.status).toBe('Cancelled');
        expect(est([done])).toMatchObject({ filled: 30_000, pending: 0 });
    });

    it('a row with an unresolved failure ACK is unknown: counted as pending and flagged', () => {
        const unresolved = map({ ...base, ord_no: 'L3', ap_code: '1', org_qty: 2, mat_qty: 0, cel_qty: 0, esun_unresolved_failure: { op_code: 'E01', op_msg: 'x' } });
        const r = est([unresolved]);
        expect(r).toMatchObject({ pending: 60_000, unknownOrders: 1 });
    });
});
