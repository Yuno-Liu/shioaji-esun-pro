// 「需要 HTTPS」說明頁延遲載入失敗時（app.tsx MobileApp）：顯示最小的靜態說明，仍不 bootstrap、不開串流、不掛載交易畫面。
// 成功載入的情況見 secure-context-gate.test.tsx；retryableLazy 是模組層狀態，失敗情境需要獨立的測試檔。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    bootstrap: vi.fn(),
    ensureStream: vi.fn(),
    useTradingState: vi.fn(() => ({ trades: [] })),
    gateLoads: 0,
    watchlistMounts: 0,
}));
vi.mock('../../lib/boot', () => ({ bootstrap: m.bootstrap }));
vi.mock('../../lib/stream', () => ({ ensureStream: m.ensureStream }));
vi.mock('../../lib/trading-state', () => ({ useTradingState: m.useTradingState }));
// 說明頁 chunk 抓取失敗：取用匯出時丟出（lazy 的 promise 因此 reject）
vi.mock('./secure-context-gate', () => ({
    get SecureContextGate() {
        m.gateLoads++;
        throw new TypeError('Failed to fetch dynamically imported module: secure-context-gate.js');
    },
}));
vi.mock('../components/status-bar', () => ({ StatusBar: () => createElement('div', { 'data-testid': 'mock-status-bar' }) }));
vi.mock('../components/toast-host', () => ({ ToastHost: () => null }));
vi.mock('../components/order-confirm-sheet', () => ({ OrderConfirmSheet: () => null }));
vi.mock('../components/order-ticket-sheet', () => ({ OrderTicketSheet: () => null }));
vi.mock('../components/order-action-sheet', () => ({ OrderActionSheet: () => null }));
vi.mock('../routes/watchlist-page', () => ({ WatchlistPage: () => null, preloadWatchEditControls: async () => undefined }));
vi.mock('../routes/trade-page', () => ({ TradePage: () => null }));
vi.mock('../routes/orders-page', () => ({ OrdersPage: () => null }));
vi.mock('../routes/positions-page', () => ({ PositionsPage: () => null }));
vi.mock('../routes/account-page', () => ({ AccountPage: () => null }));
vi.mock('../hooks/use-risk-pnl-feed', () => ({ useRiskPnlFeed: () => undefined }));
vi.mock('../hooks/use-fill-sound', () => ({ useFillSound: () => undefined }));
vi.mock('../hooks/use-wake-lock', () => ({ useWakeLock: () => undefined }));
vi.mock('../lib/resume-gate-runtime', () => ({ startResumeGate: () => () => undefined }));
vi.mock('../lib/watchlist-context', () => ({
    WatchlistProvider: ({ children }: { children?: unknown }) => {
        m.watchlistMounts++;
        return children;
    },
}));

import { MobileApp } from '../app';

let view: ReactTestRenderer | undefined;
const byTestId = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('MobileApp：說明頁延遲載入失敗', () => {
    it('顯示靜態的「需要 HTTPS」說明；不 bootstrap、不開串流、不讀交易狀態、不掛載殼層', async () => {
        await act(async () => { view = create(createElement(MobileApp, { secure: false })); });
        await vi.waitFor(async () => {
            await act(async () => { await Promise.resolve(); });
            expect(m.gateLoads).toBeGreaterThan(0);
        });
        await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
        expect(byTestId('secure-context-gate-fallback')).toHaveLength(1);
        expect(JSON.stringify(view!.toJSON())).toContain('需要 HTTPS');
        expect(JSON.stringify(view!.toJSON())).toContain('無法下單');
        expect(byTestId('secure-context-gate')).toHaveLength(0);
        expect(byTestId('mock-status-bar')).toHaveLength(0);
        expect(m.bootstrap).not.toHaveBeenCalled();
        expect(m.ensureStream).not.toHaveBeenCalled();
        expect(m.useTradingState).not.toHaveBeenCalled();
        expect(m.watchlistMounts).toBe(0);
    });
});
