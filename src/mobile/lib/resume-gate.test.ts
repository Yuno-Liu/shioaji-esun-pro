// ResumeGate 純邏輯（T1 基本測試；完整情境由 T2 補齊）＋執行期樁的閘門行為
import { afterEach, describe, expect, it } from 'vitest';
import {
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

    it('passes when ready (stub default)', () => {
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
});
