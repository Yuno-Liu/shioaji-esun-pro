// 自選頁的延遲載入模組（首屏體積）：
// 迷你走勢
// - 沒有可見列時不載入模組；只有可見列掛載走勢（不可見列是空白佔位）。
// - 載入中、載入失敗：同尺寸的空白佔位（aria-hidden），不顯示錯誤字樣、不影響列與頁面（列仍可點、價格照常）。
// - 失敗後同一列一直可見不重抓；列下次變為可見時重新 import，成功後顯示走勢。
// 搜尋面板
// - 要求開啟前不載入；失敗以底部面板「載入失敗」＋［重試］顯示（可關閉），頁面照常；重試重新 import。
// 編輯模式的列首、列尾鍵與拖曳排序（components/watch-edit-controls.tsx）
// - 非編輯模式不載入；載入中、失敗時列首、列尾是同尺寸空白佔位（沒有握把），失敗在清單上方顯示「載入失敗」＋［重試］，
//   列、表頭、清單工具與「加入股票」照常；離開編輯模式後非編輯模式的列完全不受影響；再次進入編輯模式或按重試會重新 import。
// 注意：retryableLazy 在模組層快取結果，本檔的測試依序執行。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SparkModule = { WatchSparkCell: (props: { contract: { code: string } }) => unknown };
type SearchModule = { SearchSheet: (props: { open: boolean }) => unknown };

const m = vi.hoisted(() => ({
    loads: 0,
    pending: null as null | { resolve: (mod: SparkModule) => void; reject: (error: unknown) => void },
    searchLoads: 0,
    searchPending: null as null | { resolve: (mod: SearchModule) => void; reject: (error: unknown) => void },
    /** 編輯鍵 chunk：三個 retryableLazy（拖曳排序、列首、列尾）各自呼叫一次載入入口（實際的 import() 會共用同一個 chunk） */
    editLoads: 0,
    editPending: [] as { resolve: (mod: unknown) => void; reject: (error: unknown) => void }[],
    wl: {} as Record<string, unknown>,
    navigate: vi.fn(),
    placeStockOrder: vi.fn(),
    placeFuturesOrder: vi.fn(),
}));

vi.mock('../lib/deferred-modules', () => ({
    loadRankingList: () => new Promise(() => undefined),
    loadWatchSparkline: () => {
        m.loads++;
        return new Promise<SparkModule>((resolve, reject) => { m.pending = { resolve, reject }; });
    },
    loadSearchSheet: () => {
        m.searchLoads++;
        return new Promise<SearchModule>((resolve, reject) => { m.searchPending = { resolve, reject }; });
    },
    loadWatchListSheet: () => new Promise(() => undefined),
    loadWatchEditControls: () => {
        m.editLoads++;
        return new Promise((resolve, reject) => { m.editPending.push({ resolve, reject }); });
    },
}));
vi.mock('../../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../../hooks/use-watchlist', () => ({ useWatchlist: () => m.wl }));
vi.mock('../../lib/product-search', () => ({ searchProducts: vi.fn(async () => []) }));
vi.mock('../../lib/stream', () => ({ ensureStream: () => undefined, getQuote: () => undefined, subscribeQuoteStore: () => () => undefined }));
vi.mock('../../lib/quote-ownership', () => ({ retainContractQuotes: () => () => undefined }));
vi.mock('../../lib/shioaji', () => ({
    fetchSnapshots: async () => [],
    placeStockOrder: m.placeStockOrder,
    placeFuturesOrder: m.placeFuturesOrder,
}));
vi.mock('../../lib/api', () => ({ apiGet: async () => ({ code: [] }) }));
// 編輯模式 chunk 以 lib/trade 的 notify 回報多選刪除結果（lib/trade 載入時會碰 window，node 測試環境以假的取代）
vi.mock('../../lib/trade', () => ({ notify: vi.fn() }));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));
vi.mock('../motion/haptics', () => ({ haptic: vi.fn(() => false) }));

import { BottomSheet } from '../components/bottom-sheet';
import { MODULE_LOAD_ERROR_TEXT } from '../components/route-error-boundary';
import { resetWatchPrefsForTest } from '../lib/watch-prefs';
import { WatchlistProvider } from '../lib/watchlist-context';
import * as wlStyles from '../styles/watchlist.css';
import { resetWatchlistSegmentForTest, WatchlistPage } from './watchlist-page';

type IoEntry = { target: object; isIntersecting: boolean };
class FakeIO {
    static last: FakeIO | null = null;
    constructor(public cb: (entries: IoEntry[]) => void) { FakeIO.last = this; }
    observe() { /* 測試手動決定可見度 */ }
    unobserve() { /* 測試手動決定可見度 */ }
    disconnect() { /* 測試手動決定可見度 */ }
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

const contract = (code: string, name: string) => ({ code, name, reference: 100, security_type: 'STK', exchange: 'TSE', target_code: null });

let view: ReactTestRenderer | undefined;
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const row = (code: string) => view!.root.find(n => n.type === 'li' && n.props['data-code'] === code);
const slot = (code: string) => row(code).findAll(n => n.props['data-testid'] === 'watch-spark-blank' && typeof n.type === 'string')[0];
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
const setVisible = (code: string, visible: boolean) => act(async () => { FakeIO.last!.cb([{ target: nodes.get(code)!, isIntersecting: visible }]); });
const render = () => act(async () => {
    view = create(createElement(WatchlistProvider, null, createElement(WatchlistPage)), { createNodeMock: nodeMock });
});

function expectRowsIntact() {
    expect(all('page-watchlist')).toHaveLength(1);
    expect(all('watch-row-button')).toHaveLength(2);
    expect(all('watch-row-ticket')).toHaveLength(2);
    expect(view!.root.findAll(n => n.props.role === 'alert')).toHaveLength(0);
    expect(textOf(view!.root)).not.toContain(MODULE_LOAD_ERROR_TEXT);
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', FakeIO);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    nodes.clear();
    resetWatchlistSegmentForTest();
    resetWatchPrefsForTest();
    m.wl = {
        items: [{ contract: contract('2330', '台積電') }, { contract: contract('2317', '鴻海') }],
        loading: false,
        structureBusy: false,
        loadError: false,
        retryLoad: vi.fn(),
        addSymbol: vi.fn(async () => undefined),
        removeSymbol: vi.fn(async () => undefined),
        reorderSymbol: vi.fn(),
        serverLists: [{ id: 'a', name: '我的自選', contracts: [] }],
        activeListId: 'a',
        setActiveList: vi.fn(),
    };
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('自選列迷你走勢延遲載入', () => {
    it('載入中、失敗都是同尺寸空白佔位（不顯示錯誤、不影響列）；失敗後下次可見時重新 import，成功後顯示走勢', async () => {
        await render();
        // 沒有可見列：不載入
        expect(m.loads).toBe(0);
        expect(slot('2330')!.props['data-spark']).toBe('hidden');

        // 第一列可見：開始載入，佔位為 loading（同一個尺寸 class、aria-hidden）
        await setVisible('2330', true);
        expect(m.loads).toBe(1);
        expect(slot('2330')!.props['data-spark']).toBe('loading');
        expect(slot('2330')!.props.className).toBe(wlStyles.spark);
        expect(slot('2330')!.props['aria-hidden']).toBe('true');
        expect(slot('2317')!.props['data-spark']).toBe('hidden');
        expectRowsIntact();

        // chunk 載入失敗：只有走勢欄變成空白佔位，沒有錯誤字樣、沒有 alert
        await act(async () => { m.pending!.reject(new TypeError('Failed to fetch dynamically imported module: watch-sparkline.js')); });
        await settle();
        expect(slot('2330')!.props['data-spark']).toBe('failed');
        expect(slot('2330')!.props.className).toBe(wlStyles.spark);
        expect(slot('2330')!.props['aria-hidden']).toBe('true');
        expectRowsIntact();
        // 列仍可點（開交易頁）
        await act(async () => { row('2330').find(n => n.props['data-testid'] === 'watch-row-button').props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2330' });

        // 一直可見：不重抓
        await settle();
        expect(m.loads).toBe(1);

        // 離開再回來：重新 import；同時變為可見的其他列共用同一次載入，不重複 import
        await setVisible('2330', false);
        expect(slot('2330')!.props['data-spark']).toBe('hidden');
        await setVisible('2330', true);
        await setVisible('2317', true);
        expect(m.loads).toBe(2);
        expect(slot('2330')!.props['data-spark']).toBe('loading');
        expect(slot('2317')!.props['data-spark']).toBe('loading');

        // 成功：兩列都顯示走勢
        await act(async () => {
            m.pending!.resolve({ WatchSparkCell: ({ contract: c }) => createElement('canvas', { 'data-testid': 'spark-stub', 'data-code': c.code }) });
        });
        await settle();
        expect(all('spark-stub').map(n => n.props['data-code']).sort()).toEqual(['2317', '2330']);
        expect(all('watch-spark-blank')).toHaveLength(0);
        expectRowsIntact();

        // 已載入：再次可見不再 import
        await setVisible('2330', false);
        await setVisible('2330', true);
        expect(m.loads).toBe(2);
        expect(row('2330').findAll(n => n.props['data-testid'] === 'spark-stub')).toHaveLength(1);
        expect(m.placeStockOrder).not.toHaveBeenCalled();
        expect(m.placeFuturesOrder).not.toHaveBeenCalled();
    });
});

describe('自選頁搜尋面板延遲載入', () => {
    const press = (id: string) => act(async () => { all(id)[0]!.props.onClick(); });
    const sheetOpen = (testId: string) => view!.root.findAll(n => n.type === BottomSheet && n.props.testId === testId).map(n => n.props.open as boolean);

    it('要求開啟前不載入；失敗：底部面板「載入失敗」＋重試（可關閉、頁面照常）；重試重新 import，成功後顯示搜尋面板', async () => {
        await render();
        expect(m.searchLoads).toBe(0);
        await press('watch-search');
        expect(m.searchLoads).toBe(1);
        expect(all('search-stub')).toHaveLength(0);
        expectRowsIntact();

        await act(async () => { m.searchPending!.reject(new TypeError('Failed to fetch dynamically imported module: search-sheet.js')); });
        await settle();
        expect(sheetOpen('search-load-error')).toEqual([true]);
        expect(textOf(view!.root)).toContain(MODULE_LOAD_ERROR_TEXT);
        expect(all('watch-row-button')).toHaveLength(2);
        // 關閉錯誤面板
        await act(async () => { view!.root.find(n => n.type === BottomSheet && n.props.testId === 'search-load-error').props.onClose(); });
        expect(sheetOpen('search-load-error')).toEqual([false]);

        // 再按搜尋 → 錯誤面板重開 → 重試：重新 import，成功後顯示搜尋面板
        await press('watch-search');
        expect(sheetOpen('search-load-error')).toEqual([true]);
        await press('search-load-error-body-retry');
        expect(m.searchLoads).toBe(2);
        await act(async () => { m.searchPending!.resolve({ SearchSheet: ({ open }) => createElement('div', { 'data-testid': 'search-stub', 'data-open': String(open) }) }); });
        await settle();
        expect(all('search-stub').map(n => n.props['data-open'])).toEqual(['true']);
        expect(sheetOpen('search-load-error')).toEqual([]);
        expect(m.placeStockOrder).not.toHaveBeenCalled();
    });
});

describe('自選編輯模式的列首、列尾鍵與拖曳排序延遲載入', () => {
    const press = (id: string) => act(async () => { all(id)[0]!.props.onClick(); });
    const settleEdit = (fn: (p: { resolve: (mod: unknown) => void; reject: (error: unknown) => void }) => void) => act(async () => {
        const pending = m.editPending.splice(0);
        for (const p of pending) fn(p);
    });
    const failEdit = () => settleEdit(p => p.reject(new TypeError('Failed to fetch dynamically imported module: watch-edit-controls.js')));
    const editing = () => all('watch-edit')[0]!.props['aria-pressed'] as boolean;

    function expectEditPlaceholders() {
        // 列首、列尾是同尺寸空白佔位（aria-hidden），沒有「−」「⋯」與握把，也沒有快速下單鍵
        const leading = all('watch-edit-leading-blank');
        const trailing = all('watch-edit-trailing-blank');
        expect(leading).toHaveLength(2);
        expect(trailing).toHaveLength(2);
        for (const n of [...leading, ...trailing]) expect(n.props['aria-hidden']).toBe('true');
        expect(leading[0]!.props.className).toBe(wlStyles.rowLeading);
        expect(trailing[0]!.props.className).toBe(`${wlStyles.rowTrailing} ${wlStyles.trailingPair}`);
        expect(all('watch-row-grip')).toHaveLength(0);
        expect(all('watch-row-remove')).toHaveLength(0);
        expect(all('watch-more')).toHaveLength(0);
        expect(all('watch-row-ticket')).toHaveLength(0);
        // 列、表頭、清單工具與「加入股票」照常
        expect(all('watch-row-button')).toHaveLength(2);
        expect(all('watch-list-tools')).toHaveLength(1);
        expect(all('watch-add-symbol')).toHaveLength(1);
        expect(editing()).toBe(true);
    }

    it('非編輯模式不載入；載入中與失敗為空白佔位，失敗顯示「載入失敗」＋重試；離開編輯模式列照常；再次進入與重試都重新 import', async () => {
        await render();
        expect(m.editLoads).toBe(0);
        expectRowsIntact();

        // 進入編輯模式才載入；載入中：佔位、沒有錯誤
        await press('watch-edit');
        expect(m.editLoads).toBeGreaterThan(0);
        const firstLoads = m.editLoads;
        expectEditPlaceholders();
        expect(all('watch-edit-load-error')).toHaveLength(0);

        // 失敗：清單上方「載入失敗」＋［重試］；列內仍是佔位，列可點（開交易頁）
        await failEdit();
        await settle();
        expect(all('watch-edit-load-error')).toHaveLength(1);
        expect(all('watch-edit-load-error')[0]!.props.role).toBe('alert');
        expect(textOf(view!.root)).toContain(MODULE_LOAD_ERROR_TEXT);
        expectEditPlaceholders();
        await act(async () => { row('2330').find(n => n.props['data-testid'] === 'watch-row-button').props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2330' });

        // 離開編輯模式：非編輯模式的列完全照常（快速下單鍵、沒有錯誤），不再 import
        await press('watch-edit');
        expect(editing()).toBe(false);
        expectRowsIntact();
        expect(all('watch-edit-leading-blank')).toHaveLength(0);
        expect(all('watch-edit-trailing-blank')).toHaveLength(0);
        expect(m.editLoads).toBe(firstLoads);

        // 再次進入編輯模式：重新 import；又失敗
        await press('watch-edit');
        expect(m.editLoads).toBe(firstLoads * 2);
        expectEditPlaceholders();
        await failEdit();
        await settle();
        expect(all('watch-edit-load-error')).toHaveLength(1);

        // 按［重試］：重新 import（拖曳排序與列內的列首、列尾都換新），成功後出現「−」「⋯」與握把
        await press('watch-edit-load-error-retry');
        expect(m.editLoads).toBe(firstLoads * 3);
        const real = await import('../components/watch-edit-controls');
        await settleEdit(p => p.resolve(real));
        await settle();
        expect(all('watch-edit-load-error')).toHaveLength(0);
        expect(all('watch-edit-leading-blank')).toHaveLength(0);
        expect(all('watch-edit-trailing-blank')).toHaveLength(0);
        expect(all('watch-row-remove')).toHaveLength(2);
        expect(all('watch-more')).toHaveLength(2);
        const grips = all('watch-row-grip');
        expect(grips).toHaveLength(2);
        for (const g of grips) expect(g.props.disabled).toBe(false);
        expect(grips[0]!.props['aria-label']).toBe('拖曳以調整 2330 台積電 的位置');
        expect(view!.root.findAll(n => n.props.role === 'alert')).toHaveLength(0);

        // 已載入：離開再進入不再 import，鍵同步出現
        await press('watch-edit');
        await press('watch-edit');
        expect(m.editLoads).toBe(firstLoads * 3);
        expect(all('watch-row-grip').map(g => g.props.disabled)).toEqual([false, false]);
        expect(m.placeStockOrder).not.toHaveBeenCalled();
        expect(m.placeFuturesOrder).not.toHaveBeenCalled();
    });
});
