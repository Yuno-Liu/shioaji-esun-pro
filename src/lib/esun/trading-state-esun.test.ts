// src/lib/esun/trading-state-esun.test.ts — 玉山帳戶經 trading-state 的權威讀取／快取重建（PB2-1～PB2-3）
//
// 上游模組（shioaji、stream、account-store…）與 trading-state.test.ts 一樣以 mock 隔離；玉山的
// dispatch、order-mapping、report-adapter 用真實實作，回報串流與 service 以替身取代。

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeOrderEvent, type OrderEventReport } from '../order-report';
import type { Trade } from '../types/order';
import type { Account } from '../types/portfolio';
import { fromEsunOrderResult } from './order-mapping';
import { toEsunReportWire } from './report-adapter';
import type { EsunOrderResult } from './types';

const mocks = vi.hoisted(() => ({
    account: { account_type: 'S', broker_id: '8840', account_id: '1234567', person_id: '', signed: true, username: '' },
    order: null as ((r: OrderEventReport) => void) | null,
    signals: new Set<(s: unknown) => void>(),
    positions: vi.fn(), trades: vi.fn(), balance: vi.fn(), margin: vi.fn(), subscribe: vi.fn(), health: vi.fn(),
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
    refreshHealth: async () => undefined, lastSkippedOrderRows: 0,
} }));

const epoch = 1792717200; // 2026-10-23 09:00 +08:00
const account = mocks.account as Account;

/** bridge /esun/orders 的一列（整股 5 張） */
function row(over: Record<string, unknown> = {}): Trade {
    return fromEsunOrderResult({
        ord_no: 'C0001', pre_ord_no: '', stock_no: '2884', buy_sell: 'B', ap_code: '1', price_flag: '0', bs_flag: 'R', trade: '0',
        od_price: 25.5, org_qty: 5, org_qty_share: 5000, mat_qty: 0, mat_qty_share: 0, cel_qty: 0, cel_qty_share: 0,
        avg_price: 0, ord_date: '20261023', ord_time: '090000000', ...over,
    } as EsunOrderResult, account)!;
}

let reportSeq = 0;
/** bridge SSE 的 MAT（經前端轉換後進上游回報管線） */
function mat(mktSeqNum: string, lots: number): OrderEventReport {
    reportSeq += 1;
    const result = toEsunReportWire('deal', {
        event_id: `boot1-${100 + reportSeq}`, report_stream: 'deal', report_seq: reportSeq, session_generation: 1,
        ts: '2026-10-23T09:06:00+08:00', environment: 'PRODUCTION', account: { broker_id: '8840', account_id: '1234567' },
        ord_no: 'C0001', stock_no: '2884', buy_sell: 'B', ap_code: '1', trade: '0', mat_price: 25.5,
        mat_qty: lots, mat_qty_share: lots * 1000, mkt_seq_num: mktSeqNum, mat_no: `M-${mktSeqNum}`,
    }, { environment: 'PRODUCTION', account });
    if (result.kind !== 'report') throw new Error(result.reason);
    return normalizeOrderEvent(result.wire)!;
}

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

let root: ReactTestRenderer | undefined;
let store: typeof import('../trading-state');
const local = () => store.getTradingState().trades.find(t => t.order.id === 'C0001')!;
const reasons = (scope: 'orders' | 'positions') => store.getTradingState().queries[scope].reasons;
async function emit(report: OrderEventReport) { await act(async () => { mocks.order!(report); vi.advanceTimersByTime(50); }); }
async function signal(value: unknown) {
    await act(async () => { mocks.signals.forEach(l => l(value)); await vi.advanceTimersByTimeAsync(100); });
}
async function authoritativeRead() {
    await act(async () => { vi.advanceTimersByTime(1600); await store.refreshTradingState('orders'); });
}

beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(epoch * 1000);
    vi.stubGlobal('navigator', { locks: { request: (_n: string, _o: unknown, cb: (lock: object) => unknown) => cb({}) } });
    vi.stubGlobal('BroadcastChannel', undefined); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.order = null; mocks.signals.clear(); reportSeq = 0;
    mocks.positions.mockReset().mockResolvedValue([]);
    mocks.trades.mockReset().mockResolvedValue([row()]);
    mocks.balance.mockReset().mockResolvedValue({ acc_balance: 100, date: '2026-10-23', errmsg: '' });
    mocks.subscribe.mockReset().mockResolvedValue(undefined);
    mocks.health.mockReset().mockResolvedValue({ state: 'Healthy', reasons: [] });
    store = await import('../trading-state');
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

    it('keeps the legacy behaviour for a row with only the aggregate (no esun_fills)', async () => {
        const response = deferred<Trade[]>();
        mocks.trades.mockImplementationOnce(() => response.promise);
        let run!: Promise<void>;
        await act(async () => { vi.advanceTimersByTime(1600); run = store.refreshTradingState('orders'); await Promise.resolve(); });
        await emit(mat('000417', 2));
        response.resolve([row({ mat_qty: 2, mat_qty_share: 2000, avg_price: 25.5 })]);
        await act(async () => { await run; });
        // 舊格式的 `${id}:agg` 對不上 mkt_seq_num：重播照舊套用（只能由快照邊界提示）
        expect(local().status.deal_quantity).toBe(4);
        expect(local().status.deals.map(d => d.seq)).toEqual(['C0001:agg', '000417']);
        expect(reasons('orders')).toContain('snapshot-boundary');
    });
});

describe('cache rebuild of an E.SUN account (PB2-2)', () => {
    it('never lowers the locally projected fill quantity below the cache row', async () => {
        await emit(mat('000417', 1));
        await emit(mat('000418', 2));
        expect(local().status.deal_quantity).toBe(3);
        // bridge 重啟後的快照只有 2 張（沒收到 MAT 的成交不在 event 量內）
        mocks.trades.mockReset().mockResolvedValue([row({ mat_qty: 2, mat_qty_share: 2000, avg_price: 25.5 })]);
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(mocks.trades).toHaveBeenCalledWith('S', expect.objectContaining({ account_id: '1234567' }), { refresh: false });
        expect(reasons('orders')).not.toContain('sequence-gap'); // 快取重建已完成
        expect(local().status).toMatchObject({ deal_quantity: 3, status: 'PartFilled' });
        expect(local().status.deals.map(d => d.seq)).toEqual(['000417', '000418']);
    });

    it('takes the cache row when it knows more than the local projection', async () => {
        await emit(mat('000417', 1));
        mocks.trades.mockReset().mockResolvedValue([row({ mat_qty: 4, mat_qty_share: 4000, avg_price: 25.5, cel_qty: 1, cel_qty_share: 1000 })]);
        await signal({ kind: 'resync', reason: 'bridge_restarted' });
        expect(reasons('orders')).not.toContain('sequence-gap');
        expect(local().status).toMatchObject({ deal_quantity: 4, cancel_quantity: 1, status: 'Cancelled' });
    });
});

describe('ws_reconnected resync without a cache refresh (PB2-3)', () => {
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
});
