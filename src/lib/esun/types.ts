// src/lib/esun/types.ts — Types and definitions for E.SUN Securities (玉山證券) trading & portfolio

import type { StockOrderReq, StockOrderLot, StockOrderCond, Action, OrderType, StockPriceType } from '../types/order';
import type { ContractBase } from '../types/contract';
import type { Account, AccountBalance, StockPosition } from '../types/portfolio';
import type { Settlement, StockProfitLoss, ProfitLossSummaryTotal, TradingLimits, ReserveStocksSummary } from '../shioaji';

export const ESUN_BROKER_CODE = '8840';
export const ESUN_BROKER_CODE_LEGACY = '9600';
export const ESUN_BROKER_NAME = '玉山證券';

/** E.SUN SDK ApCode (委託類別) */
export enum EsunApCode {
    Common = '1',       // 整股 (以張為單位)
    AfterMarket = '2',  // 盤後定價
    Odd = '3',          // 盤後零股 (以股為單位)
    Emg = '4',          // 興櫃 (以股為單位)
    IntradayOdd = '5',  // 盤中零股 (以股為單位)
}

/** E.SUN SDK BsFlag (委託條件 / 效期) */
export enum EsunBsFlag {
    ROD = 'R',
    IOC = 'I',
    FOK = 'F',
}

/** E.SUN SDK Side (買賣別) */
export enum EsunSide {
    Buy = 'B',
    Sell = 'S',
}

/** E.SUN SDK PriceFlag (價格旗標 / 價別) */
export enum EsunPriceFlag {
    Limit = '0',      // 限價
    Flat = '1',       // 平盤價
    LimitDown = '2',  // 跌停價
    LimitUp = '3',    // 漲停價
    Market = '4',     // 市價
}

/** E.SUN SDK TradeType (交易類別 / 信用別) */
export enum EsunTradeType {
    Cash = '0',            // 現股
    Margin = '3',          // 融資
    Short = '4',           // 融券
    DayTradingSell = 'A',  // 現股當沖先賣
}

/** 官方玉山錯誤代碼 */
export enum EsunErrorCode {
    AGR0000 = 'AGR0000', // 每分鐘登入次數超限 (10次/分)
    AGR0001 = 'AGR0001', // 今日委託筆數已達上限 (2,000次/日)
    AGR0002 = 'AGR0002', // 下單頻率超限 (20次/秒)
    AGR0003 = 'AGR0003', // 庫存或成交查詢頻率超限 (12次/分)
    AGR0004 = 'AGR0004', // 今日登入次數已達上限 (300次/日)
    AGR0005 = 'AGR0005', // 委託回報查詢頻率超限 (12次/分)
    AGR0006 = 'AGR0006', // 交割款查詢頻率超限 (3次/分)
    AGA0000 = 'AGA0000', // 密碼錯誤超過 3 次鎖定
    AGA0002 = 'AGA0002', // IP 未在白名單
    AGA0005 = 'AGA0005', // 系統時間誤差過大
    AG0003 = 'AG0003',   // 查無委託資料或委託已失效
    AG0005 = 'AG0005',   // 委託已成交或已取消，無法改單
    AG0006 = 'AG0006',   // 預約單不可改單
    AG00004 = 'AG00004', // 查無委託紀錄
    AW00002 = 'AW00002', // 日期區間不可超過 180 天
    AW00003 = 'AW00003', // 起始日期不可大於結束日期
    WS1001 = '1001',     // WebSocket 連線數達上限
}

/** Configuration required to connect to E.SUN Trading API */
export interface EsunClientConfig {
    apiUrl: string;
    apiKey: string;
    apiSecret: string;
    certPath: string;
    certPass: string;
    aid: string;
    password: string;
}

/** Order payload matching @esun/trade OrderPayload */
export interface EsunOrderPayload {
    stockNo: string;
    buySell: EsunSide;
    price: number;
    quantity: number;
    apCode: EsunApCode;
    priceFlag: EsunPriceFlag;
    bsFlag: EsunBsFlag;
    trade: EsunTradeType;
    userDef?: string;
}

/** Response returned by E.SUN placeOrder */
export interface EsunPlaceOrderResponse {
    retCode?: string;
    retMsg?: string;
    workDate?: string;
    ordType?: string;
    ordNo?: string;
    ordDate?: string;
    ordTime?: string;
    ret_code?: string;
    ret_msg?: string;
    work_date?: string;
    ord_type?: string;
    ord_no?: string;
    ord_date?: string;
    ord_time?: string;
    [key: string]: unknown;
}

/** Response returned by E.SUN replacePrice / replaceQuantity / cancelOrder */
export interface EsunReplaceOrderResponse {
    retCode?: string;
    retMsg?: string;
    ordDate?: string;
    ordTime?: string;
    ret_code?: string;
    ret_msg?: string;
    ord_date?: string;
    ord_time?: string;
    [key: string]: unknown;
}

/** Order result query item from E.SUN */
export interface EsunOrderResult {
    workDate?: string;
    ordDate?: string;
    ordTime?: string;
    ordStatus?: string;
    ordNo?: string;
    preOrdNo?: string;
    stockNo?: string;
    buySell?: string;
    apCode?: string;
    priceFlag?: string;
    trade?: string;
    odPrice?: string | number;
    orgQty?: string | number;
    orgQtyShare?: string | number;
    matQty?: string | number;
    matQtyShare?: string | number;
    celQty?: string | number;
    celQtyShare?: string | number;
    celable?: string;
    errCode?: string;
    errMsg?: string;
    avgPrice?: string | number;
    bsFlag?: string;
    memo?: string;

    // snake_case (Python esun_trade)
    work_date?: string;
    ord_date?: string;
    ord_time?: string;
    ord_status?: string;
    ord_no?: string;
    pre_ord_no?: string;
    stock_no?: string;
    buy_sell?: string;
    ap_code?: string;
    price_flag?: string;
    od_price?: string | number;
    org_qty?: string | number;
    org_qty_share?: string | number;
    mat_qty?: string | number;
    mat_qty_share?: string | number;
    cel_qty?: string | number;
    cel_qty_share?: string | number;
    err_code?: string;
    err_msg?: string;
    avg_price?: string | number;
    bs_flag?: string;
    user_def?: string;
    ret_code?: string;
    ret_msg?: string;
    [key: string]: unknown;
}

/** Raw inventory item returned by E.SUN get_inventories (stk_sums) */
export interface EsunInventoryItem {
    stk_no: string;
    stk_na?: string;
    cost_qty: number | string;
    cost_sum?: number | string;
    make_a_per?: number | string;
    make_a_sum?: number | string;
    price_avg?: number | string;
    price_evn?: number | string;
    price_mkt?: number | string;
    price_now?: number | string;
    qty_b?: number | string;
    qty_s?: number | string;
    qty_c?: number | string;
    qty_bm?: number | string;
    qty_sm?: number | string;
    qty_l?: number | string;
    s_type?: string;
    value_mkt?: number | string;
    [key: string]: unknown;
}

/** Raw balance response from E.SUN get_balance */
export interface EsunBalanceRaw {
    available_balance?: number | string;
    availableBalance?: number | string;
    acc_balance?: number | string;
    exchange_balance?: number | string;
    exchangeBalance?: number | string;
    stock_pre_save_amount?: number | string;
    stockPreSaveAmount?: number | string;
    is_latest_data?: boolean;
    isLatestData?: boolean;
    updated_at?: string;
    updatedAt?: string | { seconds?: number; nanos?: number };
    errmsg?: string;
    [key: string]: unknown;
}

/** Raw settlement item from E.SUN get_settlements */
export interface EsunSettlementItem {
    c_date?: string;
    cdate?: string;
    date?: string;
    price?: number | string;
    amount?: number | string;
    T?: number;
    [key: string]: unknown;
}

/** Raw transaction item from E.SUN get_transactions / get_transactions_by_date */
export interface EsunTransactionItem {
    buy_sell?: string;
    stk_no?: string;
    stk_na?: string;
    code?: string;
    c_date?: string;
    t_date?: string;
    date?: string;
    cost?: number | string;
    make?: number | string;
    make_per?: number | string;
    price_avg?: number | string;
    price_qty?: number | string;
    qty?: number | string;
    quantity?: number | string;
    recv?: number | string;
    trade?: string;
    dseq?: string;
    order_no?: string;
    price?: number | string;
    [key: string]: unknown;
}

/** Raw trade status response from E.SUN get_trade_status */
export interface EsunTradeStatusRaw {
    trade_limit?: number | string;
    trading_limit?: number | string;
    trading_used?: number | string;
    trading_available?: number | string;
    margin_limit?: number | string;
    margin_used?: number | string;
    margin_available?: number | string;
    short_limit?: number | string;
    short_used?: number | string;
    short_available?: number | string;
    day_trade_code?: string;
    margin_code?: string;
    short_code?: string;
    [key: string]: unknown;
}
