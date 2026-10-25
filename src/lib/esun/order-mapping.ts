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
    EsunMarketStatusRaw,
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
function taipeiToday(nowMs: number = Date.now()): Date {
    const now = new Date(nowMs + 8 * 3600_000);
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
    const rawOrdNo = String(res.ord_no ?? res.ordNo ?? '').trim();
    // 預約單（ord_type 1）的 SDK 回應把預約單編號放在 ord_no。新版 bridge 已改為 pre_ord_no、ord_no 空白；
    // 舊版 bridge 原樣轉送時，ord_no 是預約單編號而非委託書號（刪改單不得當成 ordNo 送出）
    const legacyReservation = String(res.ord_type ?? res.ordType ?? '').trim() === '1'
        && !String(res.pre_ord_no ?? res.preOrdNo ?? '').trim();
    const ordNo = legacyReservation ? '' : rawOrdNo;
    const orderId = legacyReservation ? rawOrdNo : esunOrderId(res);
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

/**
 * 委託列的排序鍵：ord_date（YYYYMMDD）＋ ord_time 補成 9 碼的 HHMMSSmmm。ord_time 7～9 碼視為
 * HHMMSSmmm（前導零可能被去掉，前補零到 9 碼）；5～6 碼視為 HHMMSS（前補零到 6 碼、毫秒補 000）。
 * 缺日期或時間、格式不符 → null。
 */
export function esunOrderSortKey(raw: Record<string, unknown>): string | null {
    const d = String(raw.ord_date ?? raw.ordDate ?? '').replace(/-/g, '').trim();
    const t = String(raw.ord_time ?? raw.ordTime ?? '').replace(/[:.]/g, '').trim();
    if (!/^\d{8}$/.test(d) || !/^\d{5,9}$/.test(t)) return null;
    const time = t.length <= 6 ? `${t.padStart(6, '0')}000` : t.padStart(9, '0');
    return `${d}${time}`;
}

/**
 * 委託查詢列依 (ord_date, ord_time) 由舊到新穩定排序（上游約定：陣列由舊到新、UI 反轉成最新在前）。
 * 同一秒內依毫秒排序；缺日期或時間的列保持原本相對順序並排在最前。不改動輸入陣列。
 */
export function sortEsunOrderResultsOldestFirst<T extends Record<string, unknown>>(rows: readonly T[]): T[] {
    return rows
        .map((row, idx) => ({ row, idx, key: row && typeof row === 'object' ? esunOrderSortKey(row) : null }))
        .sort((a, b) => {
            if (a.key === null || b.key === null) {
                if (a.key === null && b.key === null) return a.idx - b.idx;
                return a.key === null ? -1 : 1;
            }
            return a.key < b.key ? -1 : a.key > b.key ? 1 : a.idx - b.idx;
        })
        .map(x => x.row);
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
    /** 同一列也帶 esun_snapshot_missing: true（券商最近一次快照沒列出、bridge 因近期而保留） */
    snapshotMissing: boolean;
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
    return { opCode: String(f.op_code ?? '').trim(), opMsg: String(f.op_msg ?? '').trim(), snapshotMissing: raw.esun_snapshot_missing === true };
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

/** 庫存列交易類別 → StockPosition.cond（'3' 融資、'4' 融券，其他為現股） */
export function esunInventoryCondOf(trade: unknown): string {
    const t = String(trade ?? '').trim();
    return t === EsunTradeType.Margin ? 'MarginTrading' : t === EsunTradeType.Short ? 'ShortSelling' : 'Cash';
}

/** 第一個有限且大於 0 的價格；都沒有 → NaN（空字串、0、非數字都視為缺值） */
function firstPositivePrice(...values: unknown[]): number {
    for (const v of values) {
        const n = finiteNumber(v);
        if (n !== null && n > 0) return n;
    }
    return Number.NaN;
}

/** 將玉山庫存項目 (stk_sums) 轉換為 Shioaji-Pro 標準 StockPosition 物件 */
export function fromEsunInventoryToPosition(
    item: EsunInventoryItem,
    unit: 'Common' | 'Share' = 'Common',
    id = 1,
): StockPosition {
    const rawQty = Number(item.cost_qty ?? item.qty ?? 0);
    // 玉山庫存 cost_qty、qty_l 單位為股；Common 單位一律精確換算成張（股/1000，不取整），
    // 與已實現損益的張數一致（2500 股 → 2.5 張）
    const quantity = unit === 'Common' ? rawQty / 1000 : rawQty;

    // 價格欄位可能是空字串：Number('') 會變成 0，0 當參考價會讓第一個 tick 的 markPosition
    // 把損益加上「價格×股數」。一律取第一個有限且大於 0 的值；都沒有時為 NaN（未知）：
    // fmtPrice 顯示「—」、markPosition 對非有限 last_price 不重算損益、報酬率（price > 0 判斷）不計算。
    const price = firstPositivePrice(item.price_avg, item.price);
    const lastPrice = firstPositivePrice(item.price_mkt, item.price_now, item.price_avg);
    const pnl = Number(item.make_a_sum ?? 0);
    const ydQtyRaw = Number(item.qty_l ?? 0);
    const ydQuantity = unit === 'Common' ? ydQtyRaw / 1000 : ydQtyRaw;

    // 方向與信用別只看庫存列的交易類別 trade（'0' 現股、'3' 融資、'4' 融券）；
    // qty_b／qty_s／qty_bm／qty_sm 是當日委買賣與成交量，不代表持倉方向
    const trade = String(item.trade ?? '').trim();
    const cond = esunInventoryCondOf(trade);

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
    } else if (typeof raw.updated_at === 'number' && Number.isFinite(raw.updated_at)) {
        // 正式環境回整數 epoch：≥ 1e12 視為毫秒，否則視為秒
        const ms = raw.updated_at >= 1e12 ? raw.updated_at : raw.updated_at * 1000;
        date = new Date(ms).toISOString();
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

const SETTLEMENT_FORMAT_ERROR = '玉山交割款回應格式錯誤';

/** YYYYMMDD 或 YYYY-MM-DD 且為合法日曆日期 → YYYY-MM-DD；否則 null */
function toIsoDay(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
}

function isoWeekday(iso: string): boolean {
    const w = new Date(`${iso}T00:00:00Z`).getUTCDay();
    return w !== 0 && w !== 6;
}

/** iso 之後的第一個週一至週五（只跳過週六日，不知道國定假日） */
function nextWeekday(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    do {
        d.setUTCDate(d.getUTCDate() + 1);
    } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    return d.toISOString().slice(0, 10);
}

function settlementAmount(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

/** 交割行事曆的 T+0／T+1 錨點；market_status 不可用時回 null */
function settlementAnchors(
    status: EsunMarketStatusRaw | null | undefined,
    today: string,
): { a0: string; a1?: string } | null {
    if (!status || typeof status !== 'object') return null;
    const isTrading = status.is_trading_day ?? status.isTradingDay;
    const next = toIsoDay(status.next_trading_day ?? status.nextTradingDay);
    if (typeof isTrading !== 'boolean' || !next) return null;
    if (isTrading && isoWeekday(today) && next >= today) {
        return { a0: today, a1: next > today ? next : undefined };
    }
    // 非交易日（或隔夜過期但 next==today 的快取）：T+0 是今天之後第一個交易日
    if (next >= today) return { a0: next };
    return null;
}

/**
 * 玉山交割行事曆中「沒有任何玉山款項」的 0 元格（日期是推算的：market_status 錨點或只跳週末）。
 * 不改上游 Settlement 型別，以物件身分標記；合併多帳戶時見 mergeSettlementSlot。
 */
const estimatedEsunSettlements = new WeakSet<Settlement>();

/** row 是否為玉山推算的 0 元格（日期不具權威性，合併時讓位給其他帳戶的真實列） */
export function isEstimatedEsunSettlement(row: Settlement): boolean {
    return estimatedEsunSettlements.has(row);
}

/**
 * 帳務 pane 合併多個證券帳戶同一個 T 的交割列：
 * - 一方是玉山推算的 0 元格 → 採用另一方（真實列）的日期，金額加總；兩方都是推算格時沿用先到的日期，
 *   合併結果仍標記為推算格。
 * - 兩方都是真實列且日期不同 → throw（合計待確認）。
 */
export function mergeSettlementSlot(previous: Settlement | undefined, row: Settlement): Settlement {
    const rowEstimated = isEstimatedEsunSettlement(row);
    if (!previous) {
        const first = { ...row };
        if (rowEstimated) estimatedEsunSettlements.add(first);
        return first;
    }
    const prevEstimated = isEstimatedEsunSettlement(previous);
    if (previous.date !== row.date && !prevEstimated && !rowEstimated) {
        throw new Error('帳戶交割日期不一致，合計待確認');
    }
    const merged = {
        ...row,
        date: prevEstimated && !rowEstimated ? row.date : previous.date,
        amount: previous.amount + row.amount,
    };
    if (prevEstimated && rowEstimated) estimatedEsunSettlements.add(merged);
    return merged;
}

/**
 * 將玉山 get_settlements 回應轉成交割行事曆的三格 T+0／T+1／T+2（恰好三列，無資料的格金額為 0）。
 * T+0＝今天起第一個交易日；交易日以玉山 market_status 為準，取不到或過期才退回只跳週末的推算
 * （國定假日無法本地判斷，只影響金額為 0 的格的日期）。玉山的 date 是成交日，交割日是 c_date。
 *
 * 沒有玉山款項的格以 isEstimatedEsunSettlement 標記為推算格：與其他券商帳戶合計時改用對方真實列的日期。
 *
 * 取捨：market_status 不可用時，T+1 不以 nextWeekday(T+0) 當錨點，T+1／T+2 只由實際款項日期或
 * 只跳週末的推算補位。若把 T+1 錨在 nextWeekday，T+0 與 T+1 之間遇到國定假日時，真實款項日期會
 * 落在三格之外而 throw；現行做法最多讓「推算格」的日期在假日前後不精確（金額為 0，且合計時讓位給真實列）。
 */
export function fromEsunSettlements(
    rawList: EsunSettlementItem[],
    marketStatus?: EsunMarketStatusRaw | null,
    nowMs: number = Date.now(),
): Settlement[] {
    if (!Array.isArray(rawList)) throw new Error(SETTLEMENT_FORMAT_ERROR);
    const today = formatDate(taipeiToday(nowMs), true);

    const byDate = new Map<string, number>();
    for (const item of rawList) {
        if (!item || typeof item !== 'object') throw new Error(SETTLEMENT_FORMAT_ERROR);
        const date = toIsoDay(item.c_date ?? item.cDate ?? item.cdate);
        const amount = settlementAmount(item.price ?? item.amount);
        if (!date || amount === null) throw new Error(SETTLEMENT_FORMAT_ERROR);
        if (date < today) continue; // 已交割
        byDate.set(date, (byDate.get(date) ?? 0) + amount);
    }
    const pending = [...byDate.keys()].sort();

    const anchors = settlementAnchors(marketStatus, today)
        ?? { a0: isoWeekday(today) ? today : nextWeekday(today) };
    const minDate = (a: string | undefined, b: string | undefined) =>
        a === undefined ? b : b === undefined ? a : (a < b ? a : b);

    const s0 = minDate(anchors.a0, pending[0]) as string;
    const s1 = minDate(anchors.a1, pending.find(d => d > s0)) ?? nextWeekday(s0);
    const s2 = pending.find(d => d > s1) ?? nextWeekday(s1);
    const slots = [s0, s1, s2];

    const outside = pending.filter(d => !slots.includes(d));
    if (outside.length > 0) {
        throw new Error(`玉山交割款日期超出 T+2（${outside.join('、')}），無法對應交割行事曆`);
    }
    return slots.map((date, T) => {
        const settlement: Settlement = { date, amount: byDate.get(date) ?? 0, T };
        if (!byDate.has(date)) estimatedEsunSettlements.add(settlement);
        return settlement;
    });
}

/** 交易類別 9：信用當沖（只出現在帳務） */
const ESUN_CREDIT_DAY_TRADE = '9';

/**
 * 成交紀錄交易類別 → cond：'3' 融資、'9' 信用當沖 → MarginTrading（信用當沖是同一日以
 * 融資買進、融券賣出互相沖銷，App 的 cond 沒有對應值，歸入信用交易的融資）；'4' 融券 →
 * ShortSelling；其他為現股。
 */
export function esunTransactionCondOf(trade: unknown): string {
    const t = String(trade ?? '').trim().toUpperCase();
    if (t === EsunTradeType.Margin || t === ESUN_CREDIT_DAY_TRADE) return 'MarginTrading';
    if (t === EsunTradeType.Short) return 'ShortSelling';
    return 'Cash';
}

/**
 * 成交明細中「已實現」的列：賣出（現股、融資、當沖）或融券回補（買進＋trade 4），
 * 且 make（損益）有值。買進建倉與融券賣出建倉不是已實現損益。
 * 交易類別 9（信用當沖）：沖銷的兩邊都可能帶損益，S 側一律算已實現；B 側只有 make≠0
 * 才算（make 為 0 的 B 側視為建倉腿，避免同一筆當沖被算兩次）。
 */
export function isEsunRealizedTransaction(item: EsunTransactionItem): boolean {
    const make = finiteNumber(item.make);
    if (make === null) return false;
    const side = String(item.buy_sell ?? '').trim().toUpperCase();
    const trade = String(item.trade ?? '').trim().toUpperCase();
    const buy = side === 'B' || side === 'BUY';
    const sell = side === 'S' || side === 'SELL';
    if (trade === ESUN_CREDIT_DAY_TRADE) {
        if (sell) return true;
        if (buy) return make !== 0;
        return true;
    }
    const short = trade === EsunTradeType.Short;
    if (buy) return short;
    if (sell) return !short;
    // 沒有買賣別的舊資料：沿用 make 判定
    return true;
}

const isRealizedTransaction = isEsunRealizedTransaction;

/** 成交紀錄的股數（qty；舊資料 quantity）；缺值或非有限值 → 0 */
function transactionShares(item: EsunTransactionItem): number {
    return finiteNumber(item.qty ?? item.quantity) ?? 0;
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
        // 玉山 qty 是股數（price_qty 是價金，不是股數）；App 的股票已實現損益數量以張為單位
        // （上游 profit_loss 預設 unit Common），精確換算不取整
        const shares = transactionShares(item);
        const quantity = shares / 1000;
        const pnl = Number(item.make ?? 0);
        const prRatio = Number(item.make_per ?? 0);
        const cost = Math.abs(Number(item.cost ?? 0));
        const price = Number(item.price ?? item.price_avg ?? (cost > 0 && shares > 0 ? cost / shares : 0));
        const cond = esunTransactionCondOf(item.trade);

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

/**
 * 將玉山成交紀錄 (mat_sums) 轉換為 ProfitLossSummaryTotal（只彙總已實現損益的列）。
 * - 分組鍵：code＋cond（同一檔的現股與融資／融券分開彙總）。
 * - quantity：張（Σ股數/1000，與 fromEsunTransactionsToProfitLoss 的明細一致）。
 * - entry_cost＝Σ|cost|（玉山「已實現損益成本小計」）；cover_cost＝Σrecv（「已實現損益收入小計」，
 *   缺 recv 時以 |cost|＋make 推算）。
 * - 價格以股數計算：cover_price＝Σprice_qty／Σ股數（price_qty 為價金小計，缺值時以 price×股數補）；
 *   entry_price＝entry_cost／Σ股數。
 * 融資、融券的 cost 與 recv 依玉山的定義（例如成本只含自備款、收入扣除融資金額），不是完整的
 * 買進／賣出價金，因此信用交易的 entry_price 只是「成本小計／股數」，僅供參考。
 */
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

    const groups = new Map<string, {
        code: string;
        shares: number;
        priceQty: number;
        pnl: number;
        entryCost: number;
        coverCost: number;
        cond: string;
    }>();

    for (const item of realized) {
        const code = String(item.stk_no ?? item.code ?? '').trim();
        const shares = transactionShares(item);
        const pnl = finiteNumber(item.make) ?? 0;
        const cost = Math.abs(finiteNumber(item.cost) ?? 0);
        const recv = finiteNumber(item.recv) ?? (cost + pnl);
        const unitPrice = finiteNumber(item.price ?? item.price_avg);
        const priceQty = finiteNumber(item.price_qty) ?? (unitPrice !== null ? unitPrice * shares : 0);
        const cond = esunTransactionCondOf(item.trade);
        const key = `${code}\u0000${cond}`;

        const existing = groups.get(key) || {
            code,
            shares: 0,
            priceQty: 0,
            pnl: 0,
            entryCost: 0,
            coverCost: 0,
            cond,
        };

        existing.shares += shares;
        existing.priceQty += priceQty;
        existing.pnl += pnl;
        existing.entryCost += cost;
        existing.coverCost += recv;
        groups.set(key, existing);
    }

    const profitlossSum: StockProfitLossSummary[] = [];
    let totalShares = 0;
    let totalPnl = 0;
    let totalEntryCost = 0;
    let totalCoverCost = 0;

    for (const group of groups.values()) {
        const quantity = group.shares / 1000;
        const entryPrice = group.shares > 0 ? group.entryCost / group.shares : 0;
        const coverPrice = group.shares > 0 ? group.priceQty / group.shares : 0;
        const prRatio = group.entryCost > 0 ? (group.pnl / group.entryCost) * 100 : 0;

        profitlossSum.push({
            code: group.code,
            quantity,
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

        totalShares += group.shares;
        totalPnl += group.pnl;
        totalEntryCost += group.entryCost;
        totalCoverCost += group.coverCost;
    }

    const totalRatio = totalEntryCost > 0 ? (totalPnl / totalEntryCost) * 100 : 0;

    const total: ProfitLossTotal = {
        entry_amount: totalEntryCost,
        cover_amount: totalCoverCost,
        quantity: totalShares / 1000,
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
