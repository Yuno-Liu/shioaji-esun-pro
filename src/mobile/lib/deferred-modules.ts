// src/mobile/lib/deferred-modules.ts — 殼層與預設分頁上「按了才用到」的模組的延遲載入入口（規格 §13 首次載入體積）
//
// 使用端以 retryableLazy＋ModuleErrorBoundary 包起來（route-error-boundary.tsx）；app.tsx 的閒置預載
// （usePrefetchDeferredModules）呼叫同一組函式，第一次開啟時 chunk 通常已在快取。
// 獨立成檔：app.tsx 不必從 watchlist-page 匯入（測試常整個替換這個模組）。
//
// 刻意不延遲：狀態列的面板（帳戶切換、連線詳情與 ResumeGate 確認、解除鎖單）留在首屏。帳戶切換曾試過延遲載入，
// 只省約 0.3 KiB，但載入中點了沒有回饋、殼層也不會 inert，使用者改開下單面板後，帳戶面板晚到會疊上去並搶走焦點，
// 為了這點體積不值得。
/** 漲跌幅排行（自選頁「排行」分段） */
export const loadRankingList = () => import('../components/ranking-list');
