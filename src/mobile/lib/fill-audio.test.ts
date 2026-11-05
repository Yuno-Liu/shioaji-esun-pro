// 成交音效播放器：手勢解鎖只綁一次、解鎖不出聲（靜音 buffer）、開關與頁面隱藏時不播、與桌面 playDeal 同音色
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sound: true, contexts: [] as FakeAudioContext[] }));
vi.mock('../../lib/sounds', () => ({ soundEnabled: () => m.sound, setSoundEnabled: (on: boolean) => { m.sound = on; } }));

type FakeAudioContext = InstanceType<ReturnType<typeof makeAudioContext>>;

function makeAudioContext() {
    return class FakeAudioContext {
        state: 'suspended' | 'running' = 'suspended';
        currentTime = 0;
        destination = {};
        oscillators: { type: string; freq: number }[] = [];
        bufferSources = 0;
        resumeCalls = 0;
        resumeResult: 'running' | 'suspended' = 'running';
        constructor() { m.contexts.push(this); }
        resume() {
            this.resumeCalls++;
            // 與瀏覽器相同：state 在 promise 完成後才改變
            return Promise.resolve().then(() => { this.state = this.resumeResult; });
        }
        createBuffer() { return {}; }
        createBufferSource() {
            this.bufferSources++;
            return { buffer: null as unknown, connect: () => undefined, start: () => undefined };
        }
        createOscillator() {
            const osc = { type: '', frequency: { value: 0 }, connect: (g: unknown) => g, start: () => undefined, stop: () => { this.oscillators.push({ type: osc.type, freq: osc.frequency.value }); } };
            return osc;
        }
        createGain() {
            const ramp = () => undefined;
            return { gain: { setValueAtTime: ramp, linearRampToValueAtTime: ramp, exponentialRampToValueAtTime: ramp }, connect: (d: unknown) => d };
        }
    };
}

import { armFillAudioUnlock, playFillSound, resetFillAudioForTest, unlockFillAudio } from './fill-audio';

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function spyTarget() {
    const target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener');
    const remove = vi.spyOn(target, 'removeEventListener');
    return { target, add, remove };
}

beforeEach(() => {
    m.sound = true;
    m.contexts = [];
    vi.stubGlobal('AudioContext', makeAudioContext());
    vi.stubGlobal('document', { visibilityState: 'visible' });
});
afterEach(() => {
    resetFillAudioForTest();
    vi.unstubAllGlobals();
});

describe('gesture unlock', () => {
    it('binds pointerdown/touchend/click once even when armed repeatedly', () => {
        const { target, add } = spyTarget();
        armFillAudioUnlock(target);
        armFillAudioUnlock(target);
        armFillAudioUnlock(target);
        const types = add.mock.calls.map(c => c[0]);
        expect(types.sort()).toEqual(['click', 'pointerdown', 'touchend']);
    });

    it('first gesture resumes the context with a silent buffer (no oscillator) and removes the listeners', async () => {
        const { target, remove } = spyTarget();
        armFillAudioUnlock(target);
        target.dispatchEvent(new Event('touchend'));
        await flush();
        expect(m.contexts).toHaveLength(1);
        const ac = m.contexts[0]!;
        expect(ac.resumeCalls).toBe(1);
        expect(ac.bufferSources).toBe(1);
        expect(ac.oscillators).toHaveLength(0);
        expect(remove.mock.calls.map(c => c[0]).sort()).toEqual(['click', 'pointerdown', 'touchend']);
        // 之後的手勢不再處理
        target.dispatchEvent(new Event('click'));
        expect(ac.bufferSources).toBe(1);
    });

    it('keeps listening while the context stays suspended, then unlocks on a later gesture', async () => {
        const Base = makeAudioContext();
        vi.stubGlobal('AudioContext', class extends Base { resumeResult = 'suspended' as const; });
        const { target, remove } = spyTarget();
        armFillAudioUnlock(target);
        target.dispatchEvent(new Event('touchend'));
        await flush();
        expect(m.contexts[0]!.state).toBe('suspended');
        expect(remove).not.toHaveBeenCalled();
        m.contexts[0]!.resumeResult = 'running';
        target.dispatchEvent(new Event('click'));
        await flush();
        expect(m.contexts).toHaveLength(1);
        expect(remove).toHaveBeenCalledTimes(3);
    });

    it('does not create a context while sound is off', () => {
        m.sound = false;
        expect(unlockFillAudio()).toBe(false);
        expect(m.contexts).toHaveLength(0);
    });
});

describe('playFillSound', () => {
    it('plays the desktop playDeal timbre: 880 Hz then 1320 Hz sine', () => {
        unlockFillAudio();
        expect(playFillSound()).toBe(true);
        expect(m.contexts[0]!.oscillators).toEqual([{ type: 'sine', freq: 880 }, { type: 'sine', freq: 1320 }]);
    });

    it('is silent when the shared sound switch is off', () => {
        m.sound = false;
        expect(playFillSound()).toBe(false);
        expect(m.contexts).toHaveLength(0);
    });

    it('is silent while the page is hidden', () => {
        vi.stubGlobal('document', { visibilityState: 'hidden' });
        expect(playFillSound()).toBe(false);
        expect(m.contexts).toHaveLength(0);
    });

    it('re-arms the unlock listeners when the context is not running (iOS after background)', () => {
        const win = spyTarget();
        vi.stubGlobal('window', win.target);
        expect(playFillSound()).toBe(true);
        expect(m.contexts[0]!.resumeCalls).toBe(1);
        expect(win.add.mock.calls.map(c => c[0]).sort()).toEqual(['click', 'pointerdown', 'touchend']);
    });

    it('returns false without Web Audio', () => {
        vi.stubGlobal('AudioContext', undefined);
        expect(playFillSound()).toBe(false);
    });
});
