// src/mobile/lib/watch-list-order.ts — 自選群組（清單）的顯示順序：只存在這台裝置（設計規格 §7.2）
//
// - 伺服器的自選清單沒有順序欄位、也沒有排序 API（ServerWatchlist 只有 id、name、contracts）；不可用刪除再重建來換順序
//   （會換 id、有遺失資料的風險）。因此順序只存在這台裝置的 localStorage 'sj-mobile-watch-list-order-v1'（清單 id 陣列），
//   桌面不受影響。不發任何網路請求。
// - 顯示順序（orderLists）：已存的 id 依存的順序在前（只留仍存在的清單），其他清單依伺服器順序接在後面（新清單在最後）；
//   已刪除的 id 直接略過，下次存檔（排序面板傳入目前顯示的清單 id）時一併移除。
//   讀取失敗、內容不是字串陣列時當作沒有設定（伺服器順序）。
// - 首屏（自選頁清單分頁）會用到，刻意保持很小：每次呼叫直接讀 localStorage（沒有記憶體快取與訂閱）。
//   寫入（saveListOrder）在編輯模式的延遲載入 chunk（components/watch-edit-controls.tsx 的排序群組面板），
//   存檔後由自選頁傳入的回呼重繪；交易頁 ☆ 面板在開啟時讀取。寫入失敗（儲存空間不可用）時順序不會保留。

export const LIST_ORDER_KEY = 'sj-mobile-watch-list-order-v1';

/** 存在這台裝置的順序（清單 id 陣列）；沒有設定、讀取失敗或格式不對時 [] */
export function readListOrder(): string[] {
    try {
        const ids: unknown = JSON.parse(localStorage.getItem(LIST_ORDER_KEY)!);
        if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) return ids;
    } catch {
        // 不可用或內容損毀：當作沒有設定
    }
    return [];
}

/** 依這台裝置的順序排列清單：已存的 id 在前（依存的順序），其他依伺服器順序在後（sort 為穩定排序） */
export function orderLists<T extends { id: string }>(lists: readonly T[], ids: readonly string[] = readListOrder()): T[] {
    const rank = (l: T) => (ids.indexOf(l.id) + 1 || 1e9);
    return [...lists].sort((a, b) => rank(a) - rank(b));
}
