// src/mobile/components/account/device-settings-section.tsx — 帳戶頁「本裝置」設定區塊（規格 §2.1、Phase 2／3）
//
// 對外介面固定：無 props 的 DeviceSettingsSection（由 routes/account-page.tsx 掛在「顯示」之後）。
// - 成交音效：開關沿用 src/lib/sounds.ts 的 soundEnabled／setSoundEnabled（'sj-pro-sound'，與桌面同一瀏覽器共用）；
//   打開開關（使用者手勢內）時順便解鎖 iOS 的 AudioContext；「試聽」播放同音色的成交提示音。
// - 震動：選配（lib/mobile-device-settings）；瀏覽器沒有 navigator.vibrate（iOS Safari）時停用並說明。
// - 螢幕常亮：選配（lib/mobile-device-settings → hooks/use-wake-lock 在殼層啟停）；不支援 Wake Lock 時停用並說明，
//   支援時顯示目前狀態（持有中、背景已釋放、系統暫停、失敗原因）。
// - 介面觸覺回饋（Android）：lib/ui-settings 的 uiHaptics（設計規格 §5.3、§7.8）；滑塊到達門檻、長按、步進撞界時短震。
//   iOS 或不支援 navigator.vibrate 時停用並說明（與成交震動同一判斷；motion/haptics 另在 iOS 一律不執行）。

import { useState, type ReactNode } from 'react';
import { setSoundEnabled, soundEnabled } from '../../../lib/sounds';
import { playFillSound, unlockFillAudio } from '../../lib/fill-audio';
import { setMobileDeviceSettings, useMobileDeviceSettings, vibrationSupported, wakeLockSupported } from '../../lib/mobile-device-settings';
import { isIOSWebKit, setMobileUiSettings, useMobileUiSettings } from '../../lib/ui-settings';
import { useWakeLockStatus, type WakeLockStatus } from '../../lib/wake-lock';
import * as styles from '../../styles/account.css';
import { Card, Switch } from './account-ui';

function SettingRow({ label, hint, children, testId }: { label: string; hint: ReactNode; children: ReactNode; testId?: string }) {
    return (
        <div className={styles.settingRow} data-testid={testId}>
            <div className={styles.settingLabel}>
                <span>{label}</span>
                <span className={styles.settingHint}>{hint}</span>
            </div>
            {children}
        </div>
    );
}

export function wakeLockHint(supported: boolean, enabled: boolean, status: WakeLockStatus): string {
    if (!supported) return '此瀏覽器不支援螢幕常亮（需 iOS／iPadOS 16.4 以上的 Safari，或 Android Chrome）。';
    if (!enabled) return '開啟後，本頁在前景時螢幕不會自動關閉（較耗電）。';
    switch (status.state) {
        case 'active': return '螢幕保持常亮中；切到背景會自動解除，回到前景再啟用。';
        case 'pending': return '啟用中…';
        case 'hidden': return '頁面在背景，已解除；回到前景時重新啟用。';
        case 'released': return '系統已暫停螢幕常亮（可能是省電模式）；觸控畫面或回到前景時再試。';
        case 'error': return `無法啟用：${status.error ?? '未知原因'}；觸控畫面後會再試一次。`;
        default: return '開啟後，本頁在前景時螢幕不會自動關閉（較耗電）。';
    }
}

export function DeviceSettingsSection() {
    const device = useMobileDeviceSettings();
    const ui = useMobileUiSettings();
    const wake = useWakeLockStatus();
    const [sound, setSound] = useState(() => soundEnabled());
    const canVibrate = vibrationSupported();
    const canWake = wakeLockSupported();
    const canUiHaptic = canVibrate && !isIOSWebKit();

    const toggleSound = (next: boolean) => {
        try {
            setSoundEnabled(next);
        } catch {
            // localStorage 無法寫入：sounds.ts 的模組開關已改，只在本次有效
        }
        setSound(soundEnabled());
        // 在這次點擊（使用者手勢）內解鎖 iOS 的 AudioContext，之後成交才會出聲
        if (next) unlockFillAudio();
    };

    return (
        <Card title='本裝置' testId='account-device'>
            <SettingRow
                label='成交音效'
                hint='成交時播放提示音（與桌面版在同一瀏覽器共用此開關）。iPhone 需先觸控畫面一次才會出聲，靜音模式下不響；頁面在背景時不播。'
                testId='device-sound-row'
            >
                <button
                    type='button'
                    className={styles.smallButton}
                    disabled={!sound}
                    onClick={() => { unlockFillAudio(); playFillSound(); }}
                    data-testid='device-sound-preview'
                >
                    試聽
                </button>
                <Switch checked={sound} onChange={toggleSound} label='成交音效' testId='device-sound' />
            </SettingRow>
            <SettingRow
                label='成交震動'
                hint={canVibrate
                    ? '成交時短震一下（只作輔助，仍以通知與音效為主）。'
                    : '此瀏覽器不支援震動（iPhone／iPad 的 Safari 不支援），成交仍有通知與音效。'}
                testId='device-vibrate-row'
            >
                <Switch
                    checked={canVibrate && device.vibrate}
                    disabled={!canVibrate}
                    onChange={(next) => setMobileDeviceSettings({ vibrate: next })}
                    label='成交震動'
                    testId='device-vibrate'
                />
            </SettingRow>
            <SettingRow
                label='介面觸覺回饋（Android）'
                hint={canUiHaptic
                    ? '滑動確認到達門檻、長按、數量撞到上下限時輕震一下（不影響成交震動）。'
                    : '此瀏覽器不支援震動（iPhone／iPad 的 Safari 不支援），改以畫面變化提示。'}
                testId='device-ui-haptics-row'
            >
                <Switch
                    checked={canUiHaptic && ui.uiHaptics}
                    disabled={!canUiHaptic}
                    onChange={(next) => setMobileUiSettings({ uiHaptics: next })}
                    label='介面觸覺回饋'
                    testId='device-ui-haptics'
                />
            </SettingRow>
            <SettingRow label='螢幕常亮' hint={wakeLockHint(canWake, device.wakeLock, wake)} testId='device-wake-row'>
                <Switch
                    checked={canWake && device.wakeLock}
                    disabled={!canWake}
                    onChange={(next) => setMobileDeviceSettings({ wakeLock: next })}
                    label='螢幕常亮'
                    testId='device-wake'
                />
            </SettingRow>
            <p className={styles.deviceOnly}>以上設定只對本裝置有效，不會同步到其他裝置。</p>
        </Card>
    );
}
