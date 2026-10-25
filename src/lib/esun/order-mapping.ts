// src/lib/esun/order-mapping.ts — Order translation and validation for E.SUN Securities

import type { ContractBase, Exchange } from '../types/contract';
import type { Action, OrderResult, OrderStatusInfo, OrderStatusName, OrderType, StockOrderReq, StockPriceType, Trade } from '../types/order';
import type { Account, AccountBalance, StockPosition } from '../types/portfolio';
import type {
    Settlement,
    StockProfitLoss,
    ProfitLossSummaryTotal,
    StockProfitLossSummary,
    ProfitLossTotal,
    TradingLimits,
    ReserveStocksSummary,
} from '../shioaji';
import { remainingWorkingOrderQuantity } from '../working-order-quantity';
import {
    ESUN_BROKER_CODE,
    ESUN_BROKER_NAME,
    ESUN_SIMULATION_BROKER_SUFFIX,
    EsunApCode,
    EsunBsFlag,
    EsunErrorCode,
    EsunInventoryItem,
    EsunOrderMutationPayload,
    EsunOrderPayload,
    EsunOrderResult,
    EsunPlaceOrderResponse,
    EsunPriceFlag,
    EsunSide,
    EsunTradeType,
    EsunBalanceRaw,
    EsunSettlementItem,
    EsunTransactionItem,
    EsunTradeStatusRaw,
    type EsunEnvironment,
    type EsunQuantityUnit,
} from './types';

/** 官方玉山錯誤代碼中文診斷映射表 */
const ESUN_ERROR_MESSAGES: Record<string, string> = {
    [EsunErrorCode.AGR0000]: '每分鐘登入次數超限 (10次/分)，請等待 1 分鐘後再試',
    [EsunErrorCode.AGR0001]: '今日下單委託筆數已達上限 (2,000次/日)',
    [EsunErrorCode.AGR0002]: '下單頻率超限 (20次/秒)，請等待 1 分鐘後再試',
    [EsunErrorCode.AGR0003]: '庫存或成交查詢頻率超限 (12次/分)，請稍後再試',
    [EsunErrorCode.AGR0004]: '今日登入次數已達上限 (300次/日)，今日無法再連線',
    [EsunErrorCode.AGR0005]: '委託回報查詢頻率超限 (12次/分)，請稍後再試',
    [EsunErrorCode.AGR0006]: '交割款查詢頻率超限 (3次/分)，請等待 1 分鐘後再試',
    [EsunErrorCode.AGA0000]: '帳號密碼或憑證密碼錯誤超過 3 次，帳號已鎖定，請洽玉山客服解鎖',
    [EsunErrorCode.AGA0002]: 'IP 未在玉山白名單綁定，請至玉山證券後台設定信任 IP',
    [EsunErrorCode.AGA0005]: '本機系統時間與玉山伺服器誤差過大，請校時後再試',
    [EsunErrorCode.AG0003]: '查無委託資料或委託已失效',
    [EsunErrorCode.AG0005]: '委託已成交或已取消，無法改單',
    [EsunErrorCode.AG0006]: '玉山證券預約單不可改單 (AG0006)，請先刪單後重新下單',
    [EsunErrorCode.AG00004]: '查無委託紀錄',
    [EsunErrorCode.AW00002]: '查詢日期區間不可超過 180 天',
    [EsunErrorCode.AW00003]: '起始日期不可大於結束日期',
    [EsunErrorCode.WS1001]: 'WebSocket 連線數已達上限 (最多 1~2 條)，請關閉多餘連線',
};

const ESUN_BROKER_NAMES = new Set(['ESUN', 'E.SUN', 'ESUNSEC', '玉山', ESUN_BROKER_NAME]);
// 玉山證券券商代號為 884x（總公司 8840 與分公司）；模擬環境帳戶另帶 -SIM 後綴。
// 96xx 不是玉山（例如富邦證券），不可認定。
const ESUN_BROKER_PATTERN = /^884[0-9A-Z](-SIM)?$/;

/** 判斷 broker_id 是否為玉山證券代號或名稱 */
export function isEsunBroker(brokerId?: string | null): boolean {
    if (!brokerId || typeof brokerId !== 'string') return false;
    const b = brokerId.trim().toUpperCase();
    return ESUN_BROKER_PATTERN.test(b) || ESUN_BROKER_NAMES.has(b) || ESUN_BROKER_NAMES.has(brokerId.trim());
}

/** 判斷帳戶是否為玉山證券帳戶 */
export function isEsunAccount(account?: Pick<Account, 'broker_id'> | null): boolean {
    return !!account && isEsunBroker(account.broker_id);
}

/** 玉山帳戶所屬的交易環境（由帳戶鍵決定）；非玉山帳戶回 null */
export function esunEnvironmentOfAccount(account?: Pick<Account, 'broker_id'> | null): EsunEnvironment | null {
    if (!isEsunAccount(account)) return null;
    return account!.broker_id.trim().toUpperCase().endsWith(ESUN_SIMULATION_BROKER_SUFFIX) ? 'SIMULATION' : 'PRODUCTION';
}

/** 去掉環境後綴的實際分公司代號（送 bridge、與回報比對用） */
export function esunWireBrokerId(brokerId: string): string {
    const b = brokerId.trim();
    return b.toUpperCase().endsWith(ESUN_SIMULATION_BROKER_SUFFIX) ? b.slice(0, -ESUN_SIMULATION_BROKER_SUFFIX.length) : b;
}

/**
 * 由 bridge 回報的帳號組出 App 內的玉山帳戶（帳戶鍵含環境：模擬帳戶 broker_id 加 -SIM）。
 * 同一個帳號換環境就是不同的帳戶鍵，舊環境綁定的委託入口一律失效。
 */
export function esunAccountForEnvironment(
    raw: { broker_id?: string | null; account_id: string; person_id?: string | null; username?: string | null; signed?: boolean },
    environment: EsunEnvironment,
): Account {
    const wireBroker = esunWireBrokerId(String(raw.broker_id || ESUN_BROKER_CODE));
    return {
        account_type: 'S',
        broker_id: environment === 'SIMULATION' ? `${wireBroker}${ESUN_SIMULATION_BROKER_SUFFIX}` : wireBroker,
        account_id: String(raw.account_id).trim(),
        signed: raw.signed !== false,
        username: String(raw.username || ESUN_BROKER_NAME),
        person_id: String(raw.person_id ?? ''),
    };
}

// ---- 成功碼 ----

/** mutation 回應的 ret_code（snake_case 為 SDK 實際欄位；camelCase 為舊 mock 相容） */
export function esunRetCode(res: Record<string, unknown> | null | undefined): string | undefined {
    const raw = res?.ret_code ?? res?.retCode;
    if (raw === undefined || raw === null) return undefined;
    const code = String(raw).trim();
    return code ? code : undefined;
}

export function esunRetMessage(res: Record<string, unknown> | null | undefined): string {
    const raw = res?.ret_msg ?? res?.retMsg ?? res?.err_msg ?? res?.errMsg ?? '';
    return String(raw ?? '').trim();
}

/** 成功碼：全為 0（'0'、'000000'、'00000000'）；空值不算「明確成功」 */
export function isEsunSuccessCode(code?: string | null): boolean {
    return typeof code === 'string' && /^0+$/.test(code.trim());
}

/** 明確的失敗碼：有值且不是全 0 */
export function isEsunFailureCode(code?: string | null): boolean {
    return typeof code === 'string' && code.trim() !== '' && !/^0+$/.test(code.trim());
}

/** 判斷是否為預約單 (Pre-submitted / reservation order) */
export function isReservationOrder(trade: Trade | OrderResult | EsunOrderResult | Record<string, unknown>): boolean {
    if (!trade || typeof trade !== 'object') return false;
    if ('status' in trade && trade.status && typeof trade.status === 'object') {
        const s = trade.status as { status?: string; status_code?: string };
        if (s.status === 'PreSubmitted' || s.status_code === '1') {
            return true;
        }
    }
    if ('order' in trade && trade.order && typeof trade.order === 'object') {
        const o = trade.order as { ordno?: string; id?: string; seqno?: string };
        if (!o.ordno && Boolean(o.id || o.seqno)) {
            return true;
        }
    }
    const t = trade as Record<string, unknown>;
    if ('ordno' in t && !t.ordno && Boolean(t.id || t.seqno)) {
        return true;
    }
    const ordStatus = String(t.ordStatus ?? t.ord_status ?? '');
    const preOrdNo = String(t.preOrdNo ?? t.pre_ord_no ?? '');
    const ordNo = String(t.ordNo ?? t.ord_no ?? '');
    if (ordStatus === '1' || (preOrdNo && !ordNo)) {
        return true;
    }
    return false;
}

/** 驗證玉山證券下單條件；若不合法回傳錯誤訊息，合法回傳 null */
export function validateEsunStockOrder(
    contract: ContractBase,
    order: StockOrderReq,
): string | null {
    if (contract.security_type !== 'STK') {
        return '玉山證券僅支援台股現貨交易，不支援期貨、選擇權或指數商品';
    }

    if (!Number.isSafeInteger(order.quantity) || order.quantity <= 0) {
        return '委託數量必須為正整數';
    }

    if (order.order_lot === 'BlockTrade') {
        return '玉山證券 API 不支援鉅額交易';
    }

    if (
        order.order_cond === 'SBLShort' ||
        order.order_cond === 'SBLShortPriceExempt'
    ) {
        return '玉山證券 API 不支援借券賣出委託';
    }

    // 興櫃（玉山 ap_code 4）以「股」為委託單位，App 的整股數量是「張」；在 App 支援
    // 以股為單位的興櫃委託之前一律擋下，避免把 2 張當成 2 股送出。
    if (contract.exchange === 'OES') {
        return '玉山證券興櫃股票委託以「股」為單位，本 App 尚未支援；請改用玉山官方 App 下單';
    }

    // 整股 / 盤後定價規則：1 <= quantity <= 499 張
    if (order.order_lot === 'Common' || order.order_lot === 'Fixing' || !order.order_lot) {
        if (order.quantity < 1 || order.quantity > 499) {
            return order.order_lot === 'Fixing'
                ? '盤後定價委託數量必須在 1 至 499 張之間'
                : '整股委託數量必須在 1 至 499 張之間';
        }
    }

    const isOdd =
        order.order_lot === 'IntradayOdd' || order.order_lot === 'Odd';

    if (isOdd) {
        if (order.quantity < 1 || order.quantity > 999) {
            return '零股委託數量必須在 1 至 999 股之間';
        }
        if (order.order_cond && order.order_cond !== 'Cash') {
            return '零股交易不支援融資券信用條件';
        }
        if (order.daytrade_short) {
            return '零股交易不支援現股當沖';
        }
        if (order.price_type === 'MKT') {
            return '零股交易不支援市價委託，請使用限價';
        }
        if (order.order_type && order.order_type !== 'ROD') {
            return '零股委託效期只能為 ROD';
        }
    }

    if (order.daytrade_short) {
        if (order.action !== 'Sell') {
            return '現股當沖先賣僅支援賣出委託';
        }
        if (order.order_cond && order.order_cond !== 'Cash') {
            return '現股當沖先賣僅適用現股條件';
        }
        if (order.order_lot && order.order_lot !== 'Common') {
            return '現股當沖先賣僅支援整股交易';
        }
    }

    if (order.price_type === 'LMT') {
        if (!Number.isFinite(order.price) || order.price <= 0) {
            return '限價委託需要大於 0 的有效價格';
        }
    }

    return null;
}

/** 驗證玉山證券改價條件 */
export function validateEsunOrderPriceMutation(trade: Trade, newPrice: number): string | null {
    if (isReservationOrder(trade)) {
        return '玉山證券預約單不可改單 (AG0006)，請先刪單後重新下單';
    }

    if (trade.order.order_type !== 'ROD' || trade.order.price_type !== 'LMT') {
        return '玉山證券僅支援 ROD 限價單改價，市價單或 IOC/FOK 請先刪單再重新下單';
    }

    if (!Number.isFinite(newPrice) || newPrice <= 0) {
        return '改價需要大於 0 的有效價格';
    }

    return null;
}

/**
 * 驗證玉山證券減量條件。`reduction` 是「減少量」（與上游 updateOrderQty、
 * SDK cancel_order(cel_qty=…) 相同語意），必須 0 < reduction ≤ 目前剩餘量。
 */
export function validateEsunOrderQtyMutation(trade: Trade, reduction: number): string | null {
    if (isReservationOrder(trade)) {
        return '玉山證券預約單不可改單 (AG0006)，請先刪單後重新下單';
    }

    if (!Number.isSafeInteger(reduction) || reduction <= 0) {
        return '減量數量必須為正整數';
    }

    const remaining = remainingWorkingOrderQuantity(trade);
    if (remaining <= 0) {
        return '委託已無剩餘量可減量';
    }
    if (reduction > remaining) {
        return `玉山證券僅支援減量，減少數量 ${reduction} 不可超過目前剩餘 ${remaining}`;
    }

    return null;
}

/** 格式化玉山錯誤代碼為繁體中文診斷訊息 */
export function formatEsunErrorMessage(errCode?: string | null, errMsg?: string | null): string {
    const code = (errCode || '').trim().toUpperCase();
    const mapped = ESUN_ERROR_MESSAGES[code];
    const msg = (errMsg || '').trim();

    if (mapped) {
        if (msg && msg !== mapped) {
            return `${mapped} (${code}: ${msg})`;
        }
        return `${mapped} [${code}]`;
    }

    if (code && msg) {
        return `[${code}] ${msg}`;
    }
    if (msg) {
        return msg;
    }
    if (code) {
        return `[${code}] 玉山證券操作失敗`;
    }
    return '未知錯誤';
}

/** 日期字串解析為 Date；無法解析時回 null */
function parseDate(dStr: string): Date | null {
    const clean = String(dStr ?? '').replace(/-/g, '').trim();
    if (/^\d{8}$/.test(clean)) {
        const y = parseInt(clean.slice(0, 4), 10);
        const m = parseInt(clean.slice(4, 6), 10) - 1;
        const d = parseInt(clean.slice(6, 8), 10);
        return new Date(Date.UTC(y, m, d));
    }
    if (!clean) return null;
    const parsed = new Date(dStr);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 台北的今天（UTC 欄位即台北日期） */
function taipeiToday(): Date {
    const now = new Date(Date.now() + 8 * 3600_000);
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** 日期格式化為與輸入同風格字串 */
function formatDate(d: Date, hasHyphens: boolean): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return hasHyphens ? `${y}-${m}-${day}` : `${y}${m}${day}`;
}

/** 限制玉山查詢區間在 180 天以內，防止觸發 AW00002 / AW00003 */
export function clampEsunDateRange180Days(
    beginDate: string,
    endDate: string,
): { beginDate: string; endDate: string; clamped: boolean } {
    const hasHyphens = String(beginDate ?? '').includes('-') || String(endDate ?? '').includes('-');
    let clamped = false;
    // 空白或無法解析的日期：結束日退回台北今天、起始日退回結束日（不產生 NaN 日期）
    let end = parseDate(endDate);
    if (!end) { end = taipeiToday(); clamped = true; }
    let start = parseDate(beginDate);
    if (!start) { start = new Date(end.getTime()); clamped = true; }

    // 起始大於結束：修正為同一天
    if (start.getTime() > end.getTime()) {
        start = new Date(end.getTime());
        clamped = true;
    }

    const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays > 180) {
        start = new Date(end.getTime() - 180 * 24 * 60 * 60 * 1000);
        clamped = true;
    }

    return {
        beginDate: formatDate(start, hasHyphens),
        endDate: formatDate(end, hasHyphens),
        clamped,
    };
}

// ---- 委託類別與數量單位 ----

/** App 委託對應的玉山 ap_code */
export function esunApCodeFor(order: { order_lot?: string | null }, contract?: { exchange?: Exchange | string | null }): EsunApCode {
    if (contract?.exchange === 'OES') return EsunApCode.Emg;
    if (order.order_lot === 'IntradayOdd') return EsunApCode.IntradayOdd;
    if (order.order_lot === 'Odd') return EsunApCode.Odd;
    if (order.order_lot === 'Fixing') return EsunApCode.AfterMarket;
    return EsunApCode.Common;
}

/** 整股／盤後（1、2）以張計，零股／興櫃（3、4、5）以股計 */
export function esunQuantityUnitFor(apCode: string): EsunQuantityUnit {
    return apCode === EsunApCode.Odd || apCode === EsunApCode.Emg || apCode === EsunApCode.IntradayOdd ? 'share' : 'lot';
}

/** 將 Shioaji-Pro 的委託規格轉換為玉山證券 SDK 的 OrderPayload */
export function toEsunOrderPayload(
    contract: ContractBase,
    order: StockOrderReq,
): EsunOrderPayload {
    const buySell = order.action === 'Buy' ? EsunSide.Buy : EsunSide.Sell;
    const apCode = esunApCodeFor(order, contract);

    const priceFlag =
        order.price_type === 'MKT'
            ? EsunPriceFlag.Market
            : EsunPriceFlag.Limit;

    let bsFlag = EsunBsFlag.ROD;
    if (order.order_type === 'IOC') {
        bsFlag = EsunBsFlag.IOC;
    } else if (order.order_type === 'FOK') {
        bsFlag = EsunBsFlag.FOK;
    }

    let trade = EsunTradeType.Cash;
    if (order.daytrade_short && order.action === 'Sell') {
        trade = EsunTradeType.DayTradingSell;
    } else if (order.order_cond === 'MarginTrading') {
        trade = EsunTradeType.Margin;
    } else if (order.order_cond === 'ShortSelling') {
        trade = EsunTradeType.Short;
    }

    const userDef = order.custom_field ? order.custom_field.slice(0, 50) : undefined;

    return {
        stockNo: contract.code.trim(),
        buySell,
        price: order.price_type === 'MKT' ? 0 : order.price,
        quantity: order.quantity,
        apCode,
        priceFlag,
        bsFlag,
        trade,
        userDef,
    };
}

/**
 * 改單／刪單隨請求附上的原委託內容（bridge 快取沒命中時用，不再以預設值合成）。
 * quantity 為 App 單位：ap_code 1、2 為張，3、4、5 為股。
 */
export function toEsunMutationPayload(trade: Trade): EsunOrderMutationPayload {
    const order = trade.order;
    const apCode = esunApCodeFor(order, trade.contract);
    let tradeType = EsunTradeType.Cash;
    if (order.daytrade_short && order.action === 'Sell') tradeType = EsunTradeType.DayTradingSell;
    else if (order.order_cond === 'MarginTrading') tradeType = EsunTradeType.Margin;
    else if (order.order_cond === 'ShortSelling') tradeType = EsunTradeType.Short;
    const preOrdNo = order.seqno && order.seqno !== order.ordno ? order.seqno : undefined;
    return {
        ...(order.ordno ? { ordNo: order.ordno } : {}),
        ...(preOrdNo ? { preOrdNo } : {}),
        stockNo: (trade.contract.target_code || trade.contract.code || '').trim(),
        buySell: order.action === 'Buy' ? EsunSide.Buy : EsunSide.Sell,
        apCode,
        priceFlag: order.price_type === 'MKT' ? EsunPriceFlag.Market : EsunPriceFlag.Limit,
        bsFlag: order.order_type === 'IOC' ? EsunBsFlag.IOC : order.order_type === 'FOK' ? EsunBsFlag.FOK : EsunBsFlag.ROD,
        trade: tradeType,
        price: order.price,
        quantity: order.quantity,
    };
}

/** 玉山委託的穩定識別：預約單開盤後才有 ord_no，pre_ord_no 優先才不會換 id */
export function esunOrderId(raw: Record<string, unknown> | null | undefined): string {
    const pre = String(raw?.pre_ord_no ?? raw?.preOrdNo ?? '').trim();
    const ord = String(raw?.ord_no ?? raw?.ordNo ?? '').trim();
    return pre || ord;
}

/** 將玉山證券 placeOrder 回應轉換為 Shioaji-Pro 標準 Trade 物件（呼叫端先確認有委託編號） */
export function fromEsunOrderResponse(
    res: EsunPlaceOrderResponse,
    contract: ContractBase,
    order: StockOrderReq,
    account: Account,
): Trade {
    const retCode = esunRetCode(res) ?? '';
    const retMsg = esunRetMessage(res);
    const ordNo = String(res.ord_no ?? res.ordNo ?? '').trim();
    const orderId = esunOrderId(res);
    const failed = isEsunFailureCode(retCode);

    const orderResult: OrderResult = {
        id: orderId,
        seqno: orderId,
        ordno: ordNo,
        action: order.action,
        price: order.price,
        quantity: order.quantity,
        order_type: order.order_type,
        price_type: order.price_type,
        order_lot: order.order_lot ?? 'Common',
        order_cond: order.order_cond,
        daytrade_short: order.daytrade_short,
        custom_field: order.custom_field,
        account: {
            broker_id: account.broker_id || ESUN_BROKER_CODE,
            account_id: account.account_id,
            account_type: 'S',
        },
    };

    const statusInfo: OrderStatusInfo = {
        id: orderId,
        status: (failed ? 'Failed' : (ordNo ? 'Submitted' : 'PreSubmitted')) as OrderStatusName,
        status_code: retCode,
        msg: (retMsg || failed) ? formatEsunErrorMessage(retCode, retMsg) : '委託已送出',
        order_quantity: order.quantity,
        deal_quantity: 0,
        cancel_quantity: 0,
        modified_price: 0,
        deals: [],
    };

    return {
        contract: {
            ...contract,
            security_type: 'STK',
            exchange: contract.exchange ?? 'TSE',
        },
        order: orderResult,
        status: statusInfo,
    };
}

const finiteNumber = (v: unknown): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
};

/**
 * 委託數量欄位（App 單位）：ap_code 1、2 讀 *_qty（張）；3、4、5 讀 *_qty_share（股），
 * 沒有股數欄位時才由 *_qty 換算 — SDK recover_order_result 會把零股／興櫃的 *_qty
 * 乘以每張股數再送 API，可知這些欄位是「張」的小數。
 */
export function esunQuantityFromFields(
    raw: Record<string, unknown>,
    base: 'org' | 'mat' | 'cel',
    apCode: string,
): number | null {
    const camel = { org: 'orgQty', mat: 'matQty', cel: 'celQty' }[base];
    const lots = finiteNumber(raw[`${base}_qty`] ?? raw[camel]);
    if (esunQuantityUnitFor(apCode) === 'lot') return lots === null ? null : Math.round(lots);
    const shares = finiteNumber(raw[`${base}_qty_share`] ?? raw[`${camel}Share`]);
    if (shares !== null) return Math.round(shares);
    if (lots === null) return null;
    // 零股（3、5）一定少於 1 張：≥ 1 的值只可能已是股數
    if (apCode !== EsunApCode.Emg && lots >= 1) return Math.round(lots);
    return Math.round(lots * 1000);
}

/** Python 的真值判斷：bridge 以 `a or b` 取值，None、0、空字串、False 都視為沒有值 */
const pyTruthy = (v: unknown): boolean => v !== undefined && v !== null && v !== 0 && v !== '' && v !== false;

/**
 * MAT 的成交序號，取值規則與 bridge 的去重鍵相同：
 * `str(mkt_seq_num or mktSeqNum or "").strip()`。數值 0 與空字串視為沒有序號（回 ''）。
 */
export function esunMktSeqNum(raw: Record<string, unknown>): string {
    const value = [raw.mkt_seq_num, raw.mktSeqNum].find(pyTruthy);
    return value === undefined ? '' : String(value).trim();
}

type EsunDeal = Trade['status']['deals'][number];

/**
 * 列上的 esun_fills（bridge 本快取代次內經 MAT 套用的逐筆成交，依接收順序）→ App 單位的逐筆成交。
 * seq 用 mkt_seq_num（與 SSE 成交的 exchange_seq 相同），所以權威讀取或快取重建時重播的 SSE 成交
 * 會被 projectTradeDeal 當成重複。整股（ap_code 1、2）的股數必須是 1000 的倍數；缺序號、序號重複、
 * 數量不是正整數的元素略過（由呼叫端併入彙總成交）。
 */
function esunFillDeals(raw: Record<string, unknown>, apCode: string, fallbackPrice: number, ts: number): EsunDeal[] {
    const fills = Array.isArray(raw.esun_fills) ? raw.esun_fills : [];
    const lot = esunQuantityUnitFor(apCode) === 'lot';
    const seen = new Set<string>();
    const deals: EsunDeal[] = [];
    for (const fill of fills) {
        if (!fill || typeof fill !== 'object' || Array.isArray(fill)) continue;
        const f = fill as Record<string, unknown>;
        const seq = esunMktSeqNum(f);
        const shares = finiteNumber(f.mat_qty_share);
        if (!seq || seen.has(seq) || shares === null || shares <= 0 || !Number.isInteger(shares)) continue;
        const quantity = lot ? shares / 1000 : shares;
        if (!Number.isInteger(quantity)) continue;
        const matPrice = finiteNumber(f.mat_price);
        seen.add(seq);
        deals.push({ seq, price: matPrice !== null && matPrice > 0 ? matPrice : fallbackPrice, quantity, ts });
    }
    return deals;
}

/** 台北時間 YYYYMMDD + HHMMSS[mmm] → epoch 秒；缺資料回 undefined */
export function esunTimestamp(date: unknown, time: unknown): number | undefined {
    const d = String(date ?? '').replace(/-/g, '').trim();
    const t = String(time ?? '').replace(/:/g, '').trim();
    if (!/^\d{8}$/.test(d) || !/^\d{6}/.test(t)) return undefined;
    const ms = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)) - 8 * 3600_000;
    return Number.isFinite(ms) ? ms / 1000 : undefined;
}

/** bridge 快取列的 esun_unresolved_failure（失敗 ACK 對到這筆委託，尚未由成功 ACK 或新快照判定） */
export interface EsunRowUnresolvedFailure {
    opCode: string;
    opMsg: string;
}

// 以 Trade.status 物件為鍵：trading-state 合併前的淺複製（{ ...t, account }）沿用同一個 status，
// 標記不會寫進 Trade 本身（不進本地狀態、不跨視窗廣播）
const unresolvedFailures = new WeakMap<object, EsunRowUnresolvedFailure>();

/** fromEsunOrderResult 轉出的列帶有 bridge 的 esun_unresolved_failure 時回傳它 */
export function esunUnresolvedFailureOf(trade: Pick<Trade, 'status'>): EsunRowUnresolvedFailure | undefined {
    return unresolvedFailures.get(trade.status);
}

function readUnresolvedFailure(raw: Record<string, unknown>): EsunRowUnresolvedFailure | undefined {
    const v = raw.esun_unresolved_failure;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const f = v as Record<string, unknown>;
    return { opCode: String(f.op_code ?? '').trim(), opMsg: String(f.op_msg ?? '').trim() };
}

export interface EsunOrderResultOptions {
    /** 由 App 的合約快取補交易所（委託查詢沒有交易所欄位） */
    exchangeOf?: (code: string) => Exchange | undefined;
}

/**
 * 將玉山證券查詢回傳的委託紀錄轉換為 Trade 物件。缺少識別所需欄位（委託編號、
 * 股票代號、買賣別、委託數量）的列回 null，由呼叫端略過並標示待對帳，絕不以
 * 預設值（賣出、數量 0）補上。
 */
export function fromEsunOrderResult(
    item: EsunOrderResult,
    account: Account,
    opts: EsunOrderResultOptions = {},
): Trade | null {
    const raw = item as Record<string, unknown>;
    const orderId = esunOrderId(raw);
    const ordNo = String(item.ord_no ?? item.ordNo ?? '').trim();
    const stockNo = String(item.stock_no ?? item.stockNo ?? '').trim();
    const buySell = String(item.buy_sell ?? item.buySell ?? '').trim().toUpperCase();
    const action: Action | null = buySell === 'B' || buySell === 'BUY' ? 'Buy' : buySell === 'S' || buySell === 'SELL' ? 'Sell' : null;
    const apCode = String(item.ap_code ?? item.apCode ?? EsunApCode.Common).trim() || EsunApCode.Common;
    const orgQty = esunQuantityFromFields(raw, 'org', apCode);
    if (!orderId || !stockNo || !action || orgQty === null || orgQty <= 0) return null;
    const matQty = esunQuantityFromFields(raw, 'mat', apCode) ?? 0;
    const celQty = esunQuantityFromFields(raw, 'cel', apCode) ?? 0;

    const price = finiteNumber(item.od_price ?? item.odPrice) ?? 0;
    const errCode = String(item.err_code ?? item.errCode ?? '').trim();
    const errMsg = String(item.err_msg ?? item.errMsg ?? '').trim();
    const ordStatus = String(item.ord_status ?? item.ordStatus ?? '').trim();
    const preOrdNo = String(item.pre_ord_no ?? item.preOrdNo ?? '').trim();
    const rawBsFlag = String(item.bs_flag ?? item.bsFlag ?? item.order_type ?? item.orderType ?? 'R').toUpperCase();
    const rawPriceFlag = String(item.price_flag ?? item.priceFlag ?? item.price_type ?? item.priceType ?? '0').toUpperCase();
    const memo = String(item.user_def ?? item.memo ?? '');
    const avgPrice = finiteNumber(item.avg_price ?? item.avgPrice) ?? 0;
    const tradeType = String(item.trade ?? '');

    // 狀態依數量判定：成交＋取消涵蓋委託量即為終態（有取消就是 Cancelled，並保留成交量）
    let status: OrderStatusName;
    if (matQty + celQty >= orgQty) status = celQty > 0 ? 'Cancelled' : 'Filled';
    else if (isEsunFailureCode(errCode) || ordStatus === 'Fail' || ordStatus === 'Failed') status = 'Failed';
    else if (matQty > 0) status = 'PartFilled';
    else if ((preOrdNo && !ordNo) || ordStatus === 'PreSubmitted') status = 'PreSubmitted';
    else status = 'Submitted';

    let orderLot = 'Common';
    if (apCode === EsunApCode.IntradayOdd) orderLot = 'IntradayOdd';
    else if (apCode === EsunApCode.Odd) orderLot = 'Odd';
    else if (apCode === EsunApCode.AfterMarket) orderLot = 'Fixing';
    // 興櫃以股為單位：以零股的單位顯示與計算（App 不送出興櫃委託，只顯示他處下的單）
    else if (apCode === EsunApCode.Emg) orderLot = 'IntradayOdd';

    let orderType: OrderType = 'ROD';
    if (rawBsFlag === 'I' || rawBsFlag === 'IOC') {
        orderType = 'IOC';
    } else if (rawBsFlag === 'F' || rawBsFlag === 'FOK') {
        orderType = 'FOK';
    }

    let priceType: StockPriceType = 'LMT';
    if (rawPriceFlag === '4' || rawPriceFlag === 'MKT' || rawPriceFlag === 'MARKET') {
        priceType = 'MKT';
    }

    let orderCond = 'Cash';
    let daytradeShort = false;
    if (tradeType === EsunTradeType.Margin) orderCond = 'MarginTrading';
    else if (tradeType === EsunTradeType.Short) orderCond = 'ShortSelling';
    else if (tradeType === EsunTradeType.DayTradingSell) daytradeShort = true;

    const exchange: Exchange = apCode === EsunApCode.Emg ? 'OES' : (opts.exchangeOf?.(stockNo) ?? 'TSE');
    const orderTs = esunTimestamp(item.ord_date ?? item.ordDate ?? item.work_date ?? item.workDate, item.ord_time ?? item.ordTime);
    // 逐筆成交來自 bridge 的 esun_fills；成交量超出逐筆總和的部分（快照已含、bridge 沒收到 MAT
    // 的成交）以一筆彙總成交（均價）表示。逐筆總和超過成交量（不符 bridge 契約）時只用彙總。
    const fallbackPrice = avgPrice > 0 ? avgPrice : price;
    let fills = matQty > 0 ? esunFillDeals(raw, apCode, fallbackPrice, orderTs ?? 0) : [];
    if (fills.reduce((sum, d) => sum + d.quantity, 0) > matQty) fills = [];
    const rest = matQty - fills.reduce((sum, d) => sum + d.quantity, 0);
    const deals: EsunDeal[] = rest > 0
        ? [...fills, { seq: `${orderId}:agg`, price: fallbackPrice, quantity: rest, ts: orderTs ?? 0 }]
        : fills;

    const trade: Trade = {
        contract: {
            code: stockNo,
            security_type: 'STK',
            exchange,
            target_code: null,
        },
        order: {
            id: orderId,
            seqno: orderId,
            ordno: ordNo,
            action,
            price,
            quantity: orgQty,
            order_type: orderType,
            price_type: priceType,
            order_lot: orderLot,
            order_cond: orderCond,
            daytrade_short: daytradeShort,
            custom_field: memo,
            account: {
                broker_id: account.broker_id || ESUN_BROKER_CODE,
                account_id: account.account_id,
                account_type: 'S',
            },
        },
        status: {
            id: orderId,
            status,
            status_code: errCode,
            ...(orderTs !== undefined ? { order_ts: orderTs } : {}),
            msg: errMsg ? formatEsunErrorMessage(errCode, errMsg) : '',
            order_quantity: orgQty,
            deal_quantity: matQty,
            cancel_quantity: celQty,
            // 委託查詢只有目前委託價（od_price）；均價不是委託價，不寫入 modified_price
            modified_price: 0,
            deals,
        },
    };
    const unresolved = readUnresolvedFailure(raw);
    if (unresolved) unresolvedFailures.set(trade.status, unresolved);
    return trade;
}

/** 將玉山庫存項目 (stk_sums) 轉換為 Shioaji-Pro 標準 StockPosition 物件 */
export function fromEsunInventoryToPosition(
    item: EsunInventoryItem,
    unit: 'Common' | 'Share' = 'Common',
    id = 1,
): StockPosition {
    const rawQty = Number(item.cost_qty ?? item.qty ?? 0);
    // 玉山庫存 cost_qty 單位為股 (Share)
    // Common unit 轉為張數 (Math.floor(shares / 1000) 或若未滿 1 張則保留股數)
    const quantity = unit === 'Common'
        ? (rawQty >= 1000 ? Math.floor(rawQty / 1000) : rawQty / 1000)
        : rawQty;

    const price = Number(item.price_avg ?? item.price ?? 0);
    const lastPrice = Number(item.price_mkt ?? item.price_now ?? price);
    const pnl = Number(item.make_a_sum ?? 0);
    const ydQtyRaw = Number(item.qty_l ?? 0);
    const ydQuantity = unit === 'Common'
        ? (ydQtyRaw >= 1000 ? Math.floor(ydQtyRaw / 1000) : ydQtyRaw / 1000)
        : ydQtyRaw;

    // 方向與信用別只看庫存列的交易類別 trade（'0' 現股、'3' 融資、'4' 融券）；
    // qty_b／qty_s／qty_bm／qty_sm 是當日委買賣與成交量，不代表持倉方向
    const trade = String(item.trade ?? '').trim();
    const cond = trade === EsunTradeType.Margin ? 'MarginTrading' : trade === EsunTradeType.Short ? 'ShortSelling' : 'Cash';

    return {
        id,
        code: String(item.stk_no ?? ''),
        direction: trade === EsunTradeType.Short ? 'Sell' : 'Buy',
        quantity,
        price,
        last_price: lastPrice,
        pnl,
        yd_quantity: ydQuantity,
        cond,
    };
}

/** 將玉山 get_balance 回應轉換為 AccountBalance 物件 */
export function fromEsunBalance(raw: EsunBalanceRaw): AccountBalance {
    const accBalance = Number(
        raw.available_balance ?? raw.availableBalance ?? raw.acc_balance ?? 0,
    );
    let date = '';
    if (typeof raw.updated_at === 'string') {
        date = raw.updated_at;
    } else if (typeof raw.updatedAt === 'string') {
        date = raw.updatedAt;
    } else if (raw.updatedAt && typeof raw.updatedAt === 'object' && 'seconds' in raw.updatedAt) {
        date = new Date((raw.updatedAt.seconds || 0) * 1000).toISOString();
    } else {
        // bridge 回快取時附 cache_age_sec：以資料實際取得時間為準，不假裝剛更新
        const age = finiteNumber(raw.cache_age_sec);
        date = age !== null && age >= 0 ? new Date(Date.now() - age * 1000).toISOString() : '';
    }

    return {
        acc_balance: accBalance,
        date,
        errmsg: raw.errmsg || '',
    };
}

/**
 * 玉山 get_balance 只有圈存「金額」（stock_pre_save_amount），沒有逐檔圈存股數；
 * ReserveStocksSummary 只表達股數，因此不放入任何股數列（不把金額當股數）。
 */
export function fromEsunBalanceToReserveSummary(
    _raw: EsunBalanceRaw,
    account?: Account,
): ReserveStocksSummary {
    const targetAccount: Account = account ?? {
        broker_id: ESUN_BROKER_CODE,
        account_id: '',
        account_type: 'S',
        signed: true,
        username: ESUN_BROKER_NAME,
        person_id: '',
    };

    return {
        stocks: [],
        account: targetAccount,
    };
}

/** 將玉山 get_settlements 回應清單轉換為 Settlement[] */
export function fromEsunSettlements(rawList: EsunSettlementItem[]): Settlement[] {
    if (!Array.isArray(rawList)) return [];

    const today = taipeiToday();

    return rawList.map((item, idx) => {
        const rawDate = String(item.c_date ?? item.cdate ?? item.date ?? '');
        const dateStr = rawDate.length === 8
            ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
            : rawDate;
        const amount = Number(item.amount ?? item.price ?? 0);

        let tOffset = item.T;
        if (typeof tOffset !== 'number') {
            const itemDate = parseDate(dateStr);
            const diffDays = itemDate ? Math.round((itemDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : NaN;
            tOffset = Math.max(0, Math.min(2, diffDays));
        }

        return {
            date: dateStr,
            amount,
            T: typeof tOffset === 'number' && !Number.isNaN(tOffset) ? tOffset : idx,
        };
    });
}

/**
 * 成交明細中「已實現」的列：賣出（現股、融資、當沖）或融券回補（買進＋trade 4），
 * 且 make（損益）有值。買進建倉與融券賣出建倉不是已實現損益。
 */
function isRealizedTransaction(item: EsunTransactionItem): boolean {
    if (finiteNumber(item.make) === null) return false;
    const side = String(item.buy_sell ?? '').trim().toUpperCase();
    const short = String(item.trade ?? '') === EsunTradeType.Short;
    if (side === 'B' || side === 'BUY') return short;
    if (side === 'S' || side === 'SELL') return !short;
    // 沒有買賣別的舊資料：沿用 make 判定
    return true;
}

/** 將玉山成交紀錄 (mat_sums) 轉換為 StockProfitLoss[]（只含已實現損益的列，日期為成交日） */
export function fromEsunTransactionsToProfitLoss(
    rawList: EsunTransactionItem[],
): StockProfitLoss[] {
    if (!Array.isArray(rawList)) return [];

    return rawList.filter(isRealizedTransaction).map((item, idx) => {
        const code = String(item.stk_no ?? item.code ?? '');
        const rawDate = String(item.t_date ?? item.date ?? item.c_date ?? '');
        const date = rawDate.replace(/-/g, '');
        const quantity = Number(item.qty ?? item.quantity ?? item.price_qty ?? 0);
        const pnl = Number(item.make ?? 0);
        const prRatio = Number(item.make_per ?? 0);
        const cost = Math.abs(Number(item.cost ?? 0));
        const price = Number(item.price ?? item.price_avg ?? (cost > 0 && quantity > 0 ? cost / quantity : 0));
        const cond = item.trade === '3'
            ? 'MarginTrading'
            : item.trade === '4'
                ? 'ShortSelling'
                : 'Cash';

        return {
            id: idx + 1,
            code,
            quantity,
            pnl,
            date,
            dseq: String(item.dseq ?? item.order_no ?? `${idx + 1}`),
            price,
            pr_ratio: prRatio,
            cond,
            seqno: String(item.order_no ?? `${idx + 1}`),
        };
    });
}

/** 將玉山成交紀錄 (mat_sums) 轉換為 ProfitLossSummaryTotal（只彙總已實現損益的列） */
export function fromEsunTransactionsToProfitLossSummary(
    rawList: EsunTransactionItem[],
    _beginDate?: string,
    _endDate?: string,
): ProfitLossSummaryTotal {
    const realized = Array.isArray(rawList) ? rawList.filter(isRealizedTransaction) : [];
    if (realized.length === 0) {
        return {
            profitloss_sum: [],
            total: {
                entry_amount: 0,
                cover_amount: 0,
                quantity: 0,
                buy_cost: 0,
                sell_cost: 0,
                pnl: 0,
                pr_ratio: 0,
            },
        };
    }

    const byCode = new Map<string, {
        code: string;
        quantity: number;
        pnl: number;
        entryCost: number;
        coverCost: number;
        cond: string;
    }>();

    for (const item of realized) {
        const code = String(item.stk_no ?? item.code ?? '');
        const quantity = Number(item.qty ?? item.quantity ?? item.price_qty ?? 0);
        const pnl = Number(item.make ?? 0);
        const cost = Math.abs(Number(item.cost ?? 0));
        const recv = Number(item.recv ?? (cost + pnl));
        const cond = item.trade === '3' ? 'MarginTrading' : item.trade === '4' ? 'ShortSelling' : 'Cash';

        const existing = byCode.get(code) || {
            code,
            quantity: 0,
            pnl: 0,
            entryCost: 0,
            coverCost: 0,
            cond,
        };

        existing.quantity += quantity;
        existing.pnl += pnl;
        existing.entryCost += cost;
        existing.coverCost += recv;
        byCode.set(code, existing);
    }

    const profitlossSum: StockProfitLossSummary[] = [];
    let totalQty = 0;
    let totalPnl = 0;
    let totalEntryCost = 0;
    let totalCoverCost = 0;

    for (const group of byCode.values()) {
        const entryPrice = group.quantity > 0 ? group.entryCost / group.quantity : 0;
        const coverPrice = group.quantity > 0 ? group.coverCost / group.quantity : 0;
        const prRatio = group.entryCost > 0 ? (group.pnl / group.entryCost) * 100 : 0;

        profitlossSum.push({
            code: group.code,
            quantity: group.quantity,
            pnl: group.pnl,
            pr_ratio: prRatio,
            entry_price: entryPrice,
            cover_price: coverPrice,
            entry_cost: group.entryCost,
            cover_cost: group.coverCost,
            buy_cost: group.entryCost,
            sell_cost: group.coverCost,
            cond: group.cond,
            currency: 'TWD',
        });

        totalQty += group.quantity;
        totalPnl += group.pnl;
        totalEntryCost += group.entryCost;
        totalCoverCost += group.coverCost;
    }

    const totalRatio = totalEntryCost > 0 ? (totalPnl / totalEntryCost) * 100 : 0;

    const total: ProfitLossTotal = {
        entry_amount: totalEntryCost,
        cover_amount: totalCoverCost,
        quantity: totalQty,
        buy_cost: totalEntryCost,
        sell_cost: totalCoverCost,
        pnl: totalPnl,
        pr_ratio: totalRatio,
    };

    return {
        profitloss_sum: profitlossSum,
        total,
    };
}

/** 將玉山 get_trade_status 回應轉換為 TradingLimits */
export function fromEsunTradeStatusToLimits(raw: EsunTradeStatusRaw): TradingLimits {
    const tradingLimit = Number(raw.trading_limit ?? raw.trade_limit ?? 0);
    const tradingAvailable = Number(raw.trading_available ?? tradingLimit);
    const tradingUsed = Number(raw.trading_used ?? Math.max(0, tradingLimit - tradingAvailable));

    const marginLimit = Number(raw.margin_limit ?? 0);
    const marginAvailable = Number(raw.margin_available ?? marginLimit);
    const marginUsed = Number(raw.margin_used ?? Math.max(0, marginLimit - marginAvailable));

    const shortLimit = Number(raw.short_limit ?? 0);
    const shortAvailable = Number(raw.short_available ?? shortLimit);
    const shortUsed = Number(raw.short_used ?? Math.max(0, shortLimit - shortAvailable));

    return {
        trading_limit: tradingLimit,
        trading_used: tradingUsed,
        trading_available: tradingAvailable,
        margin_limit: marginLimit,
        margin_used: marginUsed,
        margin_available: marginAvailable,
        short_limit: shortLimit,
        short_used: shortUsed,
        short_available: shortAvailable,
    };
}
