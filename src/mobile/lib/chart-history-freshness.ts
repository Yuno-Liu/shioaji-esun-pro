// src/mobile/lib/chart-history-freshness.ts — 手機圖表歷史的新鮮度（規格 §9.3）
//
// 歷史以 revision 快取（chart-history-cache.ts：同組只留最新一份成功的回應，記憶體有上限）。手機切分頁、切週期、回前景都會重建圖表，
// 若一律用同一個 revision 會拿到舊歷史（走勢缺一段不補）。
// 這裡依 (code, period) 記下上次取得歷史的 revision、時間與 ResumeGate 的 resumeSeq：
//   - 沒有紀錄或上次失敗：以 nextChartHistoryRevision() 的新 revision 查詢（不重放失敗、不撿未知的舊快取）
//   - 超過 HISTORY_STALE_MS 或 resumeSeq 已改變：先顯示快取，背景以新 revision 重抓
//   - 其他：直接用快取

import type { ChartPeriod } from './chart-ranges';

/** 歷史快取可直接沿用的時間 */
export const HISTORY_STALE_MS = 60_000;

export interface HistoryEntry {
    revision: number;
    /** 發出這次查詢的時間（Date.now()） */
    at: number;
    resumeSeq: number;
    failed: boolean;
}

export type HistoryPlan =
    | { kind: 'fetch' }
    | { kind: 'cached'; revision: number; refresh: boolean };

/** 決定這次掛載／重建如何取得歷史（純函式） */
export function planHistory(entry: HistoryEntry | undefined, now: number, resumeSeq: number): HistoryPlan {
    if (!entry || entry.failed) return { kind: 'fetch' };
    const stale = now - entry.at > HISTORY_STALE_MS || entry.resumeSeq !== resumeSeq;
    return { kind: 'cached', revision: entry.revision, refresh: stale };
}

const entries = new Map<string, HistoryEntry>();
const keyOf = (code: string, period: ChartPeriod) => `${code}|${period}`;

export function getHistoryEntry(code: string, period: ChartPeriod): HistoryEntry | undefined {
    return entries.get(keyOf(code, period));
}

export function setHistoryEntry(code: string, period: ChartPeriod, entry: HistoryEntry): void {
    entries.set(keyOf(code, period), entry);
    // 只是快取索引：上限避免長時間使用累積
    if (entries.size > 200) entries.delete(entries.keys().next().value!);
}

/** 測試用 */
export function resetHistoryEntriesForTest(): void {
    entries.clear();
}
