// 手機介面偏好（'sj-mobile-ui-v1'）：sanitize、持久化、讀寫失敗容錯、低階 Android 首次預設降低透明度
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_MOBILE_UI_SETTINGS,
    getMobileUiSettings,
    isIOSWebKit,
    isLowEndDevice,
    MOBILE_UI_SETTINGS_KEY,
    resetMobileUiSettingsForTest,
    sanitizeMobileUiSettings,
    setMobileUiSettings,
    subscribeMobileUiSettings,
} from './ui-settings';

function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: vi.fn((k: string) => data.get(k) ?? null),
        setItem: vi.fn((k: string, v: string) => { data.set(k, v); }),
        removeItem: vi.fn((k: string) => { data.delete(k); }),
    };
}

beforeEach(() => {
    resetMobileUiSettingsForTest();
    // node 也有 navigator（真實核心數）：預設當成一般裝置，個別案例再覆寫
    vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 8 });
});
afterEach(() => {
    vi.unstubAllGlobals();
    resetMobileUiSettingsForTest();
});

describe('sanitizeMobileUiSettings', () => {
    it('預設 { transparency: system, uiHaptics: true }；無效欄位回預設', () => {
        expect(DEFAULT_MOBILE_UI_SETTINGS).toEqual({ transparency: 'system', uiHaptics: true });
        expect(sanitizeMobileUiSettings(null)).toEqual({ transparency: 'system', uiHaptics: true });
        expect(sanitizeMobileUiSettings('x')).toEqual({ transparency: 'system', uiHaptics: true });
        expect(sanitizeMobileUiSettings({ transparency: 'blur', uiHaptics: 'yes', extra: 1 })).toEqual({ transparency: 'system', uiHaptics: true });
        expect(sanitizeMobileUiSettings({ transparency: 'full', uiHaptics: false })).toEqual({ transparency: 'full', uiHaptics: false });
        expect(sanitizeMobileUiSettings({ transparency: 'reduced' })).toEqual({ transparency: 'reduced', uiHaptics: true });
    });
});

describe('裝置判斷', () => {
    it('iOS 以 GestureEvent 判斷', () => {
        expect(isIOSWebKit({})).toBe(false);
        expect(isIOSWebKit({ GestureEvent: function G() { /* */ } })).toBe(true);
    });

    it('低階：非 iOS 且 CPU ≤ 4 或記憶體 ≤ 3；缺值不算', () => {
        expect(isLowEndDevice({ navigator: { hardwareConcurrency: 4, deviceMemory: 8 } })).toBe(true);
        expect(isLowEndDevice({ navigator: { hardwareConcurrency: 8, deviceMemory: 3 } })).toBe(true);
        expect(isLowEndDevice({ navigator: { hardwareConcurrency: 8, deviceMemory: 4 } })).toBe(false);
        expect(isLowEndDevice({ navigator: {} })).toBe(false);
        expect(isLowEndDevice({})).toBe(false);
        expect(isLowEndDevice({ GestureEvent: function G() { /* */ }, navigator: { hardwareConcurrency: 2 } })).toBe(false);
    });
});

describe('持久化與首次預設', () => {
    it('沒有儲存值、一般裝置 → 預設值且不寫入', () => {
        const storage = memoryStorage();
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 8 });
        expect(getMobileUiSettings()).toEqual({ transparency: 'system', uiHaptics: true });
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('沒有儲存值、低階 Android → reduced 並寫回；之後尊重使用者選擇', () => {
        const storage = memoryStorage();
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
        expect(getMobileUiSettings().transparency).toBe('reduced');
        expect(JSON.parse(storage.data.get(MOBILE_UI_SETTINGS_KEY)!)).toEqual({ transparency: 'reduced', uiHaptics: true });
        setMobileUiSettings({ transparency: 'full' });
        resetMobileUiSettingsForTest();
        expect(getMobileUiSettings().transparency).toBe('full');
    });

    it('低階 iOS（有 GestureEvent）不套用降低透明度', () => {
        vi.stubGlobal('localStorage', memoryStorage());
        vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
        vi.stubGlobal('GestureEvent', function G() { /* */ });
        expect(getMobileUiSettings().transparency).toBe('system');
    });

    it('已有儲存值時不跑啟發式；壞掉的 JSON 回預設', () => {
        vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
        vi.stubGlobal('localStorage', memoryStorage({ [MOBILE_UI_SETTINGS_KEY]: JSON.stringify({ transparency: 'system', uiHaptics: false }) }));
        expect(getMobileUiSettings()).toEqual({ transparency: 'system', uiHaptics: false });
        resetMobileUiSettingsForTest();
        vi.stubGlobal('localStorage', memoryStorage({ [MOBILE_UI_SETTINGS_KEY]: '{oops' }));
        expect(getMobileUiSettings()).toEqual({ transparency: 'system', uiHaptics: true });
    });

    it('寫入 sj-mobile-ui-v1、通知監聽；沒有變化時不寫不通知', () => {
        const storage = memoryStorage();
        vi.stubGlobal('localStorage', storage);
        const listener = vi.fn();
        const off = subscribeMobileUiSettings(listener);
        setMobileUiSettings({ uiHaptics: true });
        expect(listener).not.toHaveBeenCalled();
        expect(storage.setItem).not.toHaveBeenCalled();
        setMobileUiSettings({ uiHaptics: false });
        expect(listener).toHaveBeenCalledOnce();
        expect(JSON.parse(storage.data.get(MOBILE_UI_SETTINGS_KEY)!)).toEqual({ transparency: 'system', uiHaptics: false });
        setMobileUiSettings({ transparency: 'nope' as never });
        expect(listener).toHaveBeenCalledOnce();
        off();
        setMobileUiSettings({ uiHaptics: true });
        expect(listener).toHaveBeenCalledOnce();
    });

    it('localStorage 讀寫丟例外：只在本次有效', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('SecurityError'); },
            setItem: () => { throw new Error('QuotaExceeded'); },
        });
        vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
        expect(getMobileUiSettings().transparency).toBe('reduced');
        expect(setMobileUiSettings({ transparency: 'full' }).transparency).toBe('full');
        expect(getMobileUiSettings().transparency).toBe('full');
    });

    it('沒有 localStorage（node）時用預設', () => {
        vi.stubGlobal('localStorage', undefined);
        expect(getMobileUiSettings()).toEqual({ transparency: 'system', uiHaptics: true });
    });
});
