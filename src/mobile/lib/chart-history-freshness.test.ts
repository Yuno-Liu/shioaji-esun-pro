// 手機圖表歷史新鮮度（B3）：沒有紀錄或失敗→新 revision；逾 60 秒或 resumeSeq 改變→先快取再背景重抓
import { beforeEach, describe, expect, it } from 'vitest';
import { getHistoryEntry, HISTORY_STALE_MS, planHistory, resetHistoryEntriesForTest, setHistoryEntry } from './chart-history-freshness';

beforeEach(() => { resetHistoryEntriesForTest(); });

describe('planHistory', () => {
    const entry = { revision: 5, at: 1_000_000, resumeSeq: 2, failed: false };

    it('沒有紀錄或上次失敗：新 revision 查詢', () => {
        expect(planHistory(undefined, 0, 0)).toEqual({ kind: 'fetch' });
        expect(planHistory({ ...entry, failed: true }, entry.at + 1, 2)).toEqual({ kind: 'fetch' });
    });

    it('60 秒內且 resumeSeq 相同：直接沿用快取', () => {
        expect(planHistory(entry, entry.at + HISTORY_STALE_MS, 2)).toEqual({ kind: 'cached', revision: 5, refresh: false });
    });

    it('逾 60 秒或 resumeSeq 改變：先顯示快取再背景重抓', () => {
        expect(planHistory(entry, entry.at + HISTORY_STALE_MS + 1, 2)).toEqual({ kind: 'cached', revision: 5, refresh: true });
        expect(planHistory(entry, entry.at + 1, 3)).toEqual({ kind: 'cached', revision: 5, refresh: true });
    });

    it('紀錄依 (code, period) 分開', () => {
        setHistoryEntry('2330', '5m', entry);
        expect(getHistoryEntry('2330', '5m')).toEqual(entry);
        expect(getHistoryEntry('2330', 'line')).toBeUndefined();
        expect(getHistoryEntry('2317', '5m')).toBeUndefined();
    });
});
