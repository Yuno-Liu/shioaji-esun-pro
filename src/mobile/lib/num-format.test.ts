// 手機版快取數字格式化（稽核 P1）：與 src/lib 版本逐字相同（大量向量），且相同選項只建立一個 Intl.NumberFormat
import { afterEach, describe, expect, it, vi } from 'vitest';

// 期權級距表：以假的 server 級距（tw_stock_fut_price_band）走 bandTickFor 分支；不連線
vi.mock('../../lib/tick-bands', () => ({
    prefetchTickBands: () => undefined,
    bandTickFor: (rule: string, price: number) => {
        if (rule === 'band-a') return price < 10 ? 0.01 : price < 50 ? 0.05 : price < 100 ? 0.1 : price < 500 ? 0.5 : price < 1000 ? 1 : 5;
        if (rule === 'band-opt') return price < 50 ? 0.1 : 0.5;
        return undefined;
    },
}));

import * as libFormat from '../../lib/utils/format';
import * as libTick from '../../lib/utils/ticksize';
import { cachedNumberFormat, fmtCompactInt, fmtInt, fmtStockLots, formatNumber, formatToTick } from './num-format';

type TickContract = Parameters<typeof libTick.formatToTick>[0];
const c = (over: Record<string, unknown>) => ({ exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, ...over }) as unknown as TickContract;

const CONTRACTS: TickContract[] = [
    c({}),
    c({ code: '0050' }),
    c({ code: '00878' }),
    c({ exchange: 'OTC', code: '6488' }),
    c({ exchange: 'TAIFEX', code: 'TXFL6', security_type: 'FUT', tick: 1 }),
    c({ exchange: 'TAIFEX', code: 'MXFL6', security_type: 'FUT', tick: '1' }),
    c({ exchange: 'TAIFEX', code: 'CDFL6', security_type: 'FUT', tick_rule: 'band-a', tick: 0.05, underlying_kind: 'S' }),
    c({ exchange: 'TAIFEX', code: 'CDFL6', security_type: 'FUT', tick_rule: 'unknown-rule', tick: 0.01, underlying_kind: 'S' }),
    c({ exchange: 'TAIFEX', code: 'GDFL6', security_type: 'FUT', tick: 0.1 }),
    c({ exchange: 'TAIFEX', code: 'XXFL6', security_type: 'FUT' }),
    c({ exchange: 'TAIFEX', code: 'XXFL6', security_type: 'FUT', underlying_kind: 'S' }),
    c({ exchange: 'TAIFEX', code: 'TXO22000L6', security_type: 'OPT', tick_rule: 'band-opt', tick: 0.1 }),
    c({ exchange: 'TAIFEX', code: 'TXO22000L6', security_type: 'OPT' }),
    c({ exchange: 'TAIFEX', code: 'TXO22000L6', security_type: 'OPT', tick: 0 }),
    c({ exchange: 'TAIFEX', code: 'TXO22000L6', security_type: 'OPT', tick: 0.00001 }),
    c({ exchange: 'TSE', code: '001', security_type: 'IND' }),
];

/** 各價位區間的邊界、半跳、浮點塵、負數、0、-0、極大與極小值 */
const PRICES: number[] = (() => {
    const base = [
        0, -0, 0.001, 0.004, 0.005, 0.006, 0.01, 0.015, 0.05, 0.1, 0.125, 0.3, 0.7, 1, 1.005, 1.234, 2.675,
        9.99, 9.995, 10, 10.01, 10.025, 10.03, 12.345, 49.95, 49.975, 50, 50.05, 50.1, 50.15, 99.9, 99.95, 100, 100.25, 100.5,
        123.456, 499.5, 499.75, 500, 500.4, 500.5, 999, 999.5, 1000, 1002.5, 1005, 1052.5, 1085, 1234.56, 9999.99,
        12345.678, 22572, 22800.5, 48692.46, 99999.5, 123456.789, 1e6 + 0.5, 9_876_543.21, 1e9, 2 ** 31, 1e12 + 0.125, 1e15, 9_007_199_254_740_991, 1e21, 1.7976931348623157e308,
        0.1 + 0.2, 0.3 - 0.1, 1 / 3, 2 / 3, Math.PI, Math.E * 100,
    ];
    const out: number[] = [];
    for (const v of base) out.push(v, -v);
    // 規律掃描：0.01 ～ 2000 之間的價位（含常見的浮點誤差）
    for (let i = 1; i <= 2000; i += 7) out.push(i / 100, i * 1.05, i + 0.001, i - 0.004);
    return out;
})();

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

afterEach(() => {
    vi.restoreAllMocks();
});

describe('formatToTick 與 lib 版本逐字相同', () => {
    it('各商品 × 各價位（grouping 預設／true／false；at 指定級距價位）', () => {
        const OPTS: ({ grouping?: boolean; at?: number } | undefined)[] = [undefined, { grouping: false }, { grouping: true }, { at: 99.5 }, { at: -1200, grouping: false }];
        const mismatches: string[] = [];
        let n = 0;
        for (const contract of CONTRACTS) {
            for (const price of [...PRICES, ...NON_FINITE]) {
                for (const o of OPTS) {
                    const got = formatToTick(contract, price, o);
                    const want = libTick.formatToTick(contract, price, o);
                    if (got !== want) mismatches.push(`${contract.code} ${price} ${JSON.stringify(o)}: ${got} ≠ ${want}`);
                    n += 1;
                }
            }
        }
        expect(mismatches).toEqual([]);
        expect(n).toBeGreaterThan(40_000);
    }, 60_000);

    it('代表值（文件化）', () => {
        expect(formatToTick(c({}), 1052.4)).toBe('1,050');
        expect(formatToTick(c({}), 99.96)).toBe('100.0');
        expect(formatToTick(c({ code: '0050' }), 185.33)).toBe('185.35');
        expect(formatToTick(c({ exchange: 'TAIFEX', code: 'TXFL6', security_type: 'FUT', tick: 1 }), 48692.46)).toBe('48,692');
        expect(formatToTick(c({ exchange: 'TAIFEX', code: 'TXFL6', security_type: 'FUT', tick: 1 }), 48692.46, { grouping: false })).toBe('48692');
        expect(formatToTick(c({}), Number.NaN)).toBe('—');
    });
});

describe('fmtInt／fmtCompactInt／fmtStockLots 與 lib 版本逐字相同', () => {
    const INTS = [
        ...PRICES, ...NON_FINITE, 9_999, 9_999.5, 10_000, 99_999, 100_000, 104_264, 999_999, 1_000_000, 2_345_678, 99_999_999, 100_000_000, 123_456_789, 1e12,
    ];

    it('fmtInt（含小數、負數、NaN、Infinity、undefined、null）', () => {
        for (const v of INTS) expect(fmtInt(v), String(v)).toBe(libFormat.fmtInt(v));
        expect(fmtInt(undefined)).toBe(libFormat.fmtInt(undefined));
        expect(fmtInt(null as unknown as undefined)).toBe(libFormat.fmtInt(null as unknown as undefined));
    });

    it('fmtCompactInt（萬、億的切換點）', () => {
        for (const v of INTS) expect(fmtCompactInt(v), String(v)).toBe(libFormat.fmtCompactInt(v));
        expect(fmtCompactInt(undefined)).toBe(libFormat.fmtCompactInt(undefined));
        expect(fmtCompactInt(9_999)).toBe('9,999');
        expect(fmtCompactInt(104_264)).toBe('10.4萬');
    });

    it('fmtStockLots（張＋股；預設語系千分位）', () => {
        const shares = [0, 1, 10, 999, 1000, 1001, 1500, 5010, 12_000, 999_999, 1_000_000, 1_234_567, 99_999_000, -1000, -1500, -10, 2500.4, 2500.6, 1e9 + 1];
        for (const s of shares) expect(fmtStockLots(s), String(s)).toBe(libFormat.fmtStockLots(s));
        for (let s = 0; s <= 50_000; s += 137) expect(fmtStockLots(s)).toBe(libFormat.fmtStockLots(s));
    });

    it('formatNumber 與 toLocaleString 相同（各種選項組合）', () => {
        const opts: (Intl.NumberFormatOptions & { minimumFractionDigits?: number; maximumFractionDigits?: number; useGrouping?: boolean } | undefined)[] = [
            undefined, {}, { maximumFractionDigits: 0 }, { maximumFractionDigits: 2 }, { maximumFractionDigits: 4 },
            { minimumFractionDigits: 2, maximumFractionDigits: 2 }, { minimumFractionDigits: 0, maximumFractionDigits: 0 },
            { minimumFractionDigits: 3, maximumFractionDigits: 3, useGrouping: false }, { useGrouping: true }, { useGrouping: false },
        ];
        for (const o of opts) {
            for (const v of [...PRICES, ...NON_FINITE]) {
                const want = v.toLocaleString('en-US', o);
                expect(formatNumber(v, 'en-US', o as Parameters<typeof formatNumber>[2])).toBe(want);
            }
        }
        // 非 number（執行期壞資料）照舊交給 toLocaleString
        expect(formatNumber('1234' as unknown as number, 'en-US')).toBe('1234');
    });

    it('fmtStockLots 的張數用執行環境預設語系（同 lib 的 toLocaleString()），不固定為 en-US', async () => {
        // 測試機的預設語系通常是 en-US 或 zh-TW，逐字比對抓不到差異；這裡直接檢查建立格式器時的 locales 參數
        vi.resetModules();
        const Original = Intl.NumberFormat;
        const ctor = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function(locales, options) {
            return new Original(locales, options);
        } as typeof Intl.NumberFormat);
        try {
            const fresh = await import('./num-format');
            expect(fresh.fmtStockLots(12_345_000)).toBe(libFormat.fmtStockLots(12_345_000));
            expect(fresh.fmtStockLots(5_010)).toBe(libFormat.fmtStockLots(5_010));
            expect(ctor).toHaveBeenCalled();
            expect(ctor.mock.calls.map(([locales]) => locales)).toEqual(ctor.mock.calls.map(() => undefined));
            // 對照：fmtInt 固定 en-US（同 lib）
            fresh.fmtInt(1_234);
            expect(ctor.mock.calls.at(-1)?.[0]).toBe('en-US');
        } finally {
            ctor.mockRestore();
        }
    });
});

describe('快取', () => {
    it('相同 locale＋選項只建立一個 Intl.NumberFormat；不同選項各自一個', () => {
        const Original = Intl.NumberFormat;
        const ctor = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function(locales, options) {
            return new Original(locales, options);
        } as typeof Intl.NumberFormat);
        const contract = c({ code: '0050' });
        // 選項組合未曾使用過（前面的向量測試已建立過 0～5 位小數的格式器）
        for (let i = 0; i < 1_000; i++) formatNumber(i + 0.123, 'en-US', { minimumFractionDigits: 7, maximumFractionDigits: 7, useGrouping: false });
        expect(ctor).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 1_000; i++) formatToTick(contract, 30 + i / 1000, { grouping: false });
        expect(ctor.mock.calls.length).toBeLessThanOrEqual(2);
        expect(cachedNumberFormat('en-US', { maximumFractionDigits: 2 })).toBe(cachedNumberFormat('en-US', { maximumFractionDigits: 2 }));
        expect(cachedNumberFormat('en-US', { maximumFractionDigits: 2 })).not.toBe(cachedNumberFormat('en-US', { maximumFractionDigits: 2, useGrouping: true }));
    });

    it('計時（僅記錄，不設門檻）：快取版比 toLocaleString 快', () => {
        const contract = c({});
        const N = 20_000;
        const t0 = performance.now();
        for (let i = 0; i < N; i++) libTick.formatToTick(contract, 1000 + (i % 500));
        const t1 = performance.now();
        for (let i = 0; i < N; i++) formatToTick(contract, 1000 + (i % 500));
        const t2 = performance.now();
        const lib = (t1 - t0) / N * 1000;
        const fast = (t2 - t1) / N * 1000;
        console.info(`[num-format] formatToTick lib ${lib.toFixed(2)}µs／次，快取版 ${fast.toFixed(2)}µs／次（${(lib / Math.max(fast, 1e-6)).toFixed(1)}×）`);
        expect(fast).toBeGreaterThan(0);
    });
});
