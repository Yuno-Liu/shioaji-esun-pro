// fork（D2-10）：持股類股只算頂欄對應的證券帳戶；歸屬不明的列不算進去
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';

const acct = (broker_id: string, account_id: string): Account =>
    ({ broker_id, account_id, account_type: 'S', signed: true, person_id: '', username: '' }) as Account;
const esun = acct('8840', '0000001');
const sino = acct('9A95', '1234567');
const row = (code: string, quantity: number, account?: Account) =>
    ({ id: 0, code, direction: 'Buy', quantity, yd_quantity: quantity, price: 100, last_price: 100, pnl: 0, cond: 'Cash', ...(account ? { account } : {}) });
const m = vi.hoisted(() => ({ positions: [] as unknown[] }));
vi.mock('./trading-state', () => ({
    useTradingState: () => ({ positions: m.positions, trades: [], queries: { positions: { updatedAt: 1, error: null } } }),
}));
import { useHoldings, type HoldingsState } from './portfolio-sector';

let view!: ReactTestRenderer;
let out!: HoldingsState;
function Probe({ account }: { account?: Account | null }) { out = useHoldings(account); return null; }

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.positions = [row('2330', 2, esun), row('2317', 3, sino), row('2454', 4)];
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('only the scoped account counts; rows without an owner are never attributed to it', async () => {
    await act(async () => { view = create(createElement(Probe, { account: esun })); });
    expect(out.holdings.map(x => x.code)).toEqual(['2330']);
    await act(async () => { view.update(createElement(Probe, { account: sino })); });
    expect(out.holdings.map(x => x.code)).toEqual(['2317']);
});

it('without an account (no stock account) it keeps the upstream all-accounts view', async () => {
    await act(async () => { view = create(createElement(Probe, { account: null })); });
    expect(out.holdings.map(x => x.code).sort()).toEqual(['2317', '2330', '2454']);
});
