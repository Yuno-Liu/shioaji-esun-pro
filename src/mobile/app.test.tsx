// 殼層：延遲載入的分頁／下單面板 chunk 載入失敗時（F2／M-PLAT-1），只在該區塊顯示「載入失敗」與［重試］；
// 狀態列、分頁列、toast、常駐確認面板不可被卸載；重試會重新 import，成功後正常顯示
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    failOrders: true,
    failTicket: true,
    ordersLoads: 0,
    ticketLoads: 0,
    // 狀態列帳戶切換面板、自選頁排行的延遲載入入口（閒置預載應呼叫）
    deferredLoads: [] as string[],
    deferredFail: false,
    /** 產業分頁模組已被 import（app.tsx 直接延遲載入，列入閒置預載；mock factory 在第一次 import 時執行） */
    sectorImported: false,
}));

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
vi.mock('./routes/watchlist-page', () => ({
    WatchlistPage: () => null,
    // 自選編輯鍵的閒置預載走自選頁匯出的 preload（三個 lazy 共用 lib/deferred-modules 的 loadWatchEditControls）
    preloadWatchEditControls: async () => {
        m.deferredLoads.push('watch-edit-controls');
        if (m.deferredFail) throw new TypeError('Failed to fetch dynamically imported module: watch-edit-controls.js');
    },
}));
vi.mock('./routes/trade-page', () => ({ TradePage: () => null }));
vi.mock('./routes/market-page', () => {
    m.sectorImported = true;
    return { MarketPage: () => null };
});
vi.mock('./routes/positions-page', () => ({ PositionsPage: () => null }));
vi.mock('./routes/account-page', () => ({ AccountPage: () => null }));
vi.mock('./hooks/use-risk-pnl-feed', () => ({ useRiskPnlFeed: () => undefined }));
vi.mock('./hooks/use-fill-sound', () => ({ useFillSound: () => undefined }));
vi.mock('./hooks/use-wake-lock', () => ({ useWakeLock: () => undefined }));
vi.mock('./lib/resume-gate-runtime', () => ({ startResumeGate: () => () => undefined }));
vi.mock('./lib/watchlist-context', () => ({ WatchlistProvider: ({ children }: { children?: unknown }) => children }));
vi.mock('./lib/deferred-modules', () => ({
    loadRankingList: async () => {
        m.deferredLoads.push('ranking-list');
        if (m.deferredFail) throw new TypeError('Failed to fetch dynamically imported module: ranking-list.js');
        return {};
    },
    loadWatchSparkline: async () => {
        m.deferredLoads.push('watch-sparkline');
        if (m.deferredFail) throw new TypeError('Failed to fetch dynamically imported module: watch-sparkline.js');
        return {};
    },
    loadSearchSheet: async () => {
        m.deferredLoads.push('search-sheet');
        if (m.deferredFail) throw new TypeError('Failed to fetch dynamically imported module: search-sheet.js');
        return {};
    },
    loadWatchListSheet: async () => {
        m.deferredLoads.push('watch-list-sheet');
        if (m.deferredFail) throw new TypeError('Failed to fetch dynamically imported module: watch-list-sheet.js');
        return {};
    },
}));

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
    m.deferredLoads = [];
    m.deferredFail = false;
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function mount(Shell: typeof MobileShell = MobileShell) {
    await act(async () => { view = create(createElement(Shell)); });
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

/** 閒置預載全部完成所需時間：1.5 秒延遲＋其後每個間隔 100ms（12 個模組）再多留一點 */
const PREFETCH_ALL_MS = 1_500 + 12 * 100 + 200;
const ALL_DEFERRED = ['watch-sparkline', 'search-sheet', 'watch-list-sheet', 'watch-edit-controls', 'ranking-list'];

/**
 * 推進假時鐘；每 100ms（預載間隔）等一次動態 import 完成（分頁與面板的 preload() 是真的 import()，會在真實時間 resolve，
 * 逐一預載要等前一個結束才排下一個）。
 */
async function advance(ms: number) {
    await act(async () => {
        for (let left = ms; left > 0; left -= 100) {
            await vi.advanceTimersByTimeAsync(Math.min(100, left));
            await vi.dynamicImportSettled();
        }
    });
}

describe('MobileShell idle prefetch', () => {
    // retryableLazy 的 resolve／預載狀態是模組層的：每個測試重新載入 app（mock 照常套用），不受前面測試已載入的面板影響
    let Shell: typeof MobileShell;
    let openTicketFresh: typeof openTicket;
    beforeEach(async () => {
        vi.resetModules();
        Shell = (await import('./app')).MobileShell;
        const store = await import('./lib/mobile-store');
        store.resetMobileUiForTest();
        openTicketFresh = store.openTicket;
    });
    it('首屏完成 1.5 秒後逐一預載（稽核 P10）：迷你走勢第一個，之後每 100ms 一個、同一時間只發一個；含搜尋面板、清單名稱面板、自選編輯鍵與排行', async () => {
        m.failOrders = false;
        await mount(Shell);
        const ticket0 = m.ticketLoads;
        expect(m.deferredLoads).toEqual([]);
        await advance(1_499);
        expect(m.deferredLoads).toEqual([]);
        await advance(1);
        // 沒有 requestIdleCallback（測試環境、iOS Safari）：第一個立即執行，其餘尚未發出
        expect(m.deferredLoads).toEqual(['watch-sparkline']);
        expect(m.ticketLoads).toBe(ticket0);
        await advance(100);
        // 第二個是下單面板（preload）
        expect(m.ticketLoads).toBe(ticket0 + 1);
        expect(m.deferredLoads).toEqual(['watch-sparkline']);
        await advance(100);
        expect(m.deferredLoads).toEqual(['watch-sparkline', 'search-sheet']);
        await advance(PREFETCH_ALL_MS);
        expect(m.deferredLoads).toEqual(ALL_DEFERRED);
        expect(m.ticketLoads).toBe(ticket0 + 1);
        expectPersistentChromeMounted();
    });

    it('閒置預載也包含市場分頁模組（不經過 lazy 元件，不顯示錯誤）', async () => {
        m.failOrders = false;
        await mount(Shell);
        await advance(PREFETCH_ALL_MS);
        expect(m.sectorImported).toBe(true);
        expect(byTestId('route-load-error')).toHaveLength(0);
        expectPersistentChromeMounted();
    });

    it('預載失敗只吞掉並繼續下一個：不顯示錯誤、不卸載殼層', async () => {
        m.failOrders = false;
        m.deferredFail = true;
        await mount(Shell);
        await advance(PREFETCH_ALL_MS);
        expect(m.deferredLoads).toEqual(ALL_DEFERRED);
        expect(byTestId('ticket-load-error')).toHaveLength(0);
        expect(byTestId('route-load-error')).toHaveLength(0);
        expectPersistentChromeMounted();
    });

    it.each([
        ['saveData', { saveData: true, effectiveType: '4g' }],
        ['3g', { effectiveType: '3g' }],
        ['2g', { effectiveType: '2g' }],
        ['slow-2g', { effectiveType: 'slow-2g' }],
    ])('省流量／慢速網路（%s）只預載迷你走勢、下單面板與交易頁', async (_label, connection) => {
        vi.stubGlobal('navigator', { connection });
        m.failOrders = false;
        await mount(Shell);
        const ticket0 = m.ticketLoads;
        await advance(PREFETCH_ALL_MS);
        expect(m.deferredLoads).toEqual(['watch-sparkline']);
        expect(m.ticketLoads).toBe(ticket0 + 1);
        expectPersistentChromeMounted();
    });

    it('一般網路（4g）照常預載全部', async () => {
        vi.stubGlobal('navigator', { connection: { saveData: false, effectiveType: '4g' } });
        m.failOrders = false;
        await mount(Shell);
        await advance(PREFETCH_ALL_MS);
        expect(m.deferredLoads).toEqual(ALL_DEFERRED);
    });

    it('卸載殼層後不再排下一個預載', async () => {
        m.failOrders = false;
        await mount(Shell);
        await advance(1_500);
        expect(m.deferredLoads).toEqual(['watch-sparkline']);
        await act(async () => view?.unmount());
        view = undefined;
        await advance(PREFETCH_ALL_MS);
        expect(m.deferredLoads).toEqual(['watch-sparkline']);
    });

    it('下單面板預載成功後（稽核 P3），開啟時直接用已載入的元件、不再經 lazy import', async () => {
        m.failOrders = false;
        m.failTicket = false;
        await mount(Shell);
        await advance(PREFETCH_ALL_MS);
        const loads = m.ticketLoads;
        expect(loads).toBeGreaterThan(0);
        await act(async () => { openTicketFresh({ code: '2330', action: 'Buy' }); });
        expect(byTestId('ticket-sheet')).toHaveLength(1);
        expect(m.ticketLoads).toBe(loads);
    });
});