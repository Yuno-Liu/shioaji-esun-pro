// src/mobile/components/batch-exit-sheet.tsx — 持倉「多選市價出清」預覽與進度面板（延遲載入；設計規格 §7.7、§10 S10）
//
// - 預覽（phase 'preview'）：標題「市價出清 N 筆」；依帳戶分組，組標頭＝券商與遮蔽帳號（持倉頁 groupLabel）＋環境標籤
//   正式／模擬／未確認（與狀態列路由徽章同一算法：orderRouteOf＋即時環境 → routeTone）；每筆＝名稱代碼、條件、多空數量、
//   動作（closeActionText）、各腳（整張市價 IOC；零股以跌停／漲停價盤中零股限價，與 lib 實際送出相同）。
//   警語：市價 IOC 可能以不利價格成交、未成交部分自動取消；非交易時段送出會被券商拒絕；含正式環境時另有強警示。
//   SlideToConfirm「滑動送出 N 筆」：任一組環境未確認、持倉頁給的停用原因（閘門、進行中的流程、清單為空）時停用並顯示原因。
//   滑動完成只呼叫 onConfirm(各帳戶當下看到的環境)；送出由持倉頁的 runBatchExit 執行，本元件不呼叫任何送單函式。
// - 執行中（'running'）：不可關閉（dismissible=false），每筆顯示等待／送出中／已送出／未送出（原因）／略過／結果未知；
//   「停止剩餘」只在目前這筆之後停止（送出中的那一筆無法取消）。
// - 完成（'done'）：摘要＋「完成」。

import { useEsunEnvironment } from '../../lib/esun';
import { orderRouteOf } from '../../lib/order-route';
import { useServerInfo } from '../../lib/server-info-store';
import type { Account } from '../../lib/types/portfolio';
import type { BatchItemState, BatchItemStatus } from '../lib/batch-exit';
import * as styles from '../styles/batch-exit.css';
import { GroupedSection } from '../ui/grouped';
import { InlineNote } from '../ui/inline-note';
import { BottomSheet, SheetFooter } from './bottom-sheet';
import { routeTone, type RouteTone } from './route-badge';
import { SlideToConfirm } from './slide-to-confirm';

export interface BatchViewItem {
    /** positionKey */
    key: string;
    code: string;
    name?: string;
    /** 條件與多空數量（已依遮蔽金額處理），例如「現股 多 3張+500股」 */
    summary: string;
    /** closeActionText(plan)，例如「融資賣出」「平倉買進」 */
    actionText: string;
    /** 實際送出的各腳 */
    legs: string[];
}

export interface BatchViewGroup {
    /** accountKeyOf(account) */
    key: string;
    account: Account;
    /** 券商＋市場＋遮蔽帳號（持倉頁 groupLabel） */
    label: string;
    items: BatchViewItem[];
}

export type BatchPhase = 'preview' | 'running' | 'done';

export interface BatchExitSheetProps {
    phase: BatchPhase;
    groups: BatchViewGroup[];
    /** 執行中與完成後每筆的狀態（以 positionKey 對照）；預覽時為 null */
    states: Readonly<Record<string, BatchItemState>> | null;
    /** 持倉頁給的停用原因（閘門、進行中的流程、清單為空）；null＝可送出 */
    blockReason: string | null;
    /** 預覽期間有選取的持倉變動而被移除的說明 */
    note: string | null;
    /** 已要求停止剩餘 */
    stopRequested: boolean;
    /** 完成後的摘要（只有筆數） */
    summary: string | null;
    /** 滑動完成：各帳戶（accountKeyOf）此刻顯示的環境（true 模擬、false 正式、undefined 未確認） */
    onConfirm: (envs: ReadonlyMap<string, boolean | undefined>) => void;
    onStop: () => void;
    onClose: () => void;
}

export const BATCH_SHEET_TEXT = {
    envUnknown: '有帳戶的環境未確認（模擬／正式），不能送出',
    iocWarn: '市價 IOC 可能以不利價格成交，未成交部分自動取消。',
    hoursWarn: '非交易時段送出會被券商拒絕。',
    flow: '滑動後依序逐筆送出，不再逐筆確認；每筆送出前會再核對持倉與連線，持倉有變動的會略過；任一筆結果未知即停止，不會重送。',
    production: '包含正式環境帳戶：將以真實資金送出市價委託。',
    stop: '停止剩餘',
    stopping: '將在目前這筆之後停止',
    done: '完成',
    cancel: '取消',
} as const;

const ENV_TEXT: Record<RouteTone, string> = { production: '正式', simulation: '模擬', unknown: '未確認' };

export const BATCH_STATUS_TEXT: Record<BatchItemStatus, string> = {
    waiting: '等待',
    sending: '送出中',
    sent: '已送出',
    'not-sent': '未送出',
    skipped: '略過',
    unknown: '結果未知',
};

export function BatchExitSheet({ phase, groups, states, blockReason, note, stopRequested, summary, onConfirm, onStop, onClose }: BatchExitSheetProps) {
    const esun = useEsunEnvironment();
    const info = useServerInfo();
    // 與 RouteBadge（useOrderRoute → routeTone）相同的算法；環境改變時重新渲染
    const routes = groups.map(g => orderRouteOf(g.account, { esunEnvironment: esun.environment, sinopacSimulation: info?.simulation }));
    const tones = routes.map(routeTone);
    const count = groups.reduce((n, g) => n + g.items.length, 0);
    const running = phase === 'running';
    const anyProduction = tones.includes('production');
    const reason = count === 0 ? '沒有可出清的持倉' : tones.includes('unknown') ? BATCH_SHEET_TEXT.envUnknown : blockReason;
    const all = Object.values(states ?? {});
    const done = all.filter(s => s.status !== 'waiting' && s.status !== 'sending').length;

    const confirm = () => {
        if (reason !== null) return;
        onConfirm(new Map(groups.map((g, i) => [g.key, routes[i]!.simulation])));
    };

    const footer = phase === 'preview' ? (
        <div className={styles.footerStack}>
            <SlideToConfirm
                label={`滑動送出 ${count} 筆`}
                tone='danger'
                testId='batch-exit-slide'
                disabled={reason !== null}
                disabledReason={reason}
                // 清單、停用原因或說明（例如滑動後未開始的原因）改變時解除「已觸發」鎖定，可再滑一次
                resetKey={`${count}:${reason ?? ''}:${note ?? ''}`}
                onConfirm={confirm}
            />
            <button type='button' className={styles.textButton} onClick={onClose} data-testid='batch-exit-cancel'>{BATCH_SHEET_TEXT.cancel}</button>
        </div>
    ) : running ? (
        <div className={styles.footerStack}>
            <p className={styles.batchStatusLine} role='status' data-testid='batch-exit-progress'>處理中… {done}／{all.length}</p>
            <button type='button' className={styles.outlineButton} disabled={stopRequested} onClick={onStop} data-testid='batch-exit-stop'>
                {stopRequested ? BATCH_SHEET_TEXT.stopping : BATCH_SHEET_TEXT.stop}
            </button>
        </div>
    ) : (
        <div className={styles.footerStack}>
            <p className={styles.sheetText} role='status' data-testid='batch-exit-summary'>{summary}</p>
            <button type='button' className={styles.outlineButton} onClick={onClose} data-testid='batch-exit-done'>{BATCH_SHEET_TEXT.done}</button>
        </div>
    );

    return (
        <BottomSheet open onClose={onClose} dismissible={!running} title={`市價出清 ${count} 筆`} detent='large' testId='batch-exit-sheet' footer={footer}>
            <div className={styles.sheetBody}>
                {phase === 'preview' && (
                    <>
                        {anyProduction && <InlineNote tone='danger' role='alert' testId='batch-exit-production'>{BATCH_SHEET_TEXT.production}</InlineNote>}
                        <InlineNote tone='warn' testId='batch-exit-warn'>
                            {BATCH_SHEET_TEXT.iocWarn}
                            {BATCH_SHEET_TEXT.hoursWarn}
                        </InlineNote>
                        <p className={styles.sheetText}>{BATCH_SHEET_TEXT.flow}</p>
                        {note && <InlineNote tone='info' role='status' testId='batch-exit-note'>{note}</InlineNote>}
                    </>
                )}
                {groups.map((g, gi) => (
                    <GroupedSection key={g.key} testId='batch-exit-group'>
                        <p className={styles.batchGroupHead} data-testid='batch-exit-group-head'>
                            <span>{g.label}</span>
                            <span className={styles.envTag[tones[gi]!]} data-testid='batch-exit-env' data-env={tones[gi]}>{ENV_TEXT[tones[gi]!]}</span>
                        </p>
                        <ul className={styles.batchList}>
                            {g.items.map(it => {
                                const st = states?.[it.key];
                                return (
                                    <li key={it.key} className={styles.batchItem} data-testid='batch-exit-item' data-code={it.code} data-status={st?.status}>
                                        <span className={styles.batchItemHead}>
                                            <span>{it.name ? `${it.name} ${it.code}` : it.code}</span>
                                            <span>{it.summary}</span>
                                            <span className={styles.batchAction}>→ 市價{it.actionText}</span>
                                        </span>
                                        {it.legs.map(l => <p key={l} className={styles.batchLeg} data-testid='batch-exit-leg'>{l}</p>)}
                                        {st && (
                                            <p className={`${styles.batchStatusLine} ${styles.batchStatus[st.status]}`} data-testid='batch-exit-status'>
                                                {BATCH_STATUS_TEXT[st.status]}{st.reason ? `（${st.reason}）` : ''}
                                            </p>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </GroupedSection>
                ))}
            </div>
        </BottomSheet>
    );
}
