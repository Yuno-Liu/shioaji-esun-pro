// src/lib/esun/service.test.ts — Unit tests for EsunTradeService

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase } from '../types/contract';
import type { OrderResult, StockOrderReq, Trade } from '../types/order';
import type { Account } from '../types/portfolio';
import { MOCK_ESUN_ACCOUNT_ID, MockEsunDriver } from './mock-driver';
import { EsunBridgeError, HttpEsunDriver, UnavailableEsunDriver } from './http-driver';
import { EsunTradeService } from './service';
import {
    ESUN_BROKER_CODE,
    ESUN_PRODUCTION_ENTRY,
    ESUN_SIMULATION_ENTRY,
    formatEsunConfigCoreSection,
    parseEsunConfigEnvironment,
} from './types';

// 帳戶鍵含環境：模擬帳戶 broker_id 帶 -SIM
const simAccount: Account = {
    account_type: 'S',
    broker_id: `${ESUN_BROKER_CODE}-SIM`,
    account_id: MOCK_ESUN_ACCOUNT_ID,
    signed: true,
    username: '測試玉山帳戶',
    person_id: 'A123456789',
};
const prodAccount: Account = { ...simAccount, broker_id: ESUN_BROKER_CODE };

const otherAccount: Account = {
    account_type: 'S',
    broker_id: '9A95',
    account_id: '9876543',
    signed: true,
    username: '永豐帳戶',
    person_id: 'A123456789',
};

const stockContract: ContractBase = {
    code: '2884',
    security_type: 'STK',
    exchange: 'TSE',
    target_code: null,
};

const limitBuy = (quantity: number, extra: Partial<StockOrderReq> = {}): StockOrderReq => ({
    action: 'Buy', price: 25.0, quantity, price_type: 'LMT', order_type: 'ROD', ...extra,
});

function tradeOf(order: Partial<OrderResult> & { id: string }, status: Partial<Trade['status']> = {}): Trade {
    return {
        contract: stockContract,
        order: { seqno: order.id, ordno: order.id, action: 'Buy', price: 25, quantity: 5, order_type: 'ROD', price_type: 'LMT', order_lot: 'Common', ...order },
        status: {
            id: order.id, status: 'Submitted', status_code: '', msg: '', order_quantity: order.quantity ?? 5,
            deal_quantity: 0, cancel_quantity: 0, modified_price: 0, deals: [], ...status,
        },
    };
}

function healthBody(environment: 'SIMULATION' | 'PRODUCTION', generation = 1) {
    return {
        ok: true, configured: true, problems: [], environment,
        entry: environment === 'SIMULATION' ? ESUN_SIMULATION_ENTRY : ESUN_PRODUCTION_ENTRY,
        account: { broker_id: '8840', account_id: MOCK_ESUN_ACCOUNT_ID },
        loggedIn: true, loginError: null, sessionGeneration: generation,
    };
}

describe('EsunTradeService', () => {
    let service: EsunTradeService;
    let mockDriver: MockEsunDriver;

    beforeEach(async () => {
        mockDriver = new MockEsunDriver();
        service = new EsunTradeService(mockDriver);
        // 與 bridge 同步：環境為模擬，帳戶為 8840-SIM
        await service.refreshHealth();
    });

    describe('account identity', () => {
        it('keys bridge accounts by environment and keeps the bridge account id as the wire account', () => {
            expect(service.isEnvironmentKnown()).toBe(true);
            expect(service.getAccounts()).toEqual([expect.objectContaining({ broker_id: '8840-SIM', account_id: MOCK_ESUN_ACCOUNT_ID })]);
        });

        it('never fabricates an account: registerEsunAccount() needs a bridge account or a known environment', () => {
            const fresh = new EsunTradeService(new UnavailableEsunDriver());
            expect(() => fresh.registerEsunAccount()).toThrow('尚未回報帳號');
            expect(() => fresh.registerEsunAccount('88401234567')).toThrow('環境尚未確認');
            expect(service.registerEsunAccount()).toMatchObject({ broker_id: '8840-SIM' });
            expect(service.registerEsunAccount('88411234567')).toMatchObject({ broker_id: '8841-SIM', account_id: '1234567' });
        });

        it('registers and clears accounts', () => {
            service.clearAccounts();
            service.registerAccount(simAccount);
            service.registerAccount(simAccount);
            expect(service.getAccounts()).toHaveLength(1);
            service.clearAccounts();
            expect(service.getAccounts()).toHaveLength(0);
        });
    });

    describe('connectBridge', () => {
        it('switches to the bridge driver and registers environment-keyed accounts', async () => {
            const fresh = new EsunTradeService(new UnavailableEsunDriver());
            const mockFetch = vi.fn(async (input: string) => {
                if (input.includes('/esun/health')) return new Response(JSON.stringify(healthBody('PRODUCTION', 7)), { status: 200 });
                if (input.includes('/esun/accounts')) {
                    return new Response(JSON.stringify([{ account_type: 'S', broker_id: '8840', account_id: MOCK_ESUN_ACCOUNT_ID, signed: true, username: '玉山證券', person_id: 'A123456789' }]), { status: 200 });
                }
                return new Response('Not Found', { status: 404 });
            });
            const listener = vi.fn();
            fresh.subscribe(listener);
            const health = await fresh.connectBridge(new HttpEsunDriver('http://127.0.0.1:8090', mockFetch as never));
            expect(health?.configured).toBe(true);
            expect(fresh.getDriver().name).toBe('http-bridge');
            expect(fresh.getAccounts()).toEqual([expect.objectContaining({ broker_id: '8840', account_id: MOCK_ESUN_ACCOUNT_ID, person_id: 'A123456789' })]);
            expect(fresh.getSnapshot()).toMatchObject({ environment: 'PRODUCTION', environmentKnown: true, sessionGeneration: 7, bridgeConnected: true });
            expect(listener).toHaveBeenCalled();
        });

        it('retains the fail-closed driver when the probe fails and retries next time', async () => {
            const fresh = new EsunTradeService(new UnavailableEsunDriver());
            let attempt = 0;
            const driver: any = {
                health: vi.fn(async () => {
                    attempt++;
                    if (attempt === 1) throw new Error('bridge not ready');
                    return healthBody('SIMULATION');
                }),
                accounts: vi.fn(async () => []),
            };
            expect(await fresh.connectBridge(driver)).toBeNull();
            expect(fresh.getDriver().name).toBe('unavailable');
            expect(fresh.isEnvironmentKnown()).toBe(false);
            expect(await fresh.connectBridge(driver)).not.toBeNull();
            expect(fresh.getAccounts().some(a => a.broker_id === '8840-SIM')).toBe(true);
        });
    });

    describe('switchEnvironment (B-03 / D1-02)', () => {
        it('re-keys accounts, updates the session and notifies subscribers on success', async () => {
            const listener = vi.fn();
            service.subscribe(listener);
            const seen: boolean[] = [];
            service.subscribe(() => seen.push(service.getSnapshot().switching));
            const res = await service.switchEnvironment('PRODUCTION');
            expect(res.ok).toBe(true);
            expect(service.getEnvironment()).toBe('PRODUCTION');
            expect(service.getEntryUrl()).toBe(ESUN_PRODUCTION_ENTRY);
            expect(service.getAccounts()).toEqual([expect.objectContaining({ broker_id: '8840' })]);
            expect(service.getSnapshot().switching).toBe(false);
            expect(seen).toContain(true);
            expect(listener).toHaveBeenCalled();
        });

        it('keeps the local environment when the bridge answers HTTP 400', async () => {
            const fetchImpl = vi.fn(async (input: string) => input.includes('/esun/auth/environment')
                ? new Response(JSON.stringify({ ok: false, error: '未提供 esun-config.production.ini' }), { status: 400 })
                : new Response(JSON.stringify(healthBody('SIMULATION')), { status: 200 }));
            service.setDriver(new HttpEsunDriver('', fetchImpl as never));
            const res = await service.switchEnvironment('PRODUCTION');
            expect(res.ok).toBe(false);
            expect(res.error).toContain('esun-config.production.ini');
            expect(service.getEnvironment()).toBe('SIMULATION');
            expect(service.isSimulation()).toBe(true);
            expect(service.getAccounts()[0]?.broker_id).toBe('8840-SIM');
        });

        it('keeps the local environment when the bridge is unreachable', async () => {
            const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
            service.setDriver(new HttpEsunDriver('', fetchImpl as never));
            const res = await service.switchEnvironment('PRODUCTION');
            expect(res.ok).toBe(false);
            expect(service.getEnvironment()).toBe('SIMULATION');
        });

        it('fails when the bridge reports a different environment than requested', async () => {
            const driver: any = {
                name: 'custom',
                health: vi.fn(async () => healthBody('SIMULATION')),
                switchEnvironment: vi.fn(async () => ({ ok: true, environment: 'SIMULATION', entry: ESUN_SIMULATION_ENTRY })),
            };
            service.setDriver(driver);
            const res = await service.switchEnvironment('PRODUCTION');
            expect(res.ok).toBe(false);
            expect(service.getEnvironment()).toBe('SIMULATION');
        });

        it('fails without a connected bridge and refuses a concurrent switch', async () => {
            const offline = new EsunTradeService(new UnavailableEsunDriver());
            expect((await offline.switchEnvironment('PRODUCTION')).ok).toBe(false);

            let release!: () => void;
            const driver: any = {
                name: 'slow',
                health: vi.fn(async () => healthBody('PRODUCTION', 2)),
                switchEnvironment: vi.fn(() => new Promise(resolve => { release = () => resolve({ ok: true, environment: 'PRODUCTION', entry: ESUN_PRODUCTION_ENTRY, sessionGeneration: 2 }); })),
            };
            service.setDriver(driver);
            const first = service.switchEnvironment('PRODUCTION');
            expect(service.getSnapshot().switching).toBe(true);
            const second = await service.switchEnvironment('SIMULATION');
            expect(second.ok).toBe(false);
            expect(second.error).toContain('進行中');
            release();
            expect((await first).ok).toBe(true);
        });

        it('refuses to switch to an environment without a config profile', async () => {
            service.setConfigProfiles({
                PRODUCTION: { available: false, fileName: null, expectedFileName: 'esun-config.production.ini', aliases: [], entry: ESUN_PRODUCTION_ENTRY },
            });
            const res = await service.switchEnvironment('PRODUCTION');
            expect(res.ok).toBe(false);
            expect(res.error).toContain('未提供 esun-config.production.ini 設定檔');
            expect(service.getEnvironment()).toBe('SIMULATION');
        });

        it('does not let config profile detection rewrite a bridge-reported environment', () => {
            service.setConfigProfiles({
                SIMULATION: { available: false, fileName: null, expectedFileName: 'esun-config.simulation.ini', aliases: [], entry: ESUN_SIMULATION_ENTRY },
            });
            expect(service.getEnvironment()).toBe('SIMULATION');
        });

        it('only uses config profiles as a display hint while the environment is unknown', () => {
            const fresh = new EsunTradeService(new UnavailableEsunDriver());
            fresh.setConfigProfiles({
                SIMULATION: { available: false, fileName: null, expectedFileName: 'esun-config.simulation.ini', aliases: [], entry: ESUN_SIMULATION_ENTRY },
            });
            expect(fresh.getEnvironment()).toBe('PRODUCTION');
            expect(fresh.isEnvironmentKnown()).toBe(false);
        });
    });

    describe('session snapshot (§5 session event, health ordering)', () => {
        it('applies a newer session event, re-keys accounts and emits', () => {
            const listener = vi.fn();
            service.subscribe(listener);
            service.applySession({ generation: 5, environment: 'PRODUCTION', account: { broker_id: '8840', account_id: MOCK_ESUN_ACCOUNT_ID }, loggedIn: true });
            expect(service.getEnvironment()).toBe('PRODUCTION');
            expect(service.getSessionGeneration()).toBe(5);
            expect(service.getAccounts()[0]?.broker_id).toBe('8840');
            expect(listener).toHaveBeenCalled();
        });

        it('ignores an older session generation', () => {
            service.applySession({ generation: 5, environment: 'PRODUCTION', account: { broker_id: '8840', account_id: MOCK_ESUN_ACCOUNT_ID } });
            service.applySession({ generation: 4, environment: 'SIMULATION', account: { broker_id: '8840', account_id: MOCK_ESUN_ACCOUNT_ID } });
            expect(service.getEnvironment()).toBe('PRODUCTION');
        });

        it('drops a slow health answer that started before a switch completed', async () => {
            let resolveHealth!: (value: unknown) => void;
            const driver: any = {
                name: 'custom',
                health: vi.fn(() => new Promise(resolve => { resolveHealth = resolve; })),
                switchEnvironment: vi.fn(async () => ({ ok: true, environment: 'PRODUCTION', entry: ESUN_PRODUCTION_ENTRY })),
            };
            const fresh = new EsunTradeService(driver);
            const slow = fresh.refreshHealth();
            const stale = resolveHealth;
            await fresh.switchEnvironment('PRODUCTION');
            stale({ ...healthBody('SIMULATION'), sessionGeneration: undefined });
            await slow;
            expect(fresh.getEnvironment()).toBe('PRODUCTION');
        });
    });

    describe('placeStockOrder', () => {
        it('binds the order to the account environment and the bridge account id', async () => {
            const beforeDispatch = vi.fn();
            const onResponse = vi.fn();
            const trade = await service.placeStockOrder(stockContract, limitBuy(2, { custom_field: 'test-tag' }), simAccount, { beforeDispatch, onResponse });
            expect(mockDriver.lastGuard).toEqual({ expected_environment: 'SIMULATION', expected_account: MOCK_ESUN_ACCOUNT_ID });
            expect(beforeDispatch).toHaveBeenCalledOnce();
            expect(onResponse).toHaveBeenCalledOnce();
            expect(trade.order.ordno).toMatch(/^E\d+/);
            expect(trade.order.id).toBe(trade.order.ordno);
            expect(trade.status.status).toBe('Submitted');
            expect(trade.order.custom_field).toBe('test-tag');
        });

        it('treats a snake_case ret_code rejection as not sent (B-05)', async () => {
            mockDriver.simulateFailure = '市場已收盤，無法下單';
            await expect(service.placeStockOrder(stockContract, limitBuy(1), simAccount)).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('市場已收盤'),
            });
        });

        it('treats an accepted answer without an order number as an unknown outcome', async () => {
            vi.spyOn(mockDriver, 'placeOrder').mockResolvedValueOnce({ ret_code: '000000' });
            const error = await service.placeStockOrder(stockContract, limitBuy(1), simAccount).catch(e => e);
            expect(error.mutationOutcomeUnknown).toBe(true);
            expect('mutationNotStarted' in error).toBe(false);
        });

        it('refuses a bridge switched elsewhere (409) as not sent and resyncs the environment (B-04 / C-01)', async () => {
            mockDriver.setBridgeEnvironment('PRODUCTION');
            const error = await service.placeStockOrder(stockContract, limitBuy(1), simAccount).catch(e => e);
            expect(error).toBeInstanceOf(EsunBridgeError);
            expect(error.mutationNotStarted).toBe(true);
            expect(error.message).toContain('其他視窗或裝置');
            await vi.waitFor(() => expect(service.getEnvironment()).toBe('PRODUCTION'));
            expect(service.getAccounts()[0]?.broker_id).toBe('8840');
        });

        it('refuses locally before dispatch when the account belongs to the other environment', async () => {
            const beforeDispatch = vi.fn();
            const placeOrder = vi.spyOn(mockDriver, 'placeOrder');
            await expect(service.placeStockOrder(stockContract, limitBuy(1), prodAccount, { beforeDispatch })).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('正式環境'),
            });
            expect(beforeDispatch).not.toHaveBeenCalled();
            expect(placeOrder).not.toHaveBeenCalled();
        });

        it('marks a caller beforeDispatch refusal as not sent', async () => {
            await expect(service.placeStockOrder(stockContract, limitBuy(1), simAccount, {
                beforeDispatch: () => { throw new Error('有效期已過'); },
            })).rejects.toMatchObject({ mutationNotStarted: true, message: '有效期已過' });
        });

        it('rejects non-E.SUN accounts, out-of-range sheets and emerging stocks before dispatching', async () => {
            await expect(service.placeStockOrder(stockContract, limitBuy(1), otherAccount)).rejects.toMatchObject({ mutationNotStarted: true });
            const beforeDispatch = vi.fn();
            await expect(service.placeStockOrder(stockContract, limitBuy(500), simAccount, { beforeDispatch }))
                .rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('1 至 499 張') });
            await expect(service.placeStockOrder({ ...stockContract, exchange: 'OES' }, limitBuy(2), simAccount, { beforeDispatch }))
                .rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('興櫃') });
            expect(beforeDispatch).not.toHaveBeenCalled();
        });
    });

    describe('cancelOrder (B-06)', () => {
        it('only reports "sent": never fabricates Cancelled, cancel quantity or zero fills', async () => {
            const placed = await service.placeStockOrder(stockContract, limitBuy(3), simAccount);
            const before = { ...placed, status: { ...placed.status, deal_quantity: 1 } };
            const beforeDispatch = vi.fn();
            const res = await service.cancelOrder(before, simAccount, { beforeDispatch });
            expect(beforeDispatch).toHaveBeenCalledOnce();
            expect(res.status.status).toBe('Submitted');
            expect(res.status.cancel_quantity).toBe(0);
            expect(res.status.deal_quantity).toBe(1);
            expect(res.status.msg).toContain('刪單已送出');
            expect(mockDriver.lastGuard?.expected_environment).toBe('SIMULATION');
        });

        it('supports the (contract, order, account) and (tradeId, account) forms', async () => {
            const order: OrderResult = { id: 'E00001', seqno: 'E00001', ordno: 'E00001', action: 'Buy', price: 25.0, quantity: 2 };
            await expect(service.cancelOrder(stockContract, order, simAccount)).resolves.toMatchObject({ order: { ordno: 'E00001' } });
            await expect(service.cancelOrder('E00001', simAccount)).resolves.toMatchObject({ order: { ordno: 'E00001' } });
        });

        it('treats a broker refusal as not sent and rejects a missing order number', async () => {
            mockDriver.simulateFailure = '委託已成交';
            await expect(service.cancelOrder(tradeOf({ id: 'E00009' }), simAccount)).rejects.toMatchObject({ mutationNotStarted: true });
            mockDriver.simulateFailure = null;
            await expect(service.cancelOrder(stockContract, { id: '', seqno: '', ordno: '', action: 'Buy', price: 25, quantity: 1 }, simAccount))
                .rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('缺少玉山證券委託編號') });
        });
    });

    describe('updateOrderPrice', () => {
        it('sends the new price and reports "sent" without rewriting the order', async () => {
            const trade = tradeOf({ id: 'E00002' });
            const res = await service.updateOrderPrice(trade, 25.5, simAccount);
            expect(res.order.price).toBe(25);
            expect(res.status.msg).toContain('25.5');
        });

        it('blocks reservations, non-ROD/limit orders, odd lots and invalid prices', async () => {
            await expect(service.updateOrderPrice(tradeOf({ id: 'R1', ordno: '' }, { status: 'PreSubmitted' }), 26, simAccount))
                .rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('AG0006') });
            await expect(service.updateOrderPrice(tradeOf({ id: 'E2', order_type: 'IOC' }), 26, simAccount))
                .rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('ROD 限價單') });
            await expect(service.updateOrderPrice(tradeOf({ id: 'E3', order_lot: 'IntradayOdd', quantity: 100 }), 26, simAccount))
                .rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('零股委託不能改價') });
            await expect(service.updateOrderPrice(tradeOf({ id: 'E4' }), -1, simAccount))
                .rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('大於 0') });
        });
    });

    describe('updateOrderQty — reduce-by semantics (B-02 / C-V1-1)', () => {
        it('sends the reduction (not the new total) and leaves the remaining quantity at the broker', async () => {
            const placed = await service.placeStockOrder(stockContract, limitBuy(5), simAccount);
            // 委託列：目前剩餘 5、想改成剩 1 → 上游呼叫 updateOrderQty(id, 5 - 1)
            const res = await service.updateOrderQty(placed, 4, simAccount);
            expect(mockDriver.lastUnit).toBe('lot');
            expect(res.order.quantity).toBe(5);
            const [row] = await service.fetchTrades(simAccount, true);
            expect(row?.status.cancel_quantity).toBe(4);
            expect(row!.order.quantity - row!.status.cancel_quantity - row!.status.deal_quantity).toBe(1);
        });

        it('sends odd-lot reductions in shares', async () => {
            const placed = await service.placeStockOrder(stockContract, limitBuy(300, { order_lot: 'IntradayOdd' }), simAccount);
            await service.updateOrderQty(placed, 100, simAccount);
            expect(mockDriver.lastUnit).toBe('share');
            const [row] = await service.fetchTrades(simAccount, true);
            expect(row?.order.quantity).toBe(300);
            expect(row?.status.cancel_quantity).toBe(100);
        });

        it('requires 0 < reduction <= remaining (after fills and earlier reductions)', async () => {
            const trade = tradeOf({ id: 'E5', quantity: 5 }, { deal_quantity: 2, status: 'PartFilled' });
            await expect(service.updateOrderQty(trade, 0, simAccount)).rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('正整數') });
            await expect(service.updateOrderQty(trade, 4, simAccount)).rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('剩餘 3') });
            await expect(service.updateOrderQty(trade, 3, simAccount)).resolves.toBeDefined();
        });

        it('blocks reservations and refuses when only an order number is known', async () => {
            await expect(service.updateOrderQty(tradeOf({ id: 'R2', ordno: '' }, { status: 'PreSubmitted' }), 1, simAccount))
                .rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('AG0006') });
            await expect(service.updateOrderQty('E00003', 2, simAccount))
                .rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('剩餘數量') });
            const order: OrderResult = { id: 'E00003', seqno: 'E00003', ordno: 'E00003', action: 'Buy', price: 25.0, quantity: 5 };
            await expect(service.updateOrderQty(stockContract, order, 2, simAccount)).resolves.toBeDefined();
        });
    });

    describe('portfolio queries', () => {
        it('maps the SDK snake_case order results of the bridge', async () => {
            await service.placeStockOrder(stockContract, limitBuy(1), simAccount);
            const trades = await service.fetchTrades(simAccount);
            expect(trades).toHaveLength(1);
            expect(trades[0]).toMatchObject({ contract: { code: '2884' }, order: { action: 'Buy', quantity: 1 }, status: { status: 'Submitted' } });
        });

        it('queries positions, balance, settlements, P&L, limits and reserve summary', async () => {
            expect((await service.fetchPositions(simAccount, 'Common'))[0]?.quantity).toBe(2);
            expect((await service.fetchPositions(simAccount, 'Share'))[0]?.quantity).toBe(2000);
            expect((await service.fetchAccountBalance(simAccount)).acc_balance).toBe(500000);
            expect(await service.fetchSettlements(simAccount)).toHaveLength(3);
            expect((await service.fetchProfitLoss(simAccount, '20261001', '20261023'))[0]?.pnl).toBe(2500);
            expect((await service.fetchProfitLossSummary(simAccount, '20261001', '20261023')).total.pnl).toBe(2500);
            expect((await service.fetchTradingLimits(simAccount)).trading_available).toBe(800000);
            const reserve = await service.fetchStockReserveSummary(simAccount);
            expect(reserve.stocks).toEqual([]);
            expect(reserve.account).toBe(simAccount);
        });

        it('refuses other brokers, the other environment and accounts the bridge did not log in', async () => {
            await expect(service.fetchPositions(otherAccount)).rejects.toThrow('非玉山證券帳戶');
            await expect(service.fetchTrades(otherAccount)).rejects.toThrow('非玉山證券帳戶');
            await expect(service.fetchTrades(prodAccount)).rejects.toThrow('正式環境');
            await expect(service.fetchAccountBalance({ ...simAccount, account_id: '7654321' })).rejects.toThrow('不是 esun-bridge 目前登入的帳戶');
        });

        it('fails closed when the bridge is not connected', async () => {
            const offline = new EsunTradeService(new UnavailableEsunDriver());
            offline.registerAccount(simAccount);
            await expect(offline.fetchTrades(simAccount)).rejects.toThrow('未連線');
            await expect(offline.fetchAccountBalance(simAccount)).rejects.toThrow('未連線');
        });

        it('propagates CA expiry errors instead of reporting an empty expiry', async () => {
            expect(await service.fetchCaExpire()).toBe('2027-12-31');
            const offline = new EsunTradeService(new UnavailableEsunDriver());
            await expect(offline.fetchCaExpire()).rejects.toThrow();
        });
    });

    describe('config ini helpers', () => {
        it('parses esun-config.ini SIMULATION vs PRODUCTION rules correctly', () => {
            const parsedSim = parseEsunConfigEnvironment(`
[Core]
Entry = https://esuntradingapi-simulation.esunsec.com.tw/api/v1
Environment = SIMULATION
`);
            expect(parsedSim).toMatchObject({ environment: 'SIMULATION', hasEnvironmentKey: true, entry: ESUN_SIMULATION_ENTRY });
            const parsedProd = parseEsunConfigEnvironment(`
[Core]
Entry = https://esuntradingapi.esunsec.com.tw/api/v1
`);
            expect(parsedProd).toMatchObject({ environment: 'PRODUCTION', hasEnvironmentKey: false, entry: ESUN_PRODUCTION_ENTRY });
        });

        it('formats the [Core] section between environments', () => {
            const sim = `[Core]
Entry = https://esuntradingapi-simulation.esunsec.com.tw/api/v1
Environment = SIMULATION

[User]
Account = 88401234567`;
            const prod = formatEsunConfigCoreSection(sim, 'PRODUCTION');
            expect(prod).toContain(`Entry = ${ESUN_PRODUCTION_ENTRY}`);
            expect(prod).not.toContain('Environment');
            expect(parseEsunConfigEnvironment(formatEsunConfigCoreSection(prod, 'SIMULATION')).environment).toBe('SIMULATION');
        });
    });
});
