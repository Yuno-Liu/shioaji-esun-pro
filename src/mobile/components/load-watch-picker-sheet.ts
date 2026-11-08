// src/mobile/components/load-watch-picker-sheet.ts — 交易頁 ☆「加入自選」清單選擇面板的延遲載入入口（規格 §13 首次載入體積）
//
// 只有使用者在交易頁按 ☆ 時才 import（不閒置預載）；交易頁本身是延遲載入，首屏不受影響。
// 獨立成檔：測試可以 vi.mock 這個模組控制載入中與失敗（同 trade-info/load-trade-chips-sheet 的作法）。
export const loadWatchPickerSheet = () => import('./watch-picker-sheet');
