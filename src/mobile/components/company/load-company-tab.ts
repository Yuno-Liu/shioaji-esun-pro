// src/mobile/components/company/load-company-tab.ts — 交易頁「公司」分頁的延遲載入入口（規格 §13 首次載入體積）
//
// 只有使用者切到「公司」分頁時才 import（連同 lib/company-data 的讀取器與 hooks/use-company-data）；不閒置預載。
// 獨立成檔：測試以 vi.mock 這個模組控制載入成功、失敗與重試（同 lib/deferred-modules 的作法）。
export const loadCompanyTab = () => import('./company-tab');
