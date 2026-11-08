// src/mobile/components/trade-info/load-trade-chips-sheet.ts — 「籌碼與當沖」面板的延遲載入入口（規格 §13 首次載入體積）
//
// 只有使用者點交易頁的當沖資訊列時才 import（連同 lib/trade-chips、credit_enquire 與券源的讀取）；不閒置預載。
// 獨立成檔：測試以 vi.mock 這個模組替換面板（同 company/load-company-tab 的作法）。
export const loadTradeChipsSheet = () => import('./trade-chips-sheet');
