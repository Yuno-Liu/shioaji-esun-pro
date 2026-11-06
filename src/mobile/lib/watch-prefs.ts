// src/mobile/lib/watch-prefs.ts — 自選頁的裝置偏好：迷你走勢開關（帳戶頁「顯示」）
//
// - 預設開啟；存 localStorage 'sj-mobile-watch-spark'（'0'＝關、其他＝開）。讀寫都包 try/catch，不可用時只在本次有效。
// - 關閉時自選頁不掛載走勢欄，也就完全不發 K 線請求（lib/watch-sparkline-data.ts 只在列可見且開啟時排隊）。
// - 獨立成檔、不併入 ui-settings（sj-mobile-ui-v1）：那份設定的形狀被既有測試精確比對。

import { useSyncExternalStore } from 'react';

export const WATCH_SPARK_KEY = 'sj-mobile-watch-spark';

let current: boolean | null = null;
const listeners = new Set<() => void>();

function load(): boolean {
    try {
        return (typeof localStorage === 'undefined' ? null : localStorage.getItem(WATCH_SPARK_KEY)) !== '0';
    } catch {
        return true;
    }
}

export function getWatchSparklineEnabled(): boolean {
    current ??= load();
    return current;
}

export function setWatchSparklineEnabled(next: boolean): void {
    if (getWatchSparklineEnabled() === next) return;
    current = next;
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(WATCH_SPARK_KEY, next ? '1' : '0');
    } catch {
        // 無痕或配額不足：只在本次有效
    }
    listeners.forEach(l => l());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useWatchSparklineEnabled(): boolean {
    return useSyncExternalStore(subscribe, getWatchSparklineEnabled, getWatchSparklineEnabled);
}

/** 測試用：清掉記憶體中的值，下次讀取重新載入 */
export function resetWatchPrefsForTest(): void {
    current = null;
    listeners.clear();
}
