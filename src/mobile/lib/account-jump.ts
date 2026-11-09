// src/mobile/lib/account-jump.ts — 從其他畫面跳到帳戶頁的某個區塊（首屏；只導覽，不發任何請求）
//
// 狀態列的帳戶切換面板「玉山環境切換」連結 → 帳戶 › 連線的交易環境區塊（components/account/env-switch-section.tsx）。
// 區塊掛載時（或已在帳戶頁時由 onAccountJump 通知）以 takeAccountJump(id) 消化請求，捲到區塊並聚焦。

import { navigate } from './hash-router';

let pending: string | null = null;
const listeners = new Set<() => void>();

export function jumpToAccountSection(id: string): void {
    pending = id;
    navigate({ name: 'account' });
    listeners.forEach(l => l());
}

/** 有待處理的跳轉請求且目標是 id：回 true 並清除 */
export function takeAccountJump(id: string): boolean {
    if (pending !== id) return false;
    pending = null;
    return true;
}

export function onAccountJump(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
