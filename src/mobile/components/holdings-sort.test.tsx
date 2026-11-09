// 自選頁「持倉」分段的檢視排序（components/holdings-list.tsx ＋ components/watch-sort.tsx；使用者要求「自選持倉也要有排序功能」）：
// - 預設「持倉順序」（合併順序）、不取快照；選項：持倉順序、股票代號、股價、漲幅%、漲跌；再點目前的選項＝反向。
// - 列以合併鍵（商品類別＋代碼）識別，同代碼不同類別各一列；股票代號以字串比較。
// - 股價類：1 次批次快照（只含已解析的合約）＋「排序依據 HH:MM:SS」＋［⟳］最短 5 秒；沒有資料的列不論方向都在最後。
// - 偏好存本裝置（同自選排序的 localStorage 鍵，清單 id 'pos:holdings'）。
// - S1：排序鍵、選項、⟳ 都不開下單面板、不送單；請求只有排序依據的快照。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase } from '../../lib/types/contract';
import type { AccountedPosition } from '../../lib/types/portfolio';

const m = vi.hoisted(() => ({
    state: {} as Record<string, unknown>,
    listeners: new Set<() => void>(),
    contracts: new Map<string, Record<string, unknown>>(),
    navigate: vi.fn(),
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    refreshTradingState: vi.fn(),
    ensureContract: vi.fn(),
    apiGet: vi.fn(),
    useQuote: vi.fn(() => undefined),
    shioaji: {
        fetchKbars: vi.fn(),
        fetchSnapshots: vi.fn(),
        fetchPositions: vi.fn(),
        resolveContract: vi.fn(),
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelOrders: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
    },
    trade: { placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn(), cancelAllOrders: vi.fn() },
}));

vi.mock('../../lib/trading-state', async () => {
    const { useSyncExternalStore } = await import('react');
    return {
        useTradingState: () => useSyncExternalStore(l => { m.listeners.add(l); return () => { m.listeners.delete(l); }; }, () => m.state),
        refreshTradingState: m.refreshTradingState,
        RECONCILE_REASON_LABELS: {},
    };
});
vi.mock('../../lib/contracts-cache', () => ({
    useContract: (code: string | null) => (code ? m.contracts.get(code) : undefined),
    ensureContract: m.ensureContract,
    getCachedContract: (code: string) => m.contracts.get(code),
}));
vi.mock('../../lib/privacy', () => ({ usePrivacyMoney: () => false, maskMoney: (t: string) => t }));
vi.mock('../../hooks/use-stream', () => ({ useQuote: m.useQuote }));
vi.mock('../../lib/shioaji', () => m.shioaji);
vi.mock('../../lib/trade', () => ({ ...m.trade, notify: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiGet: m.apiGet }));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));
vi.mock('../lib/mobile-store', () => ({ openTicket: m.openTicket, openOrderAction: m.openOrderAction }));
vi.mock('../motion/haptics', () => ({ haptic: vi.fn(() => false) }));

import { resetWatchPrefsForTest, setWatchSparklineEnabled } from '../lib/watch-prefs';
import { resetSortBasisForTest, SORT_STORAGE_KEY } from '../lib/watch-sort';
import { BottomSheet } from './bottom-sheet';
import { holdingSortItems, HoldingsList, HOLDINGS_SORT_ID, mergeHoldings } from './holdings-list';

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

const S1 = { account_type: 'S', broker_id: '9A95', account_id: '0001', person_id: 'A1', username: 'u', signed: true };
const F1 = { account_type: 'F', broker_id: 'F002', account_id: '0009', person_id: 'A1', username: 'u', signed: true };
const stock = (code: string) =>
    ({ id: 1, code, direction: 'Buy', quantity: 1000, price: 100, last_price: 0, pnl: 0, yd_quantity: 1000, cond: 'Cash', account: S1 }) as unknown as AccountedPosition;
const deriv = (code: string) =>
    ({ id: 2, code, direction: 'Buy', quantity: 1, price: 20000, last_price: 0, pnl: 0, account: F1 }) as unknown as AccountedPosition;
const contract = (code: string, name: string, security_type: string, exchange = 'TSE') => ({ code, name, security_type, exchange, reference: 100, target_code: null });
const snap = (code: string, close: number, change_price: number, change_rate: number) => ({ code, close, change_price, change_rate });

const query = () => ({ updatedAt: 1, loading: false, needsReconcile: false, error: null, reasons: [] });
const setTrading = (positions: AccountedPosition[]) => {
    m.state = { positions, trades: [], queries: { positions: query(), orders: query(), account: query() } };
    m.listeners.forEach(l => l());
};

// 合併順序：2330、TXFL6、00878、2317、9999（合約未解析）、1101（快照沒有成交）
const POSITIONS = [stock('2330'), deriv('TXFL6'), stock('00878'), stock('2317'), stock('9999'), stock('1101')];
const SNAPSHOTS = [
    snap('2330', 1000, 10, 1.01),
    snap('TXFL6', 20000, -100, -0.5),
    snap('00878', 21.5, 0.3, 1.41),
    snap('2317', 150, -3, -1.96),
    snap('1101', 0, 0, 0),
];

let view: ReactTestRenderer | undefined;
const render = () => act(async () => { view = create(createElement(HoldingsList, { metric: 'pct', onOpen: vi.fn() })); });
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const rowCodes = () => all('holding-row').map(r => r.props['data-code'] as string);
const press = (id: string) => act(async () => { all(id)[0]!.props.onClick(); });
const option = (key: string) => act(async () => { all(`watch-sort-option-${key}`)[0]!.findByType('button').props.onClick(); });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const choose = async (key: string) => { await press('watch-sort'); await option(key); await settle(); };
const sortSheet = () => view!.root.findAll(n => n.type === BottomSheet && n.props.testId === 'watch-sort-sheet')[0]!;
const stored = () => JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? 'null') as Record<string, unknown> | null;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-09T02:00:00Z')); // 台北 10:00:00
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', FakeIO);
    vi.stubGlobal('localStorage', new MemoryStorage());
    resetWatchPrefsForTest();
    resetSortBasisForTest();
    setWatchSparklineEnabled(false);
    m.contracts.clear();
    m.contracts.set('2330', contract('2330', '台積電', 'STK'));
    m.contracts.set('2317', contract('2317', '鴻海', 'STK'));
    m.contracts.set('00878', contract('00878', '國泰永續高股息', 'STK'));
    m.contracts.set('1101', contract('1101', '台泥', 'STK'));
    m.contracts.set('TXFL6', contract('TXFL6', '臺股期貨', 'FUT', 'TAIFEX'));
    for (const f of [m.navigate, m.openTicket, m.openOrderAction, m.refreshTradingState, m.ensureContract, m.apiGet, m.useQuote]) f.mockClear();
    for (const f of [...Object.values(m.shioaji), ...Object.values(m.trade)]) f.mockReset();
    m.shioaji.fetchSnapshots.mockImplementation(async (contracts: ContractBase[]) => SNAPSHOTS.filter(s => contracts.some(c => c.code === s.code)));
    setTrading(POSITIONS);
});
afterEach(async () => {
    // 請求：只有排序依據的快照；不讀持倉、不解析合約、不發其他 lib 請求
    expect(m.refreshTradingState).not.toHaveBeenCalled();
    expect(m.ensureContract).not.toHaveBeenCalled();
    expect(m.apiGet).not.toHaveBeenCalled();
    for (const [k, f] of Object.entries(m.shioaji)) if (k !== 'fetchSnapshots') expect(f, k).not.toHaveBeenCalled();
    // S1
    for (const [k, f] of Object.entries(m.trade)) expect(f, k).not.toHaveBeenCalled();
    expect(m.openTicket).not.toHaveBeenCalled();
    expect(m.openOrderAction).not.toHaveBeenCalled();
    expect(m.navigate).not.toHaveBeenCalled();
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('持倉排序', () => {
    it('預設持倉順序（合併順序）：不取快照、沒有排序依據列；選項為持倉順序、股票代號、股價、漲幅%、漲跌', async () => {
        await render();
        const button = all('watch-sort')[0]!;
        expect(button.props['data-sort']).toBe('manual:asc');
        expect(textOf(button)).toBe('持倉順序');
        expect(button.props['aria-label']).toBe('排序：持倉順序，持倉頁的順序；點按變更');
        expect(rowCodes()).toEqual(['2330', 'TXFL6', '00878', '2317', '9999', '1101']);
        expect(all('watch-sort-basis')).toHaveLength(0);
        expect(m.shioaji.fetchSnapshots).not.toHaveBeenCalled();

        await press('watch-sort');
        expect(sortSheet().props.open).toBe(true);
        const options = sortSheet().findAll(n => typeof n.type === 'string' && String(n.props['data-testid'] ?? '').startsWith('watch-sort-option-'));
        expect(options.map(n => n.props['data-testid'])).toEqual(['manual', 'code', 'price', 'pct', 'chg'].map(k => `watch-sort-option-${k}`));
        expect(textOf(options[0]!)).toContain('持倉順序');
        expect(textOf(options[0]!)).toContain('目前：持倉頁的順序');
        expect(textOf(sortSheet())).toContain('不會改動持倉');
    });

    it('股票代號：以字串比較（00878 在 1101 前、期貨代碼在數字後）；再點一次反向；不取快照', async () => {
        await render();
        await choose('code');
        expect(rowCodes()).toEqual(['00878', '1101', '2317', '2330', '9999', 'TXFL6']);
        expect(all('watch-sort')[0]!.props['data-sort']).toBe('code:asc');
        await choose('code');
        expect(rowCodes()).toEqual(['TXFL6', '9999', '2330', '2317', '1101', '00878']);
        expect(m.shioaji.fetchSnapshots).not.toHaveBeenCalled();
        // 回到持倉順序
        await choose('manual');
        expect(rowCodes()).toEqual(['2330', 'TXFL6', '00878', '2317', '9999', '1101']);
        expect(stored()).toEqual({ [HOLDINGS_SORT_ID]: { key: 'manual', dir: 'asc' } });
    });

    it('股價類：1 次批次快照（未解析的合約不送）、排序依據 HH:MM:SS；沒有資料的列不論方向都在最後；再點反向不重取', async () => {
        await render();
        await choose('price');
        expect(m.shioaji.fetchSnapshots).toHaveBeenCalledTimes(1);
        expect((m.shioaji.fetchSnapshots.mock.calls[0]![0] as ContractBase[]).map(c => c.code)).toEqual(['2330', 'TXFL6', '00878', '2317', '1101']);
        expect(rowCodes()).toEqual(['TXFL6', '2330', '2317', '00878', '9999', '1101']);
        expect(textOf(all('watch-sort-basis')[0]!)).toBe('排序依據 10:00:00');

        await choose('price');
        expect(all('watch-sort')[0]!.props['data-sort']).toBe('price:asc');
        expect(rowCodes()).toEqual(['00878', '2317', '2330', 'TXFL6', '9999', '1101']);

        await choose('pct');
        expect(rowCodes()).toEqual(['00878', '2330', 'TXFL6', '2317', '9999', '1101']);
        await choose('chg');
        expect(rowCodes()).toEqual(['2330', '00878', '2317', 'TXFL6', '9999', '1101']);
        await choose('chg');
        expect(rowCodes()).toEqual(['TXFL6', '2317', '00878', '2330', '9999', '1101']);
        // 5 秒內選其他股價類排序沿用同一份排序依據
        expect(m.shioaji.fetchSnapshots).toHaveBeenCalledTimes(1);
    });

    it('［⟳］：5 秒內停用；之後可按，重新取 1 次並更新時間與順序', async () => {
        await render();
        await choose('price');
        const refresh = () => view!.root.findAll(n => n.type === 'button' && n.props['data-testid'] === 'watch-sort-refresh')[0]!;
        expect(refresh().props.disabled).toBe(true);
        await act(async () => { vi.advanceTimersByTime(5_100); });
        expect(refresh().props.disabled).toBe(false);
        m.shioaji.fetchSnapshots.mockImplementation(async () => [snap('2317', 2000, 1, 0.05), snap('2330', 1000, 10, 1.01)]);
        await act(async () => { refresh().props.onClick(); });
        await settle();
        expect(m.shioaji.fetchSnapshots).toHaveBeenCalledTimes(2);
        expect(textOf(all('watch-sort-basis')[0]!)).toBe('排序依據 10:00:05');
        expect(rowCodes()).toEqual(['2317', '2330', 'TXFL6', '00878', '9999', '1101']);
    });

    it('偏好存在這台裝置（同自選排序的鍵、清單 id pos:holdings）：重新掛載沿用並取 1 次快照；不影響自選清單的偏好', async () => {
        localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ a: { key: 'code', dir: 'desc' } }));
        await render();
        await choose('pct');
        expect(stored()).toEqual({ a: { key: 'code', dir: 'desc' }, [HOLDINGS_SORT_ID]: { key: 'pct', dir: 'desc' } });
        await act(async () => view!.unmount());
        resetSortBasisForTest();
        await render();
        expect(all('watch-sort')[0]!.props['data-sort']).toBe('pct:desc');
        await settle();
        expect(m.shioaji.fetchSnapshots).toHaveBeenCalledTimes(2);
        expect(rowCodes()).toEqual(['00878', '2330', 'TXFL6', '2317', '9999', '1101']);
    });

    it('持倉增加：依同一份排序依據放進順序（沒有資料在最後），不自動重取', async () => {
        await render();
        await choose('price');
        m.contracts.set('2454', contract('2454', '聯發科', 'STK'));
        await act(async () => { setTrading([...POSITIONS, stock('2454')]); });
        await settle();
        expect(rowCodes()).toEqual(['TXFL6', '2330', '2317', '00878', '9999', '1101', '2454']);
        expect(m.shioaji.fetchSnapshots).toHaveBeenCalledTimes(1);
    });

    it('讀取失敗：顯示讀取失敗，列維持持倉順序（基準順序）', async () => {
        m.shioaji.fetchSnapshots.mockRejectedValue(new Error('503'));
        await render();
        await choose('price');
        expect(textOf(all('watch-sort-basis')[0]!)).toContain('排序資料讀取失敗');
        expect(rowCodes()).toEqual(['2330', 'TXFL6', '00878', '2317', '9999', '1101']);
    });
});

describe('排序項目', () => {
    it('id 為合併鍵：同代碼的股票帳戶與期貨帳戶持倉各一項；未解析的合約 resolved false', () => {
        const holdings = mergeHoldings([stock('X1'), deriv('X1'), stock('9999')]);
        const items = holdingSortItems(holdings, code => (code === 'X1' ? (contract('X1', 'x', 'STK') as unknown as ContractBase) : undefined));
        expect(items.map(i => [i.id, i.contract.code, i.resolved])).toEqual([['S:X1', 'X1', undefined], ['F:X1', 'X1', undefined], ['S:9999', '9999', false]]);
    });
});
