// src/mobile/components/account/esun-reconnect-section.tsx — 帳戶頁「玉山重新連線」區塊（規格 Phase 2）
//
// 【樁】由帳戶頁（routes/account-page.tsx）掛載在玉山連線狀態旁；內容另由負責「帳戶設定與裝置」的任務實作：
// 只提供一般重新連線（esunTradeService.reconnect()，絕不帶 force）、60 秒冷卻、按下前提醒「密碼錯 3 次會鎖帳」。
// 對外介面固定：無 props 的 EsunReconnectSection（沒有玉山帳戶或 bridge 時自行回 null）。

export function EsunReconnectSection() {
    return null;
}
