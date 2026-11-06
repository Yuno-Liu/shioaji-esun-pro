// src/mobile/components/slide-to-confirm.tsx — 滑動確認 v2（確認面板、委託操作、平倉共用；規格 §6.4、設計規格 §6.3、§10 S2）
//
// 行動裝置誤觸率高：送出手勢必須是「按住把手往右滑過 80% 行程再放開」，點一下不會觸發。
// - 行程（travel）＝軌道寬度 − 把手寬度 − 左右留白；放手時 final = slideProgress(起點進度, 放手 clientX − 按下 clientX, 行程)，
//   !inactive && slideReached(final) 才送出。速度只用於未達門檻時的回彈初速；不用投射、不用遲滯、不吸附（不可更動）。
// - 拖曳 1:1 保留抓取偏移；把手 translateX 與填充位移由彈簧引擎直接寫 style（不逐 move setState），
//   語意 state（aria-valuenow）每跨 5% 才更新；就緒視覺（Check、2px 框）與送出條件同為 p ≥ 0.8。
// - 未就緒（所在面板未 settled 且距 max(shownAt, 最近一次 resetKey 改變) 未滿 armDelayMs）時忽略 pointerdown；鍵盤不受影響。
// - 中止（一律回 0、不送出）：pointercancel、lostpointercapture、disabled 變真、visibilitychange 為 hidden、所在面板退場。
// - disabled 時不接受任何手勢與按鍵，並顯示 disabledReason；觸發一次後鎖定；父層改變 resetKey 重新啟用。
// - 鍵盤可及：把手是 role="slider"；→／↑ 前進 25%、←／↓ 後退 25%、End 到底、Home／Esc 歸零，
//   進度 ≥ 80% 時按 Enter 或空白鍵才確認（不會因單一按鍵誤觸）。
// - 觸覺：p 由 <0.8 越過 0.8 時震一次，退回 <0.77 才會再震（0.77 只用於震動節流，不影響視覺與判定）。
// - AT 後備（SLIDE_AT_FALLBACK，依 VoiceOver／TalkBack 實機關卡結果啟用）：仍須先把進度調到 ≥ 80%，
//   再以另一個明確動作確認；任何模式都不會單擊直接送出。

import { Check, ChevronsRight, TriangleAlert } from 'lucide-react';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { usePointerDrag } from '../motion/gesture';
import { haptic } from '../motion/haptics';
import { animateSpring, motionNow, SPRINGS, writeStyle, type SpringHandle } from '../motion/spring';
import * as styles from '../styles/controls.css';
import { srOnly } from '../styles/primitives.css';
import { SheetPresenceContext } from '../ui/sheet-context';

/** 需滑過的行程比例 */
export const SLIDE_CONFIRM_THRESHOLD = 0.8;
/** 把手寬度＋左右留白（與 styles/controls.css.ts 的 slideHandle 一致：48px＋3px×2） */
export const SLIDE_HANDLE_SPAN_PX = 54;
/** 鍵盤每次移動的比例 */
export const SLIDE_KEY_STEP = 0.25;
/** 進場保護：所在面板 settled 或距開啟／resetKey 改變滿這個時間（先到者）才接受按下 */
export const SLIDE_ARM_DELAY_MS = 300;
/** 震動遲滯：越過門檻震動後，需退回這個比例以下才會再震（不影響視覺與送出判定） */
export const SLIDE_HAPTIC_REARM = 0.77;
/** 語意進度（aria-valuenow）的更新粒度 */
const SEMANTIC_STEP = 0.05;
/** AT 後備：最近這段時間內有指標拖曳時不接受 click 確認 */
const AT_CLICK_QUIET_MS = 350;

/**
 * VoiceOver／TalkBack 實機關卡（設計規格 §6.3）的後備模式：
 * - 'off'：不啟用（實機關卡完成前的預設）。
 * - 'click'：增減可用、Enter 不可用 → 把手靜止且進度 ≥ 80%、最近 350ms 內沒有指標拖曳時，接受 click 作為確認。
 * - 'range'：增減不可用 → 加視覺隱藏的原生 range（step 25）綁同一進度，並以同一 click 規則確認。
 * 任何模式都不得改成單擊直接送出。
 */
export type SlideAtFallback = 'off' | 'click' | 'range';
export const SLIDE_AT_FALLBACK: SlideAtFallback = 'off';

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
    /** 進場保護（ms），預設 300 */
    armDelayMs?: number;
    /** AT 後備模式；預設 SLIDE_AT_FALLBACK（只供實機關卡結果切換與測試） */
    atFallback?: SlideAtFallback;
}

const SEMANTIC_STEPS = Math.round(1 / SEMANTIC_STEP);
/** 語意進度：每跨 5% 才變（floor(p × 20) / 20 保證「≥ 0.8」與連續值完全一致） */
const quantize = (p: number) => Math.floor(p * SEMANTIC_STEPS) / SEMANTIC_STEPS;

export function SlideToConfirm({
    label, onConfirm, disabled = false, disabledReason, tone = 'neutral', resetKey, testId = 'slide-to-confirm',
    armDelayMs = SLIDE_ARM_DELAY_MS, atFallback = SLIDE_AT_FALLBACK,
}: SlideToConfirmProps) {
    const presence = useContext(SheetPresenceContext);
    const presenceRef = useRef(presence);
    presenceRef.current = presence;

    const trackRef = useRef<HTMLDivElement | null>(null);
    const handleRef = useRef<HTMLDivElement | null>(null);
    const fillRef = useRef<HTMLDivElement | null>(null);
    const labelRef = useRef<HTMLDivElement | null>(null);

    const [progress, setProgressState] = useState(0);
    const progressRef = useRef(0);
    const setProgress = useCallback((p: number) => { progressRef.current = p; setProgressState(p); }, []);
    const [dragging, setDragging] = useState(false);
    const [done, setDone] = useState(false);
    const doneRef = useRef(false);
    const onConfirmRef = useRef(onConfirm);
    onConfirmRef.current = onConfirm;

    // 畫面上的連續進度與彈簧
    const live = useRef(0);
    const travelRef = useRef(0);
    const spring = useRef<SpringHandle | null>(null);
    const springTarget = useRef<number | null>(null);
    const drag = useRef<{ startProgress: number; travel: number; cancel: () => void } | null>(null);
    const hapticArmed = useRef(true);
    const lastPointerAt = useRef(Number.NEGATIVE_INFINITY);

    // 最近一次 resetKey 改變的時間（掛載不算）
    const prevResetKey = useRef(resetKey);
    const resetAt = useRef(Number.NEGATIVE_INFINITY);
    if (!Object.is(prevResetKey.current, resetKey)) {
        prevResetKey.current = resetKey;
        resetAt.current = motionNow();
    }

    const exiting = presence.phase === 'exiting';
    const inactive = disabled || done || exiting;
    const inactiveRef = useRef(inactive);
    inactiveRef.current = inactive;

    const armWaitMs = () => {
        const p = presenceRef.current;
        if (p.settled) return 0;
        return Math.max(0, armDelayMs - (motionNow() - Math.max(p.shownAt, resetAt.current)));
    };
    const armed = armWaitMs() === 0;
    const [, forceRender] = useState(0);
    useEffect(() => {
        if (armed) return;
        const id = setTimeout(() => forceRender(n => n + 1), armWaitMs() + 16);
        return () => clearTimeout(id);
    });

    const measureTravel = () => {
        let width = 0;
        try {
            width = trackRef.current?.getBoundingClientRect?.().width ?? 0;
        } catch {
            width = 0;
        }
        return width - SLIDE_HANDLE_SPAN_PX;
    };

    /** 直接寫 style：把手 translateX、填充位移、軌道文字淡出（node mock 沒有 style 時不寫） */
    const applyVisual = useCallback((p: number) => {
        const travel = travelRef.current > 0 ? travelRef.current : 0;
        const x = p * travel;
        writeStyle(handleRef.current, { transform: x > 0 ? `translateX(${x}px)` : null });
        writeStyle(fillRef.current, { transform: x > 0 ? `translateX(${x + SLIDE_HANDLE_SPAN_PX}px)` : null });
        writeStyle(labelRef.current, { opacity: x > 0 && !doneRef.current ? String(Math.max(0, 1 - p / 0.6)) : null });
    }, []);

    const moveVisualTo = useCallback((target: number, velocity?: number) => {
        if (springTarget.current === target && spring.current && !spring.current.done) {
            if (velocity !== undefined) spring.current.retarget(target, velocity);
            return;
        }
        spring.current?.stop();
        travelRef.current = measureTravel();
        springTarget.current = target;
        spring.current = animateSpring({
            from: live.current,
            to: target,
            velocity: velocity ?? 0,
            config: SPRINGS.default,
            restDelta: 0.001,
            restSpeed: 0.01,
            el: handleRef.current,
            onUpdate: v => {
                // 回彈不過頭：畫面值夾在 0–1
                live.current = Math.min(1, Math.max(0, v));
                applyVisual(live.current);
            },
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [applyVisual]);

    const reset = useCallback(() => {
        const d = drag.current;
        drag.current = null;
        d?.cancel();
        hapticArmed.current = true;
        setDragging(false);
        setProgress(0);
    }, [setProgress]);

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

    // 所在面板退場：歸零、不送出
    useEffect(() => {
        if (exiting && !doneRef.current) reset();
    }, [exiting, reset]);

    // 頁面切到背景：歸零、不送出
    useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
        const onVisibility = () => {
            if (document.visibilityState === 'hidden' && !doneRef.current) reset();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, [reset]);

    // 非拖曳時畫面跟著語意進度（鍵盤、回彈、送出、歸零）
    useLayoutEffect(() => {
        if (dragging) return;
        moveVisualTo(done ? 1 : progress);
    }, [progress, dragging, done, moveVisualTo]);

    useEffect(() => () => { spring.current?.stop(); }, []);

    const fire = () => {
        if (doneRef.current || disabled || presenceRef.current.isExiting()) return;
        doneRef.current = true;
        drag.current = null;
        spring.current?.stop();
        spring.current = null;
        springTarget.current = null;
        live.current = 1;
        travelRef.current = measureTravel();
        applyVisual(1);
        setDone(true);
        setProgress(1);
        setDragging(false);
        onConfirmRef.current();
    };

    const pointer = usePointerDrag({
        axis: 'x',
        slop: 0,
        canStart: () => !inactiveRef.current && armWaitMs() === 0,
        onStart: i => {
            spring.current?.stop();
            spring.current = null;
            springTarget.current = null;
            const travel = measureTravel();
            travelRef.current = travel;
            // 1:1 保留抓取偏移：從畫面上目前的位置接手（回彈中被抓住也一樣）
            drag.current = { startProgress: live.current, travel, cancel: i.cancel };
            lastPointerAt.current = motionNow();
            setDragging(true);
        },
        onMove: i => {
            const d = drag.current;
            if (!d || inactiveRef.current) return;
            lastPointerAt.current = motionNow();
            const p = slideProgress(d.startProgress, i.delta, d.travel);
            live.current = p;
            applyVisual(p);
            const q = quantize(p);
            if (q !== progressRef.current) setProgress(q);
            if (slideReached(p)) {
                if (hapticArmed.current) { hapticArmed.current = false; haptic('threshold'); }
            } else if (p < SLIDE_HAPTIC_REARM) {
                hapticArmed.current = true;
            }
        },
        onEnd: i => {
            const d = drag.current;
            drag.current = null;
            lastPointerAt.current = motionNow();
            if (!d) return;
            if (i.cancelled) { reset(); return; }
            // 送出判定只看放手位置（不可更動）
            const x = i.event.clientX;
            const final = slideProgress(d.startProgress, typeof x === 'number' ? x - i.start : Number.NaN, d.travel);
            if (!inactiveRef.current && slideReached(final)) { fire(); return; }
            // 未達門檻：以放手速度換算的進度速度回彈到 0
            hapticArmed.current = true;
            moveVisualTo(0, d.travel > 0 ? i.velocity / d.travel : 0);
            setProgress(0);
            setDragging(false);
        },
    });

    const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
        if (inactive) return;
        const step = (delta: number) => { e.preventDefault(); setProgress(Math.min(1, Math.max(0, progressRef.current + delta))); };
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
                if (slideReached(progressRef.current)) fire();
                break;
            default:
                break;
        }
    };

    /** AT 後備的確認：把手靜止、進度 ≥ 80%、最近 350ms 沒有指標拖曳；進度不足時什麼都不做（不會單擊送出） */
    const onHandleClick = () => {
        if (atFallback === 'off' || inactive || drag.current) return;
        if (motionNow() - lastPointerAt.current < AT_CLICK_QUIET_MS) return;
        if (spring.current && !spring.current.done) return;
        if (slideReached(progressRef.current) && slideReached(live.current)) fire();
    };

    const onRangeChange = (e: ChangeEvent<HTMLInputElement>) => {
        if (inactive) return;
        const v = Number(e.target.value);
        if (Number.isFinite(v)) setProgress(Math.min(1, Math.max(0, v / 100)));
    };

    const pct = Math.round(progress * 100);
    const ready = !done && slideReached(progress);
    const valueText = done ? '已確認' : ready ? `${pct}%，按 Enter 確認` : `${pct}%`;
    const hint = dragging && ready ? '放開即送出，往回滑可取消' : '按住把手向右滑到底後放開以確認';

    return (
        <div className={styles.slideWrap} data-testid={testId} data-done={done ? 'true' : 'false'}>
            <div
                ref={trackRef}
                className={`${styles.slideTrack} ${styles.slideTrackReady[tone]}`}
                data-disabled={disabled ? 'true' : 'false'}
                data-ready={ready ? 'true' : 'false'}
                data-armed={armed ? 'true' : 'false'}
            >
                <div ref={fillRef} className={`${styles.slideFillBase} ${styles.slideFill[tone]}`} data-testid={`${testId}-fill`} />
                <div ref={labelRef} className={styles.slideLabel} aria-hidden='true'>{done ? '已確認' : label}</div>
                <div
                    ref={handleRef}
                    role='slider'
                    tabIndex={inactive ? -1 : 0}
                    aria-label={label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    aria-valuetext={valueText}
                    aria-disabled={inactive}
                    className={styles.slideHandle[tone]}
                    data-testid={`${testId}-handle`}
                    data-dragging={dragging ? 'true' : 'false'}
                    onPointerDown={pointer.onPointerDown}
                    onPointerMove={pointer.onPointerMove}
                    onPointerUp={pointer.onPointerUp}
                    onPointerCancel={pointer.onPointerCancel}
                    onLostPointerCapture={pointer.onLostPointerCapture}
                    onKeyDown={onKeyDown}
                    onClick={onHandleClick}
                >
                    {ready || done
                        ? <Check size={24} strokeWidth={2.75} aria-hidden='true' />
                        : <ChevronsRight size={24} strokeWidth={2.5} aria-hidden='true' />}
                </div>
                {atFallback === 'range' && (
                    <input
                        type='range'
                        className={srOnly}
                        min={0}
                        max={100}
                        step={SLIDE_KEY_STEP * 100}
                        value={pct}
                        aria-label={label}
                        aria-valuetext={valueText}
                        disabled={inactive}
                        onChange={onRangeChange}
                        onKeyDown={onKeyDown}
                        data-testid={`${testId}-range`}
                    />
                )}
            </div>
            {disabled && disabledReason
                ? (
                    <p className={styles.slideDisabledReason} role='status'>
                        <TriangleAlert className={styles.slideReasonIcon} size={14} aria-hidden='true' />
                        <span>{disabledReason}</span>
                    </p>
                )
                : !done && <p className={styles.slideHint}>{hint}</p>}
        </div>
    );
}
