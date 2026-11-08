// useWakeLock：依本裝置設定啟停；關閉開關即釋放；不支援時不呼叫；lib/wake-lock 只在開關開啟時才動態載入
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
        await vi.waitFor(() => expect(getWakeLockStatus().state).toBe('active'));
        expect(request).toHaveBeenCalledWith('screen');
        await act(async () => { setMobileDeviceSettings({ wakeLock: false }); });
        expect(release).toHaveBeenCalledOnce();
        expect(getWakeLockStatus().state).toBe('off');
    });

    it('releases on unmount', async () => {
        setMobileDeviceSettings({ wakeLock: true });
        await act(async () => { view = create(createElement(Probe)); await flush(); });
        await vi.waitFor(() => expect(getWakeLockStatus().state).toBe('active'));
        await act(async () => view?.unmount());
        view = undefined;
        expect(release).toHaveBeenCalledOnce();
    });

    it('unsupported browsers: never loads the module or requests (the settings UI uses wakeLockSupported())', async () => {
        vi.stubGlobal('navigator', {});
        setMobileDeviceSettings({ wakeLock: true });
        await act(async () => { view = create(createElement(Probe)); await flush(); });
        // 先前的測試已載入模組時會設為 unsupported；沒載入時維持初始 off（設定區塊以 wakeLockSupported() 判斷）
        expect(['off', 'unsupported']).toContain(getWakeLockStatus().state);
        expect(request).not.toHaveBeenCalled();
    });

    it('switched off (or unmounted) before the lazy module arrives: never acquires', async () => {
        await act(async () => { view = create(createElement(Probe)); });
        // 同步 act：effect 立即執行、動態 import 還沒 resolve 就關掉開關
        act(() => { setMobileDeviceSettings({ wakeLock: true }); });
        act(() => { setMobileDeviceSettings({ wakeLock: false }); });
        // 再開一次、還沒 resolve 就卸載
        act(() => { setMobileDeviceSettings({ wakeLock: true }); });
        act(() => { view?.unmount(); });
        view = undefined;
        await act(async () => { await flush(); await flush(); });
        expect(request).not.toHaveBeenCalled();
        expect(getWakeLockStatus().state).not.toBe('active');
    });
});
