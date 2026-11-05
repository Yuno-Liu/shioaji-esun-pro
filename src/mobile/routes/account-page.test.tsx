// 帳戶頁（規格 §6.7、§10）：風控一鍵鎖單（鎖定立即生效、解除需滑動確認）、
// 「手動下單確認」一律顯示鎖定開啟且不可關閉（不寫入桌面設定）、明示只對本裝置有效、遮蔽金額。
import { createElement, useSyncExternalStore } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
    const riskListeners = new Set<() => void>();
    return {
        risk: { enabled: false, maxQty: 0, maxDailyLoss: 0, locked: false, escCancelAll: false, confirmManualOrders: false, orderLineLock: false },
        riskListeners,
        setRiskSettings: vi.fn(),
        privMoney: false,
        accounts: {} as Record<string, unknown>,
        trading: {} as Record<string, unknown>,
        fetchSettlements: vi.fn(),
        fetchHealth: vi.fn(),
        fetchInfo: vi.fn(),
        refreshHealth: vi.fn(async () => null),
        esunHealth: null as unknown,
        info: { version: '1.7.10', simulation: true } as unknown,
        usage: null as unknown,
        setThemeSettings: vi.fn(),
        setPrivacyMoney: vi.fn(),
    };
});

vi.mock('../../lib/risk', () => ({
    useRiskSettings: () => useSyncExternalStore(
        (l: () => void) => { m.riskListeners.add(l); return () => { m.riskListeners.delete(l); }; },
        () => m.risk,
    ),
    setRiskSettings: (next: object) => {
        m.setRiskSettings(next);
        m.risk = { ...m.risk, ...next };
        m.riskListeners.forEach(l => l());
    },
}));
vi.mock('../../lib/privacy', () => ({
    maskMoney: (text: string, priv: boolean) => (priv ? '•••••' : text),
    usePrivacyMoney: () => m.privMoney,
    usePrivacyMode: () => false,
    setPrivacyMoney: m.setPrivacyMoney,
    setPrivacyMode: vi.fn(),
}));
vi.mock('../../lib/account-store', () => ({ useAccounts: () => m.accounts }));
vi.mock('../../lib/trading-state', () => ({ useTradingState: () => m.trading }));
vi.mock('../../lib/flash-account', () => ({
    accountMatches: (a?: { account_type: string; broker_id: string; account_id: string } | null, b?: { account_type: string; broker_id: string; account_id: string } | null) =>
        !!a && !!b && a.account_type === b.account_type && a.broker_id === b.broker_id && a.account_id === b.account_id,
}));
vi.mock('../../lib/esun', () => ({
    esunTradeService: {
        subscribe: () => () => undefined,
        refreshHealth: m.refreshHealth,
        getBridgeHealth: () => m.esunHealth,
    },
    isEsunAccount: (a?: { broker_id?: string } | null) => !!a?.broker_id?.startsWith('ESUN'),
}));
vi.mock('../../lib/esun/stream', () => ({ getEsunStreamStatus: () => 'live' }));
vi.mock('../../lib/stream', () => ({ getLastHeartbeat: () => 0, streamConnectionEpoch: () => 3 }));
vi.mock('../../hooks/use-stream', () => ({ useStreamStatus: () => 'live' }));
vi.mock('../../hooks/use-monitor-resource', () => ({ useMonitorResource: () => ({ data: m.usage, error: '', updated: null, base: '' }) }));
vi.mock('../../lib/server-info-store', () => ({ useServerInfo: () => m.info }));
vi.mock('../../lib/shioaji', () => ({ fetchSettlements: m.fetchSettlements, fetchHealth: m.fetchHealth, fetchInfo: m.fetchInfo }));
vi.mock('../../lib/settle-date', () => ({ settleDateLabel: (raw: string) => raw }));
vi.mock('../../lib/theme-store', () => ({ useThemeSettings: () => ({ mode: 'dark', convention: 'tw', fontScale: 1.15 }), setThemeSettings: m.setThemeSettings }));
vi.mock('../components/account-switch-sheet', () => ({
    AccountSwitchSheet: () => null,
    mobileAccountLabel: (a: { account_id: string }) => `***${a.account_id.slice(-4)}`,
}));
vi.mock('../components/route-badge', () => ({ RouteBadge: () => null, useOrderRoute: () => ({ simulation: false }) }));

import { AccountPage, resetAccountPageCacheForTest, SETTLEMENT_REUSE_MS } from './account-page';

const stock = { account_type: 'S', broker_id: '9A95', account_id: '1234567', person_id: 'A1' };
const fut = { account_type: 'F', broker_id: 'F002000', account_id: '7654321', person_id: 'A1' };

let view: ReactTestRenderer | undefined;
async function render() {
    await act(async () => { view = create(createElement(AccountPage)); });
}
const byTestId = (id: string): ReactTestInstance => view!.root.find(n => n.props['data-testid'] === id && typeof n.type === 'string');
const allByTestId = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const text = () => JSON.stringify(view!.toJSON());
const textOf = (node: ReactTestInstance): string =>
    node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetAccountPageCacheForTest();
    m.risk = { enabled: false, maxQty: 0, maxDailyLoss: 0, locked: false, escCancelAll: false, confirmManualOrders: false, orderLineLock: false };
    m.riskListeners.clear();
    m.setRiskSettings.mockClear();
    m.privMoney = false;
    m.accounts = { accounts: [stock, fut], selectedStock: stock, selectedFutures: fut, loaded: true, loadError: false };
    m.trading = {
        funds: [
            { account: stock, balance: { acc_balance: 1234567, date: '2026-11-05', errmsg: '' }, updatedAt: Date.now() },
            { account: fut, margin: { equity: 500000, available_margin: 300000, initial_margin: 100000, risk_indicator: 250, today_balance: 1, maintenance_margin: 0 }, updatedAt: Date.now() },
        ],
    };
    m.fetchSettlements.mockReset().mockResolvedValue([
        { date: '2026-11-06', amount: -50000, T: 1 },
        { date: '2026-11-05', amount: 0, T: 0 },
        { date: '2026-11-09', amount: 12000, T: 2 },
    ]);
    m.fetchHealth.mockReset().mockResolvedValue({ status: 'ok', version: '1.7.10', ca_expires_in_days: 120 });
    m.fetchInfo.mockReset().mockResolvedValue({ version: '1.7.10', simulation: true });
    m.refreshHealth.mockClear();
    m.esunHealth = null;
    m.usage = { connections: 1, bytes: 104857600, limit_bytes: 524288000, remaining_bytes: 419430400 };
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('AccountPage risk controls', () => {
    it('one-tap lock sets locked immediately', async () => {
        await render();
        expect(textOf(byTestId('risk-lock-state'))).toContain('未鎖單');
        await act(async () => { byTestId('risk-lock').props.onClick(); });
        expect(m.setRiskSettings).toHaveBeenCalledWith({ locked: true });
        expect(textOf(byTestId('risk-lock-state'))).toContain('已鎖單');
        expect(allByTestId('risk-lock')).toHaveLength(0);
    });

    it('unlocking requires the slide confirmation, not a tap', async () => {
        m.risk = { ...m.risk, locked: true };
        await render();
        await act(async () => { byTestId('risk-unlock').props.onClick(); });
        expect(m.setRiskSettings).not.toHaveBeenCalled();
        expect(allByTestId('account-risk-unlock-sheet')).toHaveLength(1);
        expect(allByTestId('account-risk-unlock-slide')).toHaveLength(1);
        // 鍵盤操作滑動確認：End 推到底，Enter 才確認
        const slider = () => view!.root.find(n => n.type === 'div' && n.props.role === 'slider');
        await act(async () => { slider().props.onKeyDown({ key: 'End', preventDefault: () => undefined }); });
        expect(m.setRiskSettings).not.toHaveBeenCalled();
        await act(async () => { slider().props.onKeyDown({ key: 'Enter', preventDefault: () => undefined }); });
        expect(m.setRiskSettings).toHaveBeenCalledWith({ locked: false });
    });

    it('shows that the lock only applies to this device', async () => {
        await render();
        expect(textOf(byTestId('risk-device-only'))).toContain('此鎖定只對本裝置有效');
    });

    it('manual order confirmation is shown locked on and cannot be turned off', async () => {
        m.risk = { ...m.risk, confirmManualOrders: false }; // 桌面設定為關閉也一樣
        await render();
        const row = byTestId('risk-manual-confirm');
        expect(textOf(row)).toContain('鎖定開啟');
        const sw = byTestId('risk-manual-confirm-switch');
        expect(sw.props.role).toBe('switch');
        expect(sw.props['aria-checked']).toBe(true);
        expect(sw.props.disabled).toBe(true);
        await act(async () => { sw.props.onClick(); });
        expect(m.setRiskSettings).not.toHaveBeenCalled();
        expect(sw.props['aria-checked']).toBe(true);
    });

    it('limit inputs commit valid integers and reject invalid input', async () => {
        await render();
        const qty = () => byTestId('risk-max-qty');
        await act(async () => { qty().props.onFocus(); qty().props.onChange({ target: { value: '5' } }); });
        await act(async () => { qty().props.onBlur(); });
        expect(m.setRiskSettings).toHaveBeenCalledWith({ maxQty: 5 });
        m.setRiskSettings.mockClear();
        await act(async () => { qty().props.onFocus(); qty().props.onChange({ target: { value: '-3' } }); });
        await act(async () => { qty().props.onBlur(); });
        expect(m.setRiskSettings).not.toHaveBeenCalled();
        expect(qty().props['aria-invalid']).toBe(true);
        expect(qty().props.inputMode).toBe('numeric');
    });

    it('enable switch toggles the risk rules', async () => {
        await render();
        await act(async () => { byTestId('risk-enabled').props.onClick(); });
        expect(m.setRiskSettings).toHaveBeenCalledWith({ enabled: true });
    });
});

describe('AccountPage funds and status', () => {
    it('shows balance, settlements (sorted, signed) and futures margin', async () => {
        await render();
        expect(textOf(byTestId('funds-balance'))).toBe('$1,234,567');
        expect(textOf(byTestId('funds-equity'))).toBe('$500,000');
        const settle = textOf(byTestId('funds-settlements'));
        expect(settle.indexOf('T 日')).toBeLessThan(settle.indexOf('T+1'));
        expect(settle).toContain('−$50,000');
        expect(settle).toContain('+$12,000');
        expect(m.fetchSettlements).toHaveBeenCalledTimes(1);
        expect(m.fetchSettlements).toHaveBeenCalledWith(stock);
    });

    it('masks money when privacy money is on', async () => {
        m.privMoney = true;
        await render();
        expect(textOf(byTestId('funds-balance'))).toBe('•••••');
        expect(textOf(byTestId('funds-equity'))).toBe('•••••');
        expect(text()).not.toContain('1,234,567');
        expect(text()).not.toContain('50,000');
        expect(byTestId('risk-max-loss').props.disabled).toBe(true);
    });

    it(`reuses settlements within ${SETTLEMENT_REUSE_MS} ms when the page reopens`, async () => {
        await render();
        await act(async () => view!.unmount());
        await render();
        expect(m.fetchSettlements).toHaveBeenCalledTimes(1);
    });

    it('shows server mode, usage, P1 placeholders and diagnostics', async () => {
        await render();
        expect(textOf(byTestId('server-mode'))).toBe('模擬');
        expect(textOf(byTestId('server-usage'))).toContain('100 MiB');
        expect(text()).toContain('即將提供');
        expect(allByTestId('diag-build')).toHaveLength(1);
        expect(m.refreshHealth).toHaveBeenCalledTimes(1);
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);
    });

    it('shows E.SUN bridge session state from the service health', async () => {
        m.esunHealth = { ok: true, configured: true, problems: [], environment: 'SIMULATION', account: null, loggedIn: true, loginError: null, sessionExpired: true, wsConnected: false };
        await render();
        const esun = textOf(byTestId('conn-esun'));
        expect(esun).toContain('已登入');
        expect(esun).toContain('模擬');
        expect(esun).toContain('已失效');
        expect(esun).toContain('未連線');
    });
});
