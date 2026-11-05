// 手機圖表區間（規格 §9.3）：週期列、股票／期權查詢天數、起訖日、5,000 根上限
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    capBars,
    CHART_PERIODS,
    chartQueryRange,
    isChartPeriod,
    isFuturesLike,
    MAX_CHART_BARS,
    mobileRangeDays,
    periodDef,
    type ChartPeriod,
} from './chart-ranges';

describe('CHART_PERIODS', () => {
    it('週期列：走勢、1分、5分、15分、60分、日', () => {
        expect(CHART_PERIODS.map(p => p.label)).toEqual(['走勢', '1分', '5分', '15分', '60分', '日']);
        expect(CHART_PERIODS.map(p => p.minutes)).toEqual([1, 1, 5, 15, 60, 1440]);
        expect(periodDef('15m').minutes).toBe(15);
    });

    it('isChartPeriod 只接受已知值', () => {
        expect(isChartPeriod('1D')).toBe(true);
        expect(isChartPeriod('line')).toBe(true);
        expect(isChartPeriod('3m')).toBe(false);
        expect(isChartPeriod(null)).toBe(false);
    });
});

describe('mobileRangeDays（§9.3 區間表）', () => {
    const table: [ChartPeriod, number, number][] = [
        ['line', 0, 0],
        ['1m', 1, 1],
        ['5m', 5, 3],
        ['15m', 10, 5],
        ['60m', 20, 10],
        ['1D', 120, 20],
    ];
    it.each(table)('%s：股票 %i 天、期權 %i 天', (period, stock, fop) => {
        expect(mobileRangeDays(period, 'STK')).toBe(stock);
        expect(mobileRangeDays(period, 'FUT')).toBe(fop);
        expect(mobileRangeDays(period, 'OPT')).toBe(fop);
    });

    it('指數、權證比照股票', () => {
        expect(mobileRangeDays('1D', 'IND')).toBe(120);
        expect(mobileRangeDays('5m', 'WRT')).toBe(5);
        expect(isFuturesLike('FUT')).toBe(true);
        expect(isFuturesLike('STK')).toBe(false);
    });
});

describe('chartQueryRange', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // 2026-11-05 10:00 台灣時間（UTC 02:00）
        vi.setSystemTime(new Date('2026-11-05T02:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('K 線：N 天前到今天（台灣日期）', () => {
        expect(chartQueryRange('5m', 'STK')).toEqual({ start: '2026-10-31', end: '2026-11-05' });
        expect(chartQueryRange('5m', 'FUT')).toEqual({ start: '2026-11-02', end: '2026-11-05' });
        expect(chartQueryRange('1D', 'STK')).toEqual({ start: '2026-07-08', end: '2026-11-05' });
        expect(chartQueryRange('1m', 'FUT')).toEqual({ start: '2026-11-04', end: '2026-11-05' });
    });

    it('走勢：最近 4 天到明天（夜盤跨午夜、週末與開盤前仍有上一段）', () => {
        expect(chartQueryRange('line', 'FUT')).toEqual({ start: '2026-11-01', end: '2026-11-06' });
        expect(chartQueryRange('line', 'STK')).toEqual({ start: '2026-11-01', end: '2026-11-06' });
    });

    it('以台灣日期計算（UTC 仍是前一天時已是台灣的隔天）', () => {
        vi.setSystemTime(new Date('2026-11-04T17:00:00Z')); // 台灣 11-05 01:00
        expect(chartQueryRange('1m', 'STK').end).toBe('2026-11-05');
    });
});

describe('capBars', () => {
    it('最多保留 5,000 根（保留最新的）且不改動輸入', () => {
        expect(MAX_CHART_BARS).toBe(5000);
        const bars = Array.from({ length: 5003 }, (_, i) => i);
        const capped = capBars(bars);
        expect(capped).toHaveLength(5000);
        expect(capped[0]).toBe(3);
        expect(capped[4999]).toBe(5002);
        expect(bars).toHaveLength(5003);
        expect(capBars([1, 2, 3], 2)).toEqual([2, 3]);
        expect(capBars([1, 2])).toEqual([1, 2]);
    });
});
