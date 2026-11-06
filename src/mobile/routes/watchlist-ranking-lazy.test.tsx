// 自選頁「排行」分段改為延遲載入（規格 §13 首次載入體積）：
// - 預設「自選」分段不載入排行模組。
// - 切到「排行」：載入中顯示 Skeleton（role=status）；失敗只在分段內容區顯示「載入失敗」＋［重試］，
//   頁首與分段控制照常；重試會重新 import，成功後顯示排行。
// 注意：retryableLazy 在模組層快取成功的結果，本檔的測試依序執行。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RankingModule = { RankingList: () => unknown };

const m = vi.hoisted(() => ({
    loads: 0,
    pending: null as null | { resolve: (mod: RankingModule) => void; reject: (error: unknown) => void },
    wl: {} as Record<string, unknown>,
}));

vi.mock('../lib/deferred-modules', () => ({
    loadRankingList: () => {
        m.loads++;
        return new Promise<RankingModule>((resolve, reject) => { m.pending = { resolve, reject }; });
    },
}));
vi.mock('../../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../../hooks/use-watchlist', () => ({ useWatchlist: () => m.wl }));
vi.mock('../../lib/product-search', () => ({ searchProducts: vi.fn(async () => []) }));
vi.mock('../lib/hash-router', () => ({ navigate: vi.fn() }));
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

function expectPageChromeIntact() {
    expect(all('page-watchlist')).toHaveLength(1);
    expect(all('watch-search')).toHaveLength(1);
    expect(all('watch-segment-ranking')[0]!.props['aria-selected']).toBe(true);
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', FakeIO);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetWatchlistSegmentForTest();
    m.wl = {
        items: [],
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

describe('自選頁：排行分段延遲載入', () => {
    it('預設「自選」分段不載入排行模組', async () => {
        await render();
        expect(all('watch-segment-watchlist')[0]!.props['aria-selected']).toBe(true);
        expect(m.loads).toBe(0);
        expect(all('ranking-module-loading')).toHaveLength(0);
    });

    it('切到「排行」：載入中 Skeleton；失敗顯示「載入失敗」＋重試；重試重新 import 後顯示排行', async () => {
        await render();
        await press('watch-segment-ranking');
        expect(m.loads).toBe(1);
        // 載入中
        expect(all('ranking-module-loading')).toHaveLength(1);
        expect(all('ranking-module-loading')[0]!.props.role).toBe('status');
        expect(all('ranking-load-error')).toHaveLength(0);
        expectPageChromeIntact();

        // chunk 載入失敗：只在分段內容區顯示錯誤
        await act(async () => { m.pending!.reject(new TypeError('Failed to fetch dynamically imported module: ranking-list.js')); });
        await settle();
        expect(all('ranking-module-loading')).toHaveLength(0);
        expect(all('ranking-load-error')).toHaveLength(1);
        expect(textOf(all('ranking-load-error')[0]!)).toContain(MODULE_LOAD_ERROR_TEXT);
        expectPageChromeIntact();

        // 重試：重新 import，成功後顯示排行
        await press('ranking-load-error-retry');
        expect(m.loads).toBe(2);
        expect(all('ranking-module-loading')).toHaveLength(1);
        await act(async () => { m.pending!.resolve({ RankingList: () => createElement('div', { 'data-testid': 'ranking-stub' }) }); });
        await settle();
        expect(all('ranking-load-error')).toHaveLength(0);
        expect(all('ranking-module-loading')).toHaveLength(0);
        expect(all('ranking-stub')).toHaveLength(1);

        // 切回「自選」再回「排行」：已載入，不再 import
        await press('watch-segment-watchlist');
        await press('watch-segment-ranking');
        expect(all('ranking-stub')).toHaveLength(1);
        expect(m.loads).toBe(2);
    });
});
