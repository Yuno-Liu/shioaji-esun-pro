// src/lib/esun/http-driver.ts — Browser driver: forwards E.SUN orders and portfolio queries
// to the Python Sidecar / HTTP bridge over same-origin /esun/* JSON endpoints.
//
// Mutation 回應信封（esun-bridge 契約）：
//   accepted（200）→ 回傳 result；not_sent（4xx／503）與 rejected（422）→ 確定未成立
//   （mutationNotStarted）；unknown（502／504）、5xx、網路錯誤、逾時、無法解析的回應
//   → 結果未知（mutationOutcomeUnknown／orderOutcomeUnknown），一律不重送。
// 舊版 bridge 沒有信封時：2xx 視為 SDK 原始回傳；送單前就擋下的已知錯誤碼與 4xx
// （408／409 除外）視為未送出；其餘一律結果未知。GET 失敗照一般錯誤處理。

import type { IEsunTradeDriver, EsunBridgeHealth, EsunMutationOptions, EsunReconnectOptions, EsunReconnectResponse } from './adapter';
import type {
    EsunBalanceRaw,
    EsunInventoryItem,
    EsunMarketStatusRaw,
    EsunTradeStatusRaw,
    EsunMutationOutcome,
    EsunOrderMutationPayload,
    EsunOrderPayload,
    EsunOrderResult,
    EsunPlaceOrderResponse,
    EsunPriceFlag,
    EsunReplaceOrderResponse,
    EsunSettlementItem,
    EsunTransactionItem,
} from './types';
import type { Account, AccountBalance, StockPosition } from '../types/portfolio';
import type {
    Settlement,
    StockProfitLoss,
    ProfitLossSummaryTotal,
    TradingLimits,
    ReserveStocksSummary,
} from '../shioaji';
import {
    clampEsunDateRange180Days,
    fromEsunBalance,
    fromEsunBalanceToReserveSummary,
    fromEsunInventoryToPosition,
    fromEsunSettlements,
    fromEsunTradeStatusToLimits,
    fromEsunTransactionsToProfitLoss,
    fromEsunTransactionsToProfitLossSummary,
} from './order-mapping';

export type { EsunBridgeHealth } from './adapter';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 委託送出後的等待上限：逾時只代表「不知道」，絕不當成未送出 */
export const ESUN_MUTATION_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 15_000;
/** 委託查詢：bridge 的 refresh=true 可能先等間隔與每分鐘額度（最多約 12 秒）再呼叫 SDK */
export const ESUN_ORDERS_QUERY_TIMEOUT_MS = 30_000;
/** 重新連線：bridge 以目前設定檔重新登入券商（數秒） */
export const ESUN_RECONNECT_TIMEOUT_MS = 30_000;
/** 登入失效（台北換日 token 失效）：bridge 在呼叫 SDK 前回絕（503 not_sent） */
export const ESUN_SESSION_EXPIRED_CODE = 'ESUN_SESSION_EXPIRED';

/** 舊版 bridge（無信封）在呼叫 SDK 之前就回絕的錯誤碼 */
const PRE_DISPATCH_CODES = new Set([
    'INVALID_PARAMS',
    'INVALID_ORDER_PARAMS',
    'INVALID_QTY',
    'AG_INVALID_QUANTITY',
    'AG_INVALID_PRICE_MODIFY',
    'AG0006',
    'AGR0001',
    'AGR0002',
    'NOT_LOGGED_IN',
    ESUN_SESSION_EXPIRED_CODE,
]);

export const ESUN_OUTCOME_UNKNOWN_MESSAGE = '玉山委託送出結果未確認；請求可能已送達券商，請先查詢委託，勿直接重送';

interface EsunBridgeErrorDetail {
    code?: string;
    outcome?: EsunMutationOutcome;
    /** true：委託類請求，依 outcome 標記未送出或結果未知 */
    mutation?: boolean;
    timedOut?: boolean;
    environment?: string;
    result?: unknown;
    /** bridge 建議的重試等待（秒；429 的 retry_after 或 Retry-After） */
    retryAfter?: number;
}

/**
 * bridge 錯誤。旗標只在成立時才出現在物件上（有些呼叫端以 `'mutationNotStarted' in e`
 * 判斷，宣告成 undefined 的欄位會被誤判）。
 */
export class EsunBridgeError extends Error {
    declare readonly mutationNotStarted?: true;
    declare readonly mutationOutcomeUnknown?: true;
    declare readonly orderOutcomeUnknown?: true;
    declare readonly requestTimedOut?: true;
    declare readonly code?: string;
    declare readonly outcome?: EsunMutationOutcome;
    declare readonly httpStatus?: number;
    declare readonly environment?: string;
    declare readonly result?: unknown;
    declare readonly retryAfter?: number;
    constructor(message: string, readonly status: number, detail: EsunBridgeErrorDetail = {}) {
        super(message);
        this.name = 'EsunBridgeError';
        const extra: Record<string, unknown> = {};
        if (detail.code) extra.code = detail.code;
        if (detail.retryAfter !== undefined && Number.isFinite(detail.retryAfter) && detail.retryAfter >= 0) extra.retryAfter = detail.retryAfter;
        if (detail.outcome) extra.outcome = detail.outcome;
        if (detail.environment) extra.environment = detail.environment;
        if (detail.result !== undefined) extra.result = detail.result;
        if (detail.timedOut) extra.requestTimedOut = true;
        if (detail.mutation) {
            if (detail.outcome === 'not_sent' || detail.outcome === 'rejected') extra.mutationNotStarted = true;
            else Object.assign(extra, { mutationOutcomeUnknown: true, orderOutcomeUnknown: true, httpStatus: status });
        }
        Object.assign(this, extra);
    }
}

/** 是否為「確定沒有成立」的玉山 mutation 錯誤（not_sent／rejected） */
export function isEsunNotSent(error: unknown): boolean {
    return !!error && typeof error === 'object' && (error as { mutationNotStarted?: unknown }).mutationNotStarted === true;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function messageOf(data: unknown, fallback: string): string {
    if (isRecord(data)) {
        const text = data.error ?? data.message;
        if (typeof text === 'string' && text.trim()) return text.trim();
    }
    return fallback;
}

function codeOf(data: unknown): string | undefined {
    return isRecord(data) && typeof data.code === 'string' && data.code ? data.code : undefined;
}

/** 登入失效被擋下的委託：訊息一定要說「委託未送出」（bridge 的訊息已含時不重複） */
function notSentText(code: string | undefined, text: string): string {
    if (code !== ESUN_SESSION_EXPIRED_CODE || text.includes('未送出')) return text;
    return `${text}；委託未送出`;
}

/** 429／503 的建議等待秒數：body 的 retry_after 優先，其次 Retry-After 標頭（秒） */
function retryAfterOf(res: Response, data: unknown): number | undefined {
    const raw = isRecord(data) && data.retry_after !== undefined ? data.retry_after : res.headers?.get?.('Retry-After');
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** 舊版 bridge（沒有 outcome 欄位）的錯誤分類 */
function legacyOutcome(status: number, data: unknown): EsunMutationOutcome {
    const code = codeOf(data);
    if (code && PRE_DISPATCH_CODES.has(code)) return 'not_sent';
    if (status >= 400 && status < 500 && status !== 408 && status !== 409) return 'not_sent';
    return 'unknown';
}

export class HttpEsunDriver implements IEsunTradeDriver {
    readonly name = 'http-bridge';

    constructor(
        private readonly base = '',
        private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    ) {}

    private async send(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
        let timedOut = false;
        const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : undefined;
        try {
            const res = await this.fetchImpl(`${this.base}${path}`, {
                method,
                headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller?.signal,
            });
            const text = await res.text();
            let data: unknown = null;
            let parsed = true;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                parsed = false;
            }
            return { res, data, parsed };
        } catch (err) {
            const aborted = timedOut || (err instanceof Error && err.name === 'AbortError');
            throw Object.assign(err instanceof Error ? err : new Error(String(err)), { esunAborted: aborted });
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** 查詢類（GET）與非委託 POST：失敗照一般錯誤，不帶委託結果旗標 */
    private async request<T>(
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
        timeoutMs = QUERY_TIMEOUT_MS,
    ): Promise<T> {
        let reply: Awaited<ReturnType<HttpEsunDriver['send']>>;
        try {
            reply = await this.send(method, path, body, timeoutMs);
        } catch (err) {
            const aborted = (err as { esunAborted?: boolean }).esunAborted === true;
            throw new EsunBridgeError(
                aborted
                    ? `玉山下單服務 (esun-bridge) 回應逾時（${Math.round(timeoutMs / 1000)} 秒）`
                    : `無法連線玉山下單服務 (esun-bridge)：${err instanceof Error ? err.message : String(err)}`,
                0,
                { timedOut: aborted },
            );
        }
        const { res, data, parsed } = reply;
        if (!parsed) throw new EsunBridgeError(`玉山下單服務回應格式錯誤（HTTP ${res.status}）`, res.status);
        if (!res.ok) {
            throw new EsunBridgeError(messageOf(data, `HTTP ${res.status}`), res.status, {
                code: codeOf(data),
                environment: isRecord(data) && typeof data.environment === 'string' ? data.environment : undefined,
                retryAfter: retryAfterOf(res, data),
            });
        }
        return data as T;
    }

    /** 委託類 POST：解析回應信封；只有 not_sent／rejected 才是確定未送出 */
    private async mutate<T>(path: string, body: Json): Promise<T> {
        let reply: Awaited<ReturnType<HttpEsunDriver['send']>>;
        try {
            reply = await this.send('POST', path, body, ESUN_MUTATION_TIMEOUT_MS);
        } catch (err) {
            const aborted = (err as { esunAborted?: boolean }).esunAborted === true;
            const reason = aborted
                ? `等待超過 ${Math.round(ESUN_MUTATION_TIMEOUT_MS / 1000)} 秒`
                : `連線中斷：${err instanceof Error ? err.message : String(err)}`;
            throw new EsunBridgeError(`${ESUN_OUTCOME_UNKNOWN_MESSAGE}（${reason}）`, 0, {
                mutation: true, outcome: 'unknown', timedOut: aborted, code: 'ESUN_OUTCOME_UNKNOWN',
            });
        }
        const { res, data, parsed } = reply;
        if (!parsed) {
            const outcome = legacyOutcome(res.status, null);
            throw new EsunBridgeError(
                outcome === 'not_sent'
                    ? `玉山下單服務拒絕請求（HTTP ${res.status}），未送出`
                    : `${ESUN_OUTCOME_UNKNOWN_MESSAGE}（回應無法解析，HTTP ${res.status}）`,
                res.status,
                { mutation: true, outcome },
            );
        }
        const envelope = isRecord(data) && typeof data.outcome === 'string' ? data : null;
        if (envelope) {
            const outcome = envelope.outcome as string;
            if (outcome === 'accepted' && res.ok) return (envelope.result ?? {}) as T;
            const known: EsunMutationOutcome = outcome === 'not_sent' || outcome === 'rejected' ? outcome : 'unknown';
            const fallback = known === 'unknown' ? ESUN_OUTCOME_UNKNOWN_MESSAGE : `HTTP ${res.status}`;
            const text = messageOf(envelope, fallback);
            throw new EsunBridgeError(
                known === 'unknown' && text !== ESUN_OUTCOME_UNKNOWN_MESSAGE ? `${ESUN_OUTCOME_UNKNOWN_MESSAGE}（${text}）` : notSentText(codeOf(envelope), text),
                res.status,
                {
                    mutation: true,
                    outcome: known,
                    code: codeOf(envelope) ?? (known === 'unknown' ? 'ESUN_OUTCOME_UNKNOWN' : undefined),
                    environment: typeof envelope.environment === 'string' ? envelope.environment : undefined,
                    result: envelope.result,
                },
            );
        }
        if (res.ok) return (data ?? {}) as T; // 舊版 bridge：SDK 原始回傳
        const outcome = legacyOutcome(res.status, data);
        const text = messageOf(data, `HTTP ${res.status}`);
        throw new EsunBridgeError(
            outcome === 'unknown' ? `${ESUN_OUTCOME_UNKNOWN_MESSAGE}（${text}）` : notSentText(codeOf(data), text),
            res.status,
            { mutation: true, outcome, code: codeOf(data) },
        );
    }

    health(timeoutMs?: number): Promise<EsunBridgeHealth> {
        return this.request<EsunBridgeHealth>('GET', '/esun/health', undefined, timeoutMs);
    }

    accounts(timeoutMs?: number): Promise<Account[]> {
        return this.request<Account[]>('GET', '/esun/accounts', undefined, timeoutMs);
    }

    switchEnvironment(env: 'SIMULATION' | 'PRODUCTION'): Promise<{
        ok: boolean;
        environment: 'SIMULATION' | 'PRODUCTION';
        entry: string;
        account?: { broker_id: string; account_id: string } | null;
        message?: string;
        activeConfigFile?: string | null;
        availableEnvironments?: any[];
        configProfiles?: any;
        sessionGeneration?: number;
        error?: string;
    }> {
        // 切換需重新登入券商（數秒）；逾時由 service 視為失敗並以 health 重新同步
        return this.request('POST', '/esun/auth/environment', { environment: env }, 30_000);
    }

    /**
     * 以目前設定檔重新登入券商（台北換日 token 失效後）。不是委託：走一般 request，
     * 失敗（409 進行中、502 登入失敗、503 設定不完整、登入鎖定、423 熔斷鎖住且憑證未變）丟出 EsunBridgeError。
     */
    reconnect(opts?: EsunReconnectOptions): Promise<EsunReconnectResponse> {
        // 只有明確 force:true 才帶旗標；其他情況維持空物件（bridge 依憑證是否變更決定能否重試）
        const body = opts?.force === true ? { force: true } : {};
        return this.request<EsunReconnectResponse>('POST', '/esun/auth/reconnect', body, ESUN_RECONNECT_TIMEOUT_MS);
    }

    placeOrder(payload: EsunOrderPayload, opts?: EsunMutationOptions): Promise<EsunPlaceOrderResponse> {
        return this.mutate<EsunPlaceOrderResponse>('/esun/orders/place', {
            payload,
            ...opts?.guard,
        });
    }

    replacePrice(
        orderNo: string,
        price: number | EsunPriceFlag,
        payload?: EsunOrderMutationPayload,
        opts?: EsunMutationOptions,
    ): Promise<EsunReplaceOrderResponse> {
        return this.mutate<EsunReplaceOrderResponse>('/esun/orders/replace-price', {
            order_no: orderNo,
            price,
            ...(opts?.priceFlag ? { price_flag: opts.priceFlag } : {}),
            ...(payload ? { payload } : {}),
            ...opts?.guard,
        });
    }

    replaceQuantity(
        orderNo: string,
        cancelQuantity: number,
        payload?: EsunOrderMutationPayload,
        opts?: EsunMutationOptions,
    ): Promise<EsunReplaceOrderResponse> {
        return this.mutate<EsunReplaceOrderResponse>('/esun/orders/replace-qty', {
            order_no: orderNo,
            cancel_quantity: cancelQuantity,
            quantity_unit: opts?.unit ?? 'lot',
            ...(payload ? { payload } : {}),
            ...opts?.guard,
        });
    }

    cancelOrder(
        orderNo: string,
        payload?: EsunOrderMutationPayload,
        opts?: EsunMutationOptions,
    ): Promise<EsunReplaceOrderResponse> {
        return this.mutate<EsunReplaceOrderResponse>('/esun/orders/cancel', {
            order_no: orderNo,
            ...(payload ? { payload } : {}),
            ...opts?.guard,
        });
    }

    /**
     * refresh=true 是「向券商重新查詢」的權威讀取：bridge 若標示回傳的是快取
     * （節流、未登入、SDK 失敗時退回快取）就視為讀取失敗，不能當成券商回讀。
     */
    async getOrders(refresh = false): Promise<EsunOrderResult[]> {
        const raw = await this.request<unknown>('GET', `/esun/orders?refresh=${refresh ? 'true' : 'false'}`, undefined, ESUN_ORDERS_QUERY_TIMEOUT_MS);
        if (Array.isArray(raw)) return raw as EsunOrderResult[];
        if (isRecord(raw) && Array.isArray(raw.orders)) {
            const cached = raw.source === 'cache' || raw.refreshed === false;
            if (refresh && cached) {
                const why = typeof raw.reason === 'string' && raw.reason ? `：${raw.reason}` : '';
                throw new EsunBridgeError(`玉山委託未能向券商重新查詢（bridge 回傳快取${why}）`, 200, { code: 'ESUN_REFRESH_SKIPPED' });
            }
            return raw.orders as EsunOrderResult[];
        }
        throw new EsunBridgeError('玉山委託回應格式錯誤', 200);
    }

    /** get_inventories 原始列（bridge 原樣回傳；unit 只隨查詢字串帶上，不影響回傳形狀） */
    async getInventories(unit: 'Common' | 'Share' = 'Common'): Promise<EsunInventoryItem[]> {
        const raw = await this.request<unknown>('GET', `/esun/portfolio/positions?unit=${encodeURIComponent(unit)}`);
        if (!Array.isArray(raw) || raw.some(item => !isRecord(item))) throw new EsunBridgeError('玉山庫存回應格式錯誤', 200);
        return raw as EsunInventoryItem[];
    }

    async getPositions(unit: 'Common' | 'Share' = 'Common'): Promise<StockPosition[]> {
        const raw = await this.getInventories(unit);
        return raw.map((item, idx) => fromEsunInventoryToPosition(item, unit, idx + 1));
    }

    async getBalance(): Promise<AccountBalance> {
        const raw = await this.request<any>('GET', '/esun/portfolio/balance');
        return fromEsunBalance(raw);
    }

    async getBalanceRaw(): Promise<EsunBalanceRaw> {
        const raw = await this.request<unknown>('GET', '/esun/portfolio/balance');
        if (!isRecord(raw)) throw new EsunBridgeError('玉山餘額回應格式錯誤', 200);
        return raw as EsunBalanceRaw;
    }

    async getTradeStatusRaw(): Promise<EsunTradeStatusRaw> {
        const raw = await this.request<unknown>('GET', '/esun/portfolio/trading-limits');
        if (!isRecord(raw)) throw new EsunBridgeError('玉山交易額度回應格式錯誤', 200);
        return raw as EsunTradeStatusRaw;
    }

    async getMarketStatusRaw(): Promise<EsunMarketStatusRaw> {
        const raw = await this.request<unknown>('GET', '/esun/market_status');
        if (!isRecord(raw)) throw new EsunBridgeError('玉山市場狀態回應格式錯誤', 200);
        return raw as EsunMarketStatusRaw;
    }

    /** 交割款與 market_status 同時讀取；market_status 只用來定 T+0，失敗時退回本地推算 */
    async getSettlements(): Promise<Settlement[]> {
        const [raw, status] = await Promise.all([
            this.request<unknown>('GET', '/esun/portfolio/settlements'),
            this.request<EsunMarketStatusRaw>('GET', '/esun/market_status').catch(() => null),
        ]);
        if (!Array.isArray(raw)) throw new EsunBridgeError('玉山交割款回應格式錯誤', 200);
        return fromEsunSettlements(raw as EsunSettlementItem[], isRecord(status) ? status : null);
    }

    private profitLossPath(beginDate: string, endDate: string) {
        const clamped = clampEsunDateRange180Days(beginDate, endDate);
        return {
            clamped,
            path: `/esun/portfolio/profit-loss?begin_date=${encodeURIComponent(clamped.beginDate)}&end_date=${encodeURIComponent(clamped.endDate)}`,
        };
    }

    /** get_transactions_by_date 原始列（區間先裁切到 180 天內） */
    async getTransactions(beginDate: string, endDate: string): Promise<EsunTransactionItem[]> {
        const raw = await this.request<unknown>('GET', this.profitLossPath(beginDate, endDate).path);
        if (!Array.isArray(raw) || raw.some(item => !isRecord(item))) throw new EsunBridgeError('玉山已實現損益回應格式錯誤', 200);
        return raw as EsunTransactionItem[];
    }

    async getProfitLoss(beginDate: string, endDate: string): Promise<StockProfitLoss[]> {
        return fromEsunTransactionsToProfitLoss(await this.getTransactions(beginDate, endDate));
    }

    async getProfitLossSummary(beginDate: string, endDate: string): Promise<ProfitLossSummaryTotal> {
        const { clamped, path } = this.profitLossPath(beginDate, endDate);
        const raw = await this.request<any>('GET', path);
        if (Array.isArray(raw)) {
            return fromEsunTransactionsToProfitLossSummary(raw, clamped.beginDate, clamped.endDate);
        }
        if (raw && typeof raw === 'object' && 'profitloss_sum' in raw && 'total' in raw) {
            return raw as ProfitLossSummaryTotal;
        }
        throw new EsunBridgeError('玉山已實現損益回應格式錯誤', 200);
    }

    async getTradingLimits(): Promise<TradingLimits> {
        const raw = await this.request<any>('GET', '/esun/portfolio/trading-limits');
        return fromEsunTradeStatusToLimits(raw);
    }

    async getStockReserveSummary(): Promise<ReserveStocksSummary> {
        const raw = await this.request<any>('GET', '/esun/portfolio/balance');
        return fromEsunBalanceToReserveSummary(raw);
    }

    getCaExpire(personId?: string): Promise<{ ca_expiretime: string }> {
        return this.request<{ ca_expiretime: string }>(
            'GET',
            `/esun/ca_expiretime${personId ? `?person_id=${encodeURIComponent(personId)}` : ''}`,
        );
    }
}

/** 預設驅動：尚未連上 esun-bridge 時，委託與查詢都明確失敗（絕不假裝成功或回空帳戶）。 */
export class UnavailableEsunDriver implements IEsunTradeDriver {
    readonly name = 'unavailable';

    constructor(private readonly reason = '玉山下單服務 (esun-bridge) 未連線，未送出委託') {}

    private fail(): never {
        throw Object.assign(new Error(this.reason), { mutationNotStarted: true as const });
    }

    private unavailable(): never {
        throw new Error('玉山下單服務 (esun-bridge) 未連線，無法查詢玉山帳務');
    }

    async placeOrder(): Promise<EsunPlaceOrderResponse> { return this.fail(); }
    async replacePrice(): Promise<EsunReplaceOrderResponse> { return this.fail(); }
    async replaceQuantity(): Promise<EsunReplaceOrderResponse> { return this.fail(); }
    async cancelOrder(): Promise<EsunReplaceOrderResponse> { return this.fail(); }
    async getOrders(): Promise<EsunOrderResult[]> { return this.unavailable(); }
    async getPositions(): Promise<StockPosition[]> { return this.unavailable(); }
    async getInventories(): Promise<EsunInventoryItem[]> { return this.unavailable(); }
    async getTransactions(): Promise<EsunTransactionItem[]> { return this.unavailable(); }
    async getBalance(): Promise<AccountBalance> { return this.unavailable(); }
    async getBalanceRaw(): Promise<EsunBalanceRaw> { return this.unavailable(); }
    async getTradeStatusRaw(): Promise<EsunTradeStatusRaw> { return this.unavailable(); }
    async getMarketStatusRaw(): Promise<EsunMarketStatusRaw> { return this.unavailable(); }
    async getSettlements(): Promise<Settlement[]> { return this.unavailable(); }
    async getProfitLoss(): Promise<StockProfitLoss[]> { return this.unavailable(); }
    async getProfitLossSummary(): Promise<ProfitLossSummaryTotal> { return this.unavailable(); }
    async getTradingLimits(): Promise<TradingLimits> { return this.unavailable(); }
    async getStockReserveSummary(): Promise<ReserveStocksSummary> { return this.unavailable(); }
    async getCaExpire(): Promise<{ ca_expiretime: string }> { return this.unavailable(); }
    async switchEnvironment(env: 'SIMULATION' | 'PRODUCTION'): Promise<{
        ok: boolean;
        environment: 'SIMULATION' | 'PRODUCTION';
        entry: string;
        account?: { broker_id: string; account_id: string } | null;
        error?: string;
    }> {
        return {
            ok: false,
            environment: env,
            entry: '',
            error: '玉山下單服務 (esun-bridge) 未連線，無法切換環境',
        };
    }
}
