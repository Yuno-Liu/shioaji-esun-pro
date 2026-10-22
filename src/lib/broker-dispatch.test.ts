// src/lib/broker-dispatch.test.ts — Dual-broker integration tests for SinoPac & E.SUN routing
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { Trade } from './types/order';
import type { ContractBase } from './types/contract';
import { MockEsunDriver } from './esun/mock-driver';
import { esunTradeService } from './esun/service';

const sinopacStockAccount: Account = {
    account_type: 'S',
    broker_id: '9A95',
    account_id: '1234567',
    signed: true,
    username: '永豐證券',
    person_id: 'P123456789',
};

const sinopacFuturesAccount: Account = {
    account_type: 'F',
    broker_id: '9A95',
    account_id: '7654321',
    signed: true,
    username: '永豐期貨',
    person_id: 'P123456789',
};

const esunStockAccount: Account = {
    account_type: 'S',
    broker_id: '8840',
    account_id: '0664718',
    signed: true,
    username: '玉山證券',
    person_id: 'A123456789',
};

const m = vi.hoisted(() => ({
    accounts: [] as Account[],
    selectedStock: null as Account | null,
    selectedFutures: null as Account | null,
    trades: [] as Trade[],
    baseline: vi.fn(),
}));

vi.mock('./risk', () => ({
    checkOrderAllowed: () => null,
    getRiskSettings: () => ({ confirmManualOrders: false }),
}));

vi.mock('./stream', () => ({
    getStreamStatus: () => 'live',
    connectEsunOrderStream: vi.fn(),
    disconnectEsunOrderStream: vi.fn(),
}));

vi.mock('./account-store', () => ({
    getAccountState: () => ({
        accounts: m.accounts,
        selectedStock: m.selectedStock,
        selectedFutures: m.selectedFutures,
        loaded: true,
        loadError: false,
    }),
    accountFor: (type: string) => m.accounts.find(a => a.account_type === type),
    selectAccount: (a: Account) => {
        if (a.account_type === 'S') m.selectedStock = a;
        if (a.account_type === 'F') m.selectedFutures = a;
    },
}));

vi.mock('./trading-state', () => ({
    getTradingState: () => ({ trades: m.trades }),
    hasOrdersBaseline: m.baseline,
    cancelCacheTrusted: vi.fn(),
    locallyCancelled: vi.fn(),
}));

import { connectEsunOrderStream } from './stream';
import {
    cancelOrder,
    fetchAccountBalance,
    fetchAccounts,
    fetchCaExpire,
    fetchPositions,
    fetchProfitLoss,
    fetchProfitLossSummary,
    fetchSettlements,
    fetchStockReserveSummary,
    fetchTradeCacheHealth,
    fetchTrades,
    fetchTradingLimits,
    placeComboOrder,
    placeFuturesOrder,
    placeStockOrder,
    subscribeTradeEvents,
    updateOrderPrice,
    updateOrderQty,
} from './shioaji';
import { placeQuickOrder } from './trade';
import { beginServerInfoRequest, forgetServerInfo, observeServerInfo } from './server-info-store';

const stockContract: ContractBase = {
    code: '2884',
    security_type: 'STK',
    exchange: 'TSE',
    target_code: null,
};

const futuresContract: ContractBase = {
    code: 'TXF202611',
    security_type: 'FUT',
    exchange: 'TAIFEX',
    target_code: null,
};

describe('Dual-Broker Integration & Dispatch', () => {
    let mockDriver: MockEsunDriver;
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        mockDriver = new MockEsunDriver();
        esunTradeService.setDriver(mockDriver);
        esunTradeService.clearAccounts();
        esunTradeService.registerAccount(esunStockAccount);

        m.accounts = [sinopacStockAccount, sinopacFuturesAccount, esunStockAccount];
        m.selectedStock = sinopacStockAccount;
        m.selectedFutures = sinopacFuturesAccount;
        m.trades = [];
        m.baseline.mockReturnValue(true);

        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('BroadcastChannel', undefined);
        vi.stubGlobal('navigator', {
            locks: {
                request: (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
            },
        });

        forgetServerInfo('');
        observeServerInfo(beginServerInfoRequest(), { simulation: true } as any);

        fetchMock.mockImplementation(async (url: string) => {
            if (url.includes('/api/v1/auth/accounts')) {
                return new Response(JSON.stringify([sinopacStockAccount, sinopacFuturesAccount]));
            }
            if (url.includes('/api/v1/auth/ca_expiretime')) {
                return new Response(JSON.stringify({ person_id: 'P123456789', expire_time: '2026-12-31' }));
            }
            if (url.includes('/api/v1/auth/subscribe_trade')) {
                return new Response(JSON.stringify({ ok: true }));
            }
            if (url.includes('/api/v1/order/place_order')) {
                return new Response(JSON.stringify({
                    contract: stockContract,
                    order: { id: 'ORD_SINOPAC_1', ordno: 'O001', action: 'Buy', price: 25.0, quantity: 1 },
                    status: { status: 'Submitted', id: 'ORD_SINOPAC_1' },
                }));
            }
            return new Response(JSON.stringify({ ok: true }));
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Account Merging & Switching
    // ─────────────────────────────────────────────────────────────────────────
    describe('1. Account Merging & Switching', () => {
        it('merges SinoPac accounts with registered E.Sun accounts', async () => {
            const accounts = await fetchAccounts();
            expect(accounts.length).toBe(3);
            expect(accounts.some(a => a.broker_id === '9A95' && a.account_id === '1234567')).toBe(true);
            expect(accounts.some(a => a.broker_id === '9A95' && a.account_id === '7654321')).toBe(true);
            expect(accounts.some(a => a.broker_id === '8840' && a.account_id === '0664718')).toBe(true);
        });

        it('does not duplicate E.Sun accounts if already merged', async () => {
            esunTradeService.registerAccount(esunStockAccount);
            const accounts = await fetchAccounts();
            const esunMatches = accounts.filter(a => a.broker_id === '8840' && a.account_id === '0664718');
            expect(esunMatches.length).toBe(1);
        });

        it('returns E.Sun accounts when SinoPac API fails', async () => {
            fetchMock.mockRejectedValueOnce(new Error('SinoPac Offline'));
            const accounts = await fetchAccounts();
            expect(accounts.length).toBe(1);
            expect(accounts[0]!.broker_id).toBe('8840');
        });

        it('routes fetchCaExpire to E.Sun when active stock account is E.Sun', async () => {
            m.selectedStock = esunStockAccount;

            const expire = await fetchCaExpire('A123456789');
            expect(expire.expire_time).toBe('2027-12-31');
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('routes fetchCaExpire to SinoPac when active stock account is SinoPac', async () => {
            m.selectedStock = sinopacStockAccount;

            const expire = await fetchCaExpire('P123456789');
            expect(expire.expire_time).toBe('2026-12-31');
            expect(fetchMock).toHaveBeenCalled();
            const call = fetchMock.mock.calls[0];
            const url = call ? call[0] : '';
            expect(url).toContain('/api/v1/auth/ca_expiretime');
        });

        it('skips SinoPac subscribe_trade and triggers connectEsunOrderStream when account is E.Sun', async () => {
            await subscribeTradeEvents(esunStockAccount);
            expect(fetchMock).not.toHaveBeenCalled();
            expect(connectEsunOrderStream).toHaveBeenCalled();
        });

        it('calls SinoPac subscribe_trade when account is SinoPac', async () => {
            vi.mocked(connectEsunOrderStream).mockClear();
            await subscribeTradeEvents(sinopacStockAccount);
            expect(fetchMock).toHaveBeenCalled();
            expect(connectEsunOrderStream).not.toHaveBeenCalled();
            const call = fetchMock.mock.calls[0];
            const url = call ? call[0] : '';
            expect(url).toContain('/api/v1/auth/subscribe_trade');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Stock Order Routing & Limits
    // ─────────────────────────────────────────────────────────────────────────
    describe('2. Stock Order Routing & Limits', () => {
        it('routes stock order to SinoPac when account is SinoPac', async () => {
            const res = await placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 1,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Common',
            }, sinopacStockAccount);

            expect(res.status.id).toBe('ORD_SINOPAC_1');
            expect(fetchMock).toHaveBeenCalled();
            const [url] = (fetchMock.mock.calls.find(([u]) => u.includes('/place_order')) ?? []) as [string];
            expect(url).toContain('/api/v1/order/place_order');
        });

        it('routes stock order to E.Sun when account is E.Sun', async () => {
            const res = await placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 2,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Common',
            }, esunStockAccount);

            expect(res.status.status).toBe('Submitted');
            expect(res.order.quantity).toBe(2);
            expect(res.order.account?.broker_id).toBe('8840');
            // SinoPac fetch should not be called for order placement
            const placementCalls = fetchMock.mock.calls.filter(([u]) => u.includes('/place_order'));
            expect(placementCalls.length).toBe(0);
        });

        it('enforces E.Sun Common order limit: 1 <= qty <= 499 sheets', async () => {
            // 499 sheets: OK
            await expect(placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 499,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Common',
            }, esunStockAccount)).resolves.toBeDefined();

            // 500 sheets: rejected immediately with mutationNotStarted: true
            await expect(placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 500,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Common',
            }, esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('499'),
            });

            // 0 sheets: rejected
            await expect(placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 0,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Common',
            }, esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
            });
        });

        it('enforces E.Sun Odd order limit: 1 <= qty <= 999 shares', async () => {
            // 999 shares: OK
            await expect(placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 999,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'IntradayOdd',
            }, esunStockAccount)).resolves.toBeDefined();

            // 1000 shares: rejected
            await expect(placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 1000,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'IntradayOdd',
            }, esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('999'),
            });

            // Margin condition on Odd lot: rejected
            await expect(placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 500,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'IntradayOdd',
                order_cond: 'MarginTrading',
            }, esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('零股'),
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Futures Order Rejection on E.Sun Account
    // ─────────────────────────────────────────────────────────────────────────
    describe('3. Futures Order Rejection on E.Sun Account', () => {
        it('rejects placeFuturesOrder with E.Sun account', async () => {
            await expect(placeFuturesOrder(futuresContract, {
                action: 'Buy',
                price: 22000,
                quantity: 1,
                price_type: 'LMT',
                order_type: 'ROD',
                octype: 'Auto',
            }, esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('玉山證券不支援期貨交易'),
            });
        });

        it('rejects placeComboOrder with E.Sun account', async () => {
            await expect(placeComboOrder({ legs: [] }, {
                action: 'Buy',
                price: 100,
                quantity: 1,
                order_type: 'ROD',
                price_type: 'LMT',
            }, esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('玉山證券不支援期權組合單'),
            });
        });

        it('rejects placeQuickOrder for futures on E.Sun account', async () => {
            await expect(placeQuickOrder(
                futuresContract,
                'Buy',
                22000,
                1,
                { account: esunStockAccount },
            )).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('玉山證券僅支援證券交易'),
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Price/Quantity Modification & Cancellation Routing & Guards
    // ─────────────────────────────────────────────────────────────────────────
    describe('4. Price/Quantity Modification & Cancellation Routing & Guards', () => {
        it('routes cancelOrder to E.Sun when order belongs to E.Sun', async () => {
            // First place order via E.Sun
            const trade = await esunTradeService.placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 2,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Common',
            }, esunStockAccount);

            const ordNo = trade.order.id;
            const cancelled = await esunTradeService.cancelOrder(trade, esunStockAccount);
            expect(cancelled.status.status).toBe('Cancelled');
            expect(cancelled.order.id).toBe(ordNo);
        });

        it('routes updateOrderPrice to E.Sun when order belongs to E.Sun', async () => {
            const trade = await esunTradeService.placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 2,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Common',
            }, esunStockAccount);

            const updated = await esunTradeService.updateOrderPrice(trade, 26.0, esunStockAccount);
            expect(updated.order.price).toBe(26.0);
            expect(updated.status.status).toBe('Submitted');
        });

        it('routes updateOrderQty to E.Sun when order belongs to E.Sun', async () => {
            const trade = await esunTradeService.placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 5,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Common',
            }, esunStockAccount);

            const updated = await esunTradeService.updateOrderQty(trade, 3, esunStockAccount);
            expect(updated.order.quantity).toBe(3);
            expect(updated.status.cancel_quantity).toBe(2);
        });

        it('rejects price modification on non-ROD or non-Limit order for E.Sun', async () => {
            const iocTrade: Trade = {
                contract: stockContract,
                order: {
                    id: 'ORD_IOC_1',
                    seqno: 'ORD_IOC_1',
                    ordno: 'ORD_IOC_1',
                    action: 'Buy',
                    price: 25.0,
                    quantity: 2,
                    order_type: 'IOC',
                    price_type: 'LMT',
                    account: esunStockAccount,
                },
                status: {
                    id: 'ORD_IOC_1',
                    status: 'Submitted',
                    status_code: '000000',
                    msg: '',
                    order_quantity: 2,
                    deal_quantity: 0,
                    cancel_quantity: 0,
                    modified_price: 0,
                    deals: [],
                },
            };

            await expect(esunTradeService.updateOrderPrice(iocTrade, 26.0, esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('ROD 限價單'),
            });
        });

        it('blocks reservation order modification (AG0006) for E.Sun', async () => {
            const resTrade: Trade = {
                contract: stockContract,
                order: {
                    id: 'RES_001',
                    seqno: 'RES_001',
                    ordno: '', // No exchange ordno yet
                    action: 'Buy',
                    price: 25.0,
                    quantity: 2,
                    order_type: 'ROD',
                    price_type: 'LMT',
                    account: esunStockAccount,
                },
                status: {
                    id: 'RES_001',
                    status: 'PreSubmitted',
                    status_code: '1',
                    msg: '',
                    order_quantity: 2,
                    deal_quantity: 0,
                    cancel_quantity: 0,
                    modified_price: 0,
                    deals: [],
                },
            };

            // Price modification blocked
            await expect(esunTradeService.updateOrderPrice(resTrade, 26.0, esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('AG0006'),
            });

            // Qty modification blocked
            await expect(esunTradeService.updateOrderQty(resTrade, 1, esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('AG0006'),
            });
        });

        it('routes cancelOrder via shioaji with full trade to E.Sun', async () => {
            const placed = await esunTradeService.placeStockOrder(stockContract, {
                action: 'Buy',
                price: 25.0,
                quantity: 2,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Common',
            }, esunStockAccount);
            m.trades = [placed];

            const cancelled = await cancelOrder(placed.order.id);
            expect(cancelled.status.status).toBe('Cancelled');
        });

        it('executes fullTrade AG0006 guard when updateOrderPrice is called through shioaji', async () => {
            const resTrade: Trade = {
                contract: stockContract,
                order: {
                    id: 'RES_SHIOAJI_001',
                    seqno: 'RES_SHIOAJI_001',
                    ordno: '',
                    action: 'Buy',
                    price: 25.0,
                    quantity: 2,
                    order_type: 'ROD',
                    price_type: 'LMT',
                    account: esunStockAccount,
                },
                status: {
                    id: 'RES_SHIOAJI_001',
                    status: 'PreSubmitted',
                    status_code: '1',
                    msg: '',
                    order_quantity: 2,
                    deal_quantity: 0,
                    cancel_quantity: 0,
                    modified_price: 0,
                    deals: [],
                },
            };
            m.trades = [resTrade];

            await expect(updateOrderPrice(resTrade.order.id, 26.0)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('AG0006'),
            });
        });

        it('executes fullTrade AG0006 and reduction guard when updateOrderQty is called through shioaji', async () => {
            const resTrade: Trade = {
                contract: stockContract,
                order: {
                    id: 'RES_SHIOAJI_002',
                    seqno: 'RES_SHIOAJI_002',
                    ordno: '',
                    action: 'Buy',
                    price: 25.0,
                    quantity: 2,
                    order_type: 'ROD',
                    price_type: 'LMT',
                    account: esunStockAccount,
                },
                status: {
                    id: 'RES_SHIOAJI_002',
                    status: 'PreSubmitted',
                    status_code: '1',
                    msg: '',
                    order_quantity: 2,
                    deal_quantity: 0,
                    cancel_quantity: 0,
                    modified_price: 0,
                    deals: [],
                },
            };
            m.trades = [resTrade];

            await expect(updateOrderQty(resTrade.order.id, 1)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('AG0006'),
            });

            // Normal trade with quantity increase/equal should be rejected by reduction guard
            const normalTrade: Trade = {
                contract: stockContract,
                order: {
                    id: 'NORM_001',
                    seqno: 'NORM_001',
                    ordno: 'NORM_001',
                    action: 'Buy',
                    price: 25.0,
                    quantity: 2,
                    order_type: 'ROD',
                    price_type: 'LMT',
                    account: esunStockAccount,
                },
                status: {
                    id: 'NORM_001',
                    status: 'Submitted',
                    status_code: '000000',
                    msg: '',
                    order_quantity: 2,
                    deal_quantity: 0,
                    cancel_quantity: 0,
                    modified_price: 0,
                    deals: [],
                },
            };
            m.trades = [normalTrade];

            await expect(updateOrderQty(normalTrade.order.id, 2)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('減量'),
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Portfolio Routing for E.Sun Accounts
    // ─────────────────────────────────────────────────────────────────────────
    describe('5. Portfolio Routing for E.Sun Accounts', () => {
        it('routes fetchPositions to E.Sun (Common & Share)', async () => {
            // shioaji.fetchPositions('S', account) requests Share unit by default
            const positions = await fetchPositions('S', esunStockAccount);
            expect(positions.length).toBe(1);
            expect(positions[0]!.code).toBe('2884');
            expect(positions[0]!.quantity).toBe(2000);

            // Directly testing service with Common unit
            const commonPositions = await esunTradeService.fetchPositions(esunStockAccount, 'Common');
            expect(commonPositions[0]!.quantity).toBe(2);
        });

        it('routes fetchAccountBalance to E.Sun', async () => {
            const balance = await fetchAccountBalance(esunStockAccount);
            expect(balance.acc_balance).toBe(500000);
        });

        it('routes fetchSettlements to E.Sun', async () => {
            const settlements = await fetchSettlements(esunStockAccount);
            expect(settlements.length).toBe(3);
            expect(settlements[0]!.amount).toBe(50000);
        });

        it('routes fetchProfitLoss to E.Sun', async () => {
            const pnl = await fetchProfitLoss('S', esunStockAccount, '2026-05-01', '2026-06-01');
            expect(pnl.length).toBe(1);
            expect(pnl[0]!.code).toBe('2884');
            expect(pnl[0]!.pnl).toBe(2500);
        });

        it('routes fetchProfitLossSummary to E.Sun', async () => {
            const summary = await fetchProfitLossSummary('S', esunStockAccount, '2026-05-01', '2026-06-01');
            expect(summary.profitloss_sum.length).toBe(1);
            expect(summary.total.pnl).toBe(2500);
        });

        it('routes fetchTradingLimits to E.Sun', async () => {
            const limits = await fetchTradingLimits(esunStockAccount);
            expect(limits.trading_limit).toBe(1000000);
            expect(limits.trading_available).toBe(800000);
        });

        it('routes fetchStockReserveSummary to E.Sun', async () => {
            const reserve = await fetchStockReserveSummary(esunStockAccount);
            expect(reserve.stocks.length).toBe(1);
            expect(reserve.stocks[0]!.reserved_share).toBe(15000);
        });

        it('routes fetchTrades to E.Sun and handles trade_cache_health', async () => {
            const trades = await fetchTrades('S', esunStockAccount, { refresh: true });
            expect(Array.isArray(trades)).toBe(true);

            const health = await fetchTradeCacheHealth('S', esunStockAccount);
            expect(health.state).toBe('Healthy');
            expect(health.reasons).toEqual([]);
        });
    });
});
