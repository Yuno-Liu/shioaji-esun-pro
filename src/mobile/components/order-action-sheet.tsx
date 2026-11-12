// src/mobile/components/order-action-sheet.tsx — 委託操作面板：改價／減量／刪單（規格 §6.5、§7.2、§7.3）
//
// 介面：無 props、掛在 App 根層；目標委託來自 mobile-store 的 `orderAction`
// （openOrderAction(tradeId, 'menu'|'price'|'qty'|'cancel')／closeOrderAction()）。委託頁與交易圖表的委託線都經由 openOrderAction 開啟。
// - 動作顯示規則與實際呼叫的 lib 函式以桌面 src/components/bottom-dock-orders.tsx 為準：
//   改價＝canUpdateOrderPrice()（限價、非零股）且非玉山預約單，玉山另以 validateEsunOrderPriceMutation() 檢查新價格；
//   減量＝剩餘量 ≥ 2 且非玉山預約單，輸入「新的剩餘數量」n，送出 updateOrderQty(tradeId, 剩餘 − n)；
//   刪單＝一律提供（不因玉山 celable 提示隱藏），cancelOrder(tradeId)。
// - 每個動作都必須 SlideToConfirm 滑動完成才呼叫 lib；進行中停用並鎖住面板（不可關閉）。
//   lib 的改價／減量沒有逾時：處理超過 ORDER_ACTION_SLOW_MS 仍未結束時解除鎖定（可關閉面板）並提示結果未確認、勿重送。
//   不重送、不提前釋放 lib 的鎖或計數；關閉後 promise 結束時只發通知，不更新已卸載的元件、不關閉之後開啟的另一個面板。
//   同一筆委託仍有未結束的操作時（面板關閉後重新開啟），改價、減量、刪單一律停用並說明。
// - 改價、減量：按鈕在 useTradingLive() 為 false 或 ResumeGate 不允許時停用並說明；滑動完成後、呼叫 lib 前
//   再同步檢查 assertResumeReady({ allowStale: staleAcknowledged }) 與 assertTradingLive()，丟出就顯示「未送出」且不呼叫 lib。
//   刪單不受 ResumeGate、LIVE 與風控鎖限制（降低風險的動作；桌面刪單同樣不要求 LIVE）。
// - 結果：成功 notify；失敗一律 notify({ kind: 'err', ...mutationErrorNotice(err, verb) })。
//   「未送出」（mutationNotStarted）面板保留可修改後重試；其餘＝結果未知，關閉面板，不自動重送、不提供重送鍵。
// - 面板開啟期間該委託已不在未成交（成交或已刪）時，顯示「此委託已不在未成交」並停用所有動作。
// - OrderLines（委託頁列、本面板摘要共用）：商品（TradeInstrument：名稱為主、代碼為次；名稱來源見 lib/contract-names.ts）、
//   類別徽章、成交均價、成交進度條、已取消／原始委託量、券商訊息（遮蔽身分證號）。
// - 版面（設計規格 §7.5，流程不變）：頂部 GroupedSection 摘要 → 選單 ListRow（改價／減量／刪單，按鈕文字恰為動作名，
//   不可用原因在按鈕外）或子畫面（Stepper）→ 固定 footer：未送出回饋＋SlideToConfirm（改價、減量 neutral；刪單 danger）＋「返回」。
//   kind 為 price／qty／cancel 時直接進入對應子畫面。樣式在 styles/order-action.css.ts（OrderLines 仍用 orders.css.ts）。

import { Minus, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { mutationErrorNotice, isEsunReservationTrade } from '../../components/esun-order-meta';
import { useTradingLive } from '../../hooks/use-stream';
import { ensureContract, useContract } from '../../lib/contracts-cache';
import { useEsunOrderMeta, type EsunOrderMeta } from '../../lib/esun/account-details';
import { isEsunBroker, validateEsunOrderPriceMutation } from '../../lib/esun/order-mapping';
import { canUpdateOrderPrice, isOddLot, lotLabel, orderQtyUnit } from '../../lib/odd-lot';
import { octypeLabel, PRICE_TYPE_LABEL } from '../../lib/order-conditions';
import { orderStatusLabel } from '../../lib/order-status-label';
import { usePrivacyMode } from '../../lib/privacy';
import { cancelOrder, updateOrderPrice, updateOrderQty } from '../../lib/shioaji';
import { assertTradingLive, notify } from '../../lib/trade';
import { cancellationSummary, maskIdentifiers } from '../../lib/trade-mutations';
import { useTradingState } from '../../lib/trading-state';
import type { ContractBase, ContractInfo } from '../../lib/types/contract';
import { ACTIVE_ORDER_STATUSES, type AccountedTrade, type FuturesPriceType, type Trade } from '../../lib/types/order';
import type { Account } from '../../lib/types/portfolio';
import { fmtInt, fmtPrice } from '../../lib/utils/format';
import { roundToTick, stepPrice } from '../../lib/utils/ticksize';
import { remainingWorkingOrderQuantity } from '../../lib/working-order-quantity';
import { useResumeGate } from '../hooks/use-resume-gate';
import { instrumentText, useContractName } from '../lib/contract-names';
import { isNotStarted, notStarted } from '../lib/errors';
import { avgFillPrice, avgPriceDigits, fillProgress, orderBadges } from '../lib/order-fills';
import { closeOrderAction, getMobileUi, useMobileUi, type OrderActionKind } from '../lib/mobile-store';
import { resumeAllowsNewOrders } from '../lib/resume-gate';
import { acknowledgeStaleData, assertResumeReady, getResumeGate, retryResume, type ResumeGateSnapshot } from '../lib/resume-gate-runtime';
import { assertNoEnvSwitch } from '../lib/trading-activity';
import * as a from '../styles/order-action.css';
import * as styles from '../styles/orders.css';
import { focusRing, pressable } from '../styles/primitives.css';
import { ProgressBar } from '../ui/bars';
import { GroupedSection, ListRow, ValueRow } from '../ui/grouped';
import { InlineNote } from '../ui/inline-note';
import { Stepper } from '../ui/stepper';
import { mobileAccountLabel } from './account-switch-sheet';
import { BottomSheet, SheetFooter } from './bottom-sheet';
import { routeBadgeText, useRowRoute } from './route-badge';
import { SlideToConfirm } from './slide-to-confirm';

// ---- 共用規則（委託頁 routes/orders-page.tsx 也使用）----

export const ORDER_ACTION_TEXT = {
    gone: '此委託已不在未成交（可能已成交或已刪單），無法再操作',
    notFound: '找不到這筆委託，請到委託頁按「更新」後再試',
    notLive: '行情非 LIVE 或交易狀態未連線，暫停改價／減量（刪單不受影響）',
    resyncing: '回到前景，正在重新同步行情與委託，暫停改價／減量（刪單不受影響）',
    stale: '委託／持倉資料可能過期：請按「重試」，或勾選「我了解資料可能過期」後再改價／減量',
    failed: '連線未恢復，請重新整理頁面後再改價／減量（刪單不受影響）',
    noPrice: '此委託不提供改價（市價、零股或玉山預約單）；可刪單後重新下單',
    noQty: '此委託不提供減量（剩餘量不足 2 或玉山預約單）；全部取消請使用刪單',
    priceInvalid: '請輸入有效的正數價格',
    priceTick: '價格不符合升降單位',
    priceSame: '新價格與目前委託價相同',
    busy: '處理中…',
    slow: '處理超過 20 秒仍未完成：結果未確認，請到委託頁核對，勿重送（可關閉此面板）',
    unsettled: '這筆委託上一次的改價／減量／刪單仍在處理，結果未確認，請到委託頁核對，勿重送',
} as const;

/** 改價、減量、刪單處理超過這個時間仍未結束：允許關閉面板並提示結果未確認 */
export const ORDER_ACTION_SLOW_MS = 20_000;

// 已送出但尚未結束的操作（依委託 id 計數）：面板關閉後 promise 仍在進行，重新開啟同一筆委託時據此停用所有動作，避免重送。
// promise 結束（成功、失敗或結果未知）時在 finally 歸零；重新整理頁面會清空
const unsettled = new Map<string, number>();
const unsettledListeners = new Set<() => void>();
const unsettledChanged = () => unsettledListeners.forEach(l => l());

function trackUnsettled(tradeId: string): () => void {
    unsettled.set(tradeId, (unsettled.get(tradeId) ?? 0) + 1);
    unsettledChanged();
    let done = false;
    return () => {
        if (done) return;
        done = true;
        const n = (unsettled.get(tradeId) ?? 1) - 1;
        if (n > 0) unsettled.set(tradeId, n);
        else unsettled.delete(tradeId);
        unsettledChanged();
    };
}

function subscribeUnsettled(listener: () => void): () => void {
    unsettledListeners.add(listener);
    return () => { unsettledListeners.delete(listener); };
}

function useUnsettled(tradeId: string): boolean {
    return useSyncExternalStore(subscribeUnsettled, () => unsettled.has(tradeId), () => unsettled.has(tradeId));
}

/** 「未成交」＝ACTIVE_ORDER_STATUSES 且剩餘量 > 0（部分成交仍有剩餘的委託也算） */
export function isWorkingTrade(trade: Trade): boolean {
    return ACTIVE_ORDER_STATUSES.has(trade.status.status) && remainingWorkingOrderQuantity(trade) > 0;
}

export function isFuturesTrade(trade: Pick<Trade, 'contract'>): boolean {
    const st = trade.contract.security_type;
    return st === 'FUT' || st === 'OPT';
}

/** 委託列的帳戶（fan-out 標籤優先，其次 order.account） */
export type TradeAccount = Pick<Account, 'broker_id' | 'account_id'> & { account_type?: string };
export function tradeAccountOf(trade: Trade): TradeAccount | null {
    const tagged = (trade as AccountedTrade).account;
    if (tagged?.broker_id && tagged.account_id) return tagged;
    const oa = trade.order.account;
    return oa?.broker_id && oa.account_id ? oa : null;
}

export function tradeAccountKey(account: TradeAccount | null): string {
    return account ? `${account.broker_id}-${account.account_id}` : '';
}

export interface OrderActionAvailability {
    price: boolean;
    qty: boolean;
    /** 刪單一律提供 */
    cancel: true;
}

/** 依 §6.5 表格：改價＝限價、非零股、非玉山預約單；減量＝剩餘量 ≥ 2、非玉山預約單；刪單一律 */
export function orderActionAvailability(trade: Trade, meta: EsunOrderMeta | null): OrderActionAvailability {
    const reservation = isEsunReservationTrade(trade, meta);
    return {
        price: canUpdateOrderPrice(trade.order) && !reservation,
        qty: remainingWorkingOrderQuantity(trade) >= 2 && !reservation,
        cancel: true,
    };
}

/** 減量：輸入「新的剩餘數量」n → 送出的減少量（同桌面 bottom-dock-orders.tsx） */
export function qtyReduction(remaining: number, newRemaining: number): number {
    return remaining - newRemaining;
}

/** 「新的剩餘數量」檢查：1 ≤ n < 剩餘（全部取消請用刪單）；用語同桌面 */
export function newRemainingProblem(n: number, remaining: number): string | null {
    if (Number.isInteger(n) && n > 0 && n < remaining) return null;
    return `新的剩餘數量必須是大於 0 且小於目前剩餘 ${remaining} 的整數；全部取消請使用刪單`;
}

type PriceContract = ContractBase & Partial<Pick<ContractInfo, 'limit_up' | 'limit_down' | 'tick_rule' | 'tick' | 'underlying_kind'>>;

/** 目前委託價：modified_price 優先 */
export function currentOrderPrice(trade: Trade): number {
    return trade.status.modified_price || trade.order.price;
}

/** 新價格檢查：正數、符合升降單位、股票在漲跌停內、與目前價格不同；玉山再以 validateEsunOrderPriceMutation 檢查 */
export function priceProblem(trade: Trade, contract: PriceContract, price: number): string | null {
    if (!Number.isFinite(price) || price <= 0) return ORDER_ACTION_TEXT.priceInvalid;
    if (Math.abs(roundToTick(contract, price) - price) > 1e-6) return ORDER_ACTION_TEXT.priceTick;
    if (!isFuturesTrade(trade)) {
        const up = Number(contract.limit_up);
        const down = Number(contract.limit_down);
        if (up > 0 && down > 0 && (price > up + 1e-6 || price < down - 1e-6)) {
            return `超出漲跌停範圍（跌停 ${fmtPrice(down)}～漲停 ${fmtPrice(up)}）`;
        }
    }
    if (Math.abs(price - currentOrderPrice(trade)) < 1e-6) return ORDER_ACTION_TEXT.priceSame;
    if (isEsunBroker(tradeAccountOf(trade)?.broker_id)) return validateEsunOrderPriceMutation(trade, price);
    return null;
}

/** 改價／減量的停用原因（ResumeGate 不允許或非 LIVE）；允許時回傳 null */
export function mutationGateReason(live: boolean, gate: Pick<ResumeGateSnapshot, 'state' | 'staleAcknowledged'>): string | null {
    if (!resumeAllowsNewOrders(gate.state, gate.staleAcknowledged)) {
        if (gate.state === 'resyncing') return ORDER_ACTION_TEXT.resyncing;
        if (gate.state === 'stale-data') return ORDER_ACTION_TEXT.stale;
        return ORDER_ACTION_TEXT.failed;
    }
    return live ? null : ORDER_ACTION_TEXT.notLive;
}

const COND_LABEL: Record<string, string> = {
    MarginTrading: '融資',
    ShortSelling: '融券',
    SBLShort: '借券賣出',
    SBLShortPriceExempt: '借券賣出（豁免）',
};

/** 「整股 · 限價 ROD」「盤中零股 · 限價 ROD」「新倉 · 限價 ROD」 */
export function orderConditionText(trade: Trade): string {
    const o = trade.order;
    const parts: string[] = [];
    if (isFuturesTrade(trade)) {
        if (o.octype && o.octype !== 'Auto') parts.push(octypeLabel(o.octype));
    } else {
        parts.push(lotLabel(o.order_lot || 'Common'));
        if (o.order_cond && COND_LABEL[o.order_cond]) parts.push(COND_LABEL[o.order_cond]!);
        if (o.daytrade_short) parts.push('當沖先賣');
    }
    const pt = (o.price_type ?? 'LMT') as FuturesPriceType;
    parts.push([PRICE_TYPE_LABEL[pt] ?? pt, o.order_type].filter(Boolean).join(' '));
    return parts.join(' · ');
}

/** 價格欄：modified_price 優先；市價（無價格）顯示「市價」（同桌面） */
export function orderPriceText(trade: Trade): string {
    const pt = (trade.order.price_type ?? 'LMT') as FuturesPriceType;
    const p = currentOrderPrice(trade);
    if (pt !== 'LMT' && !p) return PRICE_TYPE_LABEL[pt] ?? '市價';
    return fmtPrice(p);
}

export function orderUnitOf(trade: Trade): string {
    return orderQtyUnit(isFuturesTrade(trade), trade.order.order_lot);
}

/** 委託時間（台北）：今天 'HH:MM:SS'，其他日 'MM/DD HH:MM:SS'；order_ts 為秒（或毫秒） */
export function orderTimeText(ts: number | undefined, now = Date.now()): string {
    if (!ts || !Number.isFinite(ts) || ts <= 0) return '';
    const ms = ts > 1e12 ? ts : ts * 1000;
    const iso = new Date(ms + 8 * 3600_000).toISOString();
    const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
    const time = iso.slice(11, 19);
    return iso.slice(0, 10) === today ? time : `${iso.slice(5, 7)}/${iso.slice(8, 10)} ${time}`;
}

/** 玉山預約日 'MM/DD'（沒有預約或沒有日期回 null） */
export function esunReservationText(meta: EsunOrderMeta | null): string | null {
    if (!meta?.reservation) return null;
    return meta.workDate ? `預約 ${meta.workDate.slice(5).replace('-', '/')}` : '預約';
}

/** 成交均價文字（沒有逐筆成交回 null） */
export function avgFillText(trade: Trade): string | null {
    const avg = avgFillPrice(trade);
    return avg === null ? null : fmtPrice(avg, avgPriceDigits(avg));
}

/** 券商狀態訊息（遮蔽身分證號與帳號長度的數字）；空白回 null */
export function orderMessageText(trade: Trade): string | null {
    const raw = typeof trade.status.msg === 'string' ? trade.status.msg.trim() : '';
    return raw ? maskIdentifiers(raw) : null;
}

/** 委託類別徽章（價別、效期、倉別、當沖、零股、信用）；文字徽章，不只靠顏色 */
export function OrderBadges({ trade }: { trade: Trade }) {
    return (
        <span className={styles.badges} data-testid='order-badges'>
            {orderBadges(trade).map(b => (
                <span key={`${b.kind}-${b.label}`} className={styles.badge[b.kind]} data-badge={b.kind}>{b.label}</span>
            ))}
        </span>
    );
}

/** 成交進度條（成交量 ÷ 減量後的委託量）；數字另有文字。填色以 ProgressBar 的 scaleX 呈現（不做 width 轉場） */
export function FillBar({ trade }: { trade: Trade }) {
    const p = fillProgress(trade);
    const unit = orderUnitOf(trade);
    const pct = Math.round(p.ratio * 100);
    return (
        <span
            className={a.progress}
            role='progressbar'
            aria-label={`成交進度 ${fmtInt(p.filled)}／${fmtInt(p.effective)} ${unit}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            data-testid='order-progress'
        >
            <ProgressBar percent={pct} tone={p.ratio >= 1 ? 'success' : 'amber'} />
        </span>
    );
}

/** 委託的商品名稱（trade.contract.name 優先，其次合約快取；沒有回 null） */
export function useTradeName(trade: Pick<Trade, 'contract'> | null): string | null {
    return useContractName(trade?.contract.code ?? null, trade?.contract.name, trade?.contract.security_type ?? undefined);
}

/**
 * 商品（名稱為主、代碼為次，同自選列；委託列、成交列、明細標頭共用）。
 * 名稱載入前只顯示代碼；單行省略號，名稱到達時列高不變。
 */
export function TradeInstrument({ trade, testId = 'order-instrument' }: { trade: Pick<Trade, 'contract'>; testId?: string }) {
    const name = useTradeName(trade);
    const code = trade.contract.code;
    return (
        <span className={styles.instrument} data-testid={testId} data-name={name ?? undefined}>
            <span className={styles.instrumentName}>{name ?? code}</span>
            {name && <span className={styles.instrumentCode}>{code}</span>}
        </span>
    );
}

/** 委託內容（委託頁列與操作面板摘要共用；全部用 span，可放在按鈕內） */
export function OrderLines({ trade, meta }: { trade: Trade; meta: EsunOrderMeta | null }) {
    const priv = usePrivacyMode();
    const account = tradeAccountOf(trade);
    // 該筆委託帳戶自己的環境（切換後殘留的舊環境委託不標成目前環境）
    const route = useRowRoute(account);
    const remaining = remainingWorkingOrderQuantity(trade);
    const unit = orderUnitOf(trade);
    const sideText = trade.order.action === 'Buy' ? '買' : '賣';
    const time = orderTimeText(trade.status.order_ts);
    const reservation = esunReservationText(meta);
    const ordNo = trade.order.ordno || trade.order.seqno;
    const progress = fillProgress(trade);
    const avg = avgFillText(trade);
    const message = orderMessageText(trade);
    return (
        <>
            <span className={styles.line}>
                <TradeInstrument trade={trade} />
                <span className={styles.side[trade.order.action === 'Buy' ? 'Buy' : 'Sell']} data-testid='order-side'>{sideText}</span>
                <OrderBadges trade={trade} />
            </span>
            <span className={styles.line}>
                <span data-testid='order-price'>{orderPriceText(trade)} × {fmtInt(trade.order.quantity)} {unit}</span>
                <span className={styles.sub} data-testid='order-fill'>
                    成交 {fmtInt(trade.status.deal_quantity)} · 剩餘 {fmtInt(remaining)}
                </span>
                {avg && <span className={styles.sub} data-testid='order-avg'>均價 {avg}</span>}
                <span className={styles.status}>{orderStatusLabel(trade.status.status)}</span>
            </span>
            {(progress.filled > 0 || progress.cancelled > 0) && (
                <span className={styles.line}>
                    {progress.filled > 0 && <FillBar trade={trade} />}
                    {progress.cancelled > 0 && (
                        <span className={styles.sub} data-testid='order-cancelled'>
                            已取消 {fmtInt(progress.cancelled)} · 原始委託 {fmtInt(progress.original)} {unit}
                            {remaining > 0 ? `（減量後 ${fmtInt(progress.effective)}）` : ''}
                        </span>
                    )}
                </span>
            )}
            {message && <span className={styles.msg} data-testid='order-msg'>訊息：{message}</span>}
            <span className={styles.line}>
                <span className={styles.sub} data-testid='order-route'>
                    {route ? routeBadgeText(route) : '帳戶未知'}
                    {account ? ` · ${mobileAccountLabel(account, priv)}` : ''}
                </span>
                {reservation && <span className={styles.reservation} data-testid='order-reservation'>{reservation}</span>}
                {time && <span className={styles.sub}>{time}</span>}
                {ordNo && <span className={styles.sub}>書號 {ordNo}</span>}
            </span>
        </>
    );
}

// ---- 面板 ----

type Verb = '改價' | '改量' | '刪單';

export function OrderActionSheet() {
    const { orderAction } = useMobileUi();
    const { trades } = useTradingState();
    const [busy, setBusy] = useState(false);
    const found = orderAction ? trades.find(t => t.order.id === orderAction.tradeId) ?? null : null;
    // 委託已從清單消失時保留最後看到的內容作為摘要
    const lastSeen = useRef<{ id: string; trade: Trade } | null>(null);
    if (found) lastSeen.current = { id: found.order.id, trade: found };
    const trade = found ?? (orderAction && lastSeen.current?.id === orderAction.tradeId ? lastSeen.current.trade : null);

    useEffect(() => { if (!orderAction) setBusy(false); }, [orderAction]);

    // 標題（對話框名稱）含名稱與代碼，與委託明細面板一致；只影響顯示
    const name = useTradeName(trade);
    const title = trade ? `委託操作 ${instrumentText(trade.contract.code, name)}` : '委託操作';
    return (
        <BottomSheet open={orderAction !== null} onClose={closeOrderAction} dismissible={!busy} title={title} testId='order-action-sheet'>
            {orderAction && (trade
                ? <ActionBody key={orderAction.seq} kind={orderAction.kind} trade={trade} working={!!found && isWorkingTrade(found)} onBusyChange={setBusy} />
                : <InlineNote tone='warn' role='status'>{ORDER_ACTION_TEXT.notFound}</InlineNote>)}
        </BottomSheet>
    );
}

interface MutationRunner {
    /** 本面板的操作進行中，或同一筆委託仍有未結束的操作（面板關閉前送出的） */
    busy: boolean;
    /** 本面板的操作已處理超過 ORDER_ACTION_SLOW_MS */
    slow: boolean;
    /** 同一筆委託有面板關閉前送出、尚未結束的操作（不是本面板這一次） */
    unsettledElsewhere: boolean;
    resetKey: number;
    /** 「未送出：…」；null＝無 */
    feedback: string | null;
    run: <T>(verb: Verb, call: () => Promise<T>, onOk: (value: T) => void, opts: { gated: boolean }) => Promise<void>;
}

function useMutationRunner(onBusyChange: (busy: boolean) => void, account: TradeAccount | null, tradeId: string): MutationRunner {
    const [busy, setBusy] = useState(false);
    const [slow, setSlow] = useState(false);
    const [resetKey, setResetKey] = useState(0);
    const [feedback, setFeedback] = useState<string | null>(null);
    const busyRef = useRef(false);
    const mounted = useRef(true);
    const unsettledNow = useUnsettled(tradeId);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    // 面板鎖定：進行中且尚未超過 ORDER_ACTION_SLOW_MS（超過後可關閉面板；送出本身不中止）
    useEffect(() => { onBusyChange(busy && !slow); }, [busy, slow, onBusyChange]);
    useEffect(() => () => onBusyChange(false), [onBusyChange]);

    const notSent = (err: unknown) => {
        if (!mounted.current) return; // 面板已關閉：mutationErrorNotice 的通知已告知
        setFeedback(`未送出：${err instanceof Error ? err.message : String(err)}`);
        setResetKey(k => k + 1); // 滑動確認重新啟用，修改後可再試
    };

    const run: MutationRunner['run'] = async (verb, call, onOk, opts) => {
        // 同一筆委託仍有未結束的操作（面板關閉前送出的）：不送
        if (busyRef.current || unsettled.has(tradeId)) return;
        setFeedback(null);
        // 玉山環境切換中：玉山委託的改價、減量、刪單一律不送（含不受 ResumeGate 限制的刪單）；永豐照常
        try {
            assertNoEnvSwitch(account);
        } catch (err) {
            notSent(err);
            return;
        }
        if (opts.gated) {
            // 滑動完成後、呼叫 lib 前同步再檢查一次（期間可能切到背景或斷線）
            try {
                assertResumeReady({ allowStale: getResumeGate().staleAcknowledged });
                assertTradingLive();
            } catch (err) {
                notSent(err);
                return;
            }
        }
        busyRef.current = true;
        setBusy(true);
        // 只關閉這一次開啟的面板：逾時後使用者可能已關閉並開啟另一筆委託的面板
        const seq = getMobileUi().orderAction?.seq;
        const closeThis = () => { if (seq !== undefined && getMobileUi().orderAction?.seq === seq) closeOrderAction(); };
        const settled = trackUnsettled(tradeId);
        const slowTimer = setTimeout(() => { if (mounted.current) setSlow(true); }, ORDER_ACTION_SLOW_MS);
        try {
            const value = await call();
            onOk(value);
            closeThis();
        } catch (err) {
            notify({ kind: 'err', ...mutationErrorNotice(err, verb) });
            // 確定未送出：面板保留可修改後重試；結果未知：關閉面板，不自動重送、不提供重送鍵
            if (isNotStarted(err)) notSent(err);
            else closeThis();
        } finally {
            clearTimeout(slowTimer);
            settled();
            busyRef.current = false;
            if (mounted.current) {
                setBusy(false);
                setSlow(false);
            }
        }
    };

    const unsettledElsewhere = unsettledNow && !busy;
    return { busy: busy || unsettledNow, slow: busy && slow, unsettledElsewhere, resetKey, feedback, run };
}

/** 「未送出」回饋（role=alert；只分未送出，結果未知已關閉面板並通知） */
function NotSentNote({ text }: { text: string }) {
    return <InlineNote tone='danger' role='alert' testId='order-action-feedback'>{text}</InlineNote>;
}

/** 子畫面的固定 footer：回饋 → 滑動確認 → 「返回」（測試與無 portal 時原地渲染） */
function ActionFooter({ feedback, busy, onBack, children }: { feedback: string | null; busy: boolean; onBack: () => void; children?: ReactNode }) {
    return (
        <SheetFooter>
            <div className={a.footerStack}>
                {feedback && <NotSentNote text={feedback} />}
                {children}
                <button type='button' className={`${a.backButton} ${pressable} ${focusRing}`} disabled={busy} onClick={onBack}>
                    返回
                </button>
            </div>
        </SheetFooter>
    );
}

function ActionBody({ kind, trade, working, onBusyChange }: { kind: OrderActionKind; trade: Trade; working: boolean; onBusyChange: (busy: boolean) => void }) {
    const [view, setView] = useState<OrderActionKind>(kind);
    const meta = useEsunOrderMeta(trade);
    const live = useTradingLive();
    const gate = useResumeGate();
    const runner = useMutationRunner(onBusyChange, tradeAccountOf(trade), trade.order.id);
    const avail = orderActionAvailability(trade, meta);
    const gateReason = mutationGateReason(live, gate);
    const { busy } = runner;
    const back = () => setView('menu');
    const editDisabled = busy || !working || !!gateReason;

    return (
        <div className={a.body} data-testid='order-action-body' data-view={view}>
            <GroupedSection testId='order-action-summary'>
                <div className={a.summary}>
                    <OrderLines trade={trade} meta={meta} />
                </div>
            </GroupedSection>
            {!working && <InlineNote tone='warn' role='status' testId='order-action-gone'>{ORDER_ACTION_TEXT.gone}</InlineNote>}
            {runner.slow && <InlineNote tone='warn' role='alert' testId='order-action-slow'>{ORDER_ACTION_TEXT.slow}</InlineNote>}
            {runner.unsettledElsewhere && <InlineNote tone='warn' role='status' testId='order-action-unsettled'>{ORDER_ACTION_TEXT.unsettled}</InlineNote>}

            {view === 'menu' && (
                <>
                    <div role='group' aria-label='委託操作'>
                        <GroupedSection>
                            {avail.price && (
                                <ListRow title='改價' leading={<Pencil className={a.rowIcon} />} chevron disabled={editDisabled} onClick={() => setView('price')} />
                            )}
                            {avail.qty && (
                                <ListRow title='減量' leading={<Minus className={a.rowIcon} />} chevron disabled={editDisabled} onClick={() => setView('qty')} />
                            )}
                            <div className={a.dangerRow}>
                                <ListRow title='刪單' leading={<Trash2 className={a.rowIconDanger} />} chevron disabled={busy || !working} onClick={() => setView('cancel')} />
                            </div>
                        </GroupedSection>
                    </div>
                    {working && (avail.price || avail.qty) && gateReason && <GateNote reason={gateReason} gate={gate} busy={busy} />}
                    {runner.feedback && <NotSentNote text={runner.feedback} />}
                </>
            )}

            {view === 'price' && (avail.price
                ? <PriceForm trade={trade} working={working} gateReason={gateReason} gate={gate} runner={runner} onBack={back} />
                : (
                    <>
                        <p className={a.problem}>{ORDER_ACTION_TEXT.noPrice}</p>
                        <ActionFooter feedback={runner.feedback} busy={busy} onBack={back} />
                    </>
                ))}
            {view === 'qty' && (avail.qty
                ? <QtyForm trade={trade} working={working} gateReason={gateReason} gate={gate} runner={runner} onBack={back} />
                : (
                    <>
                        <p className={a.problem}>{ORDER_ACTION_TEXT.noQty}</p>
                        <ActionFooter feedback={runner.feedback} busy={busy} onBack={back} />
                    </>
                ))}
            {view === 'cancel' && <CancelForm trade={trade} working={working} runner={runner} onBack={back} />}
        </div>
    );
}

/** ResumeGate／LIVE 停用說明；stale-data 時可重試或勾選「我了解資料可能過期」 */
function GateNote({ reason, gate, busy }: { reason: string; gate: ResumeGateSnapshot; busy: boolean }) {
    const canRetry = gate.state === 'stale-data' || gate.state === 'failed';
    return (
        <InlineNote
            tone='warn'
            testId='order-action-gate'
            action={canRetry ? { label: '重試', onClick: () => retryResume(), disabled: busy } : undefined}
        >
            <span className={a.gateText}>{reason}</span>
            {gate.state === 'stale-data' && (
                <label className={a.checkboxLabel}>
                    <input
                        type='checkbox'
                        className={a.checkbox}
                        checked={gate.staleAcknowledged}
                        disabled={busy || gate.staleAcknowledged}
                        onChange={() => acknowledgeStaleData()}
                    />
                    我了解資料可能過期
                </label>
            )}
        </InlineNote>
    );
}

interface FormProps {
    trade: Trade;
    working: boolean;
    gateReason: string | null;
    gate: ResumeGateSnapshot;
    runner: MutationRunner;
    onBack: () => void;
}

function PriceForm({ trade, working, gateReason, gate, runner, onBack }: FormProps) {
    const cached = useContract(trade.contract.code);
    const contract: PriceContract = cached ?? trade.contract;
    const [text, setText] = useState(() => String(currentOrderPrice(trade)));
    const { busy } = runner;

    useEffect(() => {
        // 讀取合約（漲跌停、升降單位）；失敗時以委託上的合約資料檢查
        ensureContract(trade.contract.code).catch(() => undefined);
    }, [trade.contract.code]);

    const price = Number(text.replace(/,/g, '').trim() || NaN);
    const problem = priceProblem(trade, contract, price);
    const step = (steps: number) => {
        const base = Number.isFinite(price) && price > 0 ? roundToTick(contract, price) : currentOrderPrice(trade);
        const next = stepPrice(contract, base, steps);
        if (next > 0) setText(String(next));
    };
    // 股票的漲跌停界限（期權不檢查，與 priceProblem 一致）：到界限時步進鍵只回彈並說明
    const stock = !isFuturesTrade(trade);
    const up = Number(contract.limit_up);
    const down = Number(contract.limit_down);
    const disabledReason = !working ? ORDER_ACTION_TEXT.gone : busy ? ORDER_ACTION_TEXT.busy : gateReason ?? problem;
    const tradeId = trade.order.id;

    return (
        <>
            <GroupedSection>
                <ValueRow label='目前價格' value={orderPriceText(trade)} testId='order-action-current-price' />
            </GroupedSection>
            <div className={a.fieldBlock}>
                <span className={a.fieldLabel}>新價格</span>
                <Stepper
                    value={text}
                    onChange={setText}
                    onStep={d => step(d)}
                    inputMode='decimal'
                    ariaLabel='新的委託價格'
                    decLabel='價格減一檔'
                    incLabel='價格加一檔'
                    testId='order-action-price'
                    disabled={busy}
                    invalid={!!problem}
                    atMax={stock && up > 0 && price >= up}
                    atMin={stock && down > 0 && price > 0 && price <= down}
                    maxText='已到漲停'
                    minText='已到跌停'
                />
            </div>
            {problem && <p className={a.problem} data-testid='order-action-problem'>{problem}</p>}
            {gateReason && working && <GateNote reason={gateReason} gate={gate} busy={busy} />}
            <ActionFooter feedback={runner.feedback} busy={busy} onBack={onBack}>
                <SlideToConfirm
                    label={`滑動確認 改價 → ${Number.isFinite(price) ? fmtPrice(price) : '—'}`}
                    testId='order-action-slide'
                    disabled={!!disabledReason}
                    disabledReason={disabledReason}
                    resetKey={runner.resetKey}
                    onConfirm={() => {
                        void runner.run('改價', () => updateOrderPrice(tradeId, price), () => {
                            notify({ kind: 'ok', title: '改價已送出', body: `${trade.contract.code} → ${fmtPrice(price)}；等待回報確認，請在委託頁核對` });
                        }, { gated: true });
                    }}
                />
            </ActionFooter>
        </>
    );
}

function QtyForm({ trade, working, gateReason, gate, runner, onBack }: FormProps) {
    const remaining = remainingWorkingOrderQuantity(trade);
    const unit = orderUnitOf(trade);
    const [text, setText] = useState(() => String(Math.max(1, remaining - 1)));
    const latest = useRef(trade);
    latest.current = trade;
    const { busy } = runner;

    const n = text.trim() === '' ? NaN : Number(text);
    const problem = newRemainingProblem(n, remaining);
    const reduction = problem ? null : qtyReduction(remaining, n);
    const step = (delta: number) => {
        const base = Number.isInteger(n) ? n : remaining - 1;
        const next = Math.min(remaining - 1, Math.max(1, base + delta));
        setText(String(next));
    };
    const disabledReason = !working ? ORDER_ACTION_TEXT.gone : busy ? ORDER_ACTION_TEXT.busy : gateReason ?? problem;
    const tradeId = trade.order.id;
    const odd = isOddLot(trade.order.order_lot);

    return (
        <>
            <GroupedSection>
                <ValueRow label='目前剩餘' value={`${fmtInt(remaining)} ${unit}`} testId='order-action-remaining' />
            </GroupedSection>
            <div className={a.fieldBlock}>
                <span className={a.fieldLabel}>新的剩餘數量</span>
                <Stepper
                    value={text}
                    onChange={v => setText(v.replace(/[^\d]/g, ''))}
                    onStep={d => step(d)}
                    inputMode='numeric'
                    ariaLabel={`新的剩餘數量（${unit}）`}
                    decLabel='數量減一'
                    incLabel='數量加一'
                    testId='order-action-qty'
                    disabled={busy}
                    invalid={!!problem}
                    atMin={Number.isInteger(n) && n <= 1}
                    atMax={Number.isInteger(n) && n >= remaining - 1}
                    minText='已達最小數量'
                    maxText='須小於目前剩餘（全部取消請刪單）'
                    unit={unit}
                />
            </div>
            <p className={problem ? a.problem : a.note} data-testid={problem ? 'order-action-problem' : 'order-action-reduction'}>
                {problem ?? `將減少 ${fmtInt(reduction!)} ${unit}，剩餘 ${fmtInt(n)} ${unit}${odd ? '（零股以股計）' : ''}`}
            </p>
            {gateReason && working && <GateNote reason={gateReason} gate={gate} busy={busy} />}
            <ActionFooter feedback={runner.feedback} busy={busy} onBack={onBack}>
                <SlideToConfirm
                    label={reduction === null ? '滑動確認 減量' : `滑動確認 減量 ${fmtInt(reduction)} ${unit}`}
                    testId='order-action-slide'
                    disabled={!!disabledReason}
                    disabledReason={disabledReason}
                    resetKey={runner.resetKey}
                    onConfirm={() => {
                        // 以送出當下的剩餘量換算減少量（期間部分成交時仍維持使用者要的「新的剩餘數量」）
                        const now = remainingWorkingOrderQuantity(latest.current);
                        void runner.run('改量', () => {
                            const p = newRemainingProblem(n, now);
                            if (p) return Promise.reject(notStarted(p));
                            return updateOrderQty(tradeId, qtyReduction(now, n));
                        }, () => {
                            notify({ kind: 'ok', title: '減量已送出', body: `${trade.contract.code} 剩餘 ${now} → ${n} ${unit}；等待回報確認，請在委託頁核對` });
                        }, { gated: true });
                    }}
                />
            </ActionFooter>
        </>
    );
}

function CancelForm({ trade, working, runner, onBack }: { trade: Trade; working: boolean; runner: MutationRunner; onBack: () => void }) {
    const remaining = remainingWorkingOrderQuantity(trade);
    const unit = orderUnitOf(trade);
    const tradeId = trade.order.id;
    const disabledReason = !working ? ORDER_ACTION_TEXT.gone : runner.busy ? ORDER_ACTION_TEXT.busy : null;
    return (
        <>
            <p className={a.note}>刪除剩餘 {fmtInt(remaining)} {unit}。刪單送出後以券商回讀確認結果；若委託其實已成交，刪單不會成立。</p>
            <ActionFooter feedback={runner.feedback} busy={runner.busy} onBack={onBack}>
                <SlideToConfirm
                    label='滑動確認 刪單'
                    tone='danger'
                    testId='order-action-slide'
                    disabled={!!disabledReason}
                    disabledReason={disabledReason}
                    resetKey={runner.resetKey}
                    onConfirm={() => {
                        // 刪單不受 ResumeGate、LIVE 與風控鎖限制（降低風險的動作）
                        void runner.run('刪單', () => cancelOrder(tradeId, { beforeSend: () => assertNoEnvSwitch(tradeAccountOf(trade)) }), (result: Trade) => {
                            notify({ title: '刪單結果', ...cancellationSummary([{ status: 'fulfilled', value: result }]) });
                        }, { gated: false });
                    }}
                />
            </ActionFooter>
        </>
    );
}
