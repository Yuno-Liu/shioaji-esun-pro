// src/lib/esun/order-mapping.ts — Order translation and validation for E.SUN Securities

import type { ContractBase } from '../types/contract';
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
import {
    ESUN_BROKER_CODE,
    ESUN_BROKER_NAME,
    EsunApCode,
    EsunBsFlag,
    EsunErrorCode,
    EsunInventoryItem,
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

/** 判斷 broker_id 是否為玉山證券代號或名稱 */
export function isEsunBroker(brokerId?: string | null): boolean {
    if (!brokerId || typeof brokerId !== 'string') return false;
    const b = brokerId.trim().toUpperCase();
    return (
        b === '8840' ||
        b === '9600' ||
        b.startsWith('884') ||
        b.startsWith('96') ||
        b === 'ESUN' ||
        b === 'E.SUN' ||
        b === 'ESUNSEC' ||
        b === '玉山' ||
        b === ESUN_BROKER_NAME
    );
}

/** 判斷帳戶是否為玉山證券帳戶 */
export function isEsunAccount(account?: Pick<Account, 'broker_id'> | null): boolean {
    return !!account && isEsunBroker(account.broker_id);
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

    // 興櫃股票規則：1 <= quantity <= 499,000 股，超過 1,000 股需為 1,000 股整數倍
    if (contract.exchange === 'OES') {
        if (order.quantity < 1 || order.quantity > 499000) {
            return '興櫃股票委託數量必須在 1 至 499,000 股之間';
        }
        if (order.quantity > 1000 && order.quantity % 1000 !== 0) {
            return '興櫃股票委託數量超過 1,000 股時，必須為 1,000 股的整數倍';
        }
    }

    // 整股 / 盤後定價規則：1 <= quantity <= 499 張
    if (contract.exchange !== 'OES') {
        if (order.order_lot === 'Common' || order.order_lot === 'Fixing' || !order.order_lot) {
            if (order.quantity < 1 || order.quantity > 499) {
                return order.order_lot === 'Fixing'
                    ? '盤後定價委託數量必須在 1 至 499 張之間'
                    : '整股委託數量必須在 1 至 499 張之間';
            }
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

/** 驗證玉山證券改量條件 */
export function validateEsunOrderQtyMutation(trade: Trade, quantity: number): string | null {
    if (isReservationOrder(trade)) {
        return '玉山證券預約單不可改單 (AG0006)，請先刪單後重新下單';
    }

    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        return '改量必須為正整數';
    }

    const origQty = trade.order?.quantity ?? trade.status?.order_quantity;
    if (typeof origQty === 'number' && origQty > 0 && quantity >= origQty) {
        return '玉山證券僅支援減量，新數量必須小於原委託數量';
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

/** 日期字串解析為 Date */
function parseDate(dStr: string): Date {
    const clean = dStr.replace(/-/g, '');
    if (clean.length === 8) {
        const y = parseInt(clean.slice(0, 4), 10);
        const m = parseInt(clean.slice(4, 6), 10) - 1;
        const d = parseInt(clean.slice(6, 8), 10);
        return new Date(Date.UTC(y, m, d));
    }
    return new Date(dStr);
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
    const hasHyphens = beginDate.includes('-') || endDate.includes('-');
    let start = parseDate(beginDate);
    const end = parseDate(endDate);

    let clamped = false;

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

/** 將 Shioaji-Pro 的委託規格轉換為玉山證券 SDK 的 OrderPayload */
export function toEsunOrderPayload(
    contract: ContractBase,
    order: StockOrderReq,
): EsunOrderPayload {
    const buySell = order.action === 'Buy' ? EsunSide.Buy : EsunSide.Sell;

    let apCode = EsunApCode.Common;
    if (contract.exchange === 'OES') {
        apCode = EsunApCode.Emg;
    } else if (order.order_lot === 'IntradayOdd') {
        apCode = EsunApCode.IntradayOdd;
    } else if (order.order_lot === 'Odd') {
        apCode = EsunApCode.Odd;
    } else if (order.order_lot === 'Fixing') {
        apCode = EsunApCode.AfterMarket;
    }

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

function isSuccessRetCode(retCode: string): boolean {
    return retCode === '000000' || retCode === '0' || retCode === '';
}

/** 將玉山證券 placeOrder 回應轉換為 Shioaji-Pro 標準 Trade 物件 */
export function fromEsunOrderResponse(
    res: EsunPlaceOrderResponse,
    contract: ContractBase,
    order: StockOrderReq,
    account: Account,
): Trade {
    const retCode = String(res.retCode ?? res.ret_code ?? '');
    const retMsg = String(res.retMsg ?? res.ret_msg ?? '');
    const ordNo = String(res.ordNo ?? res.ord_no ?? '');
    const success = isSuccessRetCode(retCode);
    const orderId = ordNo || `ESUN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const orderResult: OrderResult = {
        id: orderId,
        seqno: ordNo,
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
        status: (success ? 'Submitted' : 'Failed') as OrderStatusName,
        status_code: retCode,
        msg: retMsg ? formatEsunErrorMessage(retCode, retMsg) : (success ? '委託已送出' : '委託失敗'),
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

/** 將玉山證券查詢回傳的委託紀錄轉換為 Trade 物件 */
export function fromEsunOrderResult(
    item: EsunOrderResult,
    account: Account,
): Trade {
    const buySell = String(item.buySell ?? item.buy_sell ?? '').toUpperCase();
    const action: Action = (buySell === 'B' || buySell === 'BUY') ? 'Buy' : 'Sell';
    const rawPrice = item.odPrice ?? item.od_price ?? 0;
    const price = typeof rawPrice === 'number' ? rawPrice : (parseFloat(String(rawPrice)) || 0);

    const rawOrgQty = item.orgQty ?? item.org_qty ?? item.orgQtyShare ?? item.org_qty_share ?? 0;
    const orgQty = typeof rawOrgQty === 'number' ? rawOrgQty : (parseInt(String(rawOrgQty), 10) || 0);

    const rawMatQty = item.matQty ?? item.mat_qty ?? item.matQtyShare ?? item.mat_qty_share ?? 0;
    const matQty = typeof rawMatQty === 'number' ? rawMatQty : (parseInt(String(rawMatQty), 10) || 0);

    const rawCelQty = item.celQty ?? item.cel_qty ?? item.celQtyShare ?? item.cel_qty_share ?? 0;
    const celQty = typeof rawCelQty === 'number' ? rawCelQty : (parseInt(String(rawCelQty), 10) || 0);

    const ordStatus = String(item.ordStatus ?? item.ord_status ?? '');
    const errCode = String(item.errCode ?? item.err_code ?? item.retCode ?? item.ret_code ?? '');
    const errMsg = String(item.errMsg ?? item.err_msg ?? item.retMsg ?? item.ret_msg ?? '');
    const ordNo = String(item.ordNo ?? item.ord_no ?? '');
    const preOrdNo = String(item.preOrdNo ?? item.pre_ord_no ?? '');
    const stockNo = String(item.stockNo ?? item.stock_no ?? '');
    const apCode = String(item.apCode ?? item.ap_code ?? '');
    const rawBsFlag = String(item.bsFlag ?? item.bs_flag ?? item.order_type ?? item.orderType ?? 'R').toUpperCase();
    const rawPriceFlag = String(item.priceFlag ?? item.price_flag ?? item.price_type ?? item.priceType ?? '0').toUpperCase();
    const memo = String(item.memo ?? item.user_def ?? '');
    const rawAvgPrice = item.avgPrice ?? item.avg_price ?? 0;
    const avgPrice = typeof rawAvgPrice === 'number' ? rawAvgPrice : (parseFloat(String(rawAvgPrice)) || 0);
    const tradeType = String(item.trade ?? '');

    let status: OrderStatusName = 'Submitted';
    if (matQty >= orgQty && orgQty > 0) {
        status = 'Filled';
    } else if (celQty >= orgQty && orgQty > 0) {
        status = 'Cancelled';
    } else if (matQty > 0) {
        status = 'PartFilled';
    } else if (ordStatus === 'Fail' || ordStatus === 'Failed' || (errCode && errCode !== '000000' && errCode !== '0')) {
        status = 'Failed';
    } else if (ordStatus === '1' || ordStatus === 'PreSubmitted' || (preOrdNo && !ordNo)) {
        status = 'PreSubmitted';
    } else if (ordStatus === 'Filled') {
        status = 'Filled';
    } else if (ordStatus === 'PartFilled' || ordStatus === 'PartiallyFilled') {
        status = 'PartFilled';
    } else if (ordStatus === 'Cancelled') {
        status = 'Cancelled';
    }

    let orderLot = 'Common';
    if (apCode === EsunApCode.IntradayOdd || apCode === '5') orderLot = 'IntradayOdd';
    else if (apCode === EsunApCode.Odd || apCode === '3') orderLot = 'Odd';
    else if (apCode === EsunApCode.AfterMarket || apCode === '2') orderLot = 'Fixing';
    else if (apCode === EsunApCode.Emg || apCode === '4') orderLot = 'Common';

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
    if (tradeType === EsunTradeType.Margin || tradeType === '3') orderCond = 'MarginTrading';
    else if (tradeType === EsunTradeType.Short || tradeType === '4') orderCond = 'ShortSelling';
    else if (tradeType === EsunTradeType.DayTradingSell || tradeType === 'A') {
        orderCond = 'Cash';
        daytradeShort = true;
    }

    const orderId = ordNo || preOrdNo;

    return {
        contract: {
            code: stockNo,
            security_type: 'STK',
            exchange: 'TSE',
            target_code: null,
        },
        order: {
            id: orderId,
            seqno: ordNo,
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
            status_code: errCode || '000000',
            msg: errMsg ? formatEsunErrorMessage(errCode, errMsg) : '',
            order_quantity: orgQty,
            deal_quantity: matQty,
            cancel_quantity: celQty,
            modified_price: avgPrice,
            deals: [],
        },
    };
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

    const isSell = Number(item.qty_s ?? 0) > 0 || Number(item.qty_sm ?? 0) > 0;
    const cond = Number(item.qty_bm ?? 0) > 0
        ? 'MarginTrading'
        : Number(item.qty_sm ?? 0) > 0
            ? 'ShortSelling'
            : 'Cash';

    return {
        id,
        code: String(item.stk_no ?? ''),
        direction: isSell ? 'Sell' : 'Buy',
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
        date = new Date().toISOString();
    }

    return {
        acc_balance: accBalance,
        date,
        errmsg: raw.errmsg || '',
    };
}

/** 將玉山圈存 (stock_pre_save_amount) 轉換為 ReserveStocksSummary */
export function fromEsunBalanceToReserveSummary(
    raw: EsunBalanceRaw,
    account?: Account,
): ReserveStocksSummary {
    const reservedAmount = Number(
        raw.stock_pre_save_amount ?? raw.stockPreSaveAmount ?? 0,
    );
    const targetAccount: Account = account ?? {
        broker_id: ESUN_BROKER_CODE,
        account_id: '',
        account_type: 'S',
        signed: true,
        username: ESUN_BROKER_NAME,
        person_id: '',
    };

    return {
        stocks: reservedAmount > 0
            ? [
                {
                    contract: {
                        code: 'TOTAL',
                        security_type: 'STK',
                        exchange: 'TSE',
                        target_code: null,
                    },
                    available_share: 0,
                    reserved_share: reservedAmount,
                },
            ]
            : [],
        account: targetAccount,
    };
}

/** 將玉山 get_settlements 回應清單轉換為 Settlement[] */
export function fromEsunSettlements(rawList: EsunSettlementItem[]): Settlement[] {
    if (!Array.isArray(rawList)) return [];

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    return rawList.map((item, idx) => {
        const rawDate = String(item.c_date ?? item.cdate ?? item.date ?? '');
        const dateStr = rawDate.length === 8
            ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
            : rawDate;
        const amount = Number(item.amount ?? item.price ?? 0);

        let tOffset = item.T;
        if (typeof tOffset !== 'number') {
            const itemDate = parseDate(dateStr);
            itemDate.setUTCHours(0, 0, 0, 0);
            const diffDays = Math.round((itemDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
            tOffset = Math.max(0, Math.min(2, diffDays));
        }

        return {
            date: dateStr,
            amount,
            T: typeof tOffset === 'number' && !Number.isNaN(tOffset) ? tOffset : idx,
        };
    });
}

/** 將玉山成交紀錄 (mat_sums) 轉換為 StockProfitLoss[] */
export function fromEsunTransactionsToProfitLoss(
    rawList: EsunTransactionItem[],
): StockProfitLoss[] {
    if (!Array.isArray(rawList)) return [];

    return rawList.map((item, idx) => {
        const code = String(item.stk_no ?? item.code ?? '');
        const rawDate = String(item.c_date ?? item.t_date ?? item.date ?? '');
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

/** 將玉山成交紀錄 (mat_sums) 轉換為 ProfitLossSummaryTotal */
export function fromEsunTransactionsToProfitLossSummary(
    rawList: EsunTransactionItem[],
    _beginDate?: string,
    _endDate?: string,
): ProfitLossSummaryTotal {
    if (!Array.isArray(rawList) || rawList.length === 0) {
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

    for (const item of rawList) {
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
