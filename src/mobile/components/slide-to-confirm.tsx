// src/mobile/components/slide-to-confirm.tsx — 滑動確認（確認面板、委託操作、平倉共用；規格 §6.4）
//
// 行動裝置誤觸率高：送出手勢必須是「按住把手往右滑過 80% 行程再放開」，點一下不會觸發。
// - 行程（travel）＝軌道寬度 − 把手寬度 − 左右留白；進度 ≥ SLIDE_CONFIRM_THRESHOLD 放開才觸發。
// - disabled 時不接受任何手勢與按鍵，並顯示 disabledReason；拖曳中變成 disabled 會立即歸零。
// - 觸發一次後鎖定（不會重複觸發）；父層要重用同一個元件時改變 resetKey 重新啟用。
// - 鍵盤可及：把手是 role="slider"；→／↑ 前進 25%、←／↓ 後退 25%、End 到底、Home／Esc 歸零，
//   進度 ≥ 80% 時按 Enter 或空白鍵才確認（不會因單一按鍵誤觸）。

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import * as styles from '../styles/controls.css';

/** 需滑過的行程比例 */
export const SLIDE_CONFIRM_THRESHOLD = 0.8;
/** 把手寬度＋左右留白（與 styles/controls.css.ts 的 slideHandle 一致：48px＋3px×2） */
export const SLIDE_HANDLE_SPAN_PX = 54;
/** 鍵盤每次移動的比例 */
export const SLIDE_KEY_STEP = 0.25;

/** 拖曳距離換算成進度（0–1）；行程未知（≤ 0）時一律為 0，不可能觸發 */
export function slideProgress(startProgress: number, dx: number, travel: number): number {
    if (!(travel > 0) || !Number.isFinite(dx)) return 0;
    return Math.min(1, Math.max(0, startProgress + dx / travel));
}

export function slideReached(progress: number): boolean {
    return progress >= SLIDE_CONFIRM_THRESHOLD;
}

export type SlideTone = 'neutral' | 'buy' | 'sell' | 'danger';

export interface SlideToConfirmProps {
    /** 軌道上的文字，例如「滑動確認 買進 2330」 */
    label: string;
    /** 滑過門檻放開後呼叫一次 */
    onConfirm: () => void;
    disabled?: boolean;
    /** 停用原因（disabled 時顯示在軌道下方） */
    disabledReason?: string | null;
    tone?: SlideTone;
    /** 改變時解除「已觸發」鎖定並歸零 */
    resetKey?: unknown;
    testId?: string;
}

export function SlideToConfirm({ label, onConfirm, disabled = false, disabledReason, tone = 'neutral', resetKey, testId = 'slide-to-confirm' }: SlideToConfirmProps) {
    const trackRef = useRef<HTMLDivElement | null>(null);
    const drag = useRef<{ pointerId: number; startX: number; startProgress: number; travel: number } | null>(null);
    const [progress, setProgress] = useState(0);
    const [dragging, setDragging] = useState(false);
    const [done, setDone] = useState(false);
    const doneRef = useRef(false);
    const onConfirmRef = useRef(onConfirm);
    onConfirmRef.current = onConfirm;

    const reset = useCallback(() => {
        drag.current = null;
        setDragging(false);
        setProgress(0);
    }, []);

    // 父層要求重新啟用
    useEffect(() => {
        doneRef.current = false;
        setDone(false);
        reset();
    }, [resetKey, reset]);

    // 拖曳途中被停用（例如伺服器模式改變、ResumeGate 離開 ready）：立即歸零
    useEffect(() => {
        if (disabled && !doneRef.current) reset();
    }, [disabled, reset]);

    const fire = () => {
        if (doneRef.current || disabled) return;
        doneRef.current = true;
        setDone(true);
        setProgress(1);
        setDragging(false);
        drag.current = null;
        onConfirmRef.current();
    };

    const travel = () => {
        const width = trackRef.current?.getBoundingClientRect?.().width ?? 0;
        return width - SLIDE_HANDLE_SPAN_PX;
    };

    const inactive = disabled || done;

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (inactive) return;
        drag.current = { pointerId: e.pointerId, startX: e.clientX, startProgress: progress, travel: travel() };
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDragging(true);
    };
    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId || inactive) return;
        setProgress(slideProgress(d.startProgress, e.clientX - d.startX, d.travel));
    };
    const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const final = slideProgress(d.startProgress, e.clientX - d.startX, d.travel);
        if (!inactive && slideReached(final)) fire();
        else reset();
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (inactive) return;
        const step = (delta: number) => { e.preventDefault(); setProgress(p => Math.min(1, Math.max(0, p + delta))); };
        switch (e.key) {
            case 'ArrowRight':
            case 'ArrowUp':
                step(SLIDE_KEY_STEP);
                break;
            case 'ArrowLeft':
            case 'ArrowDown':
                step(-SLIDE_KEY_STEP);
                break;
            case 'End':
                e.preventDefault();
                setProgress(1);
                break;
            case 'Home':
            case 'Escape':
                e.preventDefault();
                setProgress(0);
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                if (slideReached(progress)) fire();
                break;
            default:
                break;
        }
    };

    const pct = Math.round(progress * 100);
    // left／width 的百分比以軌道為基準（translateX 的百分比是把手自身寬度，不能用）
    const handleOffset = `((100% - ${SLIDE_HANDLE_SPAN_PX}px) * ${progress})`;

    return (
        <div className={styles.slideWrap} data-testid={testId}>
            <div ref={trackRef} className={styles.slideTrack} data-disabled={disabled ? 'true' : 'false'}>
                <div
                    className={`${styles.slideFillBase} ${styles.slideFill[tone]}`}
                    style={{ width: `calc(${handleOffset} + ${SLIDE_HANDLE_SPAN_PX}px)` }}
                    data-testid={`${testId}-fill`}
                />
                <div className={styles.slideLabel} aria-hidden='true'>{done ? '已確認' : label}</div>
                <div
                    role='slider'
                    tabIndex={inactive ? -1 : 0}
                    aria-label={label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    aria-valuetext={done ? '已確認' : slideReached(progress) ? `${pct}%，按 Enter 確認` : `${pct}%`}
                    aria-disabled={inactive}
                    className={styles.slideHandle[tone]}
                    data-testid={`${testId}-handle`}
                    data-dragging={dragging ? 'true' : 'false'}
                    style={{ left: `calc(3px + ${handleOffset})` }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={reset}
                    onLostPointerCapture={() => { if (drag.current) reset(); }}
                    onKeyDown={onKeyDown}
                >
                    ›
                </div>
            </div>
            {disabled && disabledReason
                ? <p className={styles.slideDisabledReason} role='status'>{disabledReason}</p>
                : !done && <p className={styles.slideHint}>按住把手向右滑到底後放開以確認</p>}
        </div>
    );
}
