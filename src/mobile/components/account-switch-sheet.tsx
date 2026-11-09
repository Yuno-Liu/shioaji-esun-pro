// src/mobile/components/account-switch-sheet.tsx — 帳戶切換面板（規格 §5.4）
//
// - 依市場分組：「證券」（永豐、玉山）、「期貨／選擇權」（永豐）。
// - 每列：券商、帳號（遮蔽模式用 privacyAccountLabel）、環境徽章；canTrade() 為 false 時標示「不可交易（未簽署）」且不可選。
// - 選取呼叫 selectAccount(account)（src/lib/account-store.ts）。
// - 下單面板開啟或確認進行中時不允許切換（避免路由變更；即使切換，captureDisplayedRoute() 也會擋下）。
// - 底部說明的「帳戶 › 連線」連結跳到帳戶頁交易環境區塊（玉山模擬／正式切換；lib/account-jump.ts），本面板不切換環境。

import { Check, TriangleAlert } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { selectAccount, useAccounts } from '../../lib/account-store';
import { canTrade } from '../../lib/account-tradable';
import { isEsunAccount, useEsunEnvironment } from '../../lib/esun';
import { accountMatches } from '../../lib/flash-account';
import { accountConfirmLabel, getPendingOrderConfirm, privacyAccountLabel, subscribeOrderConfirm } from '../../lib/order-confirm';
import { orderRouteOf, routeEnvText } from '../../lib/order-route';
import { usePrivacyMode } from '../../lib/privacy';
import { useServerInfo } from '../../lib/server-info-store';
import type { Account } from '../../lib/types/portfolio';
import { jumpToAccountSection } from '../lib/account-jump';
import { useMobileUi } from '../lib/mobile-store';
import * as controls from '../styles/controls.css';
import * as routeStyles from '../styles/route-badge.css';
import * as styles from '../styles/status-bar.css';
import { BottomSheet } from './bottom-sheet';
import { routeTone } from './route-badge';

/** 帳號顯示（確認視窗同規則：只露末四碼；隱私模式只露末兩碼） */
export function mobileAccountLabel(account: Pick<Account, 'broker_id' | 'account_id'>, priv: boolean): string {
    return privacyAccountLabel(accountConfirmLabel(account), priv);
}

/** 是否允許切換帳戶：下單面板開啟或確認進行中時不允許 */
export function useAccountSwitchLocked(): boolean {
    const ui = useMobileUi();
    const pendingConfirm = useSyncExternalStore(subscribeOrderConfirm, getPendingOrderConfirm);
    return ui.ticket !== null || pendingConfirm !== null;
}

export function AccountSwitchSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
    const state = useAccounts();
    const priv = usePrivacyMode();
    const esun = useEsunEnvironment();
    const info = useServerInfo(); // canTrade() 依伺服器模式判斷：模式改變時重新渲染
    const locked = useAccountSwitchLocked();
    const live = { esunEnvironment: esun.environment, sinopacSimulation: info?.simulation };

    const groups: { title: string; type: 'S' | 'F'; selected: Account | null }[] = [
        { title: '證券', type: 'S', selected: state.selectedStock },
        { title: '期貨／選擇權', type: 'F', selected: state.selectedFutures },
    ];

    return (
        <BottomSheet open={open} onClose={onClose} title='切換帳戶' testId='account-switch-sheet'>
            {locked && <p className={styles.lockNotice} role='status'>下單面板開啟或確認進行中，暫時不能切換帳戶。</p>}
            {!state.loaded && <p className={styles.note}>{state.loadError ? '帳戶載入失敗，請稍後再試。' : '帳戶載入中…'}</p>}
            {groups.map(group => {
                const list = state.accounts.filter(a => a.account_type === group.type);
                if (list.length === 0) return null;
                return (
                    <section key={group.type} className={styles.group}>
                        <h3 className={styles.groupTitle}>{group.title}</h3>
                        <div className={styles.groupCard}>
                            {list.map(account => {
                                const tradable = canTrade(account);
                                const selected = accountMatches(group.selected, account);
                                const route = orderRouteOf(account, live);
                                const tone = routeTone(route);
                                return (
                                    <button
                                        key={`${account.account_type}:${account.broker_id}:${account.account_id}`}
                                        type='button'
                                        className={styles.accountRow}
                                        aria-pressed={selected}
                                        disabled={locked || !tradable}
                                        data-testid='account-option'
                                        onClick={() => {
                                            if (locked || !tradable) return;
                                            selectAccount(account);
                                            onClose();
                                        }}
                                    >
                                        <span className={styles.accountMain}>
                                            <span className={styles.accountName}>{isEsunAccount(account) ? '玉山' : '永豐'} {mobileAccountLabel(account, priv)}</span>
                                            {!tradable && (
                                                <span className={styles.accountWarn}>
                                                    <TriangleAlert className={styles.warnIcon} size={14} aria-hidden='true' focusable='false' />
                                                    不可交易（未簽署）
                                                </span>
                                            )}
                                            {selected && <span className={styles.accountSub}>目前使用中</span>}
                                        </span>
                                        <span className={routeStyles.envPill[tone]}>{routeEnvText(route.simulation)}</span>
                                        {selected && <Check className={styles.selectedIcon} size={18} strokeWidth={2.5} aria-hidden='true' focusable='false' />}
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                );
            })}
            <p className={styles.note}>永豐模擬／正式由伺服器部署決定，只能顯示；玉山可在帳戶 › 連線切換。</p>
            <div className={styles.sheetActions}>
                <button type='button' className={controls.button.neutral} data-testid='account-env-link' onClick={() => { onClose(); jumpToAccountSection('account-env-switch'); }}>
                    玉山模擬／正式切換
                </button>
            </div>
        </BottomSheet>
    );
}
