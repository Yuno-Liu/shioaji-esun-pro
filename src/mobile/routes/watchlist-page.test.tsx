// 自選頁（規格 §6.1、§9.4）：只有可見列呼叫 useQuote；離開畫面卸載；每列重繪以 100 ms 節流；
// 點列開交易頁、長按開操作面板（移除、移動）；清單切換；試撮徽章；自選狀態常駐（切換分頁不重新讀清單）。
// 依參考圖改版：兩行列版面、市場標記、處置徽章、迷你走勢（只為可見列讀 K 線）、快速下單鍵（S1）、清單分頁、底部指數列。
// 底部指數列以 ContractBase 直接訂閱 IX0001／IX0043（lib/quote-ownership），不經 useQuote；
// rowQuoteCalls() 仍排除這兩檔，確保列訂閱的斷言不受指數列影響（指數列另有專門測試）。
// 迷你走勢是延遲載入（lib/deferred-modules.ts）：beforeAll 先讓 lazy 載入完成，之後各測試的可見列同步渲染走勢
// （載入中／失敗的佔位見 watchlist-deferred.test.tsx）。
import { createElement, useState, useSyncExternalStore } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
    const quotes = new Map<string, unknown>();
    const listeners = new Set<() => void>();
    return {
        quotes,
        listeners,
        emit: () => listeners.forEach(l => l()),
        useQuoteCalls: [] as { code: string | null; options: unknown }[],
        navigate: vi.fn(),
        removeSymbol: vi.fn(async () => undefined),
        reorderSymbol: vi.fn(),
        addSymbol: vi.fn(async () => undefined),
        setActiveList: vi.fn(),
        retryLoad: vi.fn(),
        searchProducts: vi.fn(async () => []),
        fetchScanner: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
        wl: {} as Record<string, unknown>,
        /** useWatchlist() 掛載次數（每次掛載＝一次完整讀取清單、合約與快照） */
        watchlistLoads: 0,
        // S1：lib 的送單／改單／刪單函式與確認面板請求（自選頁的任何入口都不得呼叫）
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelOrders: vi.fn(),
        cancelVerifiedOrder: vi.fn(),
        cancelComboOrder: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
        requestOrderConfirm: vi.fn(),
        fetchKbars: vi.fn(),
        fetchSnapshots: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
        /** 合約解析（每次 2 個 GET）：自選頁不應呼叫 */
        resolveContract: vi.fn(),
        apiGet: vi.fn(),
        haptic: vi.fn(() => false),
        /** 指數列以 ContractBase 直接訂閱（lib/quote-ownership），不經 useQuote → ensureContract */
        retainContractQuotes: vi.fn(),
        releasedQuotes: [] as string[],
        ensureStream: vi.fn(),
        /** 字級（theme-store FontScale）：預設「標準」1.15；窄螢幕走勢測試改 1.3 */
        fontScale: 1.15 as number,
    };
});

vi.mock('../../hooks/use-stream', () => ({
    useQuote: (code: string | null, options: unknown) => {
        m.useQuoteCalls.push({ code, options });
        return useSyncExternalStore(
            (l: () => void) => { m.listeners.add(l); return () => { m.listeners.delete(l); }; },
            () => (code ? m.quotes.get(code) : undefined),
        );
    },
}));
vi.mock('../../hooks/use-watchlist', async () => {
    const { useEffect } = await import('react');
    return {
        useWatchlist: () => {
            // 真正的 useWatchlist 在掛載時讀取清單：以掛載次數代表讀取次數
            useEffect(() => { m.watchlistLoads++; }, []);
            return m.wl;
        },
    };
});
vi.mock('../../lib/product-search', () => ({ searchProducts: m.searchProducts }));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));
// 指數列的即時報價：與 useQuote 假實作共用同一份 m.quotes／m.listeners
vi.mock('../../lib/stream', () => ({
    ensureStream: m.ensureStream,
    getQuote: (code: string) => m.quotes.get(code),
    subscribeQuoteStore: (_code: string, l: () => void) => { m.listeners.add(l); return () => { m.listeners.delete(l); }; },
}));
vi.mock('../../lib/quote-ownership', () => ({ retainContractQuotes: m.retainContractQuotes }));
vi.mock('../../lib/shioaji', () => ({
    fetchScanner: m.fetchScanner,
    fetchKbars: m.fetchKbars,
    fetchSnapshots: m.fetchSnapshots,
    resolveContract: m.resolveContract,
    placeStockOrder: m.placeStockOrder,
    placeFuturesOrder: m.placeFuturesOrder,
    placeComboOrder: m.placeComboOrder,
    cancelOrder: m.cancelOrder,
    cancelOrders: m.cancelOrders,
    cancelVerifiedOrder: m.cancelVerifiedOrder,
    cancelComboOrder: m.cancelComboOrder,
    updateOrderPrice: m.updateOrderPrice,
    updateOrderQty: m.updateOrderQty,
}));
vi.mock('../../lib/order-confirm', () => ({ requestOrderConfirm: m.requestOrderConfirm }));
// 處置清單（regulatory_punish）走 lib/api 的 apiGet：記錄所有 GET，確認自選頁沒有其他請求
vi.mock('../../lib/api', () => ({ apiGet: m.apiGet }));
// 字級：只換 useThemeSettings（走勢元件的 themeKey 等仍用實作）
vi.mock('../../lib/theme-store', async importOriginal => ({
    ...await importOriginal<typeof import('../../lib/theme-store')>(),
    useThemeSettings: () => ({ mode: 'dark', convention: 'tw', fontScale: m.fontScale }),
}));
vi.mock('../motion/haptics', () => ({ haptic: m.haptic }));

import { BottomSheet } from '../components/bottom-sheet';
import { resetRankingForTest } from '../components/ranking-list';
import { INDEX_SNAPSHOT_TTL_MS, resetIndexSnapshotsForTest } from '../components/watch-index-strip';
import { WatchSparkline } from '../components/watch-sparkline';
import { getMobileUi, resetMobileUiForTest } from '../lib/mobile-store';
import { PUNISH_PATH, resetPunishedCodesForTest } from '../lib/regulatory-punish';
import { resetWatchPrefsForTest, setWatchSparklineEnabled, WATCH_SPARK_KEY } from '../lib/watch-prefs';
import { resetSparklinesForTest, SPARK_RETRY_MS, sparklineQueueForTest } from '../lib/watch-sparkline-data';
import { WatchlistProvider } from '../lib/watchlist-context';
import { fill } from '../styles/primitives.css';
import * as wlStyles from '../styles/watchlist.css';
import {
    createVisibilityTracker,
    LONG_PRESS_MS,
    marketTag,
    NARROW_WATCH_QUERY,
    nextWatchMetric,
    PUNISH_LABEL,
    resetWatchlistSegmentForTest,
    revealDelta,
    rowQuoteView,
    SIM_LABEL,
    sparkFitsRow,
    WATCH_METRIC_KEY,
    WATCH_REPAINT_MS,
    WatchlistPage,
    WatchQuoteProbe,
} from './watchlist-page';

// ---- 假的 IntersectionObserver：測試手動決定哪些元素可見 ----
type Entry = { target: object; isIntersecting: boolean };
class FakeIO {
    static instances: FakeIO[] = [];
    observed = new Set<object>();
    constructor(public cb: (entries: Entry[]) => void, public opts?: unknown) { FakeIO.instances.push(this); }
    observe(el: object) { this.observed.add(el); }
    unobserve(el: object) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
}
const nodes = new Map<string, object>();
/** 假畫布（沒有 2D context：drawSparkline 只設定點陣尺寸） */
type FakeCanvas = { clientWidth: number; clientHeight: number; width: number; height: number; getContext: () => null };
const canvases: FakeCanvas[] = [];
function nodeMock(el: { type: unknown; props: unknown }) {
    const element = el as { type: unknown; props: Record<string, unknown> };
    if (element.type === 'li' && typeof element.props['data-code'] === 'string') {
        const code = element.props['data-code'] as string;
        const node = nodes.get(code) ?? { code };
        nodes.set(code, node);
        return node;
    }
    if (element.type === 'canvas') {
        const cv: FakeCanvas = { clientWidth: 56, clientHeight: 32, width: 0, height: 0, getContext: () => null };
        canvases.push(cv);
        return cv;
    }
    return {};
}
async function setVisible(code: string, visible: boolean) {
    const io = FakeIO.instances.at(-1)!;
    await act(async () => { io.cb([{ target: nodes.get(code)!, isIntersecting: visible }]); });
}

const contract = (code: string, name: string, reference: number) => ({ code, name, reference, security_type: 'STK', exchange: 'TSE', target_code: null });
const items = [
    { contract: contract('2330', '台積電', 1000) },
    { contract: contract('2317', '鴻海', 200) },
    { contract: contract('2454', '聯發科', 1200) },
];

let view: ReactTestRenderer | undefined;
async function render() {
    await act(async () => { view = create(createElement(WatchlistProvider, null, createElement(WatchlistPage)), { createNodeMock: nodeMock }); });
}
/** 底部指數列的訂閱（不屬於列） */
const INDEX_CODES = new Set(['IX0001', 'IX0043']);
const rowQuoteCalls = () => m.useQuoteCalls.filter(c => !INDEX_CODES.has(c.code ?? ''));
const quoteCodes = () => new Set(rowQuoteCalls().map(c => c.code));
const probes = () => view!.root.findAll(n => n.type === WatchQuoteProbe).map(n => n.props.code as string);
const rowButton = (code: string): ReactTestInstance =>
    view!.root.find(n => n.type === 'li' && n.props['data-code'] === code).find(n => n.props['data-testid'] === 'watch-row-button');
const priceText = (code: string) =>
    view!.root.find(n => n.type === 'li' && n.props['data-code'] === code).find(n => n.props['data-testid'] === 'watch-price').props.children as string;
const tick = (close: string, chg: string, simtrade = false) => ({ tick: { close, price_chg: chg, simtrade }, index: undefined });

/**
 * 延遲載入的元件：等動態 import 結算到條件成立。以時間為上限，不以迴圈次數決定成敗——
 * 2026-11 上游同步後搜尋面板會連帶載入較大的上游搜尋模組，CI 較慢時固定 50 次 setTimeout(0) 等不到。
 */
async function settleUntil(pred: () => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!pred() && Date.now() < deadline) {
        await act(async () => {
            await vi.dynamicImportSettled();
            await new Promise(resolve => setTimeout(resolve, 10));
        });
    }
}

/** 迷你走勢的 lazy 先載入完成（模組層快取）：之後可見列的走勢欄同步渲染，各測試不必等動態 import */
beforeAll(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', undefined); // 沒有 IO：前幾列視為可見
    m.fetchKbars.mockResolvedValue({ datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [], Amount: [] });
    m.apiGet.mockResolvedValue({ code: [] });
    m.wl = { items: items.slice(0, 1), loading: false, structureBusy: false, loadError: false, serverLists: [], activeListId: 'a' };
    await act(async () => { view = create(createElement(WatchlistProvider, null, createElement(WatchlistPage)), { createNodeMock: nodeMock }); });
    await settleUntil(() => view!.root.findAll(n => n.type === WatchSparkline).length > 0);
    expect(view!.root.findAll(n => n.type === WatchSparkline)).toHaveLength(1);
    // 搜尋面板同樣延遲載入：開一次讓 lazy 載入完成
    const searchSheet = () => view!.root.findAll(n => n.type === BottomSheet && n.props.testId === 'search-sheet');
    await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-search' && n.type === 'button').props.onClick(); });
    await settleUntil(() => searchSheet().length > 0);
    expect(searchSheet()).toHaveLength(1);
    await act(async () => view!.unmount());
    view = undefined;
    vi.unstubAllGlobals();
}, 30_000);

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', FakeIO);
    FakeIO.instances = [];
    nodes.clear();
    canvases.length = 0;
    m.retainContractQuotes.mockReset();
    m.releasedQuotes.length = 0;
    m.retainContractQuotes.mockImplementation((c: { code: string }) => () => { m.releasedQuotes.push(c.code); });
    m.resolveContract.mockReset();
    m.ensureStream.mockClear();
    m.quotes.clear();
    m.listeners.clear();
    m.useQuoteCalls.length = 0;
    m.navigate.mockClear();
    m.removeSymbol.mockClear();
    m.reorderSymbol.mockClear();
    m.setActiveList.mockClear();
    m.watchlistLoads = 0;
    m.addSymbol.mockClear();
    m.fetchScanner.mockReset();
    m.fetchScanner.mockResolvedValue([]);
    m.fetchKbars.mockReset();
    m.fetchKbars.mockResolvedValue({ datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [], Amount: [] });
    m.apiGet.mockReset();
    m.apiGet.mockResolvedValue({ code: [] });
    m.fetchSnapshots.mockReset();
    m.fetchSnapshots.mockResolvedValue([]);
    m.fontScale = 1.15;
    resetIndexSnapshotsForTest();
    resetRankingForTest();
    resetWatchlistSegmentForTest();
    resetSparklinesForTest();
    resetWatchPrefsForTest();
    resetPunishedCodesForTest();
    m.wl = {
        items,
        loading: false,
        structureBusy: false,
        loadError: false,
        retryLoad: m.retryLoad,
        addSymbol: m.addSymbol,
        removeSymbol: m.removeSymbol,
        reorderSymbol: m.reorderSymbol,
        serverLists: [{ id: 'a', name: '我的自選', contracts: [] }, { id: 'b', name: '期貨', contracts: [] }],
        activeListId: 'a',
        setActiveList: m.setActiveList,
    };
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('rowQuoteView', () => {
    it('uses tick price change and reference (never pct_chg)', () => {
        const v = rowQuoteView({ reference: 1000 }, undefined, { tick: { close: '1015', price_chg: '15', pct_chg: '150' } as never });
        expect(v).toMatchObject({ close: 1015, chg: 15, dir: 'up' });
        expect(v.pct).toBeCloseTo(1.5);
    });
    it('index quote derives change from its own reference', () => {
        const v = rowQuoteView({ reference: 0 }, undefined, { index: { close: '22000', reference: '22100' } as never });
        expect(v).toMatchObject({ close: 22000, chg: -100, dir: 'down' });
    });
    it('falls back to the snapshot close when no live quote', () => {
        const v = rowQuoteView({ reference: 200 }, { close: 200, change_rate: 0 } as never, undefined);
        expect(v).toMatchObject({ close: 200, chg: 0, dir: 'flat', simtrade: false });
    });
    it('flags a simtrade tick (indicative price, not a real trade)', () => {
        expect(rowQuoteView({ reference: 1000 }, undefined, { tick: { close: '1050', price_chg: '50', simtrade: true } as never }).simtrade).toBe(true);
        expect(rowQuoteView({ reference: 1000 }, undefined, { tick: { close: '1010', price_chg: '10', simtrade: false } as never }).simtrade).toBe(false);
    });
});

describe('createVisibilityTracker', () => {
    it('reports unsupported when IntersectionObserver is missing', () => {
        vi.stubGlobal('IntersectionObserver', undefined);
        expect(createVisibilityTracker().supported).toBe(false);
    });
});

describe('WatchlistPage visible-row subscription', () => {
    it('does not call useQuote for rows that are not visible', async () => {
        await render();
        expect(FakeIO.instances).toHaveLength(1);
        expect(FakeIO.instances[0]!.observed.size).toBe(3);
        expect(rowQuoteCalls()).toHaveLength(0);
        expect(probes()).toEqual([]);
    });

    it('subscribes only the visible rows, with narrow quotes', async () => {
        await render();
        await setVisible('2317', true);
        expect(probes()).toEqual(['2317']);
        expect(quoteCodes()).toEqual(new Set(['2317']));
        expect(m.useQuoteCalls.every(c => (c.options as { narrow?: boolean }).narrow === true)).toBe(true);
        expect(m.useQuoteCalls.length).toBeGreaterThan(0);
    });

    it('unmounts the quote probe when a row leaves the screen (release handled by quote-ownership grace)', async () => {
        await render();
        await setVisible('2330', true);
        await setVisible('2454', true);
        expect(probes().sort()).toEqual(['2330', '2454']);
        await setVisible('2330', false);
        expect(probes()).toEqual(['2454']);
        m.useQuoteCalls.length = 0;
        m.quotes.set('2330', tick('1010', '10'));
        m.quotes.set('2454', tick('1210', '10'));
        await act(async () => { m.emit(); });
        expect(quoteCodes()).toEqual(new Set(['2454']));
    });

    it('throttles row repaint to WATCH_REPAINT_MS', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await render();
        await setVisible('2330', true);
        m.quotes.set('2330', tick('1001', '1'));
        await act(async () => { m.emit(); });
        await act(async () => { vi.advanceTimersByTime(0); });
        expect(priceText('2330')).toBe('1,001');
        // 100 ms 內連續三筆：畫面不變，到期後只顯示最後一筆
        for (const [i, px] of ['1002', '1003', '1004'].entries()) {
            m.quotes.set('2330', tick(px, String(i + 2)));
            await act(async () => { m.emit(); });
            await act(async () => { vi.advanceTimersByTime(10); });
        }
        expect(priceText('2330')).toBe('1,001');
        await act(async () => { vi.advanceTimersByTime(WATCH_REPAINT_MS); });
        expect(priceText('2330')).toBe('1,004');
    });

    it('shows a 試撮 badge for simtrade ticks, and drops it once a real trade arrives', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await render();
        await setVisible('2330', true);
        const row = () => view!.root.find(n => n.type === 'li' && n.props['data-code'] === '2330');
        const badges = () => row().findAll(n => n.props['data-testid'] === 'watch-simtrade' && typeof n.type === 'string');
        m.quotes.set('2330', tick('1050', '50', true));
        await act(async () => { m.emit(); });
        await act(async () => { vi.advanceTimersByTime(WATCH_REPAINT_MS); });
        expect(badges()).toHaveLength(1);
        expect(badges()[0]!.props.children).toBe(SIM_LABEL);
        expect(rowButton('2330').props['aria-label']).toContain(`${SIM_LABEL} 1,050`);
        m.quotes.set('2330', tick('1010', '10'));
        await act(async () => { m.emit(); });
        await act(async () => { vi.advanceTimersByTime(WATCH_REPAINT_MS); });
        expect(badges()).toHaveLength(0);
        expect(rowButton('2330').props['aria-label']).not.toContain(SIM_LABEL);
    });

    it('without IntersectionObserver only the first rows subscribe', async () => {
        vi.stubGlobal('IntersectionObserver', undefined);
        await render();
        expect(probes().sort()).toEqual(['2317', '2330', '2454']);
    });
});

describe('WatchlistPage interactions', () => {
    it('tapping a row opens the trade page', async () => {
        await render();
        await act(async () => { rowButton('2317').props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2317' });
    });

    it('long press opens actions instead of navigating; remove needs a second tap', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await render();
        const btn = rowButton('2330');
        await act(async () => { btn.props.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 10, clientY: 10 }); });
        await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS); });
        await act(async () => { rowButton('2330').props.onPointerUp(); rowButton('2330').props.onClick(); });
        expect(m.navigate).not.toHaveBeenCalled();
        const remove = () => view!.root.find(n => n.props['data-testid'] === 'watch-remove');
        await act(async () => { remove().props.onClick(); });
        expect(m.removeSymbol).not.toHaveBeenCalled();
        await act(async () => { remove().props.onClick(); });
        expect(m.removeSymbol).toHaveBeenCalledWith('2330');
    });

    it('moving the finger cancels the long press', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await render();
        const btn = rowButton('2330');
        await act(async () => { btn.props.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 10, clientY: 10 }); });
        await act(async () => { rowButton('2330').props.onPointerMove({ pointerId: 1, clientX: 10, clientY: 40 }); });
        await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS * 2); });
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-actions')).toHaveLength(0);
    });

    it('actions sheet moves a row down via reorderSymbol', async () => {
        await render();
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-edit').props.onClick(); });
        const more = view!.root.findAll(n => n.props['data-testid'] === 'watch-more');
        await act(async () => { more[0]!.props.onClick(); });
        const down = view!.root.find(n => n.type === 'button' && n.props.children === '下移');
        await act(async () => { down.props.onClick(); });
        expect(m.reorderSymbol).toHaveBeenCalledWith('2330', '2317');
    });

    it('switching lists calls setActiveList（清單分頁：tablist 語意，點選中的不重複切換）', async () => {
        await render();
        const tabs = view!.root.find(n => n.props['data-testid'] === 'watch-list-tabs' && typeof n.type === 'string');
        expect(tabs.props.role).toBe('tablist');
        const tab = (id: string) => view!.root.find(n => n.props['data-testid'] === `watch-list-tab-${id}` && n.type === 'button');
        expect(tab('a').props.role).toBe('tab');
        expect(tab('a').props['aria-selected']).toBe(true);
        expect(tab('b').props.children).toBe('期貨');
        await act(async () => { tab('a').props.onClick(); });
        expect(m.setActiveList).not.toHaveBeenCalled();
        await act(async () => { tab('b').props.onClick(); });
        expect(m.setActiveList).toHaveBeenCalledWith('b');
    });
});

describe('WatchlistPage 常駐自選狀態（B4）', () => {
    it('switching tabs away and back does not reload the watchlist; quotes are released while away', async () => {
        let setShown!: (v: boolean) => void;
        function Shell() {
            const [shown, set] = useState(true);
            setShown = set;
            return createElement(WatchlistProvider, null, shown ? createElement(WatchlistPage) : null);
        }
        await act(async () => { view = create(createElement(Shell), { createNodeMock: nodeMock }); });
        expect(m.watchlistLoads).toBe(1);
        await setVisible('2330', true);
        expect(probes()).toEqual(['2330']);
        // 切到別的分頁：頁面卸載，可見列的行情訂閱一起釋放
        await act(async () => { setShown(false); });
        expect(probes()).toEqual([]);
        expect(view!.root.findAll(n => n.props['data-testid'] === 'page-watchlist')).toHaveLength(0);
        // 切回「自選」：清單立即顯示，不重新讀取
        await act(async () => { setShown(true); });
        expect(m.watchlistLoads).toBe(1);
        expect(view!.root.findAll(n => n.type === 'li' && typeof n.props['data-code'] === 'string')).toHaveLength(3);
        expect(view!.root.findAll(n => n.props.role === 'status')).toHaveLength(0);
    });

    it('WatchlistPage outside the provider fails loudly instead of loading its own copy', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await expect(act(async () => { view = create(createElement(WatchlistPage), { createNodeMock: nodeMock }); })).rejects.toThrow(/WatchlistProvider/);
        expect(m.watchlistLoads).toBe(0);
        spy.mockRestore();
        view = undefined;
    });
});

describe('WatchlistPage 自選｜排行分段', () => {
    const scannerItem = (code: string, close: number, change: number) => ({
        code, name: `名稱${code}`, close, change_price: change, high: close, low: close, total_volume: 100, total_amount: 1,
    });
    const segmentButton = (key: string) => view!.root.find(n => n.props['data-testid'] === `watch-segment-${key}` && n.type === 'button');
    const findAll = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');

    it('預設在「自選」分段：不讀取排行', async () => {
        await render();
        expect(segmentButton('watchlist').props['aria-selected']).toBe(true);
        expect(m.fetchScanner).not.toHaveBeenCalled();
        expect(findAll('ranking')).toHaveLength(0);
    });

    it('切到「排行」才讀取；自選列卸載（行情訂閱釋放）、編輯鍵與清單切換隱藏', async () => {
        m.fetchScanner.mockResolvedValue([scannerItem('3008', 2500, 100)]);
        await render();
        await setVisible('2330', true);
        expect(probes()).toEqual(['2330']);
        await act(async () => { segmentButton('ranking').props.onClick(); });
        await act(async () => { await Promise.resolve(); });
        expect(m.fetchScanner).toHaveBeenCalledTimes(1);
        expect(findAll('ranking-row')).toHaveLength(1);
        expect(probes()).toEqual([]);
        expect(findAll('watch-list')).toHaveLength(0);
        expect(findAll('watch-edit')).toHaveLength(0);
        expect(findAll('watch-list-tabs')).toHaveLength(0);
    });

    it('排行點一列開交易頁；「＋」以 STK 加入目前自選清單；已在自選的列停用', async () => {
        m.fetchScanner.mockResolvedValue([scannerItem('3008', 2500, 100), scannerItem('2330', 1100, 10)]);
        await render();
        await act(async () => { segmentButton('ranking').props.onClick(); });
        await act(async () => { await Promise.resolve(); });
        const rows = findAll('ranking-row-button');
        await act(async () => { rows[0]!.props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '3008' });
        const adds = findAll('ranking-add');
        expect(adds[1]!.props.disabled).toBe(true); // 2330 已在自選
        await act(async () => { adds[0]!.props.onClick(); });
        expect(m.addSymbol).toHaveBeenCalledWith('3008', 'STK');
    });

    it('分段選擇在切換分頁後保留', async () => {
        await render();
        await act(async () => { segmentButton('ranking').props.onClick(); });
        await act(async () => view!.unmount());
        await render();
        expect(segmentButton('ranking').props['aria-selected']).toBe(true);
        // 30 秒快取：重新掛載不再讀取
        expect(m.fetchScanner).toHaveBeenCalledTimes(1);
    });
});

// ---- B3c 自選現代化（設計規格 §7.2、§10 S1）----

const ORDER_FNS = [
    'placeStockOrder', 'placeFuturesOrder', 'placeComboOrder', 'cancelOrder', 'cancelOrders',
    'cancelVerifiedOrder', 'cancelComboOrder', 'updateOrderPrice', 'updateOrderQty', 'requestOrderConfirm',
] as const;

/** 以 Map 模擬 localStorage（測試環境沒有） */
function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
        map,
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => { map.set(k, String(v)); },
        removeItem: (k: string) => { map.delete(k); },
    };
}

describe('WatchlistPage 操作面板「買進…／賣出…」（S1：只開下單面板）', () => {
    beforeEach(() => {
        resetMobileUiForTest();
        m.haptic.mockClear();
        for (const k of ORDER_FNS) m[k].mockClear();
        m.fetchKbars.mockClear();
    });

    const longPress = async (code: string) => {
        await act(async () => { rowButton(code).props.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 10, clientY: 10 }); });
        await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS); });
        await act(async () => { rowButton(code).props.onPointerUp(); rowButton(code).props.onClick(); });
    };
    const btnByText = (text: string) => view!.root.findAll(n => n.type === 'button' && n.props.children === text);
    const actionsOpen = () => view!.root.find(n => n.type === BottomSheet && n.props.testId === 'watch-actions').props.open as boolean;

    for (const [label, action] of [['買進…', 'Buy'], ['賣出…', 'Sell']] as const) {
        it(`長按 → ${label}：只呼叫 openTicket（帶方向、source other），lib 送出／改刪單函式 0 次，操作面板關閉`, async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            await render();
            await longPress('2317');
            expect(m.haptic).toHaveBeenCalledWith('longPress');
            expect(actionsOpen()).toBe(true);
            expect(btnByText(label)).toHaveLength(1);
            await act(async () => { btnByText(label)[0]!.props.onClick(); });

            const ticket = getMobileUi().ticket;
            expect(ticket).toMatchObject({ code: '2317', action, price: null, source: 'other' });
            expect(getMobileUi().orderAction).toBeNull();
            for (const k of ORDER_FNS) expect(m[k], k).not.toHaveBeenCalled();
            expect(m.navigate).not.toHaveBeenCalled();
            expect(actionsOpen()).toBe(false);
        });
    }

    it('買賣入口一律有文字，方向小膠囊用 up／down 實心填色（fill.<tone>.strong）', async () => {
        await render();
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-edit').props.onClick(); });
        await act(async () => { view!.root.findAll(n => n.props['data-testid'] === 'watch-more')[0]!.props.onClick(); });
        const row = (id: string) => view!.root.find(n => n.props['data-testid'] === id && typeof n.type === 'string');
        const badge = (id: string) => row(id).find(n => n.type === 'span' && typeof n.props.className === 'string' && n.props.className.includes(wlStyles.sideBadge));
        expect(badge('watch-action-buy').props.children).toBe('買');
        expect(badge('watch-action-buy').props.className).toContain(fill.up.strong);
        expect(badge('watch-action-sell').props.children).toBe('賣');
        expect(badge('watch-action-sell').props.className).toContain(fill.down.strong);
        for (const k of ORDER_FNS) expect(m[k], k).not.toHaveBeenCalled();
    });

    it('指數不能下單：操作面板不提供「買進…／賣出…」', async () => {
        m.wl = { ...m.wl, items: [{ contract: { ...contract('TSE001', '加權指數', 0), security_type: 'IND' } }] };
        await render();
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-edit').props.onClick(); });
        await act(async () => { view!.root.findAll(n => n.props['data-testid'] === 'watch-more')[0]!.props.onClick(); });
        expect(btnByText('開啟交易頁')).toHaveLength(1);
        expect(btnByText('買進…')).toHaveLength(0);
        expect(btnByText('賣出…')).toHaveLength(0);
    });

    it('開啟交易頁只導頁，不開下單面板', async () => {
        await render();
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-edit').props.onClick(); });
        await act(async () => { view!.root.findAll(n => n.props['data-testid'] === 'watch-more')[1]!.props.onClick(); });
        await act(async () => { btnByText('開啟交易頁')[0]!.props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2317' });
        expect(getMobileUi().ticket).toBeNull();
    });

    it('進入自選頁的請求如實計算：處置清單 GET 1、指數快照 POST 1、合約解析 0、Quote 訂閱＝指數 2 檔＋可見列；走勢關閉時 K 線 0；送單函式 0', async () => {
        setWatchSparklineEnabled(false);
        await render();
        await setVisible('2330', true);
        m.quotes.set('2330', tick('1010', '10'));
        await act(async () => { m.emit(); });
        await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
        // GET：只有處置清單（清單含股票；30 分鐘最多 1 次）
        expect(m.apiGet.mock.calls.map(c => c[0])).toEqual(['/api/v1/data/regulatory_punish']);
        // 指數快照：1 次 POST（兩檔一起；10 分鐘最多 1 次）
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(1);
        expect(((m.fetchSnapshots.mock.calls[0] as unknown[])[0] as { code: string }[]).map(c => c.code)).toEqual(['IX0001', 'IX0043']);
        // 合約解析：0（指數以 ContractBase 直接訂閱；列的合約已由 useWatchlist 放進合約快取，useQuote 的 ensureContract 命中快取）
        expect(m.resolveContract).not.toHaveBeenCalled();
        expect(m.useQuoteCalls.filter(c => INDEX_CODES.has(c.code ?? ''))).toHaveLength(0);
        // Quote 訂閱：指數 2 檔（IND 只訂 Quote）；列只有可見的 2330（Tick＋BidAsk，由 useQuote → quote-ownership）
        expect(m.retainContractQuotes.mock.calls.map(c => (c[0] as { code: string }).code)).toEqual(['IX0001', 'IX0043']);
        expect(quoteCodes()).toEqual(new Set(['2330']));
        // 迷你走勢關閉：不掛載走勢欄、不讀 K 線
        expect(m.fetchKbars).not.toHaveBeenCalled();
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-spark')).toHaveLength(0);
        // 排行未開：不讀
        expect(m.fetchScanner).not.toHaveBeenCalled();
        for (const k of ORDER_FNS) expect(m[k], k).not.toHaveBeenCalled();
    });
});

describe('WatchlistPage 表頭指標切換鍵（watch-metric-toggle）', () => {
    const toggle = () => view!.root.find(n => n.props['data-testid'] === 'watch-metric-toggle' && n.type === 'button');
    const change = (code: string) =>
        view!.root.find(n => n.type === 'li' && n.props['data-code'] === code).find(n => n.props['data-testid'] === 'watch-change');

    it('在表頭、不在列按鈕內；「漲跌 漲跌幅」↔ 總量 切換並存 localStorage；列 aria-label 永遠含全部資訊', async () => {
        const storage = fakeStorage();
        vi.stubGlobal('localStorage', storage);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        m.wl = { ...m.wl, items: [{ contract: contract('2330', '台積電', 1000), snapshot: { close: 1000, total_volume: 45678, change_rate: 0 } }, ...items.slice(1)] };
        await render();
        // 不巢狀：列按鈕內沒有切換鍵
        expect(rowButton('2330').findAll(n => n.props['data-testid'] === 'watch-metric-toggle')).toHaveLength(0);
        expect(view!.root.find(n => n.props['data-testid'] === 'watch-list-header').findAll(n => n.props['data-testid'] === 'watch-metric-toggle' && n.type === 'button')).toHaveLength(1);

        await setVisible('2330', true);
        m.quotes.set('2330', { tick: { close: '1014', price_chg: '14', total_volume: 45678 }, index: undefined });
        await act(async () => { m.emit(); });
        await act(async () => { vi.advanceTimersByTime(WATCH_REPAINT_MS); });

        expect(toggle().props['data-metric']).toBe('pct');
        expect(toggle().props.children[0]).toBe('漲跌幅');
        expect(change('2330').props.children).toBe('+14.00 +1.40%');
        await act(async () => { toggle().props.onClick(); });
        expect(toggle().props['data-metric']).toBe('vol');
        expect(toggle().props.children[0]).toBe('總量');
        expect(change('2330').props.children).toBe('4.6萬');
        expect(storage.map.get(WATCH_METRIC_KEY)).toBe('vol');
        // 總量沒有方向：不著漲跌色
        expect(change('2330').props.className).toContain(wlStyles.tone.flat);
        expect(change('2330').props.className).not.toContain(wlStyles.tone.up);
        const label = rowButton('2330').props['aria-label'] as string;
        expect(label).toContain('1,014');
        expect(label).toContain('漲 ▲14.00 +1.40%');
        expect(label).toContain('總量 4.6萬');
        await act(async () => { toggle().props.onClick(); });
        expect(toggle().props['data-metric']).toBe('pct');
        expect(storage.map.get(WATCH_METRIC_KEY)).toBe('pct');
    });

    it('第二行是依漲跌著色的純文字（帶正負號；不用實心膠囊）', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await render();
        for (const code of ['2330', '2317', '2454']) await setVisible(code, true);
        m.quotes.set('2330', tick('1010', '10'));
        m.quotes.set('2317', tick('190', '-10'));
        m.quotes.set('2454', tick('1200', '0'));
        await act(async () => { m.emit(); });
        await act(async () => { vi.advanceTimersByTime(WATCH_REPAINT_MS); });
        expect(change('2330').props.children).toBe('+10.00 +1.00%');
        expect(change('2330').props.className).toContain(wlStyles.tone.up);
        expect(change('2330').props.className).not.toContain(fill.up.strong);
        expect(change('2317').props.children).toBe('-10.00 -5.00%');
        expect(change('2317').props.className).toContain(wlStyles.tone.down);
        expect(change('2317').props.className).not.toContain(fill.down.strong);
        expect(change('2454').props.className).toContain(wlStyles.tone.flat);
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-pill')).toHaveLength(0);
    });

    it('讀回儲存的指標；舊版 chg 併入漲跌幅；無效值或 localStorage 失敗時退回漲跌幅', async () => {
        vi.stubGlobal('localStorage', fakeStorage({ [WATCH_METRIC_KEY]: 'vol' }));
        await render();
        expect(toggle().props['data-metric']).toBe('vol');
        await act(async () => view!.unmount());
        vi.stubGlobal('localStorage', fakeStorage({ [WATCH_METRIC_KEY]: 'chg' }));
        await render();
        expect(toggle().props['data-metric']).toBe('pct');
        await act(async () => view!.unmount());
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
        await render();
        expect(toggle().props['data-metric']).toBe('pct');
        await act(async () => { toggle().props.onClick(); });
        expect(toggle().props['data-metric']).toBe('vol');
        expect(nextWatchMetric('vol')).toBe('pct');
        expect(nextWatchMetric('pct')).toBe('vol');
    });
});

// ---- 依參考圖改版：列版面、市場標記、處置、迷你走勢、快速下單、清單分頁、指數列、表頭編輯鍵 ----

const textOf = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const rowItem = (code: string) => view!.root.find(n => n.type === 'li' && n.props['data-code'] === code);
const inRow = (code: string, id: string) => rowItem(code).findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');

describe('marketTag／revealDelta', () => {
    it('上市→市、上櫃→櫃、興櫃→興、期貨→期、選擇權→權、指數→指；無法判斷時 null', () => {
        expect(marketTag({ security_type: 'STK', exchange: 'TSE' })).toBe('市');
        expect(marketTag({ security_type: 'STK', exchange: 'OTC' })).toBe('櫃');
        expect(marketTag({ security_type: 'STK', exchange: 'OES' })).toBe('興');
        expect(marketTag({ security_type: 'WRT', exchange: 'TSE' })).toBe('市');
        expect(marketTag({ security_type: 'FUT', exchange: 'TAIFEX' })).toBe('期');
        expect(marketTag({ security_type: 'OPT', exchange: 'TAIFEX' })).toBe('權');
        expect(marketTag({ security_type: 'IND', exchange: 'TSE' })).toBe('指');
        expect(marketTag({ security_type: null, exchange: null })).toBeNull();
    });

    it('清單分頁自動捲動：只在超出左右邊界時位移（含 8px 留白）', () => {
        const box = { left: 0, right: 300 };
        expect(revealDelta(box, { left: 20, right: 80 })).toBe(0);
        expect(revealDelta(box, { left: 280, right: 360 })).toBe(68);
        expect(revealDelta(box, { left: -50, right: 10 })).toBe(-58);
    });
});

describe('WatchlistPage 列版面（參考圖：兩行＋市場標記）', () => {
    it('第一行名稱、第二行代碼＋市場標記；價格與「漲跌 漲跌幅」；aria-label 含名稱、代碼、市場、價格、漲跌、漲跌幅、總量', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        m.wl = { ...m.wl, items: [{ contract: { ...contract('6274', '台燿', 900), exchange: 'OTC' } }, ...items] };
        await render();
        expect(textOf(inRow('6274', 'watch-name')[0]!)).toBe('台燿');
        expect(textOf(inRow('6274', 'watch-code')[0]!)).toBe('6274');
        expect(textOf(inRow('6274', 'watch-market')[0]!)).toBe('櫃');
        expect(textOf(inRow('2330', 'watch-market')[0]!)).toBe('市');
        await setVisible('6274', true);
        m.quotes.set('6274', { tick: { close: '810', price_chg: '-90', total_volume: 12345 }, index: undefined });
        await act(async () => { m.emit(); });
        await act(async () => { vi.advanceTimersByTime(WATCH_REPAINT_MS); });
        expect(priceText('6274')).toBe('810');
        expect(textOf(inRow('6274', 'watch-change')[0]!)).toBe('-90.00 -10.00%');
        const label = rowButton('6274').props['aria-label'] as string;
        expect(label).toBe('6274 台燿 上櫃，810，跌 ▼90.00 -10.00%，總量 1.2萬');
    });

    it('代碼與市場標記同在不縮的一組（rowMetaKey），處置徽章在組外（放不下時只有徽章換行）', async () => {
        m.apiGet.mockResolvedValue({ code: ['6488'] });
        m.wl = { ...m.wl, items: [{ contract: { ...contract('6488', '環球晶', 500), exchange: 'OTC' } }, ...items] };
        await render();
        await act(async () => { await Promise.resolve(); });
        const codeNode = inRow('6488', 'watch-code')[0]!;
        const key = codeNode.parent!;
        expect(key.props.className).toBe(wlStyles.rowMetaKey);
        expect(codeNode.props.className).toBe(wlStyles.rowMetaCode);
        expect(inRow('6488', 'watch-market')[0]!.parent).toBe(key);
        const punish = inRow('6488', 'watch-punish')[0]!;
        expect(punish.parent).toBe(key.parent);
        expect(key.parent!.props.className).toBe(wlStyles.rowMeta);
        expect(textOf(codeNode)).toBe('6488');
    });
});

describe('WatchlistPage 處置徽章（regulatory_punish）', () => {
    it('處置股在第二行顯示「處置」徽章並寫入 aria-label；30 分鐘內重新進入不再讀取', async () => {
        m.apiGet.mockResolvedValue({ code: ['2317'] });
        await render();
        await act(async () => { await Promise.resolve(); });
        expect(m.apiGet).toHaveBeenCalledTimes(1);
        expect(m.apiGet).toHaveBeenCalledWith(PUNISH_PATH);
        expect(inRow('2317', 'watch-punish').map(textOf)).toEqual([PUNISH_LABEL]);
        expect(inRow('2330', 'watch-punish')).toHaveLength(0);
        expect(rowButton('2317').props['aria-label']).toContain('處置股');
        await act(async () => view!.unmount());
        await render();
        expect(m.apiGet).toHaveBeenCalledTimes(1);
        expect(inRow('2317', 'watch-punish')).toHaveLength(1);
    });

    it('讀取失敗靜默：沒有徽章、沒有錯誤訊息', async () => {
        m.apiGet.mockRejectedValue(new Error('500 Internal Server Error'));
        await render();
        await act(async () => { await Promise.resolve(); });
        expect(m.apiGet).toHaveBeenCalledTimes(1);
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-punish')).toHaveLength(0);
        expect(view!.root.findAll(n => n.props.role === 'alert')).toHaveLength(0);
    });

    it('清單沒有股票（期貨、指數）或在「排行」分段時不讀取', async () => {
        m.wl = { ...m.wl, items: [{ contract: { ...contract('TXFR1', '台指近', 22000), security_type: 'FUT', exchange: 'TAIFEX' } }] };
        await render();
        expect(m.apiGet).not.toHaveBeenCalled();
        await act(async () => view!.unmount());
        m.wl = { ...m.wl, items };
        await render();
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-segment-ranking' && n.type === 'button').props.onClick(); });
        resetPunishedCodesForTest();
        m.apiGet.mockClear();
        await act(async () => view!.unmount());
        await render();
        expect(m.apiGet).not.toHaveBeenCalled();
    });
});

describe('WatchlistPage 迷你走勢（只為可見列讀取目前時段的 1 分 K）', () => {
    // 交易時段依時間判斷：固定在週三 10:00（台北）盤中
    const DAY = '2026-11-04';
    const NOW = new Date(`${DAY}T10:00:00+08:00`).getTime();
    const useClock = (toFake: ('Date' | 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval')[] = ['Date']) => {
        vi.useFakeTimers({ toFake });
        vi.setSystemTime(NOW);
    };
    beforeEach(() => useClock());
    const kbars = (closes: number[]) => ({
        datetime: closes.map((_, i) => `${DAY} 09:${String(i + 1).padStart(2, '0')}:00`),
        Open: closes, High: closes, Low: closes, Close: closes, Volume: closes.map(() => 1), Amount: closes.map(() => 1),
    });
    const sparkOf = (code: string) => rowItem(code).findAll(n => n.type === WatchSparkline)[0];
    const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

    it('不可見的列不讀；可見才讀一次，帶當日範圍；結果寫入快取，重新進入頁面不再讀', async () => {
        m.fetchKbars.mockResolvedValue(kbars([1000, 1004, 1002]));
        await render();
        await flush();
        expect(m.fetchKbars).not.toHaveBeenCalled();
        await setVisible('2330', true);
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
        expect((m.fetchKbars.mock.calls[0] as unknown[])[0]).toMatchObject({ code: '2330' });
        expect((m.fetchKbars.mock.calls[0] as unknown[]).slice(1, 3)).toEqual([DAY, DAY]);
        expect(sparkOf('2330')!.props.points).toEqual([1000, 1004, 1002]);
        expect(sparkOf('2330')!.props.reference).toBe(1000);
        // 離開再回來：同一交易日不再讀
        await setVisible('2330', false);
        await act(async () => view!.unmount());
        await render();
        await setVisible('2330', true);
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
        expect(sparkOf('2330')!.props.points).toEqual([1000, 1004, 1002]);
    });

    it('即時成交以分鐘為桶接在尾段（同一分鐘取代、新分鐘 append；試撮不算），不重新讀 K 線', async () => {
        useClock(['setTimeout', 'clearTimeout', 'Date']);
        m.fetchKbars.mockResolvedValue(kbars([1000, 1004]));
        await render();
        await setVisible('2330', true);
        await flush();
        expect(sparkOf('2330')!.props.points).toEqual([1000, 1004]);
        const live = async (close: string, time: string, simtrade = false) => {
            m.quotes.set('2330', { tick: { close, price_chg: '0', simtrade, date: DAY, time }, index: undefined });
            await act(async () => { m.emit(); });
            await act(async () => { vi.advanceTimersByTime(WATCH_REPAINT_MS); });
        };
        await live('1010', '09:59:10');
        expect(sparkOf('2330')!.props.points).toEqual([1000, 1004, 1010]);
        await live('1011', '09:59:40');
        expect(sparkOf('2330')!.props.points).toEqual([1000, 1004, 1011]);
        await live('1012', '10:00:05');
        expect(sparkOf('2330')!.props.points).toEqual([1000, 1004, 1011, 1012]);
        await live('1300', '10:00:30', true);
        expect(sparkOf('2330')!.props.points).toEqual([1000, 1004, 1011, 1012]);
        expect(sparkOf('2330')!.props.last).toBeUndefined();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
    });

    it('時段鍵隨時鐘前進：列一直可見時，開盤後換到新時段並重新讀取', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
        vi.setSystemTime(new Date(`${DAY}T08:58:00+08:00`));
        // 盤前：顯示前一交易日
        m.fetchKbars.mockResolvedValueOnce({ ...kbars([990, 995]), datetime: ['2026-11-03 09:01:00', '2026-11-03 13:30:00'] });
        await render();
        await setVisible('2330', true);
        await flush();
        expect((m.fetchKbars.mock.calls[0] as unknown[]).slice(1, 3)).toEqual(['2026-11-03', '2026-11-03']);
        expect(sparkOf('2330')!.props.points).toEqual([990, 995]);
        // 09:02：時鐘通知 → 新鍵 → 重新 retain、讀當日
        m.fetchKbars.mockResolvedValueOnce(kbars([1000, 1001]));
        await act(async () => { vi.advanceTimersByTime(4 * 60_000); });
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
        expect((m.fetchKbars.mock.calls[1] as unknown[]).slice(1, 3)).toEqual([DAY, DAY]);
        expect(sparkOf('2330')!.props.points).toEqual([1000, 1001]);
    });

    it('佇列同時最多 2 個；不可見或離開頁面時取消尚未開始的請求', async () => {
        const pending: ((v: unknown) => void)[] = [];
        m.fetchKbars.mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
        await render();
        for (const code of ['2330', '2317', '2454']) await setVisible(code, true);
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
        expect(sparklineQueueForTest()).toEqual({ queued: 1, inflight: 2 });
        // 第三列離開畫面：未開始的請求移出佇列
        await setVisible('2454', false);
        expect(sparklineQueueForTest()).toEqual({ queued: 0, inflight: 2 });
        // 再次可見 → 重新排隊；離開頁面（列全部卸載）→ 取消
        await setVisible('2454', true);
        expect(sparklineQueueForTest()).toEqual({ queued: 1, inflight: 2 });
        await act(async () => view!.unmount());
        view = undefined;
        expect(sparklineQueueForTest()).toEqual({ queued: 0, inflight: 2 });
        // 進行中的請求完成後照樣寫入快取，但不會再啟動已取消的請求
        await act(async () => { pending[0]!(kbars([1, 2])); pending[1]!(kbars([1, 2])); });
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
        expect(m.fetchKbars.mock.calls.map(c => (c[0] as { code: string }).code)).toEqual(['2330', '2317']);
        expect(sparklineQueueForTest()).toEqual({ queued: 0, inflight: 0 });
    });

    it('失敗或當日沒有資料：不顯示錯誤字樣，較長間隔後才重試', async () => {
        m.fetchKbars.mockRejectedValue(new Error('500'));
        await render();
        await setVisible('2330', true);
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
        expect(sparkOf('2330')!.props.points).toBeNull();
        expect(view!.root.findAll(n => n.props.role === 'alert')).toHaveLength(0);
        await setVisible('2330', false);
        await setVisible('2330', true);
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + SPARK_RETRY_MS + 1);
        await setVisible('2330', false);
        await setVisible('2330', true);
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
    });

    it('指數、組合商品顯示空白佔位、不讀 K 線', async () => {
        m.wl = {
            ...m.wl,
            items: [
                { contract: { ...contract('IX0001', '加權指數', 0), security_type: 'IND' } },
                { contract: { ...contract('TXFI6/J6', '台指價差', 0), security_type: 'FUT', exchange: 'TAIFEX', combo: { code: 'TXFI6/J6', legs: [], combo_type: 'spread' } } },
            ],
        };
        await render();
        await setVisible('IX0001', true);
        await setVisible('TXFI6/J6', true);
        await flush();
        expect(m.fetchKbars).not.toHaveBeenCalled();
        expect(inRow('IX0001', 'watch-spark-blank')).toHaveLength(1);
        expect(inRow('TXFI6/J6', 'watch-spark-blank')).toHaveLength(1);
        expect(rowItem('IX0001').findAll(n => n.type === WatchSparkline)).toHaveLength(0);
    });

    it('只有可見列建立 canvas 與點陣、排 rAF；不可見列是同尺寸空白佔位；離開畫面時畫布尺寸歸 0、取消未執行的 rAF', async () => {
        const frames = new Map<number, () => void>();
        let rafCalls = 0;
        let nextId = 0;
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { rafCalls++; frames.set(++nextId, cb); return nextId; });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
        m.fetchKbars.mockResolvedValue(kbars([1000, 1004, 1002]));
        const runFrames = () => { const due = [...frames.values()]; frames.clear(); due.forEach(f => f()); };
        const mounted = () => view!.root.findAll(n => n.type === 'canvas');
        const blank = (code: string) => inRow(code, 'watch-spark-blank')[0];

        await render();
        await flush();
        // 全部不可見：沒有 canvas、沒有 rAF；佔位與走勢同一個尺寸 class
        expect(mounted()).toHaveLength(0);
        expect(canvases).toHaveLength(0);
        expect(rafCalls).toBe(0);
        for (const code of ['2330', '2317', '2454']) {
            expect(blank(code)!.props['data-spark']).toBe('hidden');
            expect(blank(code)!.props.className).toBe(wlStyles.spark);
            expect(blank(code)!.props['aria-hidden']).toBe('true');
        }

        // 一列可見：只有這列有 canvas、點陣與 rAF
        await setVisible('2330', true);
        await flush();
        expect(mounted()).toHaveLength(1);
        expect(inRow('2330', 'watch-spark')).toHaveLength(1);
        expect(inRow('2330', 'watch-spark')[0]!.props.className).toBe(wlStyles.spark);
        expect(blank('2317')!.props['data-spark']).toBe('hidden');
        expect(canvases).toHaveLength(1);
        expect(rafCalls).toBeGreaterThan(0);
        runFrames();
        expect(canvases[0]).toMatchObject({ width: 56, height: 32 });

        // 不可見列的行情變動不排 rAF
        const before = rafCalls;
        m.quotes.set('2317', tick('201', '1'));
        await act(async () => { m.emit(); });
        await flush();
        expect(rafCalls).toBe(before);

        // 離開畫面：卸載 canvas、點陣歸 0、未執行的 rAF 取消，之後不再排 rAF
        m.quotes.set('2330', { tick: { close: '1003', price_chg: '3', date: DAY, time: '09:59:30' }, index: undefined });
        await act(async () => { m.emit(); });
        await setVisible('2330', false);
        await flush();
        expect(mounted()).toHaveLength(0);
        expect(blank('2330')!.props['data-spark']).toBe('hidden');
        expect(canvases[0]).toMatchObject({ width: 0, height: 0 });
        expect(frames.size).toBe(0);
        const after = rafCalls;
        m.quotes.set('2330', tick('1005', '5'));
        await act(async () => { m.emit(); });
        await flush();
        expect(rafCalls).toBe(after);
        expect(canvases).toHaveLength(1);
    });

    it('設定關閉：不掛載走勢欄；開關存 localStorage', async () => {
        const storage = fakeStorage();
        vi.stubGlobal('localStorage', storage);
        setWatchSparklineEnabled(false);
        expect(storage.map.get(WATCH_SPARK_KEY)).toBe('0');
        await render();
        await setVisible('2330', true);
        await flush();
        expect(view!.root.findAll(n => n.type === WatchSparkline)).toHaveLength(0);
        expect(m.fetchKbars).not.toHaveBeenCalled();
        // 開啟後：可見列才讀
        await act(async () => { setWatchSparklineEnabled(true); });
        await flush();
        expect(storage.map.get(WATCH_SPARK_KEY)).toBe('1');
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
    });

    describe('窄螢幕＋字級「大」不顯示走勢（代碼不截斷）', () => {
        /** 假 matchMedia：只有 NARROW_WATCH_QUERY 依 narrow 回應；set() 觸發 change */
        function fakeMatchMedia(initial: boolean) {
            const state = { narrow: initial, listeners: new Set<() => void>() };
            vi.stubGlobal('matchMedia', (q: string) => ({
                get matches() { return q === NARROW_WATCH_QUERY && state.narrow; },
                addEventListener: (_type: 'change', cb: () => void) => { state.listeners.add(cb); },
                removeEventListener: (_type: 'change', cb: () => void) => { state.listeners.delete(cb); },
            }));
            return {
                listeners: state.listeners,
                set: (narrow: boolean) => act(async () => { state.narrow = narrow; state.listeners.forEach(l => l()); }),
            };
        }
        const classesOf = (code: string) => (rowButton(code).props.className as string).split(/\s+/);

        it('sparkFitsRow：只有窄螢幕且字級 1.3 時放不下', () => {
            expect(sparkFitsRow(1.3, true)).toBe(false);
            expect(sparkFitsRow(1.3, false)).toBe(true);
            expect(sparkFitsRow(1.15, true)).toBe(true);
            expect(sparkFitsRow(1, true)).toBe(true);
        });

        it('窄螢幕（≤400px）＋字級「大」：不掛載走勢元件與佔位、K 線請求 0、不排 rAF；各列一致改為名稱｜數字', async () => {
            let rafCalls = 0;
            vi.stubGlobal('requestAnimationFrame', () => ++rafCalls);
            vi.stubGlobal('cancelAnimationFrame', () => undefined);
            m.fontScale = 1.3;
            fakeMatchMedia(true);
            m.fetchKbars.mockResolvedValue(kbars([1000, 1004]));
            m.wl = { ...m.wl, items: [...items, { contract: { ...contract('IX0001', '加權指數', 0), security_type: 'IND' } }] };
            await render();
            const codes = ['2330', '2317', '2454', 'IX0001'];
            for (const code of codes) await setVisible(code, true);
            await flush();
            expect(view!.root.findAll(n => n.type === WatchSparkline)).toHaveLength(0);
            expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-spark-blank')).toHaveLength(0);
            expect(view!.root.findAll(n => n.type === 'canvas')).toHaveLength(0);
            expect(m.fetchKbars).not.toHaveBeenCalled();
            expect(sparklineQueueForTest()).toEqual({ queued: 0, inflight: 0 });
            expect(rafCalls).toBe(0);
            for (const code of codes) {
                expect(classesOf(code), code).toContain(wlStyles.rowNoSpark);
                expect(classesOf(code), code).not.toContain(wlStyles.rowWithSpark);
            }
            // 列尾仍對齊：指數列保留與快速下單鍵同寬的佔位
            expect(inRow('IX0001', 'watch-row-ticket-spacer')).toHaveLength(1);
            expect(inRow('2330', 'watch-row-ticket')).toHaveLength(1);
        });

        it('視窗寬度變化時更新：變寬後走勢出現並讀取，再變窄時卸載且不再讀取；卸載時解除 matchMedia 監聽', async () => {
            m.fontScale = 1.3;
            const mq = fakeMatchMedia(true);
            m.fetchKbars.mockResolvedValue(kbars([1000, 1004]));
            await render();
            await setVisible('2330', true);
            await flush();
            expect(m.fetchKbars).not.toHaveBeenCalled();
            expect(mq.listeners.size).toBeGreaterThan(0);

            await mq.set(false);
            await flush();
            expect(m.fetchKbars).toHaveBeenCalledTimes(1);
            expect(sparkOf('2330')!.props.points).toEqual([1000, 1004]);
            expect(classesOf('2330')).toContain(wlStyles.rowWithSpark);

            await mq.set(true);
            await flush();
            expect(view!.root.findAll(n => n.type === WatchSparkline)).toHaveLength(0);
            expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-spark-blank')).toHaveLength(0);
            expect(classesOf('2330')).toContain(wlStyles.rowNoSpark);
            expect(m.fetchKbars).toHaveBeenCalledTimes(1);

            await act(async () => view!.unmount());
            view = undefined;
            expect(mq.listeners.size).toBe(0);
        });

        it('一般情況仍顯示走勢：字級「大」但視窗較寬、或窄螢幕但字級不是「大」', async () => {
            m.fetchKbars.mockResolvedValue(kbars([1000, 1004]));
            m.fontScale = 1.3;
            fakeMatchMedia(false);
            await render();
            await setVisible('2330', true);
            await flush();
            expect(m.fetchKbars).toHaveBeenCalledTimes(1);
            expect(sparkOf('2330')!.props.points).toEqual([1000, 1004]);
            expect(inRow('2317', 'watch-spark-blank')[0]!.props['data-spark']).toBe('hidden');
            await act(async () => view!.unmount());

            m.fontScale = 1.15;
            fakeMatchMedia(true);
            await render();
            await setVisible('2330', true);
            await flush();
            expect(sparkOf('2330')!.props.points).toEqual([1000, 1004]);
            expect(inRow('2317', 'watch-spark-blank')[0]!.props['data-spark']).toBe('hidden');
            expect(classesOf('2330')).toContain(wlStyles.rowWithSpark);
        });

        it('沒有 matchMedia（或呼叫丟例外）：視為非窄螢幕，字級「大」仍依設定顯示走勢', async () => {
            m.fetchKbars.mockResolvedValue(kbars([1000, 1004]));
            m.fontScale = 1.3;
            vi.stubGlobal('matchMedia', undefined);
            await render();
            await setVisible('2330', true);
            await flush();
            expect(m.fetchKbars).toHaveBeenCalledTimes(1);
            expect(sparkOf('2330')!.props.points).toEqual([1000, 1004]);
            await act(async () => view!.unmount());

            vi.stubGlobal('matchMedia', () => { throw new Error('not supported'); });
            await render();
            await setVisible('2330', true);
            await flush();
            expect(sparkOf('2330')).toBeDefined();
        });

        it('設定關閉時語意不變：寬螢幕＋一般字級也不顯示、不請求', async () => {
            vi.stubGlobal('localStorage', fakeStorage());
            setWatchSparklineEnabled(false);
            fakeMatchMedia(false);
            await render();
            await setVisible('2330', true);
            await flush();
            expect(view!.root.findAll(n => n.type === WatchSparkline)).toHaveLength(0);
            expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-spark-blank')).toHaveLength(0);
            expect(m.fetchKbars).not.toHaveBeenCalled();
        });
    });
});

describe('WatchlistPage 快速下單鍵（watch-row-ticket，S1）', () => {
    beforeEach(() => {
        resetMobileUiForTest();
        for (const k of ORDER_FNS) m[k].mockClear();
    });
    const ticketBtn = (code: string) => inRow(code, 'watch-row-ticket');

    it('列尾、不在列按鈕內；只呼叫 openTicket（不帶方向、source other），不導頁、不開操作面板、lib 送單函式 0 次', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await render();
        expect(rowButton('2317').findAll(n => n.props['data-testid'] === 'watch-row-ticket')).toHaveLength(0);
        expect(ticketBtn('2317')).toHaveLength(1);
        expect(ticketBtn('2317')[0]!.props['aria-label']).toBe('下單 2317 鴻海');
        await act(async () => { ticketBtn('2317')[0]!.props.onClick(); });
        await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS * 2); });
        expect(getMobileUi().ticket).toMatchObject({ code: '2317', action: null, price: null, source: 'other' });
        expect(getMobileUi().orderAction).toBeNull();
        expect(m.navigate).not.toHaveBeenCalled();
        expect(view!.root.find(n => n.type === BottomSheet && n.props.testId === 'watch-actions').props.open).toBe(false);
        for (const k of ORDER_FNS) expect(m[k], k).not.toHaveBeenCalled();
    });

    it('指數與組合商品不顯示；編輯模式不顯示（改顯示「⋯」）', async () => {
        m.wl = { ...m.wl, items: [...items, { contract: { ...contract('TSE001', '加權指數', 0), security_type: 'IND' } }] };
        await render();
        expect(ticketBtn('TSE001')).toHaveLength(0);
        expect(ticketBtn('2330')).toHaveLength(1);
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-edit' && n.type === 'button').props.onClick(); });
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-row-ticket' && typeof n.type === 'string')).toHaveLength(0);
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-more' && typeof n.type === 'string')).toHaveLength(4);
    });

    it('指數與組合商品放同寬的 aria-hidden 空白佔位（不可聚焦、不可點），所有列的列尾同寬、價格欄與走勢欄對齊', async () => {
        m.wl = {
            ...m.wl,
            items: [
                ...items,
                { contract: { ...contract('IX0001', '加權指數', 0), security_type: 'IND' } },
                { contract: { ...contract('TXFI6/J6', '台指價差', 0), security_type: 'FUT', exchange: 'TAIFEX', combo: { code: 'TXFI6/J6', legs: [], combo_type: 'spread' } } },
            ],
        };
        await render();
        for (const code of ['IX0001', 'TXFI6/J6']) {
            expect(ticketBtn(code)).toHaveLength(0);
            const spacer = inRow(code, 'watch-row-ticket-spacer');
            expect(spacer).toHaveLength(1);
            expect(spacer[0]!.type).toBe('span');
            expect(spacer[0]!.props.className).toBe(wlStyles.ticketSpacer);
            expect(spacer[0]!.parent!.props.className).toBe(wlStyles.rowTrailing);
            expect(spacer[0]!.parent!.props['aria-hidden']).toBe('true');
            expect(rowItem(code).findAll(n => n.type === 'button')).toHaveLength(1); // 只有列按鈕
        }
        expect(inRow('2330', 'watch-row-ticket-spacer')).toHaveLength(0);
        // 每一列的列按鈕都讓出列尾（同一組 class），列尾都是 rowTrailing 包一個 TOUCH_MIN 寬的元素
        const classes = new Set(['2330', '2317', '2454', 'IX0001', 'TXFI6/J6'].map(code => rowButton(code).props.className as string));
        expect(classes.size).toBe(1);
        expect([...classes][0]).toContain(wlStyles.rowHasTrailing);
        // 編輯模式：所有列都是「⋯」，佔位移除
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-edit' && n.type === 'button').props.onClick(); });
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-row-ticket-spacer')).toHaveLength(0);
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-more' && typeof n.type === 'string')).toHaveLength(5);
    });
});

describe('WatchlistPage 表頭編輯鍵與清單分頁', () => {
    it('編輯鍵在表頭右側（不在頁首）；aria-pressed 切換、文字「編輯／完成」', async () => {
        await render();
        const header = view!.root.find(n => n.props['data-testid'] === 'watch-list-header');
        const edit = () => header.find(n => n.props['data-testid'] === 'watch-edit' && n.type === 'button');
        expect(textOf(header.findAll(n => n.type === 'span')[0]!)).toBe('名稱');
        expect(edit().props['aria-pressed']).toBe(false);
        expect(textOf(edit())).toBe('編輯');
        await act(async () => { edit().props.onClick(); });
        expect(edit().props['aria-pressed']).toBe(true);
        expect(textOf(edit())).toBe('完成');
        await act(async () => { edit().props.onClick(); });
        expect(edit().props['aria-pressed']).toBe(false);
    });

    it('編輯鍵的無障礙名稱包含可見文字（WCAG 2.5.3）：「編輯」→「編輯自選」、「完成」→「完成編輯」', async () => {
        await render();
        const edit = () => view!.root.find(n => n.props['data-testid'] === 'watch-edit' && n.type === 'button');
        expect(textOf(edit())).toBe('編輯');
        expect(edit().props['aria-label']).toBe('編輯自選');
        expect(edit().props['aria-label']).toContain(textOf(edit()));
        await act(async () => { edit().props.onClick(); });
        expect(textOf(edit())).toBe('完成');
        expect(edit().props['aria-label']).toBe('完成編輯');
        expect(edit().props['aria-label']).toContain(textOf(edit()));
        expect(edit().props['aria-pressed']).toBe(true);
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-edit' && n.type === 'button')).toHaveLength(1);
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-search' && n.type === 'button')).toHaveLength(1);
    });

    it('只有 1 個清單時不顯示分頁', async () => {
        m.wl = { ...m.wl, serverLists: [{ id: 'a', name: '我的自選', contracts: [] }] };
        await render();
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-list-tabs')).toHaveLength(0);
    });

    it('清單結構忙碌時分頁停用', async () => {
        m.wl = { ...m.wl, structureBusy: true };
        await render();
        expect(view!.root.find(n => n.props['data-testid'] === 'watch-list-tab-b' && n.type === 'button').props.disabled).toBe(true);
    });
});

describe('WatchlistPage 底部指數列（加權｜櫃買）', () => {
    const cell = (code: string) => view!.root.find(n => n.props['data-testid'] === `watch-index-${code}` && n.type === 'button');

    const inCell = (code: string, id: string) => cell(code).findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');

    it('只在自選頁掛載時以 ContractBase 直接訂閱 IX0001／IX0043（不經 useQuote、不解析合約）；點按只導頁；離開即釋放', async () => {
        await render();
        expect(m.useQuoteCalls.filter(c => INDEX_CODES.has(c.code ?? ''))).toHaveLength(0);
        expect(m.resolveContract).not.toHaveBeenCalled();
        expect(m.retainContractQuotes.mock.calls.map(c => c[0])).toEqual([
            { security_type: 'IND', region: 'TW', exchange: 'TSE', code: 'IX0001', target_code: null },
            { security_type: 'IND', region: 'TW', exchange: 'OTC', code: 'IX0043', target_code: null },
        ]);
        expect(m.ensureStream).toHaveBeenCalled();
        m.quotes.set('IX0001', { tick: undefined, index: { close: '23000', reference: '22770' } });
        m.quotes.set('IX0043', { tick: undefined, index: { close: '250', reference: '260' } });
        await act(async () => { m.emit(); });
        expect(cell('IX0001').props['aria-label']).toBe('加權指數 23,000.00，漲 +1.01%，開啟交易頁');
        expect(cell('IX0043').props['aria-label']).toBe('櫃買指數 250.00，跌 -3.85%，開啟交易頁');
        expect(cell('IX0001').props['data-dir']).toBe('up');
        resetMobileUiForTest();
        await act(async () => { cell('IX0043').props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: 'IX0043' });
        expect(getMobileUi().ticket).toBeNull();
        for (const k of ORDER_FNS) expect(m[k], k).not.toHaveBeenCalled();
        // 離開自選頁：兩檔都釋放（quote-ownership 寬限期後退訂），不再監聽
        await act(async () => view!.unmount());
        view = undefined;
        expect(m.releasedQuotes.sort()).toEqual(['IX0001', 'IX0043']);
        expect(m.listeners.size).toBe(0);
    });

    it('可讀性：數值與漲跌幅文字是 foreground（不著漲跌色）；方向是有色 ▲▼ 圖形（SVG、aria-hidden）；文字帶正負號', async () => {
        await render();
        m.quotes.set('IX0001', { tick: undefined, index: { close: '23000', reference: '22770' } });
        m.quotes.set('IX0043', { tick: undefined, index: { close: '250', reference: '260' } });
        await act(async () => { m.emit(); });
        for (const code of ['IX0001', 'IX0043']) {
            const valueBox = cell(code).find(n => n.type === 'span' && n.props.className === wlStyles.indexValue);
            expect(valueBox.props['aria-hidden']).toBe('true');
            for (const id of ['watch-index-value', 'watch-index-pct']) {
                const cls = inCell(code, id)[0]!.props.className as string;
                for (const tone of Object.values(wlStyles.tone)) expect(cls, `${code} ${id}`).not.toContain(tone);
            }
        }
        expect(textOf(inCell('IX0001', 'watch-index-value')[0]!)).toBe('23,000.00');
        expect(textOf(inCell('IX0001', 'watch-index-pct')[0]!)).toBe('+1.01%');
        expect(textOf(inCell('IX0043', 'watch-index-pct')[0]!)).toBe('-3.85%');
        const arrow = (code: string) => cell(code).find(n => n.type === 'svg');
        expect(arrow('IX0001').props['data-dir']).toBe('up');
        expect(arrow('IX0001').props['aria-hidden']).toBe('true');
        expect(arrow('IX0001').props.focusable).toBe('false');
        expect(arrow('IX0001').props.className).toContain(wlStyles.tone.up);
        expect(arrow('IX0001').props.className).toContain(wlStyles.indexArrow);
        expect(arrow('IX0043').props['data-dir']).toBe('down');
        expect(arrow('IX0043').props.className).toContain(wlStyles.tone.down);
        // 圖形不是文字：沒有 ▲▼ 字元
        expect(textOf(cell('IX0001'))).not.toMatch(/[▲▼]/);
        // 平盤：沒有方向圖形
        m.quotes.set('IX0001', { tick: undefined, index: { close: '22770', reference: '22770' } });
        await act(async () => { m.emit(); });
        expect(cell('IX0001').findAll(n => n.type === 'svg')).toHaveLength(0);
        expect(textOf(inCell('IX0001', 'watch-index-pct')[0]!)).toBe('0.00%');
    });

    const snap = (code: string, close: number, change: number) => ({ code, close, change_price: change, change_rate: 0, datetime: '2026-11-06 13:30:00' });
    const flushSnap = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

    it('沒有即時指數（盤後、週末才開 App）：以快照的收盤與漲跌顯示；自選頁掛載時讀 1 次、TTL 內不重讀', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        m.fetchSnapshots.mockResolvedValue([snap('IX0001', 23000, 230), snap('IX0043', 250, -10)]);
        await render();
        await flushSnap();
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(1);
        const contracts = (m.fetchSnapshots.mock.calls[0] as unknown[])[0] as { code: string; security_type: string; exchange: string }[];
        expect(contracts.map(c => [c.code, c.security_type, c.exchange])).toEqual([['IX0001', 'IND', 'TSE'], ['IX0043', 'IND', 'OTC']]);
        expect(cell('IX0001').props['aria-label']).toBe('加權指數 23,000.00，漲 +1.01%，開啟交易頁');
        expect(cell('IX0001').props['data-source']).toBe('snapshot');
        expect(cell('IX0043').props['aria-label']).toBe('櫃買指數 250.00，跌 -3.85%，開啟交易頁');
        // 即時優先
        m.quotes.set('IX0001', { tick: undefined, index: { close: '23100', reference: '22770' } });
        await act(async () => { m.emit(); });
        expect(cell('IX0001').props['data-source']).toBe('live');
        expect(textOf(cell('IX0001').findAll(n => n.type === 'span')[1]!)).toBe('23,100.00+1.45%');
        expect(cell('IX0001').find(n => n.type === 'svg').props['data-dir']).toBe('up');
        // 離開再回來：TTL 內不重讀；TTL 後才再讀
        await act(async () => view!.unmount());
        await render();
        await flushSnap();
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(1);
        await act(async () => view!.unmount());
        vi.setSystemTime(Date.now() + INDEX_SNAPSHOT_TTL_MS);
        await render();
        await flushSnap();
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(2);
    });

    it('沒有即時也沒有快照（讀取失敗）：「—」，aria-label 說明沒有即時資料；失敗不拋錯', async () => {
        m.fetchSnapshots.mockRejectedValue(new Error('503'));
        await render();
        await flushSnap();
        expect(cell('IX0001').props['aria-label']).toBe('加權指數 — 沒有即時資料，開啟交易頁');
        expect(cell('IX0001').props['data-source']).toBe('none');
        expect(textOf(cell('IX0001').findAll(n => n.type === 'span')[1]!)).toBe('—');
        expect(cell('IX0001').findAll(n => n.type === 'svg')).toHaveLength(0);
    });
});

describe('WatchlistPage 載入、空清單與錯誤狀態', () => {
    const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');

    it('載入中：骨架（role=status，保留「自選清單載入中…」文字）', async () => {
        m.wl = { ...m.wl, items: [], loading: true };
        await render();
        const status = view!.root.findAll(n => n.props.role === 'status' && typeof n.type === 'string');
        expect(status).toHaveLength(1);
        expect(text(status[0]!)).toContain('自選清單載入中…');
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-list')).toHaveLength(0);
    });

    it('空清單：EmptyState 的「搜尋並加入」開啟搜尋面板（延遲載入：要求開啟前不掛載，之後保持掛載）', async () => {
        m.wl = { ...m.wl, items: [] };
        await render();
        expect(text(view!.root.find(n => n.props['data-testid'] === 'watch-empty' && typeof n.type === 'string'))).toBe('這份清單還沒有商品。');
        const search = () => view!.root.findAll(n => n.props.testId === 'search-sheet' && n.type === BottomSheet);
        expect(search()).toHaveLength(0);
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-empty-search' && n.type === 'button').props.onClick(); });
        expect(search()).toHaveLength(1);
        expect(search()[0]!.props.open).toBe(true);
        await act(async () => { search()[0]!.props.onClose(); });
        expect(search()).toHaveLength(1);
        expect(search()[0]!.props.open).toBe(false);
    });

    it('載入失敗：InlineNote（role=alert）＋重試', async () => {
        m.retryLoad.mockClear();
        m.wl = { ...m.wl, items: [], loadError: true };
        await render();
        const alert = view!.root.find(n => n.props.role === 'alert' && typeof n.type === 'string');
        expect(text(alert)).toContain('自選清單載入失敗。');
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-retry' && n.type === 'button').props.onClick(); });
        expect(m.retryLoad).toHaveBeenCalledTimes(1);
    });
});
