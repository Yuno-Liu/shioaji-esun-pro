// 手機字級預設「小」：只在第一次啟動套用一次，且尊重使用者已選的字級
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ setThemeSettings: vi.fn() }));
vi.mock('../../lib/theme-store', () => ({ setThemeSettings: m.setThemeSettings }));

import { applyMobileFontDefault, MOBILE_FONT_DEFAULT_FLAG, storedScaleIsDefault, THEME_STORAGE_KEY } from './font-default';

function memoryStorage(init: Record<string, string> = {}) {
    const data = new Map(Object.entries(init));
    return {
        data,
        getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
        setItem: (k: string, v: string) => { data.set(k, String(v)); },
    };
}
const theme = (fontScale: unknown) => JSON.stringify({ mode: 'dark', convention: 'tw', fontScale });

beforeEach(() => {
    m.setThemeSettings.mockReset();
});

describe('storedScaleIsDefault', () => {
    it('沒有存過、預設 1.15、缺值、無效值、JSON 壞掉都視為預設', () => {
        expect(storedScaleIsDefault(null)).toBe(true);
        expect(storedScaleIsDefault(theme(1.15))).toBe(true);
        expect(storedScaleIsDefault(JSON.stringify({ mode: 'dark', convention: 'tw' }))).toBe(true);
        expect(storedScaleIsDefault(theme(2))).toBe(true);
        expect(storedScaleIsDefault('{not json')).toBe(true);
        expect(storedScaleIsDefault('null')).toBe(true);
    });
    it('使用者選過的小（含舊值 0.85）與大不是預設', () => {
        expect(storedScaleIsDefault(theme(1))).toBe(false);
        expect(storedScaleIsDefault(theme(0.85))).toBe(false);
        expect(storedScaleIsDefault(theme(1.3))).toBe(false);
    });
});

describe('applyMobileFontDefault', () => {
    it('第一次啟動且沒有主題設定 → 改成小並寫入旗標', () => {
        const s = memoryStorage();
        expect(applyMobileFontDefault(s)).toBe(true);
        expect(m.setThemeSettings).toHaveBeenCalledWith({ fontScale: 1 });
        expect(s.data.get(MOBILE_FONT_DEFAULT_FLAG)).toBe('1');
    });

    it('已存字級仍是預設 1.15 → 改成小', () => {
        const s = memoryStorage({ [THEME_STORAGE_KEY]: theme(1.15) });
        expect(applyMobileFontDefault(s)).toBe(true);
        expect(m.setThemeSettings).toHaveBeenCalledTimes(1);
        expect(m.setThemeSettings).toHaveBeenCalledWith({ fontScale: 1 });
    });

    it('使用者已選大 → 不改，但仍寫入旗標', () => {
        const s = memoryStorage({ [THEME_STORAGE_KEY]: theme(1.3) });
        expect(applyMobileFontDefault(s)).toBe(false);
        expect(m.setThemeSettings).not.toHaveBeenCalled();
        expect(s.data.get(MOBILE_FONT_DEFAULT_FLAG)).toBe('1');
    });

    it('只套用一次：之後使用者改回標準（1.15）也不再覆蓋', () => {
        const s = memoryStorage();
        applyMobileFontDefault(s);
        // 使用者在帳戶頁改回「標準」
        s.setItem(THEME_STORAGE_KEY, theme(1.15));
        m.setThemeSettings.mockClear();
        expect(applyMobileFontDefault(s)).toBe(false);
        expect(applyMobileFontDefault(s)).toBe(false);
        expect(m.setThemeSettings).not.toHaveBeenCalled();
    });

    it('儲存空間不可用或讀取丟錯 → 不調整、不丟錯', () => {
        expect(applyMobileFontDefault(null)).toBe(false);
        const broken = {
            getItem: () => { throw new Error('SecurityError'); },
            setItem: () => { throw new Error('SecurityError'); },
        };
        expect(() => applyMobileFontDefault(broken)).not.toThrow();
        expect(m.setThemeSettings).not.toHaveBeenCalled();
    });

    it('setThemeSettings 丟錯（儲存已滿）→ 回傳 false，仍嘗試寫旗標', () => {
        m.setThemeSettings.mockImplementation(() => { throw new Error('QuotaExceededError'); });
        const s = memoryStorage();
        expect(applyMobileFontDefault(s)).toBe(false);
        expect(s.data.get(MOBILE_FONT_DEFAULT_FLAG)).toBe('1');
    });
});
