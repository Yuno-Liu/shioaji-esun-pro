// src/mobile/components/account/limits-card.tsx — 帳戶頁「交易額度」（規格 Phase 2；比照桌面 LimitsSection）
//
// 資料：共用 useTradingLimits（模組層快取 60 秒、手動重新整理最短間隔 TRADING_LIMITS_MIN_REFRESH_MS）。
// 交易日 08:30–15:00 才有值；模擬環境回全 0 → limitsLookEmpty 時顯示「—」並說明，不顯示「可用 $0」。

import { useState } from 'react';
import { useAccounts } from '../../../lib/account-store';
import { isEsunAccount } from '../../../lib/esun';
import { maskMoney, usePrivacyMoney } from '../../../lib/privacy';
import { limitsLookEmpty, TRADING_LIMITS_MIN_REFRESH_MS, useTradingLimits } from '../../hooks/use-trading-limits';
import { formatClock, formatTwd } from '../../lib/account-format';
import { useOrderRoute } from '../route-badge';
import * as styles from '../../styles/account.css';
import { brokerName, Card, Item, RefreshButton, useNow } from './account-ui';

export function LimitsCard() {
    const { selectedStock: stock } = useAccounts();
    const limits = useTradingLimits(stock);
    const route = useOrderRoute(stock);
    const privMoney = usePrivacyMoney();
    const now = useNow(1_000);
    const [pressedAt, setPressedAt] = useState<number | null>(null);
    const money = (v: number) => maskMoney(formatTwd(v), privMoney);
    const last = Math.max(limits.updatedAt ?? 0, pressedAt ?? 0);
    const cooldownSec = last > 0 ? Math.max(0, Math.ceil((TRADING_LIMITS_MIN_REFRESH_MS - (now - last)) / 1000)) : 0;
    const empty = limitsLookEmpty(limits.data);
    const data = limits.data;

    return (
        <Card title={stock ? `交易額度（${brokerName(stock)}）` : '交易額度'} testId='account-limits'>
            {!stock ? (
                <p className={styles.note}>尚未選擇證券帳戶。</p>
            ) : (
                <>
                    {limits.loading && !data ? (
                        <p className={styles.note}>交易額度查詢中…</p>
                    ) : empty || !data ? (
                        <>
                            <dl className={styles.kv}>
                                <Item term='現股 可用／上限' tone='muted'>—</Item>
                                <Item term='融資 可用／上限' tone='muted'>—</Item>
                                <Item term='融券 可用／上限' tone='muted'>—</Item>
                            </dl>
                            {!limits.error && (
                                <p className={styles.note} data-testid='limits-empty'>
                                    {route?.simulation === true
                                        ? '模擬環境不提供交易額度。'
                                        : '模擬環境或非交易時段（交易日 08:30–15:00 以外）不提供交易額度。'}
                                </p>
                            )}
                        </>
                    ) : (
                        <dl className={styles.kv} data-testid='limits-values'>
                            <Item term='現股 可用／上限'>{money(data.trading_available)} / {money(data.trading_limit)}</Item>
                            <Item term='融資 可用／上限'>{money(data.margin_available)} / {money(data.margin_limit)}</Item>
                            <Item term='融券 可用／上限'>{money(data.short_available)} / {money(data.short_limit)}</Item>
                        </dl>
                    )}
                    {limits.error && <p className={styles.warning} role='alert'>交易額度查詢失敗：{limits.error}</p>}
                    {isEsunAccount(stock) && <p className={styles.note}>玉山的額度及信用權限另見「玉山帳務概覽」。</p>}
                    <div className={styles.actions}>
                        <span className={styles.note}>資料時間 {formatClock(limits.updatedAt)}</span>
                        <RefreshButton
                            label='重新整理'
                            loading={limits.loading}
                            cooldownSec={cooldownSec}
                            disabled={limits.loading || cooldownSec > 0}
                            onClick={() => { setPressedAt(Date.now()); limits.refresh(); }}
                            testId='limits-refresh'
                        />
                    </div>
                </>
            )}
        </Card>
    );
}
