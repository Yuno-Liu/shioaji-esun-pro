// 帳戶 › 連線「交易環境」：永豐唯讀說明；玉山切換至模擬（按鈕確認）／正式（必須滑動）、取消不送出；
// 每個擋下條件（含面板開啟後、確認當下才出現的條件）；成功後的呼叫（同桌面）；失敗回饋；連點／並行防護；S1（不送任何委託）。
// 以 vi.mock 隔離 src/lib，不打任何真實 API。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Env = 'SIMULATION' | 'PRODUCTION';
type Profile = { available: boolean; fileName: string | null; expectedFileName: string };

const m = vi.hoisted(() => {
    const profiles = (sim = true, prod = true): Record<'SIMULATION' | 'PRODUCTION', Profile> => ({
        SIMULATION: { available: sim, fileName: sim ? 'esun-config.simulation.ini' : null, expectedFileName: 'esun-config.simulation.ini' },
        PRODUCTION: { available: prod, fileName: prod ? 'esun-config.production.ini' : null, expectedFileName: 'esun-config.production.ini' },
    });
    return {
        profiles,
        health: null as Record<string, unknown> | null,
        env: 'SIMULATION' as Env,
        known: true,
        switching: false,
        reconnecting: false,
        configProfiles: profiles(),
        info: { simulation: true } as { simulation?: boolean } | null,
        pendingConfirm: null as unknown,
        confirmListeners: new Set<() => void>(),
        serviceListeners: new Set<() => void>(),
        mutationListener: null as null | ((e: { token: string; phase: 'begin' | 'settled'; tradeId: string; base: string }) => void),
        switchEnvironment: vi.fn(),
        refreshHealth: vi.fn(),
        reconnect: vi.fn(),
        notify: vi.fn(),
        invalidate: vi.fn(),
        refreshMode: vi.fn(async () => undefined),
        // S1：任何委託函式都不得被呼叫
        orderFns: {
            placeStockOrder: vi.fn(), placeFuturesOrder: vi.fn(), cancelOrder: vi.fn(), cancelOrders: vi.fn(),
            updateOrderPrice: vi.fn(), updateOrderQty: vi.fn(),
        },
        esunOrderFns: { placeOrder: vi.fn(), cancelOrder: vi.fn(), replacePrice: vi.fn(), replaceQty: vi.fn() },
    };
});

vi.mock('../../../lib/esun', () => ({
    isEsunAccount: (a?: { broker_id?: string } | null) => !!a?.broker_id?.startsWith('884'),
    useEsunEnvironment: () => ({
        environment: m.env, isSimulation: m.env === 'SIMULATION', environmentKnown: m.known, configProfiles: m.configProfiles,
    }),
    esunTradeService: {
        subscribe: (l: () => void) => { m.serviceListeners.add(l); return () => { m.serviceListeners.delete(l); }; },
        getBridgeHealth: () => m.health,
        getSnapshot: () => ({ environment: m.env, environmentKnown: m.known, switching: m.switching }),
        isReconnecting: () => m.reconnecting,
        isEnvironmentAvailable: (t: Env) => !!m.configProfiles[t]?.available,
        getConfigProfiles: () => m.configProfiles,
        getEnvironment: () => m.env,
        getEntryUrl: () => 'entry',
        switchEnvironment: m.switchEnvironment,
        refreshHealth: m.refreshHealth,
        reconnect: m.reconnect,
        ...m.esunOrderFns,
    },
}));
vi.mock('../../../lib/order-confirm', () => ({
    getPendingOrderConfirm: () => m.pendingConfirm,
    subscribeOrderConfirm: (l: () => void) => { m.confirmListeners.add(l); return () => { m.confirmListeners.delete(l); }; },
    accountConfirmLabel: () => '',
}));
vi.mock('../../../lib/trade-mutations', () => ({
    onTradeMutation: (l: typeof m.mutationListener) => { m.mutationListener = l; return () => undefined; },
}));
vi.mock('../../../lib/trade', () => ({ notify: m.notify }));
vi.mock('../../../hooks/use-query', () => ({ invalidateAllQueries: m.invalidate }));
vi.mock('../../../lib/trading-state', () => ({ refreshTradingStateForModeChange: m.refreshMode }));
vi.mock('../../../lib/server-info-store', () => ({ useServerInfo: () => m.info }));
vi.mock('../../../lib/shioaji', () => m.orderFns);

import { tradingLimitsKey } from '../../hooks/use-trading-limits';
import { setBatchExit } from '../../lib/batch-exit-auth';
import { resetEsunEnvSwitchForTest, runEsunEnvSwitch } from '../../lib/esun-env-switch';
import { resetEsunReconnectForTest } from '../../lib/esun-reconnect';
import { closeOrderAction, closeTicket, openOrderAction, openTicket, resetMobileUiForTest } from '../../lib/mobile-store';
import { BottomSheet } from '../bottom-sheet';
import { SlideToConfirm } from '../slide-to-confirm';
import { EnvSwitchSection } from './env-switch-section';

const HEALTH = { ok: true, configured: true, problems: [], environment: 'SIMULATION', account: null, loggedIn: true, loginError: null, loginLocked: false };

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const find = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => find(id)[0]!;
const sheet = () => view!.root.findAll(n => n.type === BottomSheet && n.props.testId === 'env-switch-sheet')[0]!;
const slide = () => view!.root.findAll(n => n.type === SlideToConfirm && n.props.testId === 'env-switch-slide')[0];
const click = (id: string) => act(async () => { one(id).props.onClick(); });
const flush = () => act(async () => { await Promise.resolve(); });
const emitService = (change: () => void = () => undefined) => act(async () => { change(); m.serviceListeners.forEach(l => l()); });

async function mount() {
    await act(async () => { view = create(createElement(EnvSwitchSection)); });
}

function expectNoOrders() {
    for (const fn of [...Object.values(m.orderFns), ...Object.values(m.esunOrderFns)]) expect(fn).not.toHaveBeenCalled();
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetEsunEnvSwitchForTest();
    resetEsunReconnectForTest();
    resetMobileUiForTest();
    setBatchExit(false);
    m.health = { ...HEALTH };
    m.env = 'SIMULATION';
    m.known = true;
    m.switching = false;
    m.reconnecting = false;
    m.configProfiles = m.profiles();
    m.info = { simulation: true };
    m.pendingConfirm = null;
    m.switchEnvironment.mockReset();
    m.switchEnvironment.mockImplementation(async (t: Env) => {
        m.env = t;
        return { ok: true, environment: t, entry: 'e', bridgeUpdated: true, activeConfigFile: m.configProfiles[t].fileName };
    });
    m.refreshHealth.mockReset();
    m.refreshHealth.mockImplementation(async () => m.health);
    m.reconnect.mockReset();
    m.notify.mockClear();
    m.invalidate.mockClear();
    m.refreshMode.mockClear();
    for (const fn of [...Object.values(m.orderFns), ...Object.values(m.esunOrderFns)]) fn.mockClear();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    setBatchExit(false);
    vi.unstubAllGlobals();
});

describe('EnvSwitchSection — display', () => {
    it('SinoPac is read-only with the server-side instructions', async () => {
        await mount();
        expect(text(one('env-sinopac'))).toBe('模擬環境');
        const note = text(one('env-sinopac-note'));
        expect(note).toContain('SJ_PRODUCTION');
        expect(note).toContain('docker compose up -d');
        expect(note).toContain('不能切換');
        m.info = { simulation: false };
        await act(async () => { view!.update(createElement(EnvSwitchSection)); });
        expect(text(one('env-sinopac'))).toBe('正式環境');
    });

    it('shows the current E.SUN environment; the current option is disabled and marked', async () => {
        await mount();
        expect(text(one('env-esun'))).toBe('模擬環境');
        expect(one('env-option-simulation').props.disabled).toBe(true);
        expect(one('env-option-simulation').props['aria-pressed']).toBe(true);
        expect(text(one('env-option-simulation'))).toContain('目前使用中');
        expect(one('env-option-production').props.disabled).toBe(false);
        expect(text(one('env-option-production'))).toContain('esun-config.production.ini');
    });

    it('a missing profile disables its option and says why', async () => {
        m.configProfiles = m.profiles(true, false);
        await mount();
        expect(one('env-option-production').props.disabled).toBe(true);
        expect(text(one('env-option-production'))).toContain('未提供 esun-config.production.ini（不可選）');
    });
});

describe('EnvSwitchSection — to SIMULATION (button confirm)', () => {
    beforeEach(() => { m.env = 'PRODUCTION'; });

    it('confirm switches, then refreshes like the desktop and closes', async () => {
        await mount();
        await click('env-option-simulation');
        expect(sheet().props.open).toBe(true);
        expect(m.refreshHealth).toHaveBeenCalled();
        expect(slide()).toBeUndefined(); // 模擬：按鈕確認，不用滑動
        expect(one('env-switch-confirm').props.disabled).toBe(false);
        await click('env-switch-confirm');
        expect(m.switchEnvironment).toHaveBeenCalledExactlyOnceWith('SIMULATION');
        expect(m.invalidate).toHaveBeenCalledTimes(1);
        expect(m.refreshMode).toHaveBeenCalledTimes(1);
        expect(m.notify).toHaveBeenCalledWith({ kind: 'ok', title: '環境切換', body: '已切換玉山證券至模擬環境（esun-config.simulation.ini）' });
        expect(sheet().props.open).toBe(false);
        expectNoOrders();
    });

    it('cancel sends nothing', async () => {
        await mount();
        await click('env-option-simulation');
        await click('env-switch-cancel');
        expect(sheet().props.open).toBe(false);
        expect(m.switchEnvironment).not.toHaveBeenCalled();
        expect(m.invalidate).not.toHaveBeenCalled();
    });
});

describe('EnvSwitchSection — to PRODUCTION (slide required)', () => {
    it('shows the real-money warning; only the slide confirms; cancel does nothing', async () => {
        await mount();
        await click('env-option-production');
        expect(sheet().props.open).toBe(true);
        expect(text(one('env-switch-warning'))).toContain('正式環境的委託是真實下單，會動用真實資金與庫存');
        expect(find('env-switch-confirm')).toHaveLength(0); // 沒有按鈕可以直接切換
        expect(slide()!.props.disabled).toBe(false);
        expect(slide()!.props.tone).toBe('danger');
        await click('env-switch-cancel');
        expect(sheet().props.open).toBe(false);
        expect(m.switchEnvironment).not.toHaveBeenCalled();
    });

    it('slide switches to PRODUCTION', async () => {
        await mount();
        await click('env-option-production');
        await act(async () => { slide()!.props.onConfirm(); });
        expect(m.switchEnvironment).toHaveBeenCalledExactlyOnceWith('PRODUCTION');
        expect(m.invalidate).toHaveBeenCalledTimes(1);
        expect(m.refreshMode).toHaveBeenCalledTimes(1);
        expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok', body: '已切換玉山證券至正式環境（esun-config.production.ini）' }));
        expect(sheet().props.open).toBe(false);
        expectNoOrders();
    });

    it('not dismissible while switching; double slide / concurrent calls switch once', async () => {
        let resolve!: (v: unknown) => void;
        m.switchEnvironment.mockReturnValue(new Promise(r => { resolve = r; }));
        await mount();
        await click('env-option-production');
        await act(async () => { slide()!.props.onConfirm(); slide()!.props.onConfirm(); });
        expect(sheet().props.dismissible).toBe(false);
        expect(one('env-switch-cancel').props.disabled).toBe(true);
        expect(find('env-switch-running')).toHaveLength(1);
        expect(slide()!.props.disabled).toBe(true);
        // 其他入口同時呼叫也不會送第二次
        expect(await runEsunEnvSwitch('PRODUCTION', 'ok')).toBeNull();
        expect(m.switchEnvironment).toHaveBeenCalledTimes(1);
        await act(async () => { resolve({ ok: true, environment: 'PRODUCTION', entry: 'e', bridgeUpdated: true }); });
        expect(sheet().props.open).toBe(false);
        expect(m.switchEnvironment).toHaveBeenCalledTimes(1);
    });

    it('failure: notifies with the bridge error, keeps the sheet open, no refresh', async () => {
        m.switchEnvironment.mockResolvedValue({ ok: false, environment: 'SIMULATION', entry: 'e', bridgeUpdated: false, error: '登入失敗（LOGIN_FAILED）' });
        await mount();
        await click('env-option-production');
        await act(async () => { slide()!.props.onConfirm(); });
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '環境切換失敗', body: '登入失敗（LOGIN_FAILED）' });
        expect(text(one('env-switch-error'))).toContain('登入失敗');
        expect(sheet().props.open).toBe(true);
        expect(sheet().props.dismissible).toBe(true);
        expect(m.invalidate).not.toHaveBeenCalled();
        expect(m.refreshMode).not.toHaveBeenCalled();
        expectNoOrders();
    });

    it('a thrown error is reported as a failure', async () => {
        m.switchEnvironment.mockRejectedValue(new Error('network down'));
        await mount();
        await click('env-option-production');
        await act(async () => { slide()!.props.onConfirm(); });
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '環境切換失敗', body: 'network down' });
        expect(text(one('env-switch-error'))).toContain('network down');
    });
});

describe('EnvSwitchSection — blocking conditions', () => {
    // 每個條件：選項列（或面板）停用並顯示原因
    const cases: [string, () => void, string][] = [
        ['bridge not connected', () => { m.health = null; }, 'bridge 未連線或已停止'],
        ['bridge unhealthy', () => { m.health = { ...HEALTH, ok: false, problems: ['設定不完整'] }; }, '狀態異常（設定不完整）'],
        ['login locked', () => { m.health = { ...HEALTH, loginLocked: true, loginLockReason: 'LOGIN_FAILED' }; }, '熔斷鎖定中（LOGIN_FAILED）'],
        ['switch already in progress', () => { m.switching = true; }, '環境切換中'],
        ['reconnect in progress', () => { m.reconnecting = true; }, '重新連線進行中'],
        ['order ticket open', () => { openTicket({ code: '2330' }); }, '下單面板開啟中'],
        ['order action sheet open', () => { openOrderAction('T1'); }, '委託操作面板開啟中'],
        ['order confirm pending', () => { m.pendingConfirm = { code: '2330' }; }, '委託確認進行中'],
        ['batch exit running', () => { setBatchExit(true); }, '多選出清進行中'],
        ['cancel / modify in flight', () => { m.mutationListener!({ token: 'k1', phase: 'begin', tradeId: 'T1', base: '' }); }, '刪單／改單送出中'],
    ];

    it.each(cases)('%s: the option is disabled with the reason', async (_name, apply, reason) => {
        await mount();
        await emitService(apply);
        expect(one('env-option-production').props.disabled).toBe(true);
        expect(text(one('env-switch-block'))).toContain(reason);
    });

    it.each(cases.filter(([name]) => name !== 'switch already in progress'))('%s: appearing after the sheet opened disables the confirm', async (_name, apply, reason) => {
        m.env = 'PRODUCTION';
        await mount();
        await click('env-option-simulation');
        expect(one('env-switch-confirm').props.disabled).toBe(false);
        await emitService(apply);
        expect(one('env-switch-confirm').props.disabled).toBe(true);
        expect(text(one('env-switch-reason'))).toContain(reason);
    });

    it.each(cases)('%s: re-checked at the moment of the slide (no re-render in between)', async (_name, apply) => {
        await mount();
        await click('env-option-production');
        expect(slide()!.props.disabled).toBe(false);
        const onConfirm = slide()!.props.onConfirm as () => void;
        // 同一個 tick 內條件出現並滑動：用的是條件出現前畫面上的 onConfirm（重繪之前）
        await act(async () => { apply(); onConfirm(); });
        expect(m.switchEnvironment).not.toHaveBeenCalled();
        expectNoOrders();
    });

    it('bridge stopped (stale health, fresh probe fails) blocks the sheet', async () => {
        m.refreshHealth.mockResolvedValue(null);
        await mount();
        await click('env-option-production');
        await flush();
        expect(slide()!.props.disabled).toBe(true);
        expect(slide()!.props.disabledReason).toContain('bridge 未連線或已停止');
    });

    it('while the probe is pending the slide is disabled', async () => {
        m.refreshHealth.mockReturnValue(new Promise(() => undefined));
        await mount();
        await click('env-option-production');
        expect(slide()!.props.disabled).toBe(true);
        expect(slide()!.props.disabledReason).toContain('確認玉山 bridge 狀態');
    });

    it('a settled cancel / modify releases the block', async () => {
        await mount();
        await emitService(() => m.mutationListener!({ token: 'k1', phase: 'begin', tradeId: 'T1', base: '' }));
        expect(one('env-option-production').props.disabled).toBe(true);
        await emitService(() => m.mutationListener!({ token: 'k1', phase: 'settled', tradeId: 'T1', base: '' }));
        expect(one('env-option-production').props.disabled).toBe(false);
    });

    it('closing the ticket / action sheet releases the block', async () => {
        await mount();
        await emitService(() => openTicket({ code: '2330' }));
        expect(one('env-option-production').props.disabled).toBe(true);
        await emitService(() => { closeTicket(); openOrderAction('T1'); });
        expect(one('env-option-production').props.disabled).toBe(true);
        await emitService(closeOrderAction);
        expect(one('env-option-production').props.disabled).toBe(false);
    });
});

describe('S1 and environment-keyed caches', () => {
    it('switching back and forth sends no order of any kind', async () => {
        await mount();
        await click('env-option-production');
        await act(async () => { slide()!.props.onConfirm(); });
        await act(async () => { view!.update(createElement(EnvSwitchSection)); });
        await click('env-option-simulation');
        await click('env-switch-confirm');
        expect(m.switchEnvironment.mock.calls).toEqual([['PRODUCTION'], ['SIMULATION']]);
        expectNoOrders();
    });

    it('trading-limits cache keys differ between the simulation and production E.SUN account', () => {
        expect(tradingLimitsKey({ broker_id: '8840-SIM', account_id: '1234567' })).not.toBe(tradingLimitsKey({ broker_id: '8840', account_id: '1234567' }));
    });
});
