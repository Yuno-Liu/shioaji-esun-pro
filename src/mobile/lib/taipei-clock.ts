// src/mobile/lib/taipei-clock.ts — 台北時間 HH:mm:ss（不依裝置時區）
//
// 行情、券商資料與委託都以台北時間計：裝置設在其他時區（出國、模擬器預設 UTC）時，getHours() 會顯示當地時間而對不上盤中時段。
// 比照 components/order-action-sheet.tsx 的 orderTimeText：毫秒加 8 小時後用 UTC getter（台灣沒有夏令時間）。
// 本檔不 import 其他模組（狀態列在首屏）。

const TAIPEI_OFFSET_MS = 8 * 3600_000;

/** 毫秒時間戳 → 台北時間 HH:mm:ss；0、缺值、非有限值顯示 — */
export function taipeiClock(ms: number | null | undefined): string {
    if (!ms || !Number.isFinite(ms)) return '—';
    const d = new Date(ms + TAIPEI_OFFSET_MS);
    if (!Number.isFinite(d.getTime())) return '—';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
