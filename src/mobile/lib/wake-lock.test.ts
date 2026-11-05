// 螢幕常亮：可見才取得、隱藏釋放、回前景重取、停止釋放、request 進行中停止不持有、失敗後手勢重試、不支援
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWakeLockStatus, resetWakeLockStatusForTest, startWakeLock, type WakeLockDoc } from './wake-lock';

class FakeSentinel extends EventTarget {
    released = false;
    release = vi.fn(async () => {
        if (this.released) return;
        this.released = true;
        this.dispatchEvent(new Event('release'));
    });
    /** 系統自行釋放（例如切到背景、省電模式） */
    systemRelease() {
        this.released = true;
        this.dispatchEvent(new Event('release'));
    }
}

function fakeDoc(visibilityState: 'visible' | 'hidden' = 'visible') {
    const doc = new EventTarget() as WakeLockDoc;
    doc.visibilityState = visibilityState;
    return doc;
}

function setVisibility(doc: WakeLockDoc, v: 'visible' | 'hidden') {
    doc.visibilityState = v;
    doc.dispatchEvent(new Event('visibilitychange'));
}

function fakeNav() {
    const sentinels: FakeSentinel[] = [];
    const request = vi.fn(async (_type: 'screen') => {
        const s = new FakeSentinel();
        sentinels.push(s);
        return s;
    });
    return { nav: { wakeLock: { request } }, request, sentinels };
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => resetWakeLockStatusForTest());
afterEach(() => resetWakeLockStatusForTest());

describe('startWakeLock', () => {
    it('acquires a screen lock while visible', async () => {
        const { nav, request } = fakeNav();
        const stop = startWakeLock(nav, fakeDoc());
        await flush();
        expect(request).toHaveBeenCalledWith('screen');
        expect(getWakeLockStatus().state).toBe('active');
        stop();
    });

    it('does not request while hidden; acquires when the page comes back', async () => {
        const { nav, request } = fakeNav();
        const doc = fakeDoc('hidden');
        const stop = startWakeLock(nav, doc);
        await flush();
        expect(request).not.toHaveBeenCalled();
        expect(getWakeLockStatus().state).toBe('hidden');
        setVisibility(doc, 'visible');
        await flush();
        expect(request).toHaveBeenCalledOnce();
        expect(getWakeLockStatus().state).toBe('active');
        stop();
    });

    it('releases when hidden and re-acquires on visibilitychange back to visible', async () => {
        const { nav, request, sentinels } = fakeNav();
        const doc = fakeDoc();
        const stop = startWakeLock(nav, doc);
        await flush();
        setVisibility(doc, 'hidden');
        expect(sentinels[0]!.release).toHaveBeenCalledOnce();
        expect(getWakeLockStatus().state).toBe('hidden');
        setVisibility(doc, 'visible');
        await flush();
        expect(request).toHaveBeenCalledTimes(2);
        expect(getWakeLockStatus().state).toBe('active');
        stop();
        expect(sentinels[1]!.release).toHaveBeenCalledOnce();
    });

    it('re-acquires after the system released the lock in the background', async () => {
        const { nav, request, sentinels } = fakeNav();
        const doc = fakeDoc();
        const stop = startWakeLock(nav, doc);
        await flush();
        doc.visibilityState = 'hidden';
        sentinels[0]!.systemRelease();
        expect(getWakeLockStatus().state).toBe('hidden');
        setVisibility(doc, 'visible');
        await flush();
        expect(request).toHaveBeenCalledTimes(2);
        expect(getWakeLockStatus().state).toBe('active');
        stop();
    });

    it('stop() releases, removes listeners and sets state off', async () => {
        const { nav, request, sentinels } = fakeNav();
        const doc = fakeDoc();
        const stop = startWakeLock(nav, doc);
        await flush();
        stop();
        expect(sentinels[0]!.release).toHaveBeenCalledOnce();
        expect(getWakeLockStatus().state).toBe('off');
        setVisibility(doc, 'hidden');
        setVisibility(doc, 'visible');
        await flush();
        expect(request).toHaveBeenCalledOnce();
    });

    it('a lock granted after stop() is released immediately (not held)', async () => {
        let resolve!: (s: FakeSentinel) => void;
        const sentinel = new FakeSentinel();
        const request = vi.fn(() => new Promise<FakeSentinel>(r => { resolve = r; }));
        const stop = startWakeLock({ wakeLock: { request } }, fakeDoc());
        expect(getWakeLockStatus().state).toBe('pending');
        stop();
        resolve(sentinel);
        await flush();
        expect(sentinel.release).toHaveBeenCalledOnce();
        expect(getWakeLockStatus().state).toBe('off');
    });

    it('a lock granted after the page went hidden is released and re-requested on return', async () => {
        const { nav, request, sentinels } = fakeNav();
        let resolveFirst!: () => void;
        request.mockImplementationOnce(() => new Promise(r => {
            resolveFirst = () => { const s = new FakeSentinel(); sentinels.push(s); r(s); };
        }));
        const doc = fakeDoc();
        const stop = startWakeLock(nav, doc);
        doc.visibilityState = 'hidden';
        resolveFirst();
        await flush();
        expect(sentinels[0]!.release).toHaveBeenCalledOnce();
        expect(getWakeLockStatus().state).toBe('hidden');
        setVisibility(doc, 'visible');
        await flush();
        expect(request).toHaveBeenCalledTimes(2);
        expect(getWakeLockStatus().state).toBe('active');
        stop();
    });

    it('records a rejection and retries once on the next tap', async () => {
        const { nav, request } = fakeNav();
        request.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
        const doc = fakeDoc();
        const stop = startWakeLock(nav, doc);
        await flush();
        expect(getWakeLockStatus().state).toBe('error');
        expect(getWakeLockStatus().error).toContain('瀏覽器拒絕');
        doc.dispatchEvent(new Event('touchend'));
        doc.dispatchEvent(new Event('click'));
        await flush();
        expect(request).toHaveBeenCalledTimes(2);
        expect(getWakeLockStatus().state).toBe('active');
        stop();
    });

    it('reports unsupported when navigator.wakeLock is missing', () => {
        const stop = startWakeLock({}, fakeDoc());
        expect(getWakeLockStatus().state).toBe('unsupported');
        stop();
    });
});
