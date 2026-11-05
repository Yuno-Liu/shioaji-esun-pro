// src/mobile/lib/mobile-order.ts — 手機新單流程（規格 §7.1）
//
// 只編排 src/lib 既有函式，不自行組 HTTP 請求；順序比照桌面 src/components/order-ticket.tsx 的 execute()，另加手機閘門：
//   1) ResumeGate＋串流 LIVE → 2) 記下伺服器模式代次 → 3) 風控 → 4) 商品與券商規則（期權＋玉山帳戶在此拒絕）
//   → 5) 固定送單帳戶與顯示路由 → 6) 強制確認（不看 confirmManualOrders）→ 7) 確認後重驗
//   → 8) beforeDispatch（HTTP 送出前最後一刻同步重驗）→ 9) placeStockOrder／placeFuturesOrder。
// 結果分類（規格 R6、§7.2）：送出前任何閘門擋下都丟出 mutationNotStarted（確定沒有送出）；
// 送單函式的錯誤原樣丟出（UI 依 mutationNotStarted 判斷，其餘一律「結果未知」）。絕不重送。

import { ORDER_CONTEXT_CHANGED_MESSAGE } from '../../hooks/use-order-context';
import { isEsunAccount } from '../../lib/esun';
import { creditLabel, lotLabel, orderQtyUnit, stockOrderProblem } from '../../lib/odd-lot';
import { ACCOUNT_CHANGED_MESSAGE, captureSelectedAccount, isSelectedAccountUnchanged } from '../../lib/order-account';
import { futuresOrderProblem } from '../../lib/order-conditions';
import { accountConfirmLabel, requestOrderConfirm } from '../../lib/order-confirm';
import { captureDisplayedRoute, esunStockLegProblem, routeConfirmNote } from '../../lib/order-route';
import { checkOrderAllowed } from '../../lib/risk';
import { captureServerMode, SERVER_MODE_CHANGED_MESSAGE } from '../../lib/server-info-store';
import { placeFuturesOrder, placeStockOrder } from '../../lib/shioaji';
import { assertTradingLive, OrderConfirmCancelled } from '../../lib/trade';
import type { Trade } from '../../lib/types/order';
import { notStarted } from './errors';
import type { MobileOrderInput } from './mobile-order-types';

/** 期權選了玉山帳戶（規格 R8）：確認前就拒絕，不出現確認面板 */
export const ESUN_FUTURES_MESSAGE = '玉山帳戶只能下台股現貨，期貨／選擇權請改用永豐帳戶；這筆沒有送出';
/** 面板顯示的內容與實際要送的委託不一致（防呆：確認面板顯示的必須就是送出的） */
export const ORDER_INPUT_MISMATCH_MESSAGE = '委託內容不一致，這筆沒有送出，請重新下單';
export const MISSING_ACCOUNT_MESSAGE = '缺少有效的下單帳戶，請重新選擇帳戶';
export const LIMIT_PRICE_REQUIRED_MESSAGE = '限價單需要有效價格';

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
 * captureDisplayedRoute() 的檢查丟出的是 tradingGateRejected（沒有 mutationNotStarted）；
 * 它只在送出前被呼叫，確定沒有送出，所以補上 mutationNotStarted，UI 才會顯示「未送出」而不是「結果未知」。
 */
function routeGate(check: () => void): () => void {
    return () => {
        try {
            check();
        } catch (err) {
            if (err instanceof Error) throw Object.assign(err, { mutationNotStarted: true as const });
            throw notStarted(String(err));
        }
    };
}

/**
 * 送出一筆手機新單。
 * - resolve：券商已受理（Trade）。
 * - reject 且 err.mutationNotStarted === true：確定沒有送出（含 OrderConfirmCancelled）。
 * - reject 其他錯誤：結果未知，禁止自動重送（規格 R6、§7.2）。
 */
export async function submitMobileOrder(input: MobileOrderInput, guards: MobileOrderGuards): Promise<Trade> {
    const market = input.isFutures ? 'F' : 'S';
    // 確認面板顯示與送出都取自同一份委託內容
    const order = input.isFutures ? input.futuresOrder : input.stockOrder;
    const orderLot = input.isFutures ? undefined : (input.stockOrder.order_lot ?? 'Common');

    // 1) 手機閘門＋串流 LIVE（按鈕已停用，這裡是硬性備援）
    guards.assertResumeReady();
    assertTradingLive();
    // 2) 記下伺服器模式代次：確認期間模擬 sidecar 重啟成正式（同位址）也不送
    const sameServerMode = captureServerMode();
    if (
        order.action !== input.action
        || order.quantity !== input.quantity
        || order.order_type !== input.orderType
        || order.price_type !== input.priceType
        || (!input.isFutures && orderLot !== input.orderLot)
    ) {
        throw notStarted(ORDER_INPUT_MISMATCH_MESSAGE);
    }
    // 3) 風控：鎖單、單筆上限、當日虧損上限
    const blocked = checkOrderAllowed(order.quantity, orderLot);
    if (blocked) throw notStarted(blocked);
    // 4) 商品與券商規則：期權先拒絕玉山帳戶、再查期權條件；股票先玉山規則再上游規則
    if (input.isFutures && isEsunAccount(input.displayedAccount)) throw notStarted(ESUN_FUTURES_MESSAGE);
    const problem = input.isFutures
        ? futuresOrderProblem({ price_type: input.futuresOrder.price_type, order_type: input.futuresOrder.order_type, octype: input.futuresOrder.octype })
        : esunStockLegProblem(input.displayedAccount, input.contract, input.stockOrder)
            ?? stockOrderProblem({ ...input.stockOrder, day_trade: input.contract.day_trade });
    if (problem) throw notStarted(problem);
    const limit = order.price_type === 'LMT';
    if (limit && !(Number.isFinite(order.price) && order.price > 0)) throw notStarted(LIMIT_PRICE_REQUIRED_MESSAGE);
    // 5) 固定送單帳戶：必須等於面板上顯示的帳戶（顯示的帳戶或環境已變就丟出 ROUTE_CHANGED_MESSAGE）
    const orderAccount = captureSelectedAccount(market);
    if (!orderAccount) throw notStarted(MISSING_ACCOUNT_MESSAGE);
    if (input.isFutures && isEsunAccount(orderAccount)) throw notStarted(ESUN_FUTURES_MESSAGE);
    const sameRoute = routeGate(captureDisplayedRoute(input.displayedAccount, market));
    sameRoute();
    // 6) 強制確認（不看 confirmManualOrders）；credit／unit／note／accountLabel 比照桌面，備註最後一定附上實際路由
    const cond = input.isFutures ? undefined : input.stockOrder.order_cond;
    const credit = !input.isFutures && cond && cond !== 'Cash' ? creditLabel(order.action, cond) : undefined;
    const daytradeShort = !input.isFutures && input.stockOrder.daytrade_short === true && order.action === 'Sell';
    const note = [
        order.order_type,
        !input.isFutures && orderLot !== 'Common' ? lotLabel(orderLot) : undefined,
        credit,
        daytradeShort ? '現股當沖' : undefined,
        routeConfirmNote(orderAccount),
    ].filter(Boolean).join('・');
    const approved = await requestOrderConfirm({
        code: input.contract.code,
        name: input.contract.name,
        action: order.action,
        credit,
        price: limit ? order.price : null,
        quantity: order.quantity,
        unit: orderQtyUnit(input.isFutures, orderLot),
        note,
        accountLabel: accountConfirmLabel(orderAccount),
    }, { serverMode: sameServerMode });
    if (!approved) throw new OrderConfirmCancelled();
    // 7) 確認後重驗（確認可能停留很久）
    if (!sameServerMode()) throw notStarted(SERVER_MODE_CHANGED_MESSAGE);
    if (!isSelectedAccountUnchanged(orderAccount)) throw notStarted(ACCOUNT_CHANGED_MESSAGE);
    // 8) beforeDispatch：HTTP 送出前最後一刻同步重驗，丟出就不送（每一項都是 mutationNotStarted）
    const dispatch = {
        beforeDispatch: () => {
            guards.assertResumeReady();
            assertTradingLive();
            if (!guards.isContextCurrent()) throw notStarted(ORDER_CONTEXT_CHANGED_MESSAGE);
            if (!sameServerMode()) throw notStarted(SERVER_MODE_CHANGED_MESSAGE);
            if (!isSelectedAccountUnchanged(orderAccount)) throw notStarted(ACCOUNT_CHANGED_MESSAGE);
            sameRoute();
        },
    };
    dispatch.beforeDispatch();
    // 9) 送出：玉山帳戶由 placeStockOrder 內部轉往 bridge；錯誤原樣丟出（不重送）
    return input.isFutures
        ? placeFuturesOrder(input.contract, input.futuresOrder, orderAccount, dispatch)
        : placeStockOrder(input.contract, input.stockOrder, orderAccount, dispatch);
}
