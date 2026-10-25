// src/lib/esun/reconnect.test.ts — 玉山登入失效（台北換日 token 失效）後的重新連線與擋單
// 測試資料全部是合成的佔位值（不是真實帳號、委託書號或金額）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyOrderError, orderErrorNotice } from '../order-outcome';
import type { ContractBase } from '../types/contract';
import type { StockOrderReq } from '../types/order';
import type { Account } from '../types/portfolio';
import type { EsunReconnectResponse } from './adapter';
import { EsunBridgeError, ESUN_RECONNECT_TIMEOUT_MS, HttpEsunDriver } from './http-driver';
import { MOCK_ESUN_ACCOUNT_ID, MockEsunDriver } from './mock-driver';
import { EsunTradeService } from './service';
import { ESUN_BROKER_CODE, EsunApCode, EsunBsFlag, EsunPriceFlag, EsunSide, EsunTradeType, type EsunOrderPayload } from './types';

const payload: EsunOrderPayload = {
    stockNo: '2884',
    buySell: EsunSide.Buy,
    price: 25,
    quantity: 1,
    apCode: EsunApCode.Common,
    priceFlag: EsunPriceFlag.Limit,
    bsFlag: EsunBsFlag.ROD,
    trade: EsunTradeType.Cash,
};

const simAccount: Account = {
    account_type: 'S',
    broker_id: `${ESUN_BROKER_CODE}-SIM`,
    account_id: MOCK_ESUN_ACCOUNT_ID,
    signed: true,
    username: '測試玉山帳戶',
    person_id: 'A123456789',
};

const contract: ContractBase = { code: '2884', security_type: 'STK', exchange: 'TSE', target_code: null };
const order: StockOrderReq = { action: 'Buy', price: 25, quantity: 1, price_type: 'LMT', order_type: 'ROD' };

function reply(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

async function caught(promise: Promise<unknown>): Promise<Record<string, unknown> & Error> {
    try {
        await promise;
    } catch (e) {
        return e as Record<string, unknown> & Error;
    }
    throw new Error('expected rejection');
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('HttpEsunDriver.reconnect', () => {
    it('POSTs an empty JSON body to /esun/auth/reconnect and returns the bridge reply', async () => {
        const fetchImpl = reply(200, { ok: true, message: '玉山證券登入成功', environment: 'SIMULATION', sessionGeneration: 7 });
        const driver = new HttpEsunDriver('', fetchImpl as never);
        const res = await driver.reconnect();
        expect(res).toMatchObject({ ok: true, environment: 'SIMULATION', sessionGeneration: 7 });
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('/esun/auth/reconnect');
        expect(init.method).toBe('POST');
        expect(init.body).toBe('{}');
        expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    });

    it('sends force:true only when explicitly asked', async () => {
        const fetchImpl = reply(200, { ok: true, environment: 'SIMULATION', sessionGeneration: 8 });
        const driver = new HttpEsunDriver('', fetchImpl as never);
        await driver.reconnect({ force: true });
        await driver.reconnect({ force: false });
        await driver.reconnect({});
        const bodies = fetchImpl.mock.calls.map(c => (c as unknown as [string, RequestInit])[1].body);
        expect(bodies).toEqual(['{"force":true}', '{}', '{}']);
    });

    it('a locked login with unchanged credentials (423) surfaces the bridge code', async () => {
        const driver = new HttpEsunDriver('', reply(423, {
            ok: false, error: '登入熔斷鎖定中，憑證未變更', code: 'ESUN_CREDENTIALS_UNCHANGED', login_locked: true,
        }) as never);
        const e = await caught(driver.reconnect());
        expect(e).toBeInstanceOf(EsunBridgeError);
        expect(e.code).toBe('ESUN_CREDENTIALS_UNCHANGED');
    });

    it('fails as an ordinary request (no order outcome flags) with the bridge code and message', async () => {
        const driver = new HttpEsunDriver('', reply(502, {
            ok: false, error: '玉山登入失敗：測試用錯誤', code: 'LOGIN_FAILED', login_locked: false,
        }) as never);
        const e = await caught(driver.reconnect());
        expect(e).toBeInstanceOf(EsunBridgeError);
        expect(e.message).toBe('玉山登入失敗：測試用錯誤');
        expect(e.code).toBe('LOGIN_FAILED');
        expect('mutationNotStarted' in e).toBe(false);
        expect('mutationOutcomeUnknown' in e).toBe(false);
    });

    it('waits up to 30 seconds before reporting a timeout', async () => {
        vi.useFakeTimers();
        const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        const driver = new HttpEsunDriver('', fetchImpl as never);
        const pending = caught(driver.reconnect());
        await vi.advanceTimersByTimeAsync(ESUN_RECONNECT_TIMEOUT_MS - 1);
        expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const e = await pending;
        expect(ESUN_RECONNECT_TIMEOUT_MS).toBe(30_000);
        expect(e.requestTimedOut).toBe(true);
        expect(e.message).toContain('30 秒');
        expect('mutationOutcomeUnknown' in e).toBe(false);
    });
});

describe('ESUN_SESSION_EXPIRED is a not-sent order', () => {
    it('envelope 503 not_sent → mutationNotStarted, shown as「未送出」with the bridge text', async () => {
        const driver = new HttpEsunDriver('', reply(503, {
            ok: false, outcome: 'not_sent', code: 'ESUN_SESSION_EXPIRED', environment: 'SIMULATION',
            error: '玉山登入已失效（換日），正在重新登入；委託未送出',
        }) as never);
        const e = await caught(driver.placeOrder(payload));
        expect(e.mutationNotStarted).toBe(true);
        expect('mutationOutcomeUnknown' in e).toBe(false);
        expect(e.code).toBe('ESUN_SESSION_EXPIRED');
        expect(e.message).toBe('玉山登入已失效（換日），正在重新登入；委託未送出');
        expect(classifyOrderError(e)).toBe('not-sent');
        const notice = orderErrorNotice('⚡ 閃電下單', e);
        expect(notice.title).toBe('⚡ 閃電下單未送出');
        expect(notice.body).toContain('委託未送出');
        expect(notice.body).not.toContain('結果未確認');
    });

    it('adds「委託未送出」when the bridge text does not say it', async () => {
        const driver = new HttpEsunDriver('', reply(503, {
            ok: false, outcome: 'not_sent', code: 'ESUN_SESSION_EXPIRED', error: '玉山登入已失效',
        }) as never);
        const e = await caught(driver.cancelOrder('X0001'));
        expect(e.mutationNotStarted).toBe(true);
        expect(e.message).toBe('玉山登入已失效；委託未送出');
    });

    it('a legacy reply without an envelope (503 + code) is still not sent, not unknown', async () => {
        const driver = new HttpEsunDriver('', reply(503, { ok: false, code: 'ESUN_SESSION_EXPIRED', error: '玉山登入已失效' }) as never);
        const e = await caught(driver.placeOrder(payload));
        expect(e.mutationNotStarted).toBe(true);
        expect('mutationOutcomeUnknown' in e).toBe(false);
        expect(e.message).toBe('玉山登入已失效；委託未送出');
        expect(classifyOrderError(e)).toBe('not-sent');
    });

    it('a 503 without that code keeps the existing unknown classification', async () => {
        const driver = new HttpEsunDriver('', reply(503, { ok: false, error: 'bridge 忙碌' }) as never);
        const e = await caught(driver.placeOrder(payload));
        expect(classifyOrderError(e)).toBe('unknown');
    });

    it('service.placeStockOrder surfaces the expired session as not sent', async () => {
        const mock = new MockEsunDriver();
        const service = new EsunTradeService(mock);
        await service.refreshHealth();
        mock.expireSession();
        const e = await caught(service.placeStockOrder(contract, order, simAccount));
        expect(e.mutationNotStarted).toBe(true);
        expect(e.code).toBe('ESUN_SESSION_EXPIRED');
        expect(orderErrorNotice('下單', e).title).toBe('下單未送出');
    });
});

describe('EsunTradeService.reconnect', () => {
    let mock: MockEsunDriver;
    let service: EsunTradeService;

    beforeEach(async () => {
        mock = new MockEsunDriver();
        service = new EsunTradeService(mock);
        await service.refreshHealth();
        mock.expireSession('2026-01-02T00:00:05+08:00');
        await service.refreshHealth();
    });

    it('health carries the optional session-expired fields', () => {
        const h = service.getBridgeHealth();
        expect(h).toMatchObject({ loggedIn: false, sessionExpired: true, sessionExpiredAt: '2026-01-02T00:00:05+08:00' });
        expect(h?.loginError).toContain('重新連線');
    });

    it('success re-reads health right away and reports the new session', async () => {
        const before = service.getSessionGeneration()!;
        const listener = vi.fn();
        service.subscribe(listener);
        const res = await service.reconnect();
        expect(res.ok).toBe(true);
        expect(res.error).toBeUndefined();
        expect(res.environment).toBe('SIMULATION');
        expect(res.sessionGeneration).toBe(before + 1);
        expect(res.health).toMatchObject({ loggedIn: true });
        expect(res.health?.sessionExpired).toBeUndefined();
        expect(service.getBridgeHealth()?.loggedIn).toBe(true);
        expect(service.getSessionGeneration()).toBe(before + 1);
        expect(listener).toHaveBeenCalled();
        expect(service.isReconnecting()).toBe(false);
        // 重新登入後委託照常送出
        await expect(service.placeStockOrder(contract, order, simAccount)).resolves.toBeTruthy();
    });

    it('failure returns ok:false with a clear error and keeps the expired state', async () => {
        mock.reconnectFailure = '玉山登入失敗：測試用錯誤';
        const res = await service.reconnect();
        expect(res.ok).toBe(false);
        expect(res.error).toBe('玉山重新連線失敗：玉山登入失敗：測試用錯誤');
        expect(res.code).toBe('LOGIN_FAILED');
        expect(res.health).toMatchObject({ loggedIn: false, sessionExpired: true });
        expect(service.isReconnecting()).toBe(false);
    });

    it('bridge reply ok:false is a failure too', async () => {
        vi.spyOn(mock, 'reconnect').mockResolvedValue({ ok: false, error: '另一個登入或環境切換作業進行中', code: 'ESUN_SESSION_BUSY' });
        const res = await service.reconnect();
        expect(res).toMatchObject({ ok: false, code: 'ESUN_SESSION_BUSY', error: '玉山重新連線失敗：另一個登入或環境切換作業進行中' });
    });

    it('single-flight: concurrent calls share one bridge request', async () => {
        let release!: (v: EsunReconnectResponse) => void;
        const spy = vi.spyOn(mock, 'reconnect').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
        const a = service.reconnect();
        const b = service.reconnect();
        expect(b).toBe(a);
        expect(service.isReconnecting()).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
        release({ ok: true, environment: 'SIMULATION' });
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra).toBe(rb);
        expect(ra.ok).toBe(true);
        expect(service.isReconnecting()).toBe(false);
        // 完成後可以再發一次
        spy.mockResolvedValue({ ok: true, environment: 'SIMULATION' });
        await service.reconnect();
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('success whose health re-read fails returns health:null (never the stale expired health) and still adopts the new session', async () => {
        const before = service.getSessionGeneration()!;
        vi.spyOn(mock, 'health').mockRejectedValue(new Error('health 逾時'));
        const res = await service.reconnect();
        expect(res.ok).toBe(true);
        expect(res.health).toBeNull();
        expect(res.sessionGeneration).toBe(before + 1);
        // 回應的 session 代次已採用：trading-state 的 session 代次 hook 仍會觸發重讀
        expect(service.getSessionGeneration()).toBe(before + 1);
    });

    it('passes force:true to the driver only when asked; by default calls it without options', async () => {
        const spy = vi.spyOn(mock, 'reconnect');
        await service.reconnect();
        await service.reconnect({ force: true });
        expect(spy.mock.calls).toEqual([[], [{ force: true }]]);
    });

    it('switchEnvironment is refused while a reconnect is in flight (and vice versa)', async () => {
        let release!: (v: EsunReconnectResponse) => void;
        vi.spyOn(mock, 'reconnect').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
        const switchSpy = vi.spyOn(mock, 'switchEnvironment');
        const pending = service.reconnect();
        const res = await service.switchEnvironment('SIMULATION');
        expect(res.ok).toBe(false);
        expect(res.error).toContain('重新連線進行中');
        expect(switchSpy).not.toHaveBeenCalled();
        release({ ok: true, environment: 'SIMULATION' });
        await pending;
        expect((await service.switchEnvironment('SIMULATION')).ok).toBe(true);
    });

    it('a driver without reconnect (bridge not connected) fails clearly', async () => {
        const offline = new EsunTradeService({ name: 'offline' } as never);
        const res = await offline.reconnect();
        expect(res.ok).toBe(false);
        expect(res.error).toContain('未連線');
    });
});
