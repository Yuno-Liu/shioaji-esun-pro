// 排序群組面板的多選刪除群組（deleteGroups）的請求數：真的 useWatchlist（經 WatchlistProvider），lib/shioaji 以假的取代並計數；
// 重新讀取事件用真的 lib/watchlist-sync（window 以 EventTarget 替身）。
// - 非目前群組：lib deleteWatchlist，每個 1 次 DELETE；最後 hook 仍有它們時重新讀取一次（GET 清單＋目前清單每檔合約資訊＋快照）。
// - 目前群組：最後以 hook 的 deleteCurrentList（DELETE＋GET 清單，再切到伺服器順序第一個清單並載入：每檔合約資訊＋快照）；
//   這次 GET 已是伺服器最新狀態，不再另外重新讀取。
// - 全部選取、hook 忙碌：0 個請求；已消失的略過；失敗即停止並重新讀取。另測 groupDeleteSummary／groupDeleteBlocked。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
    fetchWatchlists: vi.fn(),
    fetchContractInfo: vi.fn(),
    resolveContract: vi.fn(),
    syncWatchlist: vi.fn(),
    createWatchlist: vi.fn(),
    renameWatchlist: vi.fn(),
    deleteWatchlist: vi.fn(),
    addWatchlistContracts: vi.fn(),
    removeWatchlistContracts: vi.fn(),
    fetchSnapshots: vi.fn(),
    notify: vi.fn(),
    log: [] as string[],
}));
vi.mock('../../lib/shioaji', () => {
    const { log, notify, ...fns } = api;
    void log;
    void notify;
    return fns;
});
vi.mock('../../lib/contracts-cache', () => ({ ensureContract: api.resolveContract, primeContract: vi.fn(), refreshCachedContracts: vi.fn() }));
vi.mock('../../lib/stream', () => ({ onContractEvent: () => () => undefined, registerCodeAlias: vi.fn() }));
vi.mock('../../lib/trade', () => ({ notify: api.notify }));

import type { ContractInfo } from '../../lib/types/contract';
import { getLatestMobileWatchlist, useMobileWatchlist, WatchlistProvider, type MobileWatchlist } from '../lib/watchlist-context';
import { deleteGroups, groupDeleteBlocked, groupDeleteSummary } from './watch-edit-controls';

type Base = { code: string; security_type: string; exchange: string };
let server: { id: string; name: string; contracts: Base[] }[] = [];
const base = (code: string): Base => ({ code, security_type: 'STK', exchange: 'TSE' });
const contract = (code: string) => ({ code, name: code, security_type: 'STK', exchange: 'TSE', target_code: null }) as unknown as ContractInfo;
const REQUEST_FNS = ['fetchWatchlists', 'fetchContractInfo', 'resolveContract', 'syncWatchlist', 'createWatchlist', 'renameWatchlist', 'deleteWatchlist', 'addWatchlistContracts', 'removeWatchlistContracts', 'fetchSnapshots'] as const;
const counts = () => Object.fromEntries(REQUEST_FNS.map(k => [k, api[k].mock.calls.length]));
const delta = (before: Record<string, number>) => {
    const after = counts();
    return Object.fromEntries(REQUEST_FNS.map(k => [k, after[k]! - before[k]!]).filter(([, n]) => n !== 0));
};

let state!: MobileWatchlist;
function Probe() {
    state = useMobileWatchlist();
    return null;
}
let root: ReactTestRenderer | undefined;
const data = new Map<string, string>();
const lists = (id: string) => server.find(l => l.id === id)!.contracts.map(c => c.code);

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
    });
    data.clear();
    api.log.length = 0;
    server = [
        { id: 'main', name: '主要', contracts: [base('A'), base('B')] },
        { id: 'watch', name: '觀察', contracts: [base('X')] },
        { id: 'other', name: '短線', contracts: [base('C')] },
    ];
    for (const k of REQUEST_FNS) api[k].mockReset();
    const info = async (code: string) => {
        api.log.push(`INFO ${code}`);
        return contract(code);
    };
    api.fetchContractInfo.mockImplementation(info);
    api.resolveContract.mockImplementation(info);
    api.fetchSnapshots.mockImplementation(async () => {
        api.log.push('SNAPSHOTS');
        return [];
    });
    api.fetchWatchlists.mockImplementation(async () => {
        api.log.push('GET');
        return server.map(l => ({ ...l, contracts: [...l.contracts] }));
    });
    api.addWatchlistContracts.mockImplementation(async (id: string, cs: { code: string }[]) => {
        api.log.push(`POST ${id} ${cs.map(c => c.code).join(',')}`);
        server = server.map(l => (l.id === id ? { ...l, contracts: [...l.contracts, ...cs.map(c => base(c.code))] } : l));
        return server.find(l => l.id === id);
    });
    api.removeWatchlistContracts.mockImplementation(async (id: string, cs: { code: string }[]) => {
        api.log.push(`DELETE ${id} ${cs.map(c => c.code).join(',')}`);
        server = server.map(l => (l.id === id ? { ...l, contracts: l.contracts.filter(c => !cs.some(x => x.code === c.code)) } : l));
        return server.find(l => l.id === id);
    });
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    vi.unstubAllGlobals();
});

async function mount() {
    await act(async () => { root = create(createElement(WatchlistProvider, null, createElement(Probe))); });
    expect(state.activeListId).toBe('main');
    expect(state.items.map(i => i.contract.code)).toEqual(['A', 'B']);
    expect(state.loading).toBe(false);
}

/** 以 act 片段推進直到 promise 完成（hook 的重新讀取在事件後非同步進行） */
async function run<T>(p: Promise<T>): Promise<T> {
    let done = false;
    let value!: T;
    void p.then(v => { done = true; value = v; });
    for (const end = Date.now() + 10_000; !done && Date.now() < end;) {
        await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    }
    expect(done).toBe(true);
    return value;
}
const flush = async () => {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 5)); });
};

const ids = () => state.serverLists.map(l => l.id);
const P = (id: string, name: string) => ({ id, name });

describe('deleteGroups（真的 useWatchlist）', () => {
    beforeEach(() => {
        api.notify.mockReset();
        api.deleteWatchlist.mockImplementation(async (id: string) => {
            api.log.push(`DELETE ${id}`);
            server = server.filter(l => l.id !== id);
        });
    });

    it('刪 2 個非目前群組：恰好 2 次 DELETE，最後重新讀取一次（GET 清單＋目前清單每檔合約資訊＋快照）', async () => {
        await mount();
        const before = counts();
        api.log.length = 0;
        const progress: number[] = [];
        const r = await run(deleteGroups(() => state, [P('other', '短線'), P('watch', '觀察')], n => progress.push(n)));
        await flush();
        expect(r).toEqual({ deleted: ['短線', '觀察'], ids: ['other', 'watch'], skipped: [], reason: null, switchedTo: null });
        expect(progress).toEqual([1, 2]);
        expect(api.log).toEqual(['DELETE other', 'DELETE watch', 'GET', 'INFO A', 'INFO B', 'SNAPSHOTS']);
        expect(delta(before)).toEqual({ deleteWatchlist: 2, fetchWatchlists: 1, fetchContractInfo: 2, fetchSnapshots: 1 });
        expect(ids()).toEqual(['main']);
        expect(state.activeListId).toBe('main');
        expect(state.items.map(i => i.contract.code)).toEqual(['A', 'B']);
        expect(groupDeleteSummary(r, 2, '主要')).toEqual({ kind: 'ok', title: '已刪除 2 個群組', body: '短線、觀察。' });
        expect(api.notify).not.toHaveBeenCalled();
    });

    it('刪目前群組＋另 1 個：DELETE 另一個 → hook DELETE 目前＋GET 清單 → 切到伺服器順序第一個清單並載入（每檔合約資訊＋快照）；不另外重新讀取', async () => {
        await mount();
        const before = counts();
        api.log.length = 0;
        const r = await run(deleteGroups(() => state, [P('main', '主要'), P('other', '短線')], () => undefined));
        await flush();
        expect(r).toEqual({ deleted: ['短線', '主要'], ids: ['other', 'main'], skipped: [], reason: null, switchedTo: '觀察' });
        expect(api.log).toEqual(['DELETE other', 'DELETE main', 'GET', 'INFO X', 'SNAPSHOTS']);
        expect(delta(before)).toEqual({ deleteWatchlist: 2, fetchWatchlists: 1, fetchContractInfo: 1, fetchSnapshots: 1 });
        expect(ids()).toEqual(['watch']);
        expect(state.activeListId).toBe('watch');
        expect(state.items.map(i => i.contract.code)).toEqual(['X']);
        // hook 自己發一則「已刪除清單」；摘要再一則（寫明切換到哪個群組）
        expect(api.notify).toHaveBeenCalledTimes(1);
        expect(api.notify.mock.calls[0]![0]).toMatchObject({ title: '已刪除清單' });
        expect(groupDeleteSummary(r, 2, '主要')).toEqual({ kind: 'ok', title: '已刪除 2 個群組', body: '短線、主要。已切換到「觀察」。' });
    });

    it('面板在流程中途卸載（自己的狀態停在舊值）：改讀常駐 Provider 的最新狀態，刪目前群組＋另 1 個仍正確判斷與回報', async () => {
        await mount();
        // 刪目前群組會切換清單並結束編輯模式，面板被卸載後自己的 latest 不再更新（瀏覽器實測發現誤報「更新中」）
        const frozen = state;
        expect(getLatestMobileWatchlist()).toBe(state);
        const r = await run(deleteGroups(() => getLatestMobileWatchlist() ?? frozen, [P('main', '主要'), P('other', '短線')], () => undefined));
        await flush();
        expect(r).toEqual({ deleted: ['短線', '主要'], ids: ['other', 'main'], skipped: [], reason: null, switchedTo: '觀察' });
        expect(getLatestMobileWatchlist()?.activeListId).toBe('watch');
    });

    it('getLatestMobileWatchlist：Provider 卸載後為 null', async () => {
        await mount();
        expect(getLatestMobileWatchlist()).not.toBeNull();
        await act(async () => { root?.unmount(); });
        root = undefined;
        expect(getLatestMobileWatchlist()).toBeNull();
    });

    it('只刪目前群組：摘要為 null（hook 的「已刪除清單」已足夠）', async () => {
        await mount();
        api.log.length = 0;
        const r = await run(deleteGroups(() => state, [P('main', '主要')], () => undefined));
        await flush();
        expect(api.log).toEqual(['DELETE main', 'GET', 'INFO X', 'SNAPSHOTS']);
        expect(groupDeleteSummary(r, 1, '主要')).toBeNull();
        expect(api.notify).toHaveBeenCalledTimes(1);
    });

    it('全部選取：不開始（至少保留一個），0 個請求', async () => {
        await mount();
        api.log.length = 0;
        const r = await run(deleteGroups(() => state, [P('main', '主要'), P('watch', '觀察'), P('other', '短線')], () => undefined));
        expect(r.reason).toBe('至少要保留一個群組');
        expect(r.deleted).toEqual([]);
        expect(api.log).toEqual([]);
        expect(groupDeleteBlocked(3, 3, state)).toBe('至少要保留一個群組');
        expect(groupDeleteBlocked(0, 3, state)).toBe('請選取要刪除的群組');
        expect(groupDeleteBlocked(1, 3, { ...state, loading: true })).toBe('自選清單更新中');
        expect(groupDeleteBlocked(1, 3, { ...state, loadError: true })).toBe('自選清單載入失敗');
        expect(groupDeleteBlocked(2, 3, state)).toBeNull();
    });

    it('hook 忙碌或載入失敗：不開始，0 個請求', async () => {
        await mount();
        api.log.length = 0;
        for (const over of [{ structureBusy: true }, { loading: true }, { loadError: true }]) {
            const r = await run(deleteGroups(() => ({ ...state, ...over }), [P('watch', '觀察')], () => undefined));
            expect(r.reason, JSON.stringify(over)).toBe(over.loadError ? '自選清單載入失敗' : '自選清單更新中');
        }
        expect(api.log).toEqual([]);
    });

    it('執行前已消失的群組：略過並說明，其餘照做', async () => {
        await mount();
        api.log.length = 0;
        const r = await run(deleteGroups(() => state, [P('gone', '已刪'), P('watch', '觀察')], () => undefined));
        await flush();
        expect(r).toMatchObject({ deleted: ['觀察'], skipped: ['已刪'], reason: null });
        expect(api.log).toEqual(['DELETE watch', 'GET', 'INFO A', 'INFO B', 'SNAPSHOTS']);
        expect(groupDeleteSummary(r, 2, '主要')).toEqual({ kind: 'ok', title: '已刪除 1 個群組', body: '觀察。「已刪」已不存在，略過。' });
        expect(groupDeleteSummary({ deleted: [], ids: [], skipped: ['已刪'], reason: null, switchedTo: null }, 1, '主要'))
            .toEqual({ kind: 'info', title: '沒有刪除群組', body: '「已刪」已不存在，略過。' });
    });

    it('刪除失敗：停止（後面的與目前群組都不刪），重新讀取一次讓畫面與伺服器一致，通知說明', async () => {
        await mount();
        api.deleteWatchlist.mockImplementation(async (id: string) => {
            api.log.push(`DELETE ${id}`);
            if (id === 'watch') throw new Error('HTTP 500');
            server = server.filter(l => l.id !== id);
        });
        api.log.length = 0;
        const r = await run(deleteGroups(() => state, [P('main', '主要'), P('watch', '觀察')], () => undefined));
        await flush();
        expect(r).toMatchObject({ deleted: [], reason: '「觀察」HTTP 500' });
        expect(api.log).toEqual(['DELETE watch', 'GET', 'INFO A', 'INFO B', 'SNAPSHOTS']);
        expect(ids()).toEqual(['main', 'watch', 'other']);
        expect(groupDeleteSummary(r, 2, '主要')).toEqual({ kind: 'err', title: '群組刪除未完成', body: '已刪除 0 個，2 個未刪除：「觀察」HTTP 500。' });
    });

    it('第二個失敗：第一個已刪，停止並重新讀取', async () => {
        await mount();
        api.deleteWatchlist.mockImplementation(async (id: string) => {
            api.log.push(`DELETE ${id}`);
            if (id === 'watch') throw new Error('HTTP 500');
            server = server.filter(l => l.id !== id);
        });
        api.log.length = 0;
        const r = await run(deleteGroups(() => state, [P('other', '短線'), P('watch', '觀察')], () => undefined));
        await flush();
        expect(r).toMatchObject({ deleted: ['短線'], reason: '「觀察」HTTP 500' });
        expect(api.log).toEqual(['DELETE other', 'DELETE watch', 'GET', 'INFO A', 'INFO B', 'SNAPSHOTS']);
        expect(ids()).toEqual(['main', 'watch']);
        expect(groupDeleteSummary(r, 2, '主要')!.body).toBe('已刪除 1 個，1 個未刪除：「觀察」HTTP 500。');
    });
});
