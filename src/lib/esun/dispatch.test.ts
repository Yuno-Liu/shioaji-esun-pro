// src/lib/esun/dispatch.test.ts — 確認視窗環境、trading-state 掛鉤（C-02 / D2-04 / §5 消費端）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signals = vi.hoisted(() => ({ listeners: new Set<(s: unknown) => void>(), status: 'live' }));
vi.mock('./stream', () => ({
    ensureEsunOrderStream: vi.fn(),
    isEsunStreamStarted: () => true,
    getEsunStreamStatus: () => signals.status,
    onEsunStreamSignal: (listener: (s: unknown) => void) => { signals.listeners.add(listener); return () => signals.listeners.delete(listener); },
}));
const tradingState = vi.hoisted(() => ({ refreshTradingState: vi.fn(async (_scope?: string) => undefined) }));
vi.mock('../trading-state', () => tradingState);

import { captureServerMode } from '../server-info-store';
import { MOCK_ESUN_ACCOUNT_ID, MockEsunDriver } from './mock-driver';
import { fromEsunOrderResult } from './order-mapping';
import { esunTradeService } from './service';
import { ensureEsunOrderStream } from './stream';
import type { EsunOrderResult } from './types';
import {
    ESUN_FAILED_ACK_REFRESH_FAILED_MESSAGE,
    ESUN_FAILED_ACK_REFRESHED_MESSAGE,
    ESUN_STALE_CACHE_MESSAGE,
    ESUN_POSITIONS_REREAD_DELAY_MS,
    ESUN_POSITIONS_REREAD_HEALTH_WAIT_MS,
    ESUN_UNREFRESHED_CACHE_MESSAGE,
    ESUN_WS_DOWN_MESSAGE,
    ESUN_WS_RECONNECTED_MESSAGE,
    esunAccountQuery,
    esunAggregateRepairMessage,
    esunCacheConflictMessage,
    esunCacheUpsertRow,
    esunConfirmBrokerLabel,
    esunConfirmGuard,
    esunConfirmSimulation,
    esunCoveredDealMessage,
    esunProfitLossRows,
    esunQuantityConflictMessage,
    esunUnitUnknownMessage,
    fetchAccountsWithEsun,
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
    let driver: MockEsunDriver;

    beforeEach(async () => {
        driver = new MockEsunDriver();
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

    // 頂欄「重新連線」不再自行呼叫 refreshTradingStateForModeChange：權威重讀只靠這個 session 代次 hook
    // 單例 service 的 session 代次跨測試累加：bridge 回應一律用「目前代次＋1」
    const nextSession = () => vi.spyOn(driver, 'reconnect').mockImplementation(async () => {
        const sessionGeneration = (esunTradeService.getSessionGeneration() ?? 0) + 1;
        vi.spyOn(driver, 'health').mockImplementation(async () => ({
            ok: true, configured: true, problems: [], environment: 'SIMULATION', account: { broker_id: '8840', account_id: MOCK_ESUN_ACCOUNT_ID },
            loggedIn: true, loginError: null, sessionGeneration,
        }));
        return { ok: true, environment: 'SIMULATION', sessionGeneration };
    });

    it('a successful manual reconnect re-reads exactly once through the session generation hook', async () => {
        nextSession();
        const res = await esunTradeService.reconnect();
        expect(res.ok).toBe(true);
        expect(res.health).toMatchObject({ loggedIn: true });
        expect(hooks.accountsChanged).toHaveBeenCalledTimes(1);
    });

    it('still re-reads once when the health read after a successful reconnect fails', async () => {
        const health = vi.spyOn(driver, 'health').mockRejectedValue(new Error('health 逾時'));
        vi.spyOn(driver, 'reconnect').mockImplementation(async () =>
            ({ ok: true, environment: 'SIMULATION', sessionGeneration: (esunTradeService.getSessionGeneration() ?? 0) + 1 }));
        const res = await esunTradeService.reconnect();
        expect(res.ok).toBe(true);
        expect(res.health).toBeNull();
        expect(hooks.accountsChanged).toHaveBeenCalledTimes(1);
        health.mockRestore();
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

    it('raises snapshot-boundary naming the order for an emerging-stock report of unknown unit (PB8-3)', () => {
        emit({ kind: 'untrackable', deal: false, authoritativeOnly: { orderId: 'E0001' } });
        expect(hooks.raise.mock.calls).toEqual([['orders', 'snapshot-boundary', esunUnitUnknownMessage('E0001')]]);
        expect(esunUnitUnknownMessage('E0001')).toContain('E0001');
        hooks.raise.mockClear();
        emit({ kind: 'untrackable', deal: true, authoritativeOnly: { orderId: 'E0001' } });
        expect(hooks.raise.mock.calls).toEqual([
            ['orders', 'snapshot-boundary', esunUnitUnknownMessage('E0001')],
            ['positions', 'snapshot-boundary', esunUnitUnknownMessage('E0001')],
        ]);
        expect(hooks.checkHealth).not.toHaveBeenCalled();
    });

    it('raises a positions snapshot-boundary naming the order for a fill covered by an order snapshot (RC1)', () => {
        emit({ kind: 'covered-deal', orderId: 'C0001' });
        expect(hooks.raise.mock.calls).toEqual([['positions', 'snapshot-boundary', esunCoveredDealMessage('C0001')]]);
        expect(esunCoveredDealMessage('C0001')).toContain('C0001');
        expect(hooks.checkHealth).not.toHaveBeenCalled();
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

    describe('ws_reconnected with a re-read cache: one delayed authoritative positions read', () => {
        type Doc = EventTarget & { hidden: boolean };
        let doc: Doc | undefined;
        const setHidden = (hidden: boolean) => { doc!.hidden = hidden; doc!.dispatchEvent(new Event('visibilitychange')); };
        const resync = () => emit({ kind: 'resync', reason: 'ws_reconnected', cacheRefreshed: true, wsOpen: true });
        const reads = () => tradingState.refreshTradingState.mock.calls.length;
        const deferred = () => {
            let settle!: (ok: boolean) => void;
            const promise = new Promise<void>((resolve, reject) => { settle = ok => ok ? resolve() : reject(new Error('503')); });
            return { promise, settle: (ok = true) => settle(ok) };
        };
        beforeEach(() => {
            vi.useFakeTimers();
            tradingState.refreshTradingState.mockReset().mockResolvedValue(undefined);
            doc = undefined;
        });
        afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
        const withDocument = (hidden: boolean) => {
            doc = Object.assign(new EventTarget(), { hidden });
            vi.stubGlobal('document', doc);
            return doc;
        };

        it('raises both reasons with a message that does not claim a read in progress, and checks health', () => {
            resync();
            expect(ESUN_WS_RECONNECTED_MESSAGE).toBe('玉山 bridge 已重新連上券商並重讀委託；持倉稍後自動重新查詢，未解除時請按更新');
            expect(hooks.raise.mock.calls).toEqual([
                ['orders', 'sequence-gap', ESUN_WS_RECONNECTED_MESSAGE],
                ['positions', 'sequence-gap', ESUN_WS_RECONNECTED_MESSAGE],
            ]);
            expect(hooks.checkHealth.mock.calls).toEqual([['gap']]);
            expect(ESUN_POSITIONS_REREAD_DELAY_MS).toBe(7_000);
        });

        it('reads nothing before 7 s; then a second health check and, after it settles, one positions read', async () => {
            resync();
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS - 1);
            expect(reads()).toBe(0);
            expect(hooks.checkHealth).toHaveBeenCalledTimes(1);
            const health = deferred();
            hooks.checkHealth.mockImplementationOnce(() => health.promise);
            await vi.advanceTimersByTimeAsync(1);
            expect(hooks.checkHealth).toHaveBeenCalledTimes(2);
            expect(hooks.checkHealth).toHaveBeenLastCalledWith('gap');
            await vi.advanceTimersByTimeAsync(50);
            expect(reads()).toBe(0);
            health.settle();
            await vi.waitFor(() => expect(reads()).toBe(1));
            expect(tradingState.refreshTradingState).toHaveBeenCalledWith('positions');
            const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder.at(-1)!;
            expect(order(hooks.checkHealth)).toBeLessThan(order(tradingState.refreshTradingState));
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(1);
        });

        it('a rejected second health check still reads positions', async () => {
            resync();
            hooks.checkHealth.mockImplementationOnce(() => Promise.reject(new Error('health 503')));
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS);
            await vi.waitFor(() => expect(reads()).toBe(1));
            expect(hooks.checkHealth).toHaveBeenCalledTimes(2);
        });

        it('a second health check that never settles delays the read by at most 3 s', async () => {
            expect(ESUN_POSITIONS_REREAD_HEALTH_WAIT_MS).toBe(3_000);
            resync();
            hooks.checkHealth.mockImplementationOnce(() => new Promise<void>(() => undefined));
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS);
            expect(hooks.checkHealth).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_HEALTH_WAIT_MS - 1);
            expect(reads()).toBe(0);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => expect(reads()).toBe(1));
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(1);
        });

        it('hidden when the delay elapses: after the page becomes visible, waits the full delay again, then reads', async () => {
            const d = withDocument(false);
            resync();
            d.hidden = true;
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS + 60_000);
            expect(reads()).toBe(0);
            expect(hooks.checkHealth).toHaveBeenCalledTimes(1);
            // 仍在背景的 visibilitychange 不觸發
            setHidden(true);
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS + 10);
            expect(reads()).toBe(0);
            setHidden(false);
            // 回到前景不立即讀：重新計時整整一段
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS - 1);
            expect(reads()).toBe(0);
            expect(hooks.checkHealth).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => expect(reads()).toBe(1));
            expect(hooks.checkHealth).toHaveBeenCalledTimes(2);
            // 一次性監聽：之後的前景切換不再讀
            setHidden(true); setHidden(false);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(1);
        });

        it('hidden again when the restarted delay elapses: keeps waiting for the foreground', async () => {
            const d = withDocument(true);
            resync();
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS);
            setHidden(false);
            await vi.advanceTimersByTimeAsync(3_000);
            d.hidden = true;
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS + 60_000);
            expect(reads()).toBe(0);
            setHidden(false);
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS - 1);
            expect(reads()).toBe(0);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => expect(reads()).toBe(1));
        });

        it('arms nothing while the broker WebSocket is still down (wsOpen false) or for an older bridge without the flag', async () => {
            emit({ kind: 'resync', reason: 'ws_reconnected', cacheRefreshed: true, wsOpen: false });
            expect(hooks.raise).toHaveBeenCalledWith('orders', 'sequence-gap', ESUN_WS_DOWN_MESSAGE);
            expect(hooks.raise).toHaveBeenCalledWith('positions', 'sequence-gap', ESUN_WS_DOWN_MESSAGE);
            hooks.raise.mockClear();
            emit({ kind: 'resync', reason: 'ws_reconnected', cacheRefreshed: true });
            expect(hooks.raise).toHaveBeenCalledWith('positions', 'sequence-gap', expect.stringContaining('玉山回報漏收'));
            expect(hooks.raise).not.toHaveBeenCalledWith('positions', 'sequence-gap', ESUN_WS_RECONNECTED_MESSAGE);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(0);
            expect(hooks.checkHealth).toHaveBeenCalledTimes(2);
        });

        it('a resync during the pre-read health wait skips that read and restarts the full delay', async () => {
            const pending = deferred();
            hooks.checkHealth.mockReturnValueOnce(Promise.resolve()).mockReturnValueOnce(pending.promise);
            resync();
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS + 500);   // 讀前健康檢查等待中
            expect(reads()).toBe(0);
            resync();                                                                  // 第二次重連
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_HEALTH_WAIT_MS);     // 等待上限到：這次不讀
            expect(reads()).toBe(0);
            pending.settle();
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS - ESUN_POSITIONS_REREAD_HEALTH_WAIT_MS - 1000);
            expect(reads()).toBe(0);                                                    // 距第二次重連還不到 7 秒
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS + ESUN_POSITIONS_REREAD_HEALTH_WAIT_MS);
            await vi.waitFor(() => expect(reads()).toBe(1));
        });

        it('arms nothing when the cache was not re-read (or for other resync reasons)', async () => {
            emit({ kind: 'resync', reason: 'ws_reconnected', cacheRefreshed: false, wsOpen: true });
            emit({ kind: 'resync', reason: 'ws_reconnected' });
            emit({ kind: 'resync', reason: 'bridge_restarted', cacheRefreshed: true });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(0);
            expect(hooks.checkHealth).toHaveBeenCalledTimes(3);
            expect(hooks.raise).toHaveBeenCalledWith('orders', 'snapshot-boundary', ESUN_STALE_CACHE_MESSAGE);
            expect(hooks.raise).not.toHaveBeenCalledWith('orders', 'sequence-gap', ESUN_WS_RECONNECTED_MESSAGE);
        });

        it('a resync while armed restarts the full delay from the last resync (one read)', async () => {
            resync();
            await vi.advanceTimersByTimeAsync(5_000);
            resync();
            // 第一次之後 7 秒：不讀
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS - 5_000);
            expect(reads()).toBe(0);
            expect(hooks.checkHealth).toHaveBeenCalledTimes(2);
            // 第二次之後 7 秒：讀一次
            await vi.advanceTimersByTimeAsync(5_000 - 1);
            expect(reads()).toBe(0);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => expect(reads()).toBe(1));
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(1);
        });

        it('a resync while waiting for the foreground drops the listener and restarts the full delay', async () => {
            const d = withDocument(true);
            const remove = vi.spyOn(d, 'removeEventListener');
            resync();
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS);
            resync();
            expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
            // 舊監聽已移除：回到前景不會另外排一輪
            setHidden(false);
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS - 1);
            expect(reads()).toBe(0);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => expect(reads()).toBe(1));
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(1);
        });

        it('a resync during the in-flight read runs exactly one more full cycle after it', async () => {
            const first = deferred();
            tradingState.refreshTradingState.mockImplementationOnce(() => first.promise.then(() => undefined));
            resync();
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS);
            await vi.waitFor(() => expect(reads()).toBe(1));
            resync();
            resync();
            first.settle();
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS - 1);
            expect(reads()).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => expect(reads()).toBe(2));
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(2);
        });

        it('stop() cancels an armed re-read', async () => {
            resync();
            stop();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(0);
            expect(hooks.checkHealth).toHaveBeenCalledTimes(1);
        });

        it('stop() during the in-flight read drops the queued follow-up cycle', async () => {
            const first = deferred();
            tradingState.refreshTradingState.mockImplementationOnce(() => first.promise.then(() => undefined));
            resync();
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS);
            await vi.waitFor(() => expect(reads()).toBe(1));
            resync();
            stop();
            first.settle();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(1);
            expect(hooks.checkHealth).toHaveBeenCalledTimes(3);
        });

        it('stop() during the pre-read health wait skips the read', async () => {
            resync();
            hooks.checkHealth.mockImplementationOnce(() => new Promise<void>(() => undefined));
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS + 1_000);
            expect(hooks.checkHealth).toHaveBeenCalledTimes(2);
            stop();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(0);
        });

        it('stop() removes the foreground listener of a re-read waiting for the page', async () => {
            const d = withDocument(true);
            const remove = vi.spyOn(d, 'removeEventListener');
            resync();
            await vi.advanceTimersByTimeAsync(ESUN_POSITIONS_REREAD_DELAY_MS);
            stop();
            expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
            setHidden(false);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(reads()).toBe(0);
        });
    });
});

describe('account load never fails on the E.SUN probe', () => {
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it('resolves with the Sinopac list when starting the order stream throws', async () => {
        vi.stubEnv('MODE', 'production');
        vi.spyOn(esunTradeService, 'getBridgeHealth').mockReturnValue(null);
        const connect = vi.spyOn(esunTradeService, 'connectBridge').mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof esunTradeService.connectBridge>>);
        vi.spyOn(esunTradeService, 'getAccounts').mockReturnValue([]);
        vi.mocked(ensureEsunOrderStream).mockImplementationOnce(() => { throw new Error('stream boom'); });
        const sinopac = [{ account_type: 'S', broker_id: '9A95', account_id: '0000001', person_id: '', signed: true, username: '' }];
        const fetchSinopac = vi.fn(async () => sinopac);
        await expect(fetchAccountsWithEsun(fetchSinopac)).resolves.toEqual(sinopac);
        expect(connect).toHaveBeenCalledTimes(1);
        expect(ensureEsunOrderStream).toHaveBeenCalled();
        expect(fetchSinopac).toHaveBeenCalledTimes(1);
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

    /** 委託 C0001 5 張的本地／快取列，deals 為 [seq, 張] */
    const withDeals = (deals: [string, number][], over: { status?: string; cancel?: number } = {}) => {
        const deal = deals.reduce((s, [, q]) => s + q, 0);
        const base = row(deal, over.cancel ?? 0, over.status ? { status: over.status } : {});
        return { ...base, status: { ...base.status, deals: deals.map(([seq, quantity]) => ({ seq, price: 25.5, quantity, ts: 1 })) } };
    };

    it('takes the cache row when the local excess comes only from the aggregate fill counted again by MATs (RC1)', () => {
        // 本地：快照彙總 1 張＋之後同一筆成交的 MAT（S1）再計入＋S2 → 3 張；快取：逐筆 S1、S2 共 2 張
        const local = withDeals([['C0001:agg', 1], ['S1', 1], ['S2', 1]]);
        const cached = withDeals([['S1', 1], ['S2', 1]]);
        expect(esunCacheUpsertRow(local, cached)).toBe(cached);
        expect(hooks.raise.mock.calls).toEqual([['orders', 'snapshot-boundary', esunAggregateRepairMessage('C0001')]]);
        // 本地已誤判為 Filled（5 張全成交）：同樣改採快取列（委託回到有效）
        hooks.raise.mockClear();
        const filled = withDeals([['C0001:agg', 2], ['S1', 1], ['S2', 1], ['S3', 1]], { status: 'Filled' });
        const live = withDeals([['S1', 1], ['S2', 1], ['S3', 1]]);
        expect(esunCacheUpsertRow(filled, live)).toBe(live);
        expect(hooks.raise).toHaveBeenCalledWith('orders', 'snapshot-boundary', esunAggregateRepairMessage('C0001'));
    });

    it('keeps the local row when the excess is not explained by the aggregate fill alone', () => {
        const cases: [ReturnType<typeof withDeals>, ReturnType<typeof withDeals>][] = [
            // 本地有快取沒有的逐筆成交
            [withDeals([['C0001:agg', 1], ['S1', 1], ['S9', 1]]), withDeals([['S1', 1], ['S2', 1]])],
            // 只有彙總成交（快取落後，例如 bridge 重啟）
            [withDeals([['C0001:agg', 2]]), withDeals([['C0001:agg', 1]])],
            // 快取成交量少於本地彙總量：快取不知道快照的成交
            [withDeals([['C0001:agg', 2], ['S1', 1]]), withDeals([['S1', 1]])],
            // 快取取消量較低
            [withDeals([['C0001:agg', 1], ['S1', 1]], { cancel: 1 }), withDeals([['S1', 1]])],
        ];
        for (const [local, cached] of cases) {
            hooks.raise.mockClear();
            expect(esunCacheUpsertRow(local, cached)).toBe(local);
            expect(hooks.raise.mock.calls).toEqual([['orders', 'snapshot-boundary', esunCacheConflictMessage('C0001')]]);
        }
    });

    const esunRow = (over: Record<string, unknown>) => ({ ...fromEsunOrderResult({
        ord_no: 'C0001', pre_ord_no: '', stock_no: '2884', buy_sell: 'B', ap_code: '1', price_flag: '0', bs_flag: 'R', trade: '0',
        od_price: 25.5, org_qty: 5, org_qty_share: 5000, mat_qty: 0, mat_qty_share: 0, cel_qty: 0, cel_qty_share: 0, avg_price: 25.5,
        ord_date: '20261023', ord_time: '090512345', ...over,
    } as EsunOrderResult, esun)!, account: esun });

    it('keeps the consistent local row over a held-open cache row with contradictory quantities, and raises a reason (RC2)', () => {
        const cached = esunRow({ mat_qty: 6, mat_qty_share: 6000 });
        expect(cached.status).toMatchObject({ status: 'PartFilled', deal_quantity: 5 });
        // 本地 2/5（一致、剩 3 張可刪單）：不被矛盾的快取列（5/5、無剩餘量）蓋掉
        const local = row(2, 0) as typeof cached;
        expect(esunCacheUpsertRow(local, cached)).toBe(local);
        expect(hooks.raise.mock.calls).toEqual([['orders', 'snapshot-boundary', esunQuantityConflictMessage('C0001')]]);
        expect(esunQuantityConflictMessage('C0001')).toContain('C0001');
        // bridge 標示 exceeds_order 的快取列同樣保留本地列（快取即使知道得比本地多也不採用）
        hooks.raise.mockClear();
        const capped = esunRow({ mat_qty: 5, mat_qty_share: 5000,
            esun_quantity_conflict: { mat: { reason: 'exceeds_order', report_shares: 6000, org_shares: 5000, raw_shares: 4000 } } });
        expect(capped.status.deal_quantity).toBe(4);
        expect(esunCacheUpsertRow(local, capped)).toBe(local);
        expect(hooks.raise.mock.calls).toEqual([['orders', 'snapshot-boundary', esunQuantityConflictMessage('C0001')]]);
        // 本地也是同樣矛盾的列：照一般規則合併（快取不落後 -> 採用快取列）
        hooks.raise.mockClear();
        const heldLocal = esunRow({ mat_qty: 6, mat_qty_share: 6000 });
        expect(esunCacheUpsertRow(heldLocal, cached)).toBe(cached);
        expect(hooks.raise).toHaveBeenCalledWith('orders', 'snapshot-boundary', esunQuantityConflictMessage('C0001'));
    });

    it('merges a later_snapshot cache row by the usual rules, still raising a reason', () => {
        const later = esunRow({ mat_qty: 3, mat_qty_share: 3000,
            esun_quantity_conflict: { mat: { reason: 'later_snapshot', report_shares: 4000, snapshot_shares: 3000 } } });
        expect(esunCacheUpsertRow(row(2, 0) as typeof later, later)).toBe(later);
        expect(hooks.raise.mock.calls).toEqual([['orders', 'snapshot-boundary', esunQuantityConflictMessage('C0001')]]);
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

describe('mock driver settlements', () => {
    it('returns the same shape as the HTTP driver (ISO dates, T+0..T+2)', async () => {
        const list = await new MockEsunDriver().getSettlements();
        expect(list.map(s => s.T)).toEqual([0, 1, 2]);
        for (const s of list) expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});
