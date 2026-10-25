// src/components/esun-order-meta.tsx — 委託分頁的玉山掛鉤（fork 模組）
//
// - EsunOrderMetaBadge：玉山委託列顯示「預約 MM/DD」與委託時間，tooltip 列出委託日期時間、
//   有效交易日、預約／盤中與券商的可否取消提示。非玉山列或沒有中繼資料時不輸出任何東西。
// - EsunOrderEditGate：玉山預約單不提供改價、改量（只包住編輯器；CANCEL 不經過這裡，
//   絕不依 celable 擋刪單——那只是券商提示，擋掉會讓使用者無法撤單）。
// - mutationErrorNotice：改價／改量／刪單失敗通知的標題與內文；確定未送出（mutationNotStarted）
//   時照實說「未送出」，其餘維持「失敗或結果未知、勿自動重送」。只改訊息，不改任何行為。

import type { ReactNode } from 'react';
import { esunCelableLabel, useEsunOrderMeta, type EsunOrderMeta } from '../lib/esun/account-details';
import { isEsunBroker } from '../lib/esun/order-mapping';
import type { Trade } from '../lib/types/order';
import * as styles from './esun-order-meta.css';

type AccountTagged = { account?: { broker_id?: string | null } | null };

/** 委託列是否屬於玉山帳戶（fan-out 帳戶標籤優先，其次 order.account） */
export function isEsunTrade(trade: Trade): boolean {
    const tagged = (trade as Trade & AccountTagged).account?.broker_id;
    return isEsunBroker(tagged ?? trade.order.account?.broker_id);
}

/**
 * 尚未進入盤中撮合的玉山預約單（不可改價、改量）：有中繼資料時以 pendingReservation 為準
 * （已取得 ord_no 的預約來源單可以改單）；沒有時以「玉山帳戶且 PreSubmitted」判斷
 */
export function isEsunReservationTrade(trade: Trade, meta: EsunOrderMeta | null): boolean {
    if (!isEsunTrade(trade)) return false;
    if (meta) return meta.pendingReservation;
    return trade.status.status === 'PreSubmitted';
}

/** 台北今天 YYYY-MM-DD */
function taipeiToday(now = Date.now()): string {
    return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD → MM/DD；缺值 '' */
const monthDay = (date: string): string => (date ? date.slice(5).replace('-', '/') : '');

/** 委託時間：委託日不是台北今天時 'MM/DD HH:MM:SS'，否則 'HH:MM:SS'；缺值回 '' */
export function esunOrderTimeLabel(meta: EsunOrderMeta, today: string = taipeiToday()): string {
    const day = meta.orderDate && meta.orderDate !== today ? monthDay(meta.orderDate) : '';
    return [day, meta.orderTime].filter(Boolean).join(' ');
}

/** tooltip：委託日期時間、有效交易日、預約／盤中、券商可否取消 */
export function esunOrderMetaTitle(meta: EsunOrderMeta): string {
    const placed = [meta.orderDate, meta.orderTime].filter(Boolean).join(' ') || '—';
    const celable = esunCelableLabel(meta.cancellable === null ? '' : meta.cancellable ? '1' : '2') || '未提供';
    return [
        `委託日期時間 ${placed}`,
        `有效交易日 ${meta.workDate || '—'}`,
        meta.pendingReservation
            ? '預約單（尚未進入盤中撮合，不可改價、改量）'
            : meta.reservation ? '預約單（已進入盤中撮合）' : '盤中單',
        `券商可否取消 ${celable}（僅供參考，刪單一律可送出）`,
    ].join('\n');
}

/**
 * 玉山委託列的預約標示與委託時間；非玉山或沒有中繼資料時回 null。
 * compact（中等寬度的委託表）：委託時間只放 tooltip，避免把 CANCEL 欄擠出可視範圍。
 */
export function EsunOrderMetaBadge({ trade, compact = false }: { trade: Trade; compact?: boolean }) {
    const meta = useEsunOrderMeta(trade);
    if (!meta || !isEsunTrade(trade)) return null;
    const time = esunOrderTimeLabel(meta);
    return (
        <span className={styles.meta} title={esunOrderMetaTitle(meta)}>
            {meta.reservation && (
                <span className={styles.reservation}>
                    預約{meta.workDate ? ` ${monthDay(meta.workDate)}` : ''}
                </span>
            )}
            {time && !compact && <span className={styles.time}>{time}</span>}
            {/* compact 且沒有預約徽章：留一個小標記作為 tooltip 入口 */}
            {time && compact && !meta.reservation && <span className={styles.time} aria-label='委託時間'>ⓘ</span>}
        </span>
    );
}

/** 玉山預約單不顯示改價、改量；其他委託原樣顯示 children */
export function EsunOrderEditGate({ trade, children }: { trade: Trade; children: ReactNode }) {
    const meta = useEsunOrderMeta(trade);
    return isEsunReservationTrade(trade, meta) ? null : <>{children}</>;
}

/** 改價／改量／刪單失敗通知；verb 為「改價」「改量」「刪單」 */
export function mutationErrorNotice(err: unknown, verb: string): { title: string; body: string } {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as { mutationNotStarted?: unknown } | null)?.mutationNotStarted === true) {
        return { title: `${verb}未送出`, body: message };
    }
    return { title: `${verb}失敗或結果未知`, body: `${message}；請手動更新委託確認，勿自動重送` };
}
