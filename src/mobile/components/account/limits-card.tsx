// src/mobile/components/account/limits-card.tsx — 帳戶頁頂部「今日剩餘交易額度」（規格 Phase 2；比照桌面 LimitsSection）
//
// 主值：永豐＝現股今日剩餘（可用），已用與總額度有資料時一併顯示；玉山＝現股「估算剩餘」（標示「估算」，
// 下方「上限 L；今日買進 已成交 A＋未成交 B」，並說明玉山只提供上限、估算依本 App 今日買進委託、可能與券商不同）。
// 下方仍列現股／融資／融券 可用／上限（玉山只列上限）。規則見 today-limits.tsx 與 lib/esun-limit-estimate.ts。
// 依目前帳戶的市場：只有證券帳戶有交易額度；沒有證券帳戶而選了期貨帳戶時說明期貨沒有每日交易額度。
// 持倉頁摘要的額度列以 openTodayLimits() 跳來時，掛載後捲到本卡並聚焦（不發請求）；
// 在殼層 ScrollRestorer 還原捲動位置之後才捲動（見 useFocusOnArrival）。
//
// 資料：共用 useTradingLimits（模組層快取 60 秒、手動重新整理最短間隔 TRADING_LIMITS_MIN_REFRESH_MS）。
// 交易日 08:30–15:00 才有值；模擬環境回全 0 → limitsLookEmpty 時顯示「—」並說明，不顯示「可用 $0」。
// 玉山（limitsAreCapsOnly）只提供額度上限：不顯示 lib 補成上限的可用；剩餘只以「估算剩餘」顯示（useEsunLimitEstimate，不另發查詢）。
// 「重新整理」冷卻＝最後一次「實際發出」查詢後 TRADING_LIMITS_MIN_REFRESH_MS（同 hook 的 attemptedAt）：
//   看到 loading 由 false 變 true 就記為發出時間；按下後 hook 沒有發出（仍在最短間隔內）就不進入倒數，改顯示說明。
//   冷卻期間才每秒重繪。

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { useAccounts } from '../../../lib/account-store';
import { maskMoney, usePrivacyMoney } from '../../../lib/privacy';
import {
    getTradingLimitsState,
    limitsAreCapsOnly,
    limitsLookEmpty,
    TRADING_LIMITS_MIN_REFRESH_MS,
    useTradingLimits,
} from '../../hooks/use-trading-limits';
import { useEsunLimitEstimate } from '../../hooks/use-esun-limit-estimate';
import { formatClock, formatTwd } from '../../lib/account-format';
import { ESUN_ESTIMATE_TEXT, esunBreakdownText, esunEstimateFlags } from '../../lib/esun-limit-estimate';
import { useOrderRoute } from '../route-badge';
import * as styles from '../../styles/account.css';
import { brokerName, Card, Item, RefreshButton } from './account-ui';
import { consumeTodayLimitsFocus, TODAY_LIMITS_ID, TODAY_LIMITS_TEXT, todayLimitView } from './today-limits';

export const LIMITS_TEXT = {
    throttled: `剛查詢過，查詢間隔至少 ${TRADING_LIMITS_MIN_REFRESH_MS / 1000} 秒，請稍候再按。`,
    capsOnly: `${ESUN_ESTIMATE_TEXT.note}融資、融券只列上限；額度及信用權限另見「玉山帳務概覽」。`,
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

/**
 * 持倉頁跳來時捲到本卡並聚焦（jsdom 等沒有 scrollIntoView 時只聚焦）。
 * 延到微任務（同一次提交的 layout effect 全部跑完後、繪製前）：殼層的 ScrollRestorer 排在路由頁面之後，
 * 同一次提交會把 main 還原成帳戶頁記住的位置，直接在這裡捲動會被它蓋掉。
 * 請求在微任務內才消化：StrictMode 的掛載→卸載→再掛載只有最後一次會執行。
 */
function useFocusOnArrival() {
    useLayoutEffect(() => {
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled || !consumeTodayLimitsFocus() || typeof document === 'undefined') return;
            const el = document.getElementById(TODAY_LIMITS_ID);
            if (!el) return;
            if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
            el.focus({ preventScroll: true });
        });
        return () => { cancelled = true; };
    }, []);
}

export function LimitsCard() {
    const { selectedStock: stock, selectedFutures: futures } = useAccounts();
    const limits = useTradingLimits(stock);
    const estimate = useEsunLimitEstimate(stock, limits.data);
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
    const today = todayLimitView(limits, capsOnly, estimate);
    const flags = today.estimate ? esunEstimateFlags(today.estimate) : [];
    useFocusOnArrival();
    const onRefresh = () => {
        if (!stock) return;
        limits.refresh();
        // hook 在最短間隔內會直接忽略（不發請求、不改狀態）：不進入倒數假裝在讀，改顯示說明
        setThrottled(!getTradingLimitsState(stock).loading);
    };

    return (
        <Card
            title={stock ? `${capsOnly && !today.estimate && today.status === 'ok' ? TODAY_LIMITS_TEXT.capsTitle : TODAY_LIMITS_TEXT.title}（${brokerName(stock)}）` : TODAY_LIMITS_TEXT.title}
            testId='account-limits'
            id={TODAY_LIMITS_ID}
        >
            {!stock ? (
                <p className={styles.note} data-testid='limits-no-stock'>{futures ? TODAY_LIMITS_TEXT.futures : '尚未選擇證券帳戶。'}</p>
            ) : (
                <>
                    {today.status === 'ok' && (
                        <div className={styles.limitsHero} data-testid='limits-today'>
                            <span className={styles.limitsHeroLabel}>
                                {today.estimate ? `現股 ${ESUN_ESTIMATE_TEXT.label}` : capsOnly ? '現股' : '現股今日剩餘（可用）'}
                                {capsOnly && <span className={styles.badge}>{today.estimate ? '估算' : '上限'}</span>}
                            </span>
                            <span className={styles.limitsHeroValue} data-testid='limits-today-value'>{today.primary === null ? '—' : money(today.primary)}</span>
                            {today.estimate && (
                                <span className={styles.limitsHeroSub} data-testid='limits-today-sub'>{esunBreakdownText(today.estimate, money)}</span>
                            )}
                            {flags.length > 0 && (
                                <span className={styles.limitsHeroSub} data-testid='limits-estimate-flags'>{flags.join('；')}</span>
                            )}
                            {!capsOnly && (today.used !== null || today.total !== null) && (
                                <span className={styles.limitsHeroSub} data-testid='limits-today-sub'>
                                    {[today.used !== null ? `已用 ${money(today.used)}` : '', today.total !== null ? `總額度 ${money(today.total)}` : ''].filter(Boolean).join(' · ')}
                                </span>
                            )}
                        </div>
                    )}
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
