// src/mobile/lib/chart-limit-range.ts — 走勢圖「漲跌停範圍」模式（設計規格 §7.3）
//
// 點走勢圖右側的價格軸切換：主圖 Y 軸固定為 [跌停, 漲停]，再點回到自動範圍。
// 狀態只放在模組層：本次使用期間換檔、換週期再回到走勢都沿用；預設自動，不寫進 storage（重新開啟 App 回到自動）。

import { useSyncExternalStore } from 'react';

let on = false;
const listeners = new Set<() => void>();

export function getLimitRange(): boolean {
    return on;
}

export function setLimitRange(next: boolean) {
    if (next === on) return;
    on = next;
    listeners.forEach(l => l());
}

export function toggleLimitRange() {
    setLimitRange(!on);
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function useLimitRange(): boolean {
    return useSyncExternalStore(subscribe, getLimitRange, getLimitRange);
}

/** 有漲跌停可用：非指數，漲停、跌停都是正數且漲停高於跌停 */
export function hasLimitRange(c: { security_type: string | null | undefined; limit_up: number; limit_down: number }): boolean {
    return c.security_type !== 'IND' && c.limit_up > 0 && c.limit_down > 0 && c.limit_up > c.limit_down;
}

/** 測試用：回到預設（自動範圍） */
export function resetLimitRangeForTest() {
    on = false;
    listeners.forEach(l => l());
}
