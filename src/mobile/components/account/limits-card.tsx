// src/mobile/components/account/limits-card.tsx — 帳戶頁「交易額度」（規格 Phase 2；比照桌面 LimitsSection）
//
// 資料：共用 useTradingLimits（模組層快取 60 秒、手動重新整理最短間隔 TRADING_LIMITS_MIN_REFRESH_MS）。
// 交易日 08:30–15:00 才有值；模擬環境回全 0 → limitsLookEmpty 時顯示「—」並說明，不顯示「可用 $0」。
// 玉山（limitsAreCapsOnly）只提供額度上限：只顯示「上限」，不顯示可用／剩餘（lib 會把缺的可用補成上限）。
// 「重新整理」冷卻＝最後一次「實際發出」查詢後 TRADING_LIMITS_MIN_REFRESH_MS（同 hook 的 attemptedAt）：
//   看到 loading 由 false 變 true 就記為發出時間；按下後 hook 沒有發出（仍在最短間隔內）就不進入倒數，改顯示說明。
//   冷卻期間才每秒重繪。

import { useEffect, useReducer, useRef, useState } from 'react';
import { useAccounts } from '../../../lib/account-store';
import { maskMoney, usePrivacyMoney } from '../../../lib/privacy';
import {
    getTradingLimitsState,
    limitsAreCapsOnly,
    limitsLookEmpty,
    TRADING_LIMITS_MIN_REFRESH_MS,
    useTradingLimits,
} from '../../hooks/use-trading-limits';
import { formatClock, formatTwd } from '../../lib/account-format';
import { useOrderRoute } from '../route-badge';
import * as styles from '../../styles/account.css';
import { brokerName, Card, Item, RefreshButton } from './account-ui';

export const LIMITS_TEXT = {
    throttled: `剛查詢過，查詢間隔至少 ${TRADING_LIMITS_MIN_REFRESH_MS / 1000} 秒，請稍候再按。`,
    capsOnly: '玉山只提供額度上限，未提供可用／剩餘額度；額度及信用權限另見「玉山帳務概覽」。',
} as const;

/** 最後一次觀察到「實際發出」查詢的時間（loading false→true）；帳戶切換時重設 */
function useObservedAttempt(key: string, loading: boolean): number | null {
    const [at, setAt] = useState<{ key: string; at: number } | null>(null);
    const prev = useRef({ key: '', loading: false });
    useEffect(() => {
        if (loading && !(prev.current.key === key && prev.current.loading)) setAt({ key, at: Date.now() });
        prev.current = { key, loading };
    }, [key, loading]);
    return at && at.key === key ? at.at : null;
}

export function LimitsCard() {
    const { selectedStock: stock } = useAccounts();
    const limits = useTradingLimits(stock);
    const route = useOrderRoute(stock);
    const privMoney = usePrivacyMoney();
    const accountKey = stock ? `${stock.broker_id}:${stock.account_id}` : '';
    const attemptAt = useObservedAttempt(accountKey, limits.loading);
    const [throttled, setThrottled] = useState(false);
    const [, tick] = useReducer((n: number) => n + 1, 0);
    const money = (v: number) => maskMoney(formatTwd(v), privMoney);
    // 掛載前發出的查詢看不到發出時間：成功時 updatedAt ≥ 發出時間，用它當下限（只會比 hook 保守）
    const last = Math.max(attemptAt ?? 0, limits.updatedAt ?? 0);
    const now = Date.now();
    const remainingMs = last > 0 ? TRADING_LIMITS_MIN_REFRESH_MS - (now - last) : 0;
    const cooldownSec = remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
    // 冷卻期間才每秒重繪
    useEffect(() => {
        if (cooldownSec <= 0) return;
        const t = setTimeout(tick, Math.min(1_000, Math.max(50, remainingMs - (cooldownSec - 1) * 1_000)));
        return () => clearTimeout(t);
    });
    useEffect(() => { setThrottled(false); }, [accountKey]);
    const empty = limitsLookEmpty(limits.data);
    const data = limits.data;
    const capsOnly = limitsAreCapsOnly(stock);
    const term = (name: string) => (capsOnly ? `${name} 上限` : `${name} 可用／上限`);
    const onRefresh = () => {
        if (!stock) return;
        limits.refresh();
        // hook 在最短間隔內會直接忽略（不發請求、不改狀態）：不進入倒數假裝在讀，改顯示說明
        setThrottled(!getTradingLimitsState(stock).loading);
    };

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
                                <Item term={term('現股')} tone='muted'>—</Item>
                                <Item term={term('融資')} tone='muted'>—</Item>
                                <Item term={term('融券')} tone='muted'>—</Item>
                            </dl>
                            {!limits.error && (
                                <p className={styles.note} data-testid='limits-empty'>
                                    {route?.simulation === true
                                        ? '模擬環境不提供交易額度。'
                                        : '模擬環境或非交易時段（交易日 08:30–15:00 以外）不提供交易額度。'}
                                </p>
                            )}
                        </>
                    ) : capsOnly ? (
                        <dl className={styles.kv} data-testid='limits-values'>
                            <Item term={term('現股')}>{money(data.trading_limit)}</Item>
                            <Item term={term('融資')}>{money(data.margin_limit)}</Item>
                            <Item term={term('融券')}>{money(data.short_limit)}</Item>
                        </dl>
                    ) : (
                        <dl className={styles.kv} data-testid='limits-values'>
                            <Item term='現股 可用／上限'>{money(data.trading_available)} / {money(data.trading_limit)}</Item>
                            <Item term='融資 可用／上限'>{money(data.margin_available)} / {money(data.margin_limit)}</Item>
                            <Item term='融券 可用／上限'>{money(data.short_available)} / {money(data.short_limit)}</Item>
                        </dl>
                    )}
                    {limits.error && <p className={styles.warning} role='alert'>交易額度查詢失敗：{limits.error}</p>}
                    {capsOnly && <p className={styles.note} data-testid='limits-caps-only'>{LIMITS_TEXT.capsOnly}</p>}
                    {throttled && !limits.loading && cooldownSec === 0 && <p className={styles.note} role='status' data-testid='limits-throttled'>{LIMITS_TEXT.throttled}</p>}
                    <div className={styles.actions}>
                        <span className={styles.note}>資料時間 {formatClock(limits.updatedAt)}</span>
                        <RefreshButton
                            label='重新整理'
                            loading={limits.loading}
                            cooldownSec={cooldownSec}
                            disabled={limits.loading || cooldownSec > 0}
                            onClick={onRefresh}
                            testId='limits-refresh'
                        />
                    </div>
                </>
            )}
        </Card>
    );
}
