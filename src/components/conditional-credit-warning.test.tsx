// 條件單表單的融券提醒（合成資料，不送任何委託）
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
const S: Account = { account_type: 'S', broker_id: 'bs', account_id: 's1', person_id: '', signed: true, username: '' };
const m = vi.hoisted(() => ({ positions: [] as AccountedPosition[] }));
vi.mock('../lib/trading-state', () => ({ getTradingState: () => ({ positions: m.positions }), subscribeTradingState: () => () => undefined }));
import { CashCreditWarning } from './conditional-credit-warning';
let view: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('warns on a 現股 buy trigger when the account holds a short of the code', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.positions = [{ account: S, code: '1234', id: 1, direction: 'Sell', quantity: 2000, price: 380.5, last_price: 392, pnl: 0, yd_quantity: 2000, cond: 'ShortSelling' }];
    await act(async () => { view = create(createElement(CashCreditWarning, { account: S, code: '1234', actions: ['Buy'] })); });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(JSON.stringify(view!.toJSON())).toContain('現股買進不會回補融券');
    await act(async () => { view!.update(createElement(CashCreditWarning, { account: S, code: '1234', actions: ['Sell'] })); });
    expect(view!.toJSON()).toBeNull();
});
