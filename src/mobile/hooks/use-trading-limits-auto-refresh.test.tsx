// 永豐交易額度的「委託事件後自動重查」：去抖、最短間隔、連續事件合併、只查受影響且正在顯示的證券帳戶、
// 期貨與玉山帳戶不重查、頁面隱藏時不查（回到可見補查一次）、第一次讀到委託只當基準。
// 事件來源以 mock 的 useTradingState().trades 模擬（同 lib/trading-state 的投影）；查詢以 mock 的 fetchTradingLimits 計數，不打任何 API。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    fetchTradingLimits: vi.fn(),
    trading: { trades: [] as unknown[], queries: { orders: { updatedAt: 1 as number | null } } },
    // S1：lib 的送單／改單／刪單函式（自動重查只讀額度，任何一個都不得呼叫）
    send: {
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelVerifiedOrder: vi.fn(),
        cancelOrders: vi.fn(),
        cancelComboOrder: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
    },
}));
vi.mock('../../lib/shioaji', () => ({ fetchTradingLimits: m.fetchTradingLimits, ...m.send }));
vi.mock('../../lib/trading-state', () => ({ useTradingState: () => m.trading }));

import {
    LIMITS_EVENT_DEBOUNCE_MS,
    LIMITS_EVENT_MAX_WAIT_MS,
    TRADING_LIMITS_MIN_REFRESH_MS,
    loadTradingLimits,
    resetTradingLimitsForTest,
    useTradingLimits,
} from './use-trading-limits';

type Acc = { broker_id: string; account_id: string; account_type: 'S' | 'F' };
const sinopac: Acc = { broker_id: '9A95', account_id: '1234567', account_type: 'S' };
const sinopac2: Acc = { broker_id: '9A95', account_id: '7777777', account_type: 'S' };
const esun: Acc = { broker_id: '8840', account_id: '0099887', account_type: 'S' };
const fut: Acc = { broker_id: 'F002000', account_id: '7654321', account_type: 'F' };
const LIMITS = {
    trading_limit: 1_000_000, trading_used: 0, trading_available: 1_000_000,
    margin_limit: 0, margin_used: 0, margin_available: 0, short_limit: 0, short_used: 0, short_available: 0,
};

function trade(account: Acc, id: string, status = 'Submitted', deal = 0, cancel = 0) {
    return {
        account,
        contract: { code: '2330', security_type: account.account_type === 'F' ? 'FUT' : 'STK', exchange: 'TSE', target_code: null },
        order: { id, seqno: id, ordno: id, action: 'Buy', price: 100, quantity: 3, account },
        status: { id, status, status_code: '', order_quantity: 3, deal_quantity: deal, cancel_quantity: cancel, modified_price: 0, msg: '', deals: [] },
    };
}

function Probe({ account }: { account: Acc | null }) {
    useTradingLimits(account);
    return null;
}

let view: ReactTestRenderer | undefined;
let shown: Acc | null = sinopac;
async function mount(account: Acc | null = sinopac) {
    shown = account;
    await act(async () => { view = create(createElement(Probe, { account })); });
}
/** 交易狀態更新（新的清單參考）→ 重繪讓 hook 看到 */
async function setTrades(trades: unknown[], ordersUpdatedAt: number | null = 1) {
    m.trading = { trades, queries: { orders: { updatedAt: ordersUpdatedAt } } };
    if (view) await act(async () => { view!.update(createElement(Probe, { account: shown })); });
}
async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const calls = () => m.fetchTradingLimits.mock.calls.length;
const callsFor = (a: Acc) => m.fetchTradingLimits.mock.calls.filter(([x]) => x.account_id === a.account_id).length;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T02:00:00Z'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetTradingLimitsForTest();
    m.fetchTradingLimits.mockReset().mockResolvedValue(LIMITS);
    m.trading = { trades: [trade(sinopac, 'A')], queries: { orders: { updatedAt: 1 } } };
    shown = sinopac;
});
afterEach(async () => {
    if (view) await act(async () => view!.unmount());
    view = undefined;
    resetTradingLimitsForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('SinoPac trading limits refresh after order events', () => {
    it('debounces an event by LIMITS_EVENT_DEBOUNCE_MS (outside the minimum interval)', async () => {
        await mount();
        expect(calls()).toBe(1); // 首次讀取
        await advance(TRADING_LIMITS_MIN_REFRESH_MS + 5_000);
        await setTrades([trade(sinopac, 'A'), trade(sinopac, 'B')]); // 新委託
        expect(calls()).toBe(1);
        await advance(LIMITS_EVENT_DEBOUNCE_MS - 1);
        expect(calls()).toBe(1);
        await advance(1);
        expect(calls()).toBe(2);
        expect(m.fetchTradingLimits).toHaveBeenLastCalledWith({ broker_id: '9A95', account_id: '1234567' });
        await advance(60_000);
        expect(calls()).toBe(2); // 只查一次
    });

    it('never violates the minimum interval: an early event waits for the earliest allowed time', async () => {
        await mount();
        await advance(1_000);
        await setTrades([trade(sinopac, 'A', 'PartFilled', 1)]); // 成交
        await advance(TRADING_LIMITS_MIN_REFRESH_MS - 1_000 - 1);
        expect(calls()).toBe(1);
        await advance(1);
        expect(calls()).toBe(2);
    });

    it('coalesces bursts: one refresh at most LIMITS_EVENT_MAX_WAIT_MS after the first event, later events wait for the interval', async () => {
        await mount();
        await advance(15_000);
        const start = Date.now();
        const times: number[] = [];
        m.fetchTradingLimits.mockImplementation(async () => { times.push(Date.now() - start); return LIMITS; });
        for (let i = 1; i <= 10; i++) {
            await setTrades([trade(sinopac, 'A', 'PartFilled', i % 3, 0), trade(sinopac, `N${i}`)]);
            await advance(1_000);
        }
        await advance(30_000);
        // 第一筆事件在 0 秒：6 秒時查一次；之後的事件等到上次查詢後 10 秒（16 秒）
        expect(times).toEqual([LIMITS_EVENT_MAX_WAIT_MS, LIMITS_EVENT_MAX_WAIT_MS + TRADING_LIMITS_MIN_REFRESH_MS]);
    });

    it('refreshes only the affected stock account; futures and E.SUN events never trigger a query', async () => {
        await mount();
        await advance(15_000);
        await setTrades([trade(sinopac, 'A'), trade(fut, 'F1'), trade(esun, 'E1')]);
        await advance(30_000);
        expect(calls()).toBe(1);
        // 另一個永豐證券帳戶（沒有畫面顯示）：不查，也不查目前顯示的帳戶
        await setTrades([trade(sinopac, 'A'), trade(fut, 'F1', 'Filled', 3), trade(esun, 'E1', 'Cancelled', 0, 3), trade(sinopac2, 'B1')]);
        await advance(30_000);
        expect(calls()).toBe(1);
        expect(callsFor(sinopac2)).toBe(0);
    });

    it('a futures or E.SUN view never schedules a refresh', async () => {
        await mount(esun);
        expect(calls()).toBe(1); // 玉山首次讀取上限（既有行為）
        m.trading = { trades: [trade(esun, 'E1')], queries: { orders: { updatedAt: 1 } } };
        await advance(15_000);
        await setTrades([trade(esun, 'E1', 'PartFilled', 1)]);
        await advance(60_000 - 15_000 - 1);
        expect(calls()).toBe(1);
        await act(async () => view!.unmount());
        view = undefined;
        await mount(fut);
        await setTrades([trade(fut, 'F1')]);
        await advance(30_000);
        expect(callsFor(fut)).toBe(0);
    });

    it('the first orders read is only a baseline', async () => {
        m.trading = { trades: [], queries: { orders: { updatedAt: null } } };
        await mount();
        await advance(15_000);
        await setTrades([trade(sinopac, 'A'), trade(sinopac, 'B')], 1);
        await advance(30_000);
        expect(calls()).toBe(1);
    });

    it('does not query while the page is hidden; catches up once when visible again', async () => {
        const listeners = new Set<() => void>();
        const doc = {
            visibilityState: 'visible',
            addEventListener: (_: string, l: () => void) => listeners.add(l),
            removeEventListener: (_: string, l: () => void) => listeners.delete(l),
        };
        vi.stubGlobal('document', doc);
        await mount();
        await advance(15_000);
        doc.visibilityState = 'hidden';
        await setTrades([trade(sinopac, 'A', 'Cancelled', 0, 3)]); // 刪單
        await advance(60_000);
        expect(calls()).toBe(1);
        await setTrades([trade(sinopac, 'A', 'Cancelled', 0, 3), trade(sinopac, 'B')]);
        await advance(5_000);
        expect(calls()).toBe(1);
        doc.visibilityState = 'visible';
        await act(async () => { listeners.forEach(l => l()); });
        await advance(0);
        expect(calls()).toBe(2);
        await act(async () => { listeners.forEach(l => l()); });
        await advance(60_000);
        expect(calls()).toBe(2);
    });

    it('an event while no view shows the account is caught up once when it mounts (still within the TTL)', async () => {
        await mount();
        await act(async () => view!.unmount());
        view = undefined;
        await advance(15_000);
        // 沒有畫面：只記下
        m.trading = { trades: [trade(sinopac, 'A', 'PartFilled', 1)], queries: { orders: { updatedAt: 1 } } };
        // 用另一個顯示中的永豐帳戶把清單餵給 hook
        await mount(sinopac2);
        expect(callsFor(sinopac2)).toBe(1);
        await advance(30_000);
        expect(callsFor(sinopac)).toBe(1);
        await act(async () => view!.unmount());
        view = undefined;
        await mount(sinopac);
        await advance(0);
        expect(callsFor(sinopac)).toBe(2);
        await advance(60_000);
        expect(callsFor(sinopac)).toBe(2);
    });

    it('S1: order events only re-read the limits of that account, never send / amend / cancel orders', async () => {
        await mount();
        await advance(15_000);
        await setTrades([trade(sinopac, 'A', 'PartFilled', 1), trade(sinopac, 'B')]);
        await advance(30_000);
        await setTrades([trade(sinopac, 'A', 'Cancelled', 1, 2), trade(sinopac, 'B', 'Filled', 3)]);
        await advance(30_000);
        for (const f of Object.values(m.send)) expect(f).not.toHaveBeenCalled();
        expect(m.fetchTradingLimits.mock.calls.every(([a]) => a.broker_id === '9A95' && a.account_id === '1234567')).toBe(true);
        expect(calls()).toBe(3);
    });

    it('a manual refresh after the event already covers it (no second query)', async () => {
        await mount();
        await advance(15_000);
        await setTrades([trade(sinopac, 'A', 'PartFilled', 1)]);
        await advance(500);
        await act(async () => { await loadTradingLimits(sinopac, { force: true }); });
        expect(calls()).toBe(2);
        await advance(60_000);
        expect(calls()).toBe(2);
    });
});
