// src/lib/esun/dispatch.test.ts — 確認視窗環境、trading-state 掛鉤（C-02 / D2-04 / §5 消費端）

import { beforeEach, describe, expect, it, vi } from 'vitest';

const signals = vi.hoisted(() => ({ listeners: new Set<(s: unknown) => void>() }));
vi.mock('./stream', () => ({
    ensureEsunOrderStream: vi.fn(),
    isEsunStreamStarted: () => true,
    getEsunStreamStatus: () => 'live',
    onEsunStreamSignal: (listener: (s: unknown) => void) => { signals.listeners.add(listener); return () => signals.listeners.delete(listener); },
}));

import { captureServerMode } from '../server-info-store';
import { MOCK_ESUN_ACCOUNT_ID, MockEsunDriver } from './mock-driver';
import { esunTradeService } from './service';
import {
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
    });
});
