// 已實現損益：區間（台北日期）與合計規則（sum 優先、列表加總後備、逐帳戶判斷、|損益| 排序）
import { describe, expect, it } from 'vitest';
import type { ProfitLoss, ProfitLossSummaryTotal } from '../../lib/shioaji';
import {
    aggregateRealizedPnl,
    customRangeBounds,
    customRangeProblem,
    marketPnlTotal,
    PNL_MAX_RANGE_DAYS,
    PNL_MIN_INTERVAL_MS,
    PNL_PERIODS,
    pnlDateRange,
    pnlRangeDays,
    type PnlPart,
} from './account-pnl';

// 2026-11-05（週四）10:00 台北 = 02:00 UTC
const THU = Date.UTC(2026, 10, 5, 2, 0, 0);

function stockRow(id: number, code: string, pnl: number): ProfitLoss {
    return { id, code, quantity: 1, pnl, date: '20261105', dseq: `D${id}`, price: 100, pr_ratio: 0, cond: 'Cash', seqno: `S${id}` };
}

function sum(pnl: number, rows = 0): ProfitLossSummaryTotal {
    return {
        profitloss_sum: Array.from({ length: rows }, () => ({ code: '2330', quantity: 1, pnl, pr_ratio: 0, entry_price: 0, cover_price: 0, entry_cost: 0, cover_cost: 0, buy_cost: 0, sell_cost: 0, cond: 'Cash', currency: 'TWD' })),
        total: { entry_amount: 0, cover_amount: 0, quantity: 0, buy_cost: 0, sell_cost: 0, pnl, pr_ratio: 0 },
    };
}

describe('pnlDateRange', () => {
    it('uses Taipei dates for today, week (Monday), month and last 30 days', () => {
        expect(pnlDateRange('today', THU)).toEqual({ begin: '2026-11-05', end: '2026-11-05' });
        expect(pnlDateRange('week', THU)).toEqual({ begin: '2026-11-02', end: '2026-11-05' });
        expect(pnlDateRange('month', THU)).toEqual({ begin: '2026-11-01', end: '2026-11-05' });
        expect(pnlDateRange('30d', THU)).toEqual({ begin: '2026-10-07', end: '2026-11-05' });
    });

    it('rolls to the Taipei day even when UTC is still the previous day', () => {
        // 2026-11-08（週日）23:30 UTC = 2026-11-09（週一）07:30 台北
        const mon = Date.UTC(2026, 10, 8, 23, 30);
        expect(pnlDateRange('today', mon)).toEqual({ begin: '2026-11-09', end: '2026-11-09' });
        expect(pnlDateRange('week', mon)).toEqual({ begin: '2026-11-09', end: '2026-11-09' });
        // 週日：本週從週一起算
        const sun = Date.UTC(2026, 10, 8, 2, 0);
        expect(pnlDateRange('week', sun).begin).toBe('2026-11-02');
    });
});

describe('marketPnlTotal', () => {
    it('prefers the summary total when it has data', () => {
        expect(marketPnlTotal([stockRow(1, '2330', 10)], sum(500, 1))).toEqual({ total: 500, source: 'sum' });
        // total 為 0 但有彙總列：仍以 sum 為準
        expect(marketPnlTotal([stockRow(1, '2330', 10)], sum(0, 1))).toEqual({ total: 0, source: 'sum' });
    });

    it('falls back to the list sum when the summary is empty (simulation) or failed', () => {
        expect(marketPnlTotal([stockRow(1, '2330', 10), stockRow(2, '2317', -3)], sum(0))).toEqual({ total: 7, source: 'list' });
        expect(marketPnlTotal([stockRow(1, '2330', 10)], null)).toEqual({ total: 10, source: 'list' });
    });

    it('returns null when neither list nor summary is available', () => {
        expect(marketPnlTotal(null, null)).toEqual({ total: null, source: 'none' });
        expect(marketPnlTotal(null, sum(0))).toEqual({ total: null, source: 'none' });
    });
});

describe('aggregateRealizedPnl', () => {
    it('decides sum vs list per account and sorts rows by |pnl|', () => {
        const parts: PnlPart[] = [
            { market: 'S', accountKey: '9A95:1', list: [stockRow(1, '2330', 100), stockRow(2, '2317', -900)], sum: sum(1234, 2), errors: [] },
            { market: 'F', accountKey: 'F002:2', list: [stockRow(3, 'TXF', 50)], sum: sum(0), errors: [] },
        ];
        const r = aggregateRealizedPnl(parts);
        expect(r.total).toBe(1234 + 50);
        expect(r.incomplete).toBe(false);
        expect(r.markets.map(m => m.source)).toEqual(['sum', 'list']);
        expect(r.rows.map(x => x.code)).toEqual(['2317', '2330', 'TXF']);
        expect(r.rows[0]).toMatchObject({ market: 'S', accountKey: '9A95:1' });
    });

    it('marks the total incomplete when an account failed entirely', () => {
        const r = aggregateRealizedPnl([
            { market: 'S', accountKey: 'a', list: [stockRow(1, '2330', 10)], sum: null, errors: [] },
            { market: 'F', accountKey: 'b', list: null, sum: null, errors: ['永豐期貨損益明細查詢失敗：x'] },
        ]);
        expect(r.total).toBe(10);
        expect(r.incomplete).toBe(true);
        expect(r.errors).toEqual(['永豐期貨損益明細查詢失敗：x']);
    });

    it('returns null total when every account failed', () => {
        const r = aggregateRealizedPnl([{ market: 'S', accountKey: 'a', list: null, sum: null, errors: ['x'] }]);
        expect(r.total).toBeNull();
        expect(r.rows).toEqual([]);
    });
});

// 自訂區間：固定時間（不依賴今天是星期幾或月初）。2026-11-09 10:00 台北 = 02:00 UTC
const NOW = Date.UTC(2026, 10, 9, 2, 0, 0);

describe('custom range', () => {
    it('adds 自訂 as the last period option', () => {
        expect(PNL_PERIODS.map(p => p.text)).toEqual(['今日', '本週', '本月', '近 30 天', '自訂']);
    });

    it('counts days including both ends; invalid dates count as null', () => {
        expect(pnlRangeDays('2026-11-09', '2026-11-09')).toBe(1);
        expect(pnlRangeDays('2026-10-11', '2026-11-09')).toBe(30);
        // 跨月底與閏年 2 月
        expect(pnlRangeDays('2028-02-28', '2028-03-01')).toBe(3);
        expect(pnlRangeDays('2026-02-30', '2026-03-01')).toBeNull();
        expect(pnlRangeDays('', '2026-03-01')).toBeNull();
    });

    it('allows exactly 180 days (inclusive) and rejects 181 with the current count', () => {
        expect(PNL_MAX_RANGE_DAYS).toBe(180);
        expect(customRangeProblem('2026-05-14', '2026-11-09', NOW)).toBeNull();
        expect(customRangeProblem('2026-05-13', '2026-11-09', NOW)).toBe('區間最多 180 天（目前 181 天）。');
        expect(customRangeProblem('2026-04-23', '2026-11-09', NOW)).toBe('區間最多 180 天（目前 201 天）。');
        // 與今天無關的歷史區間也一樣：180 天可以、181 天不行
        expect(customRangeProblem('2025-01-01', '2025-06-29', NOW)).toBeNull();
        expect(customRangeProblem('2025-01-01', '2025-06-30', NOW)).toMatch(/目前 181 天/);
        expect(customRangeProblem('2026-11-09', '2026-11-09', NOW)).toBeNull();
    });

    it('rejects begin after end, end after today (Taipei), and blank or invalid dates', () => {
        expect(customRangeProblem('2026-11-05', '2026-11-01', NOW)).toBe('起日不能晚於迄日。');
        expect(customRangeProblem('2026-11-01', '2026-11-10', NOW)).toBe('迄日不能晚於今天（2026-11-09）。');
        expect(customRangeProblem('', '2026-11-09', NOW)).toBe('請選擇起日。');
        expect(customRangeProblem('2026-11-01', '', NOW)).toBe('請選擇迄日。');
        expect(customRangeProblem('2026-02-30', '2026-11-09', NOW)).toBe('起日不是有效的日期。');
        expect(customRangeProblem('2026-11-01', '2026/11/09', NOW)).toBe('迄日不是有效的日期。');
        expect(customRangeProblem('0005-01-01', '2026-11-09', NOW)).toBe('起日不是有效的日期。');
    });

    it('uses the Taipei date for "today" even when UTC is still the previous day', () => {
        // 2026-11-09 23:30 UTC = 2026-11-10 07:30 台北
        const late = Date.UTC(2026, 10, 9, 23, 30);
        expect(customRangeProblem('2026-11-01', '2026-11-10', late)).toBeNull();
        expect(customRangeProblem('2026-11-01', '2026-11-11', late)).toBe('迄日不能晚於今天（2026-11-10）。');
    });

    it('bounds: end max = today; begin max = end; begin min = end − 179 days', () => {
        expect(customRangeBounds('2026-11-09', NOW)).toEqual({ endMax: '2026-11-09', beginMax: '2026-11-09', beginMin: '2026-05-14' });
        expect(customRangeBounds('2026-10-01', NOW)).toEqual({ endMax: '2026-11-09', beginMax: '2026-10-01', beginMin: '2026-04-05' });
        // 迄日無效或晚於今天：以今天為準
        expect(customRangeBounds('', NOW).beginMax).toBe('2026-11-09');
        expect(customRangeBounds('2026-12-01', NOW).beginMin).toBe('2026-05-14');
        // 由 min 推得的區間正好是上限
        const b = customRangeBounds('2026-10-01', NOW);
        expect(pnlRangeDays(b.beginMin, '2026-10-01')).toBe(PNL_MAX_RANGE_DAYS);
    });

    it('the global interval keeps E.SUN realized P&L under ~8 requests per minute (2 GETs per query)', () => {
        const esunRequestsPerQuery = 2; // fetchProfitLoss + fetchProfitLossSummary → 各一個 GET /esun/portfolio/profit-loss
        expect(PNL_MIN_INTERVAL_MS).toBe(15_000);
        expect(Math.ceil(60_000 / PNL_MIN_INTERVAL_MS) * esunRequestsPerQuery).toBeLessThanOrEqual(8);
    });
});
