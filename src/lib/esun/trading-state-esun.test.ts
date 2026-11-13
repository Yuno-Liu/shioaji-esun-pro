// src/lib/esun/trading-state-esun.test.ts — 玉山帳戶經 trading-state 的權威讀取／快取重建（PB2-1～PB2-3）
//
// 上游模組（shioaji、stream、account-store…）與 trading-state.test.ts 一樣以 mock 隔離；玉山的
// dispatch、order-mapping、report-adapter 用真實實作，回報串流與 service 以替身取代。

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeOrderEvent, type OrderEventReport } from '../order-report';
import type { Trade } from '../types/order';
import { remainingWorkingOrderQuantity } from '../working-order-quantity';
import type { Account } from '../types/portfolio';
import { fromEsunOrderResult } from './order-mapping';
import { toEsunReportWire } from './report-adapter';
import type { EsunOrderResult } from './types';

const mocks = vi.hoisted(() => ({
    account: { account_type: 'S', broker_id: '8840', account_id: '1234567', person_id: '', signed: true, username: '' },
    order: null as ((r: OrderEventReport) => void) | null,
    signals: new Set<(s: unknown) => void>(),
    positions: vi.fn(), trades: vi.fn(), balance: vi.fn(), margin: vi.fn(), subscribe: vi.fn(), health: vi.fn(),
    bridgeTrades: vi.fn(),
}));
vi.mock('../account-store', () => ({ useAccounts: () => ({ accounts: [mocks.account], selectedStock: mocks.account, selectedFutures: null }),
    getAccountState: () => ({ accounts: [mocks.account] }), refreshAccounts: vi.fn(), subscribeAccounts: () => () => undefined }));
vi.mock('../runtime', () => ({ getApiBase: () => 'http://fixture.invalid', isTauri: false }));
vi.mock('../boot', () => ({ subscribeTradeReports: mocks.subscribe }));
vi.mock('../trade-observations', () => ({ onTradeResponse: () => vi.fn(), observeTradeResponse: (t: unknown) => t }));
vi.mock('../contracts-cache', () => ({ ensureContract: async () => ({ code: '2884', security_type: 'STK' }), getCachedContract: () => ({ code: '2884', security_type: 'STK' }) }));
vi.mock('../quote-ownership', () => ({ retainQuote: () => vi.fn() }));
vi.mock('../shioaji', () => ({ fetchPositions: mocks.positions, fetchTrades: mocks.trades, fetchAccountBalance: mocks.balance, fetchMargin: mocks.margin, fetchTradeCacheHealth: mocks.health }));
vi.mock('../stream', () => ({ ensureStream: vi.fn(), getStreamStatus: () => 'live', isStreamOwner: () => false,
    onOrderEvent: (cb: typeof mocks.order) => { mocks.order = cb; return vi.fn(); },
    onAnyTick: () => vi.fn(), onOddLotTick: () => vi.fn(), onAnyBidAsk: () => vi.fn(), subscribeStatusStore: () => vi.fn() }));
vi.mock('./stream', () => ({
    ensureEsunOrderStream: vi.fn(),
    isEsunStreamStarted: () => true,
    getEsunStreamStatus: () => 'live',
    onEsunStreamSignal: (l: (s: unknown) => void) => { mocks.signals.add(l); return () => mocks.signals.delete(l); },
}));
vi.mock('./service', () => ({ esunTradeService: {
    getAccounts: () => [mocks.account], getSessionGeneration: () => 1, subscribe: () => () => undefined,
    refreshHealth: async () => undefined, lastSkippedOrderRows: 0, fetchTrades: mocks.bridgeTrades,
} }));

const epoch = 1792717200; // 2026-10-23 09:00 +08:00
const account = mocks.account as Account;

// trading-state（經 dispatch）使用的 order-mapping 實例：resetModules 後重新載入，
// 快取列的 esun_unresolved_failure 標記記在該實例裡
let toTrade = fromEsunOrderResult;

/** bridge /esun/orders 的一列（整股 5 張） */
function row(over: Record<string, unknown> = {}): Trade {
    return toTrade({
        ord_no: 'C0001', pre_ord_no: '', stock_no: '2884', buy_sell: 'B', ap_code: '1', price_flag: '0', bs_flag: 'R', trade: '0',
        od_price: 25.5, org_qty: 5, org_qty_share: 5000, mat_qty: 0, mat_qty_share: 0, cel_qty: 0, cel_qty_share: 0,
        avg_price: 0, ord_date: '20261023', ord_time: '090000000', ...over,
    } as EsunOrderResult, account)!;
}

let reportSeq = 0;
/** bridge SSE 的 MAT（經前端轉換後進上游回報管線） */
function mat(mktSeqNum: string, lots: number, over: Record<string, unknown> = {}): OrderEventReport {
    reportSeq += 1;
    const result = toEsunReportWire('deal', {
        event_id: `boot1-${100 + reportSeq}`, report_stream: 'deal', report_seq: reportSeq, session_generation: 1,
        ts: '2026-10-23T09:06:00+08:00', environment: 'PRODUCTION', account: { broker_id: '8840', account_id: '1234567' },
        ord_no: 'C0001', stock_no: '2884', buy_sell: 'B', ap_code: '1', trade: '0', mat_price: 25.5,
        mat_qty: lots, mat_qty_share: lots * 1000, mkt_seq_num: mktSeqNum, mat_no: `M-${mktSeqNum}`, ...over,
    }, { environment: 'PRODUCTION', account });
    if (result.kind !== 'report') throw new Error(result.reason);
    return normalizeOrderEvent(result.wire)!;
}

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

let root: ReactTestRenderer | undefined;
let store: typeof import('../trading-state');
let dispatch: typeof import('./dispatch');
const local = () => store.getTradingState().trades.find(t => t.order.id === 'C0001')!;
const reasons = (scope: 'orders' | 'positions') => store.getTradingState().queries[scope].reasons;
async function emit(report: OrderEventReport) { await act(async () => { mocks.order!(report); vi.advanceTimersByTime(50); }); }
async function signal(value: unknown) {
    await act(async () => { mocks.signals.forEach(l => l(value)); await vi.advanceTimersByTimeAsync(100); });
}
/** 讓跳號健康檢查的節流間隔過去 */
async function idle() { await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); }
async function authoritativeRead() {
    await act(async () => { vi.advanceTimersByTime(1600); await store.refreshTradingState('orders'); });
}

beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(epoch * 1000);
    toTrade = (await import('./order-mapping')).fromEsunOrderResult;
    vi.stubGlobal('navigator', { locks: { request: (_n: string, _o: unknown, cb: (lock: object) => unknown) => cb({}) } });
    vi.stubGlobal('BroadcastChannel', undefined); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.order = null; mocks.signals.clear(); reportSeq = 0;
    mocks.positions.mockReset().mockResolvedValue([]);
    mocks.trades.mockReset().mockResolvedValue([row()]);
    mocks.balance.mockReset().mockResolvedValue({ acc_balance: 100, date: '2026-10-23', errmsg: '' });
    mocks.subscribe.mockReset().mockResolvedValue(undefined);
    mocks.health.mockReset().mockResolvedValue({ state: 'Healthy', reasons: [] });
    store = await import('../trading-state');
    dispatch = await import('./dispatch');
    function Consumer() { store.useTradingState(); return null; }
    await act(async () => { root = create(createElement(Consumer)); });
    // 初次讀取（權威）：委託 C0001 5 張、尚未成交
    await act(async () => { vi.advanceTimersByTime(1600); await store.refreshTradingState(); });
    expect(local().status.deal_quantity).toBe(0);
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('authoritative read racing an SSE fill (PB2-1)', () => {
    it('does not count a fill twice when the response already includes it and lists it in esun_fills', async () => {
        const response = deferred<Trade[]>();
        mocks.trades.mockImplementationOnce(() => response.promise);
        let run!: Promise<void>;
        await act(async () => { vi.advanceTimersByTime(1600); run = store.refreshTradingState('orders'); await Promise.resolve(); });
        await emit(mat('000417', 2));
        expect(local().status.deal_quantity).toBe(2);
        // bridge 的有效成交量 max(快照, 逐筆總和) 已含這筆，esun_fills 列出它
        response.resolve([row({ mat_qty: 2, mat_qty_share: 2000, avg_price: 25.5,
            esun_fills: [{ mkt_seq_num: '000417', mat_qty_share: 2000, mat_price: 25.5 }] })]);
        await act(async () => { await run; });
        expect(local().status).toMatchObject({ deal_quantity: 2, status: 'PartFilled' });
        expect(local().status.deals.map(d => d.seq)).toEqual(['000417']);
        expect(reasons('orders')).not.toContain('projection-failed');
    });

    it('does not count a fill twice when the response has it only in the aggregate and the bridge marks the fill covered (RC1)', async () => {
        const response = deferred<Trade[]>();
        mocks.trades.mockImplementationOnce(() => response.promise);
        let run!: Promise<void>;
        await act(async () => { vi.advanceTimersByTime(1600); run = store.refreshTradingState('orders'); await Promise.resolve(); });
        // bridge 收到 MAT 時，委託快照已含這筆成交：SSE 成交帶 esun_covered_by_snapshot，以彙總 seq 投影
        await emit(mat('000417', 2, { esun_covered_by_snapshot: true }));
        expect(local().status.deal_quantity).toBe(2);
        // bridge 的實際輸出：esun_fills 也列出這筆，並帶同一個 covered 旗標
        response.resolve([row({ mat_qty: 2, mat_qty_share: 2000, avg_price: 25.5,
            esun_fills: [{ mkt_seq_num: '000417', mat_qty_share: 2000, mat_price: 25.5, esun_covered_by_snapshot: true }] })]);
        await act(async () => { await run; });
        // 重播的成交與快照列的 `${id}:agg` 是同一個 seq：不重複計入（5 張委託成交 2 張）
        expect(local().status).toMatchObject({ deal_quantity: 2, status: 'PartFilled' });
        expect(local().status.deals.map(d => d.seq)).toEqual(['C0001:agg']);
        expect(reasons('orders')).not.toContain('projection-failed');
        // 讀取期間收到回報：快照邊界仍待確認（上游語意）
        expect(reasons('orders')).toContain('snapshot-boundary');
    });

    it('a covered fill arriving during the next authoritative read, listed covered in esun_fills, stays counted once (2 lots, 1 filled)', async () => {
        // 2 張委託；快照已含 S1（1 張），MAT 還沒到 -> 彙總 1 張
        const order2 = (over: Record<string, unknown> = {}) => row({ org_qty: 2, org_qty_share: 2000, ...over });
        mocks.trades.mockReset().mockResolvedValue([order2({ mat_qty: 1, mat_qty_share: 1000, avg_price: 25.5 })]);
        await authoritativeRead();
        expect(local().status).toMatchObject({ deal_quantity: 1, status: 'PartFilled' });
        const response = deferred<Trade[]>();
        mocks.trades.mockReset().mockImplementationOnce(() => response.promise);
        let run!: Promise<void>;
        await act(async () => { vi.advanceTimersByTime(1600); run = store.refreshTradingState('orders'); await Promise.resolve(); });
        // 讀取進行中 MAT S1 才到：bridge 判 covered，以彙總 seq 投影 -> 去重
        await emit(mat('S1', 1, { esun_covered_by_snapshot: true }));
        expect(local().status.deal_quantity).toBe(1);
        response.resolve([order2({ mat_qty: 1, mat_qty_share: 1000, avg_price: 25.5,
            esun_fills: [{ mkt_seq_num: 'S1', mat_qty_share: 1000, mat_price: 25.5, esun_covered_by_snapshot: true }] })]);
        await act(async () => { await run; });
        // 重播的 S1 與回應列的彙總成交是同一個 seq：仍是 1/2，委託留在有效
        expect(local().status).toMatchObject({ deal_quantity: 1, status: 'PartFilled' });
        expect(remainingWorkingOrderQuantity(local())).toBe(1);
        expect(reasons('orders')).not.toContain('projection-failed');
    });

    it('a later, smaller snapshot (later_snapshot) replaying the fills received during the read does not count them again', async () => {
        mocks.trades.mockReset().mockResolvedValue([lots3()]);
        await authoritativeRead();
        const response = deferred<Trade[]>();
        mocks.trades.mockReset().mockImplementationOnce(() => response.promise);
        let run!: Promise<void>;
        await act(async () => { vi.advanceTimersByTime(1600); run = store.refreshTradingState('orders'); await Promise.resolve(); });
        await emit(mat('S1', 1));
        await emit(mat('S2', 1));
        expect(local().status.deal_quantity).toBe(2);
        // 玉山 REST 落後：快照只有 1 張，bridge 以較晚的快照為準，esun_fills 仍列出 S1、S2
        response.resolve([lots3({ mat_qty: 1, mat_qty_share: 1000, avg_price: 25.5,
            esun_quantity_conflict: { mat: { reason: 'later_snapshot', report_shares: 2000, snapshot_shares: 1000 } },
            esun_fills: [{ mkt_seq_num: 'S1', mat_qty_share: 1000, mat_price: 25.5 }, { mkt_seq_num: 'S2', mat_qty_share: 1000, mat_price: 25.5 }] })]);
        await act(async () => { await run; });
        // 重播的 S1、S2 都被去重：最差少計（1/3），不會誤判 3/3 已成交
        expect(local().status).toMatchObject({ deal_quantity: 1, status: 'PartFilled' });
        expect(remainingWorkingOrderQuantity(local())).toBe(2);
        expect(reasons('orders')).toContain('snapshot-boundary');
        expect(reasons('orders')).not.toContain('projection-failed');
    });
});

/** 整股 3 張（權威讀取 replace 或快取重建 upsert 的快照列） */
const lots3 = (over: Record<string, unknown> = {}) => row({ org_qty: 3, org_qty_share: 3000, ...over });
/** 盤中零股 300 股（*_qty 為張的小數、*_qty_share 為股） */
const odd300 = (over: Record<string, unknown> = {}) => row({ ap_code: '5', org_qty: 0.3, org_qty_share: 300, ...over });
const oddMat = (mktSeqNum: string, shares: number, over: Record<string, unknown> = {}) =>
    mat(mktSeqNum, shares / 1000, { ap_code: '5', mat_qty_share: shares, ...over });

describe('partial fills after a snapshot that already had one (RC1)', () => {
    const working = () => remainingWorkingOrderQuantity(local());

    it('whole lots, authoritative replace: 3 lots, snapshot 1, then MAT S1 (covered) and S2 -> 2 filled, 1 working', async () => {
        mocks.trades.mockReset().mockResolvedValue([lots3({ mat_qty: 1, mat_qty_share: 1000, avg_price: 25.5 })]);
        await authoritativeRead();
        expect(local().status).toMatchObject({ deal_quantity: 1, status: 'PartFilled' });
        await emit(mat('S1', 1, { esun_covered_by_snapshot: true }));
        expect(local().status.deal_quantity).toBe(1);
        await emit(mat('S2', 1));
        expect(local().status).toMatchObject({ deal_quantity: 2, cancel_quantity: 0, status: 'PartFilled' });
        expect(local().status.deals.map(d => d.seq)).toEqual(['C0001:agg', 'S2']);
        expect(working()).toBe(1);
        expect(reasons('orders')).toEqual([]);
        // stream.ts 對 covered 成交另外送出的訊號：持倉估算待對帳
        await signal({ kind: 'covered-deal', orderId: 'C0001' });
        expect(reasons('positions')).toContain('snapshot-boundary');
        expect(reasons('orders')).toEqual([]);
    });

    it('whole lots, cache rebuild upsert: the same sequence stays PartFilled 2/3', async () => {
        mocks.trades.mockReset().mockResolvedValue([lots3()]);
        await authoritativeRead();
        await idle();
        mocks.trades.mockReset().mockResolvedValue([lots3({ mat_qty: 1, mat_qty_share: 1000, avg_price: 25.5 })]);
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(mocks.trades).toHaveBeenCalledWith('S', expect.anything(), { refresh: false });
        expect(local().status).toMatchObject({ deal_quantity: 1, status: 'PartFilled' });
        await emit(mat('S1', 1, { esun_covered_by_snapshot: true }));
        await emit(mat('S2', 1));
        expect(local().status).toMatchObject({ deal_quantity: 2, status: 'PartFilled' });
        expect(working()).toBe(1);
        expect(reasons('orders')).toEqual([]);
    });

    it('intraday odd lot: 300 shares, snapshot 100, then MAT 100 (covered) and 100 -> 200 filled, 100 working', async () => {
        mocks.trades.mockReset().mockResolvedValue([odd300({ mat_qty: 0.1, mat_qty_share: 100, avg_price: 25.5 })]);
        await authoritativeRead();
        expect(local().order.quantity).toBe(300);
        expect(local().status).toMatchObject({ deal_quantity: 100, status: 'PartFilled' });
        await emit(oddMat('S1', 100, { esun_covered_by_snapshot: true }));
        await emit(oddMat('S2', 100));
        expect(local().status).toMatchObject({ deal_quantity: 200, status: 'PartFilled' });
        expect(working()).toBe(100);
        expect(reasons('orders')).toEqual([]);
        // 第三筆成交才是全部成交
        await emit(oddMat('S3', 100));
        expect(local().status).toMatchObject({ deal_quantity: 300, status: 'Filled' });
        expect(working()).toBe(0);
    });

    it('a cache rebuild repairs a local Filled that counted the snapshot fill twice (older bridge without the flag)', async () => {
        mocks.trades.mockReset().mockResolvedValue([lots3({ mat_qty: 1, mat_qty_share: 1000, avg_price: 25.5 })]);
        await authoritativeRead();
        // 舊版 bridge：已含在快照的 S1 照常以 mkt_seq_num 送出 -> 本地 1+1+1 = 3，誤判為 Filled
        await emit(mat('S1', 1));
        await emit(mat('S2', 1));
        expect(local().status).toMatchObject({ deal_quantity: 3, status: 'Filled' });
        expect(working()).toBe(0);
        // 快取列（bridge 的有效成交量 max(快照, 逐筆總和) = 2，逐筆 S1、S2）
        await idle();
        mocks.trades.mockReset().mockResolvedValue([lots3({ mat_qty: 2, mat_qty_share: 2000, avg_price: 25.5,
            esun_fills: [{ mkt_seq_num: 'S1', mat_qty_share: 1000, mat_price: 25.5 }, { mkt_seq_num: 'S2', mat_qty_share: 1000, mat_price: 25.5 }] })]);
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(local().status).toMatchObject({ deal_quantity: 2, status: 'PartFilled' });
        expect(working()).toBe(1);
        expect(store.getTradingState().queries.orders.error).toBe(dispatch.esunAggregateRepairMessage('C0001'));
        await authoritativeRead();
        expect(reasons('orders')).toEqual([]);
    });

    it('an authoritative read of a row whose fills exceed the order is not Filled and keeps a reason (RC2)', async () => {
        viaBridge(async () => [lots3({ mat_qty: 4, mat_qty_share: 4000, avg_price: 25.5 })]);
        await authoritativeRead();
        expect(local().status.status).not.toBe('Filled');
        expect(local().status).toMatchObject({ deal_quantity: 3, status: 'PartFilled' });
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
        expect(store.getTradingState().queries.orders.error).toBe(dispatch.esunQuantityConflictMessage('C0001'));
        // 同樣的矛盾資料再讀一次也不解除；資料一致後由權威讀取解除
        await authoritativeRead();
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
        viaBridge(async () => [lots3({ mat_qty: 2, mat_qty_share: 2000, avg_price: 25.5 })]);
        await authoritativeRead();
        expect(reasons('orders')).toEqual([]);
        expect(local().status).toMatchObject({ deal_quantity: 2, status: 'PartFilled' });
        // bridge 標示 esun_quantity_conflict 的列同樣不判終態並保留待對帳
        viaBridge(async () => [lots3({ mat_qty: 3, mat_qty_share: 3000, avg_price: 25.5, esun_quantity_conflict: true })]);
        await authoritativeRead();
        expect(local().status.status).toBe('PartFilled');
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
    });

    it('a held-open row with the raw quantity attached stays working with a remaining quantity (exceeds_order + raw_shares)', async () => {
        const capped = { mat: { reason: 'exceeds_order', report_shares: 4000, org_shares: 3000, raw_shares: 2000 } };
        viaBridge(async () => [lots3({ mat_qty: 3, mat_qty_share: 3000, avg_price: 25.5, esun_quantity_conflict: capped })]);
        await authoritativeRead();
        expect(local().status).toMatchObject({ deal_quantity: 2, status: 'PartFilled' });
        expect(working()).toBe(1);
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
    });

    it('a cache rebuild keeps the consistent local row over a held-open contradictory cache row', async () => {
        mocks.trades.mockReset().mockResolvedValue([lots3()]);
        await authoritativeRead();
        await emit(mat('S1', 1));
        await emit(mat('S2', 1));
        expect(local().status).toMatchObject({ deal_quantity: 2, status: 'PartFilled' });
        await idle();
        // 快取列被 bridge 截到委託量 3/3（沒有 raw_shares）：不可蓋掉本地 2/3
        mocks.trades.mockReset().mockResolvedValue([lots3({ mat_qty: 3, mat_qty_share: 3000, avg_price: 25.5,
            esun_quantity_conflict: { mat: { reason: 'exceeds_order', report_shares: 4000, org_shares: 3000 } } })]);
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(mocks.trades).toHaveBeenCalledWith('S', expect.anything(), { refresh: false });
        expect(local().status).toMatchObject({ deal_quantity: 2, status: 'PartFilled' });
        expect(working()).toBe(1);
        expect(reasons('orders')).toContain('snapshot-boundary');
        expect(store.getTradingState().queries.orders.error).toBe(dispatch.esunQuantityConflictMessage('C0001'));
    });
});

/** bridge SSE 的 ACK（經前端轉換後進上游回報管線） */
function ack(over: Record<string, unknown> = {}): OrderEventReport {
    reportSeq += 1;
    const result = toEsunReportWire('order', {
        event_id: `boot1-${100 + reportSeq}`, report_stream: 'order', report_seq: reportSeq, session_generation: 1,
        ts: '2026-10-23T09:05:00+08:00', environment: 'PRODUCTION', account: { broker_id: '8840', account_id: '1234567' },
        op_type: 'New', ord_date: '20261023', ord_time: '090500000', ord_no: 'C0001', pre_ord_no: '',
        stock_no: '2884', buy_sell: 'B', ap_code: '1', price_flag: '0', bs_flag: 'R', trade: '0', od_price: 25.5,
        org_qty: 5, org_qty_share: 5000, mat_qty: 0, mat_qty_share: 0, cel_qty: 0, cel_qty_share: 0,
        err_code: '00000000', err_msg: '', ...over,
    }, { environment: 'PRODUCTION', account });
    if (result.kind !== 'report') throw new Error(result.reason);
    return normalizeOrderEvent(result.wire)!;
}

describe('cache rebuild of an E.SUN account (PB2-2 / PB3-1)', () => {
    it('keeps the local row when the cache is behind and raises a reason only an authoritative read clears', async () => {
        await emit(mat('000417', 1));
        await emit(mat('000418', 2));
        expect(local().status.deal_quantity).toBe(3);
        // bridge 重啟後的快照只有 2 張；也可能是推播晚於查詢的本地高估——前端分不出哪邊對
        mocks.trades.mockReset().mockResolvedValue([row({ mat_qty: 2, mat_qty_share: 2000, avg_price: 25.5 })]);
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(mocks.trades).toHaveBeenCalledWith('S', expect.objectContaining({ account_id: '1234567' }), { refresh: false });
        expect(reasons('orders')).not.toContain('sequence-gap'); // 快取重建已完成
        expect(local().status).toMatchObject({ deal_quantity: 3, status: 'PartFilled' });
        expect(local().status.deals.map(d => d.seq)).toEqual(['000417', '000418']);
        expect(reasons('orders')).toContain('snapshot-boundary');
        expect(store.getTradingState().queries.orders.error).toContain('C0001');
        // 再一次快取重建不會解除（跳號的健康檢查有節流，先讓時間過去）
        await idle();
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(reasons('orders')).toContain('snapshot-boundary');
        expect(local().status.deal_quantity).toBe(3);
        // 權威讀取以券商快照為準並解除
        await authoritativeRead();
        expect(reasons('orders')).toEqual([]);
        expect(local().status.deal_quantity).toBe(2);
    });

    it('takes the cache row when it knows more than the local projection, without a reason', async () => {
        await emit(mat('000417', 2));
        mocks.trades.mockReset().mockResolvedValue([row({ mat_qty: 3, mat_qty_share: 3000, avg_price: 25.5 })]);
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(reasons('orders')).toEqual([]);
        expect(local().status).toMatchObject({ deal_quantity: 3, status: 'PartFilled' });
        await idle();
        mocks.trades.mockReset().mockResolvedValue([row({ mat_qty: 4, mat_qty_share: 4000, avg_price: 25.5, cel_qty: 1, cel_qty_share: 1000 })]);
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(reasons('orders')).toEqual([]);
        expect(local().status).toMatchObject({ deal_quantity: 4, cancel_quantity: 1, status: 'Cancelled' });
    });

    it('keeps a locally Failed order the cache still lists as live, until an authoritative read', async () => {
        await emit(ack({ err_code: '00000123', err_msg: '超過漲跌幅' }));
        expect(local().status.status).toBe('Failed');
        mocks.trades.mockReset().mockResolvedValue([row()]); // bridge 快取沒有記下失敗：仍是 Submitted
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(local().status.status).toBe('Failed');
        expect(reasons('orders')).toContain('snapshot-boundary');
        expect(reasons('orders')).not.toContain('sequence-gap');
        mocks.trades.mockReset().mockResolvedValue([row({ err_code: '00000123', err_msg: '超過漲跌幅' })]);
        await authoritativeRead();
        expect(reasons('orders')).toEqual([]);
        expect(local().status.status).toBe('Failed');
    });
});

/** 失敗 ACK：回報（進上游管線）與 stream.ts 依轉換結果送出的 unresolved-failure 訊號 */
function failedAck(over: Record<string, unknown>) {
    reportSeq += 1;
    const result = toEsunReportWire('order', {
        event_id: `boot1-${100 + reportSeq}`, report_stream: 'order', report_seq: reportSeq, session_generation: 1,
        ts: '2026-10-23T09:05:30+08:00', environment: 'PRODUCTION', account: { broker_id: '8840', account_id: '1234567' },
        ord_date: '20261023', ord_time: '090530000', ord_no: 'C0001', pre_ord_no: '',
        stock_no: '2884', buy_sell: 'B', ap_code: '1', price_flag: '0', bs_flag: 'R', trade: '0', od_price: 25.5,
        org_qty: 5, org_qty_share: 5000, mat_qty: 0, mat_qty_share: 0, cel_qty: 0, cel_qty_share: 0,
        err_code: '00000123', err_msg: '委託已失效', op_code: '00000123', op_msg: '委託已失效', ...over,
    }, { environment: 'PRODUCTION', account, lookup: id => {
        const t = store.getTradingState().trades.find(r => r.order.id === id);
        return t && { id: t.order.id, quantity: t.order.quantity, dealQuantity: t.status.deal_quantity, cancelQuantity: t.status.cancel_quantity, price: t.order.price };
    } });
    if (result.kind !== 'report') throw new Error(result.reason);
    const unresolved = result.unresolvedFailure
        ? { kind: 'unresolved-failure', orderId: result.orderId, opCode: result.unresolvedFailure.opCode } : null;
    return { report: normalizeOrderEvent(result.wire)!, unresolved };
}

describe('a failed report whose operation cannot be inferred (PB4-1)', () => {
    it('keeps the local order and raises a reason only an authoritative read clears, naming the order', async () => {
        const { report, unresolved } = failedAck({ op_type: 'Unknown' });
        expect(unresolved).not.toBeNull();
        await emit(report);
        await signal(unresolved);
        expect(local().status).toMatchObject({ status: 'Submitted', deal_quantity: 0, cancel_quantity: 0 });
        expect(reasons('orders')).toContain('snapshot-boundary');
        expect(store.getTradingState().queries.orders.error).toContain('C0001');
        // bridge 的背景權威查詢完成後的快取重建不會解除
        await signal({ kind: 'resync', reason: 'failed_ack_refreshed', cacheRefreshed: true });
        expect(reasons('orders')).toContain('snapshot-boundary');
        expect(local().status.status).toBe('Submitted');
        await authoritativeRead();
        expect(reasons('orders')).toEqual([]);
    });

    it('keeps the working order without a reason when the failure is inferred as a cancel or price change', async () => {
        for (const over of [{ op_type: 'Unknown', cel_qty: 5, cel_qty_share: 5000 }, { op_type: 'Unknown', od_price: 26 }, { op_type: 'Cancel' }]) {
            const { report, unresolved } = failedAck(over);
            expect(unresolved).toBeNull();
            await emit(report);
        }
        expect(local().status).toMatchObject({ status: 'Submitted', cancel_quantity: 0 });
        expect(local().order.price).toBe(25.5);
        expect(reasons('orders')).toEqual([]);
    });

    it('fails the order when the failure is a rejected new order', async () => {
        const { report, unresolved } = failedAck({ op_type: 'New' });
        expect(unresolved).toBeNull();
        await emit(report);
        expect(local().status).toMatchObject({ status: 'Failed', status_code: '00000123' });
        expect(reasons('orders')).toEqual([]);
    });
});

describe('cache rows carrying esun_unresolved_failure (PB4-2)', () => {
    const flagged = { esun_unresolved_failure: { op_code: '00000123', op_msg: '委託已失效' } };

    it('keeps the local row on a cache rebuild and raises the same reason; an authoritative read takes the snapshot', async () => {
        // 快取列即使知道更多（成交 1 張），失敗尚未判定前也不採用
        mocks.trades.mockReset().mockResolvedValue([row({ mat_qty: 1, mat_qty_share: 1000, avg_price: 25.5, ...flagged })]);
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(mocks.trades).toHaveBeenCalledWith('S', expect.anything(), { refresh: false });
        expect(local().status).toMatchObject({ status: 'Submitted', deal_quantity: 0 });
        expect(reasons('orders')).toContain('snapshot-boundary');
        expect(reasons('orders')).not.toContain('sequence-gap');
        expect(store.getTradingState().queries.orders.error).toContain('C0001');
        // 權威讀取（refresh:true）照上游語意以快照為準
        mocks.trades.mockReset().mockResolvedValue([row({ mat_qty: 1, mat_qty_share: 1000, avg_price: 25.5 })]);
        await authoritativeRead();
        expect(reasons('orders')).toEqual([]);
        expect(local().status).toMatchObject({ status: 'PartFilled', deal_quantity: 1 });
    });

    it('shares the reason of the SSE path for the same failure (one cause, not two)', async () => {
        const { report, unresolved } = failedAck({ op_type: 'Unknown' });
        await emit(report);
        await signal(unresolved);
        const before = store.getTradingState().queries.orders.error;
        await idle();
        mocks.trades.mockReset().mockResolvedValue([row(flagged)]);
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(store.getTradingState().queries.orders.error).toBe(before);
    });
});

/** 委託查詢改經玉山分派（dispatch.esunAccountQuery）讀 bridge：service.fetchTrades 由 `read` 回應 */
function viaBridge(read: (refresh: boolean) => Promise<Trade[]>) {
    mocks.bridgeTrades.mockReset().mockImplementation((_account: Account, refresh: boolean) => read(refresh));
    mocks.trades.mockReset().mockImplementation((_type: string, current: Account, opts?: { refresh?: boolean }) =>
        dispatch.esunAccountQuery('/api/v1/order/trades', current, opts?.refresh === undefined ? {} : { refresh: opts.refresh }));
}

describe('resync after the bridge re-read orders for a failed ACK (PB4-3 / PB5-1)', () => {
    it('raises only an orders reason the cache rebuild clears: no positions reason, no stale-cache snapshot-boundary', async () => {
        const cache = deferred<Trade[]>();
        mocks.trades.mockReset().mockImplementation(() => cache.promise);
        await signal({ kind: 'resync', reason: 'failed_ack_refreshed', cacheRefreshed: true });
        expect(mocks.trades).toHaveBeenCalledWith('S', expect.anything(), { refresh: false });
        // 快取重建進行中：只有 orders 的「快取同步中」
        expect(reasons('orders')).toEqual(['sequence-gap']);
        expect(store.getTradingState().queries.orders.error).toBe(dispatch.ESUN_FAILED_ACK_REFRESHED_MESSAGE);
        expect(reasons('positions')).toEqual([]);
        cache.resolve([row({ mat_qty: 1, mat_qty_share: 1000, avg_price: 25.5 })]);
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(local().status.deal_quantity).toBe(1);
        expect(reasons('orders')).toEqual([]);
        expect(reasons('positions')).toEqual([]);
        expect(store.getTradingState().needsReconcile).toBe(false);
    });

    it('raises nothing while an authoritative read is in flight, and leaves no reason after it completes', async () => {
        const response = deferred<Trade[]>();
        viaBridge(refresh => refresh ? response.promise : Promise.resolve([row()]));
        let run!: Promise<void>;
        await act(async () => { vi.advanceTimersByTime(1600); run = store.refreshTradingState('orders'); await vi.advanceTimersByTimeAsync(10); });
        expect(mocks.bridgeTrades).toHaveBeenCalledWith(expect.anything(), true);
        await signal({ kind: 'resync', reason: 'failed_ack_refreshed', cacheRefreshed: true });
        expect(reasons('orders')).toEqual([]);
        // bridge 保證進行中的權威讀取不比背景快照舊：讀取本身就會帶回失敗 ACK 的結果
        response.resolve([row({ mat_qty: 1, mat_qty_share: 1000, avg_price: 25.5 })]);
        await act(async () => { await run; await vi.advanceTimersByTimeAsync(100); });
        expect(local().status.deal_quantity).toBe(1);
        expect(reasons('orders')).toEqual([]);
        expect(reasons('positions')).toEqual([]);
        expect(mocks.bridgeTrades).not.toHaveBeenCalledWith(expect.anything(), false);
    });

    it('raises the cache-rebuild reason after all when the covering authoritative read fails', async () => {
        let fail!: (e: Error) => void;
        const response = new Promise<Trade[]>((_resolve, reject) => { fail = reject; });
        viaBridge(refresh => refresh ? response : Promise.resolve([row()]));
        let run!: Promise<void>;
        await act(async () => { vi.advanceTimersByTime(1600); run = store.refreshTradingState('orders'); await vi.advanceTimersByTimeAsync(10); });
        await signal({ kind: 'resync', reason: 'failed_ack_refreshed', cacheRefreshed: true });
        expect(reasons('orders')).toEqual([]);
        fail(new Error('bridge 503'));
        await act(async () => { await run; await vi.advanceTimersByTimeAsync(100); });
        expect(reasons('orders')).toContain('query-failed');
        expect(store.getTradingState().queries.orders.error).toContain(dispatch.ESUN_FAILED_ACK_REFRESHED_MESSAGE);
        expect(reasons('positions')).toEqual([]);
    });
});

describe('resync without a cache refresh (PB2-3 / PB5-2)', () => {
    it('keeps an orders reason through the cache rebuild; only an authoritative read clears it', async () => {
        mocks.trades.mockClear();
        await signal({ kind: 'resync', reason: 'ws_reconnected', cacheRefreshed: false });
        // 快取重建照常進行並解除 sequence-gap，但 bridge 快取沒有重讀：委託頁仍待對帳
        expect(mocks.trades).toHaveBeenCalledWith('S', expect.anything(), { refresh: false });
        expect(reasons('orders')).not.toContain('sequence-gap');
        expect(reasons('orders')).toContain('snapshot-boundary');
        expect(store.getTradingState().queries.orders.needsReconcile).toBe(true);
        await authoritativeRead();
        expect(mocks.trades).toHaveBeenLastCalledWith('S', expect.anything(), { refresh: true });
        expect(reasons('orders')).toEqual([]);
    });

    it('a ws_reconnected resync whose cache was re-read is cleared by the cache rebuild', async () => {
        await signal({ kind: 'resync', reason: 'ws_reconnected', cacheRefreshed: true });
        expect(reasons('orders')).toEqual([]);
    });

    it('a ws_reconnected resync whose cache was re-read clears positions with one delayed authoritative positions read after the rebuild', async () => {
        mocks.positions.mockClear(); mocks.trades.mockClear();
        // 上游 refreshTradingState 在上次權威讀取後 1.5 秒內不讀（冷卻）：先讓初次讀取的冷卻過去
        await act(async () => { vi.advanceTimersByTime(1600); });
        await signal({ kind: 'resync', reason: 'ws_reconnected', cacheRefreshed: true, wsOpen: true });
        // bridge 持倉快取（6 秒）過期前不讀持倉：委託已由快取重建解除，持倉原因保留
        await act(async () => { await vi.advanceTimersByTimeAsync(dispatch.ESUN_POSITIONS_REREAD_DELAY_MS - 200); });
        expect(mocks.trades).toHaveBeenCalledWith('S', expect.anything(), { refresh: false });
        expect(mocks.positions).not.toHaveBeenCalled();
        expect(reasons('orders')).toEqual([]);
        expect(reasons('positions')).toEqual(['sequence-gap']);
        await idle();
        expect(mocks.trades).not.toHaveBeenCalledWith('S', expect.anything(), { refresh: true });
        expect(mocks.positions).toHaveBeenCalledTimes(1);
        expect(reasons('orders')).toEqual([]);
        expect(reasons('positions')).toEqual([]);
    });

    it('the delayed positions read is retried when a read in flight for another tab absorbed it', async () => {
        mocks.positions.mockClear();
        await act(async () => { vi.advanceTimersByTime(1600); });
        await signal({ kind: 'resync', reason: 'ws_reconnected', cacheRefreshed: true, wsOpen: true });
        await act(async () => { await vi.advanceTimersByTimeAsync(dispatch.ESUN_POSITIONS_REREAD_DELAY_MS - 200); });
        expect(reasons('positions')).toEqual(['sequence-gap']);
        // 重讀到期時，一個只讀委託的權威讀取還在進行（委託頁按了更新、bridge 在等查詢間隔）
        const slow = deferred<Trade[]>();
        mocks.trades.mockReset().mockImplementation((_type: string, _account: unknown, opts?: { refresh?: boolean }) => opts?.refresh ? slow.promise : Promise.resolve([row()]));
        let ordersRead!: Promise<void>;
        await act(async () => {
            ordersRead = store.refreshTradingState('orders');
            // 重讀到期，讀前健康檢查的等待上限也過去：上游把那個進行中的讀取回傳給它
            await vi.advanceTimersByTimeAsync(200 + dispatch.ESUN_POSITIONS_REREAD_HEALTH_WAIT_MS + 100);
        });
        expect(mocks.positions).not.toHaveBeenCalled();
        slow.resolve([row()]);
        await act(async () => { await ordersRead; await vi.advanceTimersByTimeAsync(100); });
        expect(mocks.positions).not.toHaveBeenCalled();                    // 那次讀取沒有讀持倉
        expect(reasons('positions')).toEqual(['sequence-gap']);
        await act(async () => { await vi.advanceTimersByTimeAsync(dispatch.ESUN_POSITIONS_REREAD_RETRY_MS); });
        expect(mocks.positions).toHaveBeenCalledTimes(1);                  // 冷卻後補讀
        expect(reasons('positions')).toEqual([]);
    });

    it('a failed_ack_refresh_failed resync keeps an orders reason no cache rebuild clears, without a positions reason', async () => {
        await signal({ kind: 'resync', reason: 'failed_ack_refresh_failed', cacheRefreshed: false });
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
        expect(store.getTradingState().queries.orders.error).toBe(dispatch.ESUN_FAILED_ACK_REFRESH_FAILED_MESSAGE);
        expect(reasons('positions')).toEqual([]);
        // 之後另一次 resync 的快取重建解除自己的 sequence-gap，但不解除這個原因
        await idle();
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(mocks.trades).toHaveBeenLastCalledWith('S', expect.anything(), { refresh: false });
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
        await authoritativeRead();
        expect(reasons('orders')).toEqual([]);
    });

    it('any other resync with cacheRefreshed:false also keeps an orders reason through the cache rebuild', async () => {
        await signal({ kind: 'resync', reason: 'bridge_restarted', cacheRefreshed: false });
        expect(mocks.trades).toHaveBeenLastCalledWith('S', expect.anything(), { refresh: false });
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
        expect(store.getTradingState().queries.orders.error).toBe(dispatch.ESUN_UNREFRESHED_CACHE_MESSAGE);
        await authoritativeRead();
        expect(reasons('orders')).toEqual([]);
    });
});

describe('authoritative read of a row whose failure the latest snapshot did not list (PB5-3)', () => {
    const unresolved = { esun_unresolved_failure: { op_code: '00000123', op_msg: '委託已失效' } };

    it('is not taken as confirmed: the read keeps an orders reason that only a later authoritative read clears', async () => {
        // SSE 已先提出同一筆失敗的待對帳
        const { report, unresolved: sse } = failedAck({ op_type: 'Unknown' });
        await emit(report);
        await signal(sse);
        viaBridge(async () => [row({ ...unresolved, esun_snapshot_missing: true })]);
        await authoritativeRead();
        expect(mocks.bridgeTrades).toHaveBeenLastCalledWith(expect.anything(), true);
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
        expect(store.getTradingState().queries.orders.error).toBe(dispatch.esunSnapshotMissingFailureMessage('C0001', '00000123'));
        // 還沒判定的列再讀一次也不會解除
        await authoritativeRead();
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
        // 券商快照列出（判定）之後由權威讀取解除
        viaBridge(async () => [row({ err_code: '00000123', err_msg: '委託已失效' })]);
        await authoritativeRead();
        expect(reasons('orders')).toEqual([]);
        expect(local().status.status).toBe('Failed');
    });

    it('keeps the current behaviour for a row carrying only one of the two flags', async () => {
        for (const over of [unresolved, { esun_snapshot_missing: true }]) {
            viaBridge(async () => [row(over)]);
            await authoritativeRead();
            expect(reasons('orders')).toEqual([]);
        }
    });
});

/** 興櫃委託 E0001（bridge 快取／委託查詢列：1000 股） */
function emgRow(over: Record<string, unknown> = {}): Trade {
    return row({ ord_no: 'E0001', stock_no: '6488', ap_code: '4', od_price: 25, org_qty: 1, org_qty_share: 1000, ...over });
}

/**
 * bridge SSE 的一筆回報經 stream.ts 的轉換：可投影時為回報，興櫃缺股數欄位（unit-unknown）時為
 * 只有權威讀取能解除的 untrackable 訊號
 */
function esunEvent(event: 'order' | 'deal', over: Record<string, unknown>): { report?: OrderEventReport; signal?: unknown } {
    reportSeq += 1;
    const result = toEsunReportWire(event, {
        event_id: `boot1-${100 + reportSeq}`, report_stream: event, report_seq: reportSeq, session_generation: 1,
        ts: '2026-10-23T09:07:00+08:00', environment: 'PRODUCTION', account: { broker_id: '8840', account_id: '1234567' },
        ord_date: '20261023', ord_time: '090700000', ord_no: 'C0001', pre_ord_no: '', stock_no: '2884', buy_sell: 'B',
        ap_code: '1', price_flag: '0', bs_flag: 'R', trade: '0', err_code: '00000000', err_msg: '', ...over,
    }, { environment: 'PRODUCTION', account, lookup: id => {
        const t = store.getTradingState().trades.find(r => r.order.id === id);
        return t && { id: t.order.id, quantity: t.order.quantity, dealQuantity: t.status.deal_quantity, cancelQuantity: t.status.cancel_quantity, price: t.order.price };
    } });
    if (result.kind === 'report') return { report: normalizeOrderEvent(result.wire)! };
    if (result.reason !== 'unit-unknown') throw new Error(result.reason);
    return { signal: { kind: 'untrackable', deal: event === 'deal', authoritativeOnly: { orderId: result.orderId } } };
}
const emg = () => store.getTradingState().trades.find(t => t.order.id === 'E0001')!;
/** 興櫃委託回報（實測形狀：只有 *_qty，沒有 *_qty_share） */
const emgAckFields = { ord_no: 'E0001', stock_no: '6488', ap_code: '4', od_price: 25, org_qty: '1000', mat_qty: '0' };
/** 經上游 stream.ts 的回報帳本（跳號偵測）再送進 trading-state，與 publishStreamEvent('order_event') 相同 */
async function emitAdmitted(report: OrderEventReport) {
    const { reportLedger } = await import('../report-ledger');
    reportLedger.admit({ base: 'http://fixture.invalid', simulation: undefined }, report.eventId, report.kind);
    await emit(report);
}
/** 整股委託 C0001 的一筆無變化 ACK（推進委託回報序號） */
const plainAck = () => esunEvent('order', { op_type: 'New', od_price: 25.5, org_qty: 5, org_qty_share: 5000, mat_qty: 0, mat_qty_share: 0, cel_qty: 0, cel_qty_share: 0 });

describe('emerging-stock reports without share fields (PB8)', () => {
    beforeEach(async () => {
        // 權威讀取帶一筆興櫃列
        mocks.trades.mockReset().mockResolvedValue([row(), emgRow()]);
        await act(async () => { vi.advanceTimersByTime(1600); await store.refreshTradingState(); });
        expect(emg().status).toMatchObject({ status: 'Submitted', cancel_quantity: 0 });
        expect(emg().order.quantity).toBe(1000);
    });

    it('keeps an orders reason naming the order through a gap-triggered cache rebuild; only an authoritative read clears it', async () => {
        await emitAdmitted(plainAck().report!);
        // 他處刪除興櫃委託：ACK 不帶股數欄位，不投影
        const skipped = esunEvent('order', { ...emgAckFields, op_type: 'Cancel', cel_qty: '1000' });
        expect(skipped.report).toBeUndefined();
        await signal(skipped.signal);
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
        expect(store.getTradingState().queries.orders.error).toBe(dispatch.esunUnitUnknownMessage('E0001'));
        expect(reasons('positions')).toEqual([]);
        // 被略過的回報讓下一筆看起來跳號 → 健康檢查全部 Healthy → 快取重建（bridge 快取同樣沒套用這筆）
        mocks.trades.mockClear();
        await emitAdmitted(plainAck().report!);
        await idle();
        expect(mocks.trades).toHaveBeenCalledWith('S', expect.anything(), { refresh: false });
        expect(reasons('orders')).not.toContain('sequence-gap');
        expect(reasons('orders')).toContain('snapshot-boundary');
        expect(store.getTradingState().queries.orders.error).toContain('E0001');
        expect(emg().status.status).toBe('Submitted');
        // 權威讀取以券商快照為準並解除
        mocks.trades.mockReset().mockResolvedValue([row(), emgRow({ cel_qty: 1, cel_qty_share: 1000 })]);
        await authoritativeRead();
        expect(reasons('orders')).toEqual([]);
        expect(emg().status).toMatchObject({ status: 'Cancelled', cancel_quantity: 1000 });
    });

    it('also keeps a positions reason for a fill (MAT) through a resync cache rebuild, until an authoritative read', async () => {
        const skipped = esunEvent('deal', { ord_no: 'E0001', stock_no: '6488', ap_code: '4', mat_price: 25, mat_qty: '1000', mkt_seq_num: '000501' });
        expect(skipped.report).toBeUndefined();
        await signal(skipped.signal);
        expect(reasons('orders')).toContain('snapshot-boundary');
        expect(reasons('positions')).toContain('snapshot-boundary');
        expect(store.getTradingState().queries.positions.error).toContain('E0001');
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(mocks.trades).toHaveBeenLastCalledWith('S', expect.anything(), { refresh: false });
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
        expect(reasons('positions')).toContain('snapshot-boundary');
        expect(emg().status.deal_quantity).toBe(0);
        mocks.trades.mockReset().mockResolvedValue([row(), emgRow({ mat_qty: 1, mat_qty_share: 1000, avg_price: 25 })]);
        await act(async () => { vi.advanceTimersByTime(1600); await store.refreshTradingState(); });
        expect(reasons('orders')).toEqual([]);
        expect(reasons('positions')).toEqual([]);
        expect(emg().status).toMatchObject({ status: 'Filled', deal_quantity: 1000 });
    });

    it('raises the same reason for a failed ACK without share fields, which no cache rebuild clears (PB8-4)', async () => {
        const skipped = esunEvent('order', { ...emgAckFields, op_type: 'Unknown', err_code: '00000123', err_msg: '委託已失效' });
        expect(skipped.report).toBeUndefined();
        await signal(skipped.signal);
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
        expect(store.getTradingState().queries.orders.error).toBe(dispatch.esunUnitUnknownMessage('E0001'));
        // bridge 的背景權威查詢完成後的快取重建不會解除
        await signal({ kind: 'resync', reason: 'failed_ack_refreshed', cacheRefreshed: true });
        expect(mocks.trades).toHaveBeenLastCalledWith('S', expect.anything(), { refresh: false });
        expect(reasons('orders')).toEqual(['snapshot-boundary']);
        expect(emg().status.status).toBe('Submitted');
        await authoritativeRead();
        expect(reasons('orders')).toEqual([]);
    });

    it('projects emerging-stock reports carrying the share fields without a reason', async () => {
        const cancel = esunEvent('order', { ...emgAckFields, op_type: 'Cancel', org_qty: '1', org_qty_share: '1000', mat_qty_share: 0, cel_qty: '1', cel_qty_share: '1000' });
        expect(cancel.signal).toBeUndefined();
        await emit(cancel.report!);
        expect(emg().status).toMatchObject({ status: 'Cancelled', cancel_quantity: 1000 });
        expect(reasons('orders')).toEqual([]);
        expect(reasons('positions')).toEqual([]);
    });
});
