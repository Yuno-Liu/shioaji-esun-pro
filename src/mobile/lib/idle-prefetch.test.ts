// 閒置預載排程（稽核 P10）：逐一執行、每個一個 idle callback（沒有時 setTimeout 間隔）、前一個結束才排下一個；
// 失敗只當作結束；取消後不再排；省流量／慢速網路判斷
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constrainedNetwork, currentConnection, PREFETCH_GAP_MS, PREFETCH_IDLE_TIMEOUT_MS, schedulePrefetchSequence } from './idle-prefetch';

function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('schedulePrefetchSequence（沒有 requestIdleCallback）', () => {
    it('第一個立即執行；前一個結束後間隔 PREFETCH_GAP_MS 才執行下一個（同一時間只有一個在載入）', async () => {
        const calls: string[] = [];
        const d = [deferred(), deferred(), deferred()];
        const tasks = d.map((x, i) => () => { calls.push(`t${i}`); return x.promise; });
        schedulePrefetchSequence(tasks);
        expect(calls).toEqual(['t0']);
        // t0 尚未結束：再久也不發出 t1
        await vi.advanceTimersByTimeAsync(PREFETCH_GAP_MS * 5);
        expect(calls).toEqual(['t0']);
        d[0]!.resolve();
        await flush();
        await vi.advanceTimersByTimeAsync(PREFETCH_GAP_MS - 1);
        expect(calls).toEqual(['t0']);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toEqual(['t0', 't1']);
        d[1]!.resolve();
        await flush();
        await vi.advanceTimersByTimeAsync(PREFETCH_GAP_MS);
        expect(calls).toEqual(['t0', 't1', 't2']);
    });

    it('reject 或同步丟例外都只當作結束，繼續下一個', async () => {
        const calls: string[] = [];
        const tasks = [
            () => { calls.push('a'); return Promise.reject(new TypeError('Failed to fetch dynamically imported module')); },
            () => { calls.push('b'); throw new Error('sync'); },
            () => { calls.push('c'); return Promise.resolve(); },
        ];
        schedulePrefetchSequence(tasks);
        await vi.advanceTimersByTimeAsync(PREFETCH_GAP_MS * 3);
        expect(calls).toEqual(['a', 'b', 'c']);
    });

    it('取消後不再排下一個（已發出的不受影響）', async () => {
        const calls: string[] = [];
        const tasks = ['a', 'b', 'c'].map(k => () => { calls.push(k); return Promise.resolve(); });
        const cancel = schedulePrefetchSequence(tasks);
        await flush();
        expect(calls).toEqual(['a']);
        cancel();
        await vi.advanceTimersByTimeAsync(PREFETCH_GAP_MS * 10);
        expect(calls).toEqual(['a']);
    });

    it('空清單不做事', () => {
        expect(() => schedulePrefetchSequence([])()).not.toThrow();
    });
});

describe('schedulePrefetchSequence（有 requestIdleCallback）', () => {
    function idleStub() {
        const queue: { id: number; cb: () => void; opts?: { timeout: number } }[] = [];
        let next = 1;
        const requestIdleCallback = vi.fn((cb: () => void, opts?: { timeout: number }) => { const id = next++; queue.push({ id, cb, opts }); return id; });
        const cancelIdleCallback = vi.fn((id: number) => { const i = queue.findIndex(q => q.id === id); if (i >= 0) queue.splice(i, 1); });
        vi.stubGlobal('requestIdleCallback', requestIdleCallback);
        vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);
        const runIdle = () => { const q = queue.shift(); q?.cb(); return q; };
        return { queue, requestIdleCallback, cancelIdleCallback, runIdle };
    }

    it('每個 task 各自一個 idle callback（帶 timeout），一個 callback 只執行一個 task', async () => {
        const idle = idleStub();
        const calls: string[] = [];
        const tasks = ['a', 'b', 'c'].map(k => () => { calls.push(k); return Promise.resolve(); });
        schedulePrefetchSequence(tasks);
        expect(calls).toEqual([]);
        expect(idle.requestIdleCallback).toHaveBeenCalledTimes(1);
        expect(idle.queue[0]!.opts).toEqual({ timeout: PREFETCH_IDLE_TIMEOUT_MS });
        idle.runIdle();
        expect(calls).toEqual(['a']);
        // 下一個在 a 的 promise 結束後才排
        expect(idle.queue).toHaveLength(0);
        await flush();
        expect(idle.queue).toHaveLength(1);
        idle.runIdle();
        expect(calls).toEqual(['a', 'b']);
        await flush();
        idle.runIdle();
        await flush();
        expect(calls).toEqual(['a', 'b', 'c']);
        expect(idle.requestIdleCallback).toHaveBeenCalledTimes(3);
        expect(idle.queue).toHaveLength(0);
    });

    it('取消時清掉尚未執行的 idle callback', async () => {
        const idle = idleStub();
        const calls: string[] = [];
        const cancel = schedulePrefetchSequence([() => { calls.push('a'); return Promise.resolve(); }]);
        cancel();
        expect(idle.cancelIdleCallback).toHaveBeenCalledTimes(1);
        expect(idle.queue).toHaveLength(0);
        expect(calls).toEqual([]);
    });
});

describe('constrainedNetwork', () => {
    it('省流量或 2g／3g（含 slow-2g）為受限；4g、未知或不支援 API 時不受限', () => {
        expect(constrainedNetwork({ saveData: true })).toBe(true);
        expect(constrainedNetwork({ saveData: true, effectiveType: '4g' })).toBe(true);
        expect(constrainedNetwork({ effectiveType: '3g' })).toBe(true);
        expect(constrainedNetwork({ effectiveType: '2g' })).toBe(true);
        expect(constrainedNetwork({ effectiveType: 'slow-2g' })).toBe(true);
        expect(constrainedNetwork({ effectiveType: '4g' })).toBe(false);
        expect(constrainedNetwork({ saveData: false })).toBe(false);
        expect(constrainedNetwork({})).toBe(false);
        expect(constrainedNetwork(undefined)).toBe(false);
        expect(constrainedNetwork(null)).toBe(false);
    });

    it('currentConnection：沒有 navigator.connection 時 undefined；讀取丟例外也當作不支援', () => {
        vi.stubGlobal('navigator', {});
        expect(currentConnection()).toBeUndefined();
        vi.stubGlobal('navigator', { connection: { effectiveType: '3g' } });
        expect(currentConnection()).toEqual({ effectiveType: '3g' });
        vi.stubGlobal('navigator', { get connection() { throw new Error('denied'); } });
        expect(currentConnection()).toBeUndefined();
    });
});
