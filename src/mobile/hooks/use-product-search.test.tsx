// 手機商品搜尋 hook（2026-11 上游搜尋同步後）：開啟時預熱股票目錄、目錄改版時自動重查
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    searchProducts: vi.fn(),
    loadStockCatalog: vi.fn(),
}));

vi.mock('../../lib/product-search', () => ({ searchProducts: m.searchProducts }));
vi.mock('../../lib/stock-index', () => ({ loadStockCatalog: m.loadStockCatalog }));

import { invalidateProductCatalog } from '../../lib/product-catalog-version';
import { SEARCH_DEBOUNCE_MS, SEARCH_LIMIT, securityTypeText, useProductSearch } from './use-product-search';

let view: ReactTestRenderer | undefined;
let latest: ReturnType<typeof useProductSearch> | undefined;

function Probe({ query, active }: { query: string; active: boolean }) {
    latest = useProductSearch(query, active);
    return null;
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    m.searchProducts.mockResolvedValue([{ code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', detail: '股票' }]);
    m.loadStockCatalog.mockResolvedValue([]);
});

afterEach(async () => {
    if (view) await act(async () => view!.unmount());
    view = undefined;
    latest = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('useProductSearch', () => {
    it('開啟時以不帶 signal 的 loadStockCatalog 預熱股票目錄（不被每次搜尋 1.2 秒的期限取消）；關閉時不預熱', async () => {
        await act(async () => { view = create(createElement(Probe, { query: '', active: false })); });
        expect(m.loadStockCatalog).not.toHaveBeenCalled();
        await act(async () => { view!.update(createElement(Probe, { query: '', active: true })); });
        expect(m.loadStockCatalog).toHaveBeenCalledTimes(1);
        expect(m.loadStockCatalog).toHaveBeenCalledWith();
        // 空白查詢不發搜尋
        expect(m.searchProducts).not.toHaveBeenCalled();
    });

    it('商品目錄改版時以同一查詢自動重查（上游會讓進行中的查詢失敗並要求重新搜尋）', async () => {
        await act(async () => { view = create(createElement(Probe, { query: '台積', active: true })); });
        await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 5); });
        expect(m.searchProducts).toHaveBeenCalledTimes(1);
        expect(m.searchProducts).toHaveBeenLastCalledWith('台積', SEARCH_LIMIT, expect.objectContaining({ signal: expect.anything() }));
        expect(latest?.status).toBe('done');

        await act(async () => { invalidateProductCatalog({ region: 'TW', base_changed: true, info_changed: false }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 5); });
        expect(m.searchProducts).toHaveBeenCalledTimes(2);
        expect(m.searchProducts.mock.calls[1]![0]).toBe('台積');
        expect(latest?.status).toBe('done');
        expect(latest?.results[0]?.code).toBe('2330');
    });

    it('權證的種類文字', () => {
        expect(securityTypeText('WRT')).toBe('權證');
        expect(securityTypeText('STK')).toBe('股票');
    });
});
