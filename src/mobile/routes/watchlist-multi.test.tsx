// 自選編輯模式的多選刪除（components/watch-edit-controls.tsx 的 WatchEditTools；延遲載入的編輯 chunk）：
// - 「多選」切換（aria-pressed）→ 列首勾選圈（role=checkbox、aria-checked、「選取 2330 台積電」）、全選三態、底部「已選 N 檔」「取消」「刪除 N 檔」；
//   點列＝切換勾選（不開交易頁、不開操作面板）；握把與「⋯」停用；關閉多選後「−」與握把恢復。
// - 「刪除 N 檔」→ 確認面板列出商品；確定後依清單順序逐檔 await removeSymbol，顯示進度；結束後結束多選並 notify 摘要。
// - 停止條件：清單忙碌、出錯、換清單；開始前忙碌時停用。清單裡消失的代碼自動移出選取。
// - S1：每個新按鈕都點過，送單、改單、刪單、開下單面板與委託操作面板都不會被呼叫。
// 這裡的 useWatchlist 是可更新的假 store（removeSymbol 會真的把列移掉並重繪）；實際請求數見 components/watch-edit-controls.test.tsx。
import { createElement, useSyncExternalStore } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Item = { contract: { code: string; name: string; reference: number; security_type: string; exchange: string; target_code: null } };
const m = vi.hoisted(() => ({
    navigate: vi.fn(),
    notify: vi.fn(),
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    state: {} as Record<string, unknown>,
    listeners: new Set<() => void>(),
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
import { resetMultiSelectForTest } from '../components/watch-edit-controls';
import { resetPunishedCodesForTest } from '../lib/regulatory-punish';
import { resetWatchPrefsForTest, setWatchSparklineEnabled } from '../lib/watch-prefs';
import { WatchlistProvider } from '../lib/watchlist-context';
import { resetWatchlistSegmentForTest, WatchlistPage } from './watchlist-page';

const ORDER_FNS = [
    'placeStockOrder', 'placeFuturesOrder', 'placeComboOrder', 'cancelOrder', 'cancelOrders',
    'cancelVerifiedOrder', 'cancelComboOrder', 'updateOrderPrice', 'updateOrderQty', 'requestOrderConfirm',
    'openTicket', 'openOrderAction',
] as const;

const contract = (code: string, name: string) => ({ code, name, reference: 100, security_type: 'STK', exchange: 'TSE', target_code: null });
const ITEMS: Item[] = [
    { contract: contract('2330', '台積電') },
    { contract: contract('2317', '鴻海') },
    { contract: contract('2454', '聯發科') },
];
const LISTS = [{ id: 'a', name: '主要', contracts: [] }, { id: 'b', name: '觀察', contracts: [] }];

const setWl = (patch: Record<string, unknown>) => {
    m.state = { ...m.state, ...patch };
    m.listeners.forEach(l => l());
};
const items = () => m.state.items as Item[];
/** 假的 removeSymbol：記錄呼叫、把列移掉（hook 成功後的效果） */
const removeSymbol = vi.fn(async (code: string) => {
    setWl({ items: items().filter(i => i.contract.code !== code) });
});

let view: ReactTestRenderer | undefined;
async function render() {
    await act(async () => { view = create(createElement(WatchlistProvider, null, createElement(WatchlistPage)), { createNodeMock: () => ({}) }); });
}
const all = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => {
    const found = all(id);
    if (found.length !== 1) throw new Error(`${id}: ${found.length}`);
    return found[0]!;
};
const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const rowItem = (code: string) => view!.root.find(n => n.type === 'li' && n.props['data-code'] === code);
const inRow = (code: string, id: string) => rowItem(code).findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const sheet = (testId: string) => view!.root.findAll(n => n.type === BottomSheet && n.props.testId === testId)[0];
const click = async (n: ReactTestInstance) => { await act(async () => { n.props.onClick(); }); };
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
    await settleUntil(() => all('watch-multi').length === 1 && all('watch-row-grip').length === items().length);
};
const enterMulti = async () => {
    await enterEdit();
    await click(one('watch-multi'));
};
const checks = () => all('watch-row-select');

beforeAll(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    for (const k of ORDER_FNS) m[k].mockClear();
    m.navigate.mockClear();
    m.notify.mockClear();
    removeSymbol.mockClear();
    removeSymbol.mockImplementation(async (code: string) => { setWl({ items: items().filter(i => i.contract.code !== code) }); });
    resetMultiSelectForTest();
    resetWatchlistSegmentForTest();
    resetWatchPrefsForTest();
    resetPunishedCodesForTest();
    setWatchSparklineEnabled(false);
    m.state = {
        items: ITEMS,
        loading: false,
        structureBusy: false,
        loadError: false,
        retryLoad: vi.fn(),
        addSymbol: vi.fn(),
        removeSymbol,
        reorderSymbol: vi.fn(),
        serverLists: LISTS,
        activeListId: 'a',
        setActiveList: vi.fn(),
        createList: vi.fn(),
        renameCurrentList: vi.fn(),
        deleteCurrentList: vi.fn(),
    };
});
afterEach(async () => {
    for (const k of ORDER_FNS) expect(m[k], `S1：${k}`).not.toHaveBeenCalled();
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('多選模式的進出與勾選', () => {
    it('「多選」切換（aria-pressed）：列首「−」換成勾選圈，握把與「⋯」停用，出現全選與底部選取列；取消後恢復', async () => {
        await render();
        await enterEdit();
        const toggle = one('watch-multi');
        expect(toggle.props['aria-pressed']).toBe(false);
        expect(textOf(toggle)).toBe('多選');
        expect(all('watch-row-remove')).toHaveLength(3);
        expect(all('watch-select-all')).toHaveLength(0);
        expect(all('watch-multi-bar')).toHaveLength(0);
        expect(all('watch-row-grip').every(g => g.props.disabled === false)).toBe(true);

        expect(textOf(one('watch-edit-hint'))).toContain('按住右側握把拖曳');
        await click(toggle);
        expect(one('watch-multi').props['aria-pressed']).toBe(true);
        // 說明文字改為多選的說明
        expect(textOf(one('watch-edit-hint'))).toBe('勾選要移除的商品（點一列也可以勾選），再按下方「刪除」。');
        expect(all('watch-row-remove')).toHaveLength(0);
        expect(checks()).toHaveLength(3);
        const first = inRow('2330', 'watch-row-select')[0]!;
        expect(first.props.role).toBe('checkbox');
        expect(first.props['aria-checked']).toBe(false);
        expect(first.props['aria-label']).toBe('選取 2330 台積電');
        // 拖曳排序與「⋯」停用
        expect(all('watch-row-grip').every(g => g.props.disabled === true)).toBe(true);
        expect(all('watch-more').every(b => b.props.disabled === true)).toBe(true);
        // 全選（三態）與底部選取列
        expect(one('watch-select-all').props.role).toBe('checkbox');
        expect(one('watch-select-all').props['aria-checked']).toBe(false);
        expect(textOf(one('watch-multi-count'))).toBe('已選 0 檔');
        expect(textOf(one('watch-multi-delete'))).toBe('刪除 0 檔');
        expect(one('watch-multi-delete').props.disabled).toBe(true);

        // 取消：結束多選，「−」與握把恢復
        await click(one('watch-multi-cancel'));
        expect(one('watch-multi').props['aria-pressed']).toBe(false);
        expect(all('watch-row-remove')).toHaveLength(3);
        expect(all('watch-multi-bar')).toHaveLength(0);
        expect(all('watch-row-grip').every(g => g.props.disabled === false)).toBe(true);
        expect(removeSymbol).not.toHaveBeenCalled();
    });

    it('勾選、全選三態（mixed）、點列切換勾選（不開交易頁、不開操作面板）', async () => {
        await render();
        await enterMulti();
        await click(inRow('2317', 'watch-row-select')[0]!);
        expect(inRow('2317', 'watch-row-select')[0]!.props['aria-checked']).toBe(true);
        expect(one('watch-select-all').props['aria-checked']).toBe('mixed');
        expect(textOf(one('watch-multi-count'))).toBe('已選 1 檔');
        expect(textOf(one('watch-multi-delete'))).toBe('刪除 1 檔');
        expect(one('watch-multi-delete').props.disabled).toBe(false);

        // 點列（列按鈕）＝切換勾選
        await click(inRow('2330', 'watch-row-button')[0]!);
        expect(inRow('2330', 'watch-row-select')[0]!.props['aria-checked']).toBe(true);
        expect(m.navigate).not.toHaveBeenCalled();

        await click(one('watch-select-all'));
        expect(one('watch-select-all').props['aria-checked']).toBe(true);
        expect(checks().every(c => c.props['aria-checked'] === true)).toBe(true);
        await click(one('watch-select-all'));
        expect(one('watch-select-all').props['aria-checked']).toBe(false);
        expect(checks().every(c => c.props['aria-checked'] === false)).toBe(true);

        // 長按（contextmenu）不開操作面板
        await act(async () => { inRow('2454', 'watch-row-button')[0]!.props.onContextMenu({ preventDefault: vi.fn() }); });
        expect(sheet('watch-actions')?.props.open ?? false).toBe(false);

        // 關閉多選後點列照常開交易頁
        await click(one('watch-multi'));
        await click(inRow('2330', 'watch-row-button')[0]!);
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2330' });
    });

    it('清單裡消失的代碼移出選取；換清單時清空；離開編輯模式結束多選', async () => {
        await render();
        await enterMulti();
        await click(one('watch-select-all'));
        expect(textOf(one('watch-multi-count'))).toBe('已選 3 檔');
        await act(async () => { setWl({ items: ITEMS.filter(i => i.contract.code !== '2317') }); });
        expect(textOf(one('watch-multi-count'))).toBe('已選 2 檔');
        await act(async () => { setWl({ activeListId: 'b' }); });
        expect(textOf(one('watch-multi-count'))).toBe('已選 0 檔');
        await click(one('watch-edit'));
        expect(all('watch-multi-bar')).toHaveLength(0);
        await click(one('watch-edit'));
        await settleUntil(() => all('watch-multi').length === 1);
        expect(one('watch-multi').props['aria-pressed']).toBe(false);
        expect(checks()).toHaveLength(0);
    });
});

describe('刪除 N 檔', () => {
    it('確認面板列出要移除的商品；取消不送出；確定後依清單順序逐檔移除、結束多選並通知', async () => {
        await render();
        await enterMulti();
        await click(inRow('2454', 'watch-row-select')[0]!);
        await click(inRow('2330', 'watch-row-select')[0]!);
        await click(one('watch-multi-delete'));
        expect(sheet('watch-multi-confirm')!.props.open).toBe(true);
        expect(sheet('watch-multi-confirm')!.props.title).toBe('刪除 2 檔自選');
        expect(one('watch-multi-confirm-list').findAll(n => n.type === 'li').map(textOf)).toEqual(['2330 台積電', '2454 聯發科']);
        await click(one('watch-multi-confirm-cancel'));
        expect(sheet('watch-multi-confirm')!.props.open).toBe(false);
        expect(removeSymbol).not.toHaveBeenCalled();
        expect(one('watch-multi').props['aria-pressed']).toBe(true);

        await click(one('watch-multi-delete'));
        expect(textOf(one('watch-multi-confirm-ok'))).toBe('確定刪除 2 檔');
        await click(one('watch-multi-confirm-ok'));
        await settleUntil(() => m.notify.mock.calls.length > 0);
        expect(removeSymbol.mock.calls.map(c => c[0])).toEqual(['2330', '2454']);
        expect(items().map(i => i.contract.code)).toEqual(['2317']);
        expect(m.notify).toHaveBeenCalledTimes(1);
        expect(m.notify).toHaveBeenCalledWith({ kind: 'ok', title: '已從自選移除', body: '已從「主要」移除 2 檔' });
        expect(sheet('watch-multi-confirm')!.props.open).toBe(false);
        expect(one('watch-multi').props['aria-pressed']).toBe(false);
        expect(all('watch-multi-bar')).toHaveLength(0);
        expect(all('watch-row-remove')).toHaveLength(1);
    });

    it('依序執行（前一檔完成才開始下一檔），進行中顯示進度、面板不可關閉、勾選停用', async () => {
        const pending: (() => void)[] = [];
        removeSymbol.mockImplementation((code: string) => new Promise<void>(resolve => {
            pending.push(() => { setWl({ items: items().filter(i => i.contract.code !== code) }); resolve(); });
        }));
        await render();
        await enterMulti();
        await click(one('watch-select-all'));
        await click(one('watch-multi-delete'));
        await click(one('watch-multi-confirm-ok'));
        expect(removeSymbol).toHaveBeenCalledTimes(1);
        expect(sheet('watch-multi-confirm')!.props.dismissible).toBe(false);
        expect(textOf(one('watch-multi-progress'))).toBe('刪除中 0／3…');
        expect(one('watch-multi-confirm-cancel').props.disabled).toBe(true);
        expect(one('watch-multi-confirm-ok').props.disabled).toBe(true);
        await act(async () => { pending.shift()!(); });
        await settleUntil(() => removeSymbol.mock.calls.length === 2);
        expect(textOf(one('watch-multi-progress'))).toBe('刪除中 1／3…');
        // 進行中面板仍列出全部 3 檔
        expect(one('watch-multi-confirm-list').findAll(n => n.type === 'li')).toHaveLength(3);
        await act(async () => { pending.shift()!(); });
        await settleUntil(() => removeSymbol.mock.calls.length === 3);
        await act(async () => { pending.shift()!(); });
        await settleUntil(() => m.notify.mock.calls.length > 0);
        expect(removeSymbol.mock.calls.map(c => c[0])).toEqual(['2330', '2317', '2454']);
        expect(m.notify).toHaveBeenCalledWith({ kind: 'ok', title: '已從自選移除', body: '已從「主要」移除 3 檔' });
    });

    it('出錯時停止並回報已移除與未移除的檔數', async () => {
        removeSymbol.mockImplementation(async (code: string) => {
            if (code === '2317') throw new Error('HTTP 500');
            setWl({ items: items().filter(i => i.contract.code !== code) });
        });
        await render();
        await enterMulti();
        await click(one('watch-select-all'));
        await click(one('watch-multi-delete'));
        await click(one('watch-multi-confirm-ok'));
        await settleUntil(() => m.notify.mock.calls.length > 0);
        expect(removeSymbol.mock.calls.map(c => c[0])).toEqual(['2330', '2317']);
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '多選刪除未完成', body: '已移除 1 檔，2 檔未移除：HTTP 500' });
        expect(one('watch-multi').props['aria-pressed']).toBe(false);
    });

    it('清單變忙碌（結構更新）或換清單時停止', async () => {
        removeSymbol.mockImplementation(async (code: string) => {
            setWl({ items: items().filter(i => i.contract.code !== code), structureBusy: true, loading: true });
        });
        await render();
        await enterMulti();
        await click(one('watch-select-all'));
        await click(one('watch-multi-delete'));
        await click(one('watch-multi-confirm-ok'));
        await settleUntil(() => m.notify.mock.calls.length > 0);
        expect(removeSymbol).toHaveBeenCalledTimes(1);
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '多選刪除未完成', body: '已移除 1 檔，2 檔未移除：自選清單更新中' });

        await act(async () => view!.unmount());
        m.notify.mockClear();
        removeSymbol.mockClear();
        removeSymbol.mockImplementation(async (code: string) => {
            setWl({ items: items().filter(i => i.contract.code !== code), activeListId: 'b' });
        });
        setWl({ items: ITEMS, structureBusy: false, loading: false, activeListId: 'a' });
        await render();
        await enterMulti();
        await click(one('watch-select-all'));
        await click(one('watch-multi-delete'));
        await click(one('watch-multi-confirm-ok'));
        await settleUntil(() => m.notify.mock.calls.length > 0);
        expect(removeSymbol).toHaveBeenCalledTimes(1);
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '多選刪除未完成', body: '已移除 1 檔，2 檔未移除：自選清單已切換' });
    });

    it('清單載入中、結構更新中、載入失敗時停用「刪除 N 檔」與確定鍵', async () => {
        await render();
        await enterMulti();
        await click(one('watch-select-all'));
        await click(one('watch-multi-delete'));
        for (const over of [{ structureBusy: true, loading: true }, { loadError: true }]) {
            await act(async () => { setWl({ structureBusy: false, loading: false, loadError: false, ...over }); });
            expect(one('watch-multi-delete').props.disabled, JSON.stringify(over)).toBe(true);
            expect(one('watch-multi-confirm-ok').props.disabled, JSON.stringify(over)).toBe(true);
            await click(one('watch-multi-confirm-ok'));
        }
        expect(removeSymbol).not.toHaveBeenCalled();
    });
});
