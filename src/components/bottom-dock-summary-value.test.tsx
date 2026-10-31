// fork：摘要列「總市值」＝Σ|股數|×現價，融券以正值計；缺價列略過並標示，不顯示 NaN。
// 全部為合成資料。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountedPosition } from '../lib/types/portfolio';

const h = vi.hoisted(() => ({ esun: { broker_id: '8840', account_id: 'T0001', account_type: 'S', signed: true, person_id: '', username: '' } }));
vi.mock('../lib/account-store', () => ({
    ensureAccounts: () => undefined,
    selectAccount: vi.fn(),
    useAccounts: () => ({ accounts: [h.esun], selectedStock: h.esun, selectedFutures: null, selectedAccount: h.esun, loaded: true }),
}));
vi.mock('../lib/trading-state', () => {
    const q = { updatedAt: 1, error: null, needsReconcile: false, reasons: [] };
    const state = { loading: false, funds: undefined, queries: { positions: q, orders: q, account: q } };
    return { RECONCILE_REASON_LABELS: {}, refreshTradingState: vi.fn(), useTradingState: () => state };
});
vi.mock('../lib/dock-events', () => ({ useOpenOrdersTabRequest: () => undefined }));
vi.mock('./bottom-dock-orders', () => ({ OrdersPane: () => null }));
vi.mock('./bottom-dock-positions', () => ({ PositionsPane: () => null }));
vi.mock('./bottom-dock-account', () => ({ AccountPane: () => null }));
import { BottomDock } from './bottom-dock';

const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const pos = (extra: Partial<AccountedPosition>): AccountedPosition => ({
    id: 1, code: '2603', direction: 'Buy', quantity: 2000, price: 200, last_price: 500, pnl: 0, yd_quantity: 2000, cond: 'Cash', account: h.esun, ...extra,
} as AccountedPosition);
const cash = pos({});
const short = pos({ id: 2, code: '1234', direction: 'Sell', cond: 'ShortSelling', price: 380.5, last_price: 392, pnl: -23000 });

const totalMarketValue = async (positions: AccountedPosition[]) => {
    await act(async () => { view = create(createElement(BottomDock, { positions, trades: [], onTradesChanged: vi.fn(), onSelectCode: vi.fn() })); });
    const label = view.root.findAll(n => n.type === 'span' && n.children.length === 1 && n.children[0] === '總市值')[0]!;
    return text(label.parent!);
};

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('counts short selling as positive market value', async () => {
    expect(await totalMarketValue([cash, short])).toContain('1,784,000');
});

it('short-only accounts show a positive total, never negative', async () => {
    const shown = await totalMarketValue([short]);
    expect(shown).toContain('784,000');
    expect(shown).not.toContain('-');
});

it('a row without a price is skipped and flagged instead of turning the total into NaN', async () => {
    const shown = await totalMarketValue([cash, pos({ id: 3, code: '6446', last_price: NaN })]);
    expect(shown).toContain('1,000,000');
    expect(shown).toContain('部分缺價');
    expect(shown).not.toContain('NaN');
});
