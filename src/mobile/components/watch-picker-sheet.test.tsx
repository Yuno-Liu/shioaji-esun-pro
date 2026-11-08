// ☆「加入自選」套用（applyWatchPicks）的請求數：真的 useWatchlist（經 WatchlistProvider），lib/shioaji 以假的取代並計數；
// 重新讀取事件用真的 lib/watchlist-sync（window 以 EventTarget 替身）。
// - 目前清單：hook 的 addSymbol／removeSymbol ＝ POST 或 DELETE 一次＋GET 清單一次（帶已載入的合約，不解析合約）；
//   加入時 hook 另為新列讀一次快照（attachSnapshots，上游既有行為）。
// - 其他清單：各一次 POST 或 DELETE（lib addWatchlistContracts／removeWatchlistContracts）。
// - 有改到其他清單時最後重新讀取一次：GET 清單＋重新載入目前清單（每檔一次合約資訊＋一次快照）。
// 另測 pickSummary 的文字。
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

import type { ContractInfo } from '../../lib/types/contract';
import { useMobileWatchlist, WatchlistProvider, type MobileWatchlist } from '../lib/watchlist-context';
import { applyWatchPicks, inList, pickSummary } from './watch-picker-sheet';

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

describe('applyWatchPicks（真的 useWatchlist）', () => {
    it('目前清單＋兩個其他清單：POST＋GET（＋新列快照）、DELETE、POST，最後重新讀取一次（GET＋目前清單每檔合約資訊＋快照）', async () => {
        await mount();
        const before = counts();
        api.log.length = 0;
        const c = contract('C');
        const result = await run(applyWatchPicks(state, c, [
            { list: { id: 'other', name: '短線' }, add: false },
            { list: { id: 'watch', name: '觀察' }, add: true },
            { list: { id: 'main', name: '主要' }, add: true },
        ]));
        await flush();
        expect(result).toEqual({ added: 2, removed: 1, failed: [] });
        // 目前清單先做（hook 的佇列；加入時另讀新列的快照），其他清單依傳入順序，最後重新讀取一次
        expect(api.log).toEqual([
            'POST main C', 'SNAPSHOTS', 'GET',
            'DELETE other C',
            'POST watch C',
            'GET', 'INFO A', 'INFO B', 'INFO C', 'SNAPSHOTS',
        ]);
        expect(delta(before)).toEqual({
            addWatchlistContracts: 2,
            removeWatchlistContracts: 1,
            fetchWatchlists: 2,
            fetchContractInfo: 3,
            fetchSnapshots: 2,
        });
        // 目前清單的 POST 帶已載入的合約（不解析合約）
        expect(api.addWatchlistContracts).toHaveBeenCalledWith('main', [c]);
        expect(api.resolveContract).not.toHaveBeenCalled();
        expect(lists('main')).toEqual(['A', 'B', 'C']);
        expect(lists('watch')).toEqual(['X', 'C']);
        expect(lists('other')).toEqual([]);
        // 重新讀取後畫面與伺服器一致
        expect(state.items.map(i => i.contract.code)).toEqual(['A', 'B', 'C']);
        expect(state.serverLists.map(l => [l.id, l.contracts.map(x => x.code)])).toEqual([['main', ['A', 'B', 'C']], ['watch', ['X', 'C']], ['other', []]]);
        expect(state.loading).toBe(false);
    });

    it('只改目前清單：DELETE＋GET，不重新讀取', async () => {
        await mount();
        const before = counts();
        api.log.length = 0;
        const result = await run(applyWatchPicks(state, contract('B'), [{ list: { id: 'main', name: '主要' }, add: false }]));
        await flush();
        expect(result).toEqual({ added: 0, removed: 1, failed: [] });
        expect(api.log).toEqual(['DELETE main B', 'GET']);
        expect(delta(before)).toEqual({ removeWatchlistContracts: 1, fetchWatchlists: 1 });
    });

    it('其他清單失敗：記錄失敗、照做其餘，仍重新讀取一次', async () => {
        await mount();
        api.addWatchlistContracts.mockImplementationOnce(async (id: string) => {
            api.log.push(`POST ${id} (fail)`);
            throw new Error('HTTP 500');
        });
        api.log.length = 0;
        const result = await run(applyWatchPicks(state, contract('C'), [
            { list: { id: 'watch', name: '觀察' }, add: true },
            { list: { id: 'other', name: '短線' }, add: false },
        ]));
        await flush();
        expect(result).toEqual({ added: 0, removed: 1, failed: [{ name: '觀察', add: true, reason: 'HTTP 500' }] });
        expect(api.log).toEqual(['POST watch (fail)', 'DELETE other C', 'GET', 'INFO A', 'INFO B', 'SNAPSHOTS']);
    });
});

describe('inList／pickSummary', () => {
    it('以代碼＋商品類別比對', () => {
        expect(inList({ contracts: [{ code: '2330', security_type: 'STK', exchange: 'TSE' }] }, { code: '2330', security_type: 'STK' })).toBe(true);
        expect(inList({ contracts: [{ code: '2330', security_type: 'STK', exchange: 'TSE' }] }, { code: '2330', security_type: 'FUT' })).toBe(false);
    });

    it('全部成功 ok；有失敗時列出清單與原因', () => {
        expect(pickSummary('2330 台積電', { added: 2, removed: 1, failed: [] })).toEqual({ kind: 'ok', title: '自選已更新', body: '2330 台積電：已加入 2 個清單、移出 1 個清單' });
        expect(pickSummary('2330', { added: 1, removed: 0, failed: [{ name: '觀察', add: false, reason: 'HTTP 500' }] }))
            .toEqual({ kind: 'err', title: '自選部分未更新', body: '2330：已加入 1 個清單；「觀察」移出失敗：HTTP 500' });
        expect(pickSummary('2330', { added: 0, removed: 0, failed: [{ name: '觀察', add: true, reason: 'x' }] }).title).toBe('自選更新失敗');
    });
});
