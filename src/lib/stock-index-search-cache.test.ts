// src/lib/stock-index-search-cache.test.ts — searchStocks 正規化快取：結果不變、名稱更新後重新正規化

import { describe, expect, it, vi } from 'vitest';

vi.mock('./shioaji', () => ({
    fetchContracts: vi.fn(),
    fetchWarrantUnderlyings: vi.fn(),
    fetchContractInfo: vi.fn(),
}));

const { searchStocks } = await import('./stock-index');

describe('searchStocks normalization cache', () => {
    it('重複搜尋同一份目錄得到相同結果', () => {
        const catalog = [
            { code: '2330', name: '台積電', category: '24', exchange: 'TSE' },
            { code: '0050', name: '元大臺灣50', category: '00', exchange: 'TSE' },
            ...Array.from({ length: 5000 }, (_, i) => ({
                code: `7${String(i).padStart(5, '0')}`,
                name: `台積電購${i}`,
                category: '',
                exchange: 'TSE',
            })),
        ];
        const first = searchStocks(catalog, '台積', 5).map((s) => s.code);
        const second = searchStocks(catalog, '台積', 5).map((s) => s.code);
        expect(first[0]).toBe('2330');
        expect(second).toEqual(first);
        // 臺／台 正規化結果同樣被快取
        expect(searchStocks(catalog, '元大台灣50', 1)[0]?.code).toBe('0050');
        expect(searchStocks(catalog, '元大台灣50', 1)[0]?.code).toBe('0050');
    });

    it('目錄項目名稱更新（例如補上中文名稱）後重新正規化', () => {
        const row = { code: '2317', name: '2317', category: '', exchange: 'TSE' };
        const catalog = [row];
        expect(searchStocks(catalog, '鴻海')).toEqual([]);
        row.name = '鴻海';
        expect(searchStocks(catalog, '鴻海').map((s) => s.code)).toEqual(['2317']);
    });
});
