// 殼層重繪範圍（效能）：交易狀態每次發布（lib 最多每 50ms 一次、另有 1 秒心跳）只應重繪真正訂閱的葉節點
// （分頁列徽章、風控損益餵送），不應連帶重繪殼層根元件與目前頁面。
// 這裡不 mock useRiskPnlFeed：以可發布的 store 替身驅動 useTradingState，確認餵送仍正常、頁面與狀態列不重繪。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
    type State = {
        trades: { remaining: number }[];
        positions: { pnl: number }[];
        queries: { orders: { needsReconcile: boolean }; positions: { updatedAt: number | null } };
        margin?: { future_settle_profitloss: number };
    };
    const listeners = new Set<() => void>();
    const store = {
        state: {
            trades: [],
            positions: [],
            queries: { orders: { needsReconcile: false }, positions: { updatedAt: 1 } },
            margin: { future_settle_profitloss: 0 },
        } as State,
        subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
        get: () => store.state,
        publish(next: Partial<State>) { store.state = { ...store.state, ...next }; listeners.forEach(l => l()); },
    };
    return { store, renders: { page: 0, statusBar: 0 }, reportDailyPnl: vi.fn() };
});

vi.mock('../lib/stream', () => ({ ensureStream: () => undefined }));
vi.mock('../lib/risk', () => ({ reportDailyPnl: m.reportDailyPnl }));
vi.mock('../lib/trading-state', async () => {
    const { useSyncExternalStore } = await import('react');
    return {
        useTradingState: () => useSyncExternalStore(m.store.subscribe, m.store.get),
        getTradingState: m.store.get,
        subscribeTradingState: m.store.subscribe,
        refreshTradingStateForModeChange: async () => undefined,
    };
});
vi.mock('../lib/working-order-quantity', () => ({ remainingWorkingOrderQuantity: (t: { remaining: number }) => t.remaining }));
vi.mock('./components/status-bar', () => ({
    StatusBar: () => { m.renders.statusBar++; return null; },
}));
vi.mock('./components/toast-host', () => ({ ToastHost: () => null }));
vi.mock('./components/order-confirm-sheet', () => ({ OrderConfirmSheet: () => null }));
vi.mock('./components/bottom-sheet', () => ({ BottomSheet: () => null }));
vi.mock('./components/order-ticket-sheet', () => ({ OrderTicketSheet: () => null }));
vi.mock('./components/order-action-sheet', () => ({ OrderActionSheet: () => null }));
vi.mock('./routes/watchlist-page', () => ({ WatchlistPage: () => null, preloadWatchEditControls: async () => undefined }));
vi.mock('./routes/trade-page', () => ({ TradePage: () => null }));
vi.mock('./routes/orders-page', async () => {
    const { createElement: h } = await import('react');
    return { OrdersPage: () => { m.renders.page++; return h('p', { 'data-testid': 'orders-page' }); } };
});
vi.mock('./routes/market-page', () => ({ MarketPage: () => null }));
vi.mock('./routes/positions-page', () => ({ PositionsPage: () => null }));
vi.mock('./routes/account-page', () => ({ AccountPage: () => null }));
vi.mock('./hooks/use-fill-sound', () => ({ useFillSound: () => undefined }));
vi.mock('./hooks/use-wake-lock', () => ({ useWakeLock: () => undefined }));
vi.mock('./lib/resume-gate-runtime', () => ({ startResumeGate: () => () => undefined }));
vi.mock('./lib/watchlist-context', () => ({ WatchlistProvider: ({ children }: { children?: unknown }) => children }));

import { MobileShell } from './app';
import { resetMobileUiForTest } from './lib/mobile-store';
import { resetSheetStackForTest } from './lib/sheet-stack';

let view: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('location', { hash: '#/orders', pathname: '/mobile.html', search: '', reload: vi.fn() });
    resetMobileUiForTest();
    resetSheetStackForTest();
    m.renders.page = 0;
    m.renders.statusBar = 0;
    m.reportDailyPnl.mockClear();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    resetSheetStackForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('殼層重繪範圍', () => {
    it('交易狀態發布 3 次（只換 positions）：目前頁面與狀態列不重繪；風控損益餵送仍跟著更新；分頁列徽章仍即時', async () => {
        await act(async () => { view = create(createElement(MobileShell)); });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(view!.root.findAll(n => n.props['data-testid'] === 'orders-page')).toHaveLength(1);
        const before = { ...m.renders };

        for (const pnl of [100, 200, 300]) {
            await act(async () => { m.store.publish({ positions: [{ pnl }] }); });
        }

        // 修正前（殼層根元件訂閱交易狀態）：頁面 +3、狀態列 +3；修正後皆 +0
        expect({ page: m.renders.page - before.page, statusBar: m.renders.statusBar - before.statusBar }).toEqual({ page: 0, statusBar: 0 });
        expect(m.reportDailyPnl).toHaveBeenLastCalledWith(300, true);

        // TabBar 自己訂閱：未成交徽章仍會即時更新
        await act(async () => { m.store.publish({ trades: [{ remaining: 1 }] }); });
        expect(view!.root.findAll(n => n.props['data-testid'] === 'tab-badge' && typeof n.type === 'string')).toHaveLength(1);
        expect(m.renders.page - before.page).toBe(0);
    });
});
