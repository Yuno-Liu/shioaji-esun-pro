// 按需查詢快取：同時只發一次、冷卻內不重查、失敗保留舊資料且不自動重送
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canLoadOnDemand, cooldownLeftSec, getOnDemandState, loadOnDemand, resetOnDemandForTest } from './account-on-demand';

let now = 1_000_000;
afterEach(() => resetOnDemandForTest());

describe('loadOnDemand', () => {
    it('dedupes concurrent loads and enforces the cooldown', async () => {
        resetOnDemandForTest(() => now);
        const fetcher = vi.fn(async () => 42);
        const a = loadOnDemand('k', fetcher, 30_000);
        const b = loadOnDemand('k', fetcher, 30_000);
        expect(getOnDemandState('k').loading).toBe(true);
        await Promise.all([a, b]);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(getOnDemandState<number>('k')).toMatchObject({ data: 42, loading: false, error: null, updatedAt: now });

        now += 29_000;
        expect(await loadOnDemand('k', fetcher, 30_000)).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(canLoadOnDemand(getOnDemandState('k'), 30_000, now)).toBe(false);
        expect(cooldownLeftSec(getOnDemandState('k'), 30_000, now)).toBe(1);

        now += 1_000;
        expect(await loadOnDemand('k', fetcher, 30_000)).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('keeps previous data on failure and never retries by itself', async () => {
        resetOnDemandForTest(() => now);
        await loadOnDemand('k', async () => 'old', 0);
        const failing = vi.fn(async () => { throw new Error('boom'); });
        await loadOnDemand('k', failing, 0);
        expect(getOnDemandState<string>('k')).toMatchObject({ data: 'old', error: 'boom', loading: false });
        expect(failing).toHaveBeenCalledTimes(1);
    });

    it('turns synchronous throws into an error state', async () => {
        resetOnDemandForTest(() => now);
        await loadOnDemand('k', () => { throw new Error('sync'); }, 0);
        expect(getOnDemandState('k').error).toBe('sync');
    });

    it('keeps keys independent', async () => {
        resetOnDemandForTest(() => now);
        await loadOnDemand('a', async () => 1, 30_000);
        expect(await loadOnDemand('b', async () => 2, 30_000)).toBe(true);
        expect(getOnDemandState('b').data).toBe(2);
        expect(getOnDemandState(null).data).toBeNull();
    });
});
