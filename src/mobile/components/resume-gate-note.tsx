// src/mobile/components/resume-gate-note.tsx — ResumeGate stale-data 的共用說明（規格 §7.4）
//
// 回前景同步的委託／持倉或報價讀取失敗（stale-data）時，新單與平倉要求使用者勾選了解；
// 這個元件提供原因、勾選框（acknowledgeStaleData）與「重試同步」（retryResume），
// 持倉頁 banner、平倉說明面板與狀態列連線面板共用，文案一致。
// 只在 stale-data 時顯示；其他狀態回傳 null。

import type { ResumeGateSnapshot } from '../lib/resume-gate-runtime';
import { acknowledgeStaleData, retryResume } from '../lib/resume-gate-runtime';
import * as controls from '../styles/controls.css';
import * as styles from '../styles/resume-gate-note.css';

export const RESUME_NOTE_TEXT = {
    fallbackReason: '委託／持倉或報價資料可能過期',
    acknowledge: '我了解委託／持倉資料可能過期',
    retry: '重試同步',
} as const;

export interface ResumeGateNoteProps {
    gate: Pick<ResumeGateSnapshot, 'state' | 'staleAcknowledged' | 'message'>;
    /** 送出中等情況：勾選與重試都停用 */
    disabled?: boolean;
    /** 是否顯示原因文字（呼叫端已另外顯示 gate.message 時傳 false） */
    showReason?: boolean;
    testId?: string;
}

export function ResumeGateNote({ gate, disabled = false, showReason = true, testId = 'resume-gate-note' }: ResumeGateNoteProps) {
    if (gate.state !== 'stale-data') return null;
    return (
        <div className={styles.box} role='status' data-testid={testId}>
            {showReason && <p className={styles.reason} data-testid={`${testId}-reason`}>⚠ {gate.message ?? RESUME_NOTE_TEXT.fallbackReason}</p>}
            <div className={styles.actions}>
                <label className={styles.checkboxLabel}>
                    <input
                        type='checkbox'
                        className={styles.checkbox}
                        data-testid={`${testId}-ack`}
                        checked={gate.staleAcknowledged}
                        disabled={disabled || gate.staleAcknowledged}
                        onChange={() => acknowledgeStaleData()}
                    />
                    {RESUME_NOTE_TEXT.acknowledge}
                </label>
                <button
                    type='button'
                    className={controls.button.neutral}
                    disabled={disabled}
                    onClick={() => retryResume()}
                    data-testid={`${testId}-retry`}
                >
                    {RESUME_NOTE_TEXT.retry}
                </button>
            </div>
        </div>
    );
}
