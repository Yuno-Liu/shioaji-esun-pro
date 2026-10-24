// src/lib/esun/dispatch-cancel.test.ts — 玉山刪單確認回讀遇到 bridge refresh 間隔（R2-01）
//
// bridge 的 refresh=true 有最短間隔與每分鐘次數限制；額度不足時回 429 AGR0005 並附 retry_after。
// 「全部刪單／全平並取消」先做一次 refresh:true 再立刻刪單，刪單後約 3 秒的確認回讀可能落在間隔內：
// 確認回讀要依 retry_after（上限 6 秒）重讀一次，不能直接當成 CANCEL_UNCONFIRMED。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../types/portfolio';

const m = vi.hoisted(() => ({ accounts: [] as Account[] }));

vi.mock('./stream', () => ({
    ensureEsunOrderStream: vi.fn(),
    isEsunStreamStarted: () => true,
    getEsunStreamStatus: () => 'live',
    onEsunStreamSignal: () => () => undefined,
}));

vi.mock('../account-store', () => ({
    getAccountState: () => ({ accounts: m.accounts, selectedStock: m.accounts[0] ?? null, selectedFutures: null, loaded: true, loadError: false }),
    replaceExternalAccountsForBroker: vi.fn(),
    registerExternalAccounts: vi.fn(),
}));

import { cancelEsunOrder } from './dispatch';
import { EsunBridgeError } from './http-driver';
import { MOCK_ESUN_ACCOUNT_ID, MockEsunDriver } from './mock-driver';
import { esunTradeService } from './service';
import type { EsunOrderResult } from './types';

const account: Account = {
    account_type: 'S', broker_id: '8840-SIM', account_id: MOCK_ESUN_ACCOUNT_ID, signed: true, username: '玉山證券', person_id: '',
};

/** 與 bridge 相同的 refresh=true 最短間隔：間隔內回 429 AGR0005（retry_after 為剩餘秒數，無條件進位） */
class IntervalLimitedDriver extends MockEsunDriver {
    lastRefresh = Number.NEGATIVE_INFINITY;
    refreshCalls = 0;
    rejected = 0;
    async getOrders(refresh = false): Promise<EsunOrderResult[]> {
        if (refresh) {
            this.refreshCalls += 1;
            const wait = 5_000 - (Date.now() - this.lastRefresh);
            if (wait > 0) {
                this.rejected += 1;
                throw new EsunBridgeError('委託查詢過於頻繁（refresh 最短間隔 5 秒）', 429, { code: 'AGR0005', retryAfter: Math.ceil(wait / 1000) });
            }
            this.lastRefresh = Date.now();
        }
        return super.getOrders();
    }
}

describe('cancelEsunOrder confirmation read under the bridge refresh interval (R2-01)', () => {
    let driver: IntervalLimitedDriver;

    beforeEach(async () => {
        vi.useFakeTimers();
        driver = new IntervalLimitedDriver();
        esunTradeService.setDriver(driver);
        await esunTradeService.switchEnvironment('SIMULATION');
        m.accounts = [account];
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const placeOne = async () => {
        const trade = await esunTradeService.placeStockOrder(
            { code: '2884', security_type: 'STK', exchange: 'TSE', target_code: null },
            { action: 'Buy', price: 25, quantity: 2, price_type: 'LMT', order_type: 'ROD', order_lot: 'Common' },
            account,
        );
        return { ...trade, account };
    };

    it('re-reads once after retry_after instead of reporting CANCEL_UNCONFIRMED', async () => {
        const placed = await placeOne();
        // 全部刪單：先對玉山帳戶做一次 refresh:true，接著立刻刪單
        await esunTradeService.fetchTrades(account, true);
        const pending = cancelEsunOrder(placed, account).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(10_000);
        const result = await pending;
        expect(result).toMatchObject({ status: { status: 'Cancelled', cancel_quantity: 2 } });
        expect(driver.rejected).toBe(1);
        expect(driver.refreshCalls).toBe(3);
    });

    it('caps the wait at 6 s and still fails closed when the bridge keeps refusing', async () => {
        const placed = await placeOne();
        driver.lastRefresh = Number.POSITIVE_INFINITY; // 每次都在間隔內
        const pending = cancelEsunOrder(placed, account).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(3_100);
        expect(driver.refreshCalls).toBe(1);
        await vi.advanceTimersByTimeAsync(5_800);
        expect(driver.refreshCalls).toBe(1);
        await vi.advanceTimersByTimeAsync(300);
        expect(driver.refreshCalls).toBe(2); // 只重讀一次
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await pending).toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
        expect(driver.refreshCalls).toBe(2);
    });
});
