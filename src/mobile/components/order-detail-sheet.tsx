// src/mobile/components/order-detail-sheet.tsx — 委託明細面板（委託頁點委託列開啟；規格 §6.5 延伸）
//
// 介面：<OrderDetailSheet tradeId={string | null} onClose={() => void} />，由 routes/orders-page.tsx 掛載。
// - 資料：useTradingState().trades 依 tradeId 查詢（每次更新即時反映）；委託從清單消失時保留最後看到的內容。
// - 內容：完整欄位（狀態、價格、類別徽章、原始／成交／已取消／剩餘量、成交均價與進度、帳戶與路由、
//   委託時間與最後成交時間、書號與序號、券商訊息）、玉山中繼資料（預約、原始委託日期時間、可否刪）、
//   成交時間軸（status.deals：時間、價格、數量；玉山彙總成交另外標示）。
// - 成交時間用 order-fills 的 dealFillTs：玉山重新讀取後的逐筆成交只有委託時間，標示「券商未提供成交時間」，
//   不當成「最後成交」或時間軸的成交時間。
// - 改價／減量／刪單：只關閉本面板並以 openOrderAction(id, kind) 開啟既有的委託操作面板，
//   顯示規則（orderActionAvailability）、閘門與滑動確認全部沿用 order-action-sheet.tsx，這裡不呼叫任何 lib 交易函式。
// - 版面（設計規格 §7.6）：large 面板；標頭（方向膠囊、代碼名稱、狀態）＋GroupedSection 欄位＋成交時間軸（圓點＋細線，純 CSS）；
//   改價／減量／刪單在固定 footer。欄位文字與 testid 不變。

import { useRef, type ReactNode } from 'react';
import { useEsunOrderMeta } from '../../lib/esun/account-details';
import { orderStatusLabel } from '../../lib/order-status-label';
import { usePrivacyMode } from '../../lib/privacy';
import { useTradingState } from '../../lib/trading-state';
import type { Trade } from '../../lib/types/order';
import { fmtInt, fmtPrice } from '../../lib/utils/format';
import { remainingWorkingOrderQuantity } from '../../lib/working-order-quantity';
import { openOrderAction, type OrderActionKind } from '../lib/mobile-store';
import { dealFillTs, dealTimeline, esunCancellableText, fillProgress, isAggregateDeal, lastDealFillTs, missingDealQuantity } from '../lib/order-fills';
import * as styles from '../styles/orders.css';
import { GroupedSection } from '../ui/grouped';
import { InlineNote } from '../ui/inline-note';
import { mobileAccountLabel } from './account-switch-sheet';
import { BottomSheet, SheetFooter } from './bottom-sheet';
import {
    avgFillText,
    esunReservationText,
    FillBar,
    isWorkingTrade,
    orderActionAvailability,
    OrderBadges,
    orderMessageText,
    orderPriceText,
    orderTimeText,
    orderUnitOf,
    tradeAccountOf,
} from './order-action-sheet';
import { routeBadgeText, useOrderRoute } from './route-badge';

export const ORDER_DETAIL_TEXT = {
    notFound: '找不到這筆委託，請到委託頁按「更新」後再試',
    noDeals: '尚無成交',
    gone: '此委託沒有未成交數量，無法改價、減量或刪單',
} as const;

export interface OrderDetailSheetProps {
    /** null＝關閉 */
    tradeId: string | null;
    onClose: () => void;
}

/** 最後成交時間（秒或毫秒）；沒有成交或券商未提供成交時間回 0 */
export function lastDealTs(trade: Trade): number {
    return lastDealFillTs(trade);
}

export function OrderDetailSheet({ tradeId, onClose }: OrderDetailSheetProps) {
    const { trades } = useTradingState();
    const found = tradeId ? trades.find(t => t.order.id === tradeId) ?? null : null;
    const lastSeen = useRef<Trade | null>(null);
    if (found) lastSeen.current = found;
    const trade = found ?? (tradeId && lastSeen.current?.order.id === tradeId ? lastSeen.current : null);
    const title = trade ? `委託明細 ${trade.contract.code}` : '委託明細';
    return (
        <BottomSheet open={tradeId !== null} onClose={onClose} title={title} detent='large' testId='order-detail-sheet'>
            {tradeId !== null && (trade
                ? <DetailBody trade={trade} working={!!found && isWorkingTrade(found)} onClose={onClose} />
                : <InlineNote tone='warn' role='status'>{ORDER_DETAIL_TEXT.notFound}</InlineNote>)}
        </BottomSheet>
    );
}

function DetailBody({ trade, working, onClose }: { trade: Trade; working: boolean; onClose: () => void }) {
    const meta = useEsunOrderMeta(trade);
    const priv = usePrivacyMode();
    const account = tradeAccountOf(trade);
    const route = useOrderRoute(account);
    const unit = orderUnitOf(trade);
    const progress = fillProgress(trade);
    const remaining = remainingWorkingOrderQuantity(trade);
    const avg = avgFillText(trade);
    const message = orderMessageText(trade);
    const avail = orderActionAvailability(trade, meta);
    const id = trade.order.id;
    const modified = trade.status.modified_price > 0 && Math.abs(trade.status.modified_price - trade.order.price) > 1e-9;
    const orderTime = orderTimeText(trade.status.order_ts);
    const lastTs = lastDealTs(trade);
    const timeline = dealTimeline(trade);
    const missing = missingDealQuantity(trade);
    const lastDealText = lastTs > 0 ? orderTimeText(lastTs) : timeline.length > 0 ? '券商未提供成交時間' : '—';
    const reservation = esunReservationText(meta);

    const act = (kind: OrderActionKind) => {
        onClose();
        openOrderAction(id, kind);
    };

    // 明細欄位（ValueRow 外觀；值可換行，帳戶與券商訊息等長字串不撐破版面）；testId 在值元素上，文字恰為值
    const field = (term: string, value: ReactNode, testId?: string) => (
        <div className={styles.detailRow}>
            <span className={styles.detailTerm}>{term}</span>
            <span className={styles.detailValue} data-testid={testId}>{value}</span>
        </div>
    );

    return (
        <div className={styles.sheetBody} data-testid='order-detail-body'>
            <div className={styles.detailHead}>
                <span className={styles.side[trade.order.action === 'Buy' ? 'Buy' : 'Sell']}>{trade.order.action === 'Buy' ? '買進' : '賣出'}</span>
                <span className={styles.code}>{trade.contract.code}</span>
                {trade.contract.name && <span>{trade.contract.name}</span>}
                <span className={styles.status}>{orderStatusLabel(trade.status.status)}</span>
            </div>

            <GroupedSection header='委託'>
                {field('類別', <OrderBadges trade={trade} />)}
                {field('委託價', <>{orderPriceText(trade)}{modified ? `（原 ${fmtPrice(trade.order.price)}）` : ''}</>, 'detail-price')}
                {field('原始委託', `${fmtInt(progress.original)} ${unit}`, 'detail-original')}
                {field('已成交', `${fmtInt(progress.filled)} ${unit}`, 'detail-filled')}
                {field('已取消', `${fmtInt(progress.cancelled)} ${unit}`, 'detail-cancelled')}
                {field('剩餘', `${fmtInt(remaining)} ${unit}`, 'detail-remaining')}
                {field('成交均價', avg ?? '—', 'detail-avg')}
                {field('成交進度', (
                    <span className={styles.detailProgress}>
                        <FillBar trade={trade} />
                        <span className={styles.sub}>{fmtInt(progress.filled)}／{fmtInt(progress.effective)} {unit}</span>
                    </span>
                ))}
            </GroupedSection>

            <GroupedSection header='帳戶與書號'>
                {field('帳戶', `${route ? routeBadgeText(route) : '帳戶未知'}${account ? ` · ${mobileAccountLabel(account, priv)}` : ''}`, 'detail-account')}
                {field('委託時間', orderTime || '—', 'detail-order-time')}
                {field('最後成交', lastDealText, 'detail-last-deal')}
                {field('書號', trade.order.ordno || '—', 'detail-ordno')}
                {field('序號', trade.order.seqno || '—', 'detail-seqno')}
                {message && field('訊息', <span className={styles.msg}>{message}</span>, 'detail-msg')}
            </GroupedSection>

            {meta && (
                <GroupedSection header='玉山委託資訊' testId='detail-esun'>
                    {field('預約', meta.reservation ? (reservation ?? '預約') + (meta.pendingReservation ? '（尚未進入盤中）' : '') : '否', 'detail-esun-reservation')}
                    {field('原始委託', [meta.orderDate, meta.orderTime].filter(Boolean).join(' ') || '—')}
                    {field('可否刪', esunCancellableText(meta.cancellable), 'detail-esun-cancellable')}
                </GroupedSection>
            )}

            <GroupedSection header='成交時間軸'>
                <ol className={styles.timeline} data-testid='detail-timeline'>
                    <li className={styles.timelineItem}>
                        <span className={styles.timelineTime}>{orderTime || '—'}</span>
                        <span>委託 {orderPriceText(trade)} × {fmtInt(progress.original)} {unit}</span>
                    </li>
                    {timeline.map((d, i) => {
                        const aggregate = isAggregateDeal(trade, d);
                        const ts = dealFillTs(trade, d);
                        return (
                            <li key={`${d.seq}|${i}`} className={styles.timelineItem} data-testid='detail-deal'>
                                <span className={styles.timelineTime}>{ts > 0 ? orderTimeText(ts) || '—' : '—'}</span>
                                <span>成交 {fmtPrice(d.price)} × {fmtInt(d.quantity)} {unit}</span>
                                {aggregate
                                    ? <span className={styles.sub}>（彙總，無逐筆時間）</span>
                                    : ts <= 0 && <span className={styles.sub}>（券商未提供成交時間）</span>}
                            </li>
                        );
                    })}
                </ol>
            </GroupedSection>
            {timeline.some(d => dealFillTs(trade, d) <= 0) && timeline.some(d => dealFillTs(trade, d) > 0) && (
                <p className={styles.sheetNote} data-testid='detail-timeline-note'>依成交時間排序；券商未提供成交時間的成交排在最後。</p>
            )}
            {timeline.length === 0 && missing === 0 && <p className={styles.sheetNote} data-testid='detail-no-deals'>{ORDER_DETAIL_TEXT.noDeals}</p>}
            {missing > 0 && (
                <p className={styles.sheetNote} data-testid='detail-missing'>另有 {fmtInt(missing)} {unit} 成交，券商未提供逐筆明細</p>
            )}

            {/* 改價／減量／刪單：只關閉本面板並開委託操作面板（滑動確認在該面板內），這裡不呼叫任何 lib 交易函式 */}
            <SheetFooter>
                {working ? (
                    <div className={styles.detailActions} role='group' aria-label='委託操作'>
                        {avail.price && (
                            <button type='button' className={styles.detailAction.neutral} data-testid='detail-price-button' onClick={() => act('price')}>改價</button>
                        )}
                        {avail.qty && (
                            <button type='button' className={styles.detailAction.neutral} data-testid='detail-qty-button' onClick={() => act('qty')}>減量</button>
                        )}
                        <button type='button' className={styles.detailAction.danger} data-testid='detail-cancel-button' onClick={() => act('cancel')}>刪單</button>
                    </div>
                ) : (
                    <p className={styles.sheetNote} data-testid='detail-gone'>{ORDER_DETAIL_TEXT.gone}</p>
                )}
            </SheetFooter>
        </div>
    );
}
