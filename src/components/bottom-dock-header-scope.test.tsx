// fork（D2-06）：BottomDock 的帳戶範圍預設為頂欄帳號，但「開啟委託查詢（全部帳戶）」、
// 「顯示全部」與選單的「全部帳戶」都要真的顯示全部帳戶（不被 effect 鎖回頂欄帳號）。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';

const h = vi.hoisted(() => {
    const mk = (broker_id: string, account_id: string, account_type: 'S' | 'F') => ({ broker_id, account_id, account_type, signed: true, person_id: '', username: '' });
    return { esun: mk('8840', '0000001', 'S'), fut: mk('F002000', '7654321', 'F'), openOrders: null as null | (() => void), orders: [] as Record<string, unknown>[], select: vi.fn() };
});
vi.mock('../lib/account-store', () => ({
    ensureAccounts: () => undefined,
    selectAccount: h.select,
    useAccounts: () => ({ accounts: [h.esun, h.fut], selectedStock: h.esun, selectedFutures: h.fut, selectedAccount: h.esun, loaded: true }),
}));
vi.mock('../lib/trading-state', () => {
    const q = { updatedAt: 1, error: null, needsReconcile: false, reasons: [] };
    const state = { loading: false, funds: undefined, queries: { positions: q, orders: q, account: q } };
    return { RECONCILE_REASON_LABELS: {}, refreshTradingState: vi.fn(), useTradingState: () => state };
});
vi.mock('../lib/dock-events', () => ({ useOpenOrdersTabRequest: (cb: () => void) => { h.openOrders = cb; } }));
vi.mock('./bottom-dock-orders', () => ({ OrdersPane: (props: Record<string, unknown>) => { h.orders.push(props); return null; } }));
vi.mock('./bottom-dock-positions', () => ({ PositionsPane: () => null }));
vi.mock('./bottom-dock-account', () => ({ AccountPane: () => null }));
import { BottomDock } from './bottom-dock';

const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const accountSelect = () => view.root.findAllByType('select')[0]!;
const ordersScope = () => h.orders.at(-1)!.scopeKey;
const props = { positions: [], trades: [], onTradesChanged: vi.fn(), onSelectCode: vi.fn() };

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    h.orders.length = 0;
    h.openOrders = null;
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

const mountOnOrders = async () => {
    await act(async () => { view = create(createElement(BottomDock, props)); });
    const ordersTab = view.root.findAllByType('button').find(b => text(b).startsWith('委託 Orders'))!;
    await act(async () => { ordersTab.props.onClick(); });
};

it('defaults to the header account but the scope picker is usable and offers 全部帳戶', async () => {
    await mountOnOrders();
    expect(ordersScope()).toBe('8840-0000001');
    expect(accountSelect().props.disabled).toBeFalsy();
    expect(accountSelect().props.value).toBe('8840-0000001');
    await act(async () => { accountSelect().props.onChange({ target: { value: '' } }); });
    expect(ordersScope()).toBe('');
    await act(async () => { view.update(createElement(BottomDock, props)); });
    expect(ordersScope()).toBe('');
    // 全部帳戶 does not change the header/global selection
    expect(h.select).not.toHaveBeenCalled();
});

it('顯示全部 from the orders pane shows every account and stays that way', async () => {
    await mountOnOrders();
    await act(async () => { (h.orders.at(-1)!.onShowAll as () => void)(); });
    await act(async () => { view.update(createElement(BottomDock, props)); });
    expect(ordersScope()).toBe('');
});

it('the pending-confirmation card (開啟委託查詢・全部帳戶) is not forced back to the header account', async () => {
    await mountOnOrders();
    expect(ordersScope()).toBe('8840-0000001');
    await act(async () => { h.openOrders!(); });
    await act(async () => { view.update(createElement(BottomDock, props)); });
    expect(ordersScope()).toBe('');
});
