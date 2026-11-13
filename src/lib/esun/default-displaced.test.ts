// src/lib/esun/default-displaced.test.ts — 玉山帳戶晚到、存檔預設被頂替時只提示一次（default-displaced-notice），不改選取

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../types/portfolio';

const { fetchAccounts, notify } = vi.hoisted(() => ({ fetchAccounts: vi.fn(), notify: vi.fn() }));
vi.mock('../shioaji', () => ({ fetchAccounts }));
vi.mock('../trade', () => ({ notify }));

const store = new Map<string, string>();
let getItemThrows = false;
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => { if (getItemThrows) throw new Error('storage blocked'); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
};

const SELECTED = 'sj-pro-accounts-selected';
const sinopac: Account = { account_type: 'S', broker_id: '9A95', account_id: '0000001', person_id: 'P', signed: true, username: '永豐' };
const sinopac2: Account = { ...sinopac, account_id: '0000002' };
const esunProd: Account = { account_type: 'S', broker_id: '8840', account_id: '1234567', person_id: 'P', signed: true, username: '玉山' };
const esunSim: Account = { ...esunProd, broker_id: '8840-SIM' };
const keyOf = (a: Account) => `${a.broker_id}-${a.account_id}`;
const saved = () => JSON.parse(store.get(SELECTED) ?? '{}') as { stock?: string };
const save = (stock: string) => store.set(SELECTED, JSON.stringify({ stock, active: stock }));

/** bridge 回報指定環境與帳戶（線上券商代號 8840）：EsunTradeService 依環境重新編鍵後同步到帳戶清單 */
const driverFor = (environment: 'PRODUCTION' | 'SIMULATION', accounts: Account[]) => ({
    name: 'test-bridge',
    health: vi.fn(async () => ({
        ok: true, configured: true, problems: [], environment, entry: '', loggedIn: true, loginError: null,
        account: { broker_id: '8840', account_id: accounts[0]!.account_id },
        accounts: accounts.map(a => ({ ...a, broker_id: '8840' })),
    })),
});

let accountStore: typeof import('../account-store');
let service: import('./service').EsunTradeService;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(async () => {
    vi.resetModules();
    store.clear();
    getItemThrows = false;
    fetchAccounts.mockReset();
    notify.mockReset();
    accountStore = await import('../account-store');
    // 先載入提示模組：service 的動態載入在幾個 microtask 內完成，「不提示」的斷言不會因為還沒載完而誤過
    await import('./default-displaced-notice');
    const { EsunTradeService } = await import('./service');
    const { UnavailableEsunDriver } = await import('./http-driver');
    service = new EsunTradeService(new UnavailableEsunDriver());
});

/** 啟動時玉山未連線：只有永豐帳戶，記憶體選取頂替為永豐（不寫存檔） */
async function bootWithoutEsun(sinopacAccounts: Account[] = [sinopac]) {
    fetchAccounts.mockResolvedValue(sinopacAccounts);
    await accountStore.refreshAccounts();
}

async function esunArrives(environment: 'PRODUCTION' | 'SIMULATION', accounts: Account[]) {
    service.setDriver(driverFor(environment, accounts) as never);
    await service.refreshHealth();
    await flush();
}

describe('saved E.SUN default displaced by a late-arriving E.SUN account', () => {
    it('raises one info notice and changes neither the selection nor storage beyond the store sync', async () => {
        save(keyOf(esunProd));
        await bootWithoutEsun();
        expect(accountStore.getAccountState().selectedStock).toEqual(sinopac);
        expect(saved().stock).toBe(keyOf(esunProd));

        await esunArrives('PRODUCTION', [esunProd]);

        expect(accountStore.getAccountState().accounts).toEqual([sinopac, expect.objectContaining({ broker_id: '8840', account_id: esunProd.account_id })]);
        // 不自動改回：選取與存檔都是頂替帳戶（上游 replaceExternalAccountsForBroker 的結果）
        expect(accountStore.getAccountState().selectedStock).toEqual(sinopac);
        expect(saved().stock).toBe(keyOf(sinopac));
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith({
            kind: 'info',
            title: '玉山帳戶已恢復連線',
            body: '啟動時玉山未連線，下單帳戶已改用其他帳戶，預設也跟著改了。要用玉山下單，請點上方的帳戶列切換。',
        });
    });

    it('does not fire on a normal sync where the saved key is unchanged', async () => {
        save(keyOf(sinopac));
        await bootWithoutEsun();
        await esunArrives('PRODUCTION', [esunProd]);
        expect(saved().stock).toBe(keyOf(sinopac));
        expect(notify).not.toHaveBeenCalled();
    });

    it('does not fire when the user already picked the E.SUN account (saved key stays E.SUN)', async () => {
        await bootWithoutEsun();
        await esunArrives('PRODUCTION', [esunProd]);
        const listed = accountStore.getAccountState().accounts.find(a => a.broker_id === '8840')!;
        accountStore.selectAccount(listed);
        expect(saved().stock).toBe(keyOf(esunProd));
        notify.mockReset();
        // 玉山帳戶清單又變了（多一個帳戶）：再同步一次，記憶體選取（玉山）不變
        await esunArrives('PRODUCTION', [esunProd, { ...esunProd, account_id: '7654321' }]);
        expect(accountStore.getAccountState().accounts).toHaveLength(3);
        expect(saved().stock).toBe(keyOf(esunProd));
        expect(notify).not.toHaveBeenCalled();
    });

    it('does not fire when the saved key belongs to a non-E.SUN account', async () => {
        // 存檔的永豐帳戶不在清單：頂替為另一個永豐帳戶，存檔隨同步改寫，但那不是玉山預設
        save(keyOf(sinopac2));
        await bootWithoutEsun([sinopac]);
        await esunArrives('PRODUCTION', [esunProd]);
        expect(saved().stock).toBe(keyOf(sinopac));
        expect(notify).not.toHaveBeenCalled();
    });

    it('does not fire on an environment switch (saved key is the old environment E.SUN account)', async () => {
        save(keyOf(sinopac));
        await bootWithoutEsun();
        await esunArrives('SIMULATION', [esunProd]);
        const sim = accountStore.getAccountState().accounts.find(a => a.broker_id === '8840-SIM')!;
        accountStore.selectAccount(sim);
        expect(saved().stock).toBe(keyOf(esunSim));
        notify.mockReset();

        await esunArrives('PRODUCTION', [esunProd]);

        expect(saved().stock).toBe(keyOf(esunProd));
        expect(notify).not.toHaveBeenCalled();
    });

    it('fires only once per page session', async () => {
        save(keyOf(esunProd));
        await bootWithoutEsun();
        await esunArrives('PRODUCTION', [esunProd]);
        expect(notify).toHaveBeenCalledTimes(1);

        // 另一個視窗把玉山存回預設，之後玉山帳戶清單又變了：同樣被頂替，但不再提示
        save(keyOf(esunProd));
        const second: Account = { ...esunProd, account_id: '7654321' };
        await esunArrives('PRODUCTION', [esunProd, second]);
        expect(accountStore.getAccountState().accounts).toHaveLength(3);
        expect(saved().stock).toBe(keyOf(sinopac));
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('raises nothing and does not throw when storage reads throw', async () => {
        save(keyOf(esunProd));
        await bootWithoutEsun();
        getItemThrows = true;
        await expect(esunArrives('PRODUCTION', [esunProd])).resolves.toBeUndefined();
        expect(accountStore.getAccountState().accounts).toHaveLength(2);
        expect(accountStore.getAccountState().selectedStock).toEqual(sinopac);
        expect(notify).not.toHaveBeenCalled();
    });

    it('a failing notice is swallowed (no unhandled rejection)', async () => {
        notify.mockImplementation(() => { throw new Error('notice listener boom'); });
        save(keyOf(esunProd));
        await bootWithoutEsun();
        await expect(esunArrives('PRODUCTION', [esunProd])).resolves.toBeUndefined();
        expect(notify).toHaveBeenCalledTimes(1);
    });
});
