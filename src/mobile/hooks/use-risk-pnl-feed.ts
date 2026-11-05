// src/mobile/hooks/use-risk-pnl-feed.ts — 風控當日損益餵送（規格 §7.5）
//
// 【目前為樁（T1）】不做任何事；已掛在 MobileApp 根層（app.tsx）。
// T7 實作：與 src/App.tsx:1045-1053 同公式——持倉未實現損益＋期貨結算損益，呼叫 reportDailyPnl(pnl, known)；
// known 只有在持倉與保證金都已實際讀到時才為 true。未實作前「當日虧損上限」在手機上不會生效
// （風控鎖與單筆上限不受影響）。

export function useRiskPnlFeed(): void {
    // T7 實作
}
