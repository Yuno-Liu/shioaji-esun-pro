// 帳戶頁「顯示」（設計規格 §7.8）：新增「降低透明度：跟隨系統／開／關」寫入 ui-settings.transparency；
// 既有主題／配色／字級／遮蔽控制不變。S1：顯示與本裝置區的所有新舊按鈕都不會呼叫 lib 的送單、改單、刪單。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    setThemeSettings: vi.fn(),
    setPrivacyMoney: vi.fn(),
    setPrivacyMode: vi.fn(),
    send: {
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelVerifiedOrder: vi.fn(),
        cancelOrders: vi.fn(),
        cancelComboOrder: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
    },
}));
vi.mock('../../../lib/esun', () => ({ isEsunAccount: () => false }));
vi.mock('../../../lib/theme-store', () => ({
    useThemeSettings: () => ({ mode: 'dark', convention: 'tw', fontScale: 1, custom: null }),
    setThemeSettings: m.setThemeSettings,
}));
vi.mock('../../../lib/privacy', () => ({
    usePrivacyMoney: () => false,
    usePrivacyMode: () => false,
    setPrivacyMoney: m.setPrivacyMoney,
    setPrivacyMode: m.setPrivacyMode,
}));
vi.mock('../../../lib/shioaji', () => m.send);
vi.mock('../../../lib/sounds', () => ({ soundEnabled: () => false, setSoundEnabled: vi.fn() }));
vi.mock('../../lib/fill-audio', () => ({ unlockFillAudio: vi.fn(() => true), playFillSound: vi.fn(() => true) }));

import { getMobileUiSettings, resetMobileUiSettingsForTest } from '../../lib/ui-settings';
import { getWatchSparklineEnabled, resetWatchPrefsForTest, WATCH_SPARK_KEY } from '../../lib/watch-prefs';
import { resetMobileDeviceSettingsForTest } from '../../lib/mobile-device-settings';
import { resetWakeLockStatusForTest } from '../../lib/wake-lock';
import { DeviceSettingsSection } from './device-settings-section';
import { DisplayCard, TRANSPARENCY_OPTIONS } from './display-card';

let view: ReactTestRenderer | undefined;
const textOf = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const byTestId = (id: string) => view!.root.find(n => typeof n.type === 'string' && n.props['data-testid'] === id);
const segButtons = (id: string) => byTestId(id).findAll(n => n.type === 'button');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', undefined);
    // 高階裝置：首次載入不套用「低階 Android 預設降低透明度」
    vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 8, vibrate: () => true });
    resetMobileUiSettingsForTest();
    resetWatchPrefsForTest();
    resetMobileDeviceSettingsForTest();
    resetWakeLockStatusForTest();
    m.setThemeSettings.mockClear();
    Object.values(m.send).forEach(f => f.mockClear());
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
    resetMobileUiSettingsForTest();
});

describe('DisplayCard transparency', () => {
    it('offers 跟隨系統／開／關 mapped to system／reduced／full', () => {
        expect(TRANSPARENCY_OPTIONS.map(o => [o.value, o.text])).toEqual([['system', '跟隨系統'], ['reduced', '開'], ['full', '關']]);
    });

    it('reflects the stored value and writes ui-settings.transparency immediately', async () => {
        await act(async () => { view = create(createElement(DisplayCard)); });
        const group = byTestId('display-transparency');
        expect(group.props.role).toBe('group');
        expect(group.props['aria-label']).toBe('降低透明度');
        expect(segButtons('display-transparency').map(textOf)).toEqual(['跟隨系統', '開', '關']);
        expect(segButtons('display-transparency').map(b => b.props['aria-pressed'])).toEqual([true, false, false]);

        await act(async () => segButtons('display-transparency')[1]!.props.onClick());
        expect(getMobileUiSettings().transparency).toBe('reduced');
        expect(segButtons('display-transparency').map(b => b.props['aria-pressed'])).toEqual([false, true, false]);

        await act(async () => segButtons('display-transparency')[2]!.props.onClick());
        expect(getMobileUiSettings().transparency).toBe('full');
        // 不動主題設定
        expect(m.setThemeSettings).not.toHaveBeenCalled();
    });

    it('existing display controls keep their testIds and still write the theme store', async () => {
        await act(async () => { view = create(createElement(DisplayCard)); });
        for (const id of ['display-mode', 'display-convention', 'display-font', 'display-privacy-money', 'display-privacy-account']) {
            expect(byTestId(id)).toBeTruthy();
        }
        await act(async () => segButtons('display-font')[2]!.props.onClick());
        expect(m.setThemeSettings).toHaveBeenCalledWith({ fontScale: 1.3 });
    });
});

describe('DisplayCard 自選迷你走勢', () => {
    it('預設開啟；切換寫入 localStorage（失敗時只在本次有效）', async () => {
        const data = new Map<string, string>();
        vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } });
        await act(async () => { view = create(createElement(DisplayCard)); });
        const sw = () => byTestId('display-watch-spark');
        expect(sw().props.role).toBe('switch');
        expect(sw().props['aria-label']).toBe('自選迷你走勢');
        expect(sw().props['aria-checked']).toBe(true);
        await act(async () => sw().props.onClick());
        expect(sw().props['aria-checked']).toBe(false);
        expect(data.get(WATCH_SPARK_KEY)).toBe('0');
        expect(getWatchSparklineEnabled()).toBe(false);
        await act(async () => view!.unmount());
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
        resetWatchPrefsForTest();
        await act(async () => { view = create(createElement(DisplayCard)); });
        expect(sw().props['aria-checked']).toBe(true);
        await act(async () => sw().props.onClick());
        expect(sw().props['aria-checked']).toBe(false);
    });
});

describe('S1: account display / device entries never send, amend or cancel orders', () => {
    it('pressing every button in 顯示 and 本裝置 calls no lib order function', async () => {
        await act(async () => {
            view = create(createElement('div', null, createElement(DisplayCard), createElement(DeviceSettingsSection)));
        });
        const buttons = () => view!.root.findAll(n => n.type === 'button');
        const count = buttons().length;
        expect(count).toBeGreaterThan(10);
        for (let i = 0; i < count; i++) {
            // 每次點擊後重新取得節點（點擊會重新渲染）
            const b = buttons()[i];
            if (!b || b.props.disabled) continue;
            await act(async () => b.props.onClick?.());
        }
        for (const f of Object.values(m.send)) expect(f).not.toHaveBeenCalled();
    });
});
