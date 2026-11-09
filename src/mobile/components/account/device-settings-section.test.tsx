// 本裝置設定：音效開關沿用 sounds.ts（打開時在手勢內解鎖）、震動／螢幕常亮不支援時停用並說明、設定寫入本裝置
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    sound: false,
    setSoundEnabled: vi.fn(),
    unlock: vi.fn(() => true),
    play: vi.fn(() => true),
}));
vi.mock('../../../lib/esun', () => ({ isEsunAccount: () => false }));
vi.mock('../../../lib/sounds', () => ({
    soundEnabled: () => m.sound,
    setSoundEnabled: (on: boolean) => { m.setSoundEnabled(on); m.sound = on; },
}));
vi.mock('../../lib/fill-audio', () => ({ unlockFillAudio: m.unlock, playFillSound: m.play }));

import { getMobileDeviceSettings, resetMobileDeviceSettingsForTest } from '../../lib/mobile-device-settings';
import { getMobileUiSettings, resetMobileUiSettingsForTest } from '../../lib/ui-settings';
import { resetWakeLockStatusForTest } from '../../lib/wake-lock';
import { DeviceSettingsSection, wakeLockHint } from './device-settings-section';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const byTestId = (id: string) => view!.root.find(n => n.props['data-testid'] === id && typeof n.type === 'string');

async function mount() {
    await act(async () => { view = create(createElement(DeviceSettingsSection)); });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', undefined);
    resetMobileDeviceSettingsForTest();
    resetWakeLockStatusForTest();
    resetMobileUiSettingsForTest();
    m.sound = false;
    m.setSoundEnabled.mockClear();
    m.unlock.mockClear();
    m.play.mockClear();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('DeviceSettingsSection', () => {
    it('sound switch uses the shared sounds.ts switch and unlocks audio inside the tap', async () => {
        vi.stubGlobal('navigator', {});
        await mount();
        expect(byTestId('device-sound').props['aria-checked']).toBe(false);
        expect(byTestId('device-sound-preview').props.disabled).toBe(true);
        await act(async () => byTestId('device-sound').props.onClick());
        expect(m.setSoundEnabled).toHaveBeenCalledWith(true);
        expect(m.unlock).toHaveBeenCalledOnce();
        expect(byTestId('device-sound').props['aria-checked']).toBe(true);
        await act(async () => byTestId('device-sound-preview').props.onClick());
        expect(m.play).toHaveBeenCalledOnce();
        await act(async () => byTestId('device-sound').props.onClick());
        expect(m.setSoundEnabled).toHaveBeenLastCalledWith(false);
        // 試聽一次＋打開一次；關閉時不解鎖
        expect(m.unlock).toHaveBeenCalledTimes(2);
    });

    it('iOS (no vibrate, no wake lock): both switches disabled with an explanation', async () => {
        vi.stubGlobal('navigator', {});
        await mount();
        expect(byTestId('device-vibrate').props.disabled).toBe(true);
        expect(byTestId('device-vibrate').props['aria-checked']).toBe(false);
        expect(text(byTestId('device-vibrate-row'))).toContain('不支援震動');
        expect(byTestId('device-wake').props.disabled).toBe(true);
        expect(text(byTestId('device-wake-row'))).toContain('不支援螢幕常亮');
    });

    it('Android: vibrate and wake lock switches write the device settings', async () => {
        vi.stubGlobal('navigator', { vibrate: () => true, wakeLock: { request: () => Promise.resolve() } });
        await mount();
        expect(byTestId('device-vibrate').props.disabled).toBe(false);
        expect(byTestId('device-vibrate').props['aria-checked']).toBe(true);
        await act(async () => byTestId('device-vibrate').props.onClick());
        expect(getMobileDeviceSettings().vibrate).toBe(false);
        await act(async () => byTestId('device-wake').props.onClick());
        expect(getMobileDeviceSettings().wakeLock).toBe(true);
        expect(byTestId('device-wake').props['aria-checked']).toBe(true);
    });

    // 設計規格 §5.3、§7.8：介面觸覺回饋（Android）寫 ui-settings.uiHaptics；iOS／不支援震動時停用並說明
    it('Android: UI haptics switch writes ui-settings.uiHaptics (independent of fill vibration)', async () => {
        vi.stubGlobal('navigator', { vibrate: () => true, hardwareConcurrency: 8 });
        await mount();
        expect(byTestId('device-ui-haptics').props.role).toBe('switch');
        expect(byTestId('device-ui-haptics').props.disabled).toBe(false);
        expect(byTestId('device-ui-haptics').props['aria-checked']).toBe(true);
        expect(text(byTestId('device-ui-haptics-row'))).toContain('介面觸覺回饋（Android）');
        await act(async () => byTestId('device-ui-haptics').props.onClick());
        expect(getMobileUiSettings().uiHaptics).toBe(false);
        expect(byTestId('device-ui-haptics').props['aria-checked']).toBe(false);
        // 成交震動設定不受影響
        expect(getMobileDeviceSettings().vibrate).toBe(true);
    });

    it('iOS (no vibrate) or WebKit GestureEvent: UI haptics switch disabled with an explanation', async () => {
        vi.stubGlobal('navigator', {});
        await mount();
        expect(byTestId('device-ui-haptics').props.disabled).toBe(true);
        expect(byTestId('device-ui-haptics').props['aria-checked']).toBe(false);
        expect(text(byTestId('device-ui-haptics-row'))).toContain('不支援震動');
        await act(async () => byTestId('device-ui-haptics').props.onClick());
        expect(getMobileUiSettings().uiHaptics).toBe(true);
        await act(async () => view?.unmount());
        vi.stubGlobal('navigator', { vibrate: () => true });
        vi.stubGlobal('GestureEvent', function GestureEvent() { /* iPadOS WebKit */ });
        await mount();
        expect(byTestId('device-ui-haptics').props.disabled).toBe(true);
    });

    it('圖表長按選價下單: switch defaults off on every platform, explains itself, and writes chartPricePick', async () => {
        vi.stubGlobal('navigator', {});
        await mount();
        const sw = byTestId('device-chart-pick');
        expect(sw.props.role).toBe('switch');
        expect(sw.props.disabled).toBe(false);
        expect(sw.props['aria-checked']).toBe(false);
        expect(sw.props['aria-label']).toBe('圖表長按選價下單');
        const row = text(byTestId('device-chart-pick-row'));
        expect(row).toContain('圖表長按選價下單');
        expect(row).toContain('關閉時長按只看價格');
        await act(async () => byTestId('device-chart-pick').props.onClick());
        expect(getMobileDeviceSettings().chartPricePick).toBe(true);
        expect(byTestId('device-chart-pick').props['aria-checked']).toBe(true);
        await act(async () => byTestId('device-chart-pick').props.onClick());
        expect(getMobileDeviceSettings().chartPricePick).toBe(false);
        // 其他本裝置設定不受影響
        expect(getMobileDeviceSettings().vibrate).toBe(true);
        expect(getMobileDeviceSettings().wakeLock).toBe(false);
    });

    it('wake lock hint follows the status', () => {
        expect(wakeLockHint(true, true, { state: 'active', error: null })).toContain('保持常亮中');
        expect(wakeLockHint(true, true, { state: 'hidden', error: null })).toContain('回到前景');
        expect(wakeLockHint(true, true, { state: 'error', error: '瀏覽器拒絕' })).toContain('瀏覽器拒絕');
        expect(wakeLockHint(true, false, { state: 'off', error: null })).toContain('較耗電');
        expect(wakeLockHint(false, true, { state: 'unsupported', error: null })).toContain('16.4');
    });
});
