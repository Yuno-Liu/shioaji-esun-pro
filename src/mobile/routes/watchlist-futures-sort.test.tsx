// 自選頁：固定清單「股期近月」「股期遠月」分頁與自選清單排序（使用者要求；設計規格 §7.2）
// - 固定清單分頁接在自己的清單分頁最後；選了才 import（延遲載入）；不改目前的伺服器清單（setActiveList 0 次）。
//   固定清單沒有編輯入口：表頭編輯鍵、「＋」新增清單、編輯工具、加入股票、自選列都不顯示；選擇在模組層保留。
// - 自己的清單排序：表頭排序鍵（延遲載入），預設自訂順序（伺服器順序）；選股價類 → 1 次批次快照（清單全部商品）→ 重排，
//   沒有資料的列在最後；只改顯示順序：reorderSymbol 等清單寫入 0 次；排序檢視的長按面板不顯示上移／下移；
//   編輯模式顯示伺服器順序、不顯示排序鍵；偏好依清單 id 存在本裝置。
// - S1：排序鍵、排序面板、固定清單分頁都不呼叫送單、改單、刪單，也不開下單或委託面板。
// 注意：retryableLazy 在模組層快取成功的結果，本檔的測試依序執行。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase } from '../../lib/types/contract';

type FuturesModule = { FuturesList: (props: { listId: string; metric: string; onCycleMetric: () => void; onOpen: (code: string) => void }) => unknown };

const m = vi.hoisted(() => ({
    futuresLoads: 0,
    futuresProps: [] as { listId: string; metric: string; onOpen: (code: string) => void }[],
    wl: {} as Record<string, unknown>,
    navigate: vi.fn(),
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    fetchSnapshots: vi.fn(),
    order: {
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelOrder: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
    },
}));

vi.mock('../lib/deferred-modules', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/deferred-modules')>()),
    loadFuturesList: async (): Promise<FuturesModule> => {
        m.futuresLoads++;
        const { createElement: h } = await import('react');
        return {
            FuturesList: props => {
                m.futuresProps.push(props);
                return h('div', { 'data-testid': 'futures-stub' });
            },
        };
    },
    loadRankingList: () => new Promise(() => undefined),
    loadHoldingsList: () => new Promise(() => undefined),
    loadWatchSparkline: () => new Promise(() => undefined),
    loadSearchSheet: () => new Promise(() => undefined),
    loadWatchListSheet: () => new Promise(() => undefined),
    loadWatchEditControls: () => new Promise(() => undefined),
}));
vi.mock('../../lib/shioaji', async importOriginal => ({
    ...(await importOriginal<typeof import('../../lib/shioaji')>()),
    fetchSnapshots: m.fetchSnapshots,
    ...m.order,
}));
vi.mock('../components/watch-index-strip', () => ({ WatchIndexStrip: () => null }));
vi.mock('../lib/regulatory-punish', () => ({ usePunishedCodes: () => new Set<string>() }));
vi.mock('../../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../../lib/stream', () => ({ ensureStream: () => undefined, getQuote: () => undefined, subscribeQuoteStore: () => () => undefined }));
vi.mock('../../lib/quote-ownership', () => ({ retainContractQuotes: () => () => undefined }));
vi.mock('../../hooks/use-watchlist', () => ({ useWatchlist: () => m.wl }));
vi.mock('../../lib/product-search', () => ({ searchProducts: vi.fn(async () => []) }));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));
vi.mock('../lib/mobile-store', async importOriginal => ({
    ...(await importOriginal<typeof import('../lib/mobile-store')>()),
    openTicket: m.openTicket,
    openOrderAction: m.openOrderAction,
}));
vi.mock('../motion/haptics', () => ({ haptic: vi.fn(() => false) }));

import { BottomSheet } from '../components/bottom-sheet';
import { resetSortBasisForTest } from '../lib/watch-sort';
import { resetWatchPrefsForTest, setWatchSparklineEnabled } from '../lib/watch-prefs';
import { WatchlistProvider } from '../lib/watchlist-context';
import { resetWatchlistSegmentForTest, WatchlistPage } from './watchlist-page';

class FakeIO {
    observe() { /* 不需要可見度 */ }
    unobserve() { /* 不需要可見度 */ }
    disconnect() { /* 不需要可見度 */ }
}
class MemoryStorage {
    data = new Map<string, string>();
    getItem(k: string) { return this.data.get(k) ?? null; }
    setItem(k: string, v: string) { this.data.set(k, v); }
    removeItem(k: string) { this.data.delete(k); }
}

let view: ReactTestRenderer | undefined;
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const press = (id: string) => act(async () => { all(id)[0]!.props.onClick(); });
// 等延遲載入的 chunk（watch-sort 等）真的載完：單獨執行某一項測試時，第一次 import 比整檔執行時慢
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await vi.dynamicImportSettled(); await Promise.resolve(); }); };
const render = async () => {
    await act(async () => { view = create(createElement(WatchlistProvider, null, createElement(WatchlistPage))); });
    await settle();
};
const contract = (code: string, name: string, over: Partial<ContractBase> = {}) => ({ code, name, reference: 100, security_type: 'STK', exchange: 'TSE', target_code: null, ...over });
const rowCodes = () => all('watch-row').map(r => r.props['data-code'] as string);
const tabIds = () => view!.root.findAll(n => n.type === 'button' && String(n.props['data-testid'] ?? '').startsWith('watch-list-tab-')).map(n => String(n.props['data-testid']).slice('watch-list-tab-'.length));
const option = (key: string) => act(async () => { all(`watch-sort-option-${key}`)[0]!.findByType('button').props.onClick(); });
const btnByText = (text: string) => view!.root.findAll(n => n.type === 'button' && n.props.children === text);

const WRITES = ['addSymbol', 'removeSymbol', 'reorderSymbol', 'createList', 'renameCurrentList', 'deleteCurrentList', 'setActiveList'] as const;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', FakeIO);
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetWatchPrefsForTest();
    setWatchSparklineEnabled(false);
    resetSortBasisForTest();
    for (const f of [m.navigate, m.openTicket, m.openOrderAction, ...Object.values(m.order)]) f.mockClear();
    m.fetchSnapshots.mockReset();
    m.fetchSnapshots.mockImplementation(async (cs: ContractBase[]) => cs.flatMap(c => {
        // TXFR1 的快照以實際月份代碼回傳；2317 沒有成交
        const close: Record<string, number> = { '2330': 1000, TXFK6: 22800, '0050': 150 };
        const code = c.code === 'TXFR1' ? 'TXFK6' : c.code;
        return close[code] === undefined ? [] : [{ code, close: close[code], change_price: 1, change_rate: 0.1 }];
    }));
    m.wl = {
        items: [
            { contract: contract('2317', '鴻海') },
            { contract: contract('2330', '台積電') },
            { contract: contract('TXFR1', '臺股期貨 近月', { security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFK6' }) },
            { contract: contract('0050', '元大台灣50') },
        ],
        loading: false,
        structureBusy: false,
        loadError: false,
        retryLoad: vi.fn(),
        serverLists: [{ id: 'a', name: '我的自選', contracts: [] }, { id: 'b', name: '觀察', contracts: [] }],
        activeListId: 'a',
        ...Object.fromEntries(WRITES.map(k => [k, vi.fn(async () => undefined)])),
    };
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // S1：送單、改單、刪單與委託操作面板 0 次
    for (const [k, f] of Object.entries(m.order)) expect(f, k).not.toHaveBeenCalled();
    expect(m.openOrderAction).not.toHaveBeenCalled();
});

describe('固定清單分頁', () => {
    it('接在自己的清單最後；選了才載入；沒有編輯入口；不改伺服器的目前清單；選擇在模組層保留', async () => {
        resetWatchlistSegmentForTest();
        await render();
        expect(tabIds()).toEqual(['a', 'b', 'fut-near', 'fut-next']);
        expect(textOf(all('watch-list-tab-fut-near')[0]!)).toBe('股期近月');
        expect(textOf(all('watch-list-tab-fut-next')[0]!)).toBe('股期遠月');
        expect(m.futuresLoads).toBe(0);
        expect(all('watch-list-add')).toHaveLength(1);

        await press('watch-list-tab-fut-near');
        await settle();
        expect(m.futuresLoads).toBe(1);
        expect(all('futures-stub')).toHaveLength(1);
        expect(m.futuresProps.at(-1)!.listId).toBe('fut:near');
        expect(m.futuresProps.at(-1)!.metric).toBe('pct');
        expect(all('watch-list-tab-fut-near')[0]!.props['aria-selected']).toBe(true);
        for (const id of ['watch-list', 'watch-list-header', 'watch-edit', 'watch-list-add', 'watch-list-tools', 'watch-add-symbol', 'watch-empty', 'watch-sort']) {
            expect(all(id), id).toHaveLength(0);
        }
        // onOpen 只 navigate
        m.futuresProps.at(-1)!.onOpen('CDFK6');
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: 'CDFK6' });

        await press('watch-list-tab-fut-next');
        await settle();
        expect(m.futuresProps.at(-1)!.listId).toBe('fut:next');

        // 重新進入自選頁：仍是固定清單
        await act(async () => view!.unmount());
        await render();
        expect(all('watch-list-tab-fut-next')[0]!.props['aria-selected']).toBe(true);
        expect(all('futures-stub')).toHaveLength(1);
        for (const k of WRITES) expect(m.wl[k], k).not.toHaveBeenCalled();

        // 回到自己的清單：同一個清單不呼叫 setActiveList；換清單才呼叫
        await press('watch-list-tab-a');
        expect(all('futures-stub')).toHaveLength(0);
        expect(rowCodes()).toEqual(['2317', '2330', 'TXFR1', '0050']);
        expect(all('watch-edit')).toHaveLength(1);
        expect(m.wl.setActiveList).not.toHaveBeenCalled();
        await press('watch-list-tab-fut-near');
        await press('watch-list-tab-b');
        expect(m.wl.setActiveList).toHaveBeenCalledWith('b');
        expect(m.openTicket).not.toHaveBeenCalled();
    });
});

describe('自己的清單排序', () => {
    it('預設自訂順序；股價 → 1 次批次快照、重排（沒有資料在最後、連續月以實際月份對應）；不寫回伺服器；偏好存本裝置', async () => {
        resetWatchlistSegmentForTest();
        await render();
        expect(all('watch-sort')[0]!.props['data-sort']).toBe('manual:asc');
        expect(rowCodes()).toEqual(['2317', '2330', 'TXFR1', '0050']);
        expect(all('watch-sort-basis')).toHaveLength(0);
        expect(m.fetchSnapshots).not.toHaveBeenCalled();

        await press('watch-sort');
        const sheet = view!.root.findAll(n => n.type === BottomSheet && n.props.testId === 'watch-sort-sheet')[0]!;
        expect(sheet.props.open).toBe(true);
        const keys = sheet.findAll(n => typeof n.type === 'string' && String(n.props['data-testid'] ?? '').startsWith('watch-sort-option-')).map(n => n.props['data-testid']);
        expect(keys).toEqual(['manual', 'code', 'price', 'pct', 'chg'].map(k => `watch-sort-option-${k}`));
        await option('price');
        await settle();
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(1);
        expect((m.fetchSnapshots.mock.calls[0]![0] as ContractBase[]).map(c => c.code)).toEqual(['2317', '2330', 'TXFR1', '0050']);
        expect(rowCodes()).toEqual(['TXFR1', '2330', '0050', '2317']);
        expect(textOf(all('watch-sort-basis')[0]!)).toMatch(/排序依據 \d\d:\d\d:\d\d/);
        expect(JSON.parse(localStorage.getItem('sj-mobile-watch-sort-v1')!)).toEqual({ a: { key: 'price', dir: 'desc' } });

        // 再點一次＝由低到高；沒有資料的 2317 仍在最後；不重取
        await press('watch-sort');
        await option('price');
        expect(rowCodes()).toEqual(['0050', '2330', 'TXFR1', '2317']);
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(1);

        // 股票代號：不需要快照
        await press('watch-sort');
        await option('code');
        expect(rowCodes()).toEqual(['0050', '2317', '2330', 'TXFR1']);
        expect(all('watch-sort-basis')).toHaveLength(0);
        for (const k of WRITES) expect(m.wl[k], k).not.toHaveBeenCalled();
        expect(m.openTicket).not.toHaveBeenCalled();
    });

    it('開啟時已存股價排序：取 1 次快照；排序檢視的操作面板沒有上移／下移；編輯模式顯示伺服器順序、沒有排序鍵', async () => {
        localStorage.setItem('sj-mobile-watch-sort-v1', JSON.stringify({ a: { key: 'price', dir: 'desc' } }));
        resetWatchlistSegmentForTest();
        await render();
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(1);
        expect(rowCodes()).toEqual(['TXFR1', '2330', '0050', '2317']);

        await act(async () => {
            all('watch-row-button').find(n => n.props['aria-label'].startsWith('2330'))!.props.onContextMenu({ preventDefault: vi.fn() });
        });
        expect(view!.root.find(n => n.type === BottomSheet && n.props.testId === 'watch-actions').props.open).toBe(true);
        expect(btnByText('開啟交易頁').length + all('watch-action-open').length).toBeGreaterThan(0);
        for (const t of ['移到最上', '上移', '下移']) expect(btnByText(t), t).toHaveLength(0);
        expect(all('watch-remove')).toHaveLength(1);
        await act(async () => { view!.root.find(n => n.type === BottomSheet && n.props.testId === 'watch-actions').props.onClose(); });

        await press('watch-edit');
        expect(rowCodes()).toEqual(['2317', '2330', 'TXFR1', '0050']);
        expect(all('watch-sort')).toHaveLength(0);
        expect(all('watch-sort-basis')).toHaveLength(0);
        await press('watch-edit');
        expect(rowCodes()).toEqual(['TXFR1', '2330', '0050', '2317']);
        expect(all('watch-sort')).toHaveLength(1);
        // 5 秒內重新掛載沿用同一份排序依據
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(1);
        for (const k of WRITES) expect(m.wl[k], k).not.toHaveBeenCalled();
    });

    it('清單內容改變（新增一檔）：依同一份排序依據放進順序（沒有資料在最後），不自動重取', async () => {
        localStorage.setItem('sj-mobile-watch-sort-v1', JSON.stringify({ a: { key: 'price', dir: 'desc' } }));
        resetWatchlistSegmentForTest();
        await render();
        const before = m.fetchSnapshots.mock.calls.length;
        m.wl = { ...m.wl, items: [...(m.wl.items as unknown[]), { contract: contract('2454', '聯發科') }] };
        await act(async () => { view!.update(createElement(WatchlistProvider, null, createElement(WatchlistPage))); });
        await settle();
        expect(rowCodes()).toEqual(['TXFR1', '2330', '0050', '2317', '2454']);
        expect(m.fetchSnapshots.mock.calls.length).toBe(before);
    });

    it('換清單：關掉長按面板；新清單的排序結果交回前不沿用上一張清單的順序，也不會少列', async () => {
        localStorage.setItem('sj-mobile-watch-sort-v1', JSON.stringify({ a: { key: 'price', dir: 'desc' }, b: { key: 'price', dir: 'desc' } }));
        resetWatchlistSegmentForTest();
        await render();
        expect(rowCodes()).toEqual(['TXFR1', '2330', '0050', '2317']);
        await act(async () => {
            all('watch-row-button').find(n => n.props['aria-label'].startsWith('2330'))!.props.onContextMenu({ preventDefault: vi.fn() });
        });
        const actionsOpen = () => view!.root.findAll(n => n.type === BottomSheet && n.props.testId === 'watch-actions').some(n => n.props.open);
        expect(actionsOpen()).toBe(true);

        // 清單 b 的排序快照一直沒回來：排序鍵還沒交回 b 的順序
        m.fetchSnapshots.mockImplementation(() => new Promise(() => undefined));
        await press('watch-list-tab-b');
        expect(m.wl.setActiveList).toHaveBeenCalledWith('b');
        m.wl = { ...m.wl, activeListId: 'b', items: [{ contract: contract('2603', '長榮') }, { contract: contract('2330', '台積電') }, { contract: contract('2412', '中華電') }] };
        await act(async () => { view!.update(createElement(WatchlistProvider, null, createElement(WatchlistPage))); });
        await settle();

        expect(actionsOpen()).toBe(false);
        // 上一張清單的順序（只含 2330）不得讓 2603、2412 消失
        expect([...rowCodes()].sort()).toEqual(['2330', '2412', '2603']);
    });
});
