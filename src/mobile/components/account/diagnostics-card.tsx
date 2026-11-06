// src/mobile/components/account/diagnostics-card.tsx — 帳戶頁「診斷」：secure context、Web Locks、BroadcastChannel、UA、建置版本

import { useState } from 'react';
import { readSecureContextDiagnostics } from '../../lib/secure-context';
import * as styles from '../../styles/account.css';
import { SELECTABLE } from '../../styles/layout.css';
import { Card, Item } from './account-ui';

export function DiagnosticsCard() {
    const [d] = useState(() => readSecureContextDiagnostics());
    const yes = (ok: boolean) => (ok ? '支援' : '不支援');
    return (
        <Card title='診斷' testId='account-diagnostics'>
            <dl className={styles.kv}>
                <Item term='Secure context' tone={d.isSecureContext ? 'good' : 'bad'}>{d.isSecureContext ? '是（HTTPS）' : '否'}</Item>
                <Item term='Web Locks' tone={d.webLocks ? 'good' : 'bad'}>{yes(d.webLocks)}</Item>
                <Item term='BroadcastChannel' tone={d.broadcastChannel ? 'good' : 'bad'}>{yes(d.broadcastChannel)}</Item>
                {/* 來源、建置版本、UA 要能長按選取複製（回報問題用；全域 user-select: none 的例外） */}
                <Item term='來源' className={SELECTABLE} testId='diag-origin'>{d.origin || '—'}</Item>
                <Item term='建置版本' className={SELECTABLE} testId='diag-build'>{d.buildVersion}</Item>
                <dt className={styles.term}>User Agent</dt>
                <dd className={`${styles.ua} ${SELECTABLE}`} data-testid='diag-ua'>{d.userAgent || '—'}</dd>
            </dl>
        </Card>
    );
}
