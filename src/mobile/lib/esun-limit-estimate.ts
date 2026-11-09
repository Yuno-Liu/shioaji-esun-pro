// src/mobile/lib/esun-limit-estimate.ts — 玉山「估算剩餘」交易額度（純函式；帳戶頁額度卡、持倉頁摘要一行、下單面板共用）
//
// 玉山 get_trade_status 只提供額度上限（trade_limit／margin_limit／short_limit），沒有已用或剩餘
// （lib 的 fromEsunTradeStatusToLimits 把缺的可用補成上限）。這裡用本 App 已有的委託資料就地估算，不另發任何查詢：
//
//   估算剩餘 ＝ 現股額度上限 − Σ（該帳戶今日「買進」委託的 已成交金額 ＋ 未成交金額）
//
// - 只扣買進（使用者選定的規則）：賣出一律不計；不分信用條件（融資買進、融券買進也是買進）。
//   融資／融券額度仍只顯示上限，不估算。
// - 已成交金額：逐筆成交（status.deals）Σ 數量 × 成交價；逐筆合計少於 deal_quantity 的差額以委託價估
//   （玉山權威讀取已把缺少逐筆的成交量補成一筆「均價」彙總成交，所以通常不會走到這裡）；市價或無價格以漲停價估。
// - 未成交金額：剩餘量（委託量 − 成交量 − 取消量）× 委託價（改價後 modified_price 優先）；
//   市價買進或沒有委託價時以合約漲停價（limit_up，保守高估）估；仍無法判定價格的委託不計入並標示 incomplete。
// - 單位：玉山委託在交易狀態中以 App 單位表示（lib/esun/order-mapping.ts fromEsunOrderResult：
//   ap_code 1、2 整股／盤後定價以「張」，3、4、5 盤中零股／盤後零股／興櫃以「股」，興櫃轉成 IntradayOdd）。
//   金額一律換算成股數（整股 × SHARES_PER_LOT，零股即股數）。
// - 委託狀態：
//   - Cancelled／Failed（含被拒）：只計已成交部分。Filled：只計已成交。
//   - PendingSubmit、PreSubmitted、Submitted、PartFilled：計已成交＋剩餘量。
//   - 結果未知：Inactive、PendingSubmit，以及玉山列帶 esun_unresolved_failure（失敗 ACK 尚未判定）或
//     數量矛盾（esun_quantity_conflict）的委託 → 剩餘量一律以未成交計，並標示 uncertain。
//   - 委託查詢待對帳（queries.orders.needsReconcile）時清單可能不完整 → 標示 reconcile。
// - 今日：委託時間（status.order_ts，epoch 秒）以台北日期比對；沒有委託時間的列視為今日（交易狀態只保留當日委託，
//   保守計入）。帳戶以 broker_id＋account_id 比對（AccountedTrade.account 優先，其次 order.account）。

import { esunQuantityConflictOf, esunUnresolvedFailureOf } from '../../lib/esun/order-mapping';
import { isOddLot, SHARES_PER_LOT } from '../../lib/odd-lot';
import { ACTIVE_ORDER_STATUSES, type AccountedTrade, type Trade } from '../../lib/types/order';
import type { Account } from '../../lib/types/portfolio';

export interface EsunLimitEstimate {
    /** 現股額度上限（元） */
    limit: number;
    /** 今日買進已成交金額（元） */
    filled: number;
    /** 今日買進未成交金額（元；市價以漲停價估） */
    pending: number;
    /** 估算剩餘＝上限 − 已成交 − 未成交（可能為負） */
    remaining: number;
    /** 計入的今日買進委託筆數 */
    buyOrders: number;
    /** 結果未知（以未成交計）的委託筆數 */
    unknownOrders: number;
    /** 無法判定價格而未計入（部分）金額的委託筆數 */
    unpricedOrders: number;
    /** 委託查詢待對帳：清單可能不完整 */
    reconcile: boolean;
    /** 委託已讀取（未讀取時估算未含今日委託） */
    ordersLoaded: boolean;
}

export interface EsunLimitEstimateInput {
    limit: number;
    account: Pick<Account, 'broker_id' | 'account_id'>;
    trades: readonly AccountedTrade[];
    /** 委託已讀取過（queries.orders.updatedAt !== null） */
    ordersLoaded: boolean;
    /** 委託查詢待對帳 */
    ordersNeedReconcile?: boolean;
    /** 合約漲停價（市價或無價買進的未成交以此估）；查不到回 undefined */
    limitUpOf?: (code: string) => number | undefined;
    /** 目前時間（ms），判定「今日」 */
    now: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;

/** 台北日期序號（epoch ms → 1970-01-01 起的日數） */
function taipeiDay(ms: number): number {
    return Math.floor((ms + 8 * 3_600_000) / 86_400_000);
}

function sameAccount(t: AccountedTrade, account: Pick<Account, 'broker_id' | 'account_id'>): boolean {
    const a = t.account ?? t.order.account;
    if (!a) return false;
    if (a.account_type && a.account_type !== 'S') return false;
    return a.broker_id === account.broker_id && a.account_id === account.account_id;
}

function isToday(t: Trade, today: number): boolean {
    const ts = t.status.order_ts;
    if (!positive(ts)) return true;
    const ms = ts > 1e11 ? ts : ts * 1000;
    return taipeiDay(ms) === today;
}

/** 結果未知的委託：剩餘量以未成交計，並標示估算不確定 */
export function esunOrderOutcomeUnknown(t: Trade): boolean {
    const s = t.status.status;
    return s === 'Inactive' || s === 'PendingSubmit' || !!esunUnresolvedFailureOf(t) || esunQuantityConflictOf(t);
}

function remainingQuantity(t: Trade, unknown: boolean): number {
    const q = t.order.quantity;
    const deal = t.status.deal_quantity;
    const cancel = t.status.cancel_quantity;
    if (unknown) {
        if (![q, deal, cancel].every(n => finite(n) && n >= 0)) return 0;
        return Math.max(0, q - deal - cancel);
    }
    if (!ACTIVE_ORDER_STATUSES.has(t.status.status)) return 0;
    if (![q, deal, cancel].every(n => finite(n) && n >= 0)) return 0;
    return Math.max(0, q - deal - cancel);
}

/** 委託價：改價後的新價優先；市價或沒有價格回 null（由呼叫端改用漲停價） */
function orderPrice(t: Trade): number | null {
    if (t.order.price_type === 'MKT') return null;
    if (positive(t.status.modified_price)) return t.status.modified_price;
    return positive(t.order.price) ? t.order.price : null;
}

/** 估算玉山證券帳戶今日剩餘交易額度（只扣買進） */
export function estimateEsunRemaining(input: EsunLimitEstimateInput): EsunLimitEstimate {
    const today = taipeiDay(input.now);
    let filled = 0;
    let pending = 0;
    let buyOrders = 0;
    let unknownOrders = 0;
    let unpricedOrders = 0;
    for (const t of input.trades) {
        if (t.order.action !== 'Buy' || !sameAccount(t, input.account) || !isToday(t, today)) continue;
        buyOrders++;
        const unit = (qty: number) => (isOddLot(t.order.order_lot) ? qty : qty * SHARES_PER_LOT);
        let fallbackPrice = orderPrice(t);
        if (fallbackPrice === null) {
            // 市價或沒有委託價：以漲停價保守估
            const limitUp = input.limitUpOf?.(t.contract.code);
            fallbackPrice = positive(limitUp) ? limitUp : null;
        }
        let unpriced = false;

        // 已成交：逐筆成交為準；逐筆不足 deal_quantity 的差額以委託價（市價以漲停價）估
        // 有效逐筆成交（同 order-fills.ts validDeals；就地篩選，避免把 order-fills 拆成另一個共用 chunk）
        const deals = (Array.isArray(t.status.deals) ? t.status.deals : []).filter(d => d && positive(d.quantity) && positive(d.price));
        let dealQty = 0;
        for (const d of deals) {
            dealQty += d.quantity;
            filled += unit(d.quantity) * d.price;
        }
        const missing = finite(t.status.deal_quantity) ? t.status.deal_quantity - dealQty : 0;
        if (missing > 0) {
            if (fallbackPrice === null) unpriced = true;
            else filled += unit(missing) * fallbackPrice;
        }

        // 未成交：結果未知的委託一律以未成交計
        const unknown = esunOrderOutcomeUnknown(t);
        if (unknown) unknownOrders++;
        const rest = remainingQuantity(t, unknown);
        if (rest > 0) {
            if (fallbackPrice === null) unpriced = true;
            else pending += unit(rest) * fallbackPrice;
        }
        if (unpriced) unpricedOrders++;
    }
    filled = Math.round(filled);
    pending = Math.round(pending);
    return {
        limit: input.limit,
        filled,
        pending,
        remaining: input.limit - filled - pending,
        buyOrders,
        unknownOrders,
        unpricedOrders,
        reconcile: !!input.ordersNeedReconcile,
        ordersLoaded: input.ordersLoaded,
    };
}

// ---- 共用文字（帳戶頁額度卡、持倉頁摘要一行、下單面板） ----

/** 玉山「估算剩餘」的共用文字（帳戶頁額度卡、持倉頁摘要一行、下單面板） */
export const ESUN_ESTIMATE_TEXT = {
    label: '估算剩餘',
    /** 簡短說明（帳戶頁額度卡） */
    note: '玉山只提供額度上限；估算剩餘以本 App 委託清單中今日的買進委託（已成交＋未成交）計算，賣出不計，可能與券商數字不同。',
    /** 更短的說明（持倉頁一行、下單面板） */
    short: '估算，玉山只提供上限',
    ordersLoading: '委託尚未讀取，尚未扣除今日委託',
    reconcile: '委託待對帳，估算可能不完整',
} as const;

/** 「上限 L；今日買進 已成交 A＋未成交 B」（金額經 money 格式化與遮蔽） */
export function esunBreakdownText(est: EsunLimitEstimate, money: (v: number) => string): string {
    return `上限 ${money(est.limit)}；今日買進 已成交 ${money(est.filled)}＋未成交 ${money(est.pending)}`;
}

/** 估算的附註（委託未讀取、結果未知、無法判定價格、待對帳）；沒有時回空陣列 */
export function esunEstimateFlags(est: EsunLimitEstimate): string[] {
    const out: string[] = [];
    if (!est.ordersLoaded) out.push(ESUN_ESTIMATE_TEXT.ordersLoading);
    if (est.unknownOrders > 0) out.push(`含 ${est.unknownOrders} 筆結果未知的委託（以未成交計）`);
    if (est.unpricedOrders > 0) out.push(`${est.unpricedOrders} 筆委託無法判定價格，未計入`);
    if (est.reconcile) out.push(ESUN_ESTIMATE_TEXT.reconcile);
    return out;
}
