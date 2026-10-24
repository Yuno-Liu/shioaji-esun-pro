// src/lib/esun/mock-driver.ts — Mock driver for testing and simulation
//
// 回傳形狀比照 esun_trade SDK 實際欄位（snake_case；sdk.py 以 order_result["ap_code"]
// 等鍵存取）：零股／興櫃（ap_code 3、4、5）的 *_qty 為「張」的小數、*_qty_share 為股數。
// 環境綁定與 bridge 相同：expected_environment 不符時回 409（確定未送出）。

import type { IEsunTradeDriver, EsunBridgeHealth, EsunMutationOptions } from './adapter';
import type {
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
    /** 最後一筆委託類請求帶的預期環境／帳號（測試檢查用） */
    public lastGuard: EsunMutationOptions['guard'] | undefined;
    /** 最後一筆減量請求的數量單位（測試檢查用） */
    public lastUnit: EsunMutationOptions['unit'] | undefined;

    private customPositions: StockPosition[] | null = null;
    private customBalance: AccountBalance | null = null;
    private customSettlements: Settlement[] | null = null;
    private customProfitLoss: StockProfitLoss[] | null = null;
    private customTradingLimits: TradingLimits | null = null;

    setPositions(positions: StockPosition[]): void {
        this.customPositions = positions;
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
            loggedIn: true,
            loginError: null,
            sessionGeneration: this.generation,
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

    async getPositions(unit: 'Common' | 'Share' = 'Common'): Promise<StockPosition[]> {
        if (this.customPositions) {
            return this.customPositions;
        }
        // get_inventories 的 stk_sums 形狀（cost_qty 為股數、trade 為交易類別）
        const raw = [{
            stk_no: '2884',
            cost_qty: 2000,
            price_avg: 25.0,
            price_mkt: 26.5,
            make_a_sum: 3000,
            qty_l: 2000,
            trade: '0',
        }];
        return raw.map((item, idx) => fromEsunInventoryToPosition(item, unit, idx + 1));
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
