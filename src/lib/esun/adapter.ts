// src/lib/esun/adapter.ts — Driver interface for E.SUN Securities trading & portfolio

import type {
    EsunOrderPayload,
    EsunOrderResult,
    EsunPlaceOrderResponse,
    EsunPriceFlag,
    EsunReplaceOrderResponse,
} from './types';
import type { Account, AccountBalance, StockPosition } from '../types/portfolio';
import type {
    Settlement,
    StockProfitLoss,
    ProfitLossSummaryTotal,
    TradingLimits,
    ReserveStocksSummary,
} from '../shioaji';

export interface EsunBridgeHealth {
    ok: boolean;
    configured: boolean;
    problems: string[];
    environment: 'SIMULATION' | 'PRODUCTION' | null;
    simulation?: boolean;
    entry?: string | null;
    account: { broker_id: string; account_id: string } | null;
    loggedIn: boolean;
    loginError: string | null;
}

/** 抽象驅動介面：支援不同執行環境（HTTP 橋接、Mock 模擬） */
export interface IEsunTradeDriver {
    readonly name: string;

    /** 送出委託 */
    placeOrder(payload: EsunOrderPayload): Promise<EsunPlaceOrderResponse>;

    /** 改價 */
    replacePrice(
        orderNo: string,
        price: number | EsunPriceFlag,
        payload?: Partial<EsunOrderPayload>,
    ): Promise<EsunReplaceOrderResponse>;

    /** 減量 / 改量 */
    replaceQuantity(
        orderNo: string,
        quantity: number,
        payload?: Partial<EsunOrderPayload>,
    ): Promise<EsunReplaceOrderResponse>;

    /** 刪單 */
    cancelOrder(
        orderNo: string,
        payload?: Partial<EsunOrderPayload>,
    ): Promise<EsunReplaceOrderResponse>;

    /** 查詢當日委託（可選，refresh: 強制打 API 刷新） */
    getOrders?(refresh?: boolean): Promise<EsunOrderResult[]>;

    /** 查詢持股庫存與未實現損益 */
    getPositions?(unit?: 'Common' | 'Share'): Promise<StockPosition[]>;

    /** 查詢銀行餘額與圈存 */
    getBalance?(): Promise<AccountBalance>;

    /** 查詢 T+2 交割款 */
    getSettlements?(): Promise<Settlement[]>;

    /** 查詢歷史成交與已實現損益 */
    getProfitLoss?(beginDate: string, endDate: string): Promise<StockProfitLoss[]>;

    /** 查詢歷史成交與已實現損益彙總 */
    getProfitLossSummary?(beginDate: string, endDate: string): Promise<ProfitLossSummaryTotal>;

    /** 查詢交易額度與信用權限 */
    getTradingLimits?(): Promise<TradingLimits>;

    /** 查詢圈存摘要 */
    getStockReserveSummary?(): Promise<ReserveStocksSummary>;

    /** 查詢憑證效期 */
    getCaExpire?(personId?: string): Promise<{ ca_expiretime: string }>;

    /** 健康檢查 */
    health?(timeoutMs?: number): Promise<EsunBridgeHealth>;

    /** 查詢帳戶清單 */
    accounts?(timeoutMs?: number): Promise<Account[]>;

    /** 切換環境（模擬 / 正式） */
    switchEnvironment?(env: 'SIMULATION' | 'PRODUCTION'): Promise<{
        ok: boolean;
        environment: 'SIMULATION' | 'PRODUCTION';
        entry: string;
        message?: string;
    }>;

    /** 登入 / 連線（可選） */
    login?(): Promise<void>;
}
