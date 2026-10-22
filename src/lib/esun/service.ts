// src/lib/esun/service.ts — E.SUN Securities trading and portfolio service manager

import type { ContractBase } from '../types/contract';
import type { OrderResult, OrderStatusInfo, StockOrderReq, Trade } from '../types/order';
import type { Account, AccountBalance, StockPosition } from '../types/portfolio';
import type {
    Settlement,
    StockProfitLoss,
    ProfitLossSummaryTotal,
    TradingLimits,
    ReserveStocksSummary,
} from '../shioaji';
import type { IEsunTradeDriver, EsunBridgeHealth } from './adapter';
import { MockEsunDriver } from './mock-driver';
import {
    fromEsunOrderResponse,
    fromEsunOrderResult,
    isEsunAccount,
    isReservationOrder,
    toEsunOrderPayload,
    validateEsunOrderPriceMutation,
    validateEsunOrderQtyMutation,
    validateEsunStockOrder,
} from './order-mapping';
import { ESUN_BROKER_CODE, ESUN_BROKER_NAME, type EsunClientConfig } from './types';
import { HttpEsunDriver, UnavailableEsunDriver } from './http-driver';

/** esun-bridge 位址：預設同源（由 Vite proxy / Docker 轉發 /esun） */
function bridgeBase(): string {
    try {
        return String((import.meta as any).env?.VITE_ESUN_BRIDGE_BASE ?? '').replace(/\/+$/, '');
    } catch {
        return '';
    }
}

function mutationNotStartedError(message: string): Error & { mutationNotStarted: true } {
    return Object.assign(new Error(message), {
        mutationNotStarted: true as const,
    });
}

function defaultDriver(): IEsunTradeDriver {
    try {
        const env = (import.meta as any).env;
        if (env?.VITE_ESUN_DRIVER === 'mock') return new MockEsunDriver();
    } catch {
        // non-vite environment
    }
    return new UnavailableEsunDriver();
}

export class EsunTradeService {
    private driver: IEsunTradeDriver;
    private accounts: Account[] = [];
    private config: Partial<EsunClientConfig> = {};
    private bridgeProbe: Promise<EsunBridgeHealth | null> | null = null;
    private bridgeHealth: EsunBridgeHealth | null = null;

    constructor(initialDriver?: IEsunTradeDriver) {
        this.driver = initialDriver ?? defaultDriver();
        this.initFromEnv();
    }

    /**
     * 連線 esun-bridge（同源 /esun/*）：成功即改用 HttpEsunDriver 並註冊玉山帳戶。
     * 結果快取，失敗時保留 fail-closed 驅動，不影響永豐流程。
     */
    connectBridge(driver: HttpEsunDriver = new HttpEsunDriver(bridgeBase())): Promise<EsunBridgeHealth | null> {
        if (!this.bridgeProbe) {
            this.bridgeProbe = (async () => {
                try {
                    const health = await driver.health(3_000);
                    const accounts = await driver.accounts(3_000);
                    this.bridgeHealth = health;
                    this.setDriver(driver);
                    for (const a of accounts) this.registerAccount(a);
                    if (!health.configured || health.loginError) {
                        console.warn(
                            '[esun] esun-bridge 已連線但尚未可下單：',
                            health.loginError ?? health.problems.join('；'),
                        );
                    }
                    return health;
                } catch {
                    return null;
                }
            })();
        }
        return this.bridgeProbe;
    }

    getBridgeHealth(): EsunBridgeHealth | null {
        return this.bridgeHealth;
    }

    private initFromEnv(): void {
        try {
            const env = typeof import.meta !== 'undefined' && (import.meta as any).env
                ? (import.meta as any).env
                : undefined;
            const aid = env?.VITE_ESUN_ACCOUNT || env?.VITE_ESUN_AID;
            let brokerId = env?.VITE_ESUN_BROKER_ID;
            let accountId = aid ? String(aid).trim() : '';
            if (accountId && !brokerId) {
                if (accountId.length === 11 && (accountId.startsWith('96') || accountId.startsWith('88'))) {
                    brokerId = accountId.slice(0, 4);
                    accountId = accountId.slice(4);
                } else {
                    brokerId = ESUN_BROKER_CODE;
                }
            }
            const username = env?.VITE_ESUN_USERNAME || ESUN_BROKER_NAME;
            if (accountId) {
                this.registerAccount({
                    account_type: 'S',
                    broker_id: String(brokerId || ESUN_BROKER_CODE),
                    account_id: accountId,
                    signed: true,
                    username: String(username),
                    person_id: '',
                });
            }
        } catch {
            // ignore non-vite environments
        }
    }

    getDriver(): IEsunTradeDriver {
        return this.driver;
    }

    setDriver(driver: IEsunTradeDriver): void {
        this.driver = driver;
    }

    configure(config: Partial<EsunClientConfig>): void {
        this.config = { ...this.config, ...config };
        if (config.aid && !this.accounts.some(a => a.account_id === config.aid)) {
            this.registerAccount({
                account_type: 'S',
                broker_id: ESUN_BROKER_CODE,
                account_id: config.aid,
                signed: true,
                username: ESUN_BROKER_NAME,
                person_id: '',
            });
        }
    }

    getConfig(): Partial<EsunClientConfig> {
        return this.config;
    }

    registerAccount(account: Account): void {
        if (!this.accounts.some(a => a.broker_id === account.broker_id && a.account_id === account.account_id)) {
            this.accounts.push(account);
        }
    }

    clearAccounts(): void {
        this.accounts = [];
    }

    getAccounts(): Account[] {
        return [...this.accounts];
    }

    /** 查詢憑證效期 */
    async fetchCaExpire(personId?: string): Promise<string> {
        if (!this.driver.getCaExpire) return '';
        const res = await this.driver.getCaExpire(personId);
        return res?.ca_expiretime || '';
    }

    /** 送出玉山證券現貨委託 */
    async placeStockOrder(
        contract: ContractBase,
        order: StockOrderReq,
        account: Account,
        opts?: { beforeDispatch?: () => void; onResponse?: (res: Response) => void },
    ): Promise<Trade> {
        if (!isEsunAccount(account)) {
            throw mutationNotStartedError('指定的帳戶非玉山證券帳戶');
        }

        const problem = validateEsunStockOrder(contract, order);
        if (problem) {
            throw mutationNotStartedError(problem);
        }

        opts?.beforeDispatch?.();

        const payload = toEsunOrderPayload(contract, order);
        const res = await this.driver.placeOrder(payload);

        if (opts?.onResponse) {
            try {
                opts.onResponse(
                    new Response(JSON.stringify(res), {
                        status: res.retCode === '000000' || res.retCode === '0' || !res.retCode ? 200 : 400,
                        headers: { 'Content-Type': 'application/json' },
                    }),
                );
            } catch {
                // Ignore mock response wrapper error
            }
        }

        if (res.retCode && res.retCode !== '000000' && res.retCode !== '0') {
            throw mutationNotStartedError(`玉山證券下單失敗 [${res.retCode}]：${res.retMsg}`);
        }

        return fromEsunOrderResponse(res, contract, order, account);
    }

    /**
     * 取消玉山證券委託
     * 支援 signatures:
     * - cancelOrder(tradeId, account, opts?)
     * - cancelOrder(contract, order, account, opts?)
     * - cancelOrder(trade, account, opts?)
     */
    async cancelOrder(
        arg1: ContractBase | string | Trade,
        arg2: OrderResult | Account,
        arg3?: Account | { beforeDispatch?: () => void },
        arg4?: { beforeDispatch?: () => void },
    ): Promise<Trade> {
        let contract: ContractBase;
        let order: OrderResult;
        let account: Account;
        let opts: { beforeDispatch?: () => void } | undefined;

        if (typeof arg1 === 'string') {
            const tradeId = arg1;
            account = arg2 as Account;
            opts = arg3 as { beforeDispatch?: () => void } | undefined;
            contract = {
                code: '',
                security_type: 'STK',
                exchange: 'TSE',
                target_code: null,
            };
            order = {
                id: tradeId,
                seqno: tradeId,
                ordno: tradeId,
                action: 'Buy',
                price: 0,
                quantity: 0,
            };
        } else if ('contract' in arg1 && 'order' in arg1) {
            const trade = arg1 as Trade;
            contract = trade.contract;
            order = trade.order;
            account = arg2 as Account;
            opts = arg3 as { beforeDispatch?: () => void } | undefined;
        } else {
            contract = arg1 as ContractBase;
            order = arg2 as OrderResult;
            account = arg3 as Account;
            opts = arg4;
        }

        if (!isEsunAccount(account)) {
            throw mutationNotStartedError('指定的帳戶非玉山證券帳戶');
        }

        const ordNo = order.ordno || order.seqno || order.id;
        if (!ordNo) {
            throw mutationNotStartedError('缺少玉山證券委託編號，無法刪單');
        }

        opts?.beforeDispatch?.();

        const res = await this.driver.cancelOrder(ordNo, {
            stockNo: contract.code,
        });

        if (res.retCode && res.retCode !== '000000' && res.retCode !== '0') {
            throw new Error(`玉山證券刪單失敗 [${res.retCode}]：${res.retMsg}`);
        }

        const statusInfo: OrderStatusInfo = {
            id: order.id,
            status: 'Cancelled',
            status_code: res.retCode ?? res.ret_code ?? '000000',
            msg: res.retMsg ?? res.ret_msg ?? '已刪單',
            order_quantity: order.quantity,
            deal_quantity: 0,
            cancel_quantity: order.quantity,
            modified_price: 0,
            deals: [],
        };

        return {
            contract,
            order,
            status: statusInfo,
        };
    }

    /**
     * 修改委託價格
     * 支援 signatures:
     * - updateOrderPrice(tradeId, price, account, opts?)
     * - updateOrderPrice(contract, order, price, account, opts?)
     * - updateOrderPrice(trade, price, account, opts?)
     */
    async updateOrderPrice(
        arg1: ContractBase | string | Trade,
        arg2: OrderResult | number,
        arg3: number | Account,
        arg4?: Account | { beforeDispatch?: () => void },
        arg5?: { beforeDispatch?: () => void },
    ): Promise<Trade> {
        let contract: ContractBase;
        let order: OrderResult;
        let newPrice: number;
        let account: Account;
        let opts: { beforeDispatch?: () => void } | undefined;
        let fullTrade: Trade | null = null;

        if (typeof arg1 === 'string') {
            const tradeId = arg1;
            newPrice = arg2 as number;
            account = arg3 as Account;
            opts = arg4 as { beforeDispatch?: () => void } | undefined;
            contract = {
                code: '',
                security_type: 'STK',
                exchange: 'TSE',
                target_code: null,
            };
            order = {
                id: tradeId,
                seqno: tradeId,
                ordno: tradeId,
                action: 'Buy',
                price: newPrice,
                quantity: 0,
                order_type: 'ROD',
                price_type: 'LMT',
            };
        } else if ('contract' in arg1 && 'order' in arg1) {
            fullTrade = arg1 as Trade;
            contract = fullTrade.contract;
            order = fullTrade.order;
            newPrice = arg2 as number;
            account = arg3 as Account;
            opts = arg4 as { beforeDispatch?: () => void } | undefined;
        } else {
            contract = arg1 as ContractBase;
            order = arg2 as OrderResult;
            newPrice = arg3 as number;
            account = arg4 as Account;
            opts = arg5;
        }

        if (!isEsunAccount(account)) {
            throw mutationNotStartedError('指定的帳戶非玉山證券帳戶');
        }

        const ordNo = order.ordno || order.seqno || order.id;
        if (!ordNo) {
            throw mutationNotStartedError('缺少玉山證券委託編號，無法改價');
        }

        if (fullTrade) {
            const validationErr = validateEsunOrderPriceMutation(fullTrade, newPrice);
            if (validationErr) {
                throw mutationNotStartedError(validationErr);
            }
        } else {
            if (order.order_type && order.order_type !== 'ROD') {
                throw mutationNotStartedError('玉山證券僅支援 ROD 限價單改價');
            }
            if (order.price_type && order.price_type !== 'LMT') {
                throw mutationNotStartedError('玉山證券僅支援 ROD 限價單改價');
            }
            if (!Number.isFinite(newPrice) || newPrice <= 0) {
                throw mutationNotStartedError('改價需要大於 0 的有效價格');
            }
        }

        opts?.beforeDispatch?.();

        const res = await this.driver.replacePrice(ordNo, newPrice, {
            stockNo: contract.code,
        });

        if (res.retCode && res.retCode !== '000000' && res.retCode !== '0') {
            throw new Error(`玉山證券改價失敗 [${res.retCode}]：${res.retMsg}`);
        }

        return {
            contract,
            order: { ...order, price: newPrice },
            status: {
                id: order.id,
                status: 'Submitted',
                status_code: res.retCode ?? res.ret_code ?? '000000',
                msg: res.retMsg ?? res.ret_msg ?? '改價成功',
                order_quantity: order.quantity,
                deal_quantity: 0,
                cancel_quantity: 0,
                modified_price: newPrice,
                deals: [],
            },
        };
    }

    /**
     * 修改委託數量（減量）
     * 支援 signatures:
     * - updateOrderQty(tradeId, quantity, account, opts?)
     * - updateOrderQty(contract, order, quantity, account, opts?)
     * - updateOrderQty(trade, quantity, account, opts?)
     */
    async updateOrderQty(
        arg1: ContractBase | string | Trade,
        arg2: OrderResult | number,
        arg3: number | Account,
        arg4?: Account | { beforeDispatch?: () => void },
        arg5?: { beforeDispatch?: () => void },
    ): Promise<Trade> {
        let contract: ContractBase;
        let order: OrderResult;
        let newQty: number;
        let account: Account;
        let opts: { beforeDispatch?: () => void } | undefined;
        let fullTrade: Trade | null = null;

        if (typeof arg1 === 'string') {
            const tradeId = arg1;
            newQty = arg2 as number;
            account = arg3 as Account;
            opts = arg4 as { beforeDispatch?: () => void } | undefined;
            contract = {
                code: '',
                security_type: 'STK',
                exchange: 'TSE',
                target_code: null,
            };
            order = {
                id: tradeId,
                seqno: tradeId,
                ordno: tradeId,
                action: 'Buy',
                price: 0,
                quantity: newQty,
            };
        } else if ('contract' in arg1 && 'order' in arg1) {
            fullTrade = arg1 as Trade;
            contract = fullTrade.contract;
            order = fullTrade.order;
            newQty = arg2 as number;
            account = arg3 as Account;
            opts = arg4 as { beforeDispatch?: () => void } | undefined;
        } else {
            contract = arg1 as ContractBase;
            order = arg2 as OrderResult;
            newQty = arg3 as number;
            account = arg4 as Account;
            opts = arg5;
        }

        if (!isEsunAccount(account)) {
            throw mutationNotStartedError('指定的帳戶非玉山證券帳戶');
        }

        const ordNo = order.ordno || order.seqno || order.id;
        if (!ordNo) {
            throw mutationNotStartedError('缺少玉山證券委託編號，無法改量');
        }

        if (fullTrade) {
            const validationErr = validateEsunOrderQtyMutation(fullTrade, newQty);
            if (validationErr) {
                throw mutationNotStartedError(validationErr);
            }
        } else {
            if (!Number.isSafeInteger(newQty) || newQty <= 0) {
                throw mutationNotStartedError('改量必須為正整數');
            }
        }

        opts?.beforeDispatch?.();

        const res = await this.driver.replaceQuantity(ordNo, newQty, {
            stockNo: contract.code,
            quantity: order.quantity,
        });

        if (res.retCode && res.retCode !== '000000' && res.retCode !== '0') {
            throw new Error(`玉山證券改量失敗 [${res.retCode}]：${res.retMsg}`);
        }

        return {
            contract,
            order: { ...order, quantity: newQty },
            status: {
                id: order.id,
                status: 'Submitted',
                status_code: res.retCode ?? res.ret_code ?? '000000',
                msg: res.retMsg ?? res.ret_msg ?? '改量成功',
                order_quantity: newQty,
                deal_quantity: 0,
                cancel_quantity: Math.max(0, order.quantity - newQty),
                modified_price: 0,
                deals: [],
            },
        };
    }

    /** 查詢玉山委託 */
    async fetchTrades(account: Account, refresh = false): Promise<Trade[]> {
        if (!isEsunAccount(account)) return [];
        if (!this.driver.getOrders) return [];
        const results = await this.driver.getOrders(refresh);
        return results.map(r => fromEsunOrderResult(r, account));
    }

    /** 查詢持股庫存與未實現損益 */
    async fetchPositions(account: Account, unit: 'Common' | 'Share' = 'Common'): Promise<StockPosition[]> {
        if (!isEsunAccount(account)) {
            throw new Error('指定的帳戶非玉山證券帳戶');
        }
        if (!this.driver.getPositions) return [];
        return this.driver.getPositions(unit);
    }

    /** 查詢銀行餘額與圈存 */
    async fetchAccountBalance(account: Account): Promise<AccountBalance> {
        if (!isEsunAccount(account)) {
            throw new Error('指定的帳戶非玉山證券帳戶');
        }
        if (!this.driver.getBalance) {
            return { acc_balance: 0, date: '', errmsg: '未實作 getBalance' };
        }
        return this.driver.getBalance();
    }

    /** 查詢 T+2 交割款 */
    async fetchSettlements(account: Account): Promise<Settlement[]> {
        if (!isEsunAccount(account)) {
            throw new Error('指定的帳戶非玉山證券帳戶');
        }
        if (!this.driver.getSettlements) return [];
        return this.driver.getSettlements();
    }

    /** 查詢歷史成交與已實現損益 */
    async fetchProfitLoss(
        account: Account,
        beginDate = '',
        endDate = '',
    ): Promise<StockProfitLoss[]> {
        if (!isEsunAccount(account)) {
            throw new Error('指定的帳戶非玉山證券帳戶');
        }
        if (!this.driver.getProfitLoss) return [];
        return this.driver.getProfitLoss(beginDate, endDate);
    }

    /** 查詢歷史成交與已實現損益彙總 */
    async fetchProfitLossSummary(
        account: Account,
        beginDate = '',
        endDate = '',
    ): Promise<ProfitLossSummaryTotal> {
        if (!isEsunAccount(account)) {
            throw new Error('指定的帳戶非玉山證券帳戶');
        }
        if (!this.driver.getProfitLossSummary) {
            return {
                profitloss_sum: [],
                total: { entry_amount: 0, cover_amount: 0, quantity: 0, buy_cost: 0, sell_cost: 0, pnl: 0, pr_ratio: 0 },
            };
        }
        return this.driver.getProfitLossSummary(beginDate, endDate);
    }

    /** 查詢交易額度與信用權限 */
    async fetchTradingLimits(account: Account): Promise<TradingLimits> {
        if (!isEsunAccount(account)) {
            throw new Error('指定的帳戶非玉山證券帳戶');
        }
        if (!this.driver.getTradingLimits) {
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
        return this.driver.getTradingLimits();
    }

    /** 查詢圈存摘要 */
    async fetchStockReserveSummary(account: Account): Promise<ReserveStocksSummary> {
        if (!isEsunAccount(account)) {
            throw new Error('指定的帳戶非玉山證券帳戶');
        }
        if (!this.driver.getStockReserveSummary) {
            return { stocks: [], account };
        }
        return this.driver.getStockReserveSummary();
    }
}

export const esunTradeService = new EsunTradeService();
