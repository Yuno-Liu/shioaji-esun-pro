// 手機版 R1：非 secure context 只顯示「需要 HTTPS」說明，不呼叫 bootstrap()、不開串流、不讀交易狀態
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    bootstrap: vi.fn(),
    initTheme: vi.fn(),
    ensureStream: vi.fn(),
    useTradingState: vi.fn(() => ({ trades: [] })),
    risk: { confirmManualOrders: false },
    setRiskSettings: vi.fn(),
    subscribeRiskSettings: vi.fn(() => () => undefined),
}));
vi.mock('../../lib/boot', () => ({ bootstrap: m.bootstrap }));
vi.mock('../../lib/theme-store', () => ({ initTheme: m.initTheme }));
vi.mock('../../lib/risk', () => ({
    getRiskSettings: () => m.risk,
    setRiskSettings: (next: object) => { m.setRiskSettings(next); Object.assign(m.risk, next); },
    subscribeRiskSettings: m.subscribeRiskSettings,
}));
vi.mock('../../lib/stream', () => ({ ensureStream: m.ensureStream }));
vi.mock('../../lib/trading-state', () => ({ useTradingState: m.useTradingState }));
// 交易殼層的元件各自連到 src/lib：這裡以空元件隔離，只驗證殼層是否被掛載
vi.mock('../components/status-bar', () => ({ StatusBar: () => createElement('div', { 'data-testid': 'mock-status-bar' }) }));
vi.mock('../components/toast-host', () => ({ ToastHost: () => null }));
vi.mock('../components/order-confirm-sheet', () => ({ OrderConfirmSheet: () => null }));
vi.mock('../components/order-ticket-sheet', () => ({ OrderTicketSheet: () => null }));
vi.mock('../components/order-action-sheet', () => ({ OrderActionSheet: () => null }));
// 各分頁與根層 hook 也各自讀 src/lib（串流狀態、持倉、ResumeGate）：一併隔離，殼層測試只看掛載與否
vi.mock('../routes/watchlist-page', () => ({ WatchlistPage: () => null }));
vi.mock('../routes/trade-page', () => ({ TradePage: () => null }));
vi.mock('../routes/orders-page', () => ({ OrdersPage: () => null }));
vi.mock('../routes/positions-page', () => ({ PositionsPage: () => null }));
vi.mock('../routes/account-page', () => ({ AccountPage: () => null }));
vi.mock('../hooks/use-risk-pnl-feed', () => ({ useRiskPnlFeed: () => undefined }));
vi.mock('../lib/resume-gate-runtime', () => ({ startResumeGate: () => () => undefined }));

import { MobileApp } from '../app';
import { isMobileSecure, readSecureContextDiagnostics } from '../lib/secure-context';
import { startMobile } from '../start';
import { SecureContextGate } from './secure-context-gate';

const lanHttp = {
    isSecureContext: false,
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' },
    BroadcastChannel: function BroadcastChannel() { /* stub */ },
    location: { origin: 'http://192.168.1.20:8080' },
};
const https = {
    isSecureContext: true,
    navigator: { locks: { request: () => Promise.resolve() }, userAgent: 'test' },
    BroadcastChannel: function BroadcastChannel() { /* stub */ },
    location: { origin: 'https://trade.example.ts.net' },
};

const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());
let view: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.bootstrap.mockClear();
    m.initTheme.mockClear();
    m.ensureStream.mockClear();
    m.useTradingState.mockClear();
    m.setRiskSettings.mockClear();
    m.risk.confirmManualOrders = false;
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('secure context detection', () => {
    it('LAN HTTP is not a secure context (no Web Locks)', () => {
        const d = readSecureContextDiagnostics(lanHttp);
        expect(d).toMatchObject({ isSecureContext: false, webLocks: false, broadcastChannel: true, origin: 'http://192.168.1.20:8080' });
        expect(isMobileSecure(d)).toBe(false);
    });

    it('HTTPS with Web Locks and BroadcastChannel is secure', () => {
        expect(isMobileSecure(readSecureContextDiagnostics(https))).toBe(true);
    });

    it('HTTPS without BroadcastChannel (old iOS) is still not usable', () => {
        expect(isMobileSecure(readSecureContextDiagnostics({ ...https, BroadcastChannel: undefined }))).toBe(false);
    });
});

describe('startMobile', () => {
    it('does not bootstrap outside a secure context but still forces manual order confirm', () => {
        startMobile(false);
        expect(m.bootstrap).not.toHaveBeenCalled();
        expect(m.initTheme).toHaveBeenCalledOnce();
        expect(m.setRiskSettings).toHaveBeenCalledWith({ confirmManualOrders: true });
    });

    it('bootstraps in a secure context', () => {
        startMobile(true);
        expect(m.bootstrap).toHaveBeenCalledOnce();
    });
});

describe('SecureContextGate', () => {
    it('shows the HTTPS explanation and diagnostics', async () => {
        await act(async () => { view = create(createElement(SecureContextGate, { diagnostics: readSecureContextDiagnostics(lanHttp) })); });
        const out = text(view!);
        expect(out).toContain('需要 HTTPS');
        expect(out).toContain('無法下單');
        expect(out).toContain('isSecureContext');
        expect(out).toContain('http://192.168.1.20:8080');
        expect(out).toContain('iPhone OS 17_5');
    });

    it('MobileApp outside a secure context renders only the gate: no bootstrap, no stream, no trading state', async () => {
        await act(async () => { view = create(createElement(MobileApp, { secure: false, diagnostics: readSecureContextDiagnostics(lanHttp) })); });
        expect(text(view!)).toContain('需要 HTTPS');
        expect(view!.root.findAll(n => n.props['data-testid'] === 'mock-status-bar')).toHaveLength(0);
        expect(view!.root.findAll(n => n.props['data-testid'] === 'mobile-shell')).toHaveLength(0);
        expect(m.bootstrap).not.toHaveBeenCalled();
        expect(m.ensureStream).not.toHaveBeenCalled();
        expect(m.useTradingState).not.toHaveBeenCalled();
    });

    it('MobileApp in a secure context mounts the trading shell and opens the stream', async () => {
        await act(async () => { view = create(createElement(MobileApp, { secure: true })); });
        expect(text(view!)).not.toContain('需要 HTTPS');
        expect(view!.root.findAll(n => n.props['data-testid'] === 'mock-status-bar').length).toBeGreaterThan(0);
        expect(m.ensureStream).toHaveBeenCalled();
    });
});
