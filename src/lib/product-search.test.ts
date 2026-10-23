// src/lib/product-search.test.ts — 商品快速搜尋與模糊比對測試

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';

const mxfContract: ContractInfo = {
    code: 'MXFR1',
    name: '小型臺指期貨近月',
    exchange: 'TAIFEX',
    security_type: 'FUT',
    target_code: null,
    currency: 'TWD',
    reference: 22000,
    limit_up: 24200,
    limit_down: 19800,
    day_trade: 'Yes',
    update_date: '2026-10-23',
    category: 'MXF',
    margin_trading_balance: 0,
    short_selling_balance: 0,
    delivery_month: '202610',
    root: 'MXF',
};

const txfContract: ContractInfo = {
    code: 'TXFR1',
    name: '臺股期貨近月',
    exchange: 'TAIFEX',
    security_type: 'FUT',
    target_code: null,
    currency: 'TWD',
    reference: 22000,
    limit_up: 24200,
    limit_down: 19800,
    day_trade: 'Yes',
    update_date: '2026-10-23',
    category: 'TXF',
    margin_trading_balance: 0,
    short_selling_balance: 0,
    delivery_month: '202610',
    root: 'TXF',
};

const mocks = vi.hoisted(() => ({
    fetchFutures: vi.fn(),
    fetchFuturesRoots: vi.fn(),
    fetchOptionRoots: vi.fn(),
    fetchOptions: vi.fn(),
    fetchWarrants: vi.fn(),
    resolveContract: vi.fn(),
    loadStockCatalog: vi.fn(),
}));

vi.mock('./shioaji', () => ({
    fetchFutures: mocks.fetchFutures,
    fetchFuturesRoots: mocks.fetchFuturesRoots,
    fetchOptionRoots: mocks.fetchOptionRoots,
    fetchOptions: mocks.fetchOptions,
    fetchWarrants: mocks.fetchWarrants,
    normalizeContractCode: (code: string) => code.trim().toUpperCase(),
    resolveContract: mocks.resolveContract,
}));

vi.mock('./stock-index', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./stock-index')>();
    return {
        ...actual,
        loadStockCatalog: mocks.loadStockCatalog,
    };
});

import { searchProducts } from './product-search';

describe('searchProducts', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        mocks.loadStockCatalog.mockResolvedValue([
            { code: '0050', name: '元大台灣50', exchange: 'TSE', category: '00' },
            { code: '2330', name: '台積電', exchange: 'TSE', category: '24' },
            { code: '2317', name: '鴻海', exchange: 'TSE', category: '31' },
            { code: '00878', name: '國泰永續高股息', exchange: 'TSE', category: '00' },
        ]);

        mocks.fetchFuturesRoots.mockResolvedValue([
            { root: 'TXF', name: '臺股期貨' },
            { root: 'MXF', name: '小型臺指期貨' },
            { root: 'TMF', name: '微型臺指期貨' },
            { root: 'EXF', name: '電子期貨' },
            { root: 'FXF', name: '金融期貨' },
        ]);

        mocks.fetchOptionRoots.mockResolvedValue([
            { root: 'TXO', name: '臺指選擇權' },
        ]);

        mocks.fetchFutures.mockImplementation(async (params?: { root?: string }) => {
            if (params?.root === 'MXF') return [mxfContract];
            if (params?.root === 'TXF') return [txfContract];
            return [];
        });

        mocks.fetchOptions.mockResolvedValue([]);
        mocks.fetchWarrants.mockResolvedValue([]);
        mocks.resolveContract.mockRejectedValue(new Error('not found'));
    });

    it('returns empty array when given an empty or whitespace query', async () => {
        expect(await searchProducts('')).toEqual([]);
        expect(await searchProducts('   ')).toEqual([]);
    });

    describe('期貨別名與根代碼模糊搜尋', () => {
        it('matches MXF futures when searching with alias "小台"', async () => {
            const results = await searchProducts('小台');
            expect(mocks.fetchFutures).toHaveBeenCalledWith({ root: 'MXF' });
            expect(results.length).toBeGreaterThan(0);
            expect(results.some((r) => r.code === 'MXFR1' && r.security_type === 'FUT')).toBe(true);
        });

        it('matches TXF futures when searching with alias "台指"', async () => {
            const results = await searchProducts('台指');
            expect(mocks.fetchFutures).toHaveBeenCalledWith({ root: 'TXF' });
            expect(results.length).toBeGreaterThan(0);
            expect(results.some((r) => r.code === 'TXFR1' && r.security_type === 'FUT')).toBe(true);
        });

        it('matches MXF futures when searching with root code "MXF"', async () => {
            const results = await searchProducts('MXF');
            expect(mocks.fetchFutures).toHaveBeenCalledWith({ root: 'MXF' });
            expect(results.some((r) => r.code === 'MXFR1' && r.security_type === 'FUT')).toBe(true);
        });

        it('matches TXF futures when searching with root code "TXF"', async () => {
            const results = await searchProducts('TXF');
            expect(mocks.fetchFutures).toHaveBeenCalledWith({ root: 'TXF' });
            expect(results.some((r) => r.code === 'TXFR1' && r.security_type === 'FUT')).toBe(true);
        });
    });

    describe('股票名稱模糊搜尋', () => {
        it('matches stock 0050 when searching with fuzzy subsequence "元大50"', async () => {
            const results = await searchProducts('元大50');
            const match = results.find((r) => r.code === '0050');
            expect(match).toBeDefined();
            expect(match).toMatchObject({
                code: '0050',
                name: '元大台灣50',
                security_type: 'STK',
                exchange: 'TSE',
            });
        });

        it('matches stock 2330 when searching "台積電" or exact code "2330"', async () => {
            const resultsByName = await searchProducts('台積電');
            expect(resultsByName[0]?.code).toBe('2330');

            const resultsByCode = await searchProducts('2330');
            expect(resultsByCode[0]?.code).toBe('2330');
        });
    });

    describe('指數模糊搜尋', () => {
        it('matches semiconductor index IX0028 when searching "半導體"', async () => {
            const results = await searchProducts('半導體');
            const match = results.find((r) => r.code === 'IX0028');
            expect(match).toBeDefined();
            expect(match).toMatchObject({
                code: 'IX0028',
                name: '半導體類指數',
                security_type: 'IND',
                exchange: 'TSE',
                detail: '指數',
            });
        });
    });
});
