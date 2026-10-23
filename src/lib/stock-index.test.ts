import { afterEach, describe, expect, it, vi } from 'vitest';

const pending: { code: string; resolve: () => void }[] = [];
let active = 0;
let peak = 0;

vi.mock('./shioaji', () => ({
    fetchContracts: vi.fn(),
    fetchWarrantUnderlyings: vi.fn(),
    fetchContractInfo: vi.fn(
        (code: string) =>
            new Promise((resolve) => {
                active += 1;
                peak = Math.max(peak, active);
                pending.push({
                    code,
                    resolve: () => {
                        active -= 1;
                        resolve({ code, name: `N${code}`, category: '24' });
                    },
                });
            }),
    ),
}));

const {
    DETAIL_CONCURRENCY,
    loadStockDetails,
    searchStocks,
    fuzzySubsequenceGap,
} = await import('./stock-index');

afterEach(() => {
    pending.length = 0;
    active = 0;
    peak = 0;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('loadStockDetails', () => {
    it('caps concurrent contract-info requests and still loads every code', async () => {
        const codes = Array.from({ length: 40 }, (_, i) => String(1000 + i));
        const done = loadStockDetails(codes);
        await flush();
        expect(pending.length).toBe(DETAIL_CONCURRENCY);
        while (pending.length > 0) {
            pending.shift()!.resolve();
            await flush();
        }
        const details = await done;
        expect(details).toHaveLength(40);
        expect(peak).toBe(DETAIL_CONCURRENCY);
    });
});

describe('searchStocks (fuzzy search)', () => {
    const sample = [
        { code: '2330', name: '台積電', category: '24', exchange: 'TSE' },
        { code: '2317', name: '鴻海', category: '31', exchange: 'TSE' },
        { code: '0050', name: '元大台灣50', category: '00', exchange: 'TSE' },
        { code: '00878', name: '國泰永續高股息', category: '00', exchange: 'TSE' },
        { code: '2834', name: '臺灣企銀', category: '17', exchange: 'TSE' },
        { code: '034567', name: '台積電元大42購01', category: '00', exchange: 'TSE' },
    ];

    it('matches exact code, prefix code, and leading-zero-stripped ETF codes', () => {
        expect(searchStocks(sample, '2330')[0]?.code).toBe('2330');
        expect(searchStocks(sample, '878')[0]?.code).toBe('00878');
        expect(searchStocks(sample, '50')[0]?.code).toBe('0050');
        expect(searchStocks(sample, '330')[0]?.code).toBe('2330');
    });

    it('normalizes 臺 and 台 in stock names and queries', () => {
        expect(searchStocks(sample, '臺積電')[0]?.code).toBe('2330');
        expect(searchStocks(sample, '台灣企銀')[0]?.code).toBe('2834');
    });

    it('supports non-contiguous subsequence fuzzy search on names', () => {
        expect(fuzzySubsequenceGap('元大台灣50', '元大50')).toBe(2);
        expect(searchStocks(sample, '元大50')[0]?.code).toBe('0050');
        expect(searchStocks(sample, '國泰高股息')[0]?.code).toBe('00878');
        expect(searchStocks(sample, '台電')[0]?.code).toBe('2330');
    });

    it('supports multi-token queries across code and name', () => {
        expect(searchStocks(sample, '2330 台積')[0]?.code).toBe('2330');
        expect(searchStocks(sample, '00878 高股息')[0]?.code).toBe('00878');
    });

    it('ranks underlying 4-digit stock above 6-char warrants', () => {
        const res = searchStocks(sample, '台積');
        expect(res[0]?.code).toBe('2330');
    });
});
