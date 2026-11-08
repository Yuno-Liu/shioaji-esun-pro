// 排序群組面板的多選刪除群組（使用者要求：「排序群組的時候也支援多選刪除，刪除時須使用者確認」）：
// - 「選取」（aria-pressed）→ 每列勾選鍵（role=checkbox、「選取群組「主要」（2 檔）」）、點列切換、握把與 ↑／↓ 隱藏、目前清單標「（目前）」。
// - 底部「已選 N 個｜取消｜刪除 N 個群組」：N＝0、全部選取（至少保留一個）、清單忙碌或載入失敗時停用並寫原因。
// - 確認畫面（同一面板）：標題、群組與檔數、合計、警語、含目前群組時的說明；焦點移到標題，返回時回到刪除鍵；按確定前 0 個請求。
// - 確定：非目前群組 lib deleteWatchlist（依序），目前群組最後 hook deleteCurrentList；結束後一則摘要、回到排序、順序移除刪掉的 id。
// - S1：每個新按鈕都點過，送單、改單、刪單、開下單面板與委託操作面板都不會被呼叫。
// 這裡的 useWatchlist 是可更新的假 store；真 useWatchlist 的請求數見 components/watch-group-delete.test.tsx。
import { createElement, useSyncExternalStore } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    navigate: vi.fn(),
    notify: vi.fn(),
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    apiGet: vi.fn(async () => ({ code: [] })),
    deleteWatchlist: vi.fn(),
    emit: vi.fn(),
    focus: { title: vi.fn(), del: vi.fn(), select: vi.fn(), list: vi.fn() },
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
    deleteWatchlist: m.deleteWatchlist,
}));
vi.mock('../../lib/watchlist-sync', () => ({ emitWatchlistChanged: m.emit }));
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
    if (el.props['data-testid'] === 'watch-group-del-title') return { focus: m.focus.title };
    if (el.props['data-testid'] === 'watch-group-del') return { focus: m.focus.del };
    if (el.props['data-testid'] === 'watch-group-select') return { focus: m.focus.select, disabled: el.props.disabled === true };
    if (el.type === 'ul' && el.props['data-testid'] === 'watch-group-sort-list') {
        return {
            get children() { return groupOrder().map(fakeRow); },
            closest: () => null,
            focus: m.focus.list,
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
const click = async (n: ReactTestInstance) => { await act(async () => { n.props.onClick({ stopPropagation: vi.fn(), preventDefault: vi.fn() }); }); };
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
    m.deleteWatchlist.mockReset().mockImplementation(async () => undefined);
    m.emit.mockReset();
    m.focus.title.mockClear();
    m.focus.del.mockClear();
    m.focus.select.mockClear();
    m.focus.list.mockClear();
    resetMultiSelectForTest();
    resetWatchlistSegmentForTest();
    resetWatchPrefsForTest();
    resetPunishedCodesForTest();
    setWatchSparklineEnabled(false);
    m.state = { items: ITEMS, loading: false, structureBusy: false, loadError: false, serverLists: LISTS, activeListId: 'a', ...m.writes };
});
afterEach(async () => {
    for (const k of ORDER_FNS) expect(m[k], `S1：${k}`).not.toHaveBeenCalled();
    // 刪除群組只用 deleteCurrentList（目前群組）；其他清單寫入都不呼叫
    for (const [k, f] of Object.entries(m.writes)) if (k !== 'deleteCurrentList') expect(f, k).not.toHaveBeenCalled();
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

type L = (typeof LISTS)[number];
const setWl = (patch: Record<string, unknown>) => {
    m.state = { ...m.state, ...patch };
    m.listeners.forEach(l => l());
};
const lists = () => m.state.serverLists as L[];
/** 伺服器上已刪除的 id（lib deleteWatchlist）；emit（hook 重新讀取）時才從假 store 移除 */
const gone = new Set<string>();
const useServer = () => {
    gone.clear();
    m.deleteWatchlist.mockImplementation(async (id: string) => { gone.add(id); });
    m.emit.mockImplementation(() => { setWl({ serverLists: lists().filter(l => !gone.has(l.id)) }); });
    // hook 的 deleteCurrentList：刪目前清單，切到剩下的第一個（伺服器順序）；同時反映伺服器上已刪除的其他清單（hook 的 GET）
    m.writes.deleteCurrentList.mockImplementation(async () => {
        gone.add(m.state.activeListId as string);
        const left = lists().filter(l => !gone.has(l.id));
        setWl({ serverLists: left, activeListId: left[0]!.id });
    });
};
const enterSelect = async () => {
    await openSort();
    await click(one('watch-group-select'));
};
const check = (id: string) => inRow(id, 'watch-group-check');
const noRequests = () => {
    expect(m.deleteWatchlist).not.toHaveBeenCalled();
    expect(m.writes.deleteCurrentList).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
};
const settle = async () => {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 20)); });
};

describe('排序群組：選取模式', () => {
    it('「選取」（aria-pressed）：每列勾選鍵、點列切換、握把與 ↑／↓ 隱藏、目前清單標（目前）；取消回到排序', async () => {
        await render();
        await openSort();
        expect(one('watch-group-select').props['aria-pressed']).toBe(false);
        expect(all('watch-group-check')).toHaveLength(0);
        expect(all('watch-group-grip')).toHaveLength(3);
        await click(one('watch-group-select'));
        expect(one('watch-group-select').props['aria-pressed']).toBe(true);
        expect(all('watch-group-grip')).toHaveLength(0);
        expect(all('watch-group-up')).toHaveLength(0);
        expect(all('watch-group-down')).toHaveLength(0);
        expect(check('a').props.role).toBe('checkbox');
        expect(check('a').props['aria-checked']).toBe(false);
        expect(check('a').props['aria-label']).toBe('選取群組「主要」（2 檔）');
        expect(textOf(rowOf('a'))).toBe('主要（目前）2 檔');
        expect(textOf(rowOf('b'))).toBe('觀察1 檔');
        // 點勾選鍵與點列都會切換
        await click(check('b'));
        expect(check('b').props['aria-checked']).toBe(true);
        await act(async () => { rowOf('c').props.onClick(); });
        expect(check('c').props['aria-checked']).toBe(true);
        await act(async () => { rowOf('c').props.onClick(); });
        expect(check('c').props['aria-checked']).toBe(false);
        expect(textOf(one('watch-group-sel-count'))).toBe('已選 1 個');
        expect(textOf(one('watch-group-del'))).toBe('刪除 1 個群組');
        // 取消：回到排序、清空選取
        await click(one('watch-group-sel-cancel'));
        expect(one('watch-group-select').props['aria-pressed']).toBe(false);
        expect(all('watch-group-grip')).toHaveLength(3);
        await click(one('watch-group-select'));
        expect(check('b').props['aria-checked']).toBe(false);
        noRequests();
    });

    it('「刪除 N 個群組」停用並寫原因：沒選、全部選取、清單忙碌、載入失敗', async () => {
        await render();
        await enterSelect();
        expect(one('watch-group-del').props.disabled).toBe(true);
        expect(textOf(one('watch-group-del-reason'))).toBe('請選取要刪除的群組');
        for (const id of ['a', 'b', 'c']) await click(check(id));
        expect(one('watch-group-del').props.disabled).toBe(true);
        expect(textOf(one('watch-group-del-reason'))).toBe('至少要保留一個群組');
        await click(check('c'));
        expect(one('watch-group-del').props.disabled).toBe(false);
        expect(all('watch-group-del-reason')).toHaveLength(0);
        await act(async () => { setWl({ structureBusy: true, loading: true }); });
        expect(one('watch-group-del').props.disabled).toBe(true);
        expect(textOf(one('watch-group-del-reason'))).toBe('自選清單更新中');
        await act(async () => { setWl({ structureBusy: false, loading: false, loadError: true }); });
        expect(one('watch-group-del').props.disabled).toBe(true);
        expect(textOf(one('watch-group-del-reason'))).toBe('自選清單載入失敗');
        noRequests();
    });
});

describe('排序群組：刪除確認與執行', () => {
    it('確認畫面：標題（焦點）、群組與檔數、合計、警語、含目前群組的說明；返回回到刪除鍵；按確定前 0 個請求', async () => {
        useServer();
        await render();
        await enterSelect();
        await click(check('b'));
        await click(check('a'));
        await click(one('watch-group-del'));
        expect(textOf(one('watch-group-del-title'))).toBe('刪除 2 個群組？');
        expect(m.focus.title).toHaveBeenCalledTimes(1);
        expect(one('watch-group-del-list').findAll(n => n.type === 'li').map(textOf)).toEqual(['主要（目前）2 檔', '觀察1 檔']);
        expect(textOf(one('watch-group-del-total'))).toBe('合計 3 檔。自選清單與桌面共用，刪除後桌面也會看不到，無法復原。');
        expect(textOf(one('watch-group-del-active'))).toBe('包含目前的群組，刪除後會切換到其他群組。');
        expect(textOf(one('watch-group-del-ok'))).toBe('確定刪除 2 個群組');
        expect(sheet()!.props.dismissible).toBe(true);
        noRequests();
        // 返回：回到選取模式、焦點回到刪除鍵、選取保留
        await click(one('watch-group-del-back'));
        expect(all('watch-group-del-confirm')).toHaveLength(0);
        expect(m.focus.del).toHaveBeenCalledTimes(1);
        expect(check('a').props['aria-checked']).toBe(true);
        // 不含目前群組時沒有切換說明
        await click(check('a'));
        await click(one('watch-group-del'));
        expect(all('watch-group-del-active')).toHaveLength(0);
        // 關閉面板也不送出
        await act(async () => { sheet()!.props.onClose(); });
        noRequests();
        expect(m.notify).not.toHaveBeenCalled();
    });

    it('確定：非目前群組依序 deleteWatchlist，最後重新讀取一次；一則摘要、回到排序、順序移除刪掉的 id', async () => {
        useServer();
        data.set(LIST_ORDER_KEY, JSON.stringify(['c', 'b', 'a']));
        await render();
        await enterSelect();
        await click(check('c'));
        await click(check('b'));
        await click(one('watch-group-del'));
        await click(one('watch-group-del-ok'));
        await settle();
        expect(m.deleteWatchlist.mock.calls.map(c => c[0])).toEqual(['c', 'b']);
        expect(m.writes.deleteCurrentList).not.toHaveBeenCalled();
        expect(m.emit).toHaveBeenCalledTimes(1);
        expect(m.emit).toHaveBeenCalledWith({ source: 'user' });
        expect(m.notify).toHaveBeenCalledTimes(1);
        expect(m.notify).toHaveBeenCalledWith({ kind: 'ok', title: '已刪除 2 個群組', body: '短線、觀察。' });
        expect(stored()).toEqual(['a']);
        expect(all('watch-group-del-confirm')).toHaveLength(0);
        expect(one('watch-group-select').props['aria-pressed']).toBe(false);
        expect(sheetOrder()).toEqual(['a']);
        expect(sheet()!.props.open).toBe(true);
        // 只剩一個群組：「選取」停用，焦點改到群組列表（不掉到 body）
        expect(m.focus.select).not.toHaveBeenCalled();
        expect(m.focus.list).toHaveBeenCalledTimes(1);
    });

    it('刪除完成後還剩兩個以上群組：焦點回到「選取」鍵', async () => {
        useServer();
        await render();
        await enterSelect();
        await click(check('c'));
        await click(one('watch-group-del'));
        await click(one('watch-group-del-ok'));
        await settle();
        expect(m.deleteWatchlist.mock.calls.map(c => c[0])).toEqual(['c']);
        expect(m.focus.select).toHaveBeenCalledTimes(1);
        expect(m.focus.list).not.toHaveBeenCalled();
    });

    it('hook 重新讀取完成前：剛刪掉的群組不再顯示在面板', async () => {
        useServer();
        m.emit.mockImplementation(() => undefined); // 重新讀取還沒回來：假 store 仍有被刪的群組
        await render();
        await enterSelect();
        await click(check('b'));
        await click(one('watch-group-del'));
        await click(one('watch-group-del-ok'));
        await settle();
        expect(lists().map(l => l.id)).toEqual(['a', 'b', 'c']);
        expect(sheetOrder()).toEqual(['a', 'c']);
    });

    it('含目前群組：其他的先刪，目前群組最後用 hook 的 deleteCurrentList；不再重新讀取；摘要寫明切換到哪個群組', async () => {
        useServer();
        await render();
        await enterSelect();
        await click(check('a'));
        await click(check('c'));
        await click(one('watch-group-del'));
        const calls: string[] = [];
        m.deleteWatchlist.mockImplementation(async (id: string) => { calls.push(`lib ${id}`); gone.add(id); });
        const hook = m.writes.deleteCurrentList.getMockImplementation()!;
        m.writes.deleteCurrentList.mockImplementation(async () => { calls.push('hook current'); await hook(); });
        await click(one('watch-group-del-ok'));
        await settle();
        expect(calls).toEqual(['lib c', 'hook current']);
        expect(m.emit).not.toHaveBeenCalled();
        expect(m.notify).toHaveBeenCalledWith({ kind: 'ok', title: '已刪除 2 個群組', body: '短線、主要。已切換到「觀察」。' });
        expect(m.state.activeListId).toBe('b');
        expect(sheetOrder()).toEqual(['b']);
    });

    it('只刪目前群組：hook 已發「已刪除清單」，不再重複發摘要', async () => {
        useServer();
        await render();
        await enterSelect();
        await click(check('a'));
        await click(one('watch-group-del'));
        await click(one('watch-group-del-ok'));
        await settle();
        expect(m.writes.deleteCurrentList).toHaveBeenCalledTimes(1);
        expect(m.deleteWatchlist).not.toHaveBeenCalled();
        expect(m.notify).not.toHaveBeenCalled();
    });

    it('進行中：顯示進度、面板不可關閉、鍵停用', async () => {
        useServer();
        let release!: () => void;
        m.deleteWatchlist.mockImplementation((id: string) => new Promise<void>(r => { release = () => { gone.add(id); r(); }; }));
        await render();
        await enterSelect();
        await click(check('b'));
        await click(one('watch-group-del'));
        await click(one('watch-group-del-ok'));
        expect(sheet()!.props.dismissible).toBe(false);
        expect(textOf(one('watch-group-del-progress'))).toBe('刪除中 0／1…');
        expect(one('watch-group-del-progress').props.role).toBe('status');
        expect(one('watch-group-del-ok').props.disabled).toBe(true);
        expect(one('watch-group-del-back').props.disabled).toBe(true);
        await act(async () => { release(); });
        await settle();
        expect(sheet()!.props.dismissible).toBe(true);
        expect(m.notify).toHaveBeenCalledWith({ kind: 'ok', title: '已刪除 1 個群組', body: '觀察。' });
    });

    it('刪除失敗：停止（不再刪後面的、不刪目前群組），仍重新讀取一次，通知說明', async () => {
        useServer();
        m.deleteWatchlist.mockImplementation(async (id: string) => { if (id === 'b') throw new Error('HTTP 500'); gone.add(id); });
        await render();
        await enterSelect();
        await click(check('a'));
        await click(check('b'));
        await click(one('watch-group-del'));
        await click(one('watch-group-del-ok'));
        await settle();
        expect(m.deleteWatchlist.mock.calls.map(c => c[0])).toEqual(['b']);
        expect(m.writes.deleteCurrentList).not.toHaveBeenCalled();
        expect(m.emit).toHaveBeenCalledTimes(1);
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '群組刪除未完成', body: '已刪除 0 個，2 個未刪除：「觀察」HTTP 500。' });
    });

    it('S1：選取、勾選、取消、刪除、返回、確定都不開下單或委託面板，lib 送單／改單／刪單 0 次', async () => {
        useServer();
        await render();
        await enterSelect();
        await click(check('b'));
        await act(async () => { rowOf('c').props.onClick(); });
        await click(one('watch-group-del'));
        await click(one('watch-group-del-back'));
        await click(one('watch-group-del'));
        await click(one('watch-group-del-ok'));
        await settle();
        await click(one('watch-group-select'));
        await click(one('watch-group-sel-cancel'));
        await click(one('watch-group-sort-done'));
        expect(m.deleteWatchlist).toHaveBeenCalledTimes(2);
        // afterEach 另驗送單、改單、刪單與面板函式 0 次
    });
});
