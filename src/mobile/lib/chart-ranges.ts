// src/mobile/lib/chart-ranges.ts — 手機圖表週期與查詢區間（規格 §9.3，純函式）
//
// K 線端點只回 1 分 K，資料量與天數成正比（股票每日約 270 根；期貨日盤＋夜盤約 1,140 根），
// 手機版縮短查詢區間：
//
// | 週期 | 股票   | 期貨／選擇權 |
// |------|--------|--------------|
// | 走勢 | 當日   | 當日（日盤／夜盤依 sessionWindowFor()） |
// | 1 分 | 1 天   | 1 天 |
// | 5 分 | 5 天   | 3 天 |
// | 15 分| 10 天  | 5 天 |
// | 60 分| 20 天  | 10 天 |
// | 日   | 120 天 | 20 天 |

import type { SecurityType } from '../../lib/types/contract';
import { dateStrOffset } from '../../lib/utils/kbars';

export type ChartPeriod = 'line' | '1m' | '5m' | '15m' | '60m' | '1D';

export interface ChartPeriodDef {
    key: ChartPeriod;
    /** 週期列的按鈕文字 */
    label: string;
    /** 聚合分鐘數（走勢＝1；日 K＝1440） */
    minutes: number;
}

export const CHART_PERIODS: readonly ChartPeriodDef[] = [
    { key: 'line', label: '走勢', minutes: 1 },
    { key: '1m', label: '1分', minutes: 1 },
    { key: '5m', label: '5分', minutes: 5 },
    { key: '15m', label: '15分', minutes: 15 },
    { key: '60m', label: '60分', minutes: 60 },
    { key: '1D', label: '日', minutes: 1440 },
];

export const DEFAULT_CHART_PERIOD: ChartPeriod = 'line';

/** 圖上最多保留的已聚合 K 棒數（規格 §9.3、§9.4） */
export const MAX_CHART_BARS = 5000;

/**
 * 走勢（當日）查詢的天數範圍：與桌面 intraday-chart 相同，查最近 4 天到明天，
 * 再以 pickIntradayWindow() 挑出最新（或進行中）的時段——週末、假日、開盤前也看得到上一段；
 * 期貨夜盤跨午夜的 K 棒掛在隔天日期，所以結束日是明天。
 */
export const INTRADAY_LOOKBACK_DAYS = 4;

/** 有夜盤的商品（期貨、選擇權）用較短的區間 */
export function isFuturesLike(secType: SecurityType): boolean {
    return secType === 'FUT' || secType === 'OPT';
}

const STOCK_DAYS: Record<Exclude<ChartPeriod, 'line'>, number> = { '1m': 1, '5m': 5, '15m': 10, '60m': 20, '1D': 120 };
const FUTURES_DAYS: Record<Exclude<ChartPeriod, 'line'>, number> = { '1m': 1, '5m': 3, '15m': 5, '60m': 10, '1D': 20 };

export function periodDef(period: ChartPeriod): ChartPeriodDef {
    return CHART_PERIODS.find(p => p.key === period) ?? CHART_PERIODS[0]!;
}

export function isChartPeriod(v: unknown): v is ChartPeriod {
    return typeof v === 'string' && CHART_PERIODS.some(p => p.key === v);
}

/** 手機查詢天數；走勢回傳 0（＝當日，實際查詢範圍見 chartQueryRange） */
export function mobileRangeDays(period: ChartPeriod, secType: SecurityType): number {
    if (period === 'line') return 0;
    return (isFuturesLike(secType) ? FUTURES_DAYS : STOCK_DAYS)[period];
}

/** fetchChartHistory() 的起訖日（台灣日期 YYYY-MM-DD） */
export function chartQueryRange(period: ChartPeriod, secType: SecurityType): { start: string; end: string } {
    if (period === 'line') return { start: dateStrOffset(INTRADAY_LOOKBACK_DAYS), end: dateStrOffset(-1) };
    return { start: dateStrOffset(mobileRangeDays(period, secType)), end: dateStrOffset(0) };
}

/** 只保留最後 max 根（不改動輸入陣列） */
export function capBars<T>(bars: readonly T[], max = MAX_CHART_BARS): T[] {
    return bars.length > max ? bars.slice(bars.length - max) : bars.slice();
}
