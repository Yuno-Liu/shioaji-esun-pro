// src/mobile/lib/ui-settings.ts — 手機介面偏好（降低透明度、介面觸覺回饋）（設計規格 §5.3、§9）
//
// - 新的 localStorage 鍵 'sj-mobile-ui-v1'；不動 mobile-device-settings.ts（'sj-mobile-device-v1'）及其測試。
// - 讀寫都包 try/catch；不可用時退回記憶體，只在本次有效。
// - 第一次載入且沒有儲存值：非 iOS（沒有 GestureEvent）且 hardwareConcurrency ≤ 4 或 deviceMemory ≤ 3
//   → 預設 transparency: 'reduced' 並寫回（低階 Android 的模糊成本）。
// - html[data-sj-transparency] 屬性由殼層依這裡的值設定（不在本模組）。

import { useSyncExternalStore } from 'react';

export const MOBILE_UI_SETTINGS_KEY = 'sj-mobile-ui-v1';

export interface MobileUiSettings {
    /** system＝跟系統（prefers-reduced-transparency）；reduced＝材質實心；full＝一律半透明 */
    transparency: 'system' | 'reduced' | 'full';
    /** 介面觸覺回饋（滑塊門檻、長按、步進撞界）；成交震動另由 mobile-device-settings 控制 */
    uiHaptics: boolean;
}

export const DEFAULT_MOBILE_UI_SETTINGS: Readonly<MobileUiSettings> = Object.freeze({ transparency: 'system', uiHaptics: true });

const TRANSPARENCY = ['system', 'reduced', 'full'] as const;

export function sanitizeMobileUiSettings(v: unknown): MobileUiSettings {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const d = DEFAULT_MOBILE_UI_SETTINGS;
    return {
        transparency: (TRANSPARENCY as readonly unknown[]).includes(o.transparency) ? (o.transparency as MobileUiSettings['transparency']) : d.transparency,
        uiHaptics: typeof o.uiHaptics === 'boolean' ? o.uiHaptics : d.uiHaptics,
    };
}

// ---- 裝置判斷 ----

export interface DeviceEnv {
    GestureEvent?: unknown;
    navigator?: { hardwareConcurrency?: unknown; deviceMemory?: unknown };
}

function env(): DeviceEnv {
    return {
        GestureEvent: (globalThis as { GestureEvent?: unknown }).GestureEvent,
        navigator: typeof navigator === 'undefined' ? undefined : (navigator as unknown as DeviceEnv['navigator']),
    };
}

/** iOS／iPadOS（WebKit 才有 GestureEvent） */
export function isIOSWebKit(e: DeviceEnv = env()): boolean {
    return typeof e.GestureEvent !== 'undefined';
}

/** 低階 Android 啟發式：非 iOS 且 CPU ≤ 4 核或記憶體 ≤ 3 GB */
export function isLowEndDevice(e: DeviceEnv = env()): boolean {
    if (isIOSWebKit(e)) return false;
    const n = e.navigator;
    const cores = n?.hardwareConcurrency;
    const memory = n?.deviceMemory;
    return (typeof cores === 'number' && cores > 0 && cores <= 4) || (typeof memory === 'number' && memory > 0 && memory <= 3);
}

// ---- 儲存 ----

let current: MobileUiSettings | null = null;
const listeners = new Set<() => void>();

function write(v: MobileUiSettings): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(MOBILE_UI_SETTINGS_KEY, JSON.stringify(v));
    } catch {
        // 無痕或配額不足：只在本次有效
    }
}

function load(): MobileUiSettings {
    let raw: string | null = null;
    try {
        raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(MOBILE_UI_SETTINGS_KEY);
    } catch {
        raw = null;
    }
    if (raw !== null) {
        try {
            return sanitizeMobileUiSettings(JSON.parse(raw));
        } catch {
            return sanitizeMobileUiSettings(null);
        }
    }
    // 第一次載入：低階裝置預設降低透明度並寫回（之後完全尊重使用者的選擇）
    if (isLowEndDevice()) {
        const v: MobileUiSettings = { ...DEFAULT_MOBILE_UI_SETTINGS, transparency: 'reduced' };
        write(v);
        return v;
    }
    return { ...DEFAULT_MOBILE_UI_SETTINGS };
}

export function getMobileUiSettings(): MobileUiSettings {
    current ??= load();
    return current;
}

/** 合併後寫入；沒有變化時不寫、不通知；寫入失敗仍在本次生效 */
export function setMobileUiSettings(patch: Partial<MobileUiSettings>): MobileUiSettings {
    const prev = getMobileUiSettings();
    const next = sanitizeMobileUiSettings({ ...prev, ...patch });
    if (next.transparency === prev.transparency && next.uiHaptics === prev.uiHaptics) return prev;
    current = next;
    write(next);
    listeners.forEach(l => l());
    return next;
}

export function subscribeMobileUiSettings(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useMobileUiSettings(): MobileUiSettings {
    return useSyncExternalStore(subscribeMobileUiSettings, getMobileUiSettings, getMobileUiSettings);
}

/** 測試用：清掉記憶體中的設定與監聽，下次讀取重新載入 */
export function resetMobileUiSettingsForTest(): void {
    current = null;
    listeners.clear();
}
