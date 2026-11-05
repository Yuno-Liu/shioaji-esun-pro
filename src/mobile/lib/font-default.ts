// src/mobile/lib/font-default.ts — 手機第一次啟動時把字級預設為「小」
//
// 字級與桌面共用 src/lib/theme-store（localStorage 'sj-pro-theme'；FontScale 1＝小、1.15＝標準（預設）、1.3＝大）。
// 手機畫面窄，使用者要求預設「小」；但不改 src/lib（R2），所以只在手機第一次啟動時調整一次：
// - 手機旗標 'sj-mobile-font-default-v1' 已存在 → 什麼都不做（之後完全尊重使用者在帳戶頁的選擇，包含改回「標準」）。
// - 旗標不存在：沒有已存的主題設定、或已存的字級仍是預設 1.15（含缺值、無效值、無法解析）→ 改成 1（小）；
//   使用者已明確選過「小」或「大」→ 不動。不論是否調整都寫入旗標。
// 儲存空間不可用（例如部分私密瀏覽）時不調整、不丟錯。

import { setThemeSettings, type FontScale } from '../../lib/theme-store';

/** 手機版字級預設已處理的旗標 */
export const MOBILE_FONT_DEFAULT_FLAG = 'sj-mobile-font-default-v1';
/** theme-store 的儲存鍵（src/lib/theme-store.ts 未匯出，值需保持一致） */
export const THEME_STORAGE_KEY = 'sj-pro-theme';
/** 手機預設字級：小 */
export const MOBILE_DEFAULT_FONT_SCALE: FontScale = 1;

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): KeyValueStorage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

/**
 * 已存的主題設定是否等同桌面預設字級（1.15）。
 * 對照 theme-store 的 migrateScale：1、1.3 是使用者的選擇；舊值 0.85 會遷移成 1（也是使用者選的「小」）；
 * 其餘（1.15、缺值、無效值、JSON 壞掉、沒有存過）實際生效的都是預設 1.15。
 */
export function storedScaleIsDefault(raw: string | null): boolean {
    if (raw === null) return true;
    try {
        const parsed = JSON.parse(raw) as unknown;
        const scale = parsed && typeof parsed === 'object' ? (parsed as { fontScale?: unknown }).fontScale : undefined;
        return !(scale === 1 || scale === 1.3 || scale === 0.85);
    } catch {
        return true;
    }
}

/**
 * 在 initTheme() 之後呼叫（不論是否 secure context）。
 * 回傳 true 表示這次把字級改成「小」。
 */
export function applyMobileFontDefault(storage: KeyValueStorage | null = defaultStorage()): boolean {
    if (!storage) return false;
    let raw: string | null;
    try {
        if (storage.getItem(MOBILE_FONT_DEFAULT_FLAG) !== null) return false;
        raw = storage.getItem(THEME_STORAGE_KEY);
    } catch {
        return false;
    }
    let applied = false;
    if (storedScaleIsDefault(raw)) {
        try {
            setThemeSettings({ fontScale: MOBILE_DEFAULT_FONT_SCALE });
            applied = true;
        } catch {
            // 寫入失敗（儲存空間已滿等）：維持原字級
        }
    }
    try {
        storage.setItem(MOBILE_FONT_DEFAULT_FLAG, '1');
    } catch {
        // 無法記錄旗標：下次啟動會再判斷一次（仍只在字級是預設值時才調整）
    }
    return applied;
}
