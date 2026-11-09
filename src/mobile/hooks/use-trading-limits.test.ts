import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ fetchTradingLimits: vi.fn() }));
vi.mock('../../lib/shioaji', () => ({ fetchTradingLimits: m.fetchTradingLimits }));
vi.mock('../../lib/trading-state', () => ({ useTradingState: () => ({ trades: [], queries: { orders: { updatedAt: null } } }) }));

import {
    TRADING_LIMITS_MIN_REFRESH_MS,
    TRADING_LIMITS_TTL_MS,
    availableLimitFor,
    getTradingLimitsState,
    limitsLookEmpty,
    loadTradingLimits,
    resetTradingLimitsForTest,
} from './use-trading-limits';

const stock = { broker_id: 'BRK', account_id: '0000001', account_type: 'S' as const };
const futures = { broker_id: 'BRK', account_id: '0000002', account_type: 'F' as const };
const LIMITS = {
    trading_limit: 500_000, trading_used: 200_000, trading_available: 300_000,
    margin_limit: 100_000, margin_used: 0, margin_available: 100_000,
    short_limit: 50_000, short_used: 10_000, short_available: 40_000,
};

let t = 1_000_000;
beforeEach(() => {
    t = 1_000_000;
    resetTradingLimitsForTest(() => t);
    m.fetchTradingLimits.mockReset();
});
afterEach(() => resetTradingLimitsForTest());

describe('loadTradingLimits', () => {
    it('reads once, dedupes concurrent callers and caches for the TTL', async () => {
        m.fetchTradingLimits.mockResolvedValue(LIMITS);
        await Promise.all([loadTradingLimits(stock), loadTradingLimits(stock)]);
        expect(m.fetchTradingLimits).toHaveBeenCalledOnce();
        expect(m.fetchTradingLimits).toHaveBeenCalledWith({ broker_id: 'BRK', account_id: '0000001' });
        expect(getTradingLimitsState(stock)).toMatchObject({ data: LIMITS, error: null, loading: false, updatedAt: t });
        t += TRADING_LIMITS_TTL_MS - 1;
        await loadTradingLimits(stock);
        expect(m.fetchTradingLimits).toHaveBeenCalledOnce();
        t += 1;
        await loadTradingLimits(stock);
        expect(m.fetchTradingLimits).toHaveBeenCalledTimes(2);
    });

    it('manual refresh still waits the minimum gap', async () => {
        m.fetchTradingLimits.mockResolvedValue(LIMITS);
        await loadTradingLimits(stock);
        t += TRADING_LIMITS_MIN_REFRESH_MS - 1;
        await loadTradingLimits(stock, { force: true });
        expect(m.fetchTradingLimits).toHaveBeenCalledOnce();
        t += 1;
        await loadTradingLimits(stock, { force: true });
        expect(m.fetchTradingLimits).toHaveBeenCalledTimes(2);
    });

    it('keeps the last good data on error and never rejects', async () => {
        m.fetchTradingLimits.mockResolvedValueOnce(LIMITS).mockRejectedValueOnce(new Error('查詢失敗'));
        await loadTradingLimits(stock);
        t += TRADING_LIMITS_TTL_MS;
        await expect(loadTradingLimits(stock)).resolves.toBeUndefined();
        expect(getTradingLimitsState(stock)).toMatchObject({ data: LIMITS, error: '查詢失敗', loading: false });
    });

    it('never queries a futures account', async () => {
        await loadTradingLimits(futures);
        expect(m.fetchTradingLimits).not.toHaveBeenCalled();
        expect(getTradingLimitsState(futures).data).toBeNull();
    });
});

describe('limitsAreCapsOnly', () => {
    it('E.SUN accounts only report caps', async () => {
        const { limitsAreCapsOnly } = await import('./use-trading-limits');
        expect(limitsAreCapsOnly({ broker_id: 'ESUN' })).toBe(true);
        expect(limitsAreCapsOnly({ broker_id: 'BRK' })).toBe(false);
        expect(limitsAreCapsOnly(null)).toBe(false);
    });
});

describe('availableLimitFor / limitsLookEmpty', () => {
    it('picks the limit that matches the credit condition', () => {
        expect(availableLimitFor(LIMITS)).toBe(300_000);
        expect(availableLimitFor(LIMITS, 'MarginTrading')).toBe(100_000);
        expect(availableLimitFor(LIMITS, 'ShortSelling')).toBe(40_000);
        expect(availableLimitFor(null)).toBeNull();
    });

    it('treats all-zero limits (simulation / outside 08:30–15:00) as no data', () => {
        const zero = Object.fromEntries(Object.keys(LIMITS).map(k => [k, 0])) as typeof LIMITS;
        expect(limitsLookEmpty(zero)).toBe(true);
        expect(limitsLookEmpty(LIMITS)).toBe(false);
        expect(limitsLookEmpty(null)).toBe(true);
    });
});
