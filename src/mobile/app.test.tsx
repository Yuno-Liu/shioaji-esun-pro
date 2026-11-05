// 殼層：延遲載入的分頁／下單面板 chunk 載入失敗時（F2／M-PLAT-1），只在該區塊顯示「載入失敗」與［重試］；
// 狀態列、分頁列、toast、常駐確認面板不可被卸載；重試會重新 import，成功後正常顯示
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ failOrders: true, failTicket: true, ordersLoads: 0, ticketLoads: 0 }));

vi.mock('../lib/stream', () => ({ ensureStream: () => undefined }));
vi.mock('../lib/trading-state', () => ({ useTradingState: () => ({ trades: [] }) }));
vi.mock('./components/status-bar', () => ({ StatusBar: () => createElement('div', { 'data-testid': 'mock-status-bar' }) }));
vi.mock('./components/toast-host', () => ({ ToastHost: () => createElement('div', { 'data-testid': 'mock-toast-host' }) }));
vi.mock('./components/order-confirm-sheet', () => ({ OrderConfirmSheet: () => createElement('div', { 'data-testid': 'mock-confirm-sheet' }) }));
vi.mock('./components/bottom-sheet', () => ({
    BottomSheet: ({ open, children, testId }: { open: boolean; children: unknown; testId?: string }) =>
        (open ? createElement('div', { 'data-testid': testId }, children as never) : null),
}));
// 以 getter 模擬 chunk 載入失敗：app.tsx 的 load().then(m => m.X) 在 fail=true 時 reject
vi.mock('./routes/orders-page', () => ({
    get OrdersPage() {
        m.ordersLoads++;
        if (m.failOrders) throw new TypeError('Failed to fetch dynamically imported module: orders-page.js');
        return () => createElement('p', { 'data-testid': 'orders-page' }, '委託');
    },
}));
vi.mock('./components/order-ticket-sheet', () => ({
    get OrderTicketSheet() {
        m.ticketLoads++;
        if (m.failTicket) throw new TypeError('Failed to fetch dynamically imported module: order-ticket-sheet.js');
        return () => createElement('div', { 'data-testid': 'ticket-sheet' });
    },
}));
vi.mock('./components/order-action-sheet', () => ({ OrderActionSheet: () => null }));
vi.mock('./routes/watchlist-page', () => ({ WatchlistPage: () => null }));
vi.mock('./routes/trade-page', () => ({ TradePage: () => null }));
vi.mock('./routes/positions-page', () => ({ PositionsPage: () => null }));
vi.mock('./routes/account-page', () => ({ AccountPage: () => null }));
vi.mock('./hooks/use-risk-pnl-feed', () => ({ useRiskPnlFeed: () => undefined }));
vi.mock('./hooks/use-fill-sound', () => ({ useFillSound: () => undefined }));
vi.mock('./hooks/use-wake-lock', () => ({ useWakeLock: () => undefined }));
vi.mock('./lib/resume-gate-runtime', () => ({ startResumeGate: () => () => undefined }));
vi.mock('./lib/watchlist-context', () => ({ WatchlistProvider: ({ children }: { children?: unknown }) => children }));

import { MobileShell } from './app';
import { MODULE_LOAD_ERROR_TEXT } from './components/route-error-boundary';
import { openTicket, resetMobileUiForTest } from './lib/mobile-store';

let view: ReactTestRenderer | undefined;

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const byTestId = (id: string) => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === id);
const press = (id: string) => act(async () => { byTestId(id)[0]!.props.onClick(); });

function expectPersistentChromeMounted() {
    expect(byTestId('mobile-shell')).toHaveLength(1);
    expect(byTestId('mock-status-bar')).toHaveLength(1);
    expect(byTestId('mobile-tab-bar')).toHaveLength(1);
    expect(byTestId('mock-toast-host')).toHaveLength(1);
    expect(byTestId('mock-confirm-sheet')).toHaveLength(1);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('location', { hash: '#/orders', pathname: '/mobile.html', search: '', reload: vi.fn() });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetMobileUiForTest();
    m.failOrders = true;
    m.failTicket = true;
    m.ordersLoads = 0;
    m.ticketLoads = 0;
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function mount() {
    await act(async () => { view = create(createElement(MobileShell)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

describe('MobileShell lazy module failures', () => {
    it('a failed tab chunk shows 載入失敗＋重試 in the content area only; the shell chrome stays mounted', async () => {
        await mount();
        expect(byTestId('route-load-error')).toHaveLength(1);
        expect(JSON.stringify(view!.toJSON())).toContain(MODULE_LOAD_ERROR_TEXT);
        expectPersistentChromeMounted();
    });

    it('重試 re-imports the tab module after the network recovers', async () => {
        await mount();
        const loads = m.ordersLoads;
        m.failOrders = false;
        await press('route-load-error-retry');
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(m.ordersLoads).toBeGreaterThan(loads);
        expect(byTestId('orders-page')).toHaveLength(1);
        expect(byTestId('route-load-error')).toHaveLength(0);
        expectPersistentChromeMounted();
    });

    it('a failed order-ticket chunk shows the error in its own sheet; the tab content and chrome stay mounted; retry loads it', async () => {
        m.failOrders = false;
        await mount();
        expect(byTestId('orders-page')).toHaveLength(1);
        await act(async () => { openTicket({ code: '2330', action: 'Buy' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(byTestId('ticket-load-error')).toHaveLength(1);
        expect(byTestId('orders-page')).toHaveLength(1);
        expectPersistentChromeMounted();
        m.failTicket = false;
        await press('ticket-load-error-body-retry');
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(byTestId('ticket-sheet')).toHaveLength(1);
        expect(byTestId('ticket-load-error')).toHaveLength(0);
    });
});
