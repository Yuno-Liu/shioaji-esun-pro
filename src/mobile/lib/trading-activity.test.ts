// 交易活動閘門：刪改單追蹤在開機（殼層 app.tsx 匯入 trade-mutation-tracker）就訂閱 begin／settled，不等帳戶頁 chunk（MEDIUM-1）；
// 委託送出中計數（CRITICAL-2）；環境切換中 assertNoEnvSwitch 丟出「未送出」、openTicket／openOrderAction 不開面板（CRITICAL-1）。
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    listener: null as null | ((e: { token: string; phase: 'begin' | 'settled'; tradeId: string; base: string }) => void),
    envSwitchModuleLoaded: false,
}));
vi.mock('../../lib/trade-mutations', () => ({
    onTradeMutation: (l: typeof m.listener) => { m.listener = l; return () => undefined; },
}));
// 帳戶頁 chunk 的模組：開機路徑不得載入它
vi.mock('./esun-env-switch', () => {
    m.envSwitchModuleLoaded = true;
    return {};
});

// 開機路徑：殼層匯入的追蹤模組（只有它，模擬「帳戶頁 chunk 還沒載入」）
import { MUTATION_STALE_MS, tradeMutationInFlight } from './trade-mutation-tracker';

const listenerAtBoot = m.listener;

import { getMobileUi, openOrderAction, openTicket, resetMobileUiForTest } from './mobile-store';
import {
    assertNoEnvSwitch,
    beginOrderDispatch,
    envSwitchBlocks,
    ENV_SWITCH_NOT_SENT,
    orderDispatchInFlight,
    resetTradingActivityForTest,
    setEnvSwitch,
} from './trading-activity';

afterEach(() => {
    resetTradingActivityForTest();
    resetMobileUiForTest();
});

describe('trading-activity', () => {
    it('MEDIUM-1: the cancel/modify tracker is attached at boot, before the account chunk loads', () => {
        expect(listenerAtBoot).toBeTypeOf('function');
        expect(m.envSwitchModuleLoaded).toBe(false);
        // 殼層確實在首屏（靜態）匯入追蹤模組
        expect(readFileSync(new URL('../app.tsx', import.meta.url), 'utf8')).toMatch(/^import '\.\/lib\/trade-mutation-tracker';/m);
        m.listener!({ token: 'a', phase: 'begin', tradeId: 'T1', base: '' });
        expect(tradeMutationInFlight()).toBe(true);
        m.listener!({ token: 'a', phase: 'settled', tradeId: 'T1', base: '' });
        expect(tradeMutationInFlight()).toBe(false);
    });

    it('a begin without settled (closed tab) stops blocking after MUTATION_STALE_MS', () => {
        const t0 = Date.now();
        m.listener!({ token: 'b', phase: 'begin', tradeId: 'T2', base: '' });
        expect(tradeMutationInFlight(t0 + MUTATION_STALE_MS - 1)).toBe(true);
        expect(tradeMutationInFlight(t0 + MUTATION_STALE_MS + 1_000)).toBe(false);
    });

    it('CRITICAL-2: order dispatch counter; release is idempotent', () => {
        const a = beginOrderDispatch();
        const b = beginOrderDispatch();
        expect(orderDispatchInFlight()).toBe(true);
        a();
        a();
        expect(orderDispatchInFlight()).toBe(true);
        b();
        expect(orderDispatchInFlight()).toBe(false);
    });

    it('round 3 (2a): while switching (or checking) only E.SUN is refused; SinoPac passes; unknown account counts as E.SUN', () => {
        const ESUN = { broker_id: '8840-SIM' };
        const SINO = { broker_id: '9A95' };
        expect(() => assertNoEnvSwitch(ESUN)).not.toThrow();
        setEnvSwitch({ target: 'PRODUCTION', phase: 'switching' });
        expect(() => assertNoEnvSwitch(ESUN)).toThrow(ENV_SWITCH_NOT_SENT);
        expect(() => assertNoEnvSwitch({ broker_id: '8840' })).toThrow(ENV_SWITCH_NOT_SENT);
        expect(() => assertNoEnvSwitch(null)).toThrow(ENV_SWITCH_NOT_SENT);
        try { assertNoEnvSwitch(ESUN); } catch (err) { expect(err).toMatchObject({ mutationNotStarted: true }); }
        expect(() => assertNoEnvSwitch(SINO)).not.toThrow();
        expect(envSwitchBlocks(SINO)).toBe(false);
        // 面板照常可開（玉山帳戶在下單面板內由 ticketProblem 擋下）
        openTicket({ code: '2330', action: 'Buy' });
        openOrderAction('T1', 'cancel');
        expect(getMobileUi().ticket).not.toBeNull();
        expect(getMobileUi().orderAction).not.toBeNull();
        setEnvSwitch({ target: 'PRODUCTION', phase: 'checking' });
        expect(() => assertNoEnvSwitch(ESUN)).toThrow(ENV_SWITCH_NOT_SENT);
        expect(() => assertNoEnvSwitch(SINO)).not.toThrow();
        setEnvSwitch(null);
        expect(() => assertNoEnvSwitch(ESUN)).not.toThrow();
    });
});
