// 委託確認視窗：玉山帳戶顯示玉山 bridge 的環境，確認期間玉山環境變了就失效（C-02 / D2-04）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rt = vi.hoisted(() => ({ base: '' }));
vi.mock('./runtime', () => ({ getApiBase: () => rt.base, isTauri: false }));
// 永豐 sidecar 在模擬模式（README 推薦的「永豐模擬取行情、玉山正式下單」）
vi.mock('./shioaji', () => ({
    fetchInfo: vi.fn(async () => {
        const store = await import('./server-info-store');
        const info = { simulation: true };
        store.observeServerInfo(store.beginServerInfoRequest(), info as never);
        return info;
    }),
}));

import {
    accountConfirmLabel,
    getPendingOrderConfirm,
    requestOrderConfirm,
    resetOrderConfirmForTest,
    resolveOrderConfirm,
    ORDER_CONFIRM_SERVER_CHANGED,
} from './order-confirm';
import { MockEsunDriver } from './esun/mock-driver';
import { esunTradeService } from './esun/service';

const esunProd = { broker_id: '8840', account_id: '1234567' };
const req = { code: '2330', name: '台積電', action: 'Buy' as const, price: 1000, quantity: 1, unit: '張' };

beforeEach(async () => {
    esunTradeService.setDriver(new MockEsunDriver());
    await esunTradeService.switchEnvironment('PRODUCTION');
});

afterEach(() => {
    resetOrderConfirmForTest();
    vi.clearAllMocks();
});

describe('requestOrderConfirm for E.SUN accounts', () => {
    it('labels the account 玉山證券 and shows the E.SUN production badge while SinoPac is in simulation', async () => {
        const accountLabel = accountConfirmLabel(esunProd);
        expect(accountLabel).toBe('玉山證券-***4567');
        const promise = requestOrderConfirm({ ...req, accountLabel });
        await vi.waitFor(() => expect(getPendingOrderConfirm()?.awaitingMode).toBe(false));
        expect(getPendingOrderConfirm()?.simulation).toBe(false);
        resolveOrderConfirm(false);
        await expect(promise).resolves.toBe(false);
    });

    it('keeps the SinoPac badge for SinoPac accounts', async () => {
        const promise = requestOrderConfirm({ ...req, accountLabel: accountConfirmLabel({ broker_id: '9A95', account_id: '7654321' }) });
        await vi.waitFor(() => expect(getPendingOrderConfirm()?.awaitingMode).toBe(false));
        expect(getPendingOrderConfirm()?.simulation).toBe(true);
        resolveOrderConfirm(false);
        await promise;
    });

    it('refuses the approval when the E.SUN environment changed while the dialog was open', async () => {
        const promise = requestOrderConfirm({ ...req, accountLabel: accountConfirmLabel(esunProd) });
        await vi.waitFor(() => expect(getPendingOrderConfirm()?.awaitingMode).toBe(false));
        await esunTradeService.switchEnvironment('SIMULATION');
        await vi.waitFor(() => expect(getPendingOrderConfirm()?.serverChanged).toBe(true));
        resolveOrderConfirm(true);
        await expect(promise).rejects.toMatchObject({ message: ORDER_CONFIRM_SERVER_CHANGED, mutationNotStarted: true });
    });
});
