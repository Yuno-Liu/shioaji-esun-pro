// src/lib/esun/mock-driver.ts — Mock driver for testing and simulation
//
// 回傳形狀比照 esun_trade SDK 實際欄位（snake_case；sdk.py 以 order_result["ap_code"]
// 等鍵存取）：零股／興櫃（ap_code 3、4、5）的 *_qty 為「張」的小數、*_qty_share 為股數。
// 環境綁定與 bridge 相同：expected_environment 不符時回 409（確定未送出）。

import type { IEsunTradeDriver, EsunBridgeHealth, EsunMutationOptions, EsunReconnectResponse } from './adapter';
import type {
    EsunBalanceRaw,
    EsunInventoryItem,
    EsunMarketStatusRaw,
    EsunTradeStatusRaw,
    EsunTransactionItem,
    EsunOrderMutationPayload,
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
import { ESUN_BROKER_CODE, ESUN_BROKER_NAME, ESUN_PRODUCTION_ENTRY, ESUN_SIMULATION_ENTRY } from './types';
import { EsunBridgeError } from './http-driver';
import { fromEsunInventoryToPosition } from './order-mapping';

/** 測試用的佔位帳號（非真實帳號） */
export const MOCK_ESUN_ACCOUNT_ID = '1234567';

type MockOrder = EsunOrderPayload & { ordNo: string; celQty: number; matQty: number; orgQty: number };

const isShareUnit = (apCode: string) => apCode === '3' || apCode === '4' || apCode === '5';

export class MockEsunDriver implements IEsunTradeDriver {
    readonly name = 'mock';

    private seq = 1;
    private orders = new Map<string, MockOrder>();
    public simulateFailure: string | null = null;
    private environment: 'SIMULATION' | 'PRODUCTION' = 'SIMULATION';
    private generation = 1;
    /** 模擬券商 token 失效（台北換日）：health 回 loggedIn:false、sessionExpired:true */
    private sessionExpiredAt: string | null = null;
    /** 下一次 reconnect 失敗的錯誤（測試用；null = 成功） */
    public reconnectFailure: string | null = null;
    /** reconnect 呼叫次數（測試檢查用） */
    public reconnectCalls = 0;
    /** 最後一筆委託類請求帶的預期環境／帳號（測試檢查用） */
    public lastGuard: EsunMutationOptions['guard'] | undefined;
    /** 最後一筆減量請求的數量單位（測試檢查用） */
    public lastUnit: EsunMutationOptions['unit'] | undefined;

    private customPositions: StockPosition[] | null = null;
    private customBalance: AccountBalance | null = null;
    private customSettlements: Settlement[] | null = null;
    private customProfitLoss: StockProfitLoss[] | null = null;
    private customTradingLimits: TradingLimits | null = null;
    private customInventories: EsunInventoryItem[] | null = null;
    private customTransactions: EsunTransactionItem[] | null = null;

    setPositions(positions: StockPosition[]): void {
        this.customPositions = positions;
    }

    /** 自訂 get_inventories 原始列（service.fetchPositions 走這條） */
    setInventories(rows: EsunInventoryItem[] | null): void {
        this.customInventories = rows;
    }

    /** 自訂 get_transactions_by_date 原始列（service.fetchProfitLoss 走這條） */
    setTransactions(rows: EsunTransactionItem[] | null): void {
        this.customTransactions = rows;
    }

    setBalance(balance: AccountBalance): void {
        this.customBalance = balance;
    }

    setSettlements(settlements: Settlement[]): void {
        this.customSettlements = settlements;
    }

    setProfitLoss(profitLoss: StockProfitLoss[]): void {
        this.customProfitLoss = profitLoss;
    }

    setTradingLimits(limits: TradingLimits): void {
        this.customTradingLimits = limits;
    }

    /** 模擬另一個視窗把 bridge 切到別的環境（不經過這個 service） */
    setBridgeEnvironment(env: 'SIMULATION' | 'PRODUCTION'): void {
        this.environment = env;
        this.generation += 1;
    }

    /** 模擬券商 token 失效（測試用） */
    expireSession(at = '2026-01-02T00:00:05+08:00'): void {
        this.sessionExpiredAt = at;
    }

    /** 與 bridge 相同：重新登入成功換新的 session 代次；失敗保留目前 session */
    async reconnect(): Promise<EsunReconnectResponse> {
        this.reconnectCalls += 1;
        if (this.reconnectFailure) {
            throw new EsunBridgeError(this.reconnectFailure, 502, { code: 'LOGIN_FAILED' });
        }
        this.sessionExpiredAt = null;
        this.generation += 1;
        return {
            ok: true,
            message: '玉山證券登入成功',
            account: { broker_id: ESUN_BROKER_CODE, account_id: MOCK_ESUN_ACCOUNT_ID },
            environment: this.environment,
            sessionGeneration: this.generation,
        };
    }

    /** 模擬券商端成交（測試用） */
    fill(orderNo: string, quantity: number): void {
        const existing = this.orders.get(orderNo);
        if (existing) existing.matQty = Math.min(existing.orgQty - existing.celQty, existing.matQty + quantity);
    }

    async health(): Promise<EsunBridgeHealth> {
        return {
            ok: true,
            configured: true,
            problems: [],
            environment: this.environment,
            simulation: this.environment === 'SIMULATION',
            entry: this.environment === 'SIMULATION' ? ESUN_SIMULATION_ENTRY : ESUN_PRODUCTION_ENTRY,
            account: { broker_id: ESUN_BROKER_CODE, account_id: MOCK_ESUN_ACCOUNT_ID },
            loggedIn: this.sessionExpiredAt === null,
            loginError: this.sessionExpiredAt === null ? null : '玉山登入已於換日失效，請以「重新連線」手動重新登入',
            sessionGeneration: this.generation,
            ...(this.sessionExpiredAt === null ? {} : { sessionExpired: true, sessionExpiredAt: this.sessionExpiredAt }),
        };
    }

    async switchEnvironment(env: 'SIMULATION' | 'PRODUCTION'): Promise<{
        ok: boolean;
        environment: 'SIMULATION' | 'PRODUCTION';
        entry: string;
        account?: { broker_id: string; account_id: string } | null;
        sessionGeneration?: number;
    }> {
        this.environment = env;
        this.generation += 1;
        return {
            ok: true,
            environment: env,
            entry: env === 'SIMULATION' ? ESUN_SIMULATION_ENTRY : ESUN_PRODUCTION_ENTRY,
            account: { broker_id: ESUN_BROKER_CODE, account_id: MOCK_ESUN_ACCOUNT_ID },
            sessionGeneration: this.generation,
        };
    }

    async accounts(): Promise<Account[]> {
        return [
            {
                account_type: 'S',
                broker_id: ESUN_BROKER_CODE,
                account_id: MOCK_ESUN_ACCOUNT_ID,
                signed: true,
                username: ESUN_BROKER_NAME,
                person_id: 'A123456789',
            },
        ];
    }

    /** 與 bridge 相同的前置檢查：環境不符 → 409 not_sent */
    private checkGuard(opts?: EsunMutationOptions): void {
        this.lastGuard = opts?.guard;
        if (this.sessionExpiredAt !== null) {
            throw new EsunBridgeError('玉山登入已失效（換日），請以「重新連線」手動重新登入；委託未送出', 503, {
                mutation: true, outcome: 'not_sent', code: 'ESUN_SESSION_EXPIRED', environment: this.environment,
            });
        }
        const expected = opts?.guard?.expected_environment;
        if (expected && expected !== this.environment) {
            throw new EsunBridgeError(`玉山目前為 ${this.environment}，與預期環境 ${expected} 不符`, 409, {
                mutation: true, outcome: 'not_sent', code: 'ESUN_ENV_MISMATCH', environment: this.environment,
            });
        }
    }

    private failure(time: string): EsunReplaceOrderResponse {
        return { ret_code: '999999', ret_msg: this.simulateFailure ?? '', ord_date: '20261023', ord_time: time };
    }

    async placeOrder(payload: EsunOrderPayload, opts?: EsunMutationOptions): Promise<EsunPlaceOrderResponse> {
        this.checkGuard(opts);
        if (this.simulateFailure) {
            return {
                ret_code: '999999',
                ret_msg: this.simulateFailure,
                work_date: '20261023',
                ord_type: '0',
                ord_no: '',
                ord_date: '20261023',
                ord_time: '090000',
            };
        }

        const ordNo = `E${String(this.seq++).padStart(5, '0')}`;
        this.orders.set(ordNo, {
            ...payload,
            ordNo,
            orgQty: payload.quantity,
            celQty: 0,
            matQty: 0,
        });

        return {
            ret_code: '000000',
            ret_msg: '委託成功',
            work_date: '20261023',
            ord_type: '0',
            ord_no: ordNo,
            ord_date: '20261023',
            ord_time: '090000',
        };
    }

    async replacePrice(
        orderNo: string,
        price: number | EsunPriceFlag,
        _payload?: EsunOrderMutationPayload,
        opts?: EsunMutationOptions,
    ): Promise<EsunReplaceOrderResponse> {
        this.checkGuard(opts);
        if (this.simulateFailure) return this.failure('090100');

        const existing = this.orders.get(orderNo);
        if (existing && typeof price === 'number') {
            existing.price = price;
        }

        return {
            ret_code: '000000',
            ret_msg: '改價成功',
            ord_date: '20261023',
            ord_time: '090100',
        };
    }

    /** 減量：cancelQuantity 為減少量（SDK cancel_order(cel_qty=…) 語意） */
    async replaceQuantity(
        orderNo: string,
        cancelQuantity: number,
        _payload?: EsunOrderMutationPayload,
        opts?: EsunMutationOptions,
    ): Promise<EsunReplaceOrderResponse> {
        this.checkGuard(opts);
        this.lastUnit = opts?.unit;
        if (this.simulateFailure) return this.failure('090200');

        const existing = this.orders.get(orderNo);
        if (existing) {
            const remaining = existing.orgQty - existing.matQty - existing.celQty;
            if (!(cancelQuantity > 0) || cancelQuantity > remaining) {
                throw new EsunBridgeError(`減少數量 ${cancelQuantity} 超過剩餘量 ${remaining}`, 400, {
                    mutation: true, outcome: 'not_sent', code: 'INVALID_QTY',
                });
            }
            existing.celQty += cancelQuantity;
        }

        return {
            ret_code: '000000',
            ret_msg: '改量成功',
            ord_date: '20261023',
            ord_time: '090200',
        };
    }

    async cancelOrder(orderNo: string, _payload?: EsunOrderMutationPayload, opts?: EsunMutationOptions): Promise<EsunReplaceOrderResponse> {
        this.checkGuard(opts);
        if (this.simulateFailure) return this.failure('090300');

        const existing = this.orders.get(orderNo);
        if (existing) {
            existing.celQty = existing.orgQty - existing.matQty;
        }

        return {
            ret_code: '000000',
            ret_msg: '刪單成功',
            ord_date: '20261023',
            ord_time: '090300',
        };
    }

    async getOrders(): Promise<EsunOrderResult[]> {
        const out: EsunOrderResult[] = [];
        for (const o of this.orders.values()) {
            // App 數量：整股為張、零股為股；SDK 的 *_qty 一律為張（零股為小數）
            const share = isShareUnit(o.apCode);
            const lots = (n: number) => (share ? n / 1000 : n);
            const shares = (n: number) => (share ? n : n * 1000);
            out.push({
                work_date: '20261023',
                ord_date: '20261023',
                ord_time: '090000000',
                ord_status: '2',
                ord_no: o.ordNo,
                pre_ord_no: '',
                stock_no: o.stockNo,
                buy_sell: o.buySell,
                ap_code: o.apCode,
                price_flag: o.priceFlag,
                bs_flag: o.bsFlag,
                trade: o.trade,
                od_price: o.price,
                org_qty: lots(o.orgQty),
                org_qty_share: shares(o.orgQty),
                mat_qty: lots(o.matQty),
                mat_qty_share: shares(o.matQty),
                cel_qty: lots(o.celQty),
                cel_qty_share: shares(o.celQty),
                celable: o.celQty + o.matQty < o.orgQty ? '1' : '2',
                err_code: '00000000',
                err_msg: '',
                avg_price: o.matQty > 0 ? o.price : 0,
                user_def: o.userDef || '',
            });
        }
        return out;
    }

    /** get_inventories 原始列（stk_sums 形狀；數值為字串，與 SDK 相同）。setPositions 只影響 getPositions */
    async getInventories(): Promise<EsunInventoryItem[]> {
        if (this.customInventories) return this.customInventories;
        return [{
            ap_code: '',
            stk_no: '2884',
            stk_na: '玉山金',
            s_type: 'H',
            trade: '0',
            cost_qty: '2000',
            cost_sum: '-50071',
            price_avg: '25.00',
            price_evn: '25.11',
            price_mkt: '26.50',
            price_now: '26.50',
            price_qty_sum: '50000',
            make_a_sum: '3000',
            make_a_per: '5.99',
            rec_va_sum: '52800',
            value_mkt: '53000',
            value_now: '53000',
            qty_b: '0',
            qty_bm: '0',
            qty_s: '0',
            qty_sm: '0',
            qty_c: '0',
            qty_l: '2000',
            stk_dats: [],
        }];
    }

    async getPositions(unit: 'Common' | 'Share' = 'Common'): Promise<StockPosition[]> {
        if (this.customPositions) {
            return this.customPositions;
        }
        const raw = await this.getInventories();
        return raw.map((item, idx) => fromEsunInventoryToPosition(item, unit, idx + 1));
    }

    /** get_transactions_by_date 原始列（合成資料：一筆現股賣出） */
    async getTransactions(): Promise<EsunTransactionItem[]> {
        if (this.customTransactions) return this.customTransactions;
        return [{
            stk_no: '2884',
            stk_na: '玉山金',
            s_type: 'H',
            buy_sell: 'S',
            trade: '0',
            t_date: '20261022',
            c_date: '20261026',
            qty: '1000',
            price_avg: '27.00',
            price_qty: '27000',
            cost: '24500',
            recv: '27000',
            make: '2500',
            make_per: '10.20',
            mat_dats: [],
        }];
    }

    async getBalanceRaw(): Promise<EsunBalanceRaw> {
        return {
            available_balance: 500000,
            exchange_balance: 0,
            stock_pre_save_amount: 0,
            is_latest_data: true,
            updated_at: Date.UTC(2026, 9, 23, 0, 30) / 1000,
            cached: false,
            cache_age_sec: 0,
        };
    }

    async getTradeStatusRaw(): Promise<EsunTradeStatusRaw> {
        return {
            trade_limit: 1000000,
            margin_limit: 500000,
            short_limit: 500000,
            day_trade_code: 'X',
            margin_code: '0',
            short_code: '0',
        };
    }

    async getMarketStatusRaw(): Promise<EsunMarketStatusRaw> {
        return { is_trading_day: true, last_trading_day: '20261022', next_trading_day: '20261026' };
    }

    async getBalance(): Promise<AccountBalance> {
        if (this.customBalance) return this.customBalance;
        return {
            acc_balance: 500000,
            date: '2026-10-23T08:30:00.000Z',
            errmsg: '',
        };
    }

    async getSettlements(): Promise<Settlement[]> {
        if (this.customSettlements) return this.customSettlements;
        return [
            { date: '20261023', amount: 50000, T: 0 },
            { date: '20261024', amount: -25000, T: 1 },
            { date: '20261025', amount: 12000, T: 2 },
        ];
    }

    async getProfitLoss(): Promise<StockProfitLoss[]> {
        if (this.customProfitLoss) return this.customProfitLoss;
        return [
            {
                id: 1,
                code: '2884',
                quantity: 1000,
                pnl: 2500,
                date: '20261022',
                dseq: '1',
                price: 24.5,
                pr_ratio: 10.2,
                cond: 'Cash',
                seqno: '1',
            },
        ];
    }

    async getProfitLossSummary(): Promise<ProfitLossSummaryTotal> {
        return {
            profitloss_sum: [
                {
                    code: '2884',
                    quantity: 1000,
                    pnl: 2500,
                    pr_ratio: 10.2,
                    entry_price: 24.5,
                    cover_price: 27.0,
                    entry_cost: 24500,
                    cover_cost: 27000,
                    buy_cost: 24500,
                    sell_cost: 27000,
                    cond: 'Cash',
                    currency: 'TWD',
                },
            ],
            total: {
                entry_amount: 24500,
                cover_amount: 27000,
                quantity: 1000,
                buy_cost: 24500,
                sell_cost: 27000,
                pnl: 2500,
                pr_ratio: 10.2,
            },
        };
    }

    async getTradingLimits(): Promise<TradingLimits> {
        if (this.customTradingLimits) return this.customTradingLimits;
        return {
            trading_limit: 1000000,
            trading_used: 200000,
            trading_available: 800000,
            margin_limit: 500000,
            margin_used: 100000,
            margin_available: 400000,
            short_limit: 500000,
            short_used: 50000,
            short_available: 450000,
        };
    }

    async getStockReserveSummary(): Promise<ReserveStocksSummary> {
        // 玉山只有圈存金額，沒有逐檔圈存股數（見 fromEsunBalanceToReserveSummary）
        return {
            stocks: [],
            account: {
                broker_id: ESUN_BROKER_CODE,
                account_id: MOCK_ESUN_ACCOUNT_ID,
                account_type: 'S',
                signed: true,
                username: ESUN_BROKER_NAME,
                person_id: '',
            },
        };
    }

    async getCaExpire(): Promise<{ ca_expiretime: string }> {
        return { ca_expiretime: '2027-12-31' };
    }
}
