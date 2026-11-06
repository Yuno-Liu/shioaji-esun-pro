// src/mobile/components/account/display-card.tsx — 帳戶頁「顯示」：主題、漲跌配色、字級、降低透明度、遮蔽（規格 §6.7；設計規格 §7.8）
//
// 降低透明度寫入 lib/ui-settings 的 transparency（跟隨系統＝system、開＝reduced、關＝full）；
// html[data-sj-transparency] 由殼層的 useHtmlAttributes 訂閱設定後立即改寫（不在本元件）。

import { setPrivacyMode, setPrivacyMoney, usePrivacyMode, usePrivacyMoney } from '../../../lib/privacy';
import { setThemeSettings, useThemeSettings, type Convention, type FontScale, type ThemeMode } from '../../../lib/theme-store';
import { setMobileUiSettings, useMobileUiSettings, type MobileUiSettings } from '../../lib/ui-settings';
import * as styles from '../../styles/account.css';
import { Card, Segmented, Switch } from './account-ui';

type Transparency = MobileUiSettings['transparency'];

export const TRANSPARENCY_OPTIONS: readonly { value: Transparency; text: string }[] = [
    { value: 'system', text: '跟隨系統' },
    { value: 'reduced', text: '開' },
    { value: 'full', text: '關' },
];

export function DisplayCard() {
    const theme = useThemeSettings();
    const ui = useMobileUiSettings();
    const privMoney = usePrivacyMoney();
    const priv = usePrivacyMode();
    const modes: { value: ThemeMode; text: string }[] = [
        { value: 'dark', text: '深色' },
        { value: 'light', text: '淺色' },
        ...(theme.custom || theme.mode === 'custom' ? [{ value: 'custom' as ThemeMode, text: '自訂' }] : []),
    ];
    return (
        <Card title='顯示' testId='account-display'>
            <div className={styles.settingBlock}>
                <span>主題</span>
                <Segmented label='主題' value={theme.mode} options={modes} onChange={mode => setThemeSettings({ mode })} testId='display-mode' />
            </div>
            <div className={styles.settingBlock}>
                <span>漲跌配色</span>
                <Segmented<Convention>
                    label='漲跌配色'
                    value={theme.convention}
                    options={[{ value: 'tw', text: '台灣（紅漲綠跌）' }, { value: 'intl', text: '國際（綠漲紅跌）' }]}
                    onChange={convention => setThemeSettings({ convention })}
                    testId='display-convention'
                />
            </div>
            <div className={styles.settingBlock}>
                <span>字級</span>
                <Segmented<FontScale>
                    label='字級'
                    value={theme.fontScale}
                    options={[{ value: 1, text: '小' }, { value: 1.15, text: '標準' }, { value: 1.3, text: '大' }]}
                    onChange={fontScale => setThemeSettings({ fontScale })}
                    testId='display-font'
                />
            </div>
            <div className={styles.settingBlock}>
                <span>降低透明度</span>
                <Segmented<Transparency>
                    label='降低透明度'
                    value={ui.transparency}
                    options={TRANSPARENCY_OPTIONS}
                    onChange={transparency => setMobileUiSettings({ transparency })}
                    testId='display-transparency'
                />
                <span className={styles.settingHint}>開：底部列與通知改為實心、不模糊（較省電，低階 Android 預設開啟）。iPhone 的 Safari 不會套用系統的「降低透明度」，請在這裡切換。</span>
            </div>
            <div className={styles.settingRow}>
                <span className={styles.settingLabel}>
                    <span>遮蔽金額</span>
                    <span className={styles.settingHint}>餘額、損益、交割款以 ••••• 顯示</span>
                </span>
                <Switch checked={privMoney} label='遮蔽金額' onChange={setPrivacyMoney} testId='display-privacy-money' />
            </div>
            <div className={styles.settingRow}>
                <span className={styles.settingLabel}>
                    <span>遮蔽帳號</span>
                    <span className={styles.settingHint}>帳號只露末兩碼</span>
                </span>
                <Switch checked={priv} label='遮蔽帳號' onChange={setPrivacyMode} testId='display-privacy-account' />
            </div>
        </Card>
    );
}
