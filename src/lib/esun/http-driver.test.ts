// src/lib/esun/http-driver.test.ts — mutation 回應信封與錯誤分類（esun-bridge §4 契約）

import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyOrderError } from '../order-outcome';
import { HttpEsunDriver, EsunBridgeError, UnavailableEsunDriver } from './http-driver';
import { EsunApCode, EsunBsFlag, EsunPriceFlag, EsunSide, EsunTradeType, type EsunOrderPayload } from './types';

const payload: EsunOrderPayload = {
    stockNo: '2884',
    buySell: EsunSide.Buy,
    price: 25,
    quantity: 2,
    apCode: EsunApCode.Common,
    priceFlag: EsunPriceFlag.Limit,
    bsFlag: EsunBsFlag.ROD,
    trade: EsunTradeType.Cash,
};
const guard = { expected_environment: 'SIMULATION' as const, expected_account: '1234567' };

function reply(status: number, body: unknown, raw = false) {
    return vi.fn(async () => new Response(raw ? String(body) : JSON.stringify(body), { status }));
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
});

describe('HttpEsunDriver mutation envelope', () => {
    it('returns the SDK result of an accepted envelope', async () => {
        const fetchImpl = reply(200, {
            ok: true, outcome: 'accepted', environment: 'SIMULATION', sessionGeneration: 3,
            result: { ret_code: '000000', ret_msg: '委託成功', ord_no: 'C0001', work_date: '20261023' },
        });
        const driver = new HttpEsunDriver('', fetchImpl as never);
        const res = await driver.placeOrder(payload, { guard });
        expect(res.ord_no).toBe('C0001');
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('/esun/orders/place');
        expect(JSON.parse(String(init.body))).toEqual({ payload, expected_environment: 'SIMULATION', expected_account: '1234567' });
    });

    it('marks not_sent (409 env mismatch) as not started and keeps code/environment', async () => {
        const driver = new HttpEsunDriver('', reply(409, {
            ok: false, outcome: 'not_sent', code: 'ESUN_ENV_MISMATCH', error: 'bridge 目前為 PRODUCTION', environment: 'PRODUCTION',
        }) as never);
        const e = await caught(driver.placeOrder(payload, { guard }));
        expect(e).toBeInstanceOf(EsunBridgeError);
        expect(e.mutationNotStarted).toBe(true);
        expect('mutationOutcomeUnknown' in e).toBe(false);
        expect(e.code).toBe('ESUN_ENV_MISMATCH');
        expect(e.environment).toBe('PRODUCTION');
        expect(classifyOrderError(e)).toBe('not-sent');
    });

    it('marks a broker rejection (422 rejected) as not started', async () => {
        const driver = new HttpEsunDriver('', reply(422, {
            ok: false, outcome: 'rejected', code: 'AG0005', error: '委託已成交或已取消', result: { ret_code: 'AG0005' },
        }) as never);
        const e = await caught(driver.cancelOrder('C0001', undefined, { guard }));
        expect(e.mutationNotStarted).toBe(true);
        expect(e.outcome).toBe('rejected');
    });

    it('treats outcome unknown (502) as unknown — never as not sent', async () => {
        const driver = new HttpEsunDriver('', reply(502, {
            ok: false, outcome: 'unknown', code: 'ESUN_OUTCOME_UNKNOWN', error: 'SDK 例外',
        }) as never);
        const e = await caught(driver.placeOrder(payload, { guard }));
        expect('mutationNotStarted' in e).toBe(false);
        expect(e.mutationOutcomeUnknown).toBe(true);
        expect(e.orderOutcomeUnknown).toBe(true);
        expect(classifyOrderError(e)).toBe('unknown');
    });

    it('treats a 5xx HTML page (nginx 502 while the bridge restarts) as unknown', async () => {
        const driver = new HttpEsunDriver('', reply(502, '<html>Bad Gateway</html>', true) as never);
        const e = await caught(driver.placeOrder(payload, { guard }));
        expect('mutationNotStarted' in e).toBe(false);
        expect(classifyOrderError(e)).toBe('unknown');
    });

    it('treats a legacy 500 without envelope as unknown', async () => {
        const driver = new HttpEsunDriver('', reply(500, { error: '伺服器錯誤' }) as never);
        const e = await caught(driver.replacePrice('C0001', 26, undefined, { guard }));
        expect(classifyOrderError(e)).toBe('unknown');
    });

    it('treats a network failure after dispatch as unknown', async () => {
        const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        const driver = new HttpEsunDriver('', fetchImpl as never);
        const e = await caught(driver.placeOrder(payload, { guard }));
        expect('mutationNotStarted' in e).toBe(false);
        expect(e.mutationOutcomeUnknown).toBe(true);
        expect(e.message).toContain('勿直接重送');
    });

    it('treats the 15 s timeout (AbortError) as unknown with requestTimedOut', async () => {
        vi.useFakeTimers();
        const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        const driver = new HttpEsunDriver('', fetchImpl as never);
        const pending = caught(driver.placeOrder(payload, { guard }));
        await vi.advanceTimersByTimeAsync(15_001);
        const e = await pending;
        expect(e.mutationOutcomeUnknown).toBe(true);
        expect(e.requestTimedOut).toBe(true);
        expect('mutationNotStarted' in e).toBe(false);
    });

    it('keeps legacy pre-dispatch rejections (400 / 429 / 503 NOT_LOGGED_IN) as not sent', async () => {
        for (const [status, body] of [
            [400, { error: '委託內容不完整', code: 'INVALID_PARAMS' }],
            [429, { error: '下單頻率過高', code: 'AGR0002' }],
            [503, { error: '玉山證券尚未登入', code: 'NOT_LOGGED_IN' }],
        ] as const) {
            const driver = new HttpEsunDriver('', reply(status, body) as never);
            const e = await caught(driver.placeOrder(payload, { guard }));
            expect(e.mutationNotStarted).toBe(true);
        }
    });

    it('passes a legacy 200 raw SDK dict through as the result', async () => {
        const driver = new HttpEsunDriver('', reply(200, { ret_code: '000000', ord_no: 'C0009' }) as never);
        await expect(driver.placeOrder(payload, { guard })).resolves.toMatchObject({ ord_no: 'C0009' });
    });

    it('sends reduce-by quantity with its unit, and the guard on every mutation', async () => {
        const fetchImpl = reply(200, { ok: true, outcome: 'accepted', result: { ret_code: '000000' } });
        const driver = new HttpEsunDriver('', fetchImpl as never);
        await driver.replaceQuantity('C0001', 300, { stockNo: '2884', apCode: EsunApCode.IntradayOdd }, { guard, unit: 'share' });
        await driver.replacePrice('C0001', 26.5, { stockNo: '2884' }, { guard });
        await driver.cancelOrder('C0001', { stockNo: '2884' }, { guard });
        const bodies = fetchImpl.mock.calls.map(c => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)));
        expect(bodies[0]).toMatchObject({ order_no: 'C0001', cancel_quantity: 300, quantity_unit: 'share', ...guard });
        expect(bodies[0]).not.toHaveProperty('quantity');
        expect(bodies[1]).toMatchObject({ order_no: 'C0001', price: 26.5, ...guard });
        expect(bodies[2]).toMatchObject({ order_no: 'C0001', ...guard });
    });
});

describe('HttpEsunDriver queries', () => {
    it('raises plain errors (no mutation flags) for failed GETs', async () => {
        const driver = new HttpEsunDriver('', reply(503, { error: '玉山證券尚未登入', code: 'NOT_LOGGED_IN' }) as never);
        const e = await caught(driver.getBalance());
        expect(e).toBeInstanceOf(EsunBridgeError);
        expect('mutationNotStarted' in e).toBe(false);
        expect('mutationOutcomeUnknown' in e).toBe(false);
    });

    it('refuses a refresh=true order read that the bridge served from cache', async () => {
        const driver = new HttpEsunDriver('', reply(200, { source: 'cache', reason: 'rate limited', orders: [] }) as never);
        await expect(driver.getOrders(true)).rejects.toThrow('快取');
        const cacheOk = new HttpEsunDriver('', reply(200, { source: 'cache', orders: [{ ord_no: 'C1' }] }) as never);
        await expect(cacheOk.getOrders(false)).resolves.toHaveLength(1);
    });

    it('encodes query parameters', async () => {
        const fetchImpl = reply(200, { ca_expiretime: '2027-12-31' });
        await new HttpEsunDriver('', fetchImpl as never).getCaExpire('A1 2&x');
        expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('/esun/ca_expiretime?person_id=A1%202%26x');
    });

    it('surfaces a switch rejection from the bridge as an error', async () => {
        const driver = new HttpEsunDriver('', reply(400, { ok: false, error: '未提供 esun-config.simulation.ini' }) as never);
        await expect(driver.switchEnvironment('SIMULATION')).rejects.toThrow('esun-config.simulation.ini');
    });
});

describe('UnavailableEsunDriver', () => {
    it('fails closed for both mutations and queries', async () => {
        const driver = new UnavailableEsunDriver();
        await expect(driver.placeOrder()).rejects.toMatchObject({ mutationNotStarted: true });
        await expect(driver.getOrders()).rejects.toThrow('未連線');
        await expect(driver.getBalance()).rejects.toThrow('未連線');
        await expect(driver.switchEnvironment('PRODUCTION')).resolves.toMatchObject({ ok: false });
    });
});
