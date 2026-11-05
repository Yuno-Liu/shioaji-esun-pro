// useWakeLock：依本裝置設定啟停；關閉開關即釋放；不支援時不呼叫
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMobileDeviceSettingsForTest, setMobileDeviceSettings } from '../lib/mobile-device-settings';
import { getWakeLockStatus, resetWakeLockStatusForTest } from '../lib/wake-lock';
import { useWakeLock } from './use-wake-lock';

const release = vi.fn(async () => undefined);
const request = vi.fn(async () => ({ released: false, release, addEventListener: () => undefined }));
let view: ReactTestRenderer | undefined;

function Probe() {
    useWakeLock();
    return null;
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('navigator', { wakeLock: { request } });
    resetMobileDeviceSettingsForTest();
    resetWakeLockStatusForTest();
    request.mockClear();
    release.mockClear();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('useWakeLock', () => {
    it('does nothing while the switch is off', async () => {
        await act(async () => { view = create(createElement(Probe)); });
        expect(request).not.toHaveBeenCalled();
        expect(getWakeLockStatus().state).toBe('off');
    });

    it('acquires when switched on and releases when switched off', async () => {
        await act(async () => { view = create(createElement(Probe)); });
        await act(async () => { setMobileDeviceSettings({ wakeLock: true }); await flush(); });
        expect(request).toHaveBeenCalledWith('screen');
        expect(getWakeLockStatus().state).toBe('active');
        await act(async () => { setMobileDeviceSettings({ wakeLock: false }); });
        expect(release).toHaveBeenCalledOnce();
        expect(getWakeLockStatus().state).toBe('off');
    });

    it('releases on unmount', async () => {
        setMobileDeviceSettings({ wakeLock: true });
        await act(async () => { view = create(createElement(Probe)); await flush(); });
        await act(async () => view?.unmount());
        view = undefined;
        expect(release).toHaveBeenCalledOnce();
    });

    it('marks unsupported browsers and never requests', async () => {
        vi.stubGlobal('navigator', {});
        setMobileDeviceSettings({ wakeLock: true });
        await act(async () => { view = create(createElement(Probe)); });
        expect(getWakeLockStatus().state).toBe('unsupported');
        expect(request).not.toHaveBeenCalled();
    });
});
