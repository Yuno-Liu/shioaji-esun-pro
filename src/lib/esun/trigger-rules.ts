// src/lib/esun/trigger-rules.ts — fork：觸價單建立時的玉山檢查。
// 觸價單要到觸發時才經 placeQuickOrder → esunQuickOrderProblem 檢查玉山規則。玉山一律不收的單
// （權證、興櫃、借券、超過 499 張…）若建立時沒擋，畫面會顯示「已掛」，觸發時才送不出去，
// 使用者會以為有保護。所以建立時先用同一套規則（validateEsunStockOrder）檢查一次。
// 價格要到觸發時才決定（市價，或觸發價加減幾檔的限價），這裡只看商品、數量與條件；
// 價格相關的規則仍以觸發送單時的檢查為準。
import type { ContractBase } from '../types/contract';
import type { Action, StockOrderCond, StockOrderLot } from '../types/order';
import type { Account } from '../types/portfolio';
import { isEsunAccount, validateEsunStockOrder } from './order-mapping';

export interface EsunTriggerShape {
    action: Action;
    quantity: number;
    price?: number;
    orderLot?: StockOrderLot;
    orderCond?: StockOrderCond;
    daytradeShort?: boolean;
    /** 觸價後送出方式（trigger-engine 的 TriggerSend）；未設定＝市價 */
    send?: { type: string };
    /** 時間條件（trigger-engine 的 TimeSpec） */
    time?: { kind: string };
}

/** 玉山帳戶的觸價單在建立時就不合玉山規則的原因；不是玉山帳戶、或合規則時回傳 null */
export function esunTriggerProblem(
    account: Pick<Account, 'broker_id'> | null | undefined,
    contract: ContractBase,
    t: EsunTriggerShape,
): string | null {
    if (!isEsunAccount(account)) return null;
    // 收盤前平倉不是一筆委託：建立時數量為 0、範圍可以是整個帳戶；時間到時由 conditional/flatten
    // 逐筆走 placeQuickOrder／placeStockExitByShares，每一筆都會再檢查玉山規則
    if (t.time?.kind === 'flatten') return null;
    // 與 trigger-engine 的 orderPlanFor 相同：零股一律以限價送出；整股依送出方式，預設市價
    const odd = t.orderLot === 'IntradayOdd' || t.orderLot === 'Odd';
    const market = !odd && (t.send?.type ?? 'MKT') !== 'LMT';
    const limitPrice = typeof t.price === 'number' && Number.isFinite(t.price) && t.price > 0 ? t.price : 1;
    return validateEsunStockOrder(contract, {
        action: t.action,
        // 送單時 esunQuickOrderProblem 也是市價帶 0、限價帶實際價格；限價實際價格觸發時才算
        price: market ? 0 : limitPrice,
        // 數量未定（0）時不以數量擋下，只看商品與條件；有數量時照玉山的張數／股數範圍檢查
        quantity: t.quantity > 0 ? t.quantity : 1,
        price_type: market ? 'MKT' : 'LMT',
        order_type: market ? 'IOC' : 'ROD',
        order_lot: t.orderLot ?? 'Common',
        order_cond: t.orderCond,
        daytrade_short: t.daytradeShort,
    });
}
