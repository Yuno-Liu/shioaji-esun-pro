// src/mobile/components/order-ticket-sheet.tsx — 下單底部面板（規格 §6.3）
//
// 【目前為樁（T1）】只顯示「開發中」，沒有任何送單路徑。
// 介面：無 props、掛在 App 根層；開啟狀態與帶入的方向／價格來自 mobile-store 的 `ticket`
// （openTicket()／closeTicket()；ticket.seq 遞增代表新的開啟，需重新初始化欄位）。
// T4 實作時：送出一律呼叫 submitMobileOrder()（lib/mobile-order.ts），預覽前的即時驗證見規格 §6.3；
// 頂端必顯示 <RouteBadge account={displayedAccount} />，環境未確認時停用預覽。

import { closeTicket, useMobileUi } from '../lib/mobile-store';
import * as layout from '../styles/layout.css';
import { BottomSheet } from './bottom-sheet';

export function OrderTicketSheet() {
    const { ticket } = useMobileUi();
    return (
        <BottomSheet open={ticket !== null} onClose={closeTicket} title={ticket ? `下單 ${ticket.code}` : '下單'} testId='order-ticket-sheet'>
            <p className={layout.placeholder}>下單面板開發中，目前無法下單。</p>
        </BottomSheet>
    );
}
