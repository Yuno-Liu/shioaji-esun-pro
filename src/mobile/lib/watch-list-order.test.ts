// 群組（清單）顯示順序：只存在這台裝置（localStorage 'sj-mobile-watch-list-order-v1'），不發請求。
// 合併規則：已存的 id 依存的順序在前、只留仍存在的清單；其他清單依伺服器順序在後（新清單在最後）；已刪除的 id 略過；
// 內容不是字串陣列、JSON 損毀或 localStorage 不可用時當作沒有設定（伺服器順序）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIST_ORDER_KEY, orderLists, readListOrder } from './watch-list-order';

const data = new Map<string, string>();
const L = (...ids: string[]) => ids.map(id => ({ id, name: id.toUpperCase() }));
const ids = (lists: { id: string }[]) => lists.map(l => l.id);

beforeEach(() => {
    data.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
    });
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('orderLists', () => {
    it('沒有設定：伺服器順序（不改動傳入的陣列）', () => {
        const server = L('a', 'b', 'c');
        expect(LIST_ORDER_KEY).toBe('sj-mobile-watch-list-order-v1');
        expect(ids(orderLists(server))).toEqual(['a', 'b', 'c']);
        expect(orderLists(server)).not.toBe(server);
    });

    it('已存的順序在前；不在順序裡的（新清單）依伺服器順序接在最後', () => {
        data.set(LIST_ORDER_KEY, JSON.stringify(['c', 'a']));
        expect(ids(orderLists(L('a', 'b', 'c', 'd')))).toEqual(['c', 'a', 'b', 'd']);
    });

    it('已刪除的 id 直接略過', () => {
        data.set(LIST_ORDER_KEY, JSON.stringify(['gone', 'c', 'old', 'a']));
        expect(ids(orderLists(L('a', 'b', 'c')))).toEqual(['c', 'a', 'b']);
    });

    it('格式不對或損毀：忽略（伺服器順序）', () => {
        for (const raw of ['{', '"a"', '{"a":1}', '[1,2]', '["a",3]', 'null', '42']) {
            data.set(LIST_ORDER_KEY, raw);
            expect(readListOrder(), raw).toEqual([]);
            expect(ids(orderLists(L('a', 'b', 'c'))), raw).toEqual(['a', 'b', 'c']);
        }
    });

    it('localStorage 不可用（讀取丟錯、不存在）：伺服器順序', () => {
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('SecurityError'); } });
        expect(ids(orderLists(L('b', 'a')))).toEqual(['b', 'a']);
        vi.stubGlobal('localStorage', undefined);
        expect(ids(orderLists(L('b', 'a')))).toEqual(['b', 'a']);
    });

    it('可傳入順序（排序面板的暫存）', () => {
        expect(ids(orderLists(L('a', 'b', 'c'), ['b']))).toEqual(['b', 'a', 'c']);
    });
});
