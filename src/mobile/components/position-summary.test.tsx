// 持倉頁摘要卡的「今日剩餘交易額度」一行：永豐剩餘、玉山上限、無資料、遮蔽金額、只看期貨時不顯示、沒有證券帳戶不顯示、
// 點擊只導覽到帳戶頁（不發請求、不送單）、額度查詢同步丟出時只隱藏這一行。以 vi.mock 隔離 src/lib，不打任何 API。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    accounts: {} as { selectedStock: unknown; selectedFutures: unknown },
    fetchTradingLimits: vi.fn(),
    navigate: vi.fn(),
}));

vi.mock('../../lib/account-store', () => ({ useAccounts: () => m.accounts }));
vi.mock('../../lib/shioaji', () => ({ fetchTradingLimits: m.fetchTradingLimits }));
vi.mock('../../lib/privacy', () => ({ maskMoney: (t: string, p: boolean) => (p ? '•••••' : t) }));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));

import { resetTradingLimitsForTest } from '../hooks/use-trading-limits';
import { consumeTodayLimitsFocus, resetTodayLimitsFocusForTest, todayLimitsLineLabel, todayLimitView } from './account/today-limits';
import type { PositionsSummary } from './position-metrics';
import { PositionSummaryCard } from './position-summary';

const sinopac = { account_type: 'S', broker_id: '9A95', account_id: '1234567' } as const;
const esun = { account_type: 'S', broker_id: '8840', account_id: '0099887' } as const;
const fut = { account_type: 'F', broker_id: 'F002000', account_id: '7654321' } as const;
const limits = (over: Record<string, number> = {}) => ({
    trading_limit: 1000000, trading_used: 200000, trading_available: 800000, margin_limit: 0, margin_used: 0, margin_available: 0, short_limit: 0, short_used: 0, short_available: 0, ...over,
});
const stockSummary: PositionsSummary = { count: 1, pnl: 100, marketValue: { value: 100000, incomplete: false }, stockCost: 99900, pnlPct: 0.1 };
const futuresSummary: PositionsSummary = { count: 1, pnl: 100, marketValue: null, stockCost: null, pnlPct: null };

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const byTestId = (id: string) => view!.root.findAll(n => n.props?.['data-testid'] === id && typeof n.type === 'string');
async function render(summary: PositionsSummary = stockSummary, privMoney = false, limitsAccount?: { account_type: 'S' | 'F'; broker_id: string; account_id: string } | null) {
    await act(async () => {
        view = create(createElement(PositionSummaryCard, { summary, known: true, margin: null, futuresLabel: '', privMoney, limitsAccount }));
    });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetTradingLimitsForTest();
    resetTodayLimitsFocusForTest();
    m.accounts = { selectedStock: sinopac, selectedFutures: fut };
    m.fetchTradingLimits.mockReset().mockResolvedValue(limits());
    m.navigate.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('PositionSummaryCard 今日剩餘交易額度', () => {
    it('永豐: shows the remaining cash limit from the shared cache (one query)', async () => {
        await render();
        const line = byTestId('position-limits-line')[0]!;
        expect(text(line)).toContain('永豐 今日剩餘額度');
        expect(text(byTestId('position-limits-value')[0]!)).toBe('$800,000');
        expect(line.props['aria-label']).toContain('永豐 今日剩餘額度 $800,000');
        expect(m.fetchTradingLimits).toHaveBeenCalledTimes(1);
        expect(m.fetchTradingLimits).toHaveBeenCalledWith({ broker_id: '9A95', account_id: '1234567' });
    });

    it('玉山: labels the cap as 上限, never 剩餘', async () => {
        m.accounts = { selectedStock: esun, selectedFutures: null };
        m.fetchTradingLimits.mockResolvedValue(limits({ trading_limit: 2000000, trading_available: 2000000, trading_used: 0 }));
        await render();
        const line = text(byTestId('position-limits-line')[0]!);
        expect(line).toContain('玉山 今日額度上限');
        expect(line).not.toContain('剩餘');
        expect(line).not.toContain('永豐');
        expect(text(byTestId('position-limits-value')[0]!)).toBe('$2,000,000');
    });

    it('no data shows — with a note instead of $0', async () => {
        m.fetchTradingLimits.mockResolvedValue(limits({ trading_limit: 0, trading_used: 0, trading_available: 0 }));
        await render();
        expect(byTestId('position-limits-line')[0]!.props['data-status']).toBe('empty');
        expect(text(byTestId('position-limits-value')[0]!)).toBe('—（非交易時段或模擬環境）');
    });

    it('masks the amount when 遮蔽金額 is on', async () => {
        await render(stockSummary, true);
        expect(text(byTestId('position-limits-value')[0]!)).toBe('•••••');
        expect(byTestId('position-limits-line')[0]!.props['aria-label']).not.toContain('800,000');
    });

    it('is hidden for a futures-only view and without a stock account', async () => {
        await render(futuresSummary);
        expect(byTestId('position-limits-line')).toHaveLength(0);
        await act(async () => view!.unmount());
        m.accounts = { selectedStock: null, selectedFutures: fut };
        await render();
        expect(byTestId('position-limits-line')).toHaveLength(0);
        expect(m.fetchTradingLimits).not.toHaveBeenCalled(); // 不顯示就不查
    });

    it('an account filter shows that stock account (not the selected one); a futures account falls back to the selected stock account', async () => {
        m.fetchTradingLimits.mockImplementation(async (a: { broker_id: string }) =>
            (a.broker_id === esun.broker_id ? limits({ trading_limit: 3000000, trading_available: 3000000, trading_used: 0 }) : limits()));
        await render(stockSummary, false, esun);
        expect(m.fetchTradingLimits).toHaveBeenCalledTimes(1);
        expect(m.fetchTradingLimits).toHaveBeenCalledWith({ broker_id: '8840', account_id: '0099887' });
        expect(text(byTestId('position-limits-line')[0]!)).toContain('玉山 今日額度上限');
        expect(text(byTestId('position-limits-value')[0]!)).toBe('$3,000,000');
        await act(async () => view!.unmount());
        // 期貨帳戶（不是證券帳戶）→ 沿用目前選取的證券帳戶
        await render(stockSummary, false, fut);
        expect(m.fetchTradingLimits).toHaveBeenLastCalledWith({ broker_id: '9A95', account_id: '1234567' });
        expect(text(byTestId('position-limits-line')[0]!)).toContain('永豐 今日剩餘額度');
        await act(async () => view!.unmount());
        // 未提供 → 目前選取的證券帳戶
        await render(stockSummary, false, null);
        expect(text(byTestId('position-limits-value')[0]!)).toBe('$800,000');
    });

    it('todayLimitsLineLabel prefixes the broker name', () => {
        expect(todayLimitsLineLabel(sinopac)).toBe('永豐 今日剩餘額度');
        expect(todayLimitsLineLabel(esun)).toBe('玉山 今日額度上限');
    });

    it('tapping navigates to the account card only (no query, no order)', async () => {
        await render();
        await act(async () => { byTestId('position-limits-line')[0]!.props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'account' });
        expect(consumeTodayLimitsFocus()).toBe(true);
        expect(m.fetchTradingLimits).toHaveBeenCalledTimes(1);
    });

    it('a synchronous failure of the limits query only hides the line', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            m.fetchTradingLimits.mockImplementation(() => { throw new Error('boom'); });
            await render();
            expect(byTestId('position-limits-line')).toHaveLength(0);
            expect(byTestId('position-total')).toHaveLength(1);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('todayLimitView', () => {
    it('covers loading, error, empty, 永豐 and 玉山', () => {
        expect(todayLimitView({ data: null, error: null, loading: true }, false).status).toBe('loading');
        expect(todayLimitView({ data: null, error: null, loading: false }, false).status).toBe('loading');
        expect(todayLimitView({ data: null, error: 'x', loading: false }, false).status).toBe('error');
        expect(todayLimitView({ data: limits({ trading_limit: 0, trading_used: 0, trading_available: 0 }), error: null, loading: false }, false).status).toBe('empty');
        expect(todayLimitView({ data: limits(), error: null, loading: false }, false)).toEqual({ status: 'ok', capsOnly: false, primary: 800000, used: 200000, total: 1000000 });
        expect(todayLimitView({ data: limits(), error: null, loading: false }, true)).toEqual({ status: 'ok', capsOnly: true, primary: 1000000, used: null, total: null });
    });
});
