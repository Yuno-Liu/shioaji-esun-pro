// src/mobile/styles/metrics.ts — 手機版共用尺寸（規格 §11；設計規格 mobile-design.md §4.1）
// 改為轉出 tokens.ts 並保留原匯出名；新程式請直接從 ./tokens 取用。顏色一律用 src/theme.css.ts 的 vars。
//
// - TOUCH_MIN：'max(44px, 2.75rem)'（字級大時同步放大）
// - TRADE_BUTTON_MIN_HEIGHT：維持 '56px'（滑塊幾何依賴）
// - Z：擴充鍵（compactBar、accessory、fullscreenChart、sheetStep），原鍵 bars／sheet／confirm／toast 值不變
export {
    INPUT_FONT_SIZE,
    REDUCED_MOTION,
    SAFE_BOTTOM,
    SAFE_LEFT,
    SAFE_RIGHT,
    SAFE_TOP,
    TOUCH_MIN,
    TRADE_BUTTON_GAP,
    TRADE_BUTTON_MIN_HEIGHT,
    Z,
} from './tokens';
