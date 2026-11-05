// src/mobile/components/order-confirm-sheet.tsx — requestOrderConfirm() 的手機確認面板 host（規格 §6.4）
//
// 必須掛在 App 根層：否則 requestOrderConfirm() 的 promise 永遠不會結束。
//
// 【目前為樁（T1）】只要有待確認的委託，立即 resolveOrderConfirm(false)（取消＝確定沒有送出）並發出通知。
// **絕不自動核准**，也不讓 promise 懸置。T3 會改成真正的確認面板：
//   - 綁定 subscribeOrderConfirm()／getPendingOrderConfirm()／resolveOrderConfirm()（src/lib/order-confirm.ts）；
//   - 顯示動作（含信用名稱）、商品、價格（市價顯示「市價」）、數量＋單位、note、accountLabel（privacyAccountLabel）、環境大字；
//   - SlideToConfirm 停用條件同桌面 order-confirm-dialog.tsx：awaitingMode、simulation === null、serverChanged、
//     有 livePriceCode 但尚無即時價；serverChanged 時顯示「伺服器或模式已變更，這筆不會送出，請取消後重新下單」；
//   - ResumeGate 離開 ready 時自動 resolveOrderConfirm(false)。
// 元件名稱與「無 props、掛在根層」的用法是對外介面，T3 實作時請保留。

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getPendingOrderConfirm, resolveOrderConfirm, subscribeOrderConfirm, type OrderConfirmRequest } from '../../lib/order-confirm';
import { notify } from '../../lib/trade';

export function OrderConfirmSheet() {
    const pending = useSyncExternalStore(subscribeOrderConfirm, getPendingOrderConfirm);
    // StrictMode 會重跑 effect：同一筆只通知一次
    const handled = useRef(new WeakSet<OrderConfirmRequest>());

    useEffect(() => {
        if (!pending || handled.current.has(pending)) return;
        handled.current.add(pending);
        resolveOrderConfirm(false);
        notify({ kind: 'err', title: '未送出', body: '手機確認面板尚未完成，這筆委託已取消、沒有送出。' });
    }, [pending]);

    return null;
}
