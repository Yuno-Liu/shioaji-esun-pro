// src/lib/esun/http-driver.ts — Browser driver: forwards E.SUN orders and portfolio queries
// to the Python Sidecar / HTTP bridge over same-origin /esun/* JSON endpoints.

import type { IEsunTradeDriver, EsunBridgeHealth } from './adapter';
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

export class EsunBridgeError extends Error {
    readonly mutationNotStarted?: true;
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = 'EsunBridgeError';
        this.mutationNotStarted = true;
    }
}

export class HttpEsunDriver implements IEsunTradeDriver {
    readonly name = 'http-bridge';

    constructor(
        private readonly base = '',
        private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    ) {}

    private async request<T>(
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
        timeoutMs = 15_000,
    ): Promise<T> {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
        let res: Response;
        try {
            res = await this.fetchImpl(`${this.base}${path}`, {
                method,
                headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller?.signal,
            });
        } catch (err) {
            throw new EsunBridgeError(
                `無法連線玉山下單服務 (esun-bridge)：${err instanceof Error ? err.message : String(err)}`,
                0,
            );
        } finally {
            if (timer) clearTimeout(timer);
        }

        const text = await res.text();
        let data: unknown = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            throw new EsunBridgeError(`玉山下單服務回應格式錯誤（HTTP ${res.status}）`, res.status);
        }
        if (!res.ok) {
            const msg = (data as { error?: string; message?: string } | null)?.error
                ?? (data as { error?: string; message?: string } | null)?.message
                ?? `HTTP ${res.status}`;
            throw new EsunBridgeError(msg, res.status);
        }
        return data as T;
    }

    health(timeoutMs?: number): Promise<EsunBridgeHealth> {
        return this.request<EsunBridgeHealth>('GET', '/esun/health', undefined, timeoutMs);
    }

    accounts(timeoutMs?: number): Promise<Account[]> {
        return this.request<Account[]>('GET', '/esun/accounts', undefined, timeoutMs);
    }

    placeOrder(payload: EsunOrderPayload): Promise<EsunPlaceOrderResponse> {
        return this.request<EsunPlaceOrderResponse>('POST', '/esun/orders/place', { payload });
    }

    replacePrice(
        orderNo: string,
        price: number | EsunPriceFlag,
        payload?: Partial<EsunOrderPayload>,
    ): Promise<EsunReplaceOrderResponse> {
        return this.request<EsunReplaceOrderResponse>('POST', '/esun/orders/replace-price', {
            orderNo,
            price,
            payload,
        });
    }

    replaceQuantity(
        orderNo: string,
        quantity: number,
        payload?: Partial<EsunOrderPayload>,
    ): Promise<EsunReplaceOrderResponse> {
        return this.request<EsunReplaceOrderResponse>('POST', '/esun/orders/replace-qty', {
            orderNo,
            quantity,
            payload,
        });
    }

    cancelOrder(
        orderNo: string,
        payload?: Partial<EsunOrderPayload>,
    ): Promise<EsunReplaceOrderResponse> {
        return this.request<EsunReplaceOrderResponse>('POST', '/esun/orders/cancel', {
            orderNo,
            payload,
        });
    }

    getOrders(refresh = false): Promise<EsunOrderResult[]> {
        return this.request<EsunOrderResult[]>('GET', `/esun/orders?refresh=${Boolean(refresh)}`);
    }

    async getPositions(unit: 'Common' | 'Share' = 'Common'): Promise<StockPosition[]> {
        const raw = await this.request<any[]>('GET', `/esun/portfolio/positions?unit=${unit}`);
        if (!Array.isArray(raw)) return [];
        return raw.map((item, idx) => fromEsunInventoryToPosition(item, unit, idx + 1));
    }

    async getBalance(): Promise<AccountBalance> {
        const raw = await this.request<any>('GET', '/esun/portfolio/balance');
        return fromEsunBalance(raw);
    }

    async getSettlements(): Promise<Settlement[]> {
        const raw = await this.request<any[]>('GET', '/esun/portfolio/settlements');
        return fromEsunSettlements(raw);
    }

    async getProfitLoss(beginDate: string, endDate: string): Promise<StockProfitLoss[]> {
        const clamped = clampEsunDateRange180Days(beginDate, endDate);
        const raw = await this.request<any[]>(
            'GET',
            `/esun/portfolio/profit-loss?begin_date=${clamped.beginDate}&end_date=${clamped.endDate}`,
        );
        return fromEsunTransactionsToProfitLoss(raw);
    }

    async getProfitLossSummary(beginDate: string, endDate: string): Promise<ProfitLossSummaryTotal> {
        const clamped = clampEsunDateRange180Days(beginDate, endDate);
        const raw = await this.request<any>(
            'GET',
            `/esun/portfolio/profit-loss?begin_date=${clamped.beginDate}&end_date=${clamped.endDate}`,
        );
        if (Array.isArray(raw)) {
            return fromEsunTransactionsToProfitLossSummary(raw, clamped.beginDate, clamped.endDate);
        }
        if (raw && typeof raw === 'object' && 'profitloss_sum' in raw && 'total' in raw) {
            return raw as ProfitLossSummaryTotal;
        }
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

    async getTradingLimits(): Promise<TradingLimits> {
        const raw = await this.request<any>('GET', '/esun/portfolio/trading-limits');
        return fromEsunTradeStatusToLimits(raw);
    }

    async getStockReserveSummary(): Promise<ReserveStocksSummary> {
        const raw = await this.request<any>('GET', '/esun/portfolio/balance');
        return fromEsunBalanceToReserveSummary(raw);
    }

    async getCaExpire(personId?: string): Promise<{ ca_expiretime: string }> {
        try {
            const res = await this.request<{ ca_expiretime: string }>(
                'GET',
                `/esun/ca_expiretime${personId ? `?person_id=${personId}` : ''}`,
            );
            return res;
        } catch {
            return { ca_expiretime: '' };
        }
    }
}

/** 預設驅動：尚未連上 esun-bridge 時，任何委託都明確失敗（絕不假裝成功）。 */
export class UnavailableEsunDriver implements IEsunTradeDriver {
    readonly name = 'unavailable';

    constructor(private readonly reason = '玉山下單服務 (esun-bridge) 未連線，未送出委託') {}

    private fail(): never {
        throw Object.assign(new Error(this.reason), { mutationNotStarted: true as const });
    }

    async placeOrder(): Promise<EsunPlaceOrderResponse> { return this.fail(); }
    async replacePrice(): Promise<EsunReplaceOrderResponse> { return this.fail(); }
    async replaceQuantity(): Promise<EsunReplaceOrderResponse> { return this.fail(); }
    async cancelOrder(): Promise<EsunReplaceOrderResponse> { return this.fail(); }
    async getOrders(): Promise<EsunOrderResult[]> { return []; }
    async getPositions(): Promise<StockPosition[]> { return []; }
    async getBalance(): Promise<AccountBalance> { return { acc_balance: 0, date: '', errmsg: this.reason }; }
    async getSettlements(): Promise<Settlement[]> { return []; }
    async getProfitLoss(): Promise<StockProfitLoss[]> { return []; }
    async getProfitLossSummary(): Promise<ProfitLossSummaryTotal> {
        return {
            profitloss_sum: [],
            total: { entry_amount: 0, cover_amount: 0, quantity: 0, buy_cost: 0, sell_cost: 0, pnl: 0, pr_ratio: 0 },
        };
    }
    async getTradingLimits(): Promise<TradingLimits> {
        return {
            trading_limit: 0,
            trading_used: 0,
            trading_available: 0,
            margin_limit: 0,
            margin_used: 0,
            margin_available: 0,
            short_limit: 0,
            short_used: 0,
            short_available: 0,
        };
    }
    async getStockReserveSummary(): Promise<ReserveStocksSummary> {
        return { stocks: [], account: { broker_id: '8840', account_id: '', account_type: 'S', signed: false, username: '', person_id: '' } };
    }
    async getCaExpire(): Promise<{ ca_expiretime: string }> { return { ca_expiretime: '' }; }
}
