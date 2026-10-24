// src/lib/broker-dispatch.test.ts — Dual-broker integration tests for SinoPac & E.SUN routing
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { Trade } from './types/order';
import type { ContractBase } from './types/contract';
import { MOCK_ESUN_ACCOUNT_ID, MockEsunDriver } from './esun/mock-driver';
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

// 玉山模擬環境的帳戶（帳戶鍵含環境；送 bridge 的 expected_account 為 account_id）
const esunStockAccount: Account = {
    account_type: 'S',
    broker_id: '8840-SIM',
    account_id: MOCK_ESUN_ACCOUNT_ID,
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
}));

vi.mock('./esun/stream', () => ({
    ensureEsunOrderStream: vi.fn(),
    isEsunStreamStarted: () => true,
    getEsunStreamStatus: () => 'live',
    onEsunStreamSignal: () => () => undefined,
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
    replaceExternalAccountsForBroker: vi.fn(),
    registerExternalAccounts: vi.fn(),
}));

vi.mock('./trading-state', () => ({
    getTradingState: () => ({ trades: m.trades }),
    hasOrdersBaseline: m.baseline,
    cancelCacheTrusted: vi.fn(),
    locallyCancelled: vi.fn(),
}));

import { ensureEsunOrderStream } from './esun/stream';
import {
    cancelOrder,
    cancelVerifiedOrder,
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
import { takeMutationIntent } from './mutation-intent';
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

const limitBuy = (quantity: number, extra: Record<string, unknown> = {}) => ({
    action: 'Buy' as const,
    price: 25.0,
    quantity,
    price_type: 'LMT' as const,
    order_type: 'ROD' as const,
    order_lot: 'Common' as const,
    ...extra,
});

describe('Dual-Broker Integration & Dispatch', () => {
    let mockDriver: MockEsunDriver;
    const fetchMock = vi.fn();

    beforeEach(async () => {
        vi.clearAllMocks();
        mockDriver = new MockEsunDriver();
        esunTradeService.setDriver(mockDriver);
        esunTradeService.clearAccounts();
        // 與 bridge 同步：模擬環境、帳戶 8840-SIM
        await esunTradeService.refreshHealth();

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
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    const sinopacCalls = (path: string) => fetchMock.mock.calls.filter(([u]) => String(u).includes(path));

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Account Merging (C-03)
    // ─────────────────────────────────────────────────────────────────────────
    describe('1. Account Merging & Switching', () => {
        it('appends E.SUN accounts after the SinoPac accounts (SinoPac stays the default pick)', async () => {
            const accounts = await fetchAccounts();
            expect(accounts.map(a => `${a.broker_id}-${a.account_id}`)).toEqual([
                '9A95-1234567', '9A95-7654321', `8840-SIM-${MOCK_ESUN_ACCOUNT_ID}`,
            ]);
        });

        it('does not duplicate E.SUN accounts', async () => {
            esunTradeService.registerAccount(esunStockAccount);
            const accounts = await fetchAccounts();
            expect(accounts.filter(a => a.broker_id === '8840-SIM')).toHaveLength(1);
        });

        it('propagates a SinoPac failure instead of silently returning only E.SUN accounts', async () => {
            fetchMock.mockRejectedValueOnce(new Error('SinoPac Offline'));
            await expect(fetchAccounts()).rejects.toThrow('SinoPac Offline');
        });

        it('does not merge E.SUN accounts into an empty SinoPac list (still logging in)', async () => {
            fetchMock.mockResolvedValueOnce(new Response('[]'));
            await expect(fetchAccounts()).resolves.toEqual([]);
        });

        it('routes fetchCaExpire to SinoPac unless an E.SUN account is named (C-10)', async () => {
            m.selectedStock = esunStockAccount;
            const sinopac = await fetchCaExpire('P123456789');
            expect(sinopac.expire_time).toBe('2026-12-31');
            expect(sinopacCalls('/api/v1/auth/ca_expiretime')).toHaveLength(1);

            const esun = await fetchCaExpire('A123456789', esunStockAccount);
            expect(esun.expire_time).toBe('2027-12-31');
            expect(sinopacCalls('/api/v1/auth/ca_expiretime')).toHaveLength(1);
        });

        it('subscribes E.SUN reports by starting the E.SUN stream, never via SinoPac', async () => {
            await subscribeTradeEvents(esunStockAccount);
            expect(fetchMock).not.toHaveBeenCalled();
            expect(ensureEsunOrderStream).toHaveBeenCalled();

            await subscribeTradeEvents(sinopacStockAccount);
            expect(sinopacCalls('/api/v1/auth/subscribe_trade')).toHaveLength(1);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Stock Order Routing & Limits
    // ─────────────────────────────────────────────────────────────────────────
    describe('2. Stock Order Routing & Limits', () => {
        it('routes stock order to SinoPac when account is SinoPac', async () => {
            const res = await placeStockOrder(stockContract, limitBuy(1), sinopacStockAccount);
            expect(res.status.id).toBe('ORD_SINOPAC_1');
            expect(sinopacCalls('/place_order')).toHaveLength(1);
        });

        it('routes stock order to E.SUN with the expected environment and account', async () => {
            const res = await placeStockOrder(stockContract, limitBuy(2), esunStockAccount);
            expect(res.status.status).toBe('Submitted');
            expect(res.order.quantity).toBe(2);
            expect(res.order.account?.broker_id).toBe('8840-SIM');
            expect(mockDriver.lastGuard).toEqual({ expected_environment: 'SIMULATION', expected_account: MOCK_ESUN_ACCOUNT_ID });
            expect(sinopacCalls('/place_order')).toHaveLength(0);
        });

        it('refuses an E.SUN account that left the account list (same gate as sendOrderMutation)', async () => {
            m.accounts = [sinopacStockAccount];
            const placeOrder = vi.spyOn(mockDriver, 'placeOrder');
            await expect(placeStockOrder(stockContract, limitBuy(1), esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true, tradingGateRejected: true,
            });
            expect(placeOrder).not.toHaveBeenCalled();
        });

        it('applies the upstream odd-lot rules to E.SUN orders too', async () => {
            await expect(placeStockOrder(stockContract, limitBuy(100, { order_lot: 'IntradayOdd', price_type: 'MKT', order_type: 'IOC' }), esunStockAccount))
                .rejects.toMatchObject({ mutationNotStarted: true });
        });

        it('enforces E.Sun Common order limit: 1 <= qty <= 499 sheets', async () => {
            await expect(placeStockOrder(stockContract, limitBuy(499), esunStockAccount)).resolves.toBeDefined();
            await expect(placeStockOrder(stockContract, limitBuy(500), esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('499'),
            });
            await expect(placeStockOrder(stockContract, limitBuy(0), esunStockAccount)).rejects.toMatchObject({ mutationNotStarted: true });
        });

        it('enforces E.Sun Odd order limit: 1 <= qty <= 999 shares', async () => {
            await expect(placeStockOrder(stockContract, limitBuy(999, { order_lot: 'IntradayOdd' }), esunStockAccount)).resolves.toBeDefined();
            await expect(placeStockOrder(stockContract, limitBuy(1000, { order_lot: 'IntradayOdd' }), esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('999'),
            });
            await expect(placeStockOrder(stockContract, limitBuy(500, { order_lot: 'IntradayOdd', order_cond: 'MarginTrading' }), esunStockAccount))
                .rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('零股') });
        });

        it('applies E.SUN rules in placeQuickOrder (emerging stocks are blocked)', async () => {
            await expect(placeQuickOrder({ ...stockContract, exchange: 'OES' }, 'Buy', 50, 1, { account: esunStockAccount, source: 'auto' }))
                .rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('興櫃') });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Futures Order Rejection on E.Sun Account
    // ─────────────────────────────────────────────────────────────────────────
    describe('3. Futures Order Rejection on E.Sun Account', () => {
        it('rejects placeFuturesOrder with E.Sun account', async () => {
            await expect(placeFuturesOrder(futuresContract, {
                action: 'Buy', price: 22000, quantity: 1, price_type: 'LMT', order_type: 'ROD', octype: 'Auto',
            }, esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('玉山證券不支援期貨交易'),
            });
        });

        it('rejects placeComboOrder with E.Sun account', async () => {
            await expect(placeComboOrder({ legs: [] }, {
                action: 'Buy', price: 100, quantity: 1, order_type: 'ROD', price_type: 'LMT',
            }, esunStockAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('玉山證券不支援期權組合單'),
            });
        });

        it('rejects placeQuickOrder for futures on E.Sun account', async () => {
            await expect(placeQuickOrder(futuresContract, 'Buy', 22000, 1, { account: esunStockAccount })).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('玉山證券僅支援證券交易'),
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Cancellation confirmation & mutation semantics (C-06 / C-07 / C-V1-1)
    // ─────────────────────────────────────────────────────────────────────────
    describe('4. Price/Quantity Modification & Cancellation Routing & Guards', () => {
        const place = (quantity: number) => esunTradeService.placeStockOrder(stockContract, limitBuy(quantity), esunStockAccount)
            .then(trade => ({ ...trade, account: esunStockAccount }));

        it('confirms an E.SUN cancel only from a same-account read-back', async () => {
            vi.useFakeTimers();
            const placed = await place(2);
            m.trades = [placed];
            const pending = cancelOrder(placed.order.id);
            await vi.advanceTimersByTimeAsync(4_000);
            const cancelled = await pending;
            expect(cancelled.status.status).toBe('Cancelled');
            expect(cancelled.status.cancel_quantity).toBe(2);
            expect(sinopacCalls('/api/v1/order/cancel_order')).toHaveLength(0);
        });

        it('reports an unconfirmed E.SUN cancel as an unknown outcome (never a fabricated Cancelled)', async () => {
            vi.useFakeTimers();
            const placed = await place(3);
            m.trades = [placed];
            vi.spyOn(mockDriver, 'cancelOrder').mockResolvedValueOnce({ ret_code: '000000' }); // 券商受理但尚未生效
            const pending = cancelOrder(placed.order.id).catch(e => e);
            await vi.advanceTimersByTimeAsync(4_000);
            const error = await pending;
            expect(error.code).toBe('CANCEL_UNCONFIRMED');
            expect(error.mutationOutcomeUnknown).toBe(true);
        });

        it('routes cancelVerifiedOrder for an E.SUN row to the bridge, not to the SinoPac sidecar', async () => {
            vi.useFakeTimers();
            const placed = await place(2);
            const pending = cancelVerifiedOrder(placed, esunStockAccount);
            await vi.advanceTimersByTimeAsync(4_000);
            await expect(pending).resolves.toMatchObject({ status: { status: 'Cancelled' } });
            expect(sinopacCalls('/api/v1/order/cancel_order')).toHaveLength(0);
        });

        it('sends updateOrderQty as a reduction and records the mutation intent', async () => {
            const placed = await place(5);
            m.trades = [placed];
            // 委託列：剩餘 5、新剩餘 1 → updateOrderQty(id, 4)
            await updateOrderQty(placed.order.id, 4);
            expect(takeMutationIntent(placed.order.id)).toEqual({ kind: 'qty', quantity: 4 });
            const [row] = await esunTradeService.fetchTrades(esunStockAccount, true);
            expect(row!.order.quantity - row!.status.cancel_quantity).toBe(1);
        });

        it('records the price intent and blocks odd-lot price changes', async () => {
            const placed = await place(2);
            m.trades = [placed];
            await updateOrderPrice(placed.order.id, 26.0);
            expect(takeMutationIntent(placed.order.id)).toEqual({ kind: 'price', price: 26 });

            const odd = { ...placed, order: { ...placed.order, id: 'ODD1', ordno: 'ODD1', order_lot: 'IntradayOdd', quantity: 100 } };
            m.trades = [odd];
            await expect(updateOrderPrice('ODD1', 26.0)).rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('零股') });
        });

        it('executes the AG0006 and reduction guards through shioaji', async () => {
            const reservation: Trade = {
                contract: stockContract,
                order: { id: 'RES_SHIOAJI_002', seqno: 'RES_SHIOAJI_002', ordno: '', action: 'Buy', price: 25.0, quantity: 2, order_type: 'ROD', price_type: 'LMT', account: esunStockAccount },
                status: { id: 'RES_SHIOAJI_002', status: 'PreSubmitted', status_code: '1', msg: '', order_quantity: 2, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, deals: [] },
            };
            m.trades = [reservation];
            await expect(updateOrderPrice(reservation.order.id, 26.0)).rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('AG0006') });
            await expect(updateOrderQty(reservation.order.id, 1)).rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('AG0006') });

            const working: Trade = {
                ...reservation,
                order: { ...reservation.order, id: 'NORM_001', seqno: 'NORM_001', ordno: 'NORM_001' },
                status: { ...reservation.status, id: 'NORM_001', status: 'Submitted', status_code: '' },
            };
            m.trades = [working];
            await expect(updateOrderQty(working.order.id, 3)).rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('減量') });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Portfolio Routing for E.Sun Accounts
    // ─────────────────────────────────────────────────────────────────────────
    describe('5. Portfolio Routing for E.Sun Accounts', () => {
        it('routes fetchPositions to E.Sun (Common & Share)', async () => {
            const positions = await fetchPositions('S', esunStockAccount);
            expect(positions[0]!.code).toBe('2884');
            expect(positions[0]!.quantity).toBe(2000);
            expect((await esunTradeService.fetchPositions(esunStockAccount, 'Common'))[0]!.quantity).toBe(2);
        });

        it('routes account queries to E.Sun', async () => {
            expect((await fetchAccountBalance(esunStockAccount)).acc_balance).toBe(500000);
            expect((await fetchSettlements(esunStockAccount))[0]!.amount).toBe(50000);
            expect((await fetchProfitLoss('S', esunStockAccount, '2026-05-01', '2026-06-01'))[0]!.pnl).toBe(2500);
            expect((await fetchProfitLossSummary('S', esunStockAccount, '2026-05-01', '2026-06-01')).total.pnl).toBe(2500);
            expect((await fetchTradingLimits(esunStockAccount)).trading_available).toBe(800000);
            expect((await fetchStockReserveSummary(esunStockAccount)).stocks).toEqual([]);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('reports E.SUN trade cache health only after an authoritative read on this session', async () => {
            esunTradeService.applySession({ generation: 9, environment: 'SIMULATION', account: { broker_id: '8840', account_id: MOCK_ESUN_ACCOUNT_ID } });
            expect((await fetchTradeCacheHealth('S', esunStockAccount)).state).toBe('Degraded');
            await fetchTrades('S', esunStockAccount, { refresh: true });
            expect(await fetchTradeCacheHealth('S', esunStockAccount)).toEqual({ state: 'Healthy', reasons: [] });
        });
    });
});
