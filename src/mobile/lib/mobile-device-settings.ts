// src/mobile/lib/mobile-device-settings.ts — 手機「本裝置」設定（震動回饋、螢幕常亮）
//
// - 只存在本裝置的 localStorage（'sj-mobile-device-v1'），不與桌面共用；讀寫都包 try/catch，
//   不可用（無痕、被封鎖、測試的 node 環境）時退回記憶體，只在本次有效。
// - 成交音效的開關不在這裡：沿用 src/lib/sounds.ts 的 soundEnabled／setSoundEnabled（'sj-pro-sound'，與桌面共用）。
// - 能力偵測（navigator.vibrate、navigator.wakeLock）也放這裡，設定區塊與 hook 共用同一個判斷。

import { useSyncExternalStore } from 'react';

export const MOBILE_DEVICE_SETTINGS_KEY = 'sj-mobile-device-v1';

export interface MobileDeviceSettings {
    /** 成交時短震（只有支援 navigator.vibrate 的瀏覽器有效；iOS Safari 不支援） */
    vibrate: boolean;
    /** 螢幕常亮（Wake Lock API；頁面可見時才持有） */
    wakeLock: boolean;
}

/** 震動預設開：與規格 §5.5「成交時 Android 震動」的既有行為一致；螢幕常亮預設關（耗電） */
export const DEFAULT_MOBILE_DEVICE_SETTINGS: Readonly<MobileDeviceSettings> = Object.freeze({ vibrate: true, wakeLock: false });

/** 成交短震的長度（毫秒） */
export const FILL_VIBRATE_MS = 20;

export function sanitizeMobileDeviceSettings(v: unknown): MobileDeviceSettings {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const d = DEFAULT_MOBILE_DEVICE_SETTINGS;
    return {
        vibrate: typeof o.vibrate === 'boolean' ? o.vibrate : d.vibrate,
        wakeLock: typeof o.wakeLock === 'boolean' ? o.wakeLock : d.wakeLock,
    };
}

let current: MobileDeviceSettings | null = null;
const listeners = new Set<() => void>();

function load(): MobileDeviceSettings {
    try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(MOBILE_DEVICE_SETTINGS_KEY);
        return sanitizeMobileDeviceSettings(raw ? JSON.parse(raw) : null);
    } catch {
        return sanitizeMobileDeviceSettings(null);
    }
}

export function getMobileDeviceSettings(): MobileDeviceSettings {
    current ??= load();
    return current;
}

/** 合併後寫入；寫入 localStorage 失敗時仍在本次生效 */
export function setMobileDeviceSettings(patch: Partial<MobileDeviceSettings>): MobileDeviceSettings {
    const next = sanitizeMobileDeviceSettings({ ...getMobileDeviceSettings(), ...patch });
    const prev = getMobileDeviceSettings();
    if (next.vibrate === prev.vibrate && next.wakeLock === prev.wakeLock) return prev;
    current = next;
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(MOBILE_DEVICE_SETTINGS_KEY, JSON.stringify(next));
    } catch {
        // 無痕或配額不足：只在本次有效
    }
    listeners.forEach(l => l());
    return next;
}

export function subscribeMobileDeviceSettings(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useMobileDeviceSettings(): MobileDeviceSettings {
    return useSyncExternalStore(subscribeMobileDeviceSettings, getMobileDeviceSettings, getMobileDeviceSettings);
}

/** 測試用：清掉記憶體中的設定，下次讀取重新從 localStorage 載入 */
export function resetMobileDeviceSettingsForTest(): void {
    current = null;
    listeners.clear();
}

// ---- 能力偵測 ----

type NavLike = { vibrate?: unknown; wakeLock?: { request?: unknown } | null } | undefined;

function nav(): NavLike {
    return typeof navigator === 'undefined' ? undefined : (navigator as unknown as NavLike);
}

/** 瀏覽器有 navigator.vibrate（Android Chrome 有；iOS／iPadOS Safari 沒有） */
export function vibrationSupported(n: NavLike = nav()): boolean {
    return !!n && typeof n.vibrate === 'function';
}

/** 瀏覽器有 Screen Wake Lock API（iOS／iPadOS 16.4 起、Android Chrome 84 起） */
export function wakeLockSupported(n: NavLike = nav()): boolean {
    return !!n && !!n.wakeLock && typeof n.wakeLock.request === 'function';
}

/**
 * 成交短震：設定開啟且瀏覽器支援才震；部分瀏覽器在沒有使用者手勢時會丟例外，一律忽略。
 * 回傳是否有呼叫 navigator.vibrate。
 */
export function vibrateOnFill(n: NavLike = nav()): boolean {
    if (!getMobileDeviceSettings().vibrate || !vibrationSupported(n)) return false;
    try {
        (n as { vibrate: (ms: number) => boolean }).vibrate(FILL_VIBRATE_MS);
        return true;
    } catch {
        return false;
    }
}
