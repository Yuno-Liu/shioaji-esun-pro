// src/lib/esun/dispatch.test.ts — 確認視窗環境、trading-state 掛鉤（C-02 / D2-04 / §5 消費端）

import { beforeEach, describe, expect, it, vi } from 'vitest';

const signals = vi.hoisted(() => ({ listeners: new Set<(s: unknown) => void>(), status: 'live' }));
vi.mock('./stream', () => ({
    ensureEsunOrderStream: vi.fn(),
    isEsunStreamStarted: () => true,
    getEsunStreamStatus: () => signals.status,
    onEsunStreamSignal: (listener: (s: unknown) => void) => { signals.listeners.add(listener); return () => signals.listeners.delete(listener); },
}));

import { captureServerMode } from '../server-info-store';
import { MOCK_ESUN_ACCOUNT_ID, MockEsunDriver } from './mock-driver';
import { esunTradeService } from './service';
import {
    ESUN_FAILED_ACK_REFRESH_FAILED_MESSAGE,
    ESUN_FAILED_ACK_REFRESHED_MESSAGE,
    ESUN_STALE_CACHE_MESSAGE,
    ESUN_UNREFRESHED_CACHE_MESSAGE,
    esunAccountQuery,
    esunCacheConflictMessage,
    esunCacheUpsertRow,
    esunConfirmBrokerLabel,
    esunConfirmGuard,
    esunConfirmSimulation,
    esunProfitLossRows,
    startEsunTradingState,
    type EsunTradingHooks,
} from './dispatch';

const emit = (signal: unknown) => signals.listeners.forEach(l => l(signal));

describe('confirm dialog environment (C-02 / D2-04)', () => {
    let driver: MockEsunDriver;
    beforeEach(async () => {
        driver = new MockEsunDriver();
        esunTradeService.setDriver(driver);
        await esunTradeService.switchEnvironment('PRODUCTION');
    });

    it('labels E.SUN accounts as 玉山證券 (the -SIM key suffix never shows)', () => {
        expect(esunConfirmBrokerLabel('8840-SIM')).toBe('玉山證券');
        expect(esunConfirmBrokerLabel('9A95')).toBe('9A95');
    });

    it('shows the E.SUN environment for E.SUN orders even when SinoPac is in simulation', () => {
        expect(esunConfirmSimulation({ accountLabel: '玉山證券-***4567' }, true)).toBe(false);
        expect(esunConfirmSimulation({ accountLabel: '9A95-***4567' }, true)).toBe(true);
        expect(esunConfirmSimulation(undefined, null)).toBeNull();
    });

    it('shows no environment for a split across brokers whose environments differ', () => {
        const label = '分倉 2 戶：9A95-***4567×1、玉山證券-***4567×1';
        expect(esunConfirmSimulation({ accountLabel: label }, true)).toBeNull();
        expect(esunConfirmSimulation({ accountLabel: label }, false)).toBe(false);
    });

    it('invalidates a pending confirmation when the E.SUN environment changes', async () => {
        const guard = esunConfirmGuard(captureServerMode(), { accountLabel: '玉山證券-***4567' });
        const sinopacOnly = captureServerMode();
        expect(esunConfirmGuard(sinopacOnly, { accountLabel: '9A95-***4567' })).toBe(sinopacOnly);
        expect(guard()).toBe(true);
        await esunTradeService.switchEnvironment('SIMULATION');
        expect(guard()).toBe(false);
    });
});

describe('P&L panel routing (D2-07 / C-10)', () => {
    it('reads E.SUN realized P&L from the bridge and leaves other brokers to the sidecar', async () => {
        esunTradeService.setDriver(new MockEsunDriver());
        await esunTradeService.switchEnvironment('SIMULATION');
        const esun = esunTradeService.getAccounts()[0]!;
        await expect(esunProfitLossRows(esun, '2026-09-24', '2026-10-24')).resolves.toEqual([{ date: '20261022', pnl: 2500 }]);
        expect(esunProfitLossRows({ ...esun, broker_id: '9A95' }, '2026-09-24', '2026-10-24')).toBeNull();
    });
});

describe('trading-state hooks (§5 consumer)', () => {
    let hooks: { [K in keyof EsunTradingHooks]: ReturnType<typeof vi.fn> };
    let stop: () => void;

    beforeEach(async () => {
        const driver = new MockEsunDriver();
        esunTradeService.setDriver(driver);
        await esunTradeService.switchEnvironment('SIMULATION');
        hooks = {
            raise: vi.fn(),
            accountsChanged: vi.fn(async () => undefined),
            checkHealth: vi.fn(async () => undefined),
        };
        stop?.();
        stop = startEsunTradingState(hooks as unknown as EsunTradingHooks);
    });

    it('re-reads when a session event re-keys the E.SUN accounts', () => {
        const generation = (esunTradeService.getSessionGeneration() ?? 0) + 1;
        esunTradeService.applySession({ generation, environment: 'PRODUCTION', account: { broker_id: '8840', account_id: MOCK_ESUN_ACCOUNT_ID }, loggedIn: true });
        expect(esunTradeService.getEnvironment()).toBe('PRODUCTION');
        expect(hooks.accountsChanged).toHaveBeenCalledTimes(1);
    });

    it('re-reads when the bridge logs in again with the same account', () => {
        const generation = (esunTradeService.getSessionGeneration() ?? 0) + 1;
        esunTradeService.applySession({ generation, environment: 'SIMULATION', account: { broker_id: '8840', account_id: MOCK_ESUN_ACCOUNT_ID } });
        expect(hooks.accountsChanged).toHaveBeenCalledTimes(1);
    });

    it('does not re-read on snapshot changes that keep the accounts and session', async () => {
        esunTradeService.setConfigProfiles({});
        await esunTradeService.refreshHealth();
        expect(hooks.accountsChanged).not.toHaveBeenCalled();
    });

    it('raises disconnect while the E.SUN stream is down and re-checks health after reconnect', async () => {
        emit({ kind: 'down', message: '玉山回報串流中斷' });
        expect(hooks.raise).toHaveBeenCalledWith('orders', 'disconnect', '玉山回報串流中斷');
        expect(hooks.raise).toHaveBeenCalledWith('positions', 'disconnect', '玉山回報串流中斷');
        emit({ kind: 'reconnected' });
        await vi.waitFor(() => expect(hooks.checkHealth).toHaveBeenCalledWith('reconnect'));
    });

    it('turns a resync into a sequence gap plus a cache rebuild attempt', () => {
        emit({ kind: 'resync' });
        expect(hooks.raise).toHaveBeenCalledWith('orders', 'sequence-gap', expect.any(String));
        expect(hooks.checkHealth).toHaveBeenCalledWith('gap');
        expect(hooks.raise).not.toHaveBeenCalledWith('orders', 'snapshot-boundary', expect.any(String));
    });

    it('a ws_reconnected resync whose bridge cache was not re-read raises a reason only an authoritative read clears', () => {
        emit({ kind: 'resync', reason: 'ws_reconnected', cacheRefreshed: true });
        expect(hooks.raise).not.toHaveBeenCalledWith('orders', 'snapshot-boundary', expect.any(String));
        emit({ kind: 'resync', reason: 'ws_reconnected', cacheRefreshed: false });
        expect(hooks.raise).toHaveBeenCalledWith('orders', 'snapshot-boundary', ESUN_STALE_CACHE_MESSAGE);
        hooks.raise.mockClear();
        emit({ kind: 'resync', reason: 'ws_reconnected' });
        expect(hooks.raise).toHaveBeenCalledWith('orders', 'snapshot-boundary', ESUN_STALE_CACHE_MESSAGE);
        expect(hooks.raise).not.toHaveBeenCalledWith('positions', 'snapshot-boundary', expect.any(String));
        expect(hooks.checkHealth).toHaveBeenCalledWith('gap');
    });

    it('any resync with cacheRefreshed:false raises a reason only an authoritative read clears (PB5-2)', () => {
        emit({ kind: 'resync', reason: 'bridge_restarted', cacheRefreshed: false });
        expect(hooks.raise).toHaveBeenCalledWith('orders', 'snapshot-boundary', ESUN_UNREFRESHED_CACHE_MESSAGE);
        hooks.raise.mockClear();
        hooks.checkHealth.mockClear();
        emit({ kind: 'resync', reason: 'failed_ack_refresh_failed', cacheRefreshed: false });
        expect(hooks.raise.mock.calls).toEqual([['orders', 'snapshot-boundary', ESUN_FAILED_ACK_REFRESH_FAILED_MESSAGE]]);
        expect(hooks.checkHealth).not.toHaveBeenCalled();
    });

    it('a failed_ack_refreshed resync raises only an orders reason the cache rebuild clears (PB5-1)', () => {
        emit({ kind: 'resync', reason: 'failed_ack_refreshed', cacheRefreshed: true });
        expect(hooks.raise.mock.calls).toEqual([['orders', 'sequence-gap', ESUN_FAILED_ACK_REFRESHED_MESSAGE]]);
        expect(hooks.checkHealth).toHaveBeenCalledWith('gap');
    });

    it('raises untrackable-event for a report the stream could not convert (positions too for a deal)', () => {
        emit({ kind: 'untrackable', deal: false });
        expect(hooks.raise).toHaveBeenCalledWith('orders', 'untrackable-event', expect.any(String));
        expect(hooks.raise).not.toHaveBeenCalledWith('positions', 'untrackable-event', expect.any(String));
        emit({ kind: 'untrackable', deal: true });
        expect(hooks.raise).toHaveBeenCalledWith('positions', 'untrackable-event', expect.any(String));
    });

    it('keeps the E.SUN disconnect open when an authoritative read completes while the stream is down', async () => {
        const account = esunTradeService.getAccounts()[0]!;
        try {
            signals.status = 'down';
            emit({ kind: 'down', message: '玉山回報串流中斷' });
            hooks.raise.mockClear();
            // trading-state 讀取成功後 resolve 讀取開始前的原因；讀取期間重新提出的原因會保留
            await esunAccountQuery('/api/v1/order/trades', account, { refresh: true });
            expect(hooks.raise).toHaveBeenCalledWith('orders', 'disconnect', '玉山回報串流中斷');
            await esunAccountQuery('/api/v1/portfolio/position_unit', account, { unit: 'Common' });
            expect(hooks.raise).toHaveBeenCalledWith('positions', 'disconnect', '玉山回報串流中斷');
            hooks.raise.mockClear();
            await esunAccountQuery('/api/v1/order/trades', account, { refresh: false });
            expect(hooks.raise).not.toHaveBeenCalled();
            signals.status = 'live';
            await esunAccountQuery('/api/v1/order/trades', account, { refresh: true });
            await esunAccountQuery('/api/v1/portfolio/position_unit', account, { unit: 'Common' });
            expect(hooks.raise).not.toHaveBeenCalled();
        } finally {
            signals.status = 'live';
        }
    });
});

describe('cache rebuild row merge (esunCacheUpsertRow)', () => {
    const esun = { account_type: 'S', broker_id: '8840', account_id: '1234567', signed: true, username: '', person_id: '' };
    const row = (deal: number, cancel: number, over: { status?: string; broker?: string } = {}) => {
        const account = { ...esun, broker_id: over.broker ?? esun.broker_id };
        return {
            contract: { code: '2884', security_type: 'STK' as const, exchange: 'TSE' as const, target_code: null },
            order: { id: 'C0001', seqno: 'C0001', ordno: 'C0001', action: 'Buy' as const, price: 25.5, quantity: 5, order_type: 'ROD' as const, price_type: 'LMT' as const, account },
            status: { id: 'C0001', status: (over.status ?? (deal > 0 ? 'PartFilled' : 'Submitted')) as 'Submitted', status_code: '', msg: '', order_quantity: 5,
                deal_quantity: deal, cancel_quantity: cancel, modified_price: 0,
                deals: deal > 0 ? [{ seq: `d${deal}`, price: 25.5, quantity: deal, ts: 1 }] : [] },
            account,
        };
    };

    let hooks: { [K in keyof EsunTradingHooks]: ReturnType<typeof vi.fn> };
    let stop: (() => void) | undefined;
    beforeEach(() => {
        hooks = { raise: vi.fn(), accountsChanged: vi.fn(async () => undefined), checkHealth: vi.fn(async () => undefined) };
        stop?.();
        stop = startEsunTradingState(hooks as unknown as EsunTradingHooks);
    });

    it('keeps the local row and raises snapshot-boundary when the cache is behind on fills or cancels (PB3-1)', () => {
        const local = row(3, 0);
        expect(esunCacheUpsertRow(local, row(2, 0))).toBe(local);
        expect(hooks.raise).toHaveBeenCalledWith('orders', 'snapshot-boundary', esunCacheConflictMessage('C0001'));
        expect(esunCacheConflictMessage('C0001')).toContain('C0001');
        hooks.raise.mockClear();
        // 成交較多但取消較少：仍是矛盾，不合併兩邊
        const cancelled = row(1, 2);
        expect(esunCacheUpsertRow(cancelled, row(2, 0))).toBe(cancelled);
        expect(hooks.raise).toHaveBeenCalledTimes(1);
    });

    it('keeps a local terminal row the cache reports as live (PB3-1)', () => {
        for (const status of ['Failed', 'Cancelled', 'Filled']) {
            hooks.raise.mockClear();
            const local = row(0, 0, { status });
            expect(esunCacheUpsertRow(local, row(0, 0))).toBe(local);
            expect(hooks.raise).toHaveBeenCalledWith('orders', 'snapshot-boundary', esunCacheConflictMessage('C0001'));
        }
        hooks.raise.mockClear();
        // 快取也是終態：採用快取列
        const failed = row(0, 0, { status: 'Failed' });
        expect(esunCacheUpsertRow(row(0, 0, { status: 'Cancelled' }), failed)).toBe(failed);
        expect(hooks.raise).not.toHaveBeenCalled();
    });

    it('takes the cache row without a reason when it is not behind, and for other brokers', () => {
        const cached = row(4, 0);
        expect(esunCacheUpsertRow(row(3, 0), cached)).toBe(cached);
        const same = row(3, 0);
        expect(esunCacheUpsertRow(row(3, 0), same)).toBe(same);
        const sinopac = row(2, 0, { broker: '9A95' });
        expect(esunCacheUpsertRow(row(3, 0, { broker: '9A95' }), sinopac)).toBe(sinopac);
        const sinopacLive = row(0, 0, { broker: '9A95' });
        expect(esunCacheUpsertRow(row(0, 0, { broker: '9A95', status: 'Failed' }), sinopacLive)).toBe(sinopacLive);
        expect(hooks.raise).not.toHaveBeenCalled();
    });
});
