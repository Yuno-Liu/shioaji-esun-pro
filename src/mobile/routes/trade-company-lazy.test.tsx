// 交易頁「公司」分頁延遲載入（規格 §13 首次載入體積）：
// - 進交易頁、切五檔／明細都不 import 公司模組（因此也不讀 shioaji-data：讀取在公司模組掛載後才開始）。
// - 切到「公司」：載入中 Skeleton（role=status）；失敗只在分頁內容區顯示「載入失敗」＋［重試］，標頭與買賣鍵照常；
//   重試重新 import，成功後顯示公司分頁並帶入合約。整股／零股切換鍵在公司分頁隱藏但保留位置與狀態。
// - 切走再回來：公司分頁保持掛載（hidden），不再 import；隱藏時 active=false（不跟著成交重繪）。
// 注意：retryableLazy 在模組層快取成功的結果，本檔的測試依序執行。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';

type CompanyModule = { CompanyTab: (props: { contract?: ContractInfo; active?: boolean }) => unknown };

const m = vi.hoisted(() => ({
    loads: 0,
    pending: null as null | { resolve: (mod: CompanyModule) => void; reject: (error: unknown) => void },
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

vi.mock('../components/company/load-company-tab', () => ({
    loadCompanyTab: () => {
        m.loads++;
        return new Promise<CompanyModule>((resolve, reject) => { m.pending = { resolve, reject }; });
    },
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
    placeStockOrder: m.send.placeStockOrder,
    placeFuturesOrder: m.send.placeFuturesOrder,
    placeComboOrder: m.send.placeComboOrder,
    cancelOrder: m.send.cancelOrder,
    cancelOrders: m.send.cancelOrders,
    cancelVerifiedOrder: m.send.cancelVerifiedOrder,
    updateOrderPrice: m.send.updateOrderPrice,
    updateOrderQty: m.send.updateOrderQty,
}));
// 當沖資訊列的處置名單與「籌碼與當沖」面板：替身，不發請求（本檔只驗公司分頁）
vi.mock('../lib/regulatory-punish', () => ({ usePunishedCodes: () => new Set<string>(), usePunishedListLoaded: () => false }));
vi.mock('../components/trade-info/load-trade-chips-sheet', () => ({ loadTradeChipsSheet: async () => ({ TradeChipsSheet: () => null }) }));
vi.mock('../lib/mobile-order', () => ({ submitMobileOrder: m.send.submitMobileOrder }));
vi.mock('../../lib/trade', () => ({ placeQuickOrder: m.send.placeQuickOrder, cancelAllOrders: m.send.cancelAllOrders }));
vi.mock('../../lib/market-snapshot-store', () => ({ getMarketSnapshot: () => undefined, subscribeMarketSnapshots: () => () => undefined }));
vi.mock('../lib/hash-router', async importOriginal => ({ ...(await importOriginal<typeof import('../lib/hash-router')>()), navigate: m.navigate }));

import { MODULE_LOAD_ERROR_TEXT } from '../components/route-error-boundary';
import * as tradeStyles from '../styles/trade.css';
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
const btn = (label: string) => view!.root.findAll(n => n.type === 'button').find(b => text(b) === label)!;
const press = (node: ReactTestInstance) => act(async () => { node.props.onClick(); });
const settle = () => act(async () => { await Promise.resolve(); });
const render = () => act(async () => { view = create(createElement(TradePage, { code: '2330' })); });

function expectPageChromeIntact() {
    expect(all('page-trade')).toHaveLength(1);
    expect(all('trade-price')).toHaveLength(1);
    expect(all('trade-buy')).toHaveLength(1);
    expect(all('trade-sell')).toHaveLength(1);
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.openTicket.mockReset();
    m.openOrderAction.mockReset();
    m.navigate.mockReset();
    Object.values(m.send).forEach(f => f.mockReset());
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    expect(m.openOrderAction).not.toHaveBeenCalled();
});

describe('交易頁：公司分頁延遲載入', () => {
    it('進交易頁、切五檔／明細都不載入公司模組', async () => {
        await render();
        expect(all('trade-panel-company')).toHaveLength(1);
        expect(all('trade-company')).toHaveLength(0);
        await press(btn('明細'));
        await press(btn('五檔'));
        expect(m.loads).toBe(0);
        expect(all('company-module-loading')).toHaveLength(0);
    });

    it('切到「公司」：載入中骨架；失敗只在分頁內容區顯示「載入失敗」＋重試；重試重新 import 後顯示並帶入合約；切換鍵隱藏但保留位置', async () => {
        await render();
        await press(btn('公司'));
        expect(m.loads).toBe(1);
        expect(btn('公司').props['aria-selected']).toBe(true);
        expect(all('company-module-loading')).toHaveLength(1);
        expect(all('company-module-loading')[0]!.props.role).toBe('status');
        expect(all('depth-ladder')).toHaveLength(0);
        // 整股／零股切換鍵：公司分頁不渲染，但保留空位（分頁寬度不跳動）
        expect(all('depth-odd-toggle')).toHaveLength(0);
        expect(all('trade-panel-row')[0]!.findAll(n => n.props.className === tradeStyles.oddToggleSlot)).toHaveLength(1);
        expectPageChromeIntact();

        await act(async () => { m.pending!.reject(new TypeError('Failed to fetch dynamically imported module: company-tab.js')); });
        await settle();
        expect(all('company-module-loading')).toHaveLength(0);
        expect(all('company-load-error')).toHaveLength(1);
        expect(text(all('company-load-error')[0]!)).toContain(MODULE_LOAD_ERROR_TEXT);
        expectPageChromeIntact();

        await press(all('company-load-error-retry')[0]!);
        expect(m.loads).toBe(2);
        expect(all('company-module-loading')).toHaveLength(1);
        await act(async () => {
            m.pending!.resolve({ CompanyTab: ({ contract, active }) => createElement('div', { 'data-testid': 'company-stub', 'data-active': String(active) }, contract?.code ?? '') });
        });
        await settle();
        expect(all('company-load-error')).toHaveLength(0);
        expect(all('company-stub')).toHaveLength(1);
        expect(text(all('company-stub')[0]!)).toBe('2330');
        expect(all('trade-company')[0]!.props.hidden).toBe(false);
        expect(m.openTicket).not.toHaveBeenCalled();
    });

    it('切回五檔再回公司：公司分頁保持掛載（hidden），不再 import；零股狀態保留', async () => {
        await render();
        await press(all('depth-odd-toggle')[0]!);
        expect(all('depth-odd-toggle')[0]!.props['aria-pressed']).toBe(true);
        await press(btn('公司'));
        await settle();
        expect(all('company-stub')).toHaveLength(1);
        expect(all('company-stub')[0]!.props['data-active']).toBe('true');
        await press(btn('五檔'));
        // 五檔顯示、公司分頁隱藏但仍掛載
        expect(all('depth-ladder')).toHaveLength(1);
        expect(all('trade-company')[0]!.props.hidden).toBe(true);
        expect(all('company-stub')).toHaveLength(1);
        // 隱藏時 active=false：公司分頁停止跟著成交重繪
        expect(all('company-stub')[0]!.props['data-active']).toBe('false');
        expect(all('depth-odd-toggle')[0]!.props['aria-pressed']).toBe(true);
        await press(btn('公司'));
        expect(all('trade-company')[0]!.props.hidden).toBe(false);
        expect(all('company-stub')[0]!.props['data-active']).toBe('true');
        expect(m.loads).toBe(2);
    });
});
