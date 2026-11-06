// src/mobile/ui/stepper.tsx — 步進輸入（設計規格 §6.9）
//
// - 版面 [－][輸入][＋]；可見字元維持全形「－」「＋」（測試以 click('＋') 定位），aria-label 由呼叫端帶入
//   （「價格減一檔」「價格加一檔」「數量減一」「數量加一」）。
// - 點擊（click）走一步；按住 400ms 後每秒 8 步，連續 1.2 秒後每秒 16 步；發生過連續步進就吞掉隨後的 click
//   （避免多走一步）。pointerup／pointercancel／pointerleave／lostpointercapture、window blur、visibilitychange、
//   disabled、到達界限一律停止。
// - 界限：atMax 時按＋（atMin 時按－）不呼叫 onStep；輸入框以 spring.bump 橫移約 4px 回彈、footnote（role=status）
//   顯示 maxText／minText 2 秒、haptic('bound')；減少動態時只顯示文字。
// - flashKey 改變（外部帶入價格）：accent 外框以 WAAPI opacity 1→0 400ms；減少動態改靜態外框 600ms。
// 步進只改輸入值，不送單。

import { useEffect, useId, useRef, useState } from 'react';
import { haptic } from '../motion/haptics';
import { prefersReducedMotion } from '../motion/prefs';
import { animateSpring, SPRINGS, writeStyle, type SpringHandle } from '../motion/spring';
import { focusRing, pressable } from '../styles/primitives.css';
import * as styles from './stepper.css';

export interface StepperProps {
    value: string;
    onChange(text: string): void;
    onStep(delta: 1 | -1): void;
    inputMode: 'decimal' | 'numeric';
    ariaLabel: string;
    decLabel: string;
    incLabel: string;
    /** 放在輸入框上（例如 ticket-price、ticket-qty） */
    testId?: string;
    /** 整個元件停用（輸入框與兩鍵） */
    disabled?: boolean;
    /** 只停用兩鍵（例如市價時不能步進） */
    stepDisabled?: boolean;
    invalid?: boolean;
    onBlur?(): void;
    atMin?: boolean;
    atMax?: boolean;
    minText?: string;
    maxText?: string;
    /** 改變時（外部帶入價格）閃一下外框；第一次渲染不閃 */
    flashKey?: unknown;
    /** 單位文字（視覺；aria-label 應已含單位） */
    unit?: string;
}

/** 連續步進與回饋的時間參數（ms） */
export const STEPPER_TIMING = Object.freeze({
    holdDelay: 400,
    /** 每秒 8 步 */
    slowInterval: 125,
    /** 每秒 16 步（1000/16 取整） */
    fastInterval: 63,
    /** 連續步進持續 1.2 秒後改快速 */
    fastAfter: 1200,
    /** 停止後多久內的 click 視為按住的收尾（吞掉） */
    clickSwallow: 350,
    boundNote: 2000,
    flash: 400,
    flashStatic: 600,
});

/**
 * 撞界回彈的初速（px/s）：spring.bump（ζ .55、response .25s）從 0 出發、以此初速推出，最大位移約 4px 後回到 0
 * （x(t)=e^(−ζω0t)·(v0/ωd)·sin ωd t 的峰值 ≈ v0 × 0.02076）。
 */
export const BUMP_VELOCITY = 193;

type PointerLikeEvent = { isPrimary?: boolean; pointerType?: string; button?: number } | undefined;

interface HoldState {
    dir: 1 | -1;
    timer: ReturnType<typeof setTimeout> | null;
    /** 已連續步進的累計時間（以排程間隔累加，不依賴時鐘） */
    elapsed: number;
    /** 是否已觸發過任何連續步進（含撞界） */
    ticked: boolean;
    detach: () => void;
}

const isBound = (p: StepperProps, dir: 1 | -1) => (dir > 0 ? !!p.atMax : !!p.atMin);
const canStep = (p: StepperProps) => !p.disabled && !p.stepDisabled;

export function Stepper(props: StepperProps) {
    const {
        value, onChange, inputMode, ariaLabel, decLabel, incLabel, testId, disabled = false, stepDisabled = false,
        invalid = false, onBlur, atMin = false, atMax = false, flashKey, unit,
    } = props;
    const latest = useRef(props);
    latest.current = props;

    const noteId = useId();
    const fieldRef = useRef<HTMLDivElement | null>(null);
    const flashRef = useRef<HTMLSpanElement | null>(null);
    const hold = useRef<HoldState | null>(null);
    const swallowClick = useRef(false);
    const swallowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const boundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const bumpHandle = useRef<SpringHandle | null>(null);
    const prevFlashKey = useRef(flashKey);
    const [boundText, setBoundText] = useState('');
    const [staticFlash, setStaticFlash] = useState(false);

    // ---- 撞界回饋 ----
    const bump = (dir: 1 | -1) => {
        const p = latest.current;
        const text = (dir > 0 ? p.maxText : p.minText) ?? '';
        if (boundTimer.current) clearTimeout(boundTimer.current);
        setBoundText(text);
        if (text) boundTimer.current = setTimeout(() => { boundTimer.current = null; setBoundText(''); }, STEPPER_TIMING.boundNote);
        haptic('bound');
        if (prefersReducedMotion()) return; // 減少動態：只顯示文字
        bumpHandle.current?.stop();
        const el = fieldRef.current;
        bumpHandle.current = animateSpring({
            from: 0,
            to: 0,
            velocity: dir * BUMP_VELOCITY,
            config: SPRINGS.bump,
            el,
            onUpdate: v => writeStyle(el, { transform: Math.abs(v) < 0.01 ? 'none' : `translateX(${v}px)` }),
        });
    };

    // ---- 按住連續步進 ----
    const stopHold = () => {
        const h = hold.current;
        if (!h) return;
        hold.current = null;
        if (h.timer) clearTimeout(h.timer);
        h.detach();
        // 連續步進（含撞界）後，同一次按壓放開時的 click 是收尾：吞掉，避免多走一步。
        // 手指可能還按著（因撞界、停用、失焦而停止），所以旗標保留到放開後 clickSwallow 毫秒（見 endPointer）。
        if (h.ticked) swallowClick.current = true;
    };

    /** 指標結束（放開、取消、離開、失去捕捉）：停止連續步進；若要吞 click，從現在起只保留 clickSwallow 毫秒 */
    const endPointer = () => {
        stopHold();
        if (!swallowClick.current) return;
        if (swallowTimer.current) clearTimeout(swallowTimer.current);
        swallowTimer.current = setTimeout(() => { swallowTimer.current = null; swallowClick.current = false; }, STEPPER_TIMING.clickSwallow);
    };

    const tick = () => {
        const h = hold.current;
        if (!h) return;
        h.timer = null;
        const p = latest.current;
        if (!canStep(p)) { stopHold(); return; }
        h.ticked = true;
        if (isBound(p, h.dir)) {
            const dir = h.dir;
            stopHold();
            bump(dir);
            return;
        }
        p.onStep(h.dir);
        if (hold.current !== h) return; // onStep 同步造成停止（例如停用）
        const interval = h.elapsed >= STEPPER_TIMING.fastAfter ? STEPPER_TIMING.fastInterval : STEPPER_TIMING.slowInterval;
        h.elapsed += interval;
        h.timer = setTimeout(tick, interval);
    };

    const attachStopListeners = (): (() => void) => {
        const stop = () => stopHold();
        const w = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
        const d = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null;
        w?.addEventListener('blur', stop);
        d?.addEventListener('visibilitychange', stop);
        return () => {
            w?.removeEventListener('blur', stop);
            d?.removeEventListener('visibilitychange', stop);
        };
    };

    const startHold = (dir: 1 | -1, e: PointerLikeEvent) => {
        if (e?.isPrimary === false) return;
        if (e?.pointerType === 'mouse' && (e.button ?? 0) > 0) return;
        stopHold();
        swallowClick.current = false;
        if (swallowTimer.current) { clearTimeout(swallowTimer.current); swallowTimer.current = null; }
        if (!canStep(latest.current)) return;
        hold.current = { dir, timer: setTimeout(tick, STEPPER_TIMING.holdDelay), elapsed: 0, ticked: false, detach: attachStopListeners() };
    };

    const clickStep = (dir: 1 | -1) => {
        if (swallowClick.current) {
            swallowClick.current = false;
            return;
        }
        const p = latest.current;
        if (!canStep(p)) return;
        if (isBound(p, dir)) { bump(dir); return; }
        p.onStep(dir);
    };

    // 停用即停止
    useEffect(() => {
        if (disabled || stepDisabled) stopHold();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [disabled, stepDisabled]);

    // 連續步進中到達界限：立即停止並給撞界回饋
    useEffect(() => {
        const h = hold.current;
        if (h && isBound(latest.current, h.dir)) {
            const dir = h.dir;
            h.ticked = true;
            stopHold();
            bump(dir);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [atMin, atMax]);

    // 外部帶入價格：外框閃一下（第一次渲染不閃）
    useEffect(() => {
        if (Object.is(prevFlashKey.current, flashKey)) return;
        prevFlashKey.current = flashKey;
        if (prefersReducedMotion()) {
            if (flashTimer.current) clearTimeout(flashTimer.current);
            setStaticFlash(true);
            flashTimer.current = setTimeout(() => { flashTimer.current = null; setStaticFlash(false); }, STEPPER_TIMING.flashStatic);
            return;
        }
        const el = flashRef.current as unknown as { animate?: (k: Keyframe[], o: KeyframeAnimationOptions) => unknown } | null;
        if (el && typeof el.animate === 'function') {
            try {
                el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: STEPPER_TIMING.flash, easing: 'ease-out' });
            } catch {
                // WAAPI 失敗只少一個視覺提示
            }
        }
    }, [flashKey]);

    // 卸載：清掉所有計時器、監聽與動畫
    useEffect(() => () => {
        stopHold();
        for (const t of [swallowTimer, boundTimer, flashTimer]) if (t.current) clearTimeout(t.current);
        bumpHandle.current?.stop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const keyProps = (dir: 1 | -1) => ({
        type: 'button' as const,
        className: `${styles.key} ${pressable} ${focusRing}`,
        disabled: disabled || stepDisabled,
        onClick: () => clickStep(dir),
        onPointerDown: (e: PointerLikeEvent) => startHold(dir, e),
        onPointerUp: endPointer,
        onPointerCancel: endPointer,
        onPointerLeave: endPointer,
        onLostPointerCapture: endPointer,
        // Android 長按會開內容選單：按住步進時不要
        onContextMenu: (e: { preventDefault?: () => void } | undefined) => e?.preventDefault?.(),
    });

    return (
        <div className={styles.root}>
            <div className={styles.row}>
                <button {...keyProps(-1)} aria-label={decLabel}>－</button>
                <div className={styles.field} ref={fieldRef}>
                    <input
                        className={unit ? `${styles.input} ${styles.inputWithUnit}` : styles.input}
                        aria-label={ariaLabel}
                        aria-describedby={boundText ? noteId : undefined}
                        data-testid={testId}
                        inputMode={inputMode}
                        autoComplete='off'
                        disabled={disabled}
                        aria-invalid={invalid || undefined}
                        value={value}
                        onChange={e => onChange(e.target.value)}
                        onBlur={() => onBlur?.()}
                    />
                    <span className={styles.flash} ref={flashRef} data-static={staticFlash ? 'true' : undefined} aria-hidden='true' />
                    {unit ? <span className={styles.unit} aria-hidden='true'>{unit}</span> : null}
                </div>
                <button {...keyProps(1)} aria-label={incLabel}>＋</button>
            </div>
            <p className={styles.boundNote} role='status' id={noteId} data-testid={testId ? `${testId}-bound` : undefined}>{boundText}</p>
        </div>
    );
}
