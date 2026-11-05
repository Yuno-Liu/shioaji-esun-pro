// src/mobile/lib/mobile-order.ts — 手機新單流程（規格 §7.1）
//
// 【目前為樁（T1）】submitMobileOrder 一律丟出 mutationNotStarted「尚未實作」，**不會呼叫任何送單函式**。
// T3 會依規格 §7.1 實作：只編排 src/lib 既有函式（assertTradingLive、captureServerMode、checkOrderAllowed、
// futuresOrderProblem／esunStockLegProblem／stockOrderProblem、captureSelectedAccount、captureDisplayedRoute、
// requestOrderConfirm（強制確認）、確認後重驗、beforeDispatch 最後重驗、placeStockOrder／placeFuturesOrder），
// 不自行組 HTTP 請求。
// 注意（給 T3）：src/lib/trade.ts 的 OrderConfirmCancelled 建構子不接受參數（規格範例的
// `new OrderConfirmCancelled('已取消下單')` 會型別錯誤），請用 `new OrderConfirmCancelled()`。

import type { Trade } from '../../lib/types/order';
import { notStarted } from './errors';
import type { MobileOrderInput } from './mobile-order-types';

export interface MobileOrderGuards {
    /**
     * ResumeGate 閘門：必須是 ready（或 stale-data 且使用者已勾選了解）；否則丟出 mutationNotStarted。
     * 一般以 `() => assertResumeReady({ allowStale: <使用者已勾選> })`（resume-gate-runtime.ts）提供。
     * 送出前與 beforeDispatch 都會呼叫。
     */
    assertResumeReady(): void;
    /** 商品／單位／條件沒有變（useOrderContext 的擷取結果）；false 時 beforeDispatch 丟出 ORDER_CONTEXT_CHANGED_MESSAGE */
    isContextCurrent(): boolean;
}

/**
 * 送出一筆手機新單。
 * - resolve：券商已受理（Trade）。
 * - reject 且 err.mutationNotStarted === true：確定沒有送出（含 OrderConfirmCancelled）。
 * - reject 其他錯誤：結果未知，禁止自動重送（規格 R6、§7.2）。
 */
export async function submitMobileOrder(input: MobileOrderInput, guards: MobileOrderGuards): Promise<Trade> {
    // 樁：先跑手機閘門（與正式流程相同的第一步），再一律拒絕，確保不會有任何委託送出
    guards.assertResumeReady();
    void input;
    throw notStarted('手機下單流程尚未實作，這筆沒有送出');
}
