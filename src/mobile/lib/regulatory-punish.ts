// src/mobile/lib/regulatory-punish.ts — 處置股清單（自選列「處置」徽章）
//
// - GET /api/v1/data/regulatory_punish → { code: string[] }（桌面 src/components/chips-card.tsx 也用它）。
// - 模組層快取；自選頁可見（usePunishedCodes 的 active 為 true）時最多每 PUNISH_REFRESH_MS 讀一次，
//   頁面持續開著時以同樣間隔更新。失敗靜默（保留上次結果），同樣要等下一個間隔才重試。

import { useEffect, useSyncExternalStore } from 'react';
import { apiGet } from '../../lib/api';

export const PUNISH_REFRESH_MS = 30 * 60_000;
export const PUNISH_PATH = '/api/v1/data/regulatory_punish';

let codes: ReadonlySet<string> = new Set();
let lastAttempt = 0;
let inflight = false;
const listeners = new Set<() => void>();

/** 距上次嘗試已超過間隔時讀取一次（成功或失敗都記時間；失敗不清除舊結果） */
export function refreshPunishedCodes(now: number = Date.now()): void {
    if (inflight || (lastAttempt > 0 && now - lastAttempt < PUNISH_REFRESH_MS)) return;
    inflight = true;
    lastAttempt = now;
    apiGet<{ code?: unknown }>(PUNISH_PATH)
        .then(res => {
            const list = Array.isArray(res?.code) ? res.code.filter((c): c is string => typeof c === 'string') : [];
            codes = new Set(list);
            listeners.forEach(l => l());
        }, () => undefined)
        .finally(() => { inflight = false; });
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

const getCodes = () => codes;

/** active 時讀取（受間隔限制）並在頁面開著期間定期更新；回傳目前的處置代碼集合 */
export function usePunishedCodes(active: boolean): ReadonlySet<string> {
    useEffect(() => {
        if (!active) return;
        refreshPunishedCodes();
        const timer = setInterval(() => refreshPunishedCodes(), PUNISH_REFRESH_MS);
        return () => clearInterval(timer);
    }, [active]);
    return useSyncExternalStore(subscribe, getCodes, getCodes);
}

/** 測試用 */
export function resetPunishedCodesForTest(): void {
    codes = new Set();
    lastAttempt = 0;
    inflight = false;
    listeners.clear();
}
