// src/mobile/lib/positions-view.ts — 持倉頁「詳細｜精簡」檢視的裝置偏好
//
// - 預設「詳細」（既有使用者不會突然看到不同的畫面）；存 localStorage 'sj-mobile-positions-view'（'compact'＝精簡，其他＝詳細）。
// - 讀寫都包 try/catch：無痕、停用儲存或配額不足時只在本次有效，壞值一律視為「詳細」。
// - 獨立成檔、不併入 ui-settings（sj-mobile-ui-v1）：那份設定的形狀被既有測試精確比對。

export type PositionsView = 'detail' | 'compact';

export const POSITIONS_VIEW_KEY = 'sj-mobile-positions-view';

export function readPositionsView(): PositionsView {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(POSITIONS_VIEW_KEY) === 'compact' ? 'compact' : 'detail';
    } catch {
        return 'detail';
    }
}

export function writePositionsView(view: PositionsView): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(POSITIONS_VIEW_KEY, view);
    } catch {
        // 無痕或配額不足：只在本次有效
    }
}
