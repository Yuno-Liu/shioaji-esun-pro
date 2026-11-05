// 手機圖表歷史快取（F4:F9）：同組只留最新一份成功的回應；較舊 revision 給較新的那份；失敗不快取；組數有上限
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase } from '../../lib/types/contract';

const m = vi.hoisted(() => ({ fetchKbars: vi.fn() }));
vi.mock('../../lib/shioaji', () => ({ fetchKbars: m.fetchKbars }));
vi.mock('../../lib/runtime', () => ({ getApiBase: () => 'http://api' }));

import { cachedHistoryCountForTest, fetchMobileChartHistory, MAX_HISTORY_GROUPS, resetMobileChartHistoryForTest } from './chart-history-cache';

const contract = { exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null } as unknown as ContractBase;
const kb = (tag: string) => ({ datetime: [tag], Open: [1], High: [1], Low: [1], Close: [1], Volume: [1], Amount: [0] });
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
    resetMobileChartHistoryForTest();
    m.fetchKbars.mockReset();
});

describe('fetchMobileChartHistory', () => {
    it('重複換 revision 重抓：同組只保留最新一份（不像 src/lib 每個 revision 各留一份）', async () => {
        for (let r = 1; r <= 30; r++) {
            m.fetchKbars.mockResolvedValueOnce(kb(`r${r}`));
            await fetchMobileChartHistory(contract, '2026-07-01', '2026-11-06', { revision: r });
            await flush();
        }
        expect(m.fetchKbars).toHaveBeenCalledTimes(30);
        expect(cachedHistoryCountForTest()).toBe(1);
        expect(m.fetchKbars.mock.calls[0]).toEqual([contract, '2026-07-01', '2026-11-06', { timeoutMs: undefined }]);
    });

    it('相同或較舊的 revision 沿用最新一份成功的回應（不再查詢）；進行中的同一 revision 共用', async () => {
        m.fetchKbars.mockResolvedValueOnce(kb('a'));
        const p1 = fetchMobileChartHistory(contract, 's', 'e', { revision: 5 });
        const p1b = fetchMobileChartHistory(contract, 's', 'e', { revision: 5 });
        expect(p1b).toBe(p1);
        await p1;
        await flush();
        await expect(fetchMobileChartHistory(contract, 's', 'e', { revision: 3 })).resolves.toEqual(kb('a'));
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
    });

    it('失敗不快取，且保留上一份成功的回應（背景重抓失敗時沿用）', async () => {
        m.fetchKbars.mockResolvedValueOnce(kb('ok')).mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(kb('again'));
        await fetchMobileChartHistory(contract, 's', 'e', { revision: 1 });
        await flush();
        await expect(fetchMobileChartHistory(contract, 's', 'e', { revision: 2 })).rejects.toThrow('timeout');
        await flush();
        await expect(fetchMobileChartHistory(contract, 's', 'e', { revision: 1 })).resolves.toEqual(kb('ok'));
        expect(cachedHistoryCountForTest()).toBe(1);
        // 同一 revision 失敗後可再試（不重放失敗）
        await expect(fetchMobileChartHistory(contract, 's', 'e', { revision: 2 })).resolves.toEqual(kb('again'));
    });

    it(`最多保留 ${MAX_HISTORY_GROUPS} 組（最近使用者優先）`, async () => {
        m.fetchKbars.mockImplementation(async () => kb('x'));
        for (let i = 0; i < MAX_HISTORY_GROUPS + 5; i++) {
            await fetchMobileChartHistory({ ...contract, code: `C${i}` } as ContractBase, 's', 'e', { revision: 1 });
        }
        await flush();
        expect(cachedHistoryCountForTest()).toBe(MAX_HISTORY_GROUPS);
    });
});
