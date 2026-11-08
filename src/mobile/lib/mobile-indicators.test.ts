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
    INDICATOR_TEMPLATES,
    indicatorLabel,
    indicatorName,
    indicatorWarmupBars,
    INDICATOR_PALETTE,
    insufficientDataNote,
    limitReason,
    MAX_OVERLAYS,
    MAX_PANES,
    MOBILE_INDICATOR_DEFS,
    MOBILE_INDICATORS_KEY,
    templateSettings,
    templateSummary,
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

describe('暖機根數與「資料不足」說明（F4:F4）', () => {
    const defaults = (type: string) => Object.fromEntries(DEF_BY_TYPE.get(type)!.params.map(p => [p.key, p.def]));

    it('以實測取得各輸出第一個有值的根數（MA(20)＝20、MACD DIF 26／DEA 34、DMI ±DI 15／ADX 28）', () => {
        expect(indicatorWarmupBars(DEF_BY_TYPE.get('sma')!, { period: 20 })).toEqual({ line: 20 });
        expect(indicatorWarmupBars(DEF_BY_TYPE.get('boll')!, defaults('boll'))).toEqual({ mid: 20, upper: 20, lower: 20 });
        expect(indicatorWarmupBars(DEF_BY_TYPE.get('macd')!, defaults('macd'))).toEqual({ hist: 34, macd: 26, signal: 34 });
        expect(indicatorWarmupBars(DEF_BY_TYPE.get('dmi')!, defaults('dmi'))).toEqual({ plus: 15, minus: 15, adx: 28 });
        // 參數上限也量得到
        expect(indicatorWarmupBars(DEF_BY_TYPE.get('sma')!, { period: 500 })).toEqual({ line: 500 });
    });

    it('只在某個方向才有值的輸出（SuperTrend 多頭／空頭）以最早有值的根數為準，不誤報', () => {
        const w = indicatorWarmupBars(DEF_BY_TYPE.get('supertrend')!, defaults('supertrend'));
        expect(w.up).toBe(w.down);
        expect(insufficientDataNote(w, { up: false, down: true }, 15)).toBeNull();
    });

    it('全部內建指標都量得到（沒有值的輸出不會被誤判）', () => {
        for (const def of MOBILE_INDICATOR_DEFS) {
            const w = indicatorWarmupBars(def, defaults(def.type));
            for (const o of def.outputs) expect(w[o.key], `${def.type}.${o.key}`).toBeGreaterThan(0);
        }
    });

    it('說明只在沒有值且根數不足時出現，取需要最多根的輸出', () => {
        const dmi = { plus: 15, minus: 15, adx: 28 };
        expect(insufficientDataNote(dmi, { plus: false, minus: false, adx: true }, 17)).toBe('資料不足（需 28 根，目前 17 根）');
        expect(insufficientDataNote(dmi, { plus: true, minus: true, adx: true }, 10)).toBe('資料不足（需 28 根，目前 10 根）');
        expect(insufficientDataNote(dmi, { plus: false, minus: false, adx: false }, 30)).toBeNull();
        // 根數夠卻沒值（其他原因）不說是資料不足
        expect(insufficientDataNote({ line: 20 }, { line: true }, 25)).toBeNull();
    });
});

describe('內建範本（當沖、波段、長線）', () => {
    it('三個範本：只用手機可用的指標、參數 key 與定義完全相同且在範圍內，主圖／副圖都在上限內', () => {
        expect(INDICATOR_TEMPLATES.map(t => t.label)).toEqual(['當沖', '波段', '長線']);
        for (const t of INDICATOR_TEMPLATES) {
            let overlays = 0;
            let panes = 0;
            for (const it of t.items) {
                const def = DEF_BY_TYPE.get(it.type);
                expect(def, `${t.id}:${it.type}`).toBeDefined();
                expect(MOBILE_INDICATOR_DEFS.includes(def!), `${t.id}:${it.type}`).toBe(true);
                expect(Object.keys(it.params).sort(), `${t.id}:${it.type}`).toEqual(def!.params.map(p => p.key).sort());
                for (const p of def!.params) {
                    // 已是合法值：夾住後不變
                    expect(clampParam(p, it.params[p.key]), `${t.id}:${it.type}.${p.key}`).toBe(it.params[p.key]);
                }
                if (def!.category === 'overlay') overlays++;
                else panes++;
            }
            expect(overlays, t.id).toBeLessThanOrEqual(MAX_OVERLAYS);
            expect(panes, t.id).toBeLessThanOrEqual(MAX_PANES);
            // 轉成設定後不丟任何一項（sanitize 不截掉）
            expect(templateSettings(t).items).toHaveLength(t.items.length);
        }
    });

    it('內容：當沖 VWAP＋MA5／MA20＋MACD、波段 MA5／20／60＋KD、長線 MA20／60／120＋RSI；成交量一律顯示', () => {
        const byId = Object.fromEntries(INDICATOR_TEMPLATES.map(t => [t.id, t]));
        expect(templateSummary(byId.daytrade!)).toBe('VWAP、MA(5)、MA(20)、MACD(12,26,9)');
        expect(templateSummary(byId.swing!)).toBe('MA(5)、MA(20)、MA(60)、KD(9,3,3)');
        expect(templateSummary(byId.long!)).toBe('MA(20)、MA(60)、MA(120)、RSI(14)');
        for (const t of INDICATOR_TEMPLATES) {
            const s = templateSettings(t);
            expect(s.volume).toBe(true);
            // 顏色依序、各不相同；id 唯一
            expect(s.items.map(i => i.color)).toEqual(s.items.map((_, i) => i));
            expect(new Set(s.items.map(i => i.id)).size).toBe(s.items.length);
        }
    });
});
