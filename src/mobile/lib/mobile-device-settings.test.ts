// 本裝置設定（'sj-mobile-device-v1'）：持久化、讀寫失敗容錯、能力偵測與成交短震
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_MOBILE_DEVICE_SETTINGS,
    FILL_VIBRATE_MS,
    getMobileDeviceSettings,
    MOBILE_DEVICE_SETTINGS_KEY,
    resetMobileDeviceSettingsForTest,
    sanitizeMobileDeviceSettings,
    setMobileDeviceSettings,
    subscribeMobileDeviceSettings,
    vibrateOnFill,
    vibrationSupported,
    wakeLockSupported,
} from './mobile-device-settings';

function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: vi.fn((k: string) => data.get(k) ?? null),
        setItem: vi.fn((k: string, v: string) => { data.set(k, v); }),
        removeItem: vi.fn((k: string) => { data.delete(k); }),
    };
}

beforeEach(() => resetMobileDeviceSettingsForTest());
afterEach(() => {
    vi.unstubAllGlobals();
    resetMobileDeviceSettingsForTest();
});

describe('mobile device settings persistence', () => {
    it('defaults: vibrate on (existing §5.5 behaviour), wake lock off', () => {
        vi.stubGlobal('localStorage', memoryStorage());
        expect(getMobileDeviceSettings()).toEqual({ vibrate: true, wakeLock: false });
        expect(DEFAULT_MOBILE_DEVICE_SETTINGS).toEqual({ vibrate: true, wakeLock: false });
    });

    it('writes to sj-mobile-device-v1 and reloads after reset', () => {
        const storage = memoryStorage();
        vi.stubGlobal('localStorage', storage);
        const listener = vi.fn();
        subscribeMobileDeviceSettings(listener);
        setMobileDeviceSettings({ wakeLock: true });
        expect(listener).toHaveBeenCalledOnce();
        expect(JSON.parse(storage.data.get(MOBILE_DEVICE_SETTINGS_KEY)!)).toEqual({ vibrate: true, wakeLock: true });
        resetMobileDeviceSettingsForTest();
        expect(getMobileDeviceSettings()).toEqual({ vibrate: true, wakeLock: true });
    });

    it('does not notify or write when nothing changed', () => {
        const storage = memoryStorage();
        vi.stubGlobal('localStorage', storage);
        const listener = vi.fn();
        subscribeMobileDeviceSettings(listener);
        setMobileDeviceSettings({ vibrate: true });
        expect(listener).not.toHaveBeenCalled();
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('survives broken storage (private mode): reads defaults, keeps the value for this session', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('SecurityError'); },
            setItem: () => { throw new Error('QuotaExceededError'); },
        });
        expect(getMobileDeviceSettings()).toEqual(DEFAULT_MOBILE_DEVICE_SETTINGS);
        expect(setMobileDeviceSettings({ vibrate: false })).toEqual({ vibrate: false, wakeLock: false });
        expect(getMobileDeviceSettings().vibrate).toBe(false);
    });

    it('ignores corrupt JSON and wrong types field by field', () => {
        vi.stubGlobal('localStorage', memoryStorage({ [MOBILE_DEVICE_SETTINGS_KEY]: '{not json' }));
        expect(getMobileDeviceSettings()).toEqual(DEFAULT_MOBILE_DEVICE_SETTINGS);
        expect(sanitizeMobileDeviceSettings({ vibrate: 'no', wakeLock: true })).toEqual({ vibrate: true, wakeLock: true });
    });

    it('works without localStorage at all (node / SSR)', () => {
        vi.stubGlobal('localStorage', undefined);
        expect(getMobileDeviceSettings()).toEqual(DEFAULT_MOBILE_DEVICE_SETTINGS);
        expect(setMobileDeviceSettings({ wakeLock: true }).wakeLock).toBe(true);
    });
});

describe('capability detection and fill vibration', () => {
    it('detects vibrate and wake lock support', () => {
        expect(vibrationSupported({ vibrate: () => true })).toBe(true);
        expect(vibrationSupported({})).toBe(false);
        expect(vibrationSupported(undefined)).toBe(false);
        expect(wakeLockSupported({ wakeLock: { request: () => undefined } })).toBe(true);
        expect(wakeLockSupported({ wakeLock: null })).toBe(false);
        expect(wakeLockSupported({})).toBe(false);
    });

    it('vibrates once when enabled and supported, never when disabled or unsupported', () => {
        vi.stubGlobal('localStorage', memoryStorage());
        const vibrate = vi.fn(() => true);
        expect(vibrateOnFill({ vibrate })).toBe(true);
        expect(vibrate).toHaveBeenCalledWith(FILL_VIBRATE_MS);

        setMobileDeviceSettings({ vibrate: false });
        vibrate.mockClear();
        expect(vibrateOnFill({ vibrate })).toBe(false);
        expect(vibrate).not.toHaveBeenCalled();

        setMobileDeviceSettings({ vibrate: true });
        expect(vibrateOnFill({})).toBe(false);
    });

    it('swallows vibrate exceptions (no user gesture)', () => {
        vi.stubGlobal('localStorage', memoryStorage());
        expect(vibrateOnFill({ vibrate: () => { throw new Error('blocked'); } })).toBe(false);
    });
});
