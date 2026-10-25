// src/lib/product-search-ranking.test.ts — 個股期根不得排在股票前面、過時搜尋可取消

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';

const cdfContract: ContractInfo = {
    code: 'CDFR1',
    name: '台積電期貨近月',
    exchange: 'TAIFEX',
    security_type: 'FUT',
    target_code: '2330',
    currency: 'TWD',
    reference: 1000,
    limit_up: 1100,
    limit_down: 900,
    day_trade: 'Yes',
    update_date: '2026-10-23',
    category: 'CDF',
    margin_trading_balance: 0,
    short_selling_balance: 0,
    delivery_month: '202611',
    root: 'CDF',
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
    return { ...actual, loadStockCatalog: mocks.loadStockCatalog };
});

import { searchProducts } from './product-search';

describe('searchProducts — 個股期根排序', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.loadStockCatalog.mockResolvedValue([
            { code: '2330', name: '台積電', exchange: 'TSE', category: '24' },
            { code: '2317', name: '鴻海', exchange: 'TSE', category: '31' },
        ]);
        // 期貨根清單同時含指數期與個股期（個股期根以標的名稱命名）
        mocks.fetchFuturesRoots.mockResolvedValue([
            { root: 'TXF', name: '臺股期貨' },
            { root: 'MXF', name: '小型臺指期貨' },
            { root: 'CDF', name: '台積電' },
        ]);
        mocks.fetchOptionRoots.mockResolvedValue([]);
        mocks.fetchFutures.mockImplementation(async (params?: { root?: string; underlyingCode?: string }) =>
            params?.root === 'CDF' || params?.underlyingCode === '2330' ? [cdfContract] : [],
        );
        mocks.fetchOptions.mockResolvedValue([]);
        mocks.fetchWarrants.mockResolvedValue([]);
        mocks.resolveContract.mockRejectedValue(new Error('not found'));
    });

    it('部分股票名稱「台積」：股票排第一，不把個股期插到前面', async () => {
        const results = await searchProducts('台積');
        expect(results[0]).toMatchObject({ code: '2330', security_type: 'STK' });
        expect(results.some((r) => r.security_type === 'FUT')).toBe(false);
    });

    it('完整股票名稱「台積電」：仍以股票為第一筆', async () => {
        const results = await searchProducts('台積電');
        expect(results[0]).toMatchObject({ code: '2330', security_type: 'STK' });
    });

    it('明確要期貨「台積電期貨」時才列出個股期', async () => {
        const results = await searchProducts('台積電期貨');
        expect(results.some((r) => r.code === 'CDFR1' && r.security_type === 'FUT')).toBe(true);
    });

    it('期貨別名完全相符（小台）仍會列出期貨', async () => {
        mocks.fetchFutures.mockImplementation(async (params?: { root?: string }) =>
            params?.root === 'MXF' ? [{ ...cdfContract, code: 'MXFR1', root: 'MXF', name: '小型臺指期貨近月' }] : [],
        );
        const results = await searchProducts('小台');
        expect(results[0]).toMatchObject({ code: 'MXFR1', security_type: 'FUT' });
    });

    it('已取消（AbortSignal）的搜尋不再送出合約解析請求', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(searchProducts('2330', 10, { signal: controller.signal })).rejects.toBeDefined();
        expect(mocks.resolveContract).not.toHaveBeenCalled();
        expect(mocks.fetchFutures).not.toHaveBeenCalled();
    });

    it('目錄載入期間被取消時也不送出後續請求', async () => {
        const controller = new AbortController();
        let release!: () => void;
        mocks.loadStockCatalog.mockImplementation(
            () => new Promise((resolve) => {
                release = () => resolve([{ code: '2330', name: '台積電', exchange: 'TSE', category: '24' }]);
            }),
        );
        const pending = searchProducts('2330', 10, { signal: controller.signal });
        controller.abort();
        release();
        await expect(pending).rejects.toBeDefined();
        expect(mocks.resolveContract).not.toHaveBeenCalled();
    });
});
