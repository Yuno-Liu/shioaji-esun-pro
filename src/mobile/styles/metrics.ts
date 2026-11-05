// src/mobile/styles/metrics.ts — 手機版共用尺寸（規格 §11）
// 純常數，供 *.css.ts 與元件共用；顏色一律用 src/theme.css.ts 的 vars。

/** 觸控目標最小尺寸（44×44 pt） */
export const TOUCH_MIN = '44px';
/** 買進／賣出按鈕最小高度 */
export const TRADE_BUTTON_MIN_HEIGHT = '56px';
/** 買進／賣出兩鍵最小間距 */
export const TRADE_BUTTON_GAP = '12px';
/** 輸入欄位字級下限（避免 iOS Safari 聚焦時自動放大） */
export const INPUT_FONT_SIZE = 'max(16px, 1rem)';

/** 安全區（viewport-fit=cover 時才有值；舊瀏覽器 env() 不支援時退回 0） */
export const SAFE_TOP = 'env(safe-area-inset-top, 0px)';
export const SAFE_BOTTOM = 'env(safe-area-inset-bottom, 0px)';
export const SAFE_LEFT = 'env(safe-area-inset-left, 0px)';
export const SAFE_RIGHT = 'env(safe-area-inset-right, 0px)';

/** 疊層順序：狀態列／分頁列 < 底部面板 < 確認面板 < toast */
export const Z = {
    bars: 10,
    sheet: 100,
    confirm: 200,
    toast: 300,
} as const;

export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
