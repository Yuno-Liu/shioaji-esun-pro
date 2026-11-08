// 「估值與體質」卡的純函式：以 lib/company-data/__fixtures__/financials-2330.json（真實 v1 財報檔裁切）驗證計算，
// 另以合成季資料驗證缺資料（null＋原因）、0 與負值（分母不為正時不算比值）、季別不連續與金融業格式（沒有毛利）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { QuarterMetrics } from '../../../lib/company-data';
import type { Financials } from '../../../lib/company-data/types';
import {
    buildValuation,
    debtRatio,
    earningsQuality,
    fmtYi,
    parseQuarter,
    priceToBook,
    profitTrend,
    toYi,
    ytdEps,
} from './valuation';

const fin2330 = JSON.parse(
    readFileSync(new URL('../../../lib/company-data/__fixtures__/financials-2330.json', import.meta.url), 'utf8'),
) as Financials;

const q = (period: string, fields: Partial<QuarterMetrics> = {}): QuarterMetrics => ({
    period,
    format: 'general',
    revenue: 1000,
    grossProfit: 400,
    operatingIncome: 200,
    netIncome: 100,
    eps: 1,
    grossMarginPct: 40,
    operatingMarginPct: 20,
    netMarginPct: 10,
    totalAssets: 10_000,
    totalLiabilities: 4_000,
    equity: 6_000,
    bookValuePerShare: 20,
    operatingCashFlow: 150,
    ...fields,
});

/** 新到舊的連續四季 */
const four = (fields: Partial<QuarterMetrics>[] = [{}, {}, {}, {}]) =>
    ['2026Q2', '2026Q1', '2025Q4', '2025Q3'].map((p, i) => q(p, fields[i]));

const finWith = (periods: string[], ytd: Record<string, (number | null)[]>): Financials => ({
    code: '9999',
    name: '測試',
    market: 'twse',
    monthly_revenue: [],
    statements: {
        periods,
        format: periods.map(() => 'general'),
        income_quarter: {},
        income_ytd: ytd,
        balance: {},
        cash_flow_quarter: {},
        cash_flow_ytd: {},
    },
});

describe('2330 fixture（同一份財報檔）', () => {
    const v = buildValuation(fin2330);

    it('最新一季 2026Q2：P/B＝收盤 2405 ÷ 每股參考淨值 248.05；負債比＝負債總計 ÷ 資產總計', () => {
        expect(v.latest?.period).toBe('2026Q2');
        const pb = priceToBook(2405, v.latest);
        expect(pb.reason).toBeNull();
        expect(pb.bookValuePerShare).toBe(248.05);
        expect(pb.pb).toBeCloseTo(2405 / 248.05, 10);
        expect(pb.pb!.toFixed(2)).toBe('9.70');
        expect(v.debt.period).toBe('2026Q2');
        expect(v.debt.pct).toBeCloseTo((2901183746 / 9375654727) * 100, 10);
        expect(v.debt.pct!.toFixed(1)).toBe('30.9');
    });

    it('盈餘品質：2025Q3–2026Q2 營業現金流合計 ÷ 淨利（歸屬母公司）合計', () => {
        const cash = 426829081 + 725508787 + 698976265 + 783364977;
        const income = 452301407 + 505743990 + 572479752 + 706561938;
        expect(v.quality).toMatchObject({ from: '2025Q3', to: '2026Q2', verdict: 'above', reason: null });
        expect(v.quality.ratio).toBeCloseTo(cash / income, 10);
        expect(v.quality.ratio!.toFixed(2)).toBe('1.18');
        expect(v.quality.cashFlowYi).toBeCloseTo(cash / 1e5, 6);
        expect(v.quality.netIncomeYi).toBeCloseTo(income / 1e5, 6);
        expect(fmtYi(v.quality.cashFlowYi)).toBe('26,347');
        expect(fmtYi(v.quality.netIncomeYi)).toBe('22,371');
    });

    it('獲利金額：近 8 季（新到舊），千元換成億元', () => {
        expect(v.trend.rows.map(r => r.period)).toEqual(['2026Q2', '2026Q1', '2025Q4', '2025Q3', '2025Q2', '2025Q1', '2024Q4', '2024Q3']);
        expect(v.trend.hasGross && v.trend.hasOperating).toBe(true);
        const top = v.trend.rows[0]!;
        expect(top.revenueYi).toBeCloseTo(1270380250 / 1e5, 6);
        expect(fmtYi(top.revenueYi)).toBe('12,704');
        expect(fmtYi(top.grossProfitYi)).toBe('8,603');
        expect(fmtYi(top.operatingIncomeYi)).toBe('7,666');
        expect(fmtYi(top.netIncomeYi)).toBe('7,066');
    });

    it('累計 EPS：2026 年前 2 季 49.33，對照去年同期（2025Q2）29.31', () => {
        expect(v.ytd).toMatchObject({ period: '2026Q2', label: '2026 年前 2 季', value: 49.33, prevPeriod: '2025Q2', prev: 29.31, reason: null, prevReason: null });
        expect(v.ytd.growthPct).toBeCloseTo(((49.33 - 29.31) / 29.31) * 100, 10);
        expect(v.ytd.growthPct!.toFixed(1)).toBe('68.3');
    });
});

describe('股價淨值比', () => {
    it('沒有季報、沒有每股淨值、沒有股價：null＋原因（有每股淨值時仍附上）', () => {
        expect(priceToBook(100, undefined)).toEqual({ pb: null, bookValuePerShare: null, period: null, reason: '沒有季報' });
        expect(priceToBook(100, q('2026Q2', { bookValuePerShare: null }))).toMatchObject({ pb: null, reason: '2026Q2 沒有每股淨值' });
        for (const price of [null, 0, -5, Number.NaN]) {
            expect(priceToBook(price, q('2026Q2'))).toEqual({ pb: null, bookValuePerShare: 20, period: '2026Q2', reason: '沒有股價' });
        }
    });

    it('每股淨值為 0 或負：不適用（不算出負的或無限大的 P/B）', () => {
        expect(priceToBook(100, q('2026Q2', { bookValuePerShare: 0 }))).toMatchObject({ pb: null, bookValuePerShare: 0, reason: '每股淨值為 0，不適用' });
        expect(priceToBook(100, q('2026Q2', { bookValuePerShare: -3.2 }))).toMatchObject({ pb: null, bookValuePerShare: -3.2, reason: '每股淨值為負，不適用' });
    });
});

describe('負債比', () => {
    it('缺資產或負債：null＋原因', () => {
        expect(debtRatio(undefined)).toEqual({ pct: null, period: null, reason: '沒有季報' });
        expect(debtRatio(q('2026Q2', { totalAssets: null }))).toEqual({ pct: null, period: '2026Q2', reason: '2026Q2 沒有資產或負債總計' });
        expect(debtRatio(q('2026Q2', { totalLiabilities: null }))).toEqual({ pct: null, period: '2026Q2', reason: '2026Q2 沒有資產或負債總計' });
    });

    it('負債 0 → 0%；資產不為正、負債為負：不計算', () => {
        expect(debtRatio(q('2026Q2', { totalLiabilities: 0 })).pct).toBe(0);
        expect(debtRatio(q('2026Q2')).pct).toBe(40);
        expect(debtRatio(q('2026Q2', { totalAssets: 0 }))).toMatchObject({ pct: null, reason: '資產總計不為正，不適用' });
        expect(debtRatio(q('2026Q2', { totalAssets: -1 }))).toMatchObject({ pct: null, reason: '資產總計不為正，不適用' });
        expect(debtRatio(q('2026Q2', { totalLiabilities: -1 }))).toMatchObject({ pct: null, reason: '負債總計為負，資料異常' });
    });
});

describe('盈餘品質', () => {
    it('不足四季、季別不連續：不算', () => {
        expect(earningsQuality(four().slice(0, 3))).toMatchObject({ ratio: null, verdict: null, reason: '季報不足四季' });
        const gap = [q('2026Q2'), q('2026Q1'), q('2025Q3'), q('2025Q2')];
        expect(earningsQuality(gap)).toMatchObject({ ratio: null, verdict: null, reason: '近四季季別不連續' });
        expect(earningsQuality([q('2026Q2'), q('2026Q1'), q('2025Q4'), q('bad')])).toMatchObject({ reason: '近四季季別不連續' });
    });

    it('任一季缺營業現金流或淨利：不算，原因指出季別', () => {
        expect(earningsQuality(four([{}, {}, { operatingCashFlow: null }, {}]))).toMatchObject({
            ratio: null, cashFlowYi: null, verdict: null, from: '2025Q3', to: '2026Q2', reason: '2025Q4 沒有營業現金流',
        });
        expect(earningsQuality(four([{ netIncome: null }, {}, {}, {}]))).toMatchObject({ ratio: null, reason: '2026Q2 沒有淨利' });
    });

    it('現金流高於、低於、等於淨利：比值＋文字結論', () => {
        const above = earningsQuality(four());
        expect(above).toMatchObject({ verdict: 'above', reason: null, cashFlowYi: toYi(600), netIncomeYi: toYi(400) });
        expect(above.ratio).toBeCloseTo(1.5, 10);
        const below = earningsQuality(four([{ operatingCashFlow: 50 }, { operatingCashFlow: 50 }, { operatingCashFlow: 50 }, { operatingCashFlow: 50 }]));
        expect(below).toMatchObject({ verdict: 'below', ratio: 0.5 });
        const equal = earningsQuality(four([{ operatingCashFlow: 100 }, { operatingCashFlow: 100 }, { operatingCashFlow: 100 }, { operatingCashFlow: 100 }]));
        expect(equal).toMatchObject({ verdict: 'equal', ratio: 1 });
    });

    it('營業現金流為負：比值為負、低於淨利；營業現金流 0：比值 0', () => {
        const negative = earningsQuality(four([{ operatingCashFlow: -300 }, {}, {}, {}]));
        expect(negative.verdict).toBe('below');
        expect(negative.ratio).toBeCloseTo(150 / 400, 10);
        const allNegative = earningsQuality(four([{ operatingCashFlow: -100 }, { operatingCashFlow: -100 }, { operatingCashFlow: -100 }, { operatingCashFlow: -100 }]));
        expect(allNegative).toMatchObject({ verdict: 'below', ratio: -1 });
        const zero = earningsQuality(four([{ operatingCashFlow: 0 }, { operatingCashFlow: 0 }, { operatingCashFlow: 0 }, { operatingCashFlow: 0 }]));
        expect(zero).toMatchObject({ verdict: 'below', ratio: 0, cashFlowYi: 0 });
    });

    it('淨利合計為虧損或 0：比值不適用，但仍給合計與高低結論', () => {
        const loss = earningsQuality(four([{ netIncome: -500 }, {}, {}, {}]));
        expect(loss).toMatchObject({ ratio: null, verdict: 'above', reason: '近四季淨利合計為虧損，比值不適用', netIncomeYi: toYi(-200) });
        const zero = earningsQuality(four([{ netIncome: -300 }, {}, {}, {}]));
        expect(zero).toMatchObject({ ratio: null, reason: '近四季淨利合計為 0，比值不適用', netIncomeYi: 0 });
    });
});

describe('獲利金額趨勢', () => {
    it('最多 8 季；金融業（全部沒有毛利、營業利益）不顯示那兩欄；缺值保留 null', () => {
        const bank = Array.from({ length: 10 }, (_, i) => q(`20${20 + Math.floor(i / 4)}Q${(i % 4) + 1}`, { grossProfit: null, operatingIncome: null }));
        const t = profitTrend(bank);
        expect(t.rows).toHaveLength(8);
        expect(t.hasGross).toBe(false);
        expect(t.hasOperating).toBe(false);
        const mixed = profitTrend([q('2026Q2', { revenue: null, netIncome: -12_345 }), q('2026Q1', { grossProfit: null })]);
        expect(mixed.hasGross).toBe(true);
        expect(mixed.rows[0]).toMatchObject({ revenueYi: null, netIncomeYi: -0.12345 });
        expect(profitTrend([])).toEqual({ rows: [], hasGross: false, hasOperating: false });
    });

    it('億元格式：≥100 取整、≥1 一位、其餘兩位；負值帶負號；-0 顯示 0；缺值「—」', () => {
        expect(fmtYi(12703.8025)).toBe('12,704');
        expect(fmtYi(100)).toBe('100');
        expect(fmtYi(12.345)).toBe('12.3');
        expect(fmtYi(-12.345)).toBe('-12.3');
        expect(fmtYi(-1234.4)).toBe('-1,234');
        expect(fmtYi(0.123)).toBe('0.12');
        expect(fmtYi(0)).toBe('0.00');
        expect(fmtYi(-0.001)).toBe('0.00');
        expect(fmtYi(null)).toBe('—');
        expect(fmtYi(Number.NaN)).toBe('—');
        expect(toYi(null)).toBeNull();
    });
});

describe('累計 EPS', () => {
    it('第 1 季標示「第 1 季」；去年同期用「基本每股盈餘」舊名也讀得到', () => {
        const fin = finWith(['2025Q1', '2026Q1'], { 基本每股盈餘: [1.5, null], '基本每股盈餘（元）': [null, 2] });
        expect(ytdEps(fin)).toMatchObject({ label: '2026 年第 1 季', value: 2, prev: 1.5, prevReason: null });
        expect(ytdEps(fin).growthPct).toBeCloseTo(33.333, 2);
    });

    it('沒有去年同期：只顯示今年；去年同期為虧損或 0：不計成長率', () => {
        expect(ytdEps(finWith(['2026Q1', '2026Q2'], { '基本每股盈餘（元）': [1, 3] }))).toMatchObject({
            value: 3, prev: null, growthPct: null, prevReason: '沒有去年同期資料',
        });
        expect(ytdEps(finWith(['2025Q2', '2026Q2'], { '基本每股盈餘（元）': [-0.8, 0.5] }))).toMatchObject({
            value: 0.5, prev: -0.8, growthPct: null, prevReason: '去年同期為虧損，不計成長率',
        });
        expect(ytdEps(finWith(['2025Q2', '2026Q2'], { '基本每股盈餘（元）': [0, 0.5] }))).toMatchObject({
            prev: 0, growthPct: null, prevReason: '去年同期為 0，不計成長率',
        });
    });

    it('今年為虧損：照實顯示負值，成長率以去年同期為分母', () => {
        const y = ytdEps(finWith(['2025Q3', '2026Q3'], { '基本每股盈餘（元）': [2, -1] }));
        expect(y).toMatchObject({ label: '2026 年前 3 季', value: -1, prev: 2 });
        expect(y.growthPct).toBeCloseTo(-150, 10);
    });

    it('沒有季報、季別無法辨識、最新一季沒有累計 EPS：null＋原因', () => {
        expect(ytdEps(finWith([], {}))).toMatchObject({ value: null, reason: '沒有季報' });
        expect(ytdEps(finWith(['2026H1'], { '基本每股盈餘（元）': [3] }))).toMatchObject({ value: null, reason: '無法辨識季別 2026H1' });
        expect(ytdEps(finWith(['2025Q2', '2026Q2'], { '基本每股盈餘（元）': [1, null] }))).toMatchObject({
            value: null, label: '2026 年前 2 季', reason: '2026Q2 沒有累計 EPS',
        });
        expect(parseQuarter('2026Q5')).toBeNull();
        expect(parseQuarter('2026Q4')).toEqual({ year: 2026, quarter: 4 });
    });
});
