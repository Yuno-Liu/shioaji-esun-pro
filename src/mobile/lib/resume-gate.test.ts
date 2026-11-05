// ResumeGate 純邏輯＋閘門（assertResumeReady）在各狀態的行為。
// 事件驅動的完整情境（§14.1：隱藏門檻、四條件、stale-data、45 秒 failed、pageshow persisted）見 resume-gate-runtime.test.ts。
import { afterEach, describe, expect, it, vi } from 'vitest';

// 執行期會引用 src/lib 的串流、交易狀態與確認佇列；這裡只測閘門，全部隔離
vi.mock('../../lib/order-confirm', () => ({ resolveOrderConfirm: vi.fn() }));
vi.mock('../../lib/shioaji', () => ({ fetchSnapshots: vi.fn() }));
vi.mock('../../lib/contracts-cache', () => ({ getCachedContract: vi.fn() }));
vi.mock('../../lib/stream', () => ({}));
vi.mock('../../lib/trading-state', () => ({}));
import {
    ACTIVITY_SETTLE_MS,
    countsAsResumeActivity,
    HIDDEN_THRESHOLD_MS,
    INITIAL_RESUME_CHECKS,
    nextResumeState,
    readsMayStart,
    RESYNC_TIMEOUT_MS,
    resumeAllowsNewOrders,
    shouldResync,
    type ResumeChecks,
} from './resume-gate';
import { acknowledgeStaleData, assertResumeReady, getResumeGate, setResumeGateForTest } from './resume-gate-runtime';

const recovered: ResumeChecks = { streamLive: true, activitySinceResume: true, tradingReadSettled: 'ok', snapshotSettled: 'ok' };

describe('nextResumeState', () => {
    it('is ready only when all four checks pass', () => {
        expect(nextResumeState(recovered, 1_000)).toBe('ready');
    });

    it('keeps resyncing while any check is outstanding', () => {
        expect(nextResumeState(INITIAL_RESUME_CHECKS, 0)).toBe('resyncing');
        expect(nextResumeState({ ...recovered, streamLive: false }, 10_000)).toBe('resyncing');
        expect(nextResumeState({ ...recovered, activitySinceResume: false }, 10_000)).toBe('resyncing');
        expect(nextResumeState({ ...recovered, tradingReadSettled: 'pending' }, 10_000)).toBe('resyncing');
        expect(nextResumeState({ ...recovered, snapshotSettled: 'pending' }, 10_000)).toBe('resyncing');
    });

    it('becomes stale-data when a read failed after the stream recovered', () => {
        expect(nextResumeState({ ...recovered, tradingReadSettled: 'failed' }, 1_000)).toBe('stale-data');
        expect(nextResumeState({ ...recovered, snapshotSettled: 'failed' }, 1_000)).toBe('stale-data');
    });

    it('fails after the resync timeout when the stream has not recovered', () => {
        expect(nextResumeState(INITIAL_RESUME_CHECKS, RESYNC_TIMEOUT_MS - 1)).toBe('resyncing');
        expect(nextResumeState(INITIAL_RESUME_CHECKS, RESYNC_TIMEOUT_MS)).toBe('failed');
        // 連線已恢復時不因逾時判 failed
        expect(nextResumeState(recovered, RESYNC_TIMEOUT_MS + 1)).toBe('ready');
    });
});

describe('resume helpers', () => {
    it('resyncs only after being hidden for the threshold, or on a bfcache restore', () => {
        expect(shouldResync(HIDDEN_THRESHOLD_MS - 1)).toBe(false);
        expect(shouldResync(HIDDEN_THRESHOLD_MS)).toBe(true);
        expect(shouldResync(0, { persisted: true })).toBe(true);
        expect(shouldResync(Number.NaN)).toBe(false);
    });

    it('counts stream activity only after the settle window (queued events delivered on resume do not count)', () => {
        expect(countsAsResumeActivity(0)).toBe(false);
        expect(countsAsResumeActivity(ACTIVITY_SETTLE_MS - 1)).toBe(false);
        expect(countsAsResumeActivity(ACTIVITY_SETTLE_MS)).toBe(true);
        expect(countsAsResumeActivity(Number.NaN)).toBe(false);
        // 休市只有心跳（30 秒一次）：第一秒內的心跳不算，下一次仍在 45 秒逾時內
        expect(ACTIVITY_SETTLE_MS + 30_000).toBeLessThan(RESYNC_TIMEOUT_MS);
    });

    it('starts reads only after the stream is live and active', () => {
        expect(readsMayStart({ streamLive: true, activitySinceResume: false })).toBe(false);
        expect(readsMayStart({ streamLive: true, activitySinceResume: true })).toBe(true);
    });

    it('allows new orders only when ready or acknowledged stale', () => {
        expect(resumeAllowsNewOrders('ready', false)).toBe(true);
        expect(resumeAllowsNewOrders('stale-data', false)).toBe(false);
        expect(resumeAllowsNewOrders('stale-data', true)).toBe(true);
        expect(resumeAllowsNewOrders('resyncing', true)).toBe(false);
        expect(resumeAllowsNewOrders('failed', true)).toBe(false);
    });
});

describe('assertResumeReady (runtime gate)', () => {
    afterEach(() => setResumeGateForTest(null));

    const notStarted = (fn: () => void) => {
        try { fn(); } catch (err) { return (err as { mutationNotStarted?: boolean }).mutationNotStarted === true; }
        return 'passed';
    };

    it('passes when ready (default)', () => {
        expect(getResumeGate().state).toBe('ready');
        expect(notStarted(() => assertResumeReady())).toBe('passed');
    });

    it('blocks resyncing and failed with a not-started error', () => {
        setResumeGateForTest({ state: 'resyncing' });
        expect(notStarted(() => assertResumeReady({ allowStale: true }))).toBe(true);
        setResumeGateForTest({ state: 'failed' });
        expect(notStarted(() => assertResumeReady({ allowStale: true }))).toBe(true);
    });

    it('lets stale data through only when acknowledged and the caller allows it', () => {
        setResumeGateForTest({ state: 'stale-data' });
        expect(notStarted(() => assertResumeReady({ allowStale: true }))).toBe(true);
        acknowledgeStaleData();
        expect(getResumeGate().staleAcknowledged).toBe(true);
        expect(notStarted(() => assertResumeReady())).toBe(true);
        expect(notStarted(() => assertResumeReady({ allowStale: true }))).toBe('passed');
    });

    it('ready passes with or without allowStale', () => {
        setResumeGateForTest({ state: 'ready' });
        expect(notStarted(() => assertResumeReady())).toBe('passed');
        expect(notStarted(() => assertResumeReady({ allowStale: true }))).toBe('passed');
    });

    it('resyncing and failed block even after a stale acknowledgement flag', () => {
        setResumeGateForTest({ state: 'resyncing', staleAcknowledged: true });
        expect(notStarted(() => assertResumeReady({ allowStale: true }))).toBe(true);
        setResumeGateForTest({ state: 'failed', staleAcknowledged: true });
        expect(notStarted(() => assertResumeReady({ allowStale: true }))).toBe(true);
    });

    it('acknowledgeStaleData is ignored outside stale-data', () => {
        for (const state of ['ready', 'resyncing', 'failed'] as const) {
            setResumeGateForTest({ state });
            acknowledgeStaleData();
            expect(getResumeGate().staleAcknowledged).toBe(false);
        }
    });

    it('error messages tell the user the order was not sent', () => {
        for (const state of ['resyncing', 'stale-data', 'failed'] as const) {
            setResumeGateForTest({ state });
            expect(() => assertResumeReady()).toThrow(/沒有送出/);
        }
    });
});
