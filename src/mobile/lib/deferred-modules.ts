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
/**
 * 自選列迷你走勢（canvas＋1 分 K 資料、時段計算）：只有可見列才載入與掛載；
 * 載入前與載入失敗時走勢欄是同尺寸空白佔位，不影響列與頁面。
 */
export const loadWatchSparkline = () => import('../components/watch-sparkline');
/** 自選頁商品搜尋面板（按「搜尋」或空清單的「搜尋並加入」才掛載；連同 lib/product-search 約 4 KiB gzip） */
export const loadSearchSheet = () => import('../components/search-sheet');
/** 自選清單名稱面板（新增清單、重新命名；按「＋」或編輯模式的「重新命名」才掛載） */
export const loadWatchListSheet = () => import('../components/watch-list-sheet');
