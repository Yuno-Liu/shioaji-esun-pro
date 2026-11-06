// src/mobile/routes/orders-page.tsx — 委託（規格 §6.5、§7.3）
//
// - 資料：useTradingState().trades（AccountedTrade，每列帶帳戶）；不自行輪詢（規格 §9.1）。
// - 分頁：[未成交 N]（ACTIVE_ORDER_STATUSES 且剩餘量 > 0，部分成交仍有剩餘也在這裡）［已成交］（同桌面：status Filled）［全部］
//   ［成交］（目前委託資料中的逐筆成交 status.deals，附合計）；帳戶篩選「全部」或單一帳戶。最新在前；「全部」時未成交置頂。
// - 商品一律「名稱為主、代碼為次」（TradeInstrument／TradeName；名稱來源與查詢次數見 lib/contract-names.ts）。
// - 委託列（OrderLines）：類別徽章、成交均價、成交進度條、已取消／原始委託量、券商訊息；點列開啟委託明細面板
//   （order-detail-sheet.tsx：完整欄位、成交時間軸、玉山中繼資料；改價／減量／刪單一樣經由委託操作面板）。
// - 對帳 banner：queries.orders.needsReconcile／reasons 以 RECONCILE_REASON_LABELS 顯示，附「對帳」鍵（＝更新）。
// - 「⟳ 更新」：reconcileOrdersOnce()（lib 的 refreshTradingState('orders') 可能回傳其他範圍進行中的讀取，
//   或在 1.5 秒冷卻內直接 resolve 而沒有讀委託；reconcileOrdersOnce 會等兩者結束後真的讀一次，絕不送出任何委託），
//   按下後 6 秒冷卻（玉山 refresh 5 秒間隔、10 次／分）；冷卻跨分頁切換保留。
// - 委託尚未讀到（queries.orders.updatedAt 為 null 且沒有任何委託）時顯示「委託載入中…」，不顯示「沒有委託」。
// - 每列的改價／減量／刪單只開委託操作面板（order-action-sheet.tsx，滑動確認後才呼叫 lib）；顯示規則同面板。
// - 全部刪單：有未成交時顯示；先開確認面板（筆數、涉及帳戶）滑動確認才呼叫 cancelAllOrders()。
//   cancelAllOrders() 會刪除所有可交易帳戶的未成交委託（不受帳戶篩選限制），面板照實列出全部帳戶。
// - 勾選批次刪單（未成交分頁的「選取」模式）：勾選 →「刪除已選（N 筆）」→ 確認面板列出筆數、帳戶與委託，滑動確認後
//   比照桌面 runBatchCancel 呼叫 cancelOrders(ids)（lib 依勾選順序對每筆呼叫 cancelOrder，同帳戶共用回讀確認）。
//   完成後面板列出每筆結果（失敗用 mutationErrorNotice 的用語）並 notify 彙總；結果未知不重送、不提供重送鍵。
//   與單筆刪單相同：不受 ResumeGate、LIVE 與風控鎖限制；送出中停用並鎖住面板。切換分頁或帳戶篩選時清除選取。
// - 版面（設計規格 §7.6，流程與 testid 不變）：PageHeader＋「⟳ 更新（N）」；Segmented 分頁；PopUpButton 帳戶；
//   對帳 InlineNote；委託列三行＋列上 Chip（與列主體為兄弟節點，只呼叫 openOrderAction）；
//   選取模式的工具列與「刪除已選」以 ShellSlot bottom 放在分頁列上方（測試原地渲染）；全部刪單留在列表尾端（不黏住）。
//   載入 Skeleton（保留「委託載入中…」）、空狀態 EmptyState；全部刪單／批次刪單面板為 GroupedSection＋footer 滑塊。

import { Inbox } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { mutationErrorNotice } from '../../components/esun-order-meta';
import { useEsunOrderMeta } from '../../lib/esun/account-details';
import { maskMoney, usePrivacyMode, usePrivacyMoney } from '../../lib/privacy';
import { cancelOrders } from '../../lib/shioaji';
import { cancelAllOrders, notify } from '../../lib/trade';
import { cancellationOutcome, cancellationSummary } from '../../lib/trade-mutations';
import { RECONCILE_REASON_LABELS, reconcileOrdersOnce, useTradingState } from '../../lib/trading-state';
import type { Trade } from '../../lib/types/order';
import { fmtInt, fmtPrice } from '../../lib/utils/format';
import { remainingWorkingOrderQuantity } from '../../lib/working-order-quantity';
import { mobileAccountLabel } from '../components/account-switch-sheet';
import { BottomSheet, SheetFooter } from '../components/bottom-sheet';
import {
    isWorkingTrade,
    orderActionAvailability,
    OrderLines,
    orderPriceText,
    orderTimeText,
    orderUnitOf,
    tradeAccountKey,
    tradeAccountOf,
    TradeInstrument,
    useTradeName,
    type TradeAccount,
} from '../components/order-action-sheet';
import { OrderDetailSheet } from '../components/order-detail-sheet';
import { routeBadgeText, useOrderRoute } from '../components/route-badge';
import { SlideToConfirm } from '../components/slide-to-confirm';
import { instrumentText } from '../lib/contract-names';
import { isNotStarted } from '../lib/errors';
import { openOrderAction } from '../lib/mobile-store';
import { collectDealRows, dealTotals, quantitiesText, type DealRow } from '../lib/order-fills';
import * as styles from '../styles/orders.css';
import { Chip } from '../ui/chip';
import { EmptyState } from '../ui/empty-state';
import { GroupedSection } from '../ui/grouped';
import { InlineNote } from '../ui/inline-note';
import { PageHeader } from '../ui/page-header';
import { PopUpButton } from '../ui/pop-up-button';
import { Segmented } from '../ui/segmented';
import { ShellSlot } from '../ui/shell-slots';
import { Skeleton } from '../ui/skeleton';

/** 「更新」冷卻（玉山委託查詢 refresh 5 秒最小間隔、10 次／分） */
export const ORDERS_REFRESH_COOLDOWN_MS = 6_000;

export type OrdersTab = 'working' | 'filled' | 'all' | 'deals';

export const ORDERS_TEXT = {
    loading: '委託載入中…',
    readFailed: '委託尚未讀取成功，請按「⟳ 更新」',
    none: '沒有委託',
    noneInTab: '此分頁沒有委託',
    noDeals: '目前沒有成交',
} as const;

/** 上次按「更新」的時間（模組層：切換分頁回來冷卻仍有效） */
let lastRefreshAt = Number.NEGATIVE_INFINITY;

/** 測試用：清除冷卻 */
export function resetOrdersRefreshCooldownForTest(): void {
    lastRefreshAt = Number.NEGATIVE_INFINITY;
}

/** 分類（同桌面 bottom-dock-orders.tsx 的 statusBucket；未成交另要求 ACTIVE 狀態） */
export function orderTabOf(trade: Trade): Exclude<OrdersTab, 'all' | 'deals'> | 'dead' {
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
    const [detailId, setDetailId] = useState<string | null>(null);
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
    const [batchOpen, setBatchOpen] = useState(false);
    const [batchBusy, setBatchBusy] = useState(false);
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

    // 切換分頁或帳戶篩選：清除選取並離開選取模式（同桌面：不讓被篩掉的委託以隱形選取殘留）
    useEffect(() => {
        setSelected(new Set());
        setSelecting(false);
    }, [tab, scopeKey]);

    const scoped = useMemo(
        () => (scopeKey ? trades.filter(t => tradeAccountKey(tradeAccountOf(t)) === scopeKey) : trades),
        [trades, scopeKey],
    );
    const workingCount = useMemo(() => scoped.filter(isWorkingTrade).length, [scoped]);
    const rows = useMemo(() => {
        if (tab === 'deals') return [];
        const newest = [...scoped].reverse();
        if (tab === 'all') return [...newest.filter(isWorkingTrade), ...newest.filter(t => !isWorkingTrade(t))];
        return newest.filter(t => orderTabOf(t) === tab);
    }, [scoped, tab]);
    const dealRows = useMemo(() => (tab === 'deals' ? collectDealRows(scoped) : []), [scoped, tab]);
    // 全部刪單＝所有帳戶的未成交（cancelAllOrders 不受篩選限制）
    const allWorking = useMemo(() => trades.filter(isWorkingTrade), [trades]);
    // 批次刪單的目標：目前仍在畫面上（未成交分頁）且已勾選的委託，依畫面順序
    const selectedTrades = useMemo(
        () => (tab === 'working' ? rows.filter(t => selected.has(t.order.id)) : []),
        [rows, selected, tab],
    );

    const toggle = useCallback((id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);
    const allSelected = tab === 'working' && rows.length > 0 && selectedTrades.length === rows.length;
    const exitSelecting = useCallback(() => {
        setSelected(new Set());
        setSelecting(false);
    }, []);
    // 選取中目前範圍的未成交全部成交或刪除：自動離開選取模式（否則「完成」隨工具列消失、「全部刪單」也被隱藏）。
    // 批次刪單面板開著或送出中不動，關閉面板後再判斷。
    useEffect(() => {
        if (selecting && tab === 'working' && rows.length === 0 && !batchBusy && !batchOpen) exitSelecting();
    }, [selecting, tab, rows.length, batchBusy, batchOpen, exitSelecting]);

    const tabs: { value: OrdersTab; label: string; testId: string }[] = [
        { value: 'working', label: `未成交 ${workingCount}`, testId: 'orders-tab-working' },
        { value: 'filled', label: '已成交', testId: 'orders-tab-filled' },
        { value: 'all', label: '全部', testId: 'orders-tab-all' },
        { value: 'deals', label: '成交', testId: 'orders-tab-deals' },
    ];
    const accountOptions = useMemo(
        () => [{ value: '', label: '帳戶：全部' }, ...accounts.map(a => ({ value: a.key, label: mobileAccountLabel(a.account, priv) }))],
        [accounts, priv],
    );
    const cooling = left > 0;
    const refreshLabel = cooling ? `⟳ 更新（${Math.ceil(left / 1_000)}）` : '⟳ 更新';
    // 委託還沒讀到：不能說「沒有委託」（讀取失敗時原因另由對帳 banner 顯示）
    const unread = query.updatedAt === null && trades.length === 0;
    const emptyText = unread
        ? (query.error ? ORDERS_TEXT.readFailed : ORDERS_TEXT.loading)
        : tab === 'deals' ? ORDERS_TEXT.noDeals : trades.length === 0 ? ORDERS_TEXT.none : ORDERS_TEXT.noneInTab;
    const showSelectToolbar = tab === 'working' && rows.length > 0;
    const selectingWorking = selecting && tab === 'working';
    // 讀取中顯示骨架（保留「委託載入中…」文字）；其他空狀態用 EmptyState（標題沿用常數與 testid）
    const empty = unread && !query.error
        ? <div className={styles.emptyWrap}><Skeleton label={emptyText} rows={4} testId='orders-empty' /></div>
        : <div className={styles.emptyWrap}><EmptyState icon={Inbox} title={emptyText} testId='orders-empty' /></div>;

    return (
        <section className={styles.page} data-testid='page-orders'>
            <PageHeader
                title='委託'
                actions={(
                    <button
                        type='button'
                        className={styles.refreshButton}
                        data-testid='orders-refresh'
                        disabled={cooling}
                        aria-label={cooling ? `更新委託（${Math.ceil(left / 1_000)} 秒後可再按）` : '更新委託'}
                        onClick={refresh}
                    >
                        {refreshLabel}
                    </button>
                )}
            />

            <div className={styles.tabsWrap}>
                <Segmented<OrdersTab>
                    semantics='tabs'
                    ariaLabel='委託狀態'
                    items={tabs}
                    value={tab}
                    disabled={batchBusy}
                    onChange={setTab}
                />
            </div>

            <div className={styles.filterRow}>
                <PopUpButton
                    className={styles.accountPicker}
                    ariaLabel='帳戶篩選'
                    testId='orders-account'
                    value={scopeKey}
                    options={accountOptions}
                    disabled={batchBusy}
                    onChange={setAccountKey}
                />
                {showSelectToolbar && !selectingWorking && (
                    <div className={styles.toolbar} data-testid='orders-select-toolbar'>
                        <span className={styles.toolbarText}>點委託列查看明細</span>
                        <button type='button' className={styles.textButton} data-testid='orders-select' onClick={() => setSelecting(true)}>
                            選取
                        </button>
                    </div>
                )}
            </div>

            {query.needsReconcile && (
                <div className={styles.noteWrap}>
                    <InlineNote
                        tone='warn'
                        role='status'
                        testId='orders-reconcile'
                        action={{ label: cooling ? `對帳（${Math.ceil(left / 1_000)}）` : '對帳', onClick: refresh, disabled: cooling }}
                    >
                        {query.reasons.map(r => RECONCILE_REASON_LABELS[r] ?? r).join('、') || '待對帳'}：委託可能不完整，請按「對帳」重新讀取後核對
                    </InlineNote>
                </div>
            )}

            {tab === 'deals' ? (
                dealRows.length === 0 ? empty : <DealsList rows={dealRows} onOpen={setDetailId} />
            ) : rows.length === 0 ? empty : (
                <ul className={styles.list}>
                    {rows.map(t => (
                        <OrderRow
                            key={t.order.id}
                            trade={t}
                            selecting={selectingWorking}
                            selected={selected.has(t.order.id)}
                            disabled={batchBusy}
                            onToggle={toggle}
                            onOpen={setDetailId}
                        />
                    ))}
                </ul>
            )}

            {/* 選取模式：工具列與「刪除已選」放在分頁列上方的配件槽（不在捲動容器內）；按下只開批次刪單面板（仍需滑動確認） */}
            {selectingWorking && (
                <ShellSlot slot='bottom'>
                    <div className={styles.selectBar}>
                        {showSelectToolbar && (
                            <div className={styles.selectBarRow} data-testid='orders-select-toolbar'>
                                <span className={styles.selectBarCount} data-testid='orders-selected-count'>
                                    已選 {fmtInt(selectedTrades.length)} 筆
                                </span>
                                <button
                                    type='button'
                                    className={styles.textButton}
                                    data-testid='orders-select-all'
                                    disabled={batchBusy}
                                    onClick={() => setSelected(allSelected ? new Set() : new Set(rows.map(t => t.order.id)))}
                                >
                                    {allSelected ? '全不選' : '全選'}
                                </button>
                                <button type='button' className={styles.textButton} data-testid='orders-select-done' disabled={batchBusy} onClick={exitSelecting}>
                                    完成
                                </button>
                            </div>
                        )}
                        <button
                            type='button'
                            className={styles.cancelSelectedButton}
                            data-testid='orders-cancel-selected'
                            disabled={selectedTrades.length === 0 || batchBusy}
                            onClick={() => setBatchOpen(true)}
                        >
                            刪除已選（{selectedTrades.length} 筆）
                        </button>
                    </div>
                </ShellSlot>
            )}

            {!selectingWorking && allWorking.length > 0 && tab !== 'deals' && (
                <div className={styles.footer}>
                    <button type='button' className={styles.cancelAllButton} data-testid='orders-cancel-all' onClick={() => setConfirmAll(true)}>
                        全部刪單（{allWorking.length} 筆）
                    </button>
                </div>
            )}

            <CancelAllSheet open={confirmAll} working={allWorking} onClose={() => setConfirmAll(false)} />
            <BatchCancelSheet
                open={batchOpen}
                targets={selectedTrades}
                onBusyChange={setBatchBusy}
                onSent={exitSelecting}
                onClose={() => setBatchOpen(false)}
            />
            <OrderDetailSheet tradeId={detailId} onClose={() => setDetailId(null)} />
        </section>
    );
}

interface OrderRowProps {
    trade: Trade;
    selecting: boolean;
    selected: boolean;
    disabled: boolean;
    onToggle: (id: string) => void;
    onOpen: (id: string) => void;
}

function OrderRow({ trade, selecting, selected, disabled, onToggle, onOpen }: OrderRowProps) {
    const meta = useEsunOrderMeta(trade);
    const working = isWorkingTrade(trade);
    const avail = orderActionAvailability(trade, meta);
    const id = trade.order.id;
    const sideText = trade.order.action === 'Buy' ? '買' : '賣';
    const label = instrumentText(trade.contract.code, useTradeName(trade));
    const showActions = working && !selecting;
    const main = (
        <button
            type='button'
            className={showActions ? `${styles.rowMain} ${styles.rowMainWithActions}` : styles.rowMain}
            data-testid='order-row-main'
            disabled={selecting && disabled}
            // 不用 aria-label：讓螢幕閱讀器讀出完整委託內容；選取模式以 aria-pressed 表示勾選狀態
            aria-pressed={selecting ? selected : undefined}
            title={selecting ? undefined : '查看委託明細'}
            onClick={() => (selecting ? onToggle(id) : onOpen(id))}
        >
            <OrderLines trade={trade} meta={meta} />
        </button>
    );
    return (
        <li className={styles.row} data-testid='order-row' data-trade-id={id} data-selected={selecting ? String(selected) : undefined}>
            {selecting ? (
                <div className={styles.rowSelectable}>
                    <label className={styles.checkHit}>
                        <input
                            type='checkbox'
                            className={styles.checkbox}
                            data-testid='order-select'
                            aria-label={`選取 ${label} ${sideText}`}
                            checked={selected}
                            disabled={disabled}
                            onChange={() => onToggle(id)}
                        />
                    </label>
                    {main}
                </div>
            ) : main}
            {/* 列上動作：與列主體為兄弟節點（不巢狀在按鈕內）；只開委託操作面板，送出仍需面板內滑動確認 */}
            {showActions && (
                <div className={styles.rowActions} role='group' aria-label={`${label} ${sideText} 委託操作`}>
                    {avail.price && <Chip label='改價' testId='order-price-button' onClick={() => openOrderAction(id, 'price')} />}
                    {avail.qty && <Chip label='減量' testId='order-qty-button' onClick={() => openOrderAction(id, 'qty')} />}
                    <Chip label='刪單' testId='order-cancel-button' className={styles.chipDanger} onClick={() => openOrderAction(id, 'cancel')} />
                </div>
            )}
        </li>
    );
}

// ---- 成交分頁 ----

function DealsList({ rows, onOpen }: { rows: DealRow[]; onOpen: (id: string) => void }) {
    const privMoney = usePrivacyMoney();
    const totals = useMemo(() => dealTotals(rows), [rows]);
    const money = (n: number) => maskMoney(fmtInt(Math.round(n)), privMoney);
    const anyUntimed = rows.some(r => r.ts <= 0);
    return (
        <>
            {anyUntimed && (
                <p className={`${styles.sheetNote} ${styles.noteWrap}`} data-testid='deals-sort-note'>
                    依成交時間新到舊；券商未提供成交時間的成交（玉山重新讀取後的逐筆、彙總）排在後面，依委託時間排列。
                </p>
            )}
            <ul className={styles.list} data-testid='deals-list'>
                {rows.map(r => <DealItem key={r.key} row={r} onOpen={onOpen} />)}
            </ul>
            <GroupedSection>
                <div className={styles.totals} data-testid='deals-totals'>
                    <span className={styles.totalsHead} data-testid='deals-total-count'>合計 {fmtInt(totals.count)} 筆</span>
                    <span data-testid='deals-total-buy'>
                        <span className={styles.side.Buy}>買進</span> {fmtInt(totals.Buy.count)} 筆 · {quantitiesText(totals.Buy.quantities, fmtInt)}
                        {totals.Buy.stockAmount > 0 && ` · 股票 ${money(totals.Buy.stockAmount)} 元`}
                    </span>
                    <span data-testid='deals-total-sell'>
                        <span className={styles.side.Sell}>賣出</span> {fmtInt(totals.Sell.count)} 筆 · {quantitiesText(totals.Sell.quantities, fmtInt)}
                        {totals.Sell.stockAmount > 0 && ` · 股票 ${money(totals.Sell.stockAmount)} 元`}
                    </span>
                    {(totals.hasDerivatives || totals.amountIncomplete) && (
                        <span className={styles.sub}>
                            {totals.hasDerivatives ? '金額只計股票（期貨、選擇權需契約乘數，未列入）。' : ''}
                            {totals.amountIncomplete ? '部分成交券商未提供逐筆價格，金額不完整。' : ''}
                        </span>
                    )}
                    <span className={styles.sub}>成交價金未含手續費與稅；以目前讀到的委託資料為準。</span>
                </div>
            </GroupedSection>
        </>
    );
}

function DealItem({ row, onOpen }: { row: DealRow; onOpen: (id: string) => void }) {
    const priv = usePrivacyMode();
    const t = row.trade;
    const account = tradeAccountOf(t);
    const sideText = t.order.action === 'Buy' ? '買' : '賣';
    const time = row.deal && !row.aggregate ? orderTimeText(row.ts) : '';
    // 玉山重新讀取後的逐筆成交：券商只給委託時間，不可當成交時間顯示
    const untimed = !!row.deal && !row.aggregate && row.ts <= 0;
    return (
        <li className={styles.row} data-testid='deal-row' data-trade-id={t.order.id}>
            <button
                type='button'
                className={styles.dealRow}
                title='查看委託明細'
                onClick={() => onOpen(t.order.id)}
            >
                {/* 精簡兩行：(買) 名稱 代碼 … 時間／價 × 量 單位 … 帳戶（方向膠囊以 CSS order 排在最前） */}
                <span className={styles.line}>
                    <TradeInstrument trade={t} testId='deal-instrument' />
                    <span className={styles.side[t.order.action === 'Buy' ? 'Buy' : 'Sell']} data-testid='deal-side'>{sideText}</span>
                    <span className={styles.lineEnd} data-testid='deal-time'>{time || '—'}</span>
                </span>
                <span className={styles.line}>
                    <span data-testid='deal-price'>
                        {row.price === null ? '價格未提供' : fmtPrice(row.price)} × {fmtInt(row.quantity)} {row.unit}
                    </span>
                    {row.aggregate && <span className={styles.sub}>{row.deal ? '（彙總）' : '（無逐筆明細）'}</span>}
                    {untimed && <span className={styles.sub} data-testid='deal-untimed'>（券商未提供成交時間）</span>}
                    <span className={styles.lineEnd} data-testid='deal-account'>{account ? mobileAccountLabel(account, priv) : '帳戶未知'}</span>
                </span>
            </button>
        </li>
    );
}

// ---- 確認面板 ----

/** 清單文字用的「名稱 代碼」（名稱載入前只有代碼） */
function TradeName({ trade }: { trade: Trade }) {
    return <span data-testid='trade-name'>{instrumentText(trade.contract.code, useTradeName(trade))}</span>;
}

function AccountItem({ account, count }: { account: TradeAccount | null; count: number }) {
    const priv = usePrivacyMode();
    const route = useOrderRoute(account);
    return (
        <li className={styles.accountItem}>
            {account ? `${mobileAccountLabel(account, priv)}（${routeBadgeText(route)}）` : '帳戶未知'}：{fmtInt(count)} 筆
        </li>
    );
}

function groupByAccount(trades: readonly Trade[]): [string, { account: TradeAccount | null; count: number }][] {
    const map = new Map<string, { account: TradeAccount | null; count: number }>();
    for (const t of trades) {
        const account = tradeAccountOf(t);
        const key = tradeAccountKey(account);
        const entry = map.get(key);
        if (entry) entry.count += 1;
        else map.set(key, { account, count: 1 });
    }
    return [...map.entries()];
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

    const groups = useMemo(() => groupByAccount(working), [working]);

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
                <p className={styles.sheetText} data-testid='cancel-all-count'>將刪除 <strong>{fmtInt(working.length)}</strong> 筆未成交委託，涉及 {fmtInt(groups.length)} 個帳戶：</p>
                <GroupedSection>
                    <ul className={styles.accountList} data-testid='cancel-all-accounts'>
                        {groups.map(([key, g]) => <AccountItem key={key || 'unknown'} account={g.account} count={g.count} />)}
                    </ul>
                </GroupedSection>
                <p className={styles.sheetNote}>
                    全部刪單涵蓋所有可交易帳戶，不受帳戶篩選限制；送出前會先向券商重新讀取委託，實際筆數以券商資料為準。
                </p>
                <SheetFooter>
                    <div className={styles.footerStack}>
                        {feedback && <InlineNote tone='danger' role='alert' testId='cancel-all-feedback'>{feedback}</InlineNote>}
                        <SlideToConfirm
                            label={`滑動確認 全部刪單（${working.length} 筆）`}
                            tone='danger'
                            testId='cancel-all-slide'
                            disabled={busy || working.length === 0}
                            disabledReason={busy ? '處理中…' : working.length === 0 ? '目前沒有未成交委託' : null}
                            resetKey={resetKey}
                            onConfirm={() => { void confirm(); }}
                        />
                        <button type='button' className={styles.sheetTextButton} disabled={busy} onClick={onClose}>取消</button>
                    </div>
                </SheetFooter>
            </div>
        </BottomSheet>
    );
}

/** 批次刪單每筆結果（面板顯示用） */
export interface BatchCancelItemResult {
    trade: Trade;
    tone: 'ok' | 'warn' | 'err';
    title: string;
    body?: string;
}

/** 每筆結果的用語：成功依 cancellationOutcome；失敗一律 mutationErrorNotice（未送出／失敗或結果未知、勿自動重送） */
export function batchCancelItemResult(trade: Trade, result: PromiseSettledResult<Trade>): BatchCancelItemResult {
    if (result.status === 'rejected') {
        const notice = mutationErrorNotice(result.reason, '刪單');
        return { trade, tone: isNotStarted(result.reason) ? 'warn' : 'err', title: notice.title, body: notice.body };
    }
    switch (cancellationOutcome(result.value)) {
        case 'confirmed': return { trade, tone: 'ok', title: '已確認取消' };
        case 'filled': return { trade, tone: 'warn', title: '已全部成交，無可取消' };
        case 'pending': return { trade, tone: 'err', title: '已送出未確認', body: '請手動更新委託核對，勿自動重送' };
        default: return { trade, tone: 'err', title: '結果未知', body: '請手動更新委託核對，勿自動重送' };
    }
}

interface BatchCancelSheetProps {
    open: boolean;
    /** 已勾選、仍在未成交的委託（畫面順序） */
    targets: Trade[];
    onBusyChange: (busy: boolean) => void;
    /** 已呼叫 lib（不論結果）：清除選取 */
    onSent: () => void;
    onClose: () => void;
}

/** 勾選批次刪單確認：列出筆數、帳戶與委託；滑動確認後呼叫 cancelOrders(ids)，完成後列出每筆結果（不提供重送） */
function BatchCancelSheet({ open, targets, onBusyChange, onSent, onClose }: BatchCancelSheetProps) {
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [results, setResults] = useState<{ items: BatchCancelItemResult[]; summary: string } | null>(null);
    const [feedback, setFeedback] = useState<string | null>(null);
    const [resetKey, setResetKey] = useState(0);
    const busyRef = useRef(false);

    useEffect(() => {
        if (!open) {
            setResults(null);
            setFeedback(null);
            setProgress(null);
            setResetKey(k => k + 1);
        }
    }, [open]);
    useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);

    const groups = useMemo(() => groupByAccount(targets), [targets]);

    const confirm = async () => {
        if (busyRef.current) return;
        // 送出當下仍在未成交的勾選委託（滑動期間成交或已刪的略過；lib 送出前也會再驗證）
        const batch = targets.filter(isWorkingTrade);
        if (batch.length === 0) {
            setFeedback('未送出：已選的委託都已不在未成交');
            setResetKey(k => k + 1);
            return;
        }
        busyRef.current = true;
        setBusy(true);
        setFeedback(null);
        setProgress({ done: 0, total: batch.length });
        try {
            const settled = await cancelOrders(
                batch.map(t => t.order.id),
                () => setProgress(p => (p ? { done: p.done + 1, total: p.total } : p)),
            );
            const summary = cancellationSummary(settled);
            notify({ title: '批次刪單結果', ...summary });
            setResults({ items: batch.map((t, i) => batchCancelItemResult(t, settled[i] ?? { status: 'rejected', reason: new Error('沒有回應') })), summary: summary.body });
            onSent();
        } catch (err) {
            // cancelOrders 以 allSettled 回報每筆；這裡只會是整批在送出前就失敗
            notify({ kind: 'err', ...mutationErrorNotice(err, '批次刪單') });
            if (isNotStarted(err)) {
                setFeedback(`未送出：${err instanceof Error ? err.message : String(err)}`);
                setResetKey(k => k + 1);
            } else {
                onSent();
                onClose(); // 結果未知：不自動重送、不提供重送鍵
            }
        } finally {
            busyRef.current = false;
            setBusy(false);
            setProgress(null);
        }
    };

    return (
        <BottomSheet open={open} onClose={onClose} dismissible={!busy} title='刪除已選委託' testId='batch-cancel-sheet'>
            <div className={styles.sheetBody}>
                {results ? (
                    <div className={`${styles.sheetBody} ${styles.fade}`}>
                        <p className={styles.sheetText} data-testid='batch-cancel-summary'>{results.summary}</p>
                        <GroupedSection>
                            <ul className={styles.resultList} data-testid='batch-cancel-results'>
                                {results.items.map(r => (
                                    <li key={r.trade.order.id} className={styles.resultItem} data-testid='batch-cancel-result' data-trade-id={r.trade.order.id} data-tone={r.tone}>
                                        <span>
                                            <TradeName trade={r.trade} /> {r.trade.order.action === 'Buy' ? '買' : '賣'} {orderPriceText(r.trade)} · 剩餘 {fmtInt(remainingWorkingOrderQuantity(r.trade))} {orderUnitOf(r.trade)}
                                        </span>
                                        <span className={r.tone === 'ok' ? styles.resultOk : r.tone === 'warn' ? styles.resultWarn : styles.resultErr}>{r.title}</span>
                                        {r.body && <span className={styles.sub}>{r.body}</span>}
                                    </li>
                                ))}
                            </ul>
                        </GroupedSection>
                        <SheetFooter>
                            <button type='button' className={styles.sheetTextButton} data-testid='batch-cancel-close' onClick={onClose}>關閉</button>
                        </SheetFooter>
                    </div>
                ) : (
                    <>
                        <p className={styles.sheetText} data-testid='batch-cancel-count'>將刪除已選的 <strong>{fmtInt(targets.length)}</strong> 筆未成交委託，涉及 {fmtInt(groups.length)} 個帳戶：</p>
                        <GroupedSection>
                            <ul className={styles.accountList} data-testid='batch-cancel-accounts'>
                                {groups.map(([key, g]) => <AccountItem key={key || 'unknown'} account={g.account} count={g.count} />)}
                            </ul>
                        </GroupedSection>
                        <GroupedSection>
                            <ul className={styles.resultList} data-testid='batch-cancel-targets'>
                                {targets.map(t => (
                                    <li key={t.order.id} className={styles.resultItem}>
                                        <span>
                                            <span className={styles.side[t.order.action === 'Buy' ? 'Buy' : 'Sell']}>{t.order.action === 'Buy' ? '買' : '賣'}</span>
                                            {' '}<TradeName trade={t} /> {orderPriceText(t)} · 剩餘 {fmtInt(remainingWorkingOrderQuantity(t))} {orderUnitOf(t)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </GroupedSection>
                        <p className={styles.sheetNote}>每筆刪單送出後以券商回讀確認結果；若委託其實已成交，刪單不會成立。結果未知的委託請手動更新核對，勿重送。</p>
                        <SheetFooter>
                            <div className={styles.footerStack}>
                                {progress && <p className={styles.sheetNote} role='status' data-testid='batch-cancel-progress'>處理中… {fmtInt(progress.done)}／{fmtInt(progress.total)}</p>}
                                {feedback && <InlineNote tone='danger' role='alert' testId='batch-cancel-feedback'>{feedback}</InlineNote>}
                                <SlideToConfirm
                                    label={`滑動確認 刪除已選（${targets.length} 筆）`}
                                    tone='danger'
                                    testId='batch-cancel-slide'
                                    disabled={busy || targets.length === 0}
                                    disabledReason={busy ? '處理中…' : targets.length === 0 ? '沒有已選的未成交委託' : null}
                                    resetKey={resetKey}
                                    onConfirm={() => { void confirm(); }}
                                />
                                <button type='button' className={styles.sheetTextButton} disabled={busy} onClick={onClose}>取消</button>
                            </div>
                        </SheetFooter>
                    </>
                )}
            </div>
        </BottomSheet>
    );
}
