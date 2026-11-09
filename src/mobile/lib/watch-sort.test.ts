// 自選清單的檢視排序（lib/watch-sort.ts）：
// - 選項與預設：自己的清單預設自訂順序（伺服器順序）；固定清單沒有自訂順序、預設股票代號；
//   再點目前的選項＝反向；預設方向代號由小到大、股價／漲幅%／漲跌由大到小。
// - 排序：股價類依批次快照；沒有資料的列不論方向都在最後；同值穩定；股票代號依標的、一般在小型前。
// - 偏好存在這台裝置（sj-mobile-watch-sort-v1），格式不對或儲存空間不可用時用預設、不丟錯。
// - 批次快照：每批最多 SNAPSHOT_BATCH 檔；連續月代碼的快照以 target_code 對應。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase } from '../../lib/types/contract';
import type { Snapshot } from '../../lib/types/market';

const m = vi.hoisted(() => ({ fetchSnapshots: vi.fn() }));
vi.mock('../../lib/shioaji', () => ({ fetchSnapshots: m.fetchSnapshots }));

import { SNAPSHOT_BATCH } from '../../lib/option-window';
import {
    defaultSortPref,
    fetchSortSnapshots,
    getSortBasis,
    nextSortPref,
    readSortPref,
    resetSortBasisForTest,
    setSortBasis,
    snapshotIndex,
    SORT_STORAGE_KEY,
    sortCodes,
    sortKeys,
    sortValuesOf,
    writeSortPref,
    type SortItem,
} from './watch-sort';

const c = (code: string, target_code: string | null = null): ContractBase => ({ code, target_code, security_type: 'STK', exchange: 'TSE' });
const snap = (code: string, close: number, change_price: number, change_rate: number) => ({ code, close, change_price, change_rate }) as Snapshot;
const item = (code: string, under?: string, mult?: number): SortItem => ({ contract: c(code), under, mult });

class MemoryStorage {
    data = new Map<string, string>();
    getItem(k: string) { return this.data.get(k) ?? null; }
    setItem(k: string, v: string) { this.data.set(k, v); }
    removeItem(k: string) { this.data.delete(k); }
}

beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    m.fetchSnapshots.mockReset();
    resetSortBasisForTest();
});
afterEach(() => vi.unstubAllGlobals());

describe('選項與方向', () => {
    it('自己的清單有自訂順序（預設）；固定清單沒有、預設股票代號由小到大', () => {
        expect(sortKeys(false)).toEqual(['manual', 'code', 'price', 'pct', 'chg']);
        expect(sortKeys(true)).toEqual(['code', 'price', 'pct', 'chg']);
        expect(defaultSortPref(false)).toEqual({ key: 'manual', dir: 'asc' });
        expect(defaultSortPref(true)).toEqual({ key: 'code', dir: 'asc' });
    });

    it('換選項用預設方向；再點目前的選項反向（自訂順序不反向）', () => {
        const manual = defaultSortPref(false);
        expect(nextSortPref(manual, 'price')).toEqual({ key: 'price', dir: 'desc' });
        expect(nextSortPref(manual, 'pct')).toEqual({ key: 'pct', dir: 'desc' });
        expect(nextSortPref(manual, 'chg')).toEqual({ key: 'chg', dir: 'desc' });
        expect(nextSortPref(manual, 'code')).toEqual({ key: 'code', dir: 'asc' });
        expect(nextSortPref({ key: 'price', dir: 'desc' }, 'price')).toEqual({ key: 'price', dir: 'asc' });
        expect(nextSortPref({ key: 'price', dir: 'asc' }, 'price')).toEqual({ key: 'price', dir: 'desc' });
        expect(nextSortPref({ key: 'code', dir: 'asc' }, 'code')).toEqual({ key: 'code', dir: 'desc' });
        expect(nextSortPref(manual, 'manual')).toEqual(manual);
        expect(nextSortPref({ key: 'price', dir: 'desc' }, 'code')).toEqual({ key: 'code', dir: 'asc' });
    });
});

describe('sortCodes', () => {
    const items = [item('A'), item('B'), item('C'), item('D'), item('E')];
    const snaps = new Map<string, Snapshot>([
        ['A', snap('A', 50, 1, 2)],
        ['B', snap('B', 0, 0, 0)], // 沒有成交：視為沒有資料
        ['C', snap('C', 200, -4, -2)],
        ['E', snap('E', 50, 3, 6.4)],
        // D 沒有快照
    ]);

    it('自訂順序回傳 null（照伺服器順序）', () => {
        expect(sortCodes(items, { key: 'manual', dir: 'asc' }, snaps)).toBeNull();
    });

    it('股價：由高到低、由低到高；同值依原順序；沒有資料的列不論方向都在最後（依原順序）', () => {
        expect(sortCodes(items, { key: 'price', dir: 'desc' }, snaps)).toEqual(['C', 'A', 'E', 'B', 'D']);
        expect(sortCodes(items, { key: 'price', dir: 'asc' }, snaps)).toEqual(['A', 'E', 'C', 'B', 'D']);
    });

    it('漲幅%、漲跌：方向與缺資料在最後', () => {
        expect(sortCodes(items, { key: 'pct', dir: 'desc' }, snaps)).toEqual(['E', 'A', 'C', 'B', 'D']);
        expect(sortCodes(items, { key: 'pct', dir: 'asc' }, snaps)).toEqual(['C', 'A', 'E', 'B', 'D']);
        expect(sortCodes(items, { key: 'chg', dir: 'desc' }, snaps)).toEqual(['E', 'A', 'C', 'B', 'D']);
        expect(sortCodes(items, { key: 'chg', dir: 'asc' }, snaps)).toEqual(['C', 'A', 'E', 'B', 'D']);
    });

    it('還沒有排序依據：股價類全部視為沒有資料，維持原順序', () => {
        expect(sortCodes(items, { key: 'price', dir: 'desc' })).toEqual(['A', 'B', 'C', 'D', 'E']);
    });

    it('股票代號：自己的清單依代碼；固定清單依標的代號、同標的一般在小型前（反向只反轉標的）', () => {
        expect(sortCodes([item('2330'), item('00878'), item('TXFR1'), item('2317')], { key: 'code', dir: 'asc' })).toEqual(['00878', '2317', '2330', 'TXFR1']);
        expect(sortCodes([item('2330'), item('00878'), item('2317')], { key: 'code', dir: 'desc' })).toEqual(['2330', '2317', '00878']);
        const fixed = [item('QFFK6', '2330', 100), item('DHFK6', '2317', 2000), item('CDFK6', '2330', 2000), item('DE1K6', '2303', 2000)];
        expect(sortCodes(fixed, { key: 'code', dir: 'asc' })).toEqual(['DE1K6', 'DHFK6', 'CDFK6', 'QFFK6']);
        expect(sortCodes(fixed, { key: 'code', dir: 'desc' })).toEqual(['CDFK6', 'QFFK6', 'DHFK6', 'DE1K6']);
    });

    it('sortValuesOf：收盤價 ≤ 0 或非數字視為沒有資料', () => {
        expect(sortValuesOf(undefined)).toEqual({});
        expect(sortValuesOf(snap('X', 0, 1, 1))).toEqual({});
        expect(sortValuesOf({ code: 'X', close: Number.NaN } as Snapshot)).toEqual({});
        expect(sortValuesOf(snap('X', 10, -1, -9.09))).toEqual({ price: 10, chg: -1, pct: -9.09 });
    });
});

describe('偏好（本裝置）', () => {
    it('依清單 id 存取；固定清單不接受自訂順序；格式不對時用預設', () => {
        expect(readSortPref('a', false)).toEqual({ key: 'manual', dir: 'asc' });
        writeSortPref('a', { key: 'pct', dir: 'asc' });
        writeSortPref('fut:near', { key: 'price', dir: 'desc' });
        expect(readSortPref('a', false)).toEqual({ key: 'pct', dir: 'asc' });
        expect(readSortPref('fut:near', true)).toEqual({ key: 'price', dir: 'desc' });
        expect(JSON.parse(localStorage.getItem(SORT_STORAGE_KEY)!)).toEqual({ a: { key: 'pct', dir: 'asc' }, 'fut:near': { key: 'price', dir: 'desc' } });
        localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ 'fut:near': { key: 'manual', dir: 'asc' }, a: { key: 'bogus', dir: 'asc' }, b: { key: 'price', dir: 'up' } }));
        expect(readSortPref('fut:near', true)).toEqual({ key: 'code', dir: 'asc' });
        expect(readSortPref('a', false)).toEqual({ key: 'manual', dir: 'asc' });
        expect(readSortPref('b', false)).toEqual({ key: 'manual', dir: 'asc' });
        localStorage.setItem(SORT_STORAGE_KEY, '{oops');
        expect(readSortPref('a', false)).toEqual({ key: 'manual', dir: 'asc' });
        localStorage.setItem(SORT_STORAGE_KEY, '[1,2]');
        writeSortPref('c', { key: 'code', dir: 'desc' });
        expect(JSON.parse(localStorage.getItem(SORT_STORAGE_KEY)!)).toEqual({ c: { key: 'code', dir: 'desc' } });
    });

    it('儲存空間不可用（讀寫丟錯）：讀到預設、寫入不丟錯', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('SecurityError'); },
            setItem: () => { throw new Error('QuotaExceeded'); },
        });
        expect(readSortPref('a', false)).toEqual({ key: 'manual', dir: 'asc' });
        expect(() => writeSortPref('a', { key: 'price', dir: 'desc' })).not.toThrow();
    });
});

describe('排序依據（批次快照）', () => {
    it(`每批最多 ${SNAPSHOT_BATCH} 檔：300 檔 1 個請求、${SNAPSHOT_BATCH + 1} 檔 2 個`, async () => {
        m.fetchSnapshots.mockImplementation(async (cs: ContractBase[]) => cs.map(x => snap(x.code, 1, 0, 0)));
        const three = Array.from({ length: 300 }, (_, i) => c(`S${i}`));
        expect(await fetchSortSnapshots(three)).toHaveLength(300);
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(1);
        m.fetchSnapshots.mockClear();
        const many = Array.from({ length: SNAPSHOT_BATCH + 1 }, (_, i) => c(`S${i}`));
        expect(await fetchSortSnapshots(many)).toHaveLength(SNAPSHOT_BATCH + 1);
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(2);
        expect(m.fetchSnapshots.mock.calls[0]![0]).toHaveLength(SNAPSHOT_BATCH);
        expect(m.fetchSnapshots.mock.calls[1]![0]).toHaveLength(1);
    });

    it('snapshotIndex：先找代碼、再找 target_code（連續月）；不在清單的快照忽略', () => {
        const idx = snapshotIndex([c('TXFR1', 'TXFK6'), c('2330'), c('2317')], [snap('TXFK6', 22800, 10, 0.04), snap('2330', 1000, 5, 0.5), snap('9999', 1, 0, 0)]);
        expect([...idx.keys()]).toEqual(['TXFR1', '2330']);
        expect(idx.get('TXFR1')!.close).toBe(22800);
    });

    it('模組層快取每個清單最近一次的依據', () => {
        expect(getSortBasis('a')).toBeUndefined();
        const entry = { at: 1, snapshots: new Map() };
        setSortBasis('a', entry);
        expect(getSortBasis('a')).toBe(entry);
    });
});
