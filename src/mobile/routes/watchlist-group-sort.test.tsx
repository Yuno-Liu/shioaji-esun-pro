// 自選群組（清單）排序（使用者要求：「自選 可以編輯後排序自選群組(可以手動拖移) 目前都是固定的」）：
// - 編輯模式「排序群組」（延遲載入的編輯 chunk）→ 面板：握把拖曳（lib/watch-reorder 的 useListReorder，同手勢規則與減少動態）、
//   握把上 ↑／↓、每列 ↑／↓ 鍵；移動即存（localStorage），自選頁清單分頁依新順序重繪；「完成」關閉。
// - 順序只存在這台裝置（伺服器沒有順序欄位與排序 API）：0 個網路請求、不呼叫任何清單寫入。
// - 合併規則（新清單在最後、刪除的略過、格式不對忽略）見 lib/watch-list-order.test.ts；這裡驗頁面套用與存檔時移除已刪除的 id。
// - S1：每個新按鈕都點過，送單、改單、刪單、開下單面板與委託操作面板都不會被呼叫。
import { createElement, useSyncExternalStore } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    navigate: vi.fn(),
    notify: vi.fn(),
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    apiGet: vi.fn(async () => ({ code: [] })),
    fetchSnapshots: vi.fn(async () => []),
    state: {} as Record<string, unknown>,
    listeners: new Set<() => void>(),
    writes: {
        addSymbol: vi.fn(),
        removeSymbol: vi.fn(),
        reorderSymbol: vi.fn(),
        setActiveList: vi.fn(),
        createList: vi.fn(),
        renameCurrentList: vi.fn(),
        deleteCurrentList: vi.fn(),
        retryLoad: vi.fn(),
    },
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
}));

vi.mock('../../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../../hooks/use-watchlist', () => ({
    useWatchlist: () => useSyncExternalStore(
        l => { m.listeners.add(l); return () => { m.listeners.delete(l); }; },
        () => m.state,
    ),
}));
vi.mock('../../lib/product-search', () => ({ searchProducts: vi.fn(async () => []) }));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));
vi.mock('../lib/mobile-store', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/mobile-store')>()),
    openTicket: m.openTicket,
    openOrderAction: m.openOrderAction,
}));
vi.mock('../../lib/stream', () => ({ ensureStream: () => undefined, getQuote: () => undefined, subscribeQuoteStore: () => () => undefined }));
vi.mock('../../lib/quote-ownership', () => ({ retainContractQuotes: () => () => undefined }));
vi.mock('../../lib/shioaji', () => ({
    fetchScanner: vi.fn(async () => []),
    fetchKbars: vi.fn(),
    fetchSnapshots: m.fetchSnapshots,
    resolveContract: vi.fn(),
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
vi.mock('../../lib/api', () => ({ apiGet: m.apiGet }));
vi.mock('../../lib/trade', () => ({ notify: m.notify }));
vi.mock('../motion/haptics', () => ({ haptic: vi.fn(() => false) }));

import { BottomSheet } from '../components/bottom-sheet';
import { resetMultiSelectForTest } from '../components/watch-edit-controls';
import { resetPunishedCodesForTest } from '../lib/regulatory-punish';
import { LIST_ORDER_KEY, orderLists } from '../lib/watch-list-order';
import { REORDER_SHIFT_MS } from '../lib/watch-reorder';
import { resetWatchPrefsForTest, setWatchSparklineEnabled } from '../lib/watch-prefs';
import { WatchlistProvider } from '../lib/watchlist-context';
import * as wlStyles from '../styles/watchlist.css';
import { preloadWatchEditControls, resetWatchlistSegmentForTest, WatchlistPage } from './watchlist-page';

const ORDER_FNS = [
    'placeStockOrder', 'placeFuturesOrder', 'placeComboOrder', 'cancelOrder', 'cancelOrders',
    'cancelVerifiedOrder', 'cancelComboOrder', 'updateOrderPrice', 'updateOrderQty', 'requestOrderConfirm',
    'openTicket', 'openOrderAction',
] as const;

const contract = (code: string, name: string) => ({ code, name, reference: 100, security_type: 'STK', exchange: 'TSE', target_code: null });
const base = (code: string) => ({ code, security_type: 'STK', exchange: 'TSE' });
const ITEMS = [{ contract: contract('2330', '台積電') }, { contract: contract('2317', '鴻海') }];
const LISTS = [
    { id: 'a', name: '主要', contracts: [base('2330'), base('2317')] },
    { id: 'b', name: '觀察', contracts: [base('2454')] },
    { id: 'c', name: '短線', contracts: [] },
];

const data = new Map<string, string>();
const stored = () => JSON.parse(data.get(LIST_ORDER_KEY) ?? 'null') as unknown;

// ---- 假 DOM：排序面板的清單（ul，有 ref）的 children 依目前順序回傳假的列（data-code＝清單 id；有位置與 style） ----
// react-test-renderer 只為有 ref 的節點呼叫 createNodeMock：列（li）沒有 ref，假的列由 ul 的 children 依 id 建立並快取
const ROW_TOP = 200;
const ROW_H = 56;
type FakeRow = { style: Record<string, string>; getAttribute: (n: string) => string | null; getBoundingClientRect: () => { top: number; height: number }; querySelector: () => null };
const rows = new Map<string, FakeRow>();
const groupOrder = () => orderLists(m.state.serverLists as typeof LISTS).map(l => l.id);
const fakeRow = (id: string): FakeRow => {
    let row = rows.get(id);
    if (!row) {
        row = {
            style: {},
            getAttribute: n => (n === 'data-code' ? id : null),
            getBoundingClientRect: () => ({ top: ROW_TOP + groupOrder().indexOf(id) * ROW_H, height: ROW_H }),
            querySelector: () => null,
        };
        rows.set(id, row);
    }
    return row;
};
function nodeMock(el: { type: unknown; props: Record<string, unknown> }) {
    if (el.type === 'ul' && el.props['data-testid'] === 'watch-group-sort-list') {
        return {
            get children() { return groupOrder().map(fakeRow); },
            closest: () => null,
        };
    }
    return {};
}

let view: ReactTestRenderer | undefined;
async function render() {
    await act(async () => { view = create(createElement(WatchlistProvider, null, createElement(WatchlistPage)), { createNodeMock: nodeMock as never }); });
}
const all = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => {
    const found = all(id);
    if (found.length !== 1) throw new Error(`${id}: ${found.length}`);
    return found[0]!;
};
const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const sheet = () => view!.root.findAll(n => n.type === BottomSheet && n.props.testId === 'watch-group-sort')[0];
const click = async (n: ReactTestInstance) => { await act(async () => { n.props.onClick(); }); };
const tabOrder = () => view!.root
    .findAll(n => typeof n.type === 'string' && String(n.props['data-testid'] ?? '').startsWith('watch-list-tab-'))
    .map(n => String(n.props['data-testid']).slice('watch-list-tab-'.length));
const sheetRows = () => all('watch-group-row');
const sheetOrder = () => sheetRows().map(r => r.props['data-code'] as string);
const rowOf = (id: string) => sheetRows().find(r => r.props['data-code'] === id)!;
const inRow = (id: string, testId: string) => rowOf(id).findAll(n => n.props['data-testid'] === testId && typeof n.type === 'string')[0]!;
async function settleUntil(pred: () => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!pred() && Date.now() < deadline) {
        await act(async () => {
            await vi.dynamicImportSettled();
            await new Promise(resolve => setTimeout(resolve, 10));
        });
    }
}
const enterEdit = async () => {
    await click(one('watch-edit'));
    await settleUntil(() => all('watch-group-sort-open').length === 1);
};
const openSort = async () => {
    await enterEdit();
    await click(one('watch-group-sort-open'));
    expect(sheet()!.props.open).toBe(true);
};
const requestCounts = () => [m.apiGet.mock.calls.length, m.fetchSnapshots.mock.calls.length];

/** 編輯 chunk 先載入（retryableLazy 模組層快取）：各測試進入編輯模式時同步渲染，不受第一次 import 的時間影響 */
beforeAll(async () => {
    await preloadWatchEditControls();
}, 30_000);

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    data.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
    });
    rows.clear();
    for (const k of ORDER_FNS) m[k].mockClear();
    for (const f of Object.values(m.writes)) f.mockClear();
    m.navigate.mockClear();
    m.notify.mockClear();
    resetMultiSelectForTest();
    resetWatchlistSegmentForTest();
    resetWatchPrefsForTest();
    resetPunishedCodesForTest();
    setWatchSparklineEnabled(false);
    m.state = { items: ITEMS, loading: false, structureBusy: false, loadError: false, serverLists: LISTS, activeListId: 'a', ...m.writes };
});
afterEach(async () => {
    for (const k of ORDER_FNS) expect(m[k], `S1：${k}`).not.toHaveBeenCalled();
    // 排序只改這台裝置：不呼叫任何清單寫入
    for (const [k, f] of Object.entries(m.writes)) expect(f, k).not.toHaveBeenCalled();
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('自選頁清單分頁依這台裝置的群組順序', () => {
    it('沒有設定：伺服器順序；有設定：已存的在前、新清單在最後、已刪除的略過', async () => {
        await render();
        expect(tabOrder()).toEqual(['a', 'b', 'c']);
        await act(async () => view!.unmount());
        data.set(LIST_ORDER_KEY, JSON.stringify(['c', 'gone', 'a']));
        await render();
        expect(tabOrder()).toEqual(['c', 'a', 'b']);
        await act(async () => view!.unmount());
        data.set(LIST_ORDER_KEY, '{oops');
        await render();
        expect(tabOrder()).toEqual(['a', 'b', 'c']);
    });
});

describe('排序群組面板', () => {
    it('編輯模式才有「排序群組」；只有一個清單時停用；多選中不顯示', async () => {
        await render();
        expect(all('watch-group-sort-open')).toHaveLength(0);
        await enterEdit();
        expect(textOf(one('watch-group-sort-open'))).toBe('排序群組');
        expect(one('watch-group-sort-open').props.disabled).toBe(false);
        await click(one('watch-multi'));
        expect(all('watch-group-sort-open')).toHaveLength(0);
        await click(one('watch-multi'));
        expect(all('watch-group-sort-open')).toHaveLength(1);
        await act(async () => view!.unmount());
        m.state = { ...m.state, serverLists: [LISTS[0]] };
        await render();
        await enterEdit();
        expect(one('watch-group-sort-open').props.disabled).toBe(true);
    });

    it('面板：依目前順序列出群組（名稱、檔數）、說明只存在這台裝置；「完成」關閉；開啟不發請求', async () => {
        data.set(LIST_ORDER_KEY, JSON.stringify(['b']));
        await render();
        await enterEdit();
        const before = requestCounts();
        await click(one('watch-group-sort-open'));
        expect(sheet()!.props.open).toBe(true);
        expect(sheet()!.props.title).toBe('排序群組');
        expect(sheetOrder()).toEqual(['b', 'a', 'c']);
        expect(sheetRows().map(r => textOf(r))).toEqual(['觀察1 檔', '主要2 檔', '短線0 檔']);
        expect(textOf(sheet()!.findAll(n => n.type === 'p')[0]!)).toContain('群組順序只存在這台裝置');
        expect(inRow('b', 'watch-group-up').props.disabled).toBe(true);
        expect(inRow('b', 'watch-group-down').props.disabled).toBe(false);
        expect(inRow('c', 'watch-group-down').props.disabled).toBe(true);
        expect(inRow('a', 'watch-group-up').props['aria-label']).toBe('上移「主要」');
        expect(inRow('a', 'watch-group-grip').props['aria-label']).toBe('拖曳以調整「主要」的位置');
        expect(inRow('a', 'watch-group-grip').props.className).toContain(wlStyles.grip);
        await click(one('watch-group-sort-done'));
        expect(sheet()!.props.open).toBe(false);
        expect(requestCounts()).toEqual(before);
    });

    it('↑／↓ 一次移一格：立即存在這台裝置、清單分頁依新順序重繪；0 個請求', async () => {
        await render();
        await openSort();
        const before = requestCounts();
        await click(inRow('a', 'watch-group-down'));
        expect(stored()).toEqual(['b', 'a', 'c']);
        expect(sheetOrder()).toEqual(['b', 'a', 'c']);
        expect(tabOrder()).toEqual(['b', 'a', 'c']);
        await click(inRow('c', 'watch-group-up'));
        expect(stored()).toEqual(['b', 'c', 'a']);
        expect(tabOrder()).toEqual(['b', 'c', 'a']);
        // 到頂的「上移」停用
        await click(inRow('c', 'watch-group-up'));
        expect(stored()).toEqual(['c', 'b', 'a']);
        expect(inRow('c', 'watch-group-up').props.disabled).toBe(true);
        expect(requestCounts()).toEqual(before);
    });

    it('存檔只留目前的清單（已刪除的 id 移除）', async () => {
        data.set(LIST_ORDER_KEY, JSON.stringify(['gone', 'c', 'a']));
        await render();
        await openSort();
        expect(sheetOrder()).toEqual(['c', 'a', 'b']);
        await click(inRow('b', 'watch-group-up'));
        expect(stored()).toEqual(['c', 'b', 'a']);
    });

    it('握把上 ↑／↓：一次移一格（同自選列的握把）', async () => {
        await render();
        await openSort();
        await act(async () => {
            inRow('a', 'watch-group-grip').props.onKeyDown({ key: 'ArrowDown', repeat: false, preventDefault: vi.fn(), currentTarget: { focus: vi.fn() } });
        });
        expect(stored()).toEqual(['b', 'a', 'c']);
        expect(tabOrder()).toEqual(['b', 'a', 'c']);
    });

    it('握把拖曳：列跟手指、其他列讓位，放手才存一次；減少動態時讓位不做動畫', async () => {
        const ev = (clientY: number) => ({
            pointerId: 1, pointerType: 'touch', button: 0, clientX: 300, clientY,
            preventDefault: vi.fn(), currentTarget: { setPointerCapture: vi.fn() },
        });
        const grip = (id: string) => inRow(id, 'watch-group-grip');
        // 列中心：a＝228、b＝284、c＝340
        await render();
        await openSort();
        await act(async () => { grip('a').props.onPointerDown(ev(228)); });
        expect(rowOf('a').props.className).toContain(wlStyles.rowDragging);
        await act(async () => { grip('a').props.onPointerMove(ev(300)); });
        expect(rows.get('a')!.style.transform).toBe('translateY(72px)');
        expect(rows.get('b')!.style.transform).toBe(`translateY(${-ROW_H}px)`);
        expect(rows.get('b')!.style.transition).toBe(`transform ${REORDER_SHIFT_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`);
        expect(data.has(LIST_ORDER_KEY)).toBe(false);
        await act(async () => { grip('a').props.onPointerUp(ev(300)); });
        expect(stored()).toEqual(['b', 'a', 'c']);
        expect(tabOrder()).toEqual(['b', 'a', 'c']);
        expect(rows.get('a')!.style.transform).toBe('');

        // 減少動態（系統設定）：讓位不做動畫
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('prefers-reduced-motion'), addEventListener: () => undefined, removeEventListener: () => undefined }));
        await new Promise(r => setTimeout(r, 400)); // 放手後的點擊防護時間
        // 目前順序 b、a、c：b 中心 228
        await act(async () => { grip('b').props.onPointerDown(ev(228)); });
        await act(async () => { grip('b').props.onPointerMove(ev(300)); });
        expect(rows.get('a')!.style.transform).toBe(`translateY(${-ROW_H}px)`);
        expect(rows.get('a')!.style.transition).toBe('none');
        await act(async () => { grip('b').props.onPointerCancel(ev(300)); });
        // 取消：不存
        expect(stored()).toEqual(['b', 'a', 'c']);
    });
});
