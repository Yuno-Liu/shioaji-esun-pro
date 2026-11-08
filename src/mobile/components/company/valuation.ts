// src/mobile/components/company/valuation.ts — 「估值與體質」卡的純函式（財務子分頁頂部；給長線投資者）
//
// - 資料只用同一份財報檔（lib/company-data 的 quarterMetrics 與 statements.income_ytd），不另發請求、不改 lib。
// - 只呈現算得出來的數字：缺資料、分母為 0 或負值時 value 為 null，reason 是簡短原因（畫面顯示「—」＋原因），不推估。
// - 金額單位：財報為千元；這裡的 *Yi 欄位已換成億元（千元 ÷ 1e5）。
// - 淨利同季度財報表：quarterMetrics 的 netIncome（優先歸屬母公司業主）。

import { quarterMetrics, type QuarterMetrics } from '../../../lib/company-data';
import type { Financials } from '../../../lib/company-data/types';

/** 千元 → 億元 */
export const toYi = (thousand: number | null): number | null => (thousand === null ? null : thousand / 1e5);

/** 億元顯示：≥100 億取整、≥1 億一位小數、其餘兩位；千分位；-0 顯示 0 */
export function fmtYi(yi: number | null | undefined): string {
    if (yi === null || yi === undefined || !Number.isFinite(yi)) return '—';
    const a = Math.abs(yi);
    const digits = a >= 100 ? 0 : a >= 1 ? 1 : 2;
    const text = yi.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

/** 2026Q2 → { year: 2026, quarter: 2 }；格式不符 null */
export function parseQuarter(period: string): { year: number; quarter: number } | null {
    const hit = /^(\d{4})Q([1-4])$/.exec(period);
    return hit ? { year: Number(hit[1]), quarter: Number(hit[2]) } : null;
}

const quarterOrdinal = (period: string): number | null => {
    const q = parseQuarter(period);
    return q ? q.year * 4 + q.quarter - 1 : null;
};

// ---- 股價淨值比 ----

export interface PriceToBook {
    pb: number | null;
    bookValuePerShare: number | null;
    period: string | null;
    reason: string | null;
}

/** P/B＝股價 ÷ 最新一季每股參考淨值 */
export function priceToBook(price: number | null, latest: QuarterMetrics | undefined): PriceToBook {
    if (!latest) return { pb: null, bookValuePerShare: null, period: null, reason: '沒有季報' };
    const bvps = latest.bookValuePerShare;
    const base = { bookValuePerShare: bvps, period: latest.period };
    if (bvps === null) return { ...base, pb: null, reason: `${latest.period} 沒有每股淨值` };
    if (bvps <= 0) return { ...base, pb: null, reason: bvps === 0 ? '每股淨值為 0，不適用' : '每股淨值為負，不適用' };
    if (price === null || !Number.isFinite(price) || price <= 0) return { ...base, pb: null, reason: '沒有股價' };
    return { ...base, pb: price / bvps, reason: null };
}

// ---- 負債比 ----

export interface DebtRatio {
    pct: number | null;
    period: string | null;
    reason: string | null;
}

/** 負債比＝最新一季負債總計 ÷ 資產總計 */
export function debtRatio(latest: QuarterMetrics | undefined): DebtRatio {
    if (!latest) return { pct: null, period: null, reason: '沒有季報' };
    const { totalAssets: assets, totalLiabilities: liabilities, period } = latest;
    if (assets === null || liabilities === null) return { pct: null, period, reason: `${period} 沒有資產或負債總計` };
    if (assets <= 0) return { pct: null, period, reason: '資產總計不為正，不適用' };
    if (liabilities < 0) return { pct: null, period, reason: '負債總計為負，資料異常' };
    return { pct: (liabilities / assets) * 100, period, reason: null };
}

// ---- 盈餘品質 ----

export type QualityVerdict = 'above' | 'below' | 'equal';

export const VERDICT_TEXT: Record<QualityVerdict, string> = {
    above: '營業現金流高於淨利',
    below: '營業現金流低於淨利',
    equal: '營業現金流與淨利相同',
};

export interface EarningsQuality {
    /** 億元；四季都有資料時才有 */
    cashFlowYi: number | null;
    netIncomeYi: number | null;
    /** 營業現金流合計 ÷ 淨利合計；淨利合計 ≤ 0 時 null */
    ratio: number | null;
    verdict: QualityVerdict | null;
    /** 最舊、最新季別（四季都在時） */
    from: string | null;
    to: string | null;
    reason: string | null;
}

/** 近四季營業現金流合計對照近四季淨利合計（quarters 為新到舊） */
export function earningsQuality(quarters: readonly QuarterMetrics[]): EarningsQuality {
    const empty = { cashFlowYi: null, netIncomeYi: null, ratio: null, verdict: null, from: null, to: null };
    const rows = quarters.slice(0, 4);
    if (rows.length < 4) return { ...empty, reason: '季報不足四季' };
    const ords = rows.map(r => quarterOrdinal(r.period));
    if (ords.some((o, i) => o === null || (i > 0 && o !== ords[i - 1]! - 1))) return { ...empty, reason: '近四季季別不連續' };
    const range = { from: rows[3]!.period, to: rows[0]!.period };
    const noCash = rows.find(r => r.operatingCashFlow === null);
    if (noCash) return { ...empty, ...range, reason: `${noCash.period} 沒有營業現金流` };
    const noIncome = rows.find(r => r.netIncome === null);
    if (noIncome) return { ...empty, ...range, reason: `${noIncome.period} 沒有淨利` };
    const cash = rows.reduce((sum, r) => sum + r.operatingCashFlow!, 0);
    const income = rows.reduce((sum, r) => sum + r.netIncome!, 0);
    const verdict: QualityVerdict = cash > income ? 'above' : cash < income ? 'below' : 'equal';
    const base = { ...range, cashFlowYi: toYi(cash), netIncomeYi: toYi(income), verdict };
    if (income <= 0) {
        return { ...base, ratio: null, reason: income === 0 ? '近四季淨利合計為 0，比值不適用' : '近四季淨利合計為虧損，比值不適用' };
    }
    return { ...base, ratio: cash / income, reason: null };
}

// ---- 獲利金額趨勢 ----

export interface ProfitRow {
    period: string;
    revenueYi: number | null;
    grossProfitYi: number | null;
    operatingIncomeYi: number | null;
    netIncomeYi: number | null;
}

export interface ProfitTrend {
    /** 新到舊（同季度財報表） */
    rows: ProfitRow[];
    /** 全部季別都沒有的欄位不顯示（金融業沒有毛利、營業利益） */
    hasGross: boolean;
    hasOperating: boolean;
}

export function profitTrend(quarters: readonly QuarterMetrics[], count = 8): ProfitTrend {
    const rows = quarters.slice(0, count).map(q => ({
        period: q.period,
        revenueYi: toYi(q.revenue),
        grossProfitYi: toYi(q.grossProfit),
        operatingIncomeYi: toYi(q.operatingIncome),
        netIncomeYi: toYi(q.netIncome),
    }));
    return {
        rows,
        hasGross: rows.some(r => r.grossProfitYi !== null),
        hasOperating: rows.some(r => r.operatingIncomeYi !== null),
    };
}

// ---- 累計 EPS ----

const YTD_EPS_ACCOUNTS = ['基本每股盈餘（元）', '基本每股盈餘'] as const;

function ytdEpsAt(fin: Financials, index: number): number | null {
    const table = fin.statements?.income_ytd;
    if (!table) return null;
    for (const name of YTD_EPS_ACCOUNTS) {
        const value = table[name]?.[index];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
}

export interface YtdEps {
    period: string | null;
    /** 「2026 年前 2 季」「2026 年第 1 季」 */
    label: string | null;
    value: number | null;
    prevPeriod: string | null;
    prev: number | null;
    /** 去年同期 > 0 時的成長率（%） */
    growthPct: number | null;
    /** 今年累計缺資料的原因 */
    reason: string | null;
    /** 去年同期或成長率不能算的原因 */
    prevReason: string | null;
}

/** 今年累計基本每股盈餘（最新一季的 income_ytd），對照去年同期 */
export function ytdEps(fin: Financials): YtdEps {
    const periods = fin.statements?.periods ?? [];
    const index = periods.length - 1;
    const period = periods[index] ?? null;
    const none = { label: null, value: null, prevPeriod: null, prev: null, growthPct: null, prevReason: null };
    if (period === null) return { ...none, period: null, reason: '沒有季報' };
    const q = parseQuarter(period);
    if (!q) return { ...none, period, reason: `無法辨識季別 ${period}` };
    const label = q.quarter === 1 ? `${q.year} 年第 1 季` : `${q.year} 年前 ${q.quarter} 季`;
    const value = ytdEpsAt(fin, index);
    if (value === null) return { ...none, period, label, reason: `${period} 沒有累計 EPS` };
    const prevPeriod = `${q.year - 1}Q${q.quarter}`;
    const prevIndex = periods.indexOf(prevPeriod);
    const prev = prevIndex >= 0 ? ytdEpsAt(fin, prevIndex) : null;
    const base = { period, label, value, prevPeriod, prev, reason: null };
    if (prev === null) return { ...base, growthPct: null, prevReason: '沒有去年同期資料' };
    if (prev <= 0) return { ...base, growthPct: null, prevReason: prev === 0 ? '去年同期為 0，不計成長率' : '去年同期為虧損，不計成長率' };
    return { ...base, growthPct: ((value - prev) / prev) * 100, prevReason: null };
}

// ---- 卡片用的整包（價格以外；價格由畫面即時帶入 priceToBook） ----

export interface Valuation {
    latest: QuarterMetrics | undefined;
    debt: DebtRatio;
    quality: EarningsQuality;
    trend: ProfitTrend;
    ytd: YtdEps;
}

export function buildValuation(fin: Financials): Valuation {
    const quarters = quarterMetrics(fin, 8);
    const latest = quarters[0];
    return {
        latest,
        debt: debtRatio(latest),
        quality: earningsQuality(quarters),
        trend: profitTrend(quarters),
        ytd: ytdEps(fin),
    };
}
