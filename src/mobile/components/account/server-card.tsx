// src/mobile/components/account/server-card.tsx — 帳戶頁「伺服器」：版本、模擬／正式、憑證、每日流量（規格 §6.7）

import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { useMonitorResource } from '../../../hooks/use-monitor-resource';
import { parseUsage, quotaState, type Usage } from '../../../lib/server-monitor';
import { useServerInfo } from '../../../lib/server-info-store';
import { fetchHealth, fetchInfo } from '../../../lib/shioaji';
import type { Health } from '../../../lib/types/health';
import { shareHealth } from '../../lib/ca-expiry-check';
import * as styles from '../../styles/account.css';
import { ProgressBar, type BarTone } from '../../ui/bars';
import { Card, Item, useNow, type Tone } from './account-ui';
import { RECHECK_COOLDOWN_MS } from './connection-card';

/** 每日流量重新讀取間隔 */
export const USAGE_REFRESH_MS = 60_000;

function mib(n: number): string {
    return `${(n / 1_048_576).toLocaleString('zh-TW', { maximumFractionDigits: 1 })} MiB`;
}

function useDocumentVisible(): boolean {
    return useSyncExternalStore(
        (l) => {
            if (typeof document === 'undefined') return () => undefined;
            document.addEventListener('visibilitychange', l);
            return () => document.removeEventListener('visibilitychange', l);
        },
        () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
        () => true,
    );
}

function caTone(health: Health | null): Tone {
    if (!health) return 'muted';
    if (health.ca_expired) return 'bad';
    const d = health.ca_expires_in_days;
    if (d === undefined) return 'muted';
    return d <= 7 ? 'bad' : d <= 30 ? 'warn' : 'normal';
}

export function ServerCard() {
    const info = useServerInfo();
    const [health, setHealth] = useState<Health | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [nonce, bump] = useReducer((n: number) => n + 1, 0);
    const [lastCheck, setLastCheck] = useState(0);
    const now = useNow(RECHECK_COOLDOWN_MS);
    const visible = useDocumentVisible();
    const usage = useMonitorResource<Usage>('/api/v1/auth/usage', visible, USAGE_REFRESH_MS, parseUsage);
    const quota = quotaState(usage.data);

    useEffect(() => {
        const controller = new AbortController();
        setLastCheck(Date.now());
        setError(null);
        fetchInfo().catch(() => undefined);
        // 登記給前景憑證提醒沿用（lib/ca-expiry-check.ts），同一分鐘內不重複讀
        shareHealth(fetchHealth({ signal: controller.signal })).then(
            h => { if (!controller.signal.aborted) setHealth(h); },
            () => { if (!controller.signal.aborted) setError('伺服器狀態讀取失敗'); },
        );
        return () => controller.abort();
    }, [nonce]);

    const mode = info?.simulation === true ? { text: '模擬', tone: 'accent' as Tone } : info?.simulation === false ? { text: '正式', tone: 'bad' as Tone } : { text: '未確認', tone: 'warn' as Tone };
    const ca = !health ? '—' : health.ca_expired ? '已過期' : health.ca_expires_in_days !== undefined ? `${health.ca_expires_in_days} 天` : '—';
    const quotaFill: BarTone = quota.tone === 'danger' ? 'danger' : quota.tone === 'warning' ? 'amber' : quota.tone === 'muted' ? 'flat' : 'accent';

    return (
        <Card title='伺服器' testId='account-server'>
            <dl className={styles.kv}>
                <Item term='版本'>{info?.version ?? health?.version ?? '—'}</Item>
                <Item term='模擬／正式' tone={mode.tone} testId='server-mode'>{mode.text}</Item>
                <Item term='憑證剩餘' tone={caTone(health)}>{ca}</Item>
                {health?.session_recovering && <Item term='券商連線' tone='warn'>自動恢復中</Item>}
                <Item term='每日流量' tone={quota.tone === 'danger' ? 'bad' : quota.tone === 'warning' ? 'warn' : 'normal'} testId='server-usage'>
                    {usage.data ? `${mib(usage.data.bytes)} / ${usage.data.limit_bytes > 0 ? mib(usage.data.limit_bytes) : '未知'}` : usage.error ? '讀取失敗' : '—'}
                </Item>
            </dl>
            {usage.data && (
                <>
                    <div className={styles.meter}>
                        <ProgressBar percent={Math.min(100, Math.max(0, quota.percent ?? 0))} tone={quotaFill} />
                    </div>
                    <p className={styles.note}>{quota.label}{quota.percent !== null ? `（${quota.percent.toFixed(1)}%）` : ''}</p>
                </>
            )}
            {error && <p className={styles.warning}>{error}</p>}
            <div className={styles.actions}>
                <button type='button' className={styles.smallButton} disabled={now - lastCheck < RECHECK_COOLDOWN_MS} onClick={bump}>重新讀取</button>
            </div>
            <p className={styles.note}>模擬／正式由伺服器部署決定，手機版不能切換。</p>
        </Card>
    );
}
