// src/mobile/routes/orders-page.tsx — 委託（規格 §6.5、§7.3）
//
// - 資料：useTradingState().trades（AccountedTrade，每列帶帳戶）；不自行輪詢（規格 §9.1）。
// - 分頁：[未成交 N]（ACTIVE_ORDER_STATUSES 且剩餘量 > 0，部分成交仍有剩餘也在這裡）［已成交］（同桌面：status Filled）［全部］；
//   帳戶篩選「全部」或單一帳戶。最新在前；「全部」時未成交置頂。
// - 對帳 banner：queries.orders.needsReconcile／reasons 以 RECONCILE_REASON_LABELS 顯示，附「對帳」鍵（＝更新）。
// - 「⟳ 更新」：reconcileOrdersOnce()（lib 的 refreshTradingState('orders') 可能回傳其他範圍進行中的讀取，
//   或在 1.5 秒冷卻內直接 resolve 而沒有讀委託；reconcileOrdersOnce 會等兩者結束後真的讀一次，絕不送出任何委託），
//   按下後 6 秒冷卻（玉山 refresh 5 秒間隔、10 次／分）；冷卻跨分頁切換保留。
// - 委託尚未讀到（queries.orders.updatedAt 為 null 且沒有任何委託）時顯示「委託載入中…」，不顯示「沒有委託」。
// - 每列的改價／減量／刪單只開委託操作面板（order-action-sheet.tsx，滑動確認後才呼叫 lib）；顯示規則同面板。
// - 全部刪單：有未成交時顯示；先開確認面板（筆數、涉及帳戶）滑動確認才呼叫 cancelAllOrders()。
//   cancelAllOrders() 會刪除所有可交易帳戶的未成交委託（不受帳戶篩選限制），面板照實列出全部帳戶。

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { mutationErrorNotice } from '../../components/esun-order-meta';
import { useEsunOrderMeta } from '../../lib/esun/account-details';
import { usePrivacyMode } from '../../lib/privacy';
import { cancelAllOrders, notify } from '../../lib/trade';
import { RECONCILE_REASON_LABELS, reconcileOrdersOnce, useTradingState } from '../../lib/trading-state';
import type { Trade } from '../../lib/types/order';
import { fmtInt } from '../../lib/utils/format';
import { mobileAccountLabel } from '../components/account-switch-sheet';
import { BottomSheet } from '../components/bottom-sheet';
import {
    isWorkingTrade,
    orderActionAvailability,
    OrderLines,
    tradeAccountKey,
    tradeAccountOf,
    type TradeAccount,
} from '../components/order-action-sheet';
import { routeBadgeText, useOrderRoute } from '../components/route-badge';
import { SlideToConfirm } from '../components/slide-to-confirm';
import { isNotStarted } from '../lib/errors';
import { openOrderAction } from '../lib/mobile-store';
import * as layout from '../styles/layout.css';
import * as styles from '../styles/orders.css';

/** 「更新」冷卻（玉山委託查詢 refresh 5 秒最小間隔、10 次／分） */
export const ORDERS_REFRESH_COOLDOWN_MS = 6_000;

export type OrdersTab = 'working' | 'filled' | 'all';

export const ORDERS_TEXT = {
    loading: '委託載入中…',
    readFailed: '委託尚未讀取成功，請按「⟳ 更新」',
    none: '沒有委託',
    noneInTab: '此分頁沒有委託',
} as const;

/** 上次按「更新」的時間（模組層：切換分頁回來冷卻仍有效） */
let lastRefreshAt = Number.NEGATIVE_INFINITY;

/** 測試用：清除冷卻 */
export function resetOrdersRefreshCooldownForTest(): void {
    lastRefreshAt = Number.NEGATIVE_INFINITY;
}

/** 分類（同桌面 bottom-dock-orders.tsx 的 statusBucket；未成交另要求 ACTIVE 狀態） */
export function orderTabOf(trade: Trade): Exclude<OrdersTab, 'all'> | 'dead' {
    if (isWorkingTrade(trade)) return 'working';
    return trade.status.status === 'Filled' ? 'filled' : 'dead';
}

function useRefreshCooldown() {
    const [, tick] = useReducer((x: number) => x + 1, 0);
    const left = Math.max(0, lastRefreshAt + ORDERS_REFRESH_COOLDOWN_MS - Date.now());
    useEffect(() => {
        if (left <= 0) return;
        const id = setTimeout(tick, Math.min(1_000, left));
        return () => clearTimeout(id);
    });
    const refresh = () => {
        if (Math.max(0, lastRefreshAt + ORDERS_REFRESH_COOLDOWN_MS - Date.now()) > 0) return;
        lastRefreshAt = Date.now();
        tick();
        // 讀取失敗不會 reject：原因留在 queries.orders.reasons，由對帳 banner 顯示
        void reconcileOrdersOnce().catch(() => undefined);
    };
    return { left, refresh };
}

export function OrdersPage() {
    const state = useTradingState();
    const priv = usePrivacyMode();
    const trades = state.trades;
    const query = state.queries.orders;
    const [tab, setTab] = useState<OrdersTab>('working');
    const [accountKey, setAccountKey] = useState('');
    const [confirmAll, setConfirmAll] = useState(false);
    const { left, refresh } = useRefreshCooldown();

    // 帳戶選項：依委託出現的帳戶
    const accounts = useMemo(() => {
        const map = new Map<string, { account: TradeAccount; count: number }>();
        for (const t of trades) {
            const account = tradeAccountOf(t);
            const key = tradeAccountKey(account);
            if (!account || !key) continue;
            const entry = map.get(key);
            if (entry) entry.count += 1;
            else map.set(key, { account, count: 1 });
        }
        return [...map.entries()].map(([key, v]) => ({ key, ...v }));
    }, [trades]);
    const scopeKey = accounts.some(a => a.key === accountKey) ? accountKey : '';

    const scoped = useMemo(
        () => (scopeKey ? trades.filter(t => tradeAccountKey(tradeAccountOf(t)) === scopeKey) : trades),
        [trades, scopeKey],
    );
    const workingCount = useMemo(() => scoped.filter(isWorkingTrade).length, [scoped]);
    const rows = useMemo(() => {
        const newest = [...scoped].reverse();
        if (tab === 'all') return [...newest.filter(isWorkingTrade), ...newest.filter(t => !isWorkingTrade(t))];
        return newest.filter(t => orderTabOf(t) === tab);
    }, [scoped, tab]);
    // 全部刪單＝所有帳戶的未成交（cancelAllOrders 不受篩選限制）
    const allWorking = useMemo(() => trades.filter(isWorkingTrade), [trades]);

    const tabs: { key: OrdersTab; label: string }[] = [
        { key: 'working', label: `未成交 ${workingCount}` },
        { key: 'filled', label: '已成交' },
        { key: 'all', label: '全部' },
    ];
    const cooling = left > 0;
    const refreshLabel = cooling ? `⟳ 更新（${Math.ceil(left / 1_000)}）` : '⟳ 更新';
    // 委託還沒讀到：不能說「沒有委託」（讀取失敗時原因另由對帳 banner 顯示）
    const unread = query.updatedAt === null && trades.length === 0;

    return (
        <section className={layout.page} data-testid='page-orders'>
            <div className={styles.header}>
                <h1 className={styles.headerTitle}>委託</h1>
                <button
                    type='button'
                    className={styles.button.neutral}
                    data-testid='orders-refresh'
                    disabled={cooling}
                    aria-label={cooling ? `更新委託（${Math.ceil(left / 1_000)} 秒後可再按）` : '更新委託'}
                    onClick={refresh}
                >
                    {refreshLabel}
                </button>
            </div>

            <div className={styles.filterRow}>
                <div className={styles.tabs} role='tablist' aria-label='委託狀態'>
                    {tabs.map(t => (
                        <button
                            key={t.key}
                            type='button'
                            role='tab'
                            aria-selected={tab === t.key}
                            className={tab === t.key ? styles.tab.on : styles.tab.off}
                            data-testid={`orders-tab-${t.key}`}
                            onClick={() => setTab(t.key)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
                <select
                    className={styles.accountPicker}
                    aria-label='帳戶篩選'
                    data-testid='orders-account'
                    value={scopeKey}
                    onChange={e => setAccountKey(e.target.value)}
                >
                    <option value=''>帳戶：全部</option>
                    {accounts.map(a => (
                        <option key={a.key} value={a.key}>{mobileAccountLabel(a.account, priv)}</option>
                    ))}
                </select>
            </div>

            {query.needsReconcile && (
                <div className={styles.banner} role='status' data-testid='orders-reconcile'>
                    <span className={styles.bannerText}>
                        ⚠ {query.reasons.map(r => RECONCILE_REASON_LABELS[r] ?? r).join('、') || '待對帳'}：委託可能不完整，請按「對帳」重新讀取後核對
                    </span>
                    <button type='button' className={styles.button.neutral} disabled={cooling} onClick={refresh}>
                        {cooling ? `對帳（${Math.ceil(left / 1_000)}）` : '對帳'}
                    </button>
                </div>
            )}

            {rows.length === 0 ? (
                <p className={styles.empty} data-testid='orders-empty'>
                    {unread ? (query.error ? ORDERS_TEXT.readFailed : ORDERS_TEXT.loading) : trades.length === 0 ? ORDERS_TEXT.none : ORDERS_TEXT.noneInTab}
                </p>
            ) : (
                <ul className={styles.list}>
                    {rows.map(t => <OrderRow key={t.order.id} trade={t} />)}
                </ul>
            )}

            {allWorking.length > 0 && (
                <div className={styles.footer}>
                    <button type='button' className={styles.cancelAllButton} data-testid='orders-cancel-all' onClick={() => setConfirmAll(true)}>
                        全部刪單（{allWorking.length} 筆）
                    </button>
                </div>
            )}

            <CancelAllSheet open={confirmAll} working={allWorking} onClose={() => setConfirmAll(false)} />
        </section>
    );
}

function OrderRow({ trade }: { trade: Trade }) {
    const meta = useEsunOrderMeta(trade);
    const working = isWorkingTrade(trade);
    const avail = orderActionAvailability(trade, meta);
    const id = trade.order.id;
    return (
        <li className={styles.row} data-testid='order-row' data-trade-id={id}>
            <OrderLines trade={trade} meta={meta} />
            {working && (
                <div className={styles.rowActions}>
                    {avail.price && (
                        <button type='button' className={styles.button.neutral} data-testid='order-price-button' onClick={() => openOrderAction(id, 'price')}>
                            改價
                        </button>
                    )}
                    {avail.qty && (
                        <button type='button' className={styles.button.neutral} data-testid='order-qty-button' onClick={() => openOrderAction(id, 'qty')}>
                            減量
                        </button>
                    )}
                    <button type='button' className={styles.button.danger} data-testid='order-cancel-button' onClick={() => openOrderAction(id, 'cancel')}>
                        刪單
                    </button>
                </div>
            )}
        </li>
    );
}

function AccountItem({ account, count }: { account: TradeAccount | null; count: number }) {
    const priv = usePrivacyMode();
    const route = useOrderRoute(account);
    return (
        <li>
            {account ? `${mobileAccountLabel(account, priv)}（${routeBadgeText(route)}）` : '帳戶未知'}：{fmtInt(count)} 筆
        </li>
    );
}

/** 全部刪單確認：列出筆數與涉及帳戶；滑動確認後才呼叫 cancelAllOrders() */
function CancelAllSheet({ open, working, onClose }: { open: boolean; working: Trade[]; onClose: () => void }) {
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<string | null>(null);
    const [resetKey, setResetKey] = useState(0);
    const busyRef = useRef(false);

    useEffect(() => {
        if (!open) {
            setFeedback(null);
            setResetKey(k => k + 1);
        }
    }, [open]);

    const groups = useMemo(() => {
        const map = new Map<string, { account: TradeAccount | null; count: number }>();
        for (const t of working) {
            const account = tradeAccountOf(t);
            const key = tradeAccountKey(account);
            const entry = map.get(key);
            if (entry) entry.count += 1;
            else map.set(key, { account, count: 1 });
        }
        return [...map.entries()];
    }, [working]);

    const confirm = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setFeedback(null);
        try {
            // 結果摘要（確認取消／未確認／未送出筆數）由 cancelAllOrders() 自行 notify
            await cancelAllOrders();
            onClose();
        } catch (err) {
            notify({ kind: 'err', ...mutationErrorNotice(err, '全部刪單') });
            if (isNotStarted(err)) {
                setFeedback(`未送出：${err instanceof Error ? err.message : String(err)}`);
                setResetKey(k => k + 1);
            } else {
                onClose(); // 結果未知：不自動重送、不提供重送鍵
            }
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };

    return (
        <BottomSheet open={open} onClose={onClose} dismissible={!busy} title='全部刪單' testId='cancel-all-sheet'>
            <div className={styles.sheetBody}>
                <p data-testid='cancel-all-count'>將刪除 <strong>{fmtInt(working.length)}</strong> 筆未成交委託，涉及 {fmtInt(groups.length)} 個帳戶：</p>
                <ul className={styles.accountList} data-testid='cancel-all-accounts'>
                    {groups.map(([key, g]) => <AccountItem key={key || 'unknown'} account={g.account} count={g.count} />)}
                </ul>
                <p className={styles.sub}>
                    全部刪單涵蓋所有可交易帳戶，不受帳戶篩選限制；送出前會先向券商重新讀取委託，實際筆數以券商資料為準。
                </p>
                {feedback && <p className={styles.notSent} role='alert' data-testid='cancel-all-feedback'>{feedback}</p>}
                <SlideToConfirm
                    label={`滑動確認 全部刪單（${working.length} 筆）`}
                    tone='danger'
                    testId='cancel-all-slide'
                    disabled={busy || working.length === 0}
                    disabledReason={busy ? '處理中…' : working.length === 0 ? '目前沒有未成交委託' : null}
                    resetKey={resetKey}
                    onConfirm={() => { void confirm(); }}
                />
                <button type='button' className={styles.button.neutral} disabled={busy} onClick={onClose}>取消</button>
            </div>
        </BottomSheet>
    );
}
