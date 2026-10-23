// src/lib/esun/mock-driver.ts — Mock driver for testing and simulation

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
import { ESUN_BROKER_CODE, ESUN_BROKER_NAME, ESUN_PRODUCTION_ENTRY, ESUN_SIMULATION_ENTRY } from './types';

export class MockEsunDriver implements IEsunTradeDriver {
    readonly name = 'mock';

    private seq = 1;
    private orders = new Map<string, EsunOrderPayload & { ordNo: string; celQty: number; orgQty: number }>();
    public simulateFailure: string | null = null;
    private environment: 'SIMULATION' | 'PRODUCTION' = 'SIMULATION';

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

    async health(): Promise<EsunBridgeHealth> {
        return {
            ok: true,
            configured: true,
            problems: [],
            environment: this.environment,
            simulation: this.environment === 'SIMULATION',
            entry: this.environment === 'SIMULATION' ? ESUN_SIMULATION_ENTRY : ESUN_PRODUCTION_ENTRY,
            account: { broker_id: ESUN_BROKER_CODE, account_id: '0664718' },
            loggedIn: true,
            loginError: null,
        };
    }

    async switchEnvironment(env: 'SIMULATION' | 'PRODUCTION'): Promise<{
        ok: boolean;
        environment: 'SIMULATION' | 'PRODUCTION';
        entry: string;
    }> {
        this.environment = env;
        return {
            ok: true,
            environment: env,
            entry: env === 'SIMULATION' ? ESUN_SIMULATION_ENTRY : ESUN_PRODUCTION_ENTRY,
        };
    }

    async accounts(): Promise<Account[]> {
        return [
            {
                account_type: 'S',
                broker_id: ESUN_BROKER_CODE,
                account_id: '0664718',
                signed: true,
                username: ESUN_BROKER_NAME,
                person_id: 'A123456789',
            },
        ];
    }

    async placeOrder(payload: EsunOrderPayload): Promise<EsunPlaceOrderResponse> {
        if (this.simulateFailure) {
            return {
                retCode: '999999',
                retMsg: this.simulateFailure,
                workDate: '20261023',
                ordType: '0',
                ordNo: '',
                ordDate: '20261023',
                ordTime: '090000',
            };
        }

        const ordNo = `E${String(this.seq++).padStart(5, '0')}`;
        this.orders.set(ordNo, {
            ...payload,
            ordNo,
            orgQty: payload.quantity,
            celQty: 0,
        });

        return {
            retCode: '000000',
            retMsg: '委託成功',
            workDate: '20261023',
            ordType: '0',
            ordNo,
            ordDate: '20261023',
            ordTime: '090000',
        };
    }

    async replacePrice(
        orderNo: string,
        price: number | EsunPriceFlag,
    ): Promise<EsunReplaceOrderResponse> {
        if (this.simulateFailure) {
            return {
                retCode: '999999',
                retMsg: this.simulateFailure,
                ordDate: '20261023',
                ordTime: '090100',
            };
        }

        const existing = this.orders.get(orderNo);
        if (existing && typeof price === 'number') {
            existing.price = price;
        }

        return {
            retCode: '000000',
            retMsg: '改價成功',
            ordDate: '20261023',
            ordTime: '090100',
        };
    }

    async replaceQuantity(
        orderNo: string,
        quantity: number,
        _payload?: Partial<EsunOrderPayload>,
    ): Promise<EsunReplaceOrderResponse> {
        if (this.simulateFailure) {
            return {
                retCode: '999999',
                retMsg: this.simulateFailure,
                ordDate: '20261023',
                ordTime: '090200',
            };
        }

        const existing = this.orders.get(orderNo);
        if (existing) {
            existing.quantity = quantity;
        }

        return {
            retCode: '000000',
            retMsg: '改量成功',
            ordDate: '20261023',
            ordTime: '090200',
        };
    }

    async cancelOrder(orderNo: string): Promise<EsunReplaceOrderResponse> {
        if (this.simulateFailure) {
            return {
                retCode: '999999',
                retMsg: this.simulateFailure,
                ordDate: '20261023',
                ordTime: '090300',
            };
        }

        const existing = this.orders.get(orderNo);
        if (existing) {
            existing.celQty = existing.quantity;
            existing.quantity = 0;
        }

        return {
            retCode: '000000',
            retMsg: '刪單成功',
            ordDate: '20261023',
            ordTime: '090300',
        };
    }

    async getOrders(): Promise<EsunOrderResult[]> {
        const out: EsunOrderResult[] = [];
        for (const o of this.orders.values()) {
            out.push({
                workDate: '20261023',
                ordDate: '20261023',
                ordTime: '090000',
                ordStatus: o.celQty >= o.orgQty ? 'Cancel' : 'Submitted',
                ordNo: o.ordNo,
                preOrdNo: o.ordNo,
                stockNo: o.stockNo,
                buySell: o.buySell,
                apCode: o.apCode,
                priceFlag: o.priceFlag,
                trade: o.trade,
                odPrice: String(o.price),
                orgQty: String(o.orgQty),
                orgQtyShare: String(o.orgQty * (o.apCode === '1' ? 1000 : 1)),
                matQty: '0',
                matQtyShare: '0',
                celQty: String(o.celQty),
                celQtyShare: String(o.celQty * (o.apCode === '1' ? 1000 : 1)),
                celable: o.celQty < o.orgQty ? 'Y' : 'N',
                errCode: '000000',
                errMsg: '',
                avgPrice: '0',
                bsFlag: o.bsFlag,
                memo: o.userDef || '',
            });
        }
        return out;
    }

    async getPositions(unit: 'Common' | 'Share' = 'Common'): Promise<StockPosition[]> {
        if (this.customPositions) {
            return this.customPositions;
        }
        const mult = unit === 'Share' ? 1000 : 1;
        return [
            {
                id: 1,
                code: '2884',
                direction: 'Buy',
                quantity: 2 * mult,
                price: 25.0,
                last_price: 26.5,
                pnl: 3000,
                yd_quantity: 2 * mult,
                cond: 'Cash',
            },
        ];
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
        return {
            stocks: [
                {
                    contract: {
                        code: 'TOTAL',
                        security_type: 'STK',
                        exchange: 'TSE',
                        target_code: null,
                    },
                    available_share: 0,
                    reserved_share: 15000,
                },
            ],
            account: {
                broker_id: ESUN_BROKER_CODE,
                account_id: '0664718',
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
