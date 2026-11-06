// 帳戶頁（規格 §6.7、§10）：風控一鍵鎖單（鎖定立即生效、解除需滑動確認）、
// 「手動下單確認」一律顯示鎖定開啟且不可關閉（不寫入桌面設定）、明示只對本裝置有效、遮蔽金額；
// 資金／交割行事曆／交易額度／已實現損益／玉山帳務概覽／永豐預收（按需讀取＋冷卻）、三個樁的掛載位置。
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
        route: { simulation: false } as { simulation: boolean | undefined },
        fetchSettlements: vi.fn(),
        fetchHealth: vi.fn(),
        fetchInfo: vi.fn(),
        fetchProfitLoss: vi.fn(),
        fetchProfitLossSummary: vi.fn(),
        fetchTradingLimits: vi.fn(),
        fetchStockReserveSummary: vi.fn(),
        fetchStockReserveDetail: vi.fn(),
        fetchEarmarkingDetail: vi.fn(),
        fetchAccountOverview: vi.fn(),
        refreshHealth: vi.fn(async () => null),
        esunHealth: null as unknown,
        esunTx: null as unknown,
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
    maskAccountId: (id: string, priv: boolean) => (priv ? `••${id.slice(-2)}` : id),
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
        fetchAccountOverview: m.fetchAccountOverview,
    },
    isEsunAccount: (a?: { broker_id?: string } | null) => !!a?.broker_id?.startsWith('ESUN'),
    isEsunBroker: (b?: string | null) => !!b?.startsWith('ESUN'),
    useEsunEnvironment: () => ({ environment: 'SIMULATION', isSimulation: true }),
    clampEsunDateRange180Days: (beginDate: string, endDate: string) => ({ beginDate, endDate, clamped: false }),
    findEsunTransactionDetail: (details: { rowId: number }[] | undefined, row: { id: number }) => details?.find(d => d.rowId === row.id),
    useEsunTransactionDetails: (ref: unknown) => (ref ? m.esunTx : null),
    getEsunInventoryDetailsSnapshot: () => null,
    subscribeEsunInventoryDetails: () => () => undefined,
    findEsunInventoryDetail: () => undefined,
}));
vi.mock('../../lib/esun/stream', () => ({ getEsunStreamStatus: () => 'live' }));
vi.mock('../../lib/stream', () => ({ getLastHeartbeat: () => 0, streamConnectionEpoch: () => 3 }));
vi.mock('../../hooks/use-stream', () => ({ useStreamStatus: () => 'live' }));
vi.mock('../../hooks/use-monitor-resource', () => ({ useMonitorResource: () => ({ data: m.usage, error: '', updated: null, base: '' }) }));
vi.mock('../../lib/server-info-store', () => ({ useServerInfo: () => m.info }));
vi.mock('../../lib/shioaji', () => ({
    fetchSettlements: m.fetchSettlements,
    fetchHealth: m.fetchHealth,
    fetchInfo: m.fetchInfo,
    fetchProfitLoss: m.fetchProfitLoss,
    fetchProfitLossSummary: m.fetchProfitLossSummary,
    fetchTradingLimits: m.fetchTradingLimits,
    fetchStockReserveSummary: m.fetchStockReserveSummary,
    fetchStockReserveDetail: m.fetchStockReserveDetail,
    fetchEarmarkingDetail: m.fetchEarmarkingDetail,
}));
vi.mock('../../lib/settle-date', () => ({ settleDateLabel: (raw: string) => raw, bizDateLabel: (t: number) => `biz+${t}` }));
vi.mock('../../lib/realized-name', () => ({ canonicalBrokerCode: (c: string) => c.trim() }));
vi.mock('../../lib/theme-store', () => ({ useThemeSettings: () => ({ mode: 'dark', convention: 'tw', fontScale: 1.15 }), setThemeSettings: m.setThemeSettings }));
vi.mock('../components/account-switch-sheet', () => ({
    AccountSwitchSheet: () => null,
    mobileAccountLabel: (a: { account_id: string }) => `***${a.account_id.slice(-4)}`,
}));
vi.mock('../components/route-badge', () => ({ RouteBadge: () => null, useOrderRoute: () => m.route }));
// 三個樁由別的任務實作：這裡換成可辨識的節點，只驗證掛載位置
vi.mock('../components/account/trading-cost-section', () => ({ TradingCostSection: () => createElement('div', { 'data-testid': 'stub-trading-cost' }) }));
vi.mock('../components/account/device-settings-section', () => ({ DeviceSettingsSection: () => createElement('div', { 'data-testid': 'stub-device-settings' }) }));
vi.mock('../components/account/esun-reconnect-section', () => ({ EsunReconnectSection: () => createElement('div', { 'data-testid': 'stub-esun-reconnect' }) }));

import { loadTradingLimits, resetTradingLimitsForTest, TRADING_LIMITS_MIN_REFRESH_MS } from '../hooks/use-trading-limits';
import { AccountPage, resetAccountPageCacheForTest, SETTLEMENT_REUSE_MS } from './account-page';

const stock = { account_type: 'S', broker_id: '9A95', account_id: '1234567', person_id: 'A1' };
const fut = { account_type: 'F', broker_id: 'F002000', account_id: '7654321', person_id: 'A1' };
const esunStock = { account_type: 'S', broker_id: 'ESUN', account_id: '0011223', person_id: 'A1' };

/** 台北日期 YYYY-MM-DD（offset 天） */
function twDate(offsetDays: number, base = Date.now()): string {
    const d = new Date(base + 8 * 3600_000 + offsetDays * 86_400_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

let view: ReactTestRenderer | undefined;
async function render() {
    await act(async () => { view = create(createElement(AccountPage)); });
}
async function rerender() {
    await act(async () => { view!.update(createElement(AccountPage)); });
}
const byTestId = (id: string): ReactTestInstance => view!.root.find(n => n.props['data-testid'] === id && typeof n.type === 'string');
const allByTestId = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const text = () => JSON.stringify(view!.toJSON());
const textOf = (node: ReactTestInstance): string =>
    node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
/** 依文件順序列出帶 data-testid 的 host 節點 */
const testIdOrder = (): string[] => view!.root.findAll(n => typeof n.type === 'string' && typeof n.props['data-testid'] === 'string').map(n => n.props['data-testid'] as string);
async function click(id: string) {
    await act(async () => { byTestId(id).props.onClick(); });
}

function stockPnl(id: number, code: string, pnl: number) {
    return { id, code, quantity: 1, pnl, date: twDate(0).replace(/-/g, ''), dseq: `D${id}`, price: 100, pr_ratio: 0, cond: 'Cash', seqno: `S${id}` };
}
function pnlSum(pnl: number, rows: number) {
    return {
        profitloss_sum: Array.from({ length: rows }, () => ({ code: 'X', quantity: 1, pnl, pr_ratio: 0, entry_price: 0, cover_price: 0, entry_cost: 0, cover_cost: 0, buy_cost: 0, sell_cost: 0, cond: 'Cash', currency: 'TWD' })),
        total: { entry_amount: 0, cover_amount: 0, quantity: 0, buy_cost: 0, sell_cost: 0, pnl, pr_ratio: 0 },
    };
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetAccountPageCacheForTest();
    resetTradingLimitsForTest();
    m.risk = { enabled: false, maxQty: 0, maxDailyLoss: 0, locked: false, escCancelAll: false, confirmManualOrders: false, orderLineLock: false };
    m.riskListeners.clear();
    m.setRiskSettings.mockClear();
    m.privMoney = false;
    m.route = { simulation: false };
    m.accounts = { accounts: [stock, fut], selectedStock: stock, selectedFutures: fut, loaded: true, loadError: false };
    m.trading = {
        positions: [],
        funds: [
            { account: stock, balance: { acc_balance: 1234567, date: twDate(0), errmsg: '' }, updatedAt: Date.now() },
            {
                account: fut,
                margin: { equity: 500000, available_margin: 300000, initial_margin: 100000, maintenance_margin: 80000, risk_indicator: 250, today_balance: 1, future_settle_profitloss: -1500 },
                updatedAt: Date.now(),
            },
        ],
    };
    m.fetchSettlements.mockReset().mockResolvedValue([
        { date: twDate(1), amount: -50000, T: 1 },
        { date: twDate(0), amount: 0, T: 0 },
        { date: twDate(2), amount: 12000, T: 2 },
    ]);
    m.fetchHealth.mockReset().mockResolvedValue({ status: 'ok', version: '1.7.10', ca_expires_in_days: 120 });
    m.fetchInfo.mockReset().mockResolvedValue({ version: '1.7.10', simulation: true });
    m.fetchProfitLoss.mockReset().mockImplementation(async (market: string) => (market === 'S'
        ? [stockPnl(1, '2330', 300), stockPnl(2, '2317', -900)]
        : [{ id: 1, code: 'TXFL6', quantity: 1, pnl: 2000, date: twDate(0), direction: 'Buy', entry_price: 1, cover_price: 2, fee: 0, tax: 0 }]));
    m.fetchProfitLossSummary.mockReset().mockImplementation(async (market: string) => (market === 'S' ? pnlSum(-555, 2) : pnlSum(0, 0)));
    m.fetchTradingLimits.mockReset().mockResolvedValue({
        trading_limit: 0, trading_used: 0, trading_available: 0, margin_limit: 0, margin_used: 0, margin_available: 0, short_limit: 0, short_used: 0, short_available: 0,
    });
    m.fetchStockReserveSummary.mockReset().mockResolvedValue({ stocks: [{ contract: { code: '2330' }, available_share: 2000, reserved_share: 1000 }], account: stock });
    m.fetchStockReserveDetail.mockReset().mockResolvedValue({ stocks: [], account: stock });
    m.fetchEarmarkingDetail.mockReset().mockRejectedValue(new Error('earmark down'));
    m.fetchAccountOverview.mockReset().mockResolvedValue({
        balance: { availableBalance: 88000, exchangeBalance: 0, preSaveAmount: 1000, isLatestData: false, updatedAt: '2026-11-05T01:00:00Z', cached: true, cacheAgeSec: 12, },
        tradeStatus: { tradeLimit: 500000, marginLimit: 0, shortLimit: 0, dayTradeCode: 'N', dayTradeLabel: '不可當沖', marginCode: '9', marginLabel: '未開戶', shortCode: '9', shortLabel: '未開戶' },
        marketStatus: { isTradingDay: true, lastTradingDay: '2026-11-04', nextTradingDay: '2026-11-06' },
    });
    m.refreshHealth.mockClear();
    m.esunHealth = null;
    m.esunTx = null;
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

describe('AccountPage layout', () => {
    it('mounts the three stub sections in place and drops the coming-soon card', async () => {
        await render();
        const order = testIdOrder();
        const at = (id: string) => order.indexOf(id);
        expect(at('stub-trading-cost')).toBeGreaterThan(at('account-risk'));
        expect(at('stub-trading-cost')).toBeLessThan(at('account-connection'));
        expect(at('stub-device-settings')).toBeGreaterThan(at('account-display'));
        expect(at('stub-device-settings')).toBeLessThan(at('account-diagnostics'));
        // 玉山重新連線在連線卡的玉山 bridge 區塊內
        expect(byTestId('conn-esun-block').findAll(n => n.props['data-testid'] === 'stub-esun-reconnect')).toHaveLength(1);
        expect(text()).not.toContain('即將提供');
        expect(allByTestId('account-coming-soon')).toHaveLength(0);
    });
});

describe('AccountPage funds and settlements', () => {
    it('shows balance, futures margin details, risk bar and settle P&L', async () => {
        await render();
        expect(textOf(byTestId('funds-balance'))).toBe('$1,234,567');
        expect(textOf(byTestId('funds-equity'))).toBe('$500,000');
        expect(textOf(byTestId('funds-initial-margin'))).toBe('$100,000');
        expect(textOf(byTestId('funds-maintenance-margin'))).toBe('$80,000');
        expect(textOf(byTestId('funds-risk'))).toBe('250%（安全）');
        expect(byTestId('funds-risk-bar').props['aria-valuenow']).toBe(250);
        expect(textOf(byTestId('funds-settle-pnl'))).toBe('−$1,500');
    });

    it('shows fixed T+0/T+1/T+2 rows (sorted, signed) and the pending total', async () => {
        m.fetchSettlements.mockResolvedValue([{ date: twDate(2), amount: 12000, T: 2 }]);
        await render();
        const settle = textOf(byTestId('funds-settlements'));
        expect(settle.indexOf('T+0')).toBeLessThan(settle.indexOf('T+1'));
        expect(settle.indexOf('T+1')).toBeLessThan(settle.indexOf('T+2'));
        expect(settle).toContain('biz+0'); // 缺的列補 0
        expect(settle).toContain('+$12,000');
        expect(textOf(byTestId('settle-pending'))).toBe('+$12,000');
        expect(m.fetchSettlements).toHaveBeenCalledTimes(1);
        expect(m.fetchSettlements).toHaveBeenCalledWith(stock);
    });

    it('computes market value and total assets from liquidation value, pending settlements and cash', async () => {
        m.trading = {
            ...m.trading,
            positions: [{ code: '2330', direction: 'Buy', quantity: 2000, price: 450, last_price: 500, pnl: 100000, yd_quantity: 2000, cond: 'Cash', account: stock }],
        };
        await render();
        expect(textOf(byTestId('funds-market-value'))).toBe('$1,000,000');
        expect(textOf(byTestId('funds-pending'))).toBe('−$38,000');
        // 1,000,000 ×（1 − 0.1425% − 0.3%）＝ 995,575；＋（−38,000）＋ 1,234,567
        expect(textOf(byTestId('funds-total-assets'))).toBe('$2,192,142');
        expect(allByTestId('funds-total-reasons')).toHaveLength(0);
        await click('funds-breakdown-toggle');
        const breakdown = textOf(byTestId('funds-breakdown'));
        expect(breakdown).toContain('2330 現股 2,000 股');
        expect(breakdown).toContain('$995,575');
    });

    it('marks the totals as pending when the balance snapshot is from a prior day', async () => {
        const yesterday = Date.now() - 86_400_000;
        m.trading = { ...m.trading, funds: [{ account: stock, balance: { acc_balance: 1000, date: twDate(-1), errmsg: '' }, updatedAt: yesterday }] };
        await render();
        expect(textOf(byTestId('funds-total-assets'))).toBe('待確認');
        expect(textOf(byTestId('funds-total-reasons'))).toContain('前一日');
        expect(allByTestId('settle-prior-day')).toHaveLength(1);
    });

    it('warns that settlements are stale after positions change', async () => {
        await render();
        expect(allByTestId('settle-stale')).toHaveLength(0);
        m.trading = {
            ...m.trading,
            positions: [{ code: '2330', direction: 'Buy', quantity: 1000, price: 450, last_price: 500, pnl: 0, yd_quantity: 0, cond: 'Cash', account: stock }],
        };
        await rerender();
        expect(allByTestId('settle-stale')).toHaveLength(1);
        expect(textOf(byTestId('funds-total-assets'))).toBe('待確認');
        expect(m.fetchSettlements).toHaveBeenCalledTimes(1); // 不自動重查
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

    it(`reuses settlements within ${SETTLEMENT_REUSE_MS} ms when the page reopens and blocks refresh`, async () => {
        await render();
        expect(byTestId('funds-settle-refresh').props.disabled).toBe(true);
        await act(async () => view!.unmount());
        await render();
        expect(m.fetchSettlements).toHaveBeenCalledTimes(1);
    });

    // X3 F4:F6：失敗也套用冷卻（不可連按、切回帳戶頁不重查）
    it('a failed settlement query also starts the cooldown: no double tap and no re-query on reopen', async () => {
        let t = Date.now();
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
        try {
            m.fetchSettlements.mockReset().mockRejectedValue(new Error('settle down'));
            await render();
            expect(m.fetchSettlements).toHaveBeenCalledTimes(1);
            expect(text()).toContain('settle down');
            const button = () => byTestId('funds-settle-refresh');
            expect(button().props.disabled).toBe(true);
            expect(textOf(button())).toBe(`更新交割款（${SETTLEMENT_REUSE_MS / 1000} 秒）`);
            // 即使直接觸發也不重查
            await click('funds-settle-refresh');
            expect(m.fetchSettlements).toHaveBeenCalledTimes(1);
            // 切回帳戶頁（重新掛載）：冷卻內不重查，仍顯示上次的錯誤
            t += 5_000;
            await act(async () => view!.unmount());
            await render();
            expect(m.fetchSettlements).toHaveBeenCalledTimes(1);
            expect(text()).toContain('settle down');
            expect(textOf(button())).toBe(`更新交割款（${SETTLEMENT_REUSE_MS / 1000 - 5} 秒）`);
            // 冷卻結束：再進頁面才查
            t += SETTLEMENT_REUSE_MS;
            m.fetchSettlements.mockResolvedValue([{ date: twDate(2), amount: 12000, T: 2 }]);
            await act(async () => view!.unmount());
            await render();
            expect(m.fetchSettlements).toHaveBeenCalledTimes(2);
            expect(text()).not.toContain('settle down');
        } finally {
            spy.mockRestore();
        }
    });

    it('shows the simulation note for an all-zero futures margin', async () => {
        m.route = { simulation: true };
        m.trading = { ...m.trading, funds: [{ account: fut, margin: { equity: 0, available_margin: 0, initial_margin: 0, maintenance_margin: 0, risk_indicator: 0, today_balance: 0, future_settle_profitloss: 0 }, updatedAt: Date.now() }] };
        await render();
        expect(text()).toContain('模擬環境無法查詢保證金');
    });
});

describe('AccountPage trading limits', () => {
    it('explains empty limits (simulation or outside 08:30–15:00) instead of showing $0', async () => {
        await render();
        expect(m.fetchTradingLimits).toHaveBeenCalledTimes(1);
        expect(textOf(byTestId('limits-empty'))).toContain('08:30–15:00');
        expect(allByTestId('limits-values')).toHaveLength(0);
        // 剛查過：重新整理受最短間隔限制
        expect(byTestId('limits-refresh').props.disabled).toBe(true);
    });

    it('shows the simulation-specific note', async () => {
        m.route = { simulation: true };
        await render();
        expect(textOf(byTestId('limits-empty'))).toContain('模擬環境不提供交易額度');
    });

    // X3 F4:F1：玉山只提供額度上限，不可顯示可用／剩餘
    it('E.SUN accounts show only the caps, never available / remaining', async () => {
        m.accounts = { accounts: [esunStock, fut], selectedStock: esunStock, selectedFutures: fut, loaded: true, loadError: false };
        // lib 對玉山把缺的可用補成上限
        m.fetchTradingLimits.mockResolvedValue({
            trading_limit: 2000000, trading_used: 0, trading_available: 2000000, margin_limit: 500000, margin_used: 0, margin_available: 500000, short_limit: 300000, short_used: 0, short_available: 300000,
        });
        await render();
        const v = textOf(byTestId('limits-values'));
        expect(v).toContain('現股 上限$2,000,000');
        expect(v).toContain('融資 上限$500,000');
        expect(v).toContain('融券 上限$300,000');
        expect(v).not.toContain('可用');
        expect(v).not.toContain(' / ');
        expect(textOf(byTestId('limits-caps-only'))).toContain('未提供可用／剩餘額度');
    });

    // X3 F4:F7：冷卻與 hook 的 TRADING_LIMITS_MIN_REFRESH_MS（以發出時間計）一致
    it('after a failed auto query the refresh cooldown follows the hook attempt time', async () => {
        let t = 5_000_000;
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
        try {
            m.fetchTradingLimits.mockRejectedValue(new Error('limits down'));
            await render();
            expect(m.fetchTradingLimits).toHaveBeenCalledTimes(1);
            expect(text()).toContain('limits down');
            // 自動查詢剛發出（失敗也算）：hook 在最短間隔內不會再查 → 停用並倒數
            expect(byTestId('limits-refresh').props.disabled).toBe(true);
            expect(textOf(byTestId('limits-refresh'))).toBe(`重新整理（${TRADING_LIMITS_MIN_REFRESH_MS / 1000} 秒）`);
            t += TRADING_LIMITS_MIN_REFRESH_MS;
            await rerender();
            expect(byTestId('limits-refresh').props.disabled).toBe(false);
            await click('limits-refresh');
            expect(m.fetchTradingLimits).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
    });

    it('a press the hook ignores (queried elsewhere moments ago) shows a note instead of a fake countdown', async () => {
        let t = 7_000_000;
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
        try {
            m.fetchTradingLimits.mockRejectedValue(new Error('limits down'));
            // 下單面板剛查過（失敗）
            await loadTradingLimits(stock);
            t += 3_000;
            await render();
            expect(m.fetchTradingLimits).toHaveBeenCalledTimes(1);
            await click('limits-refresh');
            // hook 忽略：沒有請求、不進入倒數，改顯示說明
            expect(m.fetchTradingLimits).toHaveBeenCalledTimes(1);
            expect(textOf(byTestId('limits-refresh'))).toBe('重新整理');
            expect(textOf(byTestId('limits-throttled'))).toContain(`至少 ${TRADING_LIMITS_MIN_REFRESH_MS / 1000} 秒`);
        } finally {
            spy.mockRestore();
        }
    });

    it('shows available / limit for cash, margin and short', async () => {
        m.fetchTradingLimits.mockResolvedValue({
            trading_limit: 1000000, trading_used: 0, trading_available: 800000, margin_limit: 500000, margin_used: 0, margin_available: 400000, short_limit: 300000, short_used: 0, short_available: 200000,
        });
        await render();
        const v = textOf(byTestId('limits-values'));
        expect(v).toContain('$800,000 / $1,000,000');
        expect(v).toContain('$400,000 / $500,000');
        expect(v).toContain('$200,000 / $300,000');
    });
});

describe('AccountPage realized P&L', () => {
    it('does not query until opened, then applies sum-first / list-fallback totals per account', async () => {
        await render();
        expect(m.fetchProfitLoss).not.toHaveBeenCalled();
        expect(m.fetchProfitLossSummary).not.toHaveBeenCalled();
        await click('account-pnl-toggle');
        expect(m.fetchProfitLoss).toHaveBeenCalledTimes(2);
        const today = twDate(0);
        expect(m.fetchProfitLoss).toHaveBeenCalledWith('S', stock, today, today);
        expect(m.fetchProfitLoss).toHaveBeenCalledWith('F', fut, today, today);
        // 證券 sum −555（有彙總列）；期貨 sum 空 → 列表加總 2,000
        expect(textOf(byTestId('pnl-total'))).toContain('+$1,445');
        // 依 |損益| 排序：TXFL6 2,000 → 2317 −900 → 2330 300
        const rows = allByTestId('pnl-row').map(textOf);
        expect(rows[0]).toContain('TXFL6');
        expect(rows[1]).toContain('2317');
        expect(rows[1]).toContain('−$900');
        expect(rows[2]).toContain('2330');
    });

    it('enforces the cooldown: query and re-open do not refetch', async () => {
        await render();
        await click('account-pnl-toggle');
        expect(m.fetchProfitLoss).toHaveBeenCalledTimes(2);
        expect(byTestId('pnl-query').props.disabled).toBe(true);
        await click('pnl-query');
        await click('account-pnl-toggle'); // 收合
        await click('account-pnl-toggle'); // 再展開（已有資料）
        expect(m.fetchProfitLoss).toHaveBeenCalledTimes(2);
    });

    it('changing the period waits for the query button', async () => {
        await render();
        await click('account-pnl-toggle');
        const week = byTestId('pnl-period').findAll(n => n.type === 'button')[1]!;
        await act(async () => { week.props.onClick(); });
        expect(m.fetchProfitLoss).toHaveBeenCalledTimes(2);
        expect(allByTestId('pnl-idle')).toHaveLength(1);
        await click('pnl-query');
        expect(m.fetchProfitLoss).toHaveBeenCalledTimes(4);
    });

    it('keeps other accounts when one account fails', async () => {
        m.fetchProfitLoss.mockImplementation(async (market: string) => {
            if (market === 'F') throw new Error('期貨逾時');
            return [stockPnl(1, '2330', 300)];
        });
        m.fetchProfitLossSummary.mockImplementation(async (market: string) => {
            if (market === 'F') throw new Error('期貨逾時');
            return pnlSum(0, 0);
        });
        await render();
        await click('account-pnl-toggle');
        expect(textOf(byTestId('pnl-total'))).toContain('+$300');
        expect(text()).toContain('部分帳戶查詢失敗');
        expect(text()).toContain('期貨逾時');
    });

    it('expands E.SUN rows into fills and trading costs', async () => {
        m.accounts = { accounts: [esunStock], selectedStock: esunStock, selectedFutures: null, loaded: true, loadError: false };
        m.esunTx = {
            fetchedAt: Date.now(),
            details: [{
                rowId: 1, code: '2330', name: '台積電', buySell: 'S', action: 'Sell', tradeType: '0', tradeTypeLabel: '現股', cond: 'Cash', marketCode: '', market: null,
                tradeDate: twDate(0), settleDate: twDate(2), profitLossDate: twDate(0).replace(/-/g, ''), shares: 1000, avgPrice: 600, priceQty: 600000, cost: -500000, income: 598000, realizedPnl: 98000, realizedPnlPct: 19.6,
                fills: [
                    { code: '2330', name: '', buySell: 'S', action: 'Sell', tradeType: '0', tradeTypeLabel: '', marketCode: '', market: null, orderNo: 'A1234', tradeDate: twDate(0), tradeTime: '09:01:02', settleDate: '', price: 600, shares: 1000, priceQty: 600000, fee: 855, shortFee: null, tax: 1800, capitalGainsTax: null, netAmount: 597345, realizedPnl: 98000, realizedPnlPct: 19.6, userDef: '' },
                ],
            }],
        };
        m.fetchProfitLoss.mockResolvedValue([stockPnl(1, '2330', 98000)]);
        m.fetchProfitLossSummary.mockResolvedValue(pnlSum(98000, 1));
        await render();
        await click('account-pnl-toggle');
        expect(m.fetchProfitLoss).toHaveBeenCalledTimes(1);
        expect(allByTestId('pnl-esun-limit')).toHaveLength(1);
        await click('pnl-esun-detail-toggle');
        expect(textOf(byTestId('pnl-esun-cost-total'))).toBe('$2,655');
        expect(textOf(byTestId('pnl-esun-detail'))).toContain('09:01:02');
    });
});

describe('AccountPage E.SUN overview and reserves', () => {
    it('reads the E.SUN overview on demand with a cooldown and hides the SinoPac reserve card', async () => {
        m.accounts = { accounts: [esunStock, fut], selectedStock: esunStock, selectedFutures: fut, loaded: true, loadError: false };
        await render();
        expect(allByTestId('account-reserve')).toHaveLength(0);
        expect(m.fetchAccountOverview).not.toHaveBeenCalled();
        await click('account-esun-overview-toggle');
        expect(m.fetchAccountOverview).toHaveBeenCalledTimes(1);
        expect(m.fetchAccountOverview).toHaveBeenCalledWith(esunStock);
        expect(textOf(byTestId('esun-available-balance'))).toBe('$88,000');
        const body = textOf(byTestId('esun-overview-body'));
        expect(body).toContain('非最新資料');
        expect(body).toContain('不可當沖');
        expect(body).toContain('2026-11-06');
        expect(byTestId('esun-overview-query').props.disabled).toBe(true);
        await click('esun-overview-query');
        expect(m.fetchAccountOverview).toHaveBeenCalledTimes(1);
    });

    it('does not query reserves in simulation and explains why', async () => {
        m.route = { simulation: true };
        await render();
        expect(allByTestId('account-esun-overview')).toHaveLength(0);
        await click('account-reserve-toggle');
        expect(textOf(byTestId('reserve-sim'))).toContain('模擬環境不支援');
        expect(m.fetchStockReserveSummary).not.toHaveBeenCalled();
        expect(m.fetchEarmarkingDetail).not.toHaveBeenCalled();
    });

    it('reads SinoPac reserves on demand (read-only) and tolerates a partial failure', async () => {
        await render();
        expect(m.fetchStockReserveSummary).not.toHaveBeenCalled();
        await click('account-reserve-toggle');
        expect(m.fetchStockReserveSummary).toHaveBeenCalledTimes(1);
        expect(m.fetchStockReserveDetail).toHaveBeenCalledTimes(1);
        expect(m.fetchEarmarkingDetail).toHaveBeenCalledTimes(1);
        const body = textOf(byTestId('reserve-body'));
        expect(body).toContain('2,000 股 / 1,000 股');
        expect(body).toContain('圈存明細暫時無法查詢');
        // 不提供任何申請動作
        const buttons = view!.root.findAll(n => n.type === 'button').map(textOf).join('|');
        expect(buttons).not.toMatch(/申請|預收股票|圈存申請/);
        await click('reserve-query');
        expect(m.fetchStockReserveSummary).toHaveBeenCalledTimes(1);
    });
});

describe('AccountPage status', () => {
    it('shows server mode, usage and diagnostics', async () => {
        await render();
        expect(textOf(byTestId('server-mode'))).toBe('模擬');
        expect(textOf(byTestId('server-usage'))).toContain('100 MiB');
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
