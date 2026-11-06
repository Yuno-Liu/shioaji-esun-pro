// src/lib/product-search-ranking.test.ts — 個股期根不得排在股票前面、過時搜尋可取消
//
// 2026-11 同步上游：searchProducts 改用上游的重寫版本（相關商品依股票、連續月期貨、權證分組；
// 期貨以 underlying_code 關聯標的，不看 target_code；所有讀取都帶搜尋的 AbortSignal）。本檔保留 fork 的保護目的：
// 股票不被個股期擠到後面、明確要期貨時列出個股期、取消的搜尋不再發出請求或留下未取消的請求。
// 「小台」這類期貨根簡稱的子序列比對已隨上游重寫移除（請用「台指」或 MXF），不再測試。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';

const cdfContract: ContractInfo = {
    code: 'CDFR1',
    name: '台積電期貨近月',
    exchange: 'TAIFEX',
    security_type: 'FUT',
    target_code: '2330',
    underlying_code: '2330',
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

    it('部分股票名稱「台積」：股票排第一，相關個股期只排在股票之後', async () => {
        const results = await searchProducts('台積');
        expect(results[0]).toMatchObject({ code: '2330', security_type: 'STK' });
        const firstFuture = results.findIndex((r) => r.security_type === 'FUT');
        expect(firstFuture === -1 || firstFuture > results.findIndex((r) => r.code === '2330')).toBe(true);
    });

    it('完整股票名稱「台積電」：仍以股票為第一筆', async () => {
        const results = await searchProducts('台積電');
        expect(results[0]).toMatchObject({ code: '2330', security_type: 'STK' });
    });

    it('明確要期貨「台積電期貨」時才列出個股期', async () => {
        const results = await searchProducts('台積電期貨');
        expect(results.some((r) => r.code === 'CDFR1' && r.security_type === 'FUT')).toBe(true);
    });

    it('已取消（AbortSignal）的搜尋不再送出合約解析請求', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(searchProducts('2330', 10, { signal: controller.signal })).rejects.toBeDefined();
        expect(mocks.resolveContract).not.toHaveBeenCalled();
        expect(mocks.fetchFutures).not.toHaveBeenCalled();
    });

    it('目錄載入期間被取消時不再送出後續請求', async () => {
        const controller = new AbortController();
        let release!: () => void;
        let started!: () => void;
        const catalogStarted = new Promise<void>((resolve) => { started = resolve; });
        mocks.loadStockCatalog.mockImplementation(
            () => new Promise((resolve) => {
                started();
                release = () => resolve([{ code: '2330', name: '台積電', exchange: 'TSE', category: '24' }]);
            }),
        );
        const pending = searchProducts('2330', 10, { signal: controller.signal });
        await catalogStarted;
        // 上游先查直接代碼、再載入目錄：取消前已完成的請求不算；取消之後不得再發出任何請求
        const resolvedBeforeAbort = mocks.resolveContract.mock.calls.length;
        controller.abort();
        release();
        await expect(pending).rejects.toBeDefined();
        expect(mocks.resolveContract).toHaveBeenCalledTimes(resolvedBeforeAbort);
        expect(mocks.fetchFutures).not.toHaveBeenCalled();
        expect(mocks.fetchWarrants).not.toHaveBeenCalled();
    });
});
