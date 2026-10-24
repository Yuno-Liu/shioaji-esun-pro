// src/lib/esun/adapter.ts — Driver interface for E.SUN Securities trading & portfolio

import type {
    EsunConfigProfilesMap,
    EsunEnvironment,
    EsunMutationGuard,
    EsunOrderMutationPayload,
    EsunOrderPayload,
    EsunOrderResult,
    EsunPlaceOrderResponse,
    EsunPriceFlag,
    EsunQuantityUnit,
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
    availableEnvironments?: EsunEnvironment[];
    configProfiles?: EsunConfigProfilesMap;
    activeConfigFile?: string | null;
    /** session 快照代次：登入／切換成功才 +1（esun-bridge §3） */
    sessionGeneration?: number | null;
    /** 磁碟上偵測到的設定與目前 session 不一致 */
    configDrift?: boolean;
    diskEnvironment?: EsunEnvironment | null;
    wsConnected?: boolean;
    wsLastMessageAt?: string | null;
    loginLocked?: boolean;
    loginLockReason?: string | null;
}

/** 每筆委託類請求附帶的選項 */
export interface EsunMutationOptions {
    /** 預期環境與帳號；bridge 不符時回 409（確定未送出） */
    guard?: EsunMutationGuard;
    /** 改量的數量單位（只用於 replaceQuantity） */
    unit?: EsunQuantityUnit;
    /** 改價的價格旗標（只用於 replacePrice） */
    priceFlag?: EsunPriceFlag;
}

/** 抽象驅動介面：支援不同執行環境（HTTP 橋接、Mock 模擬） */
export interface IEsunTradeDriver {
    readonly name: string;

    /** 送出委託 */
    placeOrder(payload: EsunOrderPayload, opts?: EsunMutationOptions): Promise<EsunPlaceOrderResponse>;

    /** 改價 */
    replacePrice(
        orderNo: string,
        price: number | EsunPriceFlag,
        payload?: EsunOrderMutationPayload,
        opts?: EsunMutationOptions,
    ): Promise<EsunReplaceOrderResponse>;

    /** 減量：cancelQuantity 為「減少量」（與上游 update_qty、SDK cancel_order(cel_qty) 相同語意） */
    replaceQuantity(
        orderNo: string,
        cancelQuantity: number,
        payload?: EsunOrderMutationPayload,
        opts?: EsunMutationOptions,
    ): Promise<EsunReplaceOrderResponse>;

    /** 刪單（刪除全部剩餘量） */
    cancelOrder(
        orderNo: string,
        payload?: EsunOrderMutationPayload,
        opts?: EsunMutationOptions,
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
        account?: { broker_id: string; account_id: string } | null;
        message?: string;
        activeConfigFile?: string | null;
        availableEnvironments?: EsunEnvironment[];
        configProfiles?: EsunConfigProfilesMap;
        sessionGeneration?: number | null;
        error?: string;
    }>;

    /** 登入 / 連線（可選） */
    login?(): Promise<void>;
}
