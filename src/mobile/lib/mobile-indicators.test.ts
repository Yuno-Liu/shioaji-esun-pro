// 手機指標設定（W2）：預設、持久化、驗證（夾住參數、丟掉不認得的、損毀回預設）、上限、增刪改、儲存不可用。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEF_BY_TYPE } from '../../lib/indicator-defs';
import {
    addIndicator,
    canAddIndicator,
    categoryCount,
    clampParam,
    defaultIndicatorSettings,
    getIndicatorSettings,
    indicatorLabel,
    indicatorName,
    INDICATOR_PALETTE,
    limitReason,
    MAX_OVERLAYS,
    MAX_PANES,
    MOBILE_INDICATOR_DEFS,
    MOBILE_INDICATORS_KEY,
    removeIndicator,
    resetIndicatorParams,
    resetIndicatorSettingsForTest,
    sanitizeIndicatorSettings,
    setIndicatorColor,
    setIndicatorSettings,
    updateIndicatorParams,
    type MobileIndicatorSettings,
} from './mobile-indicators';

const storage = new Map<string, string>();
const fakeStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
};

beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', fakeStorage);
    resetIndicatorSettingsForTest();
});
afterEach(() => {
    vi.unstubAllGlobals();
    resetIndicatorSettingsForTest();
});

describe('預設與定義', () => {
    it('預設＝MA(5)、MA(20)＋成交量（與 MVP 相同）', () => {
        const s = defaultIndicatorSettings();
        expect(s.volume).toBe(true);
        expect(s.items.map(indicatorLabel)).toEqual(['MA(5)', 'MA(20)']);
        expect(getIndicatorSettings()).toEqual(s);
    });

    it('手機提供全部 21 個內建指標（主圖 9、副圖 12）', () => {
        expect(MOBILE_INDICATOR_DEFS).toHaveLength(21);
        expect(MOBILE_INDICATOR_DEFS.filter(d => d.category === 'overlay')).toHaveLength(9);
        expect(MOBILE_INDICATOR_DEFS.filter(d => d.category === 'pane')).toHaveLength(12);
    });

    it('中文名去掉英文簡稱；標籤含參數', () => {
        expect(indicatorName(DEF_BY_TYPE.get('sma')!)).toBe('移動平均');
        expect(indicatorName(DEF_BY_TYPE.get('dmi')!)).toBe('趨向指標');
        expect(indicatorLabel({ type: 'boll', params: { period: 20, mult: 2 } })).toBe('BOLL(20,2)');
        expect(indicatorLabel({ type: 'vwap', params: {} })).toBe('VWAP');
    });
});

describe('clampParam', () => {
    const period = DEF_BY_TYPE.get('sma')!.params[0]!; // 1–500，整數
    const mult = DEF_BY_TYPE.get('boll')!.params[1]!; // 0.5–5，步進 0.5
    const sarStep = DEF_BY_TYPE.get('sar')!.params[0]!; // 0.01–0.1，步進 0.01

    it('夾在範圍內、整數參數取整、對齊步進', () => {
        expect(clampParam(period, 9999)).toBe(500);
        expect(clampParam(period, 0)).toBe(1);
        expect(clampParam(period, 7.6)).toBe(8);
        expect(clampParam(mult, 2.3)).toBe(2.5);
        expect(clampParam(mult, 99)).toBe(5);
        expect(clampParam(sarStep, 0.034)).toBe(0.03);
        expect(clampParam(period, '12')).toBe(12);
    });

    it('非數字回預設', () => {
        expect(clampParam(period, 'abc')).toBe(20);
        expect(clampParam(period, NaN)).toBe(20);
        expect(clampParam(period, null)).toBe(20);
        expect(clampParam(period, '')).toBe(20);
    });
});

describe('sanitizeIndicatorSettings（損毀資料）', () => {
    it('不是物件、版本不符、items 不是陣列 → 預設', () => {
        for (const raw of [null, 42, 'x', [], { version: 2, items: [] }, { version: 1, items: 'no' }]) {
            expect(sanitizeIndicatorSettings(raw)).toEqual(defaultIndicatorSettings());
        }
    });

    it('丟掉不認得的指標與壞項目、夾住參數、補預設參數、修正顏色與重複 id', () => {
        const s = sanitizeIndicatorSettings({
            version: 1,
            volume: false,
            items: [
                null,
                { id: 'x', type: 'nope', params: {} },
                { id: 'a', type: 'sma', params: { period: -5, junk: 1 }, color: 99 },
                { id: 'a', type: 'rsi', params: {}, color: 1 },
                { type: 'boll', params: { period: 'bad', mult: 7 } },
            ],
        });
        expect(s.volume).toBe(false);
        expect(s.items.map(i => i.type)).toEqual(['sma', 'rsi', 'boll']);
        expect(s.items[0]!.params).toEqual({ period: 1 });
        expect(s.items[0]!.color).toBeGreaterThanOrEqual(0);
        expect(s.items[0]!.color).toBeLessThan(INDICATOR_PALETTE.length);
        expect(s.items[1]!.params).toEqual({ period: 14 });
        expect(new Set(s.items.map(i => i.id)).size).toBe(3);
        expect(s.items[2]!.params).toEqual({ period: 20, mult: 5 });
    });

    it('超過上限的項目丟掉（先到先留）', () => {
        const items = [
            ...['sma', 'ema', 'wma', 'boll', 'vwap'].map((type, i) => ({ id: `o${i}`, type, params: {}, color: 0 })),
            ...['rsi', 'kd', 'macd'].map((type, i) => ({ id: `p${i}`, type, params: {}, color: 0 })),
        ];
        const s = sanitizeIndicatorSettings({ version: 1, volume: true, items });
        expect(categoryCount(s, 'overlay')).toBe(MAX_OVERLAYS);
        expect(categoryCount(s, 'pane')).toBe(MAX_PANES);
        expect(s.items.map(i => i.type)).toEqual(['sma', 'ema', 'wma', 'boll', 'rsi', 'kd']);
    });
});

describe('持久化', () => {
    it('寫入後重新載入讀回相同設定', () => {
        const next = addIndicator(getIndicatorSettings(), 'rsi');
        setIndicatorSettings(next);
        expect(JSON.parse(storage.get(MOBILE_INDICATORS_KEY)!)).toEqual(next);
        resetIndicatorSettingsForTest();
        expect(getIndicatorSettings()).toEqual(next);
    });

    it('localStorage 內容損毀 → 預設', () => {
        storage.set(MOBILE_INDICATORS_KEY, '{not json');
        resetIndicatorSettingsForTest();
        expect(getIndicatorSettings()).toEqual(defaultIndicatorSettings());
    });

    it('使用者移除全部指標（空清單）是合法設定，不回預設', () => {
        storage.set(MOBILE_INDICATORS_KEY, JSON.stringify({ version: 1, volume: true, items: [] }));
        resetIndicatorSettingsForTest();
        expect(getIndicatorSettings().items).toEqual([]);
    });

    it('儲存不可用（讀寫丟例外）時退回預設並保留記憶體中的設定', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('SecurityError'); },
            setItem: () => { throw new Error('QuotaExceeded'); },
        });
        resetIndicatorSettingsForTest();
        expect(getIndicatorSettings()).toEqual(defaultIndicatorSettings());
        const next = addIndicator(getIndicatorSettings(), 'kd');
        expect(() => setIndicatorSettings(next)).not.toThrow();
        expect(getIndicatorSettings()).toBe(next);
    });
});

describe('上限與增刪改', () => {
    function fill(types: string[]): MobileIndicatorSettings {
        return types.reduce((s, t) => addIndicator(s, t), { version: 1, volume: true, items: [] } as MobileIndicatorSettings);
    }

    it('主圖 4 個、副圖 2 個；達上限時不能加入並說明原因', () => {
        const s = fill(['sma', 'ema', 'wma', 'boll', 'rsi', 'kd']);
        expect(categoryCount(s, 'overlay')).toBe(4);
        expect(categoryCount(s, 'pane')).toBe(2);
        expect(addIndicator(s, 'vwap')).toBe(s);
        expect(addIndicator(s, 'macd')).toBe(s);
        const r = canAddIndicator(s, 'vwap');
        expect(r.ok).toBe(false);
        expect(r.ok ? '' : r.reason).toContain('主圖最多 4 個');
        expect(limitReason(s, 'pane')).toContain('副圖最多 2 個');
        expect(canAddIndicator(fill(['sma']), 'vwap')).toEqual({ ok: true });
        expect(canAddIndicator(s, 'nope').ok).toBe(false);
    });

    it('加入用預設參數與未使用的顏色；移除、更新參數（夾住）、恢復預設、改顏色', () => {
        let s = defaultIndicatorSettings();
        s = addIndicator(s, 'boll');
        const boll = s.items[2]!;
        expect(boll.params).toEqual({ period: 20, mult: 2 });
        expect(boll.color).toBe(2); // 0、1 已被 MA 用掉
        s = updateIndicatorParams(s, boll.id, { mult: 9, period: 30 });
        expect(s.items[2]!.params).toEqual({ period: 30, mult: 5 });
        expect(updateIndicatorParams(s, boll.id, { mult: 5 })).toBe(s); // 沒有變更回傳同一物件
        s = resetIndicatorParams(s, boll.id);
        expect(s.items[2]!.params).toEqual({ period: 20, mult: 2 });
        s = setIndicatorColor(s, boll.id, 4);
        expect(s.items[2]!.color).toBe(4);
        expect(setIndicatorColor(s, boll.id, 99)).toBe(s);
        s = removeIndicator(s, boll.id);
        expect(s.items.map(indicatorLabel)).toEqual(['MA(5)', 'MA(20)']);
        expect(removeIndicator(s, 'missing')).toBe(s);
    });
});
