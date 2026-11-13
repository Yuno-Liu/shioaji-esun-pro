// src/lib/esun/probe-retry.test.ts — bridge 探測失敗後的背景重試排程（createEsunProbeRetry）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEsunProbeRetry, ESUN_PROBE_MAX_RETRIES } from './dispatch';

let doc: EventTarget & { hidden: boolean };
let win: EventTarget;
const setHidden = (hidden: boolean) => { doc.hidden = hidden; doc.dispatchEvent(new Event('visibilitychange')); };

beforeEach(() => {
    vi.useFakeTimers();
    doc = Object.assign(new EventTarget(), { hidden: false });
    win = new EventTarget();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('createEsunProbeRetry', () => {
    it('retries after 10 s, 20 s, 40 s, then every 60 s, at most 8 times', async () => {
        const probe = vi.fn(async () => null);
        createEsunProbeRetry(probe)(null);
        const at: number[] = [];
        for (let t = 0; t <= 1_000_000; t += 1_000) {
            await vi.advanceTimersByTimeAsync(1_000);
            if (probe.mock.calls.length > at.length) at.push(t + 1_000);
        }
        expect(at).toEqual([10, 30, 70, 130, 190, 250, 310, 370].map(s => s * 1_000));
        expect(probe).toHaveBeenCalledTimes(ESUN_PROBE_MAX_RETRIES);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps only one timer and registers listeners once', async () => {
        const addDoc = vi.spyOn(doc, 'addEventListener');
        const addWin = vi.spyOn(win, 'addEventListener');
        const report = createEsunProbeRetry(vi.fn(async () => null));
        report(null); report(null); report(null);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(vi.getTimerCount()).toBe(1);
        expect(addDoc).toHaveBeenCalledTimes(1);
        expect(addWin).toHaveBeenCalledTimes(1);
    });

    it('stops for good once a probe returns a health object (even not ok) and removes its listeners', async () => {
        const probe = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ ok: false });
        const removeDoc = vi.spyOn(doc, 'removeEventListener');
        createEsunProbeRetry(probe)(null);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
        expect(removeDoc).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
        setHidden(true); setHidden(false);
        win.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(600_000);
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('does not probe while hidden; becoming visible resets the counter and probes immediately', async () => {
        const probe = vi.fn(async () => null);
        const report = createEsunProbeRetry(probe);
        setHidden(true);
        report(null);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(probe).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        setHidden(false);
        expect(probe).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(probe).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('the online event resets an exhausted counter and probes again', async () => {
        const probe = vi.fn(async () => null);
        createEsunProbeRetry(probe)(null);
        await vi.advanceTimersByTimeAsync(1_000_000);
        expect(probe).toHaveBeenCalledTimes(8);
        win.dispatchEvent(new Event('online'));
        expect(probe).toHaveBeenCalledTimes(9);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(probe).toHaveBeenCalledTimes(10);
    });

    it('does not start a second probe while one is in flight', async () => {
        let settle!: (v: unknown) => void;
        const probe = vi.fn(() => new Promise(r => { settle = r; }));
        createEsunProbeRetry(probe)(null);
        await vi.advanceTimersByTimeAsync(10_000);
        setHidden(false);
        win.dispatchEvent(new Event('online'));
        expect(probe).toHaveBeenCalledTimes(1);
        settle(null);
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('treats a rejected probe as a failure', async () => {
        const probe = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ ok: true });
        createEsunProbeRetry(probe)(null);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('works without document/window (non-browser)', async () => {
        vi.unstubAllGlobals();
        const probe = vi.fn(async () => null);
        createEsunProbeRetry(probe)(null);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(probe).toHaveBeenCalledTimes(1);
    });
});
