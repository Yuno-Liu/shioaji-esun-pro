// src/mobile/routes/watchlist-edit-preload.test.tsx — 自選編輯鍵的閒置預載（preloadWatchEditControls）
//
// app.tsx 閒置時呼叫 preloadWatchEditControls：三個 retryableLazy（拖曳排序、列首、列尾）都先記住元件，
// 第一次進入編輯模式就直接渲染「−」「⋯」與握把，不 suspend、不出現空白佔位。
// 沒有預載時的載入中、失敗與重試另見 watchlist-deferred.test.tsx（retryableLazy 是模組層狀態，所以分檔）。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    editLoads: 0,
    wl: {} as Record<string, unknown>,
    placeStockOrder: vi.fn(),
    placeFuturesOrder: vi.fn(),
}));

vi.mock('../lib/deferred-modules', () => ({
    loadRankingList: () => new Promise(() => undefined),
    loadWatchSparkline: () => new Promise(() => undefined),
    loadSearchSheet: () => new Promise(() => undefined),
    loadWatchListSheet: () => new Promise(() => undefined),
    loadWatchEditControls: () => {
        m.editLoads++;
        return import('../components/watch-edit-controls');
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
vi.mock('../lib/hash-router', () => ({ navigate: vi.fn() }));
vi.mock('../motion/haptics', () => ({ haptic: vi.fn(() => false) }));

import { resetWatchPrefsForTest } from '../lib/watch-prefs';
import { WatchlistProvider } from '../lib/watchlist-context';
import { preloadWatchEditControls, resetWatchlistSegmentForTest, WatchlistPage } from './watchlist-page';

class FakeIO {
    observe() { /* 不需要可見度 */ }
    unobserve() { /* 不需要可見度 */ }
    disconnect() { /* 不需要可見度 */ }
}

const contract = (code: string, name: string) => ({ code, name, reference: 100, security_type: 'STK', exchange: 'TSE', target_code: null });

let view: ReactTestRenderer | undefined;
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', FakeIO);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

describe('自選編輯鍵的閒置預載', () => {
    it('預載後第一次進入編輯模式：同一次渲染就有「−」「⋯」與可用的握把，沒有空白佔位；不再 import', async () => {
        await act(async () => {
            view = create(createElement(WatchlistProvider, null, createElement(WatchlistPage)), { createNodeMock: () => ({}) });
        });
        expect(m.editLoads).toBe(0);

        await preloadWatchEditControls();
        const loads = m.editLoads;
        expect(loads).toBeGreaterThan(0);

        // 同步 act：不等任何 microtask（沒有預載時 lazy 會在這裡 suspend，只剩空白佔位）
        act(() => { all('watch-edit')[0]!.props.onClick(); });
        expect(all('watch-edit-leading-blank')).toHaveLength(0);
        expect(all('watch-edit-trailing-blank')).toHaveLength(0);
        expect(all('watch-row-remove')).toHaveLength(2);
        expect(all('watch-more')).toHaveLength(2);
        expect(all('watch-row-grip').map(g => g.props.disabled)).toEqual([false, false]);
        expect(m.editLoads).toBe(loads);
        expect(m.placeStockOrder).not.toHaveBeenCalled();
        expect(m.placeFuturesOrder).not.toHaveBeenCalled();
    });
});
