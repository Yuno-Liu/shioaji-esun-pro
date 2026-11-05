// src/mobile/components/order-action-sheet.tsx — 委託操作面板：改價／減量／刪單（規格 §6.5、§7.2、§7.3）
//
// 介面：無 props、掛在 App 根層；目標委託來自 mobile-store 的 `orderAction`
// （openOrderAction(tradeId, 'menu'|'price'|'qty'|'cancel')／closeOrderAction()）。委託頁與交易圖表的委託線都經由 openOrderAction 開啟。
// - 動作顯示規則與實際呼叫的 lib 函式以桌面 src/components/bottom-dock-orders.tsx 為準：
//   改價＝canUpdateOrderPrice()（限價、非零股）且非玉山預約單，玉山另以 validateEsunOrderPriceMutation() 檢查新價格；
//   減量＝剩餘量 ≥ 2 且非玉山預約單，輸入「新的剩餘數量」n，送出 updateOrderQty(tradeId, 剩餘 − n)；
//   刪單＝一律提供（不因玉山 celable 提示隱藏），cancelOrder(tradeId)。
// - 每個動作都必須 SlideToConfirm 滑動完成才呼叫 lib；進行中停用並鎖住面板（不可關閉）。
// - 改價、減量：按鈕在 useTradingLive() 為 false 或 ResumeGate 不允許時停用並說明；滑動完成後、呼叫 lib 前
//   再同步檢查 assertResumeReady({ allowStale: staleAcknowledged }) 與 assertTradingLive()，丟出就顯示「未送出」且不呼叫 lib。
//   刪單不受 ResumeGate、LIVE 與風控鎖限制（降低風險的動作；桌面刪單同樣不要求 LIVE）。
// - 結果：成功 notify；失敗一律 notify({ kind: 'err', ...mutationErrorNotice(err, verb) })。
//   「未送出」（mutationNotStarted）面板保留可修改後重試；其餘＝結果未知，關閉面板，不自動重送、不提供重送鍵。
// - 面板開啟期間該委託已不在未成交（成交或已刪）時，顯示「此委託已不在未成交」並停用所有動作。
// - OrderLines（委託頁列、本面板摘要共用）：類別徽章、成交均價、成交進度條、已取消／原始委託量、券商訊息（遮蔽身分證號）。

import { useEffect, useRef, useState } from 'react';
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
import { isNotStarted, notStarted } from '../lib/errors';
import { avgFillPrice, avgPriceDigits, fillProgress, orderBadges } from '../lib/order-fills';
import { closeOrderAction, useMobileUi, type OrderActionKind } from '../lib/mobile-store';
import { resumeAllowsNewOrders } from '../lib/resume-gate';
import { acknowledgeStaleData, assertResumeReady, getResumeGate, retryResume, type ResumeGateSnapshot } from '../lib/resume-gate-runtime';
import * as styles from '../styles/orders.css';
import { mobileAccountLabel } from './account-switch-sheet';
import { BottomSheet } from './bottom-sheet';
import { routeBadgeText, useOrderRoute } from './route-badge';
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
} as const;

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

/** 成交進度條（成交量 ÷ 減量後的委託量）；數字另有文字 */
export function FillBar({ trade }: { trade: Trade }) {
    const p = fillProgress(trade);
    const unit = orderUnitOf(trade);
    const pct = Math.round(p.ratio * 100);
    return (
        <span
            className={styles.progressTrack}
            role='progressbar'
            aria-label={`成交進度 ${fmtInt(p.filled)}／${fmtInt(p.effective)} ${unit}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            data-testid='order-progress'
        >
            <span className={styles.progressFill[p.ratio >= 1 ? 'done' : 'partial']} style={{ width: `${pct}%` }} />
        </span>
    );
}

/** 委託內容（委託頁列與操作面板摘要共用；全部用 span，可放在按鈕內） */
export function OrderLines({ trade, meta }: { trade: Trade; meta: EsunOrderMeta | null }) {
    const priv = usePrivacyMode();
    const account = tradeAccountOf(trade);
    const route = useOrderRoute(account);
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
                <span className={styles.code}>{trade.contract.code}</span>
                {trade.contract.name && <span>{trade.contract.name}</span>}
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

    const title = trade ? `委託操作 ${trade.contract.code}` : '委託操作';
    return (
        <BottomSheet open={orderAction !== null} onClose={closeOrderAction} dismissible={!busy} title={title} testId='order-action-sheet'>
            {orderAction && (trade
                ? <ActionBody key={orderAction.seq} kind={orderAction.kind} trade={trade} working={!!found && isWorkingTrade(found)} onBusyChange={setBusy} />
                : <p className={styles.problem} role='status'>{ORDER_ACTION_TEXT.notFound}</p>)}
        </BottomSheet>
    );
}

interface MutationRunner {
    busy: boolean;
    resetKey: number;
    /** 「未送出：…」；null＝無 */
    feedback: string | null;
    run: <T>(verb: Verb, call: () => Promise<T>, onOk: (value: T) => void, opts: { gated: boolean }) => Promise<void>;
}

function useMutationRunner(onBusyChange: (busy: boolean) => void): MutationRunner {
    const [busy, setBusy] = useState(false);
    const [resetKey, setResetKey] = useState(0);
    const [feedback, setFeedback] = useState<string | null>(null);
    const busyRef = useRef(false);

    useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
    useEffect(() => () => onBusyChange(false), [onBusyChange]);

    const notSent = (err: unknown) => {
        setFeedback(`未送出：${err instanceof Error ? err.message : String(err)}`);
        setResetKey(k => k + 1); // 滑動確認重新啟用，修改後可再試
    };

    const run: MutationRunner['run'] = async (verb, call, onOk, opts) => {
        if (busyRef.current) return;
        setFeedback(null);
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
        try {
            const value = await call();
            onOk(value);
            closeOrderAction();
        } catch (err) {
            notify({ kind: 'err', ...mutationErrorNotice(err, verb) });
            // 確定未送出：面板保留可修改後重試；結果未知：關閉面板，不自動重送、不提供重送鍵
            if (isNotStarted(err)) notSent(err);
            else closeOrderAction();
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };

    return { busy, resetKey, feedback, run };
}

function ActionBody({ kind, trade, working, onBusyChange }: { kind: OrderActionKind; trade: Trade; working: boolean; onBusyChange: (busy: boolean) => void }) {
    const [view, setView] = useState<OrderActionKind>(kind);
    const meta = useEsunOrderMeta(trade);
    const live = useTradingLive();
    const gate = useResumeGate();
    const runner = useMutationRunner(onBusyChange);
    const avail = orderActionAvailability(trade, meta);
    const gateReason = mutationGateReason(live, gate);
    const { busy } = runner;

    return (
        <div className={styles.sheetBody} data-testid='order-action-body' data-view={view}>
            <div className={styles.summary}>
                <OrderLines trade={trade} meta={meta} />
            </div>
            {!working && <p className={styles.problem} role='status' data-testid='order-action-gone'>{ORDER_ACTION_TEXT.gone}</p>}

            {view === 'menu' && (
                <>
                    <div className={styles.menu} role='group' aria-label='委託操作'>
                        {avail.price && (
                            <button type='button' className={styles.menuButton.neutral} disabled={busy || !working || !!gateReason} onClick={() => setView('price')}>
                                改價
                            </button>
                        )}
                        {avail.qty && (
                            <button type='button' className={styles.menuButton.neutral} disabled={busy || !working || !!gateReason} onClick={() => setView('qty')}>
                                減量
                            </button>
                        )}
                        <button type='button' className={styles.menuButton.danger} disabled={busy || !working} onClick={() => setView('cancel')}>
                            刪單
                        </button>
                    </div>
                    {working && (avail.price || avail.qty) && gateReason && <GateNote reason={gateReason} gate={gate} busy={busy} />}
                </>
            )}

            {view === 'price' && (avail.price
                ? <PriceForm trade={trade} working={working} gateReason={gateReason} gate={gate} runner={runner} />
                : <p className={styles.problem}>{ORDER_ACTION_TEXT.noPrice}</p>)}
            {view === 'qty' && (avail.qty
                ? <QtyForm trade={trade} working={working} gateReason={gateReason} gate={gate} runner={runner} />
                : <p className={styles.problem}>{ORDER_ACTION_TEXT.noQty}</p>)}
            {view === 'cancel' && <CancelForm trade={trade} working={working} runner={runner} />}

            {runner.feedback && <p className={styles.notSent} role='alert' data-testid='order-action-feedback'>{runner.feedback}</p>}

            {view !== 'menu' && (
                <button type='button' className={styles.button.neutral} disabled={busy} onClick={() => setView('menu')}>
                    返回
                </button>
            )}
        </div>
    );
}

/** ResumeGate／LIVE 停用說明；stale-data 時可重試或勾選「我了解資料可能過期」 */
function GateNote({ reason, gate, busy }: { reason: string; gate: ResumeGateSnapshot; busy: boolean }) {
    return (
        <div className={styles.gateRow} data-testid='order-action-gate'>
            <span>{reason}</span>
            {gate.state === 'stale-data' && (
                <label className={styles.gateRow}>
                    <input
                        type='checkbox'
                        className={styles.checkbox}
                        checked={gate.staleAcknowledged}
                        disabled={busy || gate.staleAcknowledged}
                        onChange={() => acknowledgeStaleData()}
                    />
                    我了解資料可能過期
                </label>
            )}
            {(gate.state === 'stale-data' || gate.state === 'failed') && (
                <button type='button' className={styles.button.neutral} disabled={busy} onClick={() => retryResume()}>重試</button>
            )}
        </div>
    );
}

interface FormProps {
    trade: Trade;
    working: boolean;
    gateReason: string | null;
    gate: ResumeGateSnapshot;
    runner: MutationRunner;
}

function PriceForm({ trade, working, gateReason, gate, runner }: FormProps) {
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
    const disabledReason = !working ? ORDER_ACTION_TEXT.gone : busy ? ORDER_ACTION_TEXT.busy : gateReason ?? problem;
    const tradeId = trade.order.id;

    return (
        <>
            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>目前價格</span>
                <span>{orderPriceText(trade)}</span>
            </div>
            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>新價格</span>
                <div className={styles.stepper}>
                    <button type='button' className={styles.stepButton} aria-label='價格減一檔' disabled={busy} onClick={() => step(-1)}>－</button>
                    <input
                        className={styles.input}
                        aria-label='新的委託價格'
                        data-testid='order-action-price'
                        inputMode='decimal'
                        autoComplete='off'
                        disabled={busy}
                        aria-invalid={problem ? true : undefined}
                        value={text}
                        onChange={e => setText(e.target.value)}
                    />
                    <button type='button' className={styles.stepButton} aria-label='價格加一檔' disabled={busy} onClick={() => step(1)}>＋</button>
                </div>
            </div>
            {problem && <p className={styles.problem} data-testid='order-action-problem'>{problem}</p>}
            {gateReason && working && <GateNote reason={gateReason} gate={gate} busy={busy} />}
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
        </>
    );
}

function QtyForm({ trade, working, gateReason, gate, runner }: FormProps) {
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
            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>目前剩餘</span>
                <span data-testid='order-action-remaining'>{fmtInt(remaining)} {unit}</span>
            </div>
            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>新的剩餘數量</span>
                <div className={styles.stepper}>
                    <button type='button' className={styles.stepButton} aria-label='數量減一' disabled={busy} onClick={() => step(-1)}>－</button>
                    <input
                        className={styles.input}
                        aria-label={`新的剩餘數量（${unit}）`}
                        data-testid='order-action-qty'
                        inputMode='numeric'
                        autoComplete='off'
                        disabled={busy}
                        aria-invalid={problem ? true : undefined}
                        value={text}
                        onChange={e => setText(e.target.value.replace(/[^\d]/g, ''))}
                    />
                    <button type='button' className={styles.stepButton} aria-label='數量加一' disabled={busy} onClick={() => step(1)}>＋</button>
                </div>
            </div>
            <p className={problem ? styles.problem : styles.sub} data-testid={problem ? 'order-action-problem' : 'order-action-reduction'}>
                {problem ?? `將減少 ${fmtInt(reduction!)} ${unit}，剩餘 ${fmtInt(n)} ${unit}${odd ? '（零股以股計）' : ''}`}
            </p>
            {gateReason && working && <GateNote reason={gateReason} gate={gate} busy={busy} />}
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
        </>
    );
}

function CancelForm({ trade, working, runner }: { trade: Trade; working: boolean; runner: MutationRunner }) {
    const remaining = remainingWorkingOrderQuantity(trade);
    const unit = orderUnitOf(trade);
    const tradeId = trade.order.id;
    const disabledReason = !working ? ORDER_ACTION_TEXT.gone : runner.busy ? ORDER_ACTION_TEXT.busy : null;
    return (
        <>
            <p className={styles.sub}>刪除剩餘 {fmtInt(remaining)} {unit}。刪單送出後以券商回讀確認結果；若委託其實已成交，刪單不會成立。</p>
            <SlideToConfirm
                label='滑動確認 刪單'
                tone='danger'
                testId='order-action-slide'
                disabled={!!disabledReason}
                disabledReason={disabledReason}
                resetKey={runner.resetKey}
                onConfirm={() => {
                    // 刪單不受 ResumeGate、LIVE 與風控鎖限制（降低風險的動作）
                    void runner.run('刪單', () => cancelOrder(tradeId), (result: Trade) => {
                        notify({ title: '刪單結果', ...cancellationSummary([{ status: 'fulfilled', value: result }]) });
                    }, { gated: false });
                }}
            />
        </>
    );
}
