// 玉山一般重新連線：只在有玉山帳戶時顯示、先確認再送、絕不帶 force、60 秒冷卻（重新掛載仍有效）、
// loginLocked／bridge 未連線／登入正常時停用並說明、結果通知用語比照桌面、成功但讀不到 health 時顯示狀態確認中
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    accounts: [] as { broker_id: string; account_id: string; account_type: string }[],
    health: null as Record<string, unknown> | null,
    switching: false,
    reconnect: vi.fn(),
    refreshHealth: vi.fn(async () => null as unknown),
    notify: vi.fn(),
    invalidate: vi.fn(),
}));
vi.mock('../../../lib/account-store', () => ({ useAccounts: () => ({ accounts: m.accounts }) }));
vi.mock('../../../lib/esun', () => ({
    isEsunAccount: (a?: { broker_id?: string } | null) => !!a?.broker_id?.startsWith('ESUN'),
    esunTradeService: {
        subscribe: () => () => undefined,
        getBridgeHealth: () => m.health,
        getSnapshot: () => ({ switching: m.switching }),
        reconnect: m.reconnect,
        refreshHealth: m.refreshHealth,
    },
}));
vi.mock('../../../lib/trade', () => ({ notify: m.notify }));
vi.mock('../../../hooks/use-query', () => ({ invalidateAllQueries: m.invalidate }));

import { ESUN_RECONNECT_COOLDOWN_MS, resetEsunReconnectForTest } from '../../lib/esun-reconnect';
import { EsunReconnectSection } from './esun-reconnect-section';

const ESUN = { broker_id: 'ESUN', account_id: '1234567', account_type: 'S' };
const LOST = { ok: true, configured: true, problems: [], environment: 'SIMULATION', account: null, loggedIn: false, loginError: 'token expired', sessionExpired: true };

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const find = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => view!.root.find(n => n.props['data-testid'] === id && typeof n.type === 'string');

async function mount() {
    await act(async () => { view = create(createElement(EsunReconnectSection)); });
}
async function unmount() {
    await act(async () => view?.unmount());
    view = undefined;
}
const click = (id: string) => act(async () => { one(id).props.onClick(); });

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-06T09:00:00+08:00'));
    resetEsunReconnectForTest();
    m.accounts = [ESUN];
    m.health = { ...LOST };
    m.switching = false;
    m.reconnect.mockReset();
    m.reconnect.mockResolvedValue({ ok: true, health: { ...LOST, loggedIn: true, sessionExpired: false, loginError: null }, environment: 'SIMULATION' });
    m.refreshHealth.mockReset();
    m.refreshHealth.mockResolvedValue(null);
    m.notify.mockClear();
    m.invalidate.mockClear();
});
afterEach(async () => {
    await unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('EsunReconnectSection', () => {
    it('renders nothing without an E.SUN account', async () => {
        m.accounts = [{ broker_id: '9A95', account_id: '1', account_type: 'S' }];
        await mount();
        expect(view!.toJSON()).toBeNull();
    });

    it('shows the current login state and environment', async () => {
        await mount();
        expect(text(one('esun-reconnect-login'))).toContain('登入失效');
        expect(text(one('esun-reconnect-env'))).toBe('模擬環境');
    });

    it('asks for confirmation first (3-strike lock warning); cancel sends nothing', async () => {
        await mount();
        await click('esun-reconnect');
        expect(m.reconnect).not.toHaveBeenCalled();
        const box = one('esun-reconnect-confirm-box');
        expect(box.props.role).toBe('alertdialog');
        expect(text(box)).toContain('密碼錯誤 3 次會被玉山鎖帳，請確認設定正確再重試');
        await click('esun-reconnect-cancel');
        expect(find('esun-reconnect-confirm-box')).toHaveLength(0);
        expect(m.reconnect).not.toHaveBeenCalled();
    });

    it('confirm calls reconnect() with no arguments (never force) and notifies like the desktop', async () => {
        await mount();
        await click('esun-reconnect');
        await click('esun-reconnect-confirm');
        expect(m.reconnect).toHaveBeenCalledOnce();
        expect(m.reconnect.mock.calls[0]).toEqual([]);
        expect(m.invalidate).toHaveBeenCalledOnce();
        expect(m.notify).toHaveBeenCalledWith({ kind: 'ok', title: '玉山重新連線', body: '已重新登入玉山證券（模擬環境）' });
    });

    it('failure notifies with the bridge error', async () => {
        m.reconnect.mockResolvedValue({ ok: false, health: LOST, error: '玉山重新連線失敗：LOGIN_FAILED', code: 'LOGIN_FAILED' });
        await mount();
        await click('esun-reconnect');
        await click('esun-reconnect-confirm');
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '玉山重新連線失敗', body: '玉山重新連線失敗：LOGIN_FAILED' });
        expect(m.invalidate).not.toHaveBeenCalled();
    });

    it('60 s cooldown after an attempt survives a remount', async () => {
        m.reconnect.mockResolvedValue({ ok: false, health: LOST, error: 'x' });
        await mount();
        await click('esun-reconnect');
        await click('esun-reconnect-confirm');
        await unmount();
        await mount();
        expect(one('esun-reconnect').props.disabled).toBe(true);
        expect(text(one('esun-reconnect'))).toContain('60 秒');
        expect(text(one('esun-reconnect-block'))).toContain('請稍候');
        await act(async () => { vi.advanceTimersByTime(ESUN_RECONNECT_COOLDOWN_MS - 1_000); });
        expect(one('esun-reconnect').props.disabled).toBe(true);
        await act(async () => { vi.advanceTimersByTime(1_000); });
        expect(one('esun-reconnect').props.disabled).toBe(false);
        expect(m.reconnect).toHaveBeenCalledOnce();
    });

    it('loginLocked: disabled, explains to use the desktop, no confirm', async () => {
        m.health = { ...LOST, loginLocked: true, loginLockReason: '密碼錯誤' };
        await mount();
        expect(one('esun-reconnect').props.disabled).toBe(true);
        expect(text(one('esun-reconnect-block'))).toContain('請到桌面版');
        expect(text(one('esun-reconnect-block'))).toContain('密碼錯誤');
        expect(text(one('esun-reconnect-login'))).toContain('鎖定');
    });

    it('locks out while the confirm panel is open if the bridge reports a lock', async () => {
        await mount();
        await click('esun-reconnect');
        m.health = { ...LOST, loginLocked: true };
        await act(async () => { vi.advanceTimersByTime(1_000); });
        expect(find('esun-reconnect-confirm-box')).toHaveLength(0);
        expect(m.reconnect).not.toHaveBeenCalled();
    });

    it('logged in normally: no reconnect needed', async () => {
        m.health = { ...LOST, loggedIn: true, sessionExpired: false, loginError: null };
        await mount();
        expect(one('esun-reconnect').props.disabled).toBe(true);
        expect(text(one('esun-reconnect-block'))).toContain('不需要重新連線');
    });

    it('bridge not connected: disabled', async () => {
        m.health = null;
        await mount();
        expect(one('esun-reconnect').props.disabled).toBe(true);
        expect(text(one('esun-reconnect-block'))).toContain('bridge 未連線');
    });

    it('E.SUN environment switch in progress: disabled with the reason', async () => {
        m.switching = true;
        await mount();
        expect(one('esun-reconnect').props.disabled).toBe(true);
        expect(text(one('esun-reconnect-block'))).toContain('環境切換中');
    });

    it('disables the button while the request is in flight', async () => {
        let resolve!: (v: unknown) => void;
        m.reconnect.mockReturnValue(new Promise(r => { resolve = r; }));
        await mount();
        await click('esun-reconnect');
        await click('esun-reconnect-confirm');
        expect(one('esun-reconnect').props.disabled).toBe(true);
        expect(one('esun-reconnect').props['aria-busy']).toBe(true);
        expect(text(one('esun-reconnect'))).toContain('重新連線中');
        await act(async () => { resolve({ ok: false, health: LOST, error: 'x' }); });
        expect(one('esun-reconnect').props['aria-busy']).toBe(false);
    });

    it('success without health shows "狀態確認中" and re-reads health', async () => {
        m.reconnect.mockResolvedValue({ ok: true, health: null, environment: null });
        m.refreshHealth.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...LOST, loggedIn: true, sessionExpired: false });
        await mount();
        await click('esun-reconnect');
        await click('esun-reconnect-confirm');
        expect(find('esun-health-confirming')).toHaveLength(1);
        expect(m.notify).toHaveBeenCalledWith({ kind: 'ok', title: '玉山重新連線', body: '已重新登入玉山證券' });
        await act(async () => { vi.advanceTimersByTime(2_000); });
        await act(async () => { vi.advanceTimersByTime(4_000); });
        expect(m.refreshHealth).toHaveBeenCalledTimes(2);
        expect(find('esun-health-confirming')).toHaveLength(0);
    });
});
