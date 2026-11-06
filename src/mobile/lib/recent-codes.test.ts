// 最近查看（交易頁切換商品面板）：最新在前、去重、上限 10、壞資料當空清單、讀寫失敗不丟錯
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRecentCodes, RECENT_CODES_KEY, RECENT_CODES_MAX, recordRecentCode } from './recent-codes';

let store: Map<string, string>;
const fakeStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
};

beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', fakeStorage);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('recent-codes', () => {
    it('key 與上限', () => {
        expect(RECENT_CODES_KEY).toBe('sj-mobile-recent-codes');
        expect(RECENT_CODES_MAX).toBe(10);
    });

    it('最新在前、以代碼去重（再看一次移到最前，名稱以新的為準）', () => {
        recordRecentCode({ code: '2330', name: '台積電', securityType: 'STK' });
        recordRecentCode({ code: '2317', name: '鴻海', securityType: 'STK' });
        const list = recordRecentCode({ code: '2330', name: '台積電(新)', securityType: 'STK' });
        expect(list.map(r => r.code)).toEqual(['2330', '2317']);
        expect(list[0]!.name).toBe('台積電(新)');
        expect(loadRecentCodes()).toEqual(list);
        expect(JSON.parse(store.get(RECENT_CODES_KEY)!)).toEqual(list);
    });

    it('最多 10 筆，超過時丟掉最舊的', () => {
        for (let i = 0; i < 13; i++) recordRecentCode({ code: `${1000 + i}`, name: `n${i}` });
        const list = loadRecentCodes();
        expect(list).toHaveLength(10);
        expect(list[0]!.code).toBe('1012');
        expect(list[9]!.code).toBe('1003');
    });

    it('沒有 securityType 時不寫入該欄位', () => {
        const [first] = recordRecentCode({ code: 'TXFR1', name: '台指期近月' });
        expect(first).toEqual({ code: 'TXFR1', name: '台指期近月' });
    });

    it.each([
        ['不是 JSON', '{oops'],
        ['不是陣列', '{"code":"2330"}'],
        ['null', 'null'],
        ['數字', '42'],
    ])('壞資料（%s）當空清單', (_label, raw) => {
        store.set(RECENT_CODES_KEY, raw);
        expect(loadRecentCodes()).toEqual([]);
        // 之後照常記錄並覆寫
        expect(recordRecentCode({ code: '2330', name: '台積電' })).toEqual([{ code: '2330', name: '台積電' }]);
    });

    it('個別壞項目略過：不合法代碼、非物件、重複；名稱非字串當空字串、種類格式不對略過', () => {
        store.set(RECENT_CODES_KEY, JSON.stringify([
            { code: '2330', name: '台積電', securityType: 'STK' },
            { code: 'bad code!', name: 'x' },
            'oops',
            null,
            { code: '2330', name: '重複' },
            { code: '2317', name: 7, securityType: 'stk<script>' },
        ]));
        expect(loadRecentCodes()).toEqual([
            { code: '2330', name: '台積電', securityType: 'STK' },
            { code: '2317', name: '' },
        ]);
    });

    it('localStorage 不存在或讀寫丟錯：讀為空清單、寫只在本次有效，不丟錯', () => {
        vi.stubGlobal('localStorage', undefined);
        expect(loadRecentCodes()).toEqual([]);
        expect(recordRecentCode({ code: '2330', name: '台積電' })).toEqual([{ code: '2330', name: '台積電' }]);
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('denied'); },
            setItem: () => { throw new Error('quota'); },
        });
        expect(loadRecentCodes()).toEqual([]);
        expect(() => recordRecentCode({ code: '2330', name: '台積電' })).not.toThrow();
    });
});
