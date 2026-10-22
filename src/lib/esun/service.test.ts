// src/lib/esun/service.test.ts — Unit tests for EsunTradeService

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase } from '../types/contract';
import type { OrderResult, StockOrderReq, Trade } from '../types/order';
import type { Account } from '../types/portfolio';
import { MockEsunDriver } from './mock-driver';
import { HttpEsunDriver } from './http-driver';
import { EsunTradeService } from './service';
import { ESUN_BROKER_CODE } from './types';

const esunAccount: Account = {
    account_type: 'S',
    broker_id: ESUN_BROKER_CODE,
    account_id: '9600123',
    signed: true,
    username: '測試玉山帳戶',
    person_id: 'A123456789',
};

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

describe('EsunTradeService', () => {
    let service: EsunTradeService;
    let mockDriver: MockEsunDriver;

    beforeEach(() => {
        mockDriver = new MockEsunDriver();
        service = new EsunTradeService(mockDriver);
    });

    describe('account management and configuration', () => {
        it('registers and retrieves accounts', () => {
            service.registerAccount(esunAccount);
            expect(service.getAccounts()).toHaveLength(1);
            expect(service.getAccounts()[0]?.account_id).toBe('9600123');

            // does not duplicate identical account
            service.registerAccount(esunAccount);
            expect(service.getAccounts()).toHaveLength(1);

            service.clearAccounts();
            expect(service.getAccounts()).toHaveLength(0);
        });

        it('auto-registers account when aid is provided in config', () => {
            service.configure({ aid: '9600999', apiKey: 'test-key' });
            const accounts = service.getAccounts();
            expect(accounts).toHaveLength(1);
            expect(accounts[0]?.broker_id).toBe(ESUN_BROKER_CODE);
            expect(accounts[0]?.account_id).toBe('9600999');
            expect(service.getConfig().apiKey).toBe('test-key');
        });
    });

    describe('connectBridge', () => {
        it('switches to the bridge driver and registers bridge accounts on success', async () => {
            const mockFetch = vi.fn(async (input: string) => {
                if (input.includes('/esun/health')) {
                    return new Response(JSON.stringify({
                        ok: true,
                        configured: true,
                        problems: [],
                        environment: 'SIMULATION',
                        account: { broker_id: '8840', account_id: '0664718' },
                        loggedIn: true,
                        loginError: null,
                    }), { status: 200 });
                }
                if (input.includes('/esun/accounts')) {
                    return new Response(JSON.stringify([
                        {
                            account_type: 'S',
                            broker_id: '8840',
                            account_id: '0664718',
                            signed: true,
                            username: '玉山證券',
                            person_id: 'A123456789',
                        },
                    ]), { status: 200 });
                }
                return new Response('Not Found', { status: 404 });
            });

            const bridgeDriver = new HttpEsunDriver('http://127.0.0.1:8090', mockFetch as never);
            service.clearAccounts();
            const health = await service.connectBridge(bridgeDriver);

            expect(health?.configured).toBe(true);
            expect(service.getDriver().name).toBe('http-bridge');
            expect(service.getAccounts()).toHaveLength(1);
            expect(service.getAccounts()[0]?.broker_id).toBe('8840');
            expect(service.getBridgeHealth()?.ok).toBe(true);
        });

        it('retains fail-closed driver when bridge probe fails', async () => {
            const failingFetch = vi.fn(async () => {
                throw new Error('Connection refused');
            });
            const bridgeDriver = new HttpEsunDriver('http://127.0.0.1:8090', failingFetch as never);
            const health = await service.connectBridge(bridgeDriver);
            expect(health).toBeNull();
            expect(service.getDriver().name).toBe('mock');
        });
    });

    describe('fetchCaExpire', () => {
        it('fetches ca_expiretime from driver', async () => {
            const expire = await service.fetchCaExpire();
            expect(expire).toBe('2027-12-31');
        });
    });

    describe('placeStockOrder', () => {
        it('places order successfully via driver', async () => {
            service.registerAccount(esunAccount);
            const req: StockOrderReq = {
                action: 'Buy',
                price: 25.0,
                quantity: 2,
                price_type: 'LMT',
                order_type: 'ROD',
                custom_field: 'test-tag',
            };

            const beforeDispatch = vi.fn();
            const onResponse = vi.fn();

            const trade = await service.placeStockOrder(stockContract, req, esunAccount, {
                beforeDispatch,
                onResponse,
            });

            expect(beforeDispatch).toHaveBeenCalledOnce();
            expect(onResponse).toHaveBeenCalledOnce();
            expect(trade.contract.code).toBe('2884');
            expect(trade.order.ordno).toMatch(/^E\d+/);
            expect(trade.order.quantity).toBe(2);
            expect(trade.order.price).toBe(25.0);
            expect(trade.status.status).toBe('Submitted');
            expect(trade.order.custom_field).toBe('test-tag');
        });

        it('rejects order with non-E.SUN account', async () => {
            const req: StockOrderReq = {
                action: 'Buy',
                price: 25.0,
                quantity: 1,
                price_type: 'LMT',
                order_type: 'ROD',
            };

            await expect(
                service.placeStockOrder(stockContract, req, otherAccount),
            ).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('非玉山證券帳戶'),
            });
        });

        it('rejects order exceeding 499 sheets before dispatching', async () => {
            const req: StockOrderReq = {
                action: 'Buy',
                price: 25.0,
                quantity: 500,
                price_type: 'LMT',
                order_type: 'ROD',
            };

            const beforeDispatch = vi.fn();
            await expect(
                service.placeStockOrder(stockContract, req, esunAccount, { beforeDispatch }),
            ).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('1 至 499 張'),
            });
            expect(beforeDispatch).not.toHaveBeenCalled();
        });

        it('handles driver error and sets mutationNotStarted', async () => {
            mockDriver.simulateFailure = '市場已收盤，無法下單';
            const req: StockOrderReq = {
                action: 'Buy',
                price: 25.0,
                quantity: 1,
                price_type: 'LMT',
                order_type: 'ROD',
            };

            await expect(
                service.placeStockOrder(stockContract, req, esunAccount),
            ).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('市場已收盤'),
            });
        });
    });

    describe('cancelOrder', () => {
        it('cancels order with (contract, order, account)', async () => {
            const order: OrderResult = {
                id: 'E00001',
                seqno: 'E00001',
                ordno: 'E00001',
                action: 'Buy',
                price: 25.0,
                quantity: 2,
            };

            const beforeDispatch = vi.fn();
            const trade = await service.cancelOrder(stockContract, order, esunAccount, {
                beforeDispatch,
            });

            expect(beforeDispatch).toHaveBeenCalledOnce();
            expect(trade.status.status).toBe('Cancelled');
            expect(trade.status.cancel_quantity).toBe(2);
        });

        it('cancels order with (tradeId, account)', async () => {
            const beforeDispatch = vi.fn();
            const trade = await service.cancelOrder('E00001', esunAccount, { beforeDispatch });
            expect(beforeDispatch).toHaveBeenCalledOnce();
            expect(trade.status.status).toBe('Cancelled');
            expect(trade.order.ordno).toBe('E00001');
        });

        it('cancels order with Trade object', async () => {
            const tradeObj: Trade = {
                contract: stockContract,
                order: {
                    id: 'E00002',
                    seqno: 'E00002',
                    ordno: 'E00002',
                    action: 'Buy',
                    price: 25.0,
                    quantity: 3,
                },
                status: {
                    id: 'E00002',
                    status: 'Submitted',
                    status_code: '000000',
                    msg: '',
                    order_quantity: 3,
                    deal_quantity: 0,
                    cancel_quantity: 0,
                    modified_price: 0,
                    deals: [],
                },
            };

            const res = await service.cancelOrder(tradeObj, esunAccount);
            expect(res.status.status).toBe('Cancelled');
        });

        it('rejects cancel without order number', async () => {
            const order: OrderResult = {
                id: '',
                seqno: '',
                ordno: '',
                action: 'Buy',
                price: 25.0,
                quantity: 1,
            };

            await expect(
                service.cancelOrder(stockContract, order, esunAccount),
            ).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('缺少玉山證券委託編號'),
            });
        });
    });

    describe('updateOrderPrice', () => {
        const order: OrderResult = {
            id: 'E00002',
            seqno: 'E00002',
            ordno: 'E00002',
            action: 'Buy',
            price: 25.0,
            quantity: 5,
            order_type: 'ROD',
            price_type: 'LMT',
        };

        it('updates price successfully with (contract, order, price, account)', async () => {
            const trade = await service.updateOrderPrice(stockContract, order, 25.5, esunAccount);
            expect(trade.order.price).toBe(25.5);
            expect(trade.status.modified_price).toBe(25.5);
        });

        it('updates price successfully with (tradeId, price, account)', async () => {
            const trade = await service.updateOrderPrice('E00002', 25.5, esunAccount);
            expect(trade.order.price).toBe(25.5);
        });

        it('blocks reservation order on price modification (AG0006)', async () => {
            const reservationTrade: Trade = {
                contract: stockContract,
                order,
                status: {
                    id: 'E00002',
                    status: 'PreSubmitted',
                    status_code: '1',
                    msg: '',
                    order_quantity: 5,
                    deal_quantity: 0,
                    cancel_quantity: 0,
                    modified_price: 0,
                    deals: [],
                },
            };

            await expect(
                service.updateOrderPrice(reservationTrade, 26.0, esunAccount),
            ).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('AG0006'),
            });
        });

        it('blocks non-ROD or Market price orders on price update', async () => {
            const iocTrade: Trade = {
                contract: stockContract,
                order: { ...order, order_type: 'IOC' },
                status: {
                    id: 'E00002',
                    status: 'Submitted',
                    status_code: '000000',
                    msg: '',
                    order_quantity: 5,
                    deal_quantity: 0,
                    cancel_quantity: 0,
                    modified_price: 0,
                    deals: [],
                },
            };

            await expect(
                service.updateOrderPrice(iocTrade, 26.0, esunAccount),
            ).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('ROD 限價單'),
            });
        });

        it('rejects invalid price', async () => {
            await expect(
                service.updateOrderPrice(stockContract, order, -1, esunAccount),
            ).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('大於 0'),
            });
        });
    });

    describe('updateOrderQty', () => {
        const order: OrderResult = {
            id: 'E00003',
            seqno: 'E00003',
            ordno: 'E00003',
            action: 'Buy',
            price: 25.0,
            quantity: 5,
        };

        it('updates quantity successfully with (contract, order, qty, account)', async () => {
            const trade = await service.updateOrderQty(stockContract, order, 2, esunAccount);
            expect(trade.order.quantity).toBe(2);
            expect(trade.status.order_quantity).toBe(2);
            expect(trade.status.cancel_quantity).toBe(3);
        });

        it('updates quantity successfully with (tradeId, qty, account)', async () => {
            const trade = await service.updateOrderQty('E00003', 2, esunAccount);
            expect(trade.order.quantity).toBe(2);
        });

        it('blocks reservation order on quantity modification (AG0006)', async () => {
            const reservationTrade: Trade = {
                contract: stockContract,
                order,
                status: {
                    id: 'E00003',
                    status: 'PreSubmitted',
                    status_code: '1',
                    msg: '',
                    order_quantity: 5,
                    deal_quantity: 0,
                    cancel_quantity: 0,
                    modified_price: 0,
                    deals: [],
                },
            };

            await expect(
                service.updateOrderQty(reservationTrade, 3, esunAccount),
            ).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('AG0006'),
            });
        });

        it('rejects invalid quantity', async () => {
            await expect(
                service.updateOrderQty(stockContract, order, 0, esunAccount),
            ).rejects.toMatchObject({
                mutationNotStarted: true,
                message: expect.stringContaining('正整數'),
            });
        });
    });

    describe('Portfolio queries', () => {
        it('queries trades', async () => {
            await service.placeStockOrder(
                stockContract,
                { action: 'Buy', price: 25, quantity: 1, price_type: 'LMT', order_type: 'ROD' },
                esunAccount,
            );

            const trades = await service.fetchTrades(esunAccount);
            expect(trades).toHaveLength(1);
            expect(trades[0]?.contract.code).toBe('2884');
            expect(trades[0]?.order.action).toBe('Buy');
        });

        it('queries positions with Common and Share units', async () => {
            const posCommon = await service.fetchPositions(esunAccount, 'Common');
            expect(posCommon).toHaveLength(1);
            expect(posCommon[0]?.quantity).toBe(2);

            const posShare = await service.fetchPositions(esunAccount, 'Share');
            expect(posShare).toHaveLength(1);
            expect(posShare[0]?.quantity).toBe(2000);
        });

        it('queries account balance', async () => {
            const balance = await service.fetchAccountBalance(esunAccount);
            expect(balance.acc_balance).toBe(500000);
        });

        it('queries settlements', async () => {
            const settlements = await service.fetchSettlements(esunAccount);
            expect(settlements).toHaveLength(3);
            expect(settlements[0]?.amount).toBe(50000);
        });

        it('queries profit loss and summary', async () => {
            const pl = await service.fetchProfitLoss(esunAccount, '20261001', '20261023');
            expect(pl).toHaveLength(1);
            expect(pl[0]?.pnl).toBe(2500);

            const summary = await service.fetchProfitLossSummary(esunAccount, '20261001', '20261023');
            expect(summary.profitloss_sum).toHaveLength(1);
            expect(summary.total.pnl).toBe(2500);
        });

        it('queries trading limits', async () => {
            const limits = await service.fetchTradingLimits(esunAccount);
            expect(limits.trading_limit).toBe(1000000);
            expect(limits.trading_available).toBe(800000);
        });

        it('queries stock reserve summary', async () => {
            const reserve = await service.fetchStockReserveSummary(esunAccount);
            expect(reserve.stocks).toHaveLength(1);
            expect(reserve.stocks[0]?.reserved_share).toBe(15000);
        });

        it('rejects portfolio queries with non-Esun account', async () => {
            await expect(service.fetchPositions(otherAccount)).rejects.toThrow('非玉山證券帳戶');
            await expect(service.fetchAccountBalance(otherAccount)).rejects.toThrow('非玉山證券帳戶');
            await expect(service.fetchSettlements(otherAccount)).rejects.toThrow('非玉山證券帳戶');
            await expect(service.fetchProfitLoss(otherAccount)).rejects.toThrow('非玉山證券帳戶');
            await expect(service.fetchProfitLossSummary(otherAccount)).rejects.toThrow('非玉山證券帳戶');
            await expect(service.fetchTradingLimits(otherAccount)).rejects.toThrow('非玉山證券帳戶');
            await expect(service.fetchStockReserveSummary(otherAccount)).rejects.toThrow('非玉山證券帳戶');
        });
    });
});
