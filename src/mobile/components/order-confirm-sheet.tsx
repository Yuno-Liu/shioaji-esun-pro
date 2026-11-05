// src/mobile/components/order-confirm-sheet.tsx — requestOrderConfirm() 的手機確認面板 host（規格 §6.4）
//
// 必須掛在 App 根層（無 props）：否則 requestOrderConfirm() 的 promise 永遠不會結束。
// 這個佇列同時服務手機新單與持倉平倉（placeStockExitByShares、placeQuickOrder 內部的確認），
// 所以內容只依 OrderConfirmRequest 呈現，不假設來源。
//
// - 送出手勢：SlideToConfirm（resetKey 依每筆 request 區分）；取消：點背景、下滑、「取消」→ resolveOrderConfirm(false)。
// - 停用條件與桌面 src/components/order-confirm-dialog.tsx 相同：
//   (livePriceCode 且無即時價) || awaitingMode || simulation === null || serverChanged。
// - ResumeGate：面板開著時 resumeSeq 與這筆出現時不同、或 resumeAllowsNewOrders() 為 false，立即取消並提示。
//   T2 進入 resyncing 時也會 resolveOrderConfirm(false)；lib 在沒有待確認時直接 return，重複呼叫無害。
// - 同一筆只 resolve(true) 一次；元件卸載時若仍有待確認就 resolve(false)，不讓 promise 懸置。
// - 即時價：桌面取自 trigger-engine 的 usePendingPrices()，但 livePriceCode 只有觸價單會帶，手機不載入
//   trigger-engine（載入即啟動觸價執行器，違反 R7）；因此有 livePriceCode 時一律視為「行情中斷」並停用（fail-closed）。

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
    getPendingOrderConfirm,
    privacyAccountLabel,
    resolveOrderConfirm,
    subscribeOrderConfirm,
    type OrderConfirmRequest,
} from '../../lib/order-confirm';
import { usePrivacyMode } from '../../lib/privacy';
import { notify } from '../../lib/trade';
import { fmtPrice } from '../../lib/utils/format';
import { resumeAllowsNewOrders } from '../lib/resume-gate';
import { getResumeGate, subscribeResumeGate } from '../lib/resume-gate-runtime';
import * as styles from '../styles/order-confirm.css';
import { BottomSheet } from './bottom-sheet';
import { SlideToConfirm } from './slide-to-confirm';

export const CONFIRM_TEXT = {
    title: '委託確認',
    serverChanged: '伺服器或模式已變更，這筆不會送出，請取消後重新下單',
    // 與桌面 order-confirm-dialog.tsx 相同
    awaitingMode: '確認伺服器模式中…',
    modeUnavailable: '無法確認伺服器模式（模擬／正式），請取消後重試',
    envUnknown: '環境未確認（模擬／正式），不能送出，請取消後重試',
    liveDown: '行情中斷',
    liveDownReason: '行情中斷，無法取得最新成交價，不能送出',
    resyncCancelled: '畫面已重新同步，這筆確認已取消、沒有送出',
    cancel: '取消',
} as const;

/** 手機沒有觸價單即時價來源（見檔頭）：有 livePriceCode 時一律視為沒有即時價 */
const NO_LIVE_PRICE = undefined;

/** 環境大字：true＝模擬、false＝正式、null＝未確認 */
export function confirmEnvText(simulation: boolean | null): string {
    return simulation === true ? '模擬環境' : simulation === false ? '正式環境' : '環境未確認';
}

/** 動作文字（信用條件寫進動作：融資買進／融券賣出；買賣一律有文字） */
export function confirmActionText(request: Pick<OrderConfirmRequest, 'action' | 'credit'>): string {
    return `${request.credit ?? ''}${request.action === 'Buy' ? '買進' : '賣出'}`;
}

/**
 * 滑動確認的停用原因；null＝可以送出。條件與桌面 order-confirm-dialog.tsx:113 完全相同：
 * (livePriceCode 且無即時價) || awaitingMode || simulation === null || serverChanged。
 */
export function confirmBlockReason(request: OrderConfirmRequest, livePrice: number | undefined): string | null {
    if (request.serverChanged) return CONFIRM_TEXT.serverChanged;
    if (request.awaitingMode) return request.modeUnavailable ? CONFIRM_TEXT.modeUnavailable : CONFIRM_TEXT.awaitingMode;
    if (request.simulation === null) return CONFIRM_TEXT.envUnknown;
    if (request.livePriceCode && livePrice === undefined) return CONFIRM_TEXT.liveDownReason;
    return null;
}

// ---- 每筆確認的識別：lib 在模式更新時會換掉 request 物件，所以另外編號 ----
// resolve 一定先清空再 emit，新的一筆 start 時也會 emit；監聽者每次 emit 都同步呼叫 syncEntry()，
// 因此「沒有待確認 → 有」一定會被看到並給新編號。

interface ConfirmEntry {
    id: number;
    request: OrderConfirmRequest;
    /** 這筆出現時的 ResumeGate resumeSeq */
    resumeSeq: number;
}

let entry: ConfirmEntry | null = null;
let nextEntryId = 1;

function syncEntry(): ConfirmEntry | null {
    const request = getPendingOrderConfirm();
    if (!request) entry = null;
    else if (!entry) entry = { id: nextEntryId++, request, resumeSeq: getResumeGate().resumeSeq };
    else if (entry.request !== request) entry = { ...entry, request };
    return entry;
}

function subscribeEntry(listener: () => void): () => void {
    return subscribeOrderConfirm(() => {
        syncEntry();
        listener();
    });
}

/** ResumeGate 仍允許這筆（resumeSeq 沒變且允許新單） */
function gateStillAllows(e: ConfirmEntry): boolean {
    const g = getResumeGate();
    return g.resumeSeq === e.resumeSeq && resumeAllowsNewOrders(g.state, g.staleAcknowledged);
}

export function OrderConfirmSheet() {
    const current = useSyncExternalStore(subscribeEntry, syncEntry);
    const priv = usePrivacyMode();
    const approvedIds = useRef(new Set<number>());
    const gateCancelledIds = useRef(new Set<number>());
    // 滑動完成但 lib 沒有接受（狀態剛好改變）時重新啟用滑動元件
    const [rearm, setRearm] = useState(0);

    // ResumeGate：兩個 store 任一變動都同步檢查（在 T2 的 resolveOrderConfirm(false) 之前就能提示原因）
    useEffect(() => {
        const check = () => {
            const e = syncEntry();
            if (!e || gateStillAllows(e) || gateCancelledIds.current.has(e.id)) return;
            gateCancelledIds.current.add(e.id);
            resolveOrderConfirm(false);
            notify({ kind: 'info', title: CONFIRM_TEXT.resyncCancelled, body: '' });
        };
        const offGate = subscribeResumeGate(check);
        const offConfirm = subscribeOrderConfirm(check);
        check();
        return () => {
            offGate();
            offConfirm();
        };
    }, []);

    // 卸載時仍有待確認：取消，不讓 promise 懸置
    useEffect(() => () => {
        if (syncEntry()) resolveOrderConfirm(false);
    }, []);

    if (!current) return null;
    const { id, request } = current;
    const blockReason = confirmBlockReason(request, NO_LIVE_PRICE);
    const actionText = confirmActionText(request);
    const isBuy = request.action === 'Buy';

    const cancel = () => {
        // 只取消畫面上這一筆（避免舊畫面的點擊取消到下一筆）
        if (syncEntry()?.id === id) resolveOrderConfirm(false);
    };

    const approve = () => {
        const e = syncEntry();
        if (!e || e.id !== id || approvedIds.current.has(id)) return;
        if (confirmBlockReason(e.request, NO_LIVE_PRICE) !== null || !gateStillAllows(e)) {
            setRearm(n => n + 1);
            return;
        }
        approvedIds.current.add(id);
        resolveOrderConfirm(true);
        // lib 沒有接受（例如模式剛變成未確認）：這筆仍待確認，允許在條件恢復後再滑一次
        if (syncEntry()?.id === id) {
            approvedIds.current.delete(id);
            setRearm(n => n + 1);
        }
    };

    const envKey = request.simulation === true ? 'simulation' : request.simulation === false ? 'production' : 'unknown';
    const priceText = request.priceLabel ?? (request.price === null ? '市價' : fmtPrice(request.price));

    return (
        <BottomSheet open onClose={cancel} title={CONFIRM_TEXT.title} layer='confirm' testId='order-confirm-sheet'>
            <div className={styles.content}>
                <strong className={styles.env[envKey]} data-testid='confirm-env'>{confirmEnvText(request.simulation)}</strong>
                <div className={styles.actionLine[isBuy ? 'up' : 'down']} data-testid='confirm-action'>
                    <span>{actionText}</span>
                    <span className={styles.contractName}>{request.name || request.code}</span>
                    {request.name && <span className={styles.contractCode}>{request.code}</span>}
                </div>
                <dl className={styles.details}>
                    <dt className={styles.detailLabel}>價格</dt>
                    <dd className={styles.detailValue} data-testid='confirm-price'>{priceText}</dd>
                    {request.livePriceCode && (
                        <>
                            <dt className={styles.detailLabel}>最新成交價</dt>
                            {/* 手機沒有觸價單即時價來源（見檔頭）：一律顯示行情中斷 */}
                            <dd className={styles.detailValueWarn} data-testid='confirm-live-price' aria-live='polite'>{CONFIRM_TEXT.liveDown}</dd>
                        </>
                    )}
                    <dt className={styles.detailLabel}>數量</dt>
                    <dd className={styles.detailValue} data-testid='confirm-qty'>{request.quantity.toLocaleString()} {request.unit}</dd>
                    {request.accountLabel && (
                        <>
                            <dt className={styles.detailLabel}>帳戶</dt>
                            <dd className={styles.detailValue} data-testid='confirm-account'>{privacyAccountLabel(request.accountLabel, priv)}</dd>
                        </>
                    )}
                </dl>
                {request.note && <p className={styles.note} data-testid='confirm-note'>{request.note}</p>}
                <SlideToConfirm
                    label={`滑動確認 ${actionText} ${request.code}`}
                    onConfirm={approve}
                    disabled={blockReason !== null}
                    disabledReason={blockReason}
                    tone={isBuy ? 'buy' : 'sell'}
                    resetKey={`${id}:${rearm}`}
                    testId='confirm-slide'
                />
                <button type='button' className={styles.cancelButton} onClick={cancel}>{CONFIRM_TEXT.cancel}</button>
            </div>
        </BottomSheet>
    );
}
