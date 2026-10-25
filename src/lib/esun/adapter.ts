// src/lib/esun/adapter.ts — Driver interface for E.SUN Securities trading & portfolio

import type {
    EsunBalanceRaw,
    EsunInventoryItem,
    EsunMarketStatusRaw,
    EsunTradeStatusRaw,
    EsunTransactionItem,
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
    /** 券商 token 已失效（例如台北換日 00:00）；失效期間委託回 503 ESUN_SESSION_EXPIRED（未送出） */
    sessionExpired?: boolean;
    /** 失效時間（ISO 字串或 epoch 秒／毫秒） */
    sessionExpiredAt?: string | number | null;
}

/** POST /esun/auth/reconnect 的成功回應（失敗時 bridge 回非 2xx，driver 丟出 EsunBridgeError） */
export interface EsunReconnectResponse {
    ok: boolean;
    message?: string;
    error?: string;
    code?: string;
    account?: { broker_id: string; account_id: string } | null;
    environment?: EsunEnvironment | null;
    sessionGeneration?: number | null;
}

/** POST /esun/auth/reconnect 的選項 */
export interface EsunReconnectOptions {
    /** 熔斷鎖住且憑證未變時強制重試一次（只在使用者確認後帶） */
    force?: boolean;
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

    /**
     * 查詢 get_inventories 原始列（bridge 原樣回傳）。有此方法時 service 只打一次請求，
     * 同時產生 StockPosition 與完整庫存明細。
     */
    getInventories?(unit?: 'Common' | 'Share'): Promise<EsunInventoryItem[]>;

    /** get_transactions_by_date 原始列（區間已裁切到 180 天內） */
    getTransactions?(beginDate: string, endDate: string): Promise<EsunTransactionItem[]>;

    /** get_balance 原始回應（含 bridge 的 cached、cache_age_sec） */
    getBalanceRaw?(): Promise<EsunBalanceRaw>;

    /** get_trade_status 原始回應 */
    getTradeStatusRaw?(): Promise<EsunTradeStatusRaw>;

    /** get_market_status 原始回應 */
    getMarketStatusRaw?(): Promise<EsunMarketStatusRaw>;

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

    /**
     * 以目前設定檔重新登入券商（POST /esun/auth/reconnect；不是委託）。
     * opts.force：熔斷鎖住且憑證未變時 bridge 回 423 ESUN_CREDENTIALS_UNCHANGED，需帶 force 才重試；
     * 只能在使用者明確確認後傳入。
     */
    reconnect?(opts?: EsunReconnectOptions): Promise<EsunReconnectResponse>;

    /** 登入 / 連線（可選） */
    login?(): Promise<void>;
}
