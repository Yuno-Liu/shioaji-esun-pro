// 介面觸覺：8／8／12ms；uiHaptics 關閉、不支援 vibrate、iOS、例外 → 不震且不丟錯
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMobileUiSettingsForTest, setMobileUiSettings } from '../lib/ui-settings';
import { HAPTIC_MS, haptic } from './haptics';

beforeEach(() => resetMobileUiSettingsForTest());
afterEach(() => {
    vi.unstubAllGlobals();
    resetMobileUiSettingsForTest();
});

describe('haptic', () => {
    it('threshold 8ms、longPress 8ms、bound 12ms', () => {
        expect(HAPTIC_MS).toEqual({ threshold: 8, longPress: 8, bound: 12 });
        const vibrate = vi.fn(() => true);
        for (const kind of ['threshold', 'longPress', 'bound'] as const) expect(haptic(kind, { vibrate })).toBe(true);
        expect(vibrate.mock.calls).toEqual([[8], [8], [12]]);
    });

    it('預設使用 navigator.vibrate', () => {
        const vibrate = vi.fn(() => true);
        vi.stubGlobal('navigator', { vibrate });
        expect(haptic('bound')).toBe(true);
        expect(vibrate).toHaveBeenCalledWith(12);
    });

    it('uiHaptics 關閉時不震', () => {
        setMobileUiSettings({ uiHaptics: false });
        const vibrate = vi.fn();
        expect(haptic('threshold', { vibrate })).toBe(false);
        expect(vibrate).not.toHaveBeenCalled();
    });

    it('不支援 vibrate（iOS Safari、node）時不震', () => {
        expect(haptic('threshold', {})).toBe(false);
        expect(haptic('threshold', undefined)).toBe(false);
    });

    it('iOS（有 GestureEvent）一律不執行，即使有 vibrate', () => {
        vi.stubGlobal('GestureEvent', function GestureEvent() { /* WebKit */ });
        const vibrate = vi.fn();
        expect(haptic('longPress', { vibrate })).toBe(false);
        expect(vibrate).not.toHaveBeenCalled();
    });

    it('vibrate 丟例外時吞掉並回傳 false', () => {
        expect(haptic('bound', { vibrate: () => { throw new Error('NotAllowed'); } })).toBe(false);
    });
});
