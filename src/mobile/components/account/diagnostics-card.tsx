// src/mobile/components/account/diagnostics-card.tsx — 帳戶頁「診斷」：secure context、Web Locks、BroadcastChannel、UA、建置版本

import { useState } from 'react';
import { readSecureContextDiagnostics } from '../../lib/secure-context';
import * as styles from '../../styles/account.css';
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
                <Item term='來源'>{d.origin || '—'}</Item>
                <Item term='建置版本' testId='diag-build'>{d.buildVersion}</Item>
                <dt className={styles.term}>User Agent</dt>
                <dd className={styles.ua}>{d.userAgent || '—'}</dd>
            </dl>
        </Card>
    );
}
