// src/mobile/components/account/display-card.tsx — 帳戶頁「顯示」：主題、漲跌配色、字級、遮蔽（規格 §6.7）

import { setPrivacyMode, setPrivacyMoney, usePrivacyMode, usePrivacyMoney } from '../../../lib/privacy';
import { setThemeSettings, useThemeSettings, type Convention, type FontScale, type ThemeMode } from '../../../lib/theme-store';
import * as styles from '../../styles/account.css';
import { Card, Segmented, Switch } from './account-ui';

export function DisplayCard() {
    const theme = useThemeSettings();
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
