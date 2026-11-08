// 自選頁「持倉」分段（使用者要求：依持倉自動列出，不可手動新增或刪除）：
// - 分段「自選｜排行｜持倉」；預設「自選」不載入持倉模組；切到「持倉」才 import（比照排行）。
// - 載入中 Skeleton（role=status）；失敗只在分段內容區顯示「載入失敗」＋［重試］，頁首與分段照常；重試重新 import 後顯示。
// - 「持倉」分段沒有任何編輯入口：清單分頁、「＋」新增清單、表頭編輯鍵、自選列都不顯示；底部指數列照舊。
// - 分段選擇在模組層保留（切換分頁再回來仍是「持倉」，不再 import）。
// - 列表元件收到目前的指標（metric）與開交易頁的 onOpen（只 navigate）。
// - S1：分段切換不呼叫 openTicket／openOrderAction 以外的任何下單函式（這裡兩者也都是 0 次）。
// 注意：retryableLazy 在模組層快取成功的結果，本檔的測試依序執行。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type HoldingsModule = { HoldingsList: (props: { metric: string; onOpen: (code: string) => void }) => unknown };

const m = vi.hoisted(() => ({
    loads: 0,
    pending: null as null | { resolve: (mod: HoldingsModule) => void; reject: (error: unknown) => void },
    wl: {} as Record<string, unknown>,
    navigate: vi.fn(),
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    stubProps: [] as { metric: string; onOpen: (code: string) => void }[],
}));

vi.mock('../lib/deferred-modules', () => ({
    loadHoldingsList: () => {
        m.loads++;
        return new Promise<HoldingsModule>((resolve, reject) => { m.pending = { resolve, reject }; });
    },
    loadRankingList: () => new Promise(() => undefined),
    loadWatchSparkline: () => new Promise(() => undefined),
    loadSearchSheet: () => new Promise(() => undefined),
    loadWatchListSheet: () => new Promise(() => undefined),
    loadWatchEditControls: () => new Promise(() => undefined),
}));
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

import { MODULE_LOAD_ERROR_TEXT } from '../components/route-error-boundary';
import { WatchlistProvider } from '../lib/watchlist-context';
import { resetWatchlistSegmentForTest, WatchlistPage } from './watchlist-page';

class FakeIO {
    observe() { /* 不需要可見度 */ }
    unobserve() { /* 不需要可見度 */ }
    disconnect() { /* 不需要可見度 */ }
}

let view: ReactTestRenderer | undefined;
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const press = (id: string) => act(async () => { all(id)[0]!.props.onClick(); });
const settle = () => act(async () => { await Promise.resolve(); });
const render = () => act(async () => { view = create(createElement(WatchlistProvider, null, createElement(WatchlistPage))); });
const contract = (code: string, name: string) => ({ code, name, reference: 100, security_type: 'STK', exchange: 'TSE', target_code: null });

function expectNoEditEntries() {
    for (const id of ['watch-list-tabs', 'watch-list-add', 'watch-list-header', 'watch-edit', 'watch-list', 'watch-empty', 'watch-list-tools', 'watch-add-symbol']) {
        expect(all(id), id).toHaveLength(0);
    }
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', FakeIO);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.navigate.mockClear();
    m.openTicket.mockClear();
    m.openOrderAction.mockClear();
    m.wl = {
        items: [{ contract: contract('2330', '台積電') }],
        loading: false,
        structureBusy: false,
        loadError: false,
        retryLoad: vi.fn(),
        addSymbol: vi.fn(async () => undefined),
        removeSymbol: vi.fn(async () => undefined),
        reorderSymbol: vi.fn(),
        serverLists: [{ id: 'a', name: '我的自選', contracts: [] }, { id: 'b', name: '觀察', contracts: [] }],
        activeListId: 'a',
        setActiveList: vi.fn(),
    };
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(m.openTicket).not.toHaveBeenCalled();
    expect(m.openOrderAction).not.toHaveBeenCalled();
});

describe('自選頁：持倉分段', () => {
    it('分段為「自選｜排行｜持倉」；預設「自選」不載入持倉模組', async () => {
        resetWatchlistSegmentForTest();
        await render();
        const tabs = view!.root.findAll(n => typeof n.type === 'string' && String(n.props['data-testid'] ?? '').startsWith('watch-segment-'));
        expect(tabs.map(textOf)).toEqual(['自選', '排行', '持倉']);
        expect(all('watch-segment-watchlist')[0]!.props['aria-selected']).toBe(true);
        expect(m.loads).toBe(0);
        expect(all('holdings-module-loading')).toHaveLength(0);
        expect(all('watch-list')).toHaveLength(1);
    });

    it('切到「持倉」：沒有編輯入口；載入中 Skeleton；失敗顯示「載入失敗」＋重試；重試後顯示並收到 metric 與 onOpen', async () => {
        resetWatchlistSegmentForTest();
        await render();
        await press('watch-segment-holdings');
        expect(all('watch-segment-holdings')[0]!.props['aria-selected']).toBe(true);
        expect(m.loads).toBe(1);
        expect(all('holdings-module-loading')).toHaveLength(1);
        expect(all('holdings-module-loading')[0]!.props.role).toBe('status');
        expectNoEditEntries();
        // 底部指數列照舊、搜尋照舊
        expect(all('watch-index-strip')).toHaveLength(1);
        expect(all('watch-search')).toHaveLength(1);

        await act(async () => { m.pending!.reject(new TypeError('Failed to fetch dynamically imported module: holdings-list.js')); });
        await settle();
        expect(all('holdings-load-error')).toHaveLength(1);
        expect(textOf(all('holdings-load-error')[0]!)).toContain(MODULE_LOAD_ERROR_TEXT);
        expect(all('page-watchlist')).toHaveLength(1);
        expectNoEditEntries();

        await press('holdings-load-error-retry');
        expect(m.loads).toBe(2);
        await act(async () => {
            m.pending!.resolve({
                HoldingsList: props => {
                    m.stubProps.push(props);
                    return createElement('div', { 'data-testid': 'holdings-stub' });
                },
            });
        });
        await settle();
        expect(all('holdings-stub')).toHaveLength(1);
        const props = m.stubProps.at(-1)!;
        expect(props.metric).toBe('pct');
        props.onOpen('2330');
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2330' });
        expectNoEditEntries();
    });

    it('分段選擇在模組層保留：重新進入自選頁仍是「持倉」、不再 import；切回「自選」恢復清單與編輯鍵', async () => {
        await render();
        expect(all('watch-segment-holdings')[0]!.props['aria-selected']).toBe(true);
        expect(all('holdings-stub')).toHaveLength(1);
        expect(m.loads).toBe(2);
        await press('watch-segment-watchlist');
        expect(all('holdings-stub')).toHaveLength(0);
        expect(all('watch-list')).toHaveLength(1);
        expect(all('watch-edit')).toHaveLength(1);
        expect(all('watch-list-tabs')).toHaveLength(1);
    });

    it('在「自選」編輯模式切到「持倉」：結束編輯模式', async () => {
        resetWatchlistSegmentForTest();
        await render();
        await press('watch-edit');
        expect(all('watch-edit')[0]!.props['aria-pressed']).toBe(true);
        await press('watch-segment-holdings');
        await press('watch-segment-watchlist');
        expect(all('watch-edit')[0]!.props['aria-pressed']).toBe(false);
    });
});
