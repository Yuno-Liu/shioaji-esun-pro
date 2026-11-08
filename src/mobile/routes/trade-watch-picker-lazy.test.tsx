// 交易頁 ☆「加入自選」面板延遲載入（規格 §13 首次載入體積）：
// - 進交易頁不 import 面板模組；第一次按 ☆ 才 import。
// - 失敗：底部面板「載入失敗」＋［重試］（可關閉，標頭與買賣鍵照常）；重試重新 import，成功後顯示面板。
// - S1：不開下單或委託面板，lib 送單／改單／刪單 0 次。
// 注意：retryableLazy 在模組層快取成功的結果，本檔的測試依序執行。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';

type PickerModule = typeof import('../components/watch-picker-sheet');

const m = vi.hoisted(() => ({
    loads: 0,
    pending: null as null | { resolve: (mod: PickerModule) => void; reject: (error: unknown) => void },
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    navigate: vi.fn(),
    send: {
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelOrders: vi.fn(),
        cancelVerifiedOrder: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
        submitMobileOrder: vi.fn(),
        placeQuickOrder: vi.fn(),
        cancelAllOrders: vi.fn(),
    },
}));

vi.mock('../components/load-watch-picker-sheet', () => ({
    loadWatchPickerSheet: () => {
        m.loads++;
        return new Promise<PickerModule>((resolve, reject) => { m.pending = { resolve, reject }; });
    },
}));
vi.mock('../lib/watchlist-context', () => ({
    useOptionalMobileWatchlist: () => ({
        items: [],
        loading: false,
        structureBusy: false,
        loadError: false,
        serverLists: [{ id: 'L1', name: '主要', contracts: [] }],
        activeListId: 'L1',
        addSymbol: vi.fn(),
        removeSymbol: vi.fn(),
    }),
}));
vi.mock('../../hooks/use-stream', () => ({ useQuote: () => ({ tick: { code: '2330', close: '1085', price_chg: '15' } }) }));
vi.mock('../../lib/contracts-cache', () => ({ useContract: () => stock, ensureContract: async () => stock }));
vi.mock('../../lib/trading-state', () => ({ useTradingState: () => ({ trades: [], positions: [] }) }));
vi.mock('../../lib/privacy', () => ({ usePrivacyMoney: () => false, maskMoney: (t: string) => t }));
vi.mock('../lib/mobile-store', () => ({ openTicket: m.openTicket, openOrderAction: m.openOrderAction, setCurrentCode: vi.fn() }));
vi.mock('../../lib/product-search', () => ({ searchProducts: vi.fn(async () => []) }));
vi.mock('../components/trade-chart', () => ({ TradeChart: () => null }));
vi.mock('../components/tick-list', () => ({ TickList: () => null }));
vi.mock('../../lib/shioaji', () => ({
    fetchSnapshots: vi.fn(async () => []),
    addWatchlistContracts: vi.fn(),
    removeWatchlistContracts: vi.fn(),
    placeStockOrder: m.send.placeStockOrder,
    placeFuturesOrder: m.send.placeFuturesOrder,
    placeComboOrder: m.send.placeComboOrder,
    cancelOrder: m.send.cancelOrder,
    cancelOrders: m.send.cancelOrders,
    cancelVerifiedOrder: m.send.cancelVerifiedOrder,
    updateOrderPrice: m.send.updateOrderPrice,
    updateOrderQty: m.send.updateOrderQty,
}));
vi.mock('../lib/regulatory-punish', () => ({ usePunishedCodes: () => new Set<string>(), usePunishedListLoaded: () => false }));
vi.mock('../components/trade-info/load-trade-chips-sheet', () => ({ loadTradeChipsSheet: async () => ({ TradeChipsSheet: () => null }) }));
vi.mock('../lib/mobile-order', () => ({ submitMobileOrder: m.send.submitMobileOrder }));
vi.mock('../../lib/trade', () => ({ placeQuickOrder: m.send.placeQuickOrder, cancelAllOrders: m.send.cancelAllOrders, notify: vi.fn() }));
vi.mock('../../lib/market-snapshot-store', () => ({ getMarketSnapshot: () => undefined, subscribeMarketSnapshots: () => () => undefined }));
vi.mock('../lib/hash-router', async importOriginal => ({ ...(await importOriginal<typeof import('../lib/hash-router')>()), navigate: m.navigate }));

import { MODULE_LOAD_ERROR_TEXT } from '../components/route-error-boundary';
import { TradePage } from './trade-page';

const stock = {
    exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 1070, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as ContractInfo;

let view: ReactTestRenderer | undefined;
const text = (n: ReactTestInstance | string): string =>
    typeof n === 'string' ? n : n.children.map(k => text(k as ReactTestInstance | string)).join('');
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const sheet = (testId: string) => view!.root.findAll(n => n.props.testId === testId && typeof n.type !== 'string')[0];
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const render = () => act(async () => { view = create(createElement(TradePage, { code: '2330' })); });

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.openTicket.mockReset();
    m.openOrderAction.mockReset();
    Object.values(m.send).forEach(f => f.mockReset());
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    expect(m.openTicket).not.toHaveBeenCalled();
    expect(m.openOrderAction).not.toHaveBeenCalled();
});

describe('交易頁：☆「加入自選」面板延遲載入', () => {
    it('進交易頁不載入；按 ☆ 才 import；失敗顯示「載入失敗」＋重試（可關閉，頁面照常）；重試成功後顯示面板', async () => {
        await render();
        expect(m.loads).toBe(0);
        expect(all('trade-watch-star')[0]!.props['aria-label']).toBe('自選：未加入');

        await act(async () => { all('trade-watch-star')[0]!.props.onClick(); });
        expect(m.loads).toBe(1);
        await act(async () => { m.pending!.reject(new TypeError('Failed to fetch dynamically imported module: watch-picker-sheet.js')); });
        await settle();
        expect(sheet('watch-picker-load-error')!.props.open).toBe(true);
        expect(text(all('watch-picker-load-error-body')[0]!)).toContain(MODULE_LOAD_ERROR_TEXT);
        expect(all('trade-price')).toHaveLength(1);
        expect(all('trade-buy')).toHaveLength(1);
        // 可關閉
        await act(async () => { sheet('watch-picker-load-error')!.props.onClose(); });
        expect(sheet('watch-picker-load-error')!.props.open).toBe(false);

        // 再按 ☆ 後重試：重新 import，成功後顯示面板
        await act(async () => { all('trade-watch-star')[0]!.props.onClick(); });
        expect(sheet('watch-picker-load-error')!.props.open).toBe(true);
        await act(async () => { all('watch-picker-load-error-body-retry')[0]!.props.onClick(); });
        expect(m.loads).toBe(2);
        await act(async () => { m.pending!.resolve(await vi.importActual<PickerModule>('../components/watch-picker-sheet')); });
        await settle();
        expect(sheet('watch-picker')!.props.open).toBe(true);
        expect(all('watch-picker-list')).toHaveLength(1);
    });
});
