// 自選頁（規格 §6.1、§9.4）：只有可見列呼叫 useQuote；離開畫面卸載；每列重繪以 100 ms 節流；
// 點列開交易頁、長按開操作面板（移除、移動）；清單切換；試撮徽章；自選狀態常駐（切換分頁不重新讀清單）。
import { createElement, useState, useSyncExternalStore } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        haptic: vi.fn(() => false),
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
vi.mock('../../lib/shioaji', () => ({
    fetchScanner: m.fetchScanner,
    fetchKbars: m.fetchKbars,
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
vi.mock('../motion/haptics', () => ({ haptic: m.haptic }));

import { BottomSheet } from '../components/bottom-sheet';
import { resetRankingForTest } from '../components/ranking-list';
import { getMobileUi, resetMobileUiForTest } from '../lib/mobile-store';
import { WatchlistProvider } from '../lib/watchlist-context';
import { fill } from '../styles/primitives.css';
import * as wlStyles from '../styles/watchlist.css';
import {
    createVisibilityTracker,
    LONG_PRESS_MS,
    nextWatchMetric,
    resetWatchlistSegmentForTest,
    rowQuoteView,
    SIM_LABEL,
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
function nodeMock(el: { type: unknown; props: unknown }) {
    const element = el as { type: unknown; props: Record<string, unknown> };
    if (element.type === 'li' && typeof element.props['data-code'] === 'string') {
        const code = element.props['data-code'] as string;
        const node = nodes.get(code) ?? { code };
        nodes.set(code, node);
        return node;
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
const quoteCodes = () => new Set(m.useQuoteCalls.map(c => c.code));
const probes = () => view!.root.findAll(n => n.type === WatchQuoteProbe).map(n => n.props.code as string);
const rowButton = (code: string): ReactTestInstance =>
    view!.root.find(n => n.type === 'li' && n.props['data-code'] === code).find(n => n.props['data-testid'] === 'watch-row-button');
const priceText = (code: string) =>
    view!.root.find(n => n.type === 'li' && n.props['data-code'] === code).find(n => n.props['data-testid'] === 'watch-price').props.children as string;
const tick = (close: string, chg: string, simtrade = false) => ({ tick: { close, price_chg: chg, simtrade }, index: undefined });

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', FakeIO);
    FakeIO.instances = [];
    nodes.clear();
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
    resetRankingForTest();
    resetWatchlistSegmentForTest();
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
        expect(m.useQuoteCalls).toHaveLength(0);
        expect(probes()).toEqual([]);
    });

    it('subscribes only the visible rows, with narrow quotes', async () => {
        await render();
        await setVisible('2317', true);
        expect(probes()).toEqual(['2317']);
        expect(quoteCodes()).toEqual(new Set(['2317']));
        expect(m.useQuoteCalls.every(c => (c.options as { narrow?: boolean }).narrow === true)).toBe(true);
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

    it('switching lists calls setActiveList', async () => {
        await render();
        const picker = view!.root.find(n => n.props['data-testid'] === 'watch-list-picker');
        await act(async () => { picker.props.onChange({ target: { value: 'b' } }); });
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
        expect(findAll('watch-list-picker')).toHaveLength(0);
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

    it('自選頁不讀 K 線（不做迷你走勢）', async () => {
        await render();
        await setVisible('2330', true);
        m.quotes.set('2330', tick('1010', '10'));
        await act(async () => { m.emit(); });
        expect(m.fetchKbars).not.toHaveBeenCalled();
    });
});

describe('WatchlistPage 表頭指標切換鍵（watch-metric-toggle）', () => {
    const toggle = () => view!.root.find(n => n.props['data-testid'] === 'watch-metric-toggle' && n.type === 'button');
    const pill = (code: string) =>
        view!.root.find(n => n.type === 'li' && n.props['data-code'] === code).find(n => n.props['data-testid'] === 'watch-pill');

    it('在表頭、不在列按鈕內；漲跌幅 → 漲跌 → 總量 循環並存 localStorage；列 aria-label 永遠含全部資訊', async () => {
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
        expect(pill('2330').props.children).toBe('+1.40%');
        await act(async () => { toggle().props.onClick(); });
        expect(toggle().props['data-metric']).toBe('chg');
        expect(pill('2330').props.children).toBe('▲14.00');
        expect(storage.map.get(WATCH_METRIC_KEY)).toBe('chg');
        await act(async () => { toggle().props.onClick(); });
        expect(pill('2330').props.children).toBe('4.6萬');
        // 總量沒有方向：中性膠囊（不用實心漲跌色）
        expect(pill('2330').props.className).toContain(wlStyles.pill.flat);
        expect(pill('2330').props.className).not.toContain(fill.up.strong);
        const label = rowButton('2330').props['aria-label'] as string;
        expect(label).toContain('1,014');
        expect(label).toContain('漲 ▲14.00 +1.40%');
        expect(label).toContain('總量 4.6萬');
        await act(async () => { toggle().props.onClick(); });
        expect(toggle().props['data-metric']).toBe('pct');
        expect(storage.map.get(WATCH_METRIC_KEY)).toBe('pct');
    });

    it('上漲膠囊為實心 up＋inkStrong（fill.up.strong）；下跌為 fill.down.strong；平盤為中性', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await render();
        for (const code of ['2330', '2317', '2454']) await setVisible(code, true);
        m.quotes.set('2330', tick('1010', '10'));
        m.quotes.set('2317', tick('190', '-10'));
        m.quotes.set('2454', tick('1200', '0'));
        await act(async () => { m.emit(); });
        await act(async () => { vi.advanceTimersByTime(WATCH_REPAINT_MS); });
        expect(pill('2330').props.className).toContain(fill.up.strong);
        expect(pill('2317').props.className).toContain(fill.down.strong);
        expect(pill('2317').props.children).toBe('-5.00%');
        expect(pill('2454').props.className).toContain(wlStyles.pill.flat);
    });

    it('讀回儲存的指標；無效值或 localStorage 失敗時退回漲跌幅', async () => {
        vi.stubGlobal('localStorage', fakeStorage({ [WATCH_METRIC_KEY]: 'vol' }));
        await render();
        expect(toggle().props['data-metric']).toBe('vol');
        await act(async () => view!.unmount());
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
        await render();
        expect(toggle().props['data-metric']).toBe('pct');
        await act(async () => { toggle().props.onClick(); });
        expect(toggle().props['data-metric']).toBe('chg');
        expect(nextWatchMetric('vol')).toBe('pct');
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

    it('空清單：EmptyState 的「搜尋並加入」開啟搜尋面板', async () => {
        m.wl = { ...m.wl, items: [] };
        await render();
        expect(text(view!.root.find(n => n.props['data-testid'] === 'watch-empty' && typeof n.type === 'string'))).toBe('這份清單還沒有商品。');
        const search = () => view!.root.find(n => n.props.testId === 'search-sheet' && n.type === BottomSheet);
        expect(search().props.open).toBe(false);
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-empty-search' && n.type === 'button').props.onClick(); });
        expect(search().props.open).toBe(true);
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
