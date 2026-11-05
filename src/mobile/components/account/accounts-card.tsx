// src/mobile/components/account/accounts-card.tsx — 帳戶頁「帳號」：證券／期貨槽位與切換面板（規格 §5.4）

import { useState } from 'react';
import { useAccounts } from '../../../lib/account-store';
import { usePrivacyMode } from '../../../lib/privacy';
import type { Account } from '../../../lib/types/portfolio';
import { AccountSwitchSheet, mobileAccountLabel } from '../account-switch-sheet';
import { RouteBadge } from '../route-badge';
import * as styles from '../../styles/account.css';
import { brokerName, Card } from './account-ui';

function AccountSlot({ label, account, priv }: { label: string; account: Account | null; priv: boolean }) {
    return (
        <div className={styles.slot}>
            <span className={styles.slotLabel}>{label}</span>
            <span className={styles.slotValue}>{account ? `${brokerName(account)} ${mobileAccountLabel(account, priv)}` : '未選擇'}</span>
            {account && <RouteBadge account={account} />}
        </div>
    );
}

export function AccountsCard() {
    const state = useAccounts();
    const priv = usePrivacyMode();
    const [open, setOpen] = useState(false);
    return (
        <Card
            title='帳號'
            testId='account-accounts'
            extra={<button type='button' className={styles.smallButton} onClick={() => setOpen(true)} data-testid='account-switch-open'>切換帳戶</button>}
        >
            {!state.loaded && <p className={styles.note}>{state.loadError ? '帳戶載入失敗，請稍後再試。' : '帳戶載入中…'}</p>}
            <AccountSlot label='證券' account={state.selectedStock} priv={priv} />
            <AccountSlot label='期貨／選擇權' account={state.selectedFutures} priv={priv} />
            <AccountSwitchSheet open={open} onClose={() => setOpen(false)} />
        </Card>
    );
}
