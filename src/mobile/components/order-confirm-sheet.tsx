// src/mobile/components/order-confirm-sheet.tsx — requestOrderConfirm() 的手機確認面板 host（規格 §6.4；設計規格 §7.5、§10 S4／S6）
//
// 必須掛在 App 根層（無 props）：否則 requestOrderConfirm() 的 promise 永遠不會結束。
// 這個佇列同時服務手機新單與持倉平倉（placeStockExitByShares、placeQuickOrder 內部的確認），
// 所以內容只依 OrderConfirmRequest 呈現，不假設來源。
//
// - 送出手勢：SlideToConfirm（resetKey 依每筆 request 區分；放在面板固定 footer）；
//   取消：取消鈕、X、點暗化幕、下拉、Esc → 全部只呼叫 cancel()（resolveOrderConfirm(false)）。
// - 停用條件與桌面 src/components/order-confirm-dialog.tsx 相同：
//   (livePriceCode 且無即時價) || awaitingMode || simulation === null || serverChanged。
// - ResumeGate：面板開著時 resumeSeq 與這筆出現時不同、或 resumeAllowsNewOrders() 為 false，立即取消並提示。
//   T2 進入 resyncing 時也會 resolveOrderConfirm(false)；lib 在沒有待確認時直接 return，重複呼叫無害。
// - 同一筆只 resolve(true) 一次；元件卸載時若仍有待確認就 resolve(false)，不讓 promise 懸置。
// - 退場（設計規格 §7.5）：lastEntryRef 快取最後一筆，shown = current ?? lastEntryRef；BottomSheet 的 open 只看
//   current（lib 一 resolve 就清空 pending → 核准或取消後立即沿原路退場，不停留等待 lib）；退場中顯示 shown 的內容、
//   滑塊 disabled（以 context 傳遞，BottomSheet 凍結 children／footer 也能生效），onExited 後清空快取。
//   approve()／cancel() 仍以 entry id 與 approvedIds 檢查（第二道防線：退場中的舊畫面不能核准或取消下一筆）。
//   同步模式（測試、無 DOM）下關閉即卸載。
// - 依 request.action 著色整個面板（BottomSheet tone：買進 vars.color.up、賣出 vars.color.down），
//   並以大字顯示動作（含信用名稱：融資買進、融券賣出、融券買進（回補）、現股當沖賣出）。
// - 環境橫幅（confirm-env）放在 BottomSheet 的 pinned 固定區（標題列下方、不隨 body 捲動）：視窗再矮、body 捲到底，
//   環境仍與固定 footer 的滑塊同時看得到（§10 S6）。全寬實心：正式 danger＋ShieldAlert、模擬 accent、未確認 amber 黑字（文字為 confirmEnvText()）。
// - 即時價：桌面取自 trigger-engine 的 usePendingPrices()，但 livePriceCode 只有觸價單會帶，手機不載入
//   trigger-engine（載入即啟動觸價執行器，違反 R7）；因此有 livePriceCode 時一律視為「行情中斷」並停用（fail-closed）。
// - 持倉多選市價出清（lib/batch-exit-auth，§10 S10）：批次進行中不渲染面板（也不沿用退場快取），每個確認請求交給
//   decideBatchConfirm()：approve → resolve(true)、reject → resolve(false)、wait → 等下一次 store 更新再判斷。
//   ResumeGate 不允許時不判斷（由上面的 ResumeGate 檢查取消）；核准未被 lib 接受（仍是同一筆）就立即取消。
//   沒有批次時 decide 回 'none'，面板行為與原本相同。

import { ShieldAlert } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import { decideBatchConfirm, isBatchExitActive, subscribeBatchExit } from '../lib/batch-exit-auth';
import { resumeAllowsNewOrders } from '../lib/resume-gate';
import { getResumeGate, subscribeResumeGate } from '../lib/resume-gate-runtime';
import * as styles from '../styles/order-confirm.css';
import { pressable } from '../styles/primitives.css';
import { ValueRow } from '../ui/grouped';
import { BottomSheet } from './bottom-sheet';
import { SlideToConfirm, type SlideToConfirmProps } from './slide-to-confirm';

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

/** 備註裡的「現股當沖」段（桌面與手機新單都以「・現股當沖」附在 note；credit 不含當沖，見規格 §17） */
const DAYTRADE_NOTE = '現股當沖';

/**
 * 動作文字（信用條件寫進動作；買賣一律有文字）：融資買進、融券賣出、融券買進（回補）、
 * 現股當沖賣出（credit 為空且 note 有「現股當沖」段）、買進、賣出。
 */
export function confirmActionText(request: Pick<OrderConfirmRequest, 'action' | 'credit'> & { note?: string }): string {
    const side = request.action === 'Buy' ? '買進' : '賣出';
    if (request.credit) return request.credit === '融券' && request.action === 'Buy' ? '融券買進（回補）' : `${request.credit}${side}`;
    if (request.action === 'Sell' && (request.note ?? '').split('・').includes(DAYTRADE_NOTE)) return `${DAYTRADE_NOTE}${side}`;
    return side;
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

/**
 * 面板是否仍開著（current !== null）。BottomSheet 退場時凍結 children／footer 的 React 元素，
 * 所以「open 為假時滑塊 disabled」以 context 傳遞：context 變動仍會傳到凍結元素裡的消費者。
 */
const ConfirmOpenContext = createContext(true);

/** 確認滑塊：面板退場中（open 為假）一律停用、不顯示停用原因 */
function ConfirmSlide(props: SlideToConfirmProps) {
    const open = useContext(ConfirmOpenContext);
    return <SlideToConfirm {...props} disabled={!open || props.disabled} disabledReason={open ? props.disabledReason : null} />;
}

export function OrderConfirmSheet() {
    const current = useSyncExternalStore(subscribeEntry, syncEntry);
    const batch = useSyncExternalStore(subscribeBatchExit, isBatchExitActive);
    const priv = usePrivacyMode();
    const approvedIds = useRef(new Set<number>());
    const gateCancelledIds = useRef(new Set<number>());
    // 滑動完成但 lib 沒有接受（狀態剛好改變）時重新啟用滑動元件
    const [rearm, setRearm] = useState(0);
    // 退場動畫期間沿用最後一筆的內容（onExited 後清空）
    const lastEntryRef = useRef<ConfirmEntry | null>(null);
    if (batch) lastEntryRef.current = null;
    else if (current) lastEntryRef.current = current;

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

    // 批次出清：不顯示面板，依授權結果核准或取消（見檔頭）
    // resolve 會先清空待確認再通知（重入時 syncEntry() 為 null），同一筆不會判斷兩次。
    useEffect(() => {
        const run = () => {
            const e = syncEntry();
            if (!e || !isBatchExitActive() || !gateStillAllows(e)) return;
            const d = decideBatchConfirm(e.request);
            if (d !== 'approve' && d !== 'reject') return;
            resolveOrderConfirm(d === 'approve');
            if (syncEntry()?.id === e.id) resolveOrderConfirm(false);
        };
        const offConfirm = subscribeOrderConfirm(run);
        const offBatch = subscribeBatchExit(run);
        run();
        return () => {
            offConfirm();
            offBatch();
        };
    }, []);

    // 卸載時仍有待確認：取消，不讓 promise 懸置
    useEffect(() => () => {
        if (syncEntry()) resolveOrderConfirm(false);
    }, []);

    // 退場結束：只在仍沒有待確認時清空快取（退場中又來新的一筆時由 current 接手）
    const onExited = useCallback(() => {
        if (!syncEntry()) lastEntryRef.current = null;
    }, []);

    const shown = current ?? lastEntryRef.current;
    if (!shown || batch) return null;
    const open = current !== null;
    const { id, request } = shown;
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

    const footer = (
        <div className={styles.footer}>
            <ConfirmSlide
                label={`滑動確認 ${actionText} ${request.code}`}
                onConfirm={approve}
                disabled={blockReason !== null}
                disabledReason={blockReason}
                tone={isBuy ? 'buy' : 'sell'}
                resetKey={`${id}:${rearm}`}
                testId='confirm-slide'
            />
            <button type='button' className={`${styles.cancelButton} ${pressable}`} onClick={cancel}>{CONFIRM_TEXT.cancel}</button>
        </div>
    );

    return (
        <ConfirmOpenContext.Provider value={open}>
            <BottomSheet
                open={open}
                onClose={cancel}
                onExited={onExited}
                title={CONFIRM_TEXT.title}
                layer='confirm'
                detent='fit'
                testId='order-confirm-sheet'
                tone={isBuy ? 'buy' : 'sell'}
                footer={footer}
                pinned={(
                    <strong className={styles.env[envKey]} data-testid='confirm-env' data-env={envKey}>
                        {envKey === 'production' && <ShieldAlert className={styles.envIcon} aria-hidden='true' focusable='false' />}
                        {confirmEnvText(request.simulation)}
                    </strong>
                )}
            >
                <div className={styles.content}>
                    <div className={styles.actionLine[isBuy ? 'up' : 'down']} data-testid='confirm-action'>
                        <span className={styles.actionBig}>{actionText}</span>
                        <span className={styles.contractName}>{request.name || request.code}</span>
                        {request.name && <span className={styles.contractCode}>{request.code}</span>}
                    </div>
                    <div className={styles.details}>
                        <ValueRow label='價格' value={priceText} testId='confirm-price' />
                        {/* 手機沒有觸價單即時價來源（見檔頭）：一律顯示行情中斷 */}
                        {request.livePriceCode && <ValueRow label='最新成交價' value={CONFIRM_TEXT.liveDown} tone='warn' testId='confirm-live-price' />}
                        <ValueRow label='數量' value={`${request.quantity.toLocaleString()} ${request.unit}`} testId='confirm-qty' />
                        {request.accountLabel && <ValueRow label='帳戶' value={privacyAccountLabel(request.accountLabel, priv)} testId='confirm-account' />}
                    </div>
                    {request.note && <p className={styles.note} data-testid='confirm-note'>{request.note}</p>}
                </div>
            </BottomSheet>
        </ConfirmOpenContext.Provider>
    );
}
