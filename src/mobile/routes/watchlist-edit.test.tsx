// 自選的增減與排序（使用者要求：「自選要增加可增加或減少的功能」「手指拖曳移動方便快速調整位置」）：
// - 清單：「＋」新增清單（名稱面板：空白、重複檢查；失敗保持面板）；編輯模式重新命名（失敗保持面板與編輯模式）、
//   刪除清單（兩段式確認；只剩一個清單不可刪；失敗顯示原因）。
// - 股票：編輯模式列首「−」→ 移除確認面板（沿用移除流程與文字）；清單底部「加入股票」開搜尋面板。
// - 拖曳排序（lib/watch-reorder.ts）：握把 pointer 事件模擬 → 列跟手指、其他列讓位、放手只呼叫一次 reorderSymbol、
//   位置不變不呼叫、取消還原、拖曳中不觸發列點擊與操作面板、減少動態不做讓位動畫、寫入中停用、靠近底緣自動捲動。
// - 編輯模式的列首、列尾鍵與拖曳排序是延遲載入（components/watch-edit-controls.tsx）：beforeAll 先進一次編輯模式讓 lazy
//   載入完成，之後各測試進入編輯模式時同步出現（載入中、失敗見 watchlist-deferred.test.tsx）。
// - S1：以上入口都不呼叫 lib 的送單、改單、刪單函式。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    navigate: vi.fn(),
    removeSymbol: vi.fn(async (_code: string) => undefined),
    reorderSymbol: vi.fn(),
    addSymbol: vi.fn(async () => undefined),
    setActiveList: vi.fn(),
    retryLoad: vi.fn(),
    createList: vi.fn(async (_name: string) => undefined),
    renameCurrentList: vi.fn(async (_name: string) => true),
    deleteCurrentList: vi.fn(async () => undefined),
    searchProducts: vi.fn(async () => []),
    wl: {} as Record<string, unknown>,
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
    notify: vi.fn(),
}));

vi.mock('../../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../../hooks/use-watchlist', () => ({ useWatchlist: () => m.wl }));
vi.mock('../../lib/product-search', () => ({ searchProducts: m.searchProducts }));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));
vi.mock('../../lib/stream', () => ({ ensureStream: () => undefined, getQuote: () => undefined, subscribeQuoteStore: () => () => undefined }));
vi.mock('../../lib/quote-ownership', () => ({ retainContractQuotes: () => () => undefined }));
vi.mock('../../lib/shioaji', () => ({
    fetchScanner: vi.fn(async () => []),
    fetchKbars: vi.fn(async () => ({ datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [], Amount: [] })),
    fetchSnapshots: vi.fn(async () => []),
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
vi.mock('../../lib/api', () => ({ apiGet: vi.fn(async () => ({ code: [] })) }));
vi.mock('../../lib/trade', () => ({ notify: m.notify }));
vi.mock('../motion/haptics', () => ({ haptic: vi.fn(() => false) }));

import { BottomSheet } from '../components/bottom-sheet';
import { checkListName } from '../components/watch-list-sheet';
import { getMobileUi, resetMobileUiForTest } from '../lib/mobile-store';
import { resetPunishedCodesForTest } from '../lib/regulatory-punish';
import { REORDER_CLICK_GUARD_MS, REORDER_KEY_PENDING_MS, REORDER_SHIFT_MS } from '../lib/watch-reorder';
import { resetWatchPrefsForTest, setWatchSparklineEnabled } from '../lib/watch-prefs';
import { WatchlistProvider } from '../lib/watchlist-context';
import * as wlStyles from '../styles/watchlist.css';
import { resetWatchlistSegmentForTest, WatchlistPage } from './watchlist-page';

const ORDER_FNS = [
    'placeStockOrder', 'placeFuturesOrder', 'placeComboOrder', 'cancelOrder', 'cancelOrders',
    'cancelVerifiedOrder', 'cancelComboOrder', 'updateOrderPrice', 'updateOrderQty', 'requestOrderConfirm',
] as const;

// ---- 假 DOM：列（li）有位置與 style，清單（ul）的 children 依目前順序，closest('main') 回傳假的捲動容器 ----
const ROW_TOP = 100;
const ROW_H = 64;
type FakeRow = { code: string; style: Record<string, string>; getAttribute: (n: string) => string | null; getBoundingClientRect: () => { top: number; height: number } };
type FakeMain = { scrollTop: number; getBoundingClientRect: () => { top: number; bottom: number } };
const rows = new Map<string, FakeRow>();
let main: FakeMain | null = null;
const order = () => (m.wl.items as { contract: { code: string } }[]).map(i => i.contract.code);
function nodeMock(el: { type: unknown; props: Record<string, unknown> }) {
    if (el.type === 'li' && typeof el.props['data-code'] === 'string') {
        const code = el.props['data-code'] as string;
        let row = rows.get(code);
        if (!row) {
            row = {
                code,
                style: {},
                getAttribute: n => (n === 'data-code' ? code : null),
                getBoundingClientRect: () => ({ top: ROW_TOP + order().indexOf(code) * ROW_H, height: ROW_H }),
            };
            rows.set(code, row);
        }
        return row;
    }
    if (el.type === 'ul' && el.props['data-testid'] === 'watch-list') {
        return {
            get children() { return order().map(c => rows.get(c)!); },
            closest: (sel: string) => (sel === 'main' ? main : null),
        };
    }
    return {};
}

const contract = (code: string, name: string, reference: number) => ({ code, name, reference, security_type: 'STK', exchange: 'TSE', target_code: null });
const items = [
    { contract: contract('2330', '台積電', 1000) },
    { contract: contract('2317', '鴻海', 200) },
    { contract: contract('2454', '聯發科', 1200) },
];
const LISTS = [{ id: 'a', name: '我的自選', contracts: [] }, { id: 'b', name: '期貨', contracts: [] }];

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
const rowItem = (code: string) => view!.root.find(n => n.type === 'li' && n.props['data-code'] === code);
const inRow = (code: string, id: string) => rowItem(code).findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const sheet = (testId: string) => view!.root.find(n => n.type === BottomSheet && n.props.testId === testId);
/** 延遲載入的面板（搜尋、清單名稱）：等動態 import 結算到面板出現 */
async function settleSheet(testId: string) {
    for (let i = 0; i < 30 && view!.root.findAll(n => n.type === BottomSheet && n.props.testId === testId).length === 0; i++) {
        await act(async () => { await vi.dynamicImportSettled(); });
    }
}
/** 延遲載入的元件：等動態 import 結算到條件成立；以時間為上限，不以迴圈次數決定成敗（CI 較慢時才等得到） */
async function settleUntil(pred: () => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!pred() && Date.now() < deadline) {
        await act(async () => {
            await vi.dynamicImportSettled();
            await new Promise(resolve => setTimeout(resolve, 10));
        });
    }
}
/** 按「＋」或「重新命名」開清單名稱面板 */
async function openListSheet(id: 'watch-list-add' | 'watch-list-rename') {
    await act(async () => { one(id).props.onClick(); });
    await settleSheet('watch-list-sheet');
}
const edit = async () => { await act(async () => { one('watch-edit').props.onClick(); }); };
const btnByText = (text: string) => view!.root.findAll(n => n.type === 'button' && textOf(n) === text);

/** 編輯模式的列首、列尾鍵與拖曳排序先載入完成（retryableLazy 模組層快取）：之後各測試進入編輯模式時同步渲染 */
beforeAll(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setWatchSparklineEnabled(false);
    m.wl = {
        items, loading: false, structureBusy: false, loadError: false, serverLists: LISTS, activeListId: 'a',
        reorderSymbol: m.reorderSymbol, removeSymbol: m.removeSymbol, addSymbol: m.addSymbol, retryLoad: m.retryLoad,
        setActiveList: m.setActiveList, createList: m.createList, renameCurrentList: m.renameCurrentList, deleteCurrentList: m.deleteCurrentList,
    };
    await render();
    await edit();
    await settleUntil(() => all('watch-row-grip').length === 3 && all('watch-row-grip')[0]!.props.disabled === false);
    expect(all('watch-row-grip')).toHaveLength(3);
    expect(all('watch-row-grip')[0]!.props.disabled).toBe(false);
    await act(async () => view!.unmount());
    view = undefined;
    vi.unstubAllGlobals();
}, 30_000);

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    rows.clear();
    main = null;
    for (const k of ORDER_FNS) m[k].mockClear();
    m.navigate.mockClear();
    m.removeSymbol.mockClear();
    m.reorderSymbol.mockClear();
    m.setActiveList.mockClear();
    m.createList.mockReset();
    m.createList.mockResolvedValue(undefined);
    m.renameCurrentList.mockReset();
    m.renameCurrentList.mockResolvedValue(true);
    m.deleteCurrentList.mockReset();
    m.deleteCurrentList.mockResolvedValue(undefined);
    resetWatchlistSegmentForTest();
    resetWatchPrefsForTest();
    resetPunishedCodesForTest();
    resetMobileUiForTest();
    // 走勢與本檔無關：關閉（不掛載走勢欄、不讀 K 線）
    setWatchSparklineEnabled(false);
    m.wl = {
        items,
        loading: false,
        structureBusy: false,
        loadError: false,
        retryLoad: m.retryLoad,
        addSymbol: m.addSymbol,
        removeSymbol: m.removeSymbol,
        reorderSymbol: m.reorderSymbol,
        serverLists: LISTS,
        activeListId: 'a',
        setActiveList: m.setActiveList,
        createList: m.createList,
        renameCurrentList: m.renameCurrentList,
        deleteCurrentList: m.deleteCurrentList,
    };
});
afterEach(async () => {
    for (const k of ORDER_FNS) expect(m[k], `S1：${k}`).not.toHaveBeenCalled();
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('checkListName', () => {
    it('去頭尾空白；空白、與其他清單同名不可；重新命名時與自己同名可以', () => {
        expect(checkListName('  半導體 ', ['我的自選'])).toEqual({ ok: true, name: '半導體' });
        expect(checkListName('   ', ['我的自選'])).toEqual({ ok: false, error: '請輸入清單名稱' });
        expect(checkListName(' 期貨', ['我的自選', '期貨'])).toEqual({ ok: false, error: '已有名為「期貨」的清單' });
        expect(checkListName('我的自選', ['我的自選', '期貨'], '我的自選')).toEqual({ ok: true, name: '我的自選' });
        expect(checkListName('期貨', ['我的自選', '期貨'], '我的自選').ok).toBe(false);
    });
});

describe('新增清單（清單列最後的「＋」）', () => {
    const input = () => one('watch-list-name-input');
    const type = async (v: string) => { await act(async () => { input().props.onChange({ target: { value: v } }); }); };
    const submit = async () => { await act(async () => { view!.root.find(n => n.type === 'form').props.onSubmit({ preventDefault: vi.fn() }); }); };

    it('多個清單時在分頁之後；只有一個清單時（不顯示分頁）也有「＋」', async () => {
        await render();
        expect(one('watch-list-add').props['aria-label']).toBe('新增自選清單');
        await act(async () => view!.unmount());
        m.wl = { ...m.wl, serverLists: [LISTS[0]] };
        await render();
        expect(all('watch-list-tabs')).toHaveLength(0);
        expect(all('watch-list-add')).toHaveLength(1);
    });

    it('面板輸入名稱：空白與重複名稱不送出；成功以去空白的名稱呼叫 createList 並關閉面板', async () => {
        await render();
        // 延遲載入：要求開啟前不掛載
        expect(view!.root.findAll(n => n.type === BottomSheet && n.props.testId === 'watch-list-sheet')).toHaveLength(0);
        await openListSheet('watch-list-add');
        expect(sheet('watch-list-sheet').props.open).toBe(true);
        expect(sheet('watch-list-sheet').props.title).toBe('新增自選清單');
        await submit();
        expect(textOf(one('watch-list-name-error'))).toBe('請輸入清單名稱');
        await type(' 期貨 ');
        expect(all('watch-list-name-error')).toHaveLength(0);
        await submit();
        expect(textOf(one('watch-list-name-error'))).toBe('已有名為「期貨」的清單');
        expect(m.createList).not.toHaveBeenCalled();
        await type('  半導體 ');
        await submit();
        expect(m.createList).toHaveBeenCalledTimes(1);
        expect(m.createList).toHaveBeenCalledWith('半導體');
        expect(sheet('watch-list-sheet').props.open).toBe(false);
    });

    it('建立失敗：顯示原因，面板保持開啟', async () => {
        m.createList.mockRejectedValue(new Error('HTTP 500'));
        await render();
        await openListSheet('watch-list-add');
        await type('半導體');
        await submit();
        expect(textOf(one('watch-list-name-error'))).toBe('新增清單失敗：HTTP 500');
        expect(sheet('watch-list-sheet').props.open).toBe(true);
    });

    it('清單結構更新中停用「＋」與送出', async () => {
        m.wl = { ...m.wl, structureBusy: true };
        await render();
        expect(one('watch-list-add').props.disabled).toBe(true);
    });
});

describe('編輯模式：重新命名與刪除清單', () => {
    const input = () => one('watch-list-name-input');
    const type = async (v: string) => { await act(async () => { input().props.onChange({ target: { value: v } }); }); };
    const submit = async () => { await act(async () => { view!.root.find(n => n.type === 'form').props.onSubmit({ preventDefault: vi.fn() }); }); };
    const editing = () => one('watch-edit').props['aria-pressed'] as boolean;

    it('只在編輯模式顯示清單工具', async () => {
        await render();
        expect(all('watch-list-tools')).toHaveLength(0);
        await edit();
        expect(all('watch-list-rename')).toHaveLength(1);
        expect(all('watch-list-delete')).toHaveLength(1);
    });

    it('重新命名：預填目前名稱；重複名稱不送出；renameCurrentList 回傳 false 時保持面板與編輯模式；成功關閉', async () => {
        m.renameCurrentList.mockResolvedValueOnce(false);
        await render();
        await edit();
        await openListSheet('watch-list-rename');
        expect(sheet('watch-list-sheet').props.title).toBe('重新命名清單');
        expect(input().props.value).toBe('我的自選');
        await type('期貨');
        await submit();
        expect(textOf(one('watch-list-name-error'))).toBe('已有名為「期貨」的清單');
        expect(m.renameCurrentList).not.toHaveBeenCalled();
        await type(' 長線 ');
        await submit();
        expect(m.renameCurrentList).toHaveBeenCalledWith('長線');
        expect(textOf(one('watch-list-name-error'))).toBe('重新命名失敗，請稍後再試');
        expect(sheet('watch-list-sheet').props.open).toBe(true);
        expect(editing()).toBe(true);
        await submit();
        expect(m.renameCurrentList).toHaveBeenCalledTimes(2);
        expect(sheet('watch-list-sheet').props.open).toBe(false);
        expect(editing()).toBe(true);
    });

    it('名稱沒變：不呼叫 renameCurrentList，直接關閉', async () => {
        await render();
        await edit();
        await openListSheet('watch-list-rename');
        await submit();
        expect(m.renameCurrentList).not.toHaveBeenCalled();
        expect(sheet('watch-list-sheet').props.open).toBe(false);
    });

    it('刪除清單：兩段式確認，第二次才呼叫 deleteCurrentList（一次）', async () => {
        await render();
        await edit();
        expect(textOf(one('watch-list-delete'))).toBe('刪除清單');
        await act(async () => { one('watch-list-delete').props.onClick(); });
        expect(m.deleteCurrentList).not.toHaveBeenCalled();
        expect(textOf(one('watch-list-delete'))).toBe('確定刪除「我的自選」');
        expect(textOf(one('watch-edit-hint'))).toContain('刪除後桌面也會看不到');
        await act(async () => { one('watch-list-delete').props.onClick(); });
        expect(m.deleteCurrentList).toHaveBeenCalledTimes(1);
    });

    it('刪除清單鍵的無障礙名稱包含可見文字（WCAG 2.5.3）：一般、確認、刪除中', async () => {
        let finish!: () => void;
        m.deleteCurrentList.mockImplementation(() => new Promise<undefined>(r => { finish = () => r(undefined); }));
        await render();
        await edit();
        const check = () => {
            const b = one('watch-list-delete');
            expect(String(b.props['aria-label'])).toContain(textOf(b));
            return b;
        };
        expect(check().props['aria-label']).toBe('刪除清單「我的自選」');
        await act(async () => { one('watch-list-delete').props.onClick(); });
        expect(textOf(check())).toBe('確定刪除「我的自選」');
        expect(check().props['aria-label']).toBe('確定刪除「我的自選」清單');
        await act(async () => { one('watch-list-delete').props.onClick(); });
        expect(textOf(check())).toBe('刪除中…');
        await act(async () => { finish(); });
    });

    it('刪除失敗：顯示原因（role=alert），保持編輯模式', async () => {
        m.deleteCurrentList.mockRejectedValue(new Error('HTTP 500'));
        await render();
        await edit();
        await act(async () => { one('watch-list-delete').props.onClick(); });
        await act(async () => { one('watch-list-delete').props.onClick(); });
        expect(textOf(one('watch-list-error'))).toBe('刪除清單失敗：HTTP 500');
        expect(one('watch-list-error').props.role).toBe('alert');
        expect(editing()).toBe(true);
    });

    it('只剩一個清單：刪除鍵停用並說明，點了也不呼叫', async () => {
        m.wl = { ...m.wl, serverLists: [LISTS[0]] };
        await render();
        await edit();
        expect(one('watch-list-delete').props.disabled).toBe(true);
        expect(textOf(one('watch-edit-hint'))).toContain('只剩一個清單時不能刪除');
        await act(async () => { one('watch-list-delete').props.onClick(); });
        await act(async () => { one('watch-list-delete').props.onClick(); });
        expect(m.deleteCurrentList).not.toHaveBeenCalled();
    });

    it('空的清單也能進入編輯模式（重新命名、刪除、加入股票）', async () => {
        m.wl = { ...m.wl, items: [] };
        await render();
        expect(all('watch-empty')).toHaveLength(1);
        expect(all('watch-metric-toggle')).toHaveLength(0);
        await edit();
        expect(all('watch-list-rename')).toHaveLength(1);
        expect(all('watch-list-delete')).toHaveLength(1);
        expect(all('watch-add-symbol')).toHaveLength(1);
        expect(all('watch-empty')).toHaveLength(0);
        // 改名或刪除進行中（hook 的 loading 也為 true）：不收起編輯模式、不顯示載入骨架
        m.wl = { ...m.wl, loading: true, structureBusy: true };
        await act(async () => { view!.update(createElement(WatchlistProvider, null, createElement(WatchlistPage))); });
        expect(one('watch-edit').props['aria-pressed']).toBe(true);
        expect(all('watch-list-rename')[0]!.props.disabled).toBe(true);
        expect(all('watch-loading')).toHaveLength(0);
    });
});

describe('編輯模式：股票的移除與加入', () => {
    it('每列列首「−」（44px IconButton，名稱含代碼與名稱）→ 移除確認面板：只有移除，直接進入確認，按下才 removeSymbol', async () => {
        await render();
        expect(all('watch-row-remove')).toHaveLength(0);
        await edit();
        expect(all('watch-row-remove')).toHaveLength(3);
        const remove = inRow('2317', 'watch-row-remove')[0]!;
        expect(remove.props['aria-label']).toBe('從自選移除 2317 鴻海');
        expect(remove.parent!.parent!.props.className).toBe(wlStyles.rowLeading);
        // 不在列按鈕內
        expect(inRow('2317', 'watch-row-button')[0]!.findAll(n => n.props['data-testid'] === 'watch-row-remove')).toHaveLength(0);
        await act(async () => { remove.props.onClick(); });
        expect(sheet('watch-actions').props.open).toBe(true);
        expect(view!.root.findAll(n => n.props.testId === 'watch-action-buy')).toHaveLength(0);
        expect(btnByText('上移')).toHaveLength(0);
        expect(textOf(one('watch-remove'))).toBe('確定從自選移除 2317');
        expect(m.removeSymbol).not.toHaveBeenCalled();
        await act(async () => { one('watch-remove').props.onClick(); });
        expect(m.removeSymbol).toHaveBeenCalledTimes(1);
        expect(m.removeSymbol).toHaveBeenCalledWith('2317');
        expect(m.navigate).not.toHaveBeenCalled();
    });

    it('非編輯模式沿用長按操作面板（移除仍要按兩次）', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await render();
        await act(async () => { inRow('2330', 'watch-row-button')[0]!.props.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 10, clientY: 10 }); });
        await act(async () => { vi.advanceTimersByTime(600); });
        expect(sheet('watch-actions').props.open).toBe(true);
        expect(btnByText('上移')).toHaveLength(1);
        expect(textOf(one('watch-remove'))).toBe('從自選移除');
    });

    it('清單底部「加入股票」開既有搜尋面板', async () => {
        await render();
        expect(all('watch-add-symbol')).toHaveLength(0);
        await edit();
        await act(async () => { one('watch-add-symbol').props.onClick(); });
        await settleSheet('search-sheet');
        expect(sheet('search-sheet').props.open).toBe(true);
    });

    it('編輯模式列尾是「⋯」與握把（不顯示快速下單鍵與走勢）', async () => {
        setWatchSparklineEnabled(true);
        await render();
        await edit();
        expect(inRow('2330', 'watch-row-ticket')).toHaveLength(0);
        expect(inRow('2330', 'watch-more')).toHaveLength(1);
        expect(inRow('2330', 'watch-row-grip')).toHaveLength(1);
        expect(inRow('2330', 'watch-spark-blank')).toHaveLength(0);
        expect(inRow('2330', 'watch-row-button')[0]!.props.className).toContain(wlStyles.rowNoSpark);
        expect(getMobileUi().ticket).toBeNull();
    });
});

// ---------------------------------------------------------------------------

describe('拖曳排序（握把）', () => {
    const grip = (code: string) => inRow(code, 'watch-row-grip')[0]!;
    const ev = (clientY: number, over: Record<string, unknown> = {}) => ({
        pointerId: 1, pointerType: 'touch', button: 0, clientX: 300, clientY,
        preventDefault: vi.fn(), currentTarget: { setPointerCapture: vi.fn() }, ...over,
    });
    const down = async (code: string, y: number) => { await act(async () => { grip(code).props.onPointerDown(ev(y)); }); };
    const move = async (code: string, y: number) => { await act(async () => { grip(code).props.onPointerMove(ev(y)); }); };
    const up = async (code: string, y: number) => { await act(async () => { grip(code).props.onPointerUp(ev(y)); }); };
    const transform = (code: string) => rows.get(code)!.style.transform ?? '';
    // 列中心：2330＝132、2317＝196、2454＝260

    it('只有編輯模式有握把：44px、touch-action none（樣式）、無障礙名稱說明用途；不在列按鈕內', async () => {
        await render();
        expect(all('watch-row-grip')).toHaveLength(0);
        await edit();
        const g = grip('2330');
        expect(g.type).toBe('button');
        expect(g.props['aria-label']).toBe('拖曳以調整 2330 台積電 的位置');
        expect(g.props.className).toContain(wlStyles.grip);
        expect(inRow('2330', 'watch-row-button')[0]!.findAll(n => n.props['data-testid'] === 'watch-row-grip')).toHaveLength(0);
    });

    it('往下拖：列跟著手指（transform），越過的列即時上移讓位；放手只呼叫一次 reorderSymbol', async () => {
        await render();
        await edit();
        await down('2330', 132);
        expect(rowItem('2330').props['data-dragging']).toBe('true');
        expect(rowItem('2330').props.className).toContain(wlStyles.rowDragging);
        await move('2330', 182);
        expect(transform('2330')).toBe('translateY(50px)');
        expect(transform('2317')).toBe(''); // 還沒越過 2317 的中線
        await move('2330', 232);
        expect(transform('2330')).toBe('translateY(100px)');
        expect(transform('2317')).toBe(`translateY(${-ROW_H}px)`);
        expect(transform('2454')).toBe('');
        await move('2330', 300);
        expect(transform('2454')).toBe(`translateY(${-ROW_H}px)`);
        expect(m.reorderSymbol).not.toHaveBeenCalled();
        await up('2330', 300);
        expect(m.reorderSymbol).toHaveBeenCalledTimes(1);
        expect(m.reorderSymbol).toHaveBeenCalledWith('2330', '2454');
        // 放手後 transform 清除（新順序由 React 重新排列）
        expect(['2330', '2317', '2454'].map(transform)).toEqual(['', '', '']);
        expect(rowItem('2330').props['data-dragging']).toBeUndefined();
    });

    it('往上拖：越過的列下移讓位；放手移到目標位置', async () => {
        await render();
        await edit();
        await down('2454', 260);
        await move('2454', 180);
        expect(transform('2317')).toBe(`translateY(${ROW_H}px)`);
        expect(transform('2330')).toBe('');
        await move('2454', 120);
        expect(transform('2330')).toBe(`translateY(${ROW_H}px)`);
        await up('2454', 120);
        expect(m.reorderSymbol).toHaveBeenCalledTimes(1);
        expect(m.reorderSymbol).toHaveBeenCalledWith('2454', '2330');
    });

    it('位置沒變（拖出去又拖回來、或只點一下）不呼叫 reorderSymbol', async () => {
        await render();
        await edit();
        await down('2317', 196);
        await move('2317', 300);
        await move('2317', 200);
        expect(transform('2454')).toBe('');
        await up('2317', 200);
        await down('2317', 196);
        await up('2317', 196);
        expect(m.reorderSymbol).not.toHaveBeenCalled();
    });

    it('pointercancel（或失去 pointer capture）取消並還原，不呼叫 reorderSymbol', async () => {
        await render();
        await edit();
        await down('2330', 132);
        await move('2330', 300);
        await act(async () => { grip('2330').props.onPointerCancel(ev(300)); });
        expect(['2330', '2317', '2454'].map(transform)).toEqual(['', '', '']);
        expect(rowItem('2330').props['data-dragging']).toBeUndefined();
        await down('2330', 132);
        await move('2330', 300);
        await act(async () => { grip('2330').props.onLostPointerCapture(ev(300)); });
        expect(transform('2330')).toBe('');
        await up('2330', 300);
        expect(m.reorderSymbol).not.toHaveBeenCalled();
    });

    it('拖曳中與剛放手時不觸發列點擊（開交易頁）與操作面板；之後恢復', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-06T10:00:00+08:00'));
        await render();
        await edit();
        await down('2330', 132);
        await move('2330', 232);
        await act(async () => { inRow('2317', 'watch-row-button')[0]!.props.onClick(); });
        await act(async () => { inRow('2317', 'watch-more')[0]!.props.onClick(); });
        await act(async () => { inRow('2317', 'watch-row-remove')[0]!.props.onClick(); });
        expect(m.navigate).not.toHaveBeenCalled();
        expect(sheet('watch-actions').props.open).toBe(false);
        await up('2330', 232);
        await act(async () => { inRow('2330', 'watch-row-button')[0]!.props.onClick(); });
        expect(m.navigate).not.toHaveBeenCalled();
        vi.setSystemTime(Date.now() + REORDER_CLICK_GUARD_MS + 1);
        await act(async () => { inRow('2330', 'watch-row-button')[0]!.props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2330' });
        expect(getMobileUi().ticket).toBeNull();
    });

    it('讓位有 transform 動畫；減少動態時不做讓位動畫', async () => {
        await render();
        await edit();
        await down('2330', 132);
        await move('2330', 232);
        expect(rows.get('2317')!.style.transition).toBe(`transform ${REORDER_SHIFT_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`);
        await up('2330', 132);
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('prefers-reduced-motion'), addEventListener: () => undefined, removeEventListener: () => undefined }));
        await down('2330', 132);
        await move('2330', 232);
        expect(transform('2317')).toBe(`translateY(${-ROW_H}px)`);
        expect(rows.get('2317')!.style.transition).toBe('none');
        await up('2330', 132);
    });

    it('寫入中（清單結構更新或載入中）握把停用，按下也不開始拖曳', async () => {
        m.wl = { ...m.wl, structureBusy: true };
        await render();
        await edit();
        expect(grip('2330').props.disabled).toBe(true);
        await down('2330', 132);
        await move('2330', 300);
        expect(transform('2330')).toBe('');
        await up('2330', 300);
        expect(m.reorderSymbol).not.toHaveBeenCalled();
    });

    it('靠近可視底緣自動捲動（底部扣掉 main 的 padding-bottom＝分頁列＋配件槽），列的位移加上捲動量', async () => {
        const frames: (() => void)[] = [];
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length; });
        vi.stubGlobal('cancelAnimationFrame', () => undefined);
        vi.stubGlobal('getComputedStyle', () => ({ paddingBottom: '100px' }));
        main = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 600 }) };
        await render();
        await edit();
        await down('2330', 132);
        // 可視底緣＝600 − 100＝500；捲動區從 444 開始
        await move('2330', 430);
        expect(frames).toHaveLength(0);
        await move('2330', 472);
        expect(frames).toHaveLength(1);
        await act(async () => { frames.shift()!(); });
        expect(main.scrollTop).toBeGreaterThan(0);
        expect(transform('2330')).toBe(`translateY(${472 - 132 + main.scrollTop}px)`);
        expect(frames).toHaveLength(1); // 仍在捲動區：下一幀繼續
        await up('2330', 472);
        expect(m.reorderSymbol).toHaveBeenCalledTimes(1);
    });

    it('鍵盤（握把上按 ↑／↓）一次移一格', async () => {
        await render();
        await edit();
        await act(async () => { grip('2317').props.onKeyDown({ key: 'ArrowDown', preventDefault: vi.fn() }); });
        expect(m.reorderSymbol).toHaveBeenCalledWith('2317', '2454');
        await act(async () => { grip('2330').props.onKeyDown({ key: 'ArrowUp', preventDefault: vi.fn() }); });
        expect(m.reorderSymbol).toHaveBeenCalledTimes(1);
    });

    describe('鍵盤：自動重複、寫入中、焦點', () => {
        /** reorderSymbol 替身：真的改順序並重繪（同 hook 的樂觀更新） */
        const applyMoves = () => {
            m.reorderSymbol.mockImplementation((from: string, to: string) => {
                const list = [...(m.wl.items as typeof items)];
                const i = list.findIndex(x => x.contract.code === from);
                const j = list.findIndex(x => x.contract.code === to);
                const [moved] = list.splice(i, 1);
                list.splice(j, 0, moved!);
                m.wl = { ...m.wl, items: list };
            });
        };
        const rerender = () => act(async () => { view!.update(createElement(WatchlistProvider, null, createElement(WatchlistPage))); });
        const key = (k: string, el: { focus: () => void }, over: Record<string, unknown> = {}) => ({ key: k, preventDefault: vi.fn(), currentTarget: el, ...over });

        it('按住不放的自動重複（event.repeat）忽略；仍 preventDefault（不捲動頁面）', async () => {
            await render();
            await edit();
            const e = key('ArrowDown', { focus: vi.fn() }, { repeat: true });
            await act(async () => { grip('2330').props.onKeyDown(e); });
            expect(m.reorderSymbol).not.toHaveBeenCalled();
            expect(e.preventDefault).toHaveBeenCalled();
        });

        it('寫入中（結構更新、載入中）忽略方向鍵', async () => {
            for (const over of [{ structureBusy: true }, { loading: true }]) {
                m.wl = { ...m.wl, ...over };
                await render();
                await edit();
                await act(async () => { grip('2330').props.onKeyDown(key('ArrowDown', { focus: vi.fn() })); });
                expect(m.reorderSymbol).not.toHaveBeenCalled();
                await act(async () => view!.unmount());
                m.wl = { ...m.wl, structureBusy: false, loading: false };
            }
        });

        it('↓／↑ 移動後焦點回到被移動那列的握把，可以連續移動', async () => {
            applyMoves();
            await render();
            await edit();
            const el = { focus: vi.fn() };
            await act(async () => { grip('2330').props.onKeyDown(key('ArrowDown', el)); });
            expect(m.reorderSymbol).toHaveBeenLastCalledWith('2330', '2317');
            await rerender();
            expect(order()).toEqual(['2317', '2330', '2454']);
            expect(el.focus).toHaveBeenCalledTimes(1);
            await act(async () => { grip('2330').props.onKeyDown(key('ArrowDown', el)); });
            expect(m.reorderSymbol).toHaveBeenLastCalledWith('2330', '2454');
            await rerender();
            expect(order()).toEqual(['2317', '2454', '2330']);
            expect(el.focus).toHaveBeenCalledTimes(2);
            await act(async () => { grip('2330').props.onKeyDown(key('ArrowUp', el)); });
            await rerender();
            expect(order()).toEqual(['2317', '2330', '2454']);
            expect(el.focus).toHaveBeenCalledTimes(3);
            expect(m.reorderSymbol).toHaveBeenCalledTimes(3);
        });

        it('上一次移動尚未反映到清單時忽略方向鍵（不以舊順序計算）；逾時後恢復', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-11-06T10:00:00+08:00'));
            await render();
            await edit();
            const el = { focus: vi.fn() };
            await act(async () => { grip('2330').props.onKeyDown(key('ArrowDown', el)); });
            await act(async () => { grip('2330').props.onKeyDown(key('ArrowDown', el)); });
            expect(m.reorderSymbol).toHaveBeenCalledTimes(1);
            // 移動沒被套用（例如清單不可寫入）：逾時後不會永遠擋住
            vi.setSystemTime(Date.now() + REORDER_KEY_PENDING_MS);
            await act(async () => { grip('2330').props.onKeyDown(key('ArrowDown', el)); });
            expect(m.reorderSymbol).toHaveBeenCalledTimes(2);
            expect(el.focus).not.toHaveBeenCalled();
        });
    });

    it('清單載入失敗（loadError）時握把停用，拖曳與方向鍵都不移動', async () => {
        m.wl = { ...m.wl, loadError: true };
        await render();
        // 清單仍顯示（重新整理失敗、保留畫面）：可進入編輯模式，但握把停用
        await edit();
        const grips = all('watch-row-grip');
        expect(grips).toHaveLength(3);
        for (const g of grips) expect(g.props.disabled).toBe(true);
        await down('2330', 132);
        await move('2330', 300);
        await up('2330', 300);
        await act(async () => { grip('2330').props.onKeyDown({ key: 'ArrowDown', preventDefault: vi.fn(), currentTarget: { focus: vi.fn() } }); });
        expect(m.reorderSymbol).not.toHaveBeenCalled();
    });

    it('canReplaceList 為 false（hook 若回傳）時握把停用', async () => {
        m.wl = { ...m.wl, canReplaceList: false };
        await render();
        await edit();
        expect(grip('2330').props.disabled).toBe(true);
        await act(async () => { grip('2330').props.onKeyDown({ key: 'ArrowDown', preventDefault: vi.fn(), currentTarget: { focus: vi.fn() } }); });
        await down('2330', 132);
        await move('2330', 300);
        await up('2330', 300);
        expect(m.reorderSymbol).not.toHaveBeenCalled();
    });

    it('操作面板仍保留上移、下移、移到最上（不便拖曳時使用）', async () => {
        await render();
        await edit();
        await act(async () => { inRow('2454', 'watch-more')[0]!.props.onClick(); });
        expect(btnByText('移到最上')).toHaveLength(1);
        await act(async () => { btnByText('移到最上')[0]!.props.onClick(); });
        expect(m.reorderSymbol).toHaveBeenCalledWith('2454', '2330');
    });
});
