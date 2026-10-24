// fork（D2-06）：Dock 帳戶範圍預設跟隨頂欄，但「全部帳戶」不會被蓋回頂欄帳號
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';

const acct = (broker_id: string, account_id: string, account_type: 'S' | 'F'): Account =>
    ({ broker_id, account_id, account_type, signed: true, person_id: '', username: '' }) as Account;
const esun = acct('8840', '0000001', 'S');
const fut = acct('F002000', '7654321', 'F');
const m = vi.hoisted(() => ({ header: null as unknown }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [], selectedAccount: m.header, selectedStock: null, selectedFutures: null }) }));
import { useHeaderDefaultScope } from './bottom-dock-scope';

let view!: ReactTestRenderer;
const seen: string[] = [];
let setScope!: (scope: string) => void;
function Probe() {
    const [scope, set] = useHeaderDefaultScope();
    seen.push(scope);
    setScope = set;
    return null;
}
const rerender = async () => { await act(async () => { view.update(createElement(Probe)); }); };

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); seen.length = 0; m.header = esun; });
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('defaults to the header account and keeps an explicit 全部帳戶 choice', async () => {
    await act(async () => { view = create(createElement(Probe)); });
    expect(seen.at(-1)).toBe('8840-0000001');
    // 開啟委託查詢（全部帳戶）／顯示全部 → ''
    await act(async () => { setScope(''); });
    expect(seen.at(-1)).toBe('');
    // later renders (any store emit) must not force it back
    await rerender();
    await rerender();
    expect(seen.at(-1)).toBe('');
});

it('a header switch resets the default in the same render (no render with the old scope)', async () => {
    await act(async () => { view = create(createElement(Probe)); });
    await act(async () => { setScope(''); });
    seen.length = 0;
    m.header = fut;
    await rerender();
    expect(seen).not.toContain('');
    expect(seen.at(-1)).toBe('F002000-7654321');
});

it('no header account → all accounts', async () => {
    m.header = null;
    await act(async () => { view = create(createElement(Probe)); });
    expect(seen.at(-1)).toBe('');
});
