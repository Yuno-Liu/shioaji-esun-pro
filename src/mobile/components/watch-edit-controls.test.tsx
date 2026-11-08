// 多選刪除的請求數（真的 useWatchlist，經 WatchlistProvider；lib/shioaji 以假的取代並計數）：
// N 檔＝N ×（DELETE /watchlist/{id}/contracts ＋ GET /watchlist），不發其他請求；逐檔依序（前一檔的 GET 完成才送下一檔的 DELETE）。
// 另測 removeSummary 的文字。
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
    log: [] as string[],
}));
vi.mock('../../lib/shioaji', () => {
    const { log, ...fns } = api;
    void log;
    return fns;
});
vi.mock('../../lib/contracts-cache', () => ({ ensureContract: api.resolveContract, primeContract: vi.fn(), refreshCachedContracts: vi.fn() }));
vi.mock('../../lib/stream', () => ({ onContractEvent: () => () => undefined, registerCodeAlias: vi.fn() }));
vi.mock('../../lib/trade', () => ({ notify: vi.fn() }));

import { useMobileWatchlist, WatchlistProvider, type MobileWatchlist } from '../lib/watchlist-context';
import { removeSelected, removeSummary } from './watch-edit-controls';

type Base = { code: string; security_type: string; exchange: string };
let server: { id: string; name: string; contracts: Base[] }[] = [];
const base = (code: string): Base => ({ code, security_type: 'STK', exchange: 'TSE' });
const REQUEST_FNS = ['fetchWatchlists', 'fetchContractInfo', 'resolveContract', 'syncWatchlist', 'createWatchlist', 'renameWatchlist', 'deleteWatchlist', 'addWatchlistContracts', 'removeWatchlistContracts', 'fetchSnapshots'] as const;
const counts = () => Object.fromEntries(REQUEST_FNS.map(k => [k, api[k].mock.calls.length]));

let state!: MobileWatchlist;
function Probe() {
    state = useMobileWatchlist();
    return null;
}
let root: ReactTestRenderer | undefined;
const data = new Map<string, string>();

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
        { id: 'main', name: '主要', contracts: ['A', 'B', 'C', 'D'].map(base) },
        { id: 'watch', name: '觀察', contracts: [base('X')] },
    ];
    for (const k of REQUEST_FNS) api[k].mockReset();
    const info = async (code: string) => ({ code, name: code, security_type: 'STK', exchange: 'TSE', target_code: null });
    api.fetchContractInfo.mockImplementation(info);
    api.resolveContract.mockImplementation(info);
    api.fetchSnapshots.mockImplementation(async () => []);
    api.fetchWatchlists.mockImplementation(async () => {
        api.log.push('GET');
        return server.map(l => ({ ...l, contracts: [...l.contracts] }));
    });
    api.removeWatchlistContracts.mockImplementation(async (id: string, contracts: { code: string }[]) => {
        api.log.push(`DELETE ${id} ${contracts.map(c => c.code).join(',')}`);
        server = server.map(l => (l.id === id ? { ...l, contracts: l.contracts.filter(c => !contracts.some(x => x.code === c.code)) } : l));
    });
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    vi.unstubAllGlobals();
});

async function mount() {
    await act(async () => { root = create(createElement(WatchlistProvider, null, createElement(Probe))); });
    expect(state.items.map(i => i.contract.code)).toEqual(['A', 'B', 'C', 'D']);
    expect(state.loading).toBe(false);
}

/** 在 act 之外執行（hook 的狀態要能在各檔之間重繪），以 act 片段推進直到完成 */
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

describe('removeSelected（真的 useWatchlist）', () => {
    it('N 檔＝N ×（DELETE＋GET 清單），依序執行，沒有其他請求', async () => {
        await mount();
        const before = counts();
        api.log.length = 0;
        const progress: number[] = [];
        const result = await run(removeSelected(() => state, ['B', 'D', 'A'], n => progress.push(n)));
        expect(result).toEqual({ removed: 3, reason: null });
        expect(progress).toEqual([1, 2, 3]);
        expect(api.log).toEqual(['DELETE main B', 'GET', 'DELETE main D', 'GET', 'DELETE main A', 'GET']);
        const after = counts();
        const delta = Object.fromEntries(REQUEST_FNS.map(k => [k, after[k]! - before[k]!]).filter(([, n]) => n !== 0));
        expect(delta).toEqual({ removeWatchlistContracts: 3, fetchWatchlists: 3 });
        expect(state.items.map(i => i.contract.code)).toEqual(['C']);
        expect(server[0]!.contracts.map(c => c.code)).toEqual(['C']);
        // 其他清單不受影響
        expect(server[1]!.contracts.map(c => c.code)).toEqual(['X']);
    });

    it('DELETE 失敗：停止，回報已移除的檔數與原因；不再送後面的', async () => {
        await mount();
        api.removeWatchlistContracts.mockImplementation(async (id: string, contracts: { code: string }[]) => {
            api.log.push(`DELETE ${id} ${contracts.map(c => c.code).join(',')}`);
            if (contracts[0]!.code === 'B') throw new Error('HTTP 500');
            server = server.map(l => (l.id === id ? { ...l, contracts: l.contracts.filter(c => !contracts.some(x => x.code === c.code)) } : l));
        });
        api.log.length = 0;
        const result = await run(removeSelected(() => state, ['A', 'B', 'C'], () => undefined));
        expect(result).toEqual({ removed: 1, reason: 'HTTP 500' });
        expect(api.log).toEqual(['DELETE main A', 'GET', 'DELETE main B']);
    });

    it('已不在清單裡的代碼略過、不發請求', async () => {
        await mount();
        api.log.length = 0;
        const result = await run(removeSelected(() => state, ['Z', 'C'], () => undefined));
        expect(result).toEqual({ removed: 1, reason: null });
        expect(api.log).toEqual(['DELETE main C', 'GET']);
    });

    it('清單載入失敗時不開始', async () => {
        await mount();
        const failed = { ...state, loadError: true };
        api.log.length = 0;
        const result = await run(removeSelected(() => failed, ['A'], () => undefined));
        expect(result).toEqual({ removed: 0, reason: '自選清單載入失敗' });
        expect(api.log).toEqual([]);
    });
});

describe('removeSummary', () => {
    it('全部完成 ok；有未移除 err 並附原因', () => {
        expect(removeSummary({ removed: 3, reason: null }, 3, '主要')).toEqual({ kind: 'ok', title: '已從自選移除', body: '已從「主要」移除 3 檔' });
        expect(removeSummary({ removed: 1, reason: '自選清單更新中' }, 4, '主要')).toEqual({ kind: 'err', title: '多選刪除未完成', body: '已移除 1 檔，3 檔未移除：自選清單更新中' });
    });
});
