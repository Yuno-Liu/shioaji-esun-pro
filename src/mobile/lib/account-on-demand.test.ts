// 按需查詢快取：同時只發一次、冷卻內不重查、失敗保留舊資料且不自動重送
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canLoadOnDemand, cooldownLeftSec, gateLeftSec, getOnDemandState, loadOnDemand, resetOnDemandForTest } from './account-on-demand';

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

    it('a shared sliding-window gate allows max loads per window across keys; skipped loads use no quota', async () => {
        resetOnDemandForTest(() => now);
        const gate = { name: 'g', max: 3, windowMs: 60_000 };
        const fetcher = vi.fn(async () => 1);
        const start = now;
        expect(gateLeftSec(gate, now)).toBe(0);
        for (const k of ['a', 'b', 'c']) {
            expect(await loadOnDemand(k, fetcher, 30_000, gate)).toBe(true);
            now += 10_000;
        }
        // 第 4 次（t+30s）：等最舊一次（t+0）滑出視窗 → 30 秒
        expect(gateLeftSec(gate, now)).toBe(30);
        expect(await loadOnDemand('d', fetcher, 30_000, gate)).toBe(false);
        expect(getOnDemandState('d')).toMatchObject({ loading: false, attemptedAt: null });
        // 被擋下的嘗試不占額度；最舊一次剛好滿 60 秒就滑出
        now = start + 59_999;
        expect(gateLeftSec(gate, now)).toBe(1);
        now = start + 60_000;
        expect(gateLeftSec(gate, now)).toBe(0);
        expect(await loadOnDemand('d', fetcher, 30_000, gate)).toBe(true);
        // 視窗又滿了：下一個要等 b（t+10s）滑出
        expect(gateLeftSec(gate, now)).toBe(10);
        expect(fetcher).toHaveBeenCalledTimes(4);
        // 沒帶 gate 的 key 不受影響；不同名稱的閘門各自計數；reset 清空閘門
        expect(await loadOnDemand('e', fetcher, 30_000)).toBe(true);
        expect(gateLeftSec({ name: 'other', max: 3, windowMs: 60_000 }, now)).toBe(0);
        resetOnDemandForTest(() => now);
        expect(gateLeftSec(gate, now)).toBe(0);
    });

    it('a gate ignores passes stamped in the future (device clock moved back) instead of locking for the jump', async () => {
        resetOnDemandForTest(() => now);
        const gate = { name: 'g', max: 2, windowMs: 60_000 };
        const fetcher = vi.fn(async () => 1);
        expect(await loadOnDemand('a', fetcher, 30_000, gate)).toBe(true);
        expect(await loadOnDemand('b', fetcher, 30_000, gate)).toBe(true);
        expect(gateLeftSec(gate, now)).toBe(60);
        // 系統時間往回調一小時：舊紀錄變成「未來」→ 不計入（bridge 端仍有自己的限制），不會鎖 1 小時
        now -= 3_600_000;
        expect(gateLeftSec(gate, now)).toBe(0);
        expect(await loadOnDemand('c', fetcher, 30_000, gate)).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
});
