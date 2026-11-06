// 成交回饋：onOrderEvent 的成交（deal）→ 音效＋震動；委託回報不觸發；開關關閉、頁面隱藏時不觸發；卸載解除訂閱
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    sound: true,
    listener: null as ((ev: { kind: string }) => void) | null,
    oscillators: 0,
}));
vi.mock('../../lib/sounds', () => ({ soundEnabled: () => m.sound, setSoundEnabled: (on: boolean) => { m.sound = on; } }));
vi.mock('../../lib/stream', () => ({
    onOrderEvent: (l: (ev: { kind: string }) => void) => {
        m.listener = l;
        return () => { if (m.listener === l) m.listener = null; };
    },
}));
vi.mock('../../lib/order-report', () => ({
    describeOrderReport: (ev: { kind: string }) => ({ kind: ev.kind === 'deal' ? 'deal' : 'info', title: '', lines: [] }),
}));

import { resetFillAudioForTest } from '../lib/fill-audio';
import { FILL_VIBRATE_MS, resetMobileDeviceSettingsForTest, setMobileDeviceSettings } from '../lib/mobile-device-settings';
import { useFillSound } from './use-fill-sound';

class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume() { return Promise.resolve(); }
    createBuffer() { return {}; }
    createBufferSource() { return { buffer: null as unknown, connect: () => undefined, start: () => undefined }; }
    createOscillator() {
        m.oscillators++;
        return { type: '', frequency: { value: 0 }, connect: (g: unknown) => g, start: () => undefined, stop: () => undefined };
    }
    createGain() {
        const f = () => undefined;
        return { gain: { setValueAtTime: f, linearRampToValueAtTime: f, exponentialRampToValueAtTime: f }, connect: (d: unknown) => d };
    }
}

const vibrate = vi.fn(() => true);
let view: ReactTestRenderer | undefined;

function Probe() {
    useFillSound();
    return null;
}

async function mount() {
    await act(async () => { view = create(createElement(Probe)); });
}

const emit = (kind: string) => act(() => { m.listener?.({ kind }); });

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('navigator', { vibrate });
    vi.stubGlobal('localStorage', undefined);
    resetMobileDeviceSettingsForTest();
    resetFillAudioForTest();
    m.sound = true;
    m.oscillators = 0;
    vibrate.mockClear();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    resetFillAudioForTest();
    vi.unstubAllGlobals();
});

describe('useFillSound', () => {
    it('plays the fill sound and vibrates on a deal', async () => {
        await mount();
        await emit('deal');
        expect(m.oscillators).toBe(2);
        expect(vibrate).toHaveBeenCalledWith(FILL_VIBRATE_MS);
    });

    it('ignores order reports that are not deals', async () => {
        await mount();
        await emit('order');
        expect(m.oscillators).toBe(0);
        expect(vibrate).not.toHaveBeenCalled();
    });

    it('sound switch off → no sound, vibration still follows its own switch', async () => {
        m.sound = false;
        await mount();
        await emit('deal');
        expect(m.oscillators).toBe(0);
        expect(vibrate).toHaveBeenCalledOnce();
    });

    it('vibration switch off → no vibration, sound still plays', async () => {
        setMobileDeviceSettings({ vibrate: false });
        await mount();
        await emit('deal');
        expect(vibrate).not.toHaveBeenCalled();
        expect(m.oscillators).toBe(2);
    });

    it('both switches off → nothing', async () => {
        m.sound = false;
        setMobileDeviceSettings({ vibrate: false });
        await mount();
        await emit('deal');
        expect(m.oscillators).toBe(0);
        expect(vibrate).not.toHaveBeenCalled();
    });

    it('page hidden → neither sound nor vibration', async () => {
        vi.stubGlobal('document', { visibilityState: 'hidden' });
        await mount();
        await emit('deal');
        expect(m.oscillators).toBe(0);
        expect(vibrate).not.toHaveBeenCalled();
    });

    it('unsubscribes on unmount', async () => {
        await mount();
        expect(m.listener).not.toBeNull();
        await act(async () => view?.unmount());
        view = undefined;
        expect(m.listener).toBeNull();
    });
});
