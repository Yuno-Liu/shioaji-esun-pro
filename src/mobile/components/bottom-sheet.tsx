// src/mobile/components/bottom-sheet.tsx — 共用底部面板 v2（下單、確認、委託操作、帳戶切換、連線詳情；設計規格 §6.1、§6.2）
//
// - pinned：標題列下方的固定區（不捲動、不在拖曳區），給必須一直看得到的安全資訊（確認面板環境橫幅，§10 S6）。
// - 拖曳門檻 GESTURE.lockSlop：沒有位移的單點不進入拖曳（不停住進場、不判定關閉）。
// - 關閉方式：點暗化幕、在把手／標題區往下拖曳放手（sheetReleaseDecision）、Esc（由 lib/sheet-stack 只交給最上層）、
//   標題列的「關閉」。dismissible=false 時全部無效：按把手或點暗化幕只輕彈 6px，不呼叫 onClose（送出中避免面板消失）。
// - 拖曳中變成不可關閉（例如進入送出中）：立即取消拖曳並回到 0（T6）。
// - 生命週期（可動畫時）：entering（從面板高度以 spring.sheet 到 0）→ open（settled）→ open=false 立即解除堆疊註冊、
//   還原焦點、exiting（凍結最後一次的 children／title／tone／footer／dismissible，testId 改 `${testId}-closing`，
//   inert＋aria-hidden＋pointer-events none；pinned 一併凍結）→ closed（render null、onExited）。退場中又 open=true：從目前位置反向進場。
// - 同步模式（測試、無 DOM、node mock 沒有 style／isConnected）：open 立即就緒、關閉立即卸載；拖曳位移改存 React state，
//   panel 的 React style 恰為 offset > 0 ? { transform: `translateY(${offset}px)` } : undefined（與舊版格式一致）。
//   可動畫時 React style 恆為 undefined，位移由彈簧直接寫 element.style（只動畫 transform／opacity）。
// - Portal：SheetRootContext 為元素時 createPortal 到殼層；'inline'（預設、測試）原地渲染；null 時該幀不渲染。
//   backdrop 對 React 的 click／pointerdown 呼叫 stopPropagation（portal 事件不冒泡到頁面祖先）；keydown 不攔。
// - tone：'buy'／'sell' 時以兩層 upDim／downDim 與 3px 方向色條著色（交叉淡化），買賣顏色只用 vars.color.up／down。

import { X } from 'lucide-react';
import {
    useCallback,
    useContext,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useKeyboardInset } from '../hooks/use-keyboard-inset';
import { registerSheet, useSheetStack } from '../lib/sheet-stack';
import { DRAG_EXCLUDE_SELECTOR, suppressClicksAfterDrag, usePointerDrag, type DragEndInfo, type PointerLike } from '../motion/gesture';
import { haptic } from '../motion/haptics';
import { prefersReducedMotion } from '../motion/prefs';
import { animateSpring, animateTween, canAnimate, motionNow, project, rubberband, springAt, SPRINGS, writeStyle, type SpringConfig, type SpringHandle } from '../motion/spring';
import * as styles from '../styles/sheet.css';
import { DUR, GESTURE, Z } from '../styles/tokens';
import { SheetFooterTargetContext, SheetPresenceContext, SheetRootContext, type SheetPresence } from '../ui/sheet-context';

/** 量不到面板高度時：往下拖曳超過這個距離（px）放開即關閉；量得到時門檻為 max(這個值, 高度 × 0.5) */
export const DISMISS_DRAG_PX = 80;

/** 不可關閉面板的輕彈幅度（px） */
export const SHEET_BUMP_PX = 6;
/** 拖曳位移超過這個值（px）才在放手後攔截 click */
const CLICK_GUARD_PX = 2;

export interface BottomSheetProps {
    open: boolean;
    /** 使用者要求關閉（暗化幕、下拉、Esc、關閉鈕）；父層決定是否真的關閉 */
    onClose: () => void;
    title?: ReactNode;
    children: ReactNode;
    /** false：不能以暗化幕、下拉、Esc、關閉鈕關閉；預設 true */
    dismissible?: boolean;
    /** 疊層：一般面板（預設）或確認面板（永遠在一般面板之上） */
    layer?: 'sheet' | 'confirm';
    /** 沒有 title 時的無障礙名稱 */
    ariaLabel?: string;
    testId?: string;
    /** 買賣方向著色：buy＝vars.color.up、sell＝vars.color.down 的淡色底＋3px 色條；null／缺省＝中性 */
    tone?: 'buy' | 'sell' | null;
    /** fit＝內容高度（預設）；large＝固定可用最大高度。兩者頂端都不進入狀態列區域 */
    detent?: 'fit' | 'large';
    /** 固定在底部、不隨內容捲動 */
    footer?: ReactNode;
    /** 固定在標題列下方、不隨內容捲動（例如確認面板的環境橫幅：視窗再矮也一直看得到，§10 S6）；不在拖曳區內 */
    pinned?: ReactNode;
    /** 進場時焦點：預設 'title'（沒有 title 時 'panel'） */
    initialFocus?: 'title' | 'panel';
    /** 退場結束或同步卸載後呼叫 */
    onExited?: () => void;
}

/**
 * 放手判定（§6.1）：不可關閉或沒有往下 → stay；快速下甩（≥1000px/s 且 >10px）→ dismiss；
 * 量不到高度沿用 80px 舊規則；否則以減速率 0.99 投射（vy × 0.099）後與 max(80, 高度一半) 比較。
 */
export function sheetReleaseDecision({ y, vy, height, dismissible }: { y: number; vy: number; height: number; dismissible: boolean }): 'dismiss' | 'stay' {
    if (!dismissible || !(y > 0)) return 'stay';
    if (vy >= GESTURE.dismissVelocity && y > 10) return 'dismiss';
    if (!(height > 0)) return y >= DISMISS_DRAG_PX ? 'dismiss' : 'stay';
    const projected = y + project(Number.isFinite(vy) ? vy : 0, GESTURE.sheetDeceleration);
    return projected >= Math.max(DISMISS_DRAG_PX, height * 0.5) ? 'dismiss' : 'stay';
}

/** 面板內容的 footer：有 footer 目標（真實 DOM）時 portal 進面板的固定 footer，否則原地渲染（測試維持原地） */
export function SheetFooter({ children }: { children: ReactNode }) {
    const target = useContext(SheetFooterTargetContext);
    if (target) return createPortal(children, target);
    return <>{children}</>;
}

// ---- 內部工具 ----

type Phase = 'closed' | 'entering' | 'open' | 'exiting';

interface Frozen {
    title: ReactNode;
    children: ReactNode;
    tone: 'buy' | 'sell' | null;
    footer: ReactNode;
    pinned: ReactNode;
    dismissible: boolean;
    stackIndex: number;
}

let bumpVelocityCache = 0;
/** 以 spring.bump 從 0 出發、峰值恰為 SHEET_BUMP_PX 的初速（px/s） */
function bumpVelocity(): number {
    if (bumpVelocityCache > 0) return bumpVelocityCache;
    let peak = 0;
    for (let t = 0; t <= 0.4; t += 0.002) peak = Math.max(peak, springAt(SPRINGS.bump, 0, 1, t).x);
    bumpVelocityCache = peak > 0 ? SHEET_BUMP_PX / peak : 300;
    return bumpVelocityCache;
}

function isDomElement(el: unknown): el is HTMLElement {
    return typeof HTMLElement !== 'undefined' && el instanceof HTMLElement;
}

function measureHeight(el: unknown): number {
    const n = el as { getBoundingClientRect?: () => { height?: number }; offsetHeight?: number } | null;
    if (!n) return 0;
    try {
        const h = n.getBoundingClientRect?.().height;
        if (typeof h === 'number' && h > 0) return h;
    } catch {
        // 忽略
    }
    return typeof n.offsetHeight === 'number' && n.offsetHeight > 0 ? n.offsetHeight : 0;
}

function focusEl(el: unknown): void {
    try {
        (el as { focus?: (o?: FocusOptions) => void } | null)?.focus?.({ preventScroll: true });
    } catch {
        // 忽略
    }
}

function nextFrame(cb: () => void): void {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
    else setTimeout(cb, 16);
}

function activeElement(): Element | null {
    try {
        return typeof document === 'undefined' ? null : document.activeElement;
    } catch {
        return null;
    }
}

/** 退場開始時把焦點還給觸發元素：仍連到文件、不在 inert／aria-hidden 區，且焦點沒有被移到別處 */
function restoreFocus(trigger: Element | null, panel: unknown): void {
    const t = trigger as (Element & { isConnected?: boolean }) | null;
    if (!t || !t.isConnected || t.closest?.('[inert], [aria-hidden="true"]')) return;
    const active = activeElement();
    const bodyEl = typeof document === 'undefined' ? null : document.body;
    const inPanel = !!active && !!(panel as { contains?: (n: unknown) => boolean } | null)?.contains?.(active);
    if (active && active !== bodyEl && !inPanel) return;
    focusEl(t);
}

function excluded(e: PointerLike): boolean {
    const t = e.target as { closest?: (s: string) => unknown } | null | undefined;
    return !!t?.closest?.(DRAG_EXCLUDE_SELECTOR);
}

const releaseConfig = (v: number): SpringConfig => (Math.abs(v) >= GESTURE.flingVelocity ? SPRINGS.sheetFling : SPRINGS.sheet);

export function BottomSheet({
    open, onClose, title, children, dismissible = true, layer = 'sheet', ariaLabel, testId, tone = null,
    detent = 'fit', footer, pinned, initialFocus, onExited,
}: BottomSheetProps) {
    const root = useContext(SheetRootContext);
    const titleId = useId();

    const backdropRef = useRef<HTMLDivElement | null>(null);
    const scrimRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const titleRef = useRef<HTMLHeadingElement | null>(null);
    const [footerEl, setFooterEl] = useState<HTMLElement | null>(null);
    const footerRef = useCallback((el: HTMLDivElement | null) => setFooterEl(isDomElement(el) ? el : null), []);

    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const onExitedRef = useRef(onExited);
    onExitedRef.current = onExited;
    const dismissibleRef = useRef(dismissible);
    dismissibleRef.current = dismissible;
    const openRef = useRef(open);
    openRef.current = open;

    // ---- 進退場狀態 ----
    const [phase, setPhaseState] = useState<Phase>('closed');
    const phaseRef = useRef<Phase>('closed');
    const go = useCallback((p: Phase) => { phaseRef.current = p; setPhaseState(p); }, []);
    const [shownAt, setShownAt] = useState(0);
    const exitingRef = useRef(false);

    // ---- 堆疊 ----
    const stack = useSheetStack();
    const [stackId, setStackId] = useState<number | null>(null);
    const liveIndex = open && stackId !== null ? stack.indexOf(stackId) : -1;
    const pushed = liveIndex >= 0 && stack.topId !== stackId;

    // 開啟中記住最後一次內容；退場中沿用（凍結）
    const frozen = useRef<Frozen>({ title, children, tone, footer, pinned, dismissible, stackIndex: -1 });
    if (open) frozen.current = { title, children, tone, footer, pinned, dismissible, stackIndex: liveIndex };
    const shown = frozen.current;

    // ---- 位移（可動畫時直接寫 style） ----
    const yRef = useRef(0);
    const pRef = useRef(0);
    const heightRef = useRef(0);
    const opacityRef = useRef(1);
    const ySpring = useRef<SpringHandle | null>(null);
    const pSpring = useRef<SpringHandle | null>(null);
    const releaseVelocity = useRef(0);
    const triggerRef = useRef<Element | null>(null);
    const [offset, setOffset] = useState(0); // 同步模式（測試）的後備位移

    const applyTransform = useCallback(() => {
        const panel = panelRef.current;
        if (!canAnimate(panel)) return;
        const y = yRef.current;
        const p = pRef.current;
        const t = p > 0.0005
            ? `translateY(${y - 6 * p}px) scale(${1 - 0.06 * p})`
            : Math.abs(y) > 0.01 ? `translateY(${y}px)` : 'none';
        writeStyle(panel, { transform: t });
        const h = heightRef.current;
        const o = h > 0 ? Math.min(1, Math.max(0, 1 - y / h)) : 1;
        writeStyle(scrimRef.current, { opacity: String(o * opacityRef.current) });
    }, []);

    const writeOpacity = useCallback((o: number) => {
        opacityRef.current = o;
        writeStyle(panelRef.current, { opacity: o >= 1 ? null : String(o) });
        applyTransform();
    }, [applyTransform]);

    /**
     * 停止 ySpring。被中斷的若是減少動態的淡入／淡出（tween 也存在 ySpring），面板與暗化幕的不透明度
     * 立即回到最終值 1：之後只剩位移動畫（拖曳、回彈、輕彈），不能讓面板（含環境橫幅與滑塊）停在半透明（§9）。
     * 退場淡出只會被 fade(1)（反向進場）或 finishExit 中斷，兩者都不走這裡。
     */
    const stopY = useCallback(() => {
        ySpring.current?.stop();
        ySpring.current = null;
        if (opacityRef.current < 1) writeOpacity(1);
    }, [writeOpacity]);

    const animateY = useCallback((to: number, velocity: number, config: SpringConfig, onRest?: () => void) => {
        stopY();
        ySpring.current = animateSpring({
            from: yRef.current,
            to,
            velocity,
            config,
            el: panelRef.current,
            onUpdate: v => { yRef.current = v; applyTransform(); },
            onRest,
        });
    }, [applyTransform, stopY]);

    const fade = useCallback((to: number, onRest?: () => void) => {
        ySpring.current?.stop();
        ySpring.current = animateTween({
            from: opacityRef.current,
            to,
            durationMs: DUR.fade,
            el: panelRef.current,
            onUpdate: writeOpacity,
            onRest,
        });
    }, [writeOpacity]);

    const finishExit = useCallback(() => {
        ySpring.current?.stop();
        pSpring.current?.stop();
        ySpring.current = null;
        pSpring.current = null;
        yRef.current = 0;
        pRef.current = 0;
        opacityRef.current = 1;
        go('closed');
        onExitedRef.current?.();
    }, [go]);

    // 堆疊註冊：open 為真時註冊；open 變 false（退場開始）立即解除
    useLayoutEffect(() => {
        if (!open) return;
        const reg = registerSheet({
            layer,
            getPanel: () => panelRef.current,
            isDismissible: () => dismissibleRef.current,
            requestClose: () => onCloseRef.current(),
        });
        setStackId(reg.id);
        return () => reg.unregister();
    }, [open, layer]);

    // 進場與退場
    useLayoutEffect(() => {
        exitingRef.current = !open;
        const panel = panelRef.current;
        if (open) {
            const reentry = phaseRef.current === 'exiting';
            if (!reentry) triggerRef.current = activeElement();
            setShownAt(motionNow());
            go('entering');
            const wantTitle = (initialFocus ?? (title ? 'title' : 'panel')) === 'title';
            focusEl(wantTitle && titleRef.current ? titleRef.current : panel);
            if (!canAnimate(panel)) { go('open'); return; }
            heightRef.current = measureHeight(panel);
            if (prefersReducedMotion()) {
                // 減少動態：不位移、不縮放，150ms 淡入
                ySpring.current?.stop();
                yRef.current = 0;
                if (!reentry) writeOpacity(0);
                fade(1, () => go('open'));
                return;
            }
            if (!reentry) {
                yRef.current = heightRef.current;
                applyTransform();
            }
            animateY(0, 0, SPRINGS.sheet, () => go('open'));
            return;
        }
        if (phaseRef.current === 'closed') return;
        const trigger = triggerRef.current;
        triggerRef.current = null;
        // 下一幀再還原焦點：等殼層依堆疊深度解除背景 inert／aria-hidden
        if (trigger) nextFrame(() => restoreFocus(trigger, panelRef.current));
        if (!canAnimate(panel)) { finishExit(); return; }
        go('exiting');
        const v = releaseVelocity.current;
        releaseVelocity.current = 0;
        if (prefersReducedMotion()) { fade(0, finishExit); return; }
        const h = measureHeight(panel) || heightRef.current || (typeof window === 'undefined' ? 0 : window.innerHeight);
        heightRef.current = h;
        animateY(h, v, releaseConfig(v), finishExit);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // 堆疊後退：已註冊但不是最上層 → 縮 6%、上移 6px（減少動態時不縮放，只靠上層暗化幕）
    useEffect(() => {
        const target = pushed && !prefersReducedMotion() ? 1 : 0;
        if (pRef.current === target && !pSpring.current) return;
        pSpring.current?.stop();
        pSpring.current = animateSpring({
            from: pRef.current,
            to: target,
            config: SPRINGS.sheet,
            restDelta: 0.001,
            restSpeed: 0.01,
            el: panelRef.current,
            onUpdate: v => { pRef.current = v; applyTransform(); },
            onRest: () => { pSpring.current = null; },
        });
    }, [pushed, applyTransform]);

    // 卸載時停止動畫
    useEffect(() => () => { ySpring.current?.stop(); pSpring.current?.stop(); }, []);

    useKeyboardInset(backdropRef, open);

    // ---- 拖曳（只限 grabArea） ----
    const dragCancel = useRef<(() => void) | null>(null);
    const dragFrom = useRef(0);

    const settleBack = useCallback((velocity: number) => {
        if (!canAnimate(panelRef.current)) { setOffset(0); return; }
        animateY(0, velocity, releaseConfig(velocity));
    }, [animateY]);

    const cancelDrag = useCallback(() => {
        const cancel = dragCancel.current;
        dragCancel.current = null;
        cancel?.();
        settleBack(0);
    }, [settleBack]);

    // 拖曳中變成不可關閉（送出中）：立即取消拖曳並回到 0（T6）
    useEffect(() => {
        if (!dismissible && dragCancel.current) cancelDrag();
    }, [dismissible, cancelDrag]);

    /** 不可關閉：spring.bump 往下輕彈 6px 再回原位；不跟手、不呼叫 onClose（減少動態時不位移） */
    const bump = () => {
        haptic('bound');
        if (!canAnimate(panelRef.current) || phaseRef.current !== 'open' || dragCancel.current) return;
        stopY();
        ySpring.current = animateSpring({
            from: yRef.current,
            to: 0,
            velocity: bumpVelocity(),
            config: SPRINGS.bump,
            el: panelRef.current,
            onUpdate: v => { yRef.current = v; applyTransform(); },
        });
    };

    const release = (i: DragEndInfo) => {
        dragCancel.current = null;
        if (i.cancelled) { settleBack(0); return; }
        if (Math.abs(i.delta) > CLICK_GUARD_PX && i.element) suppressClicksAfterDrag(i.element as Element);
        const fallback = !canAnimate(panelRef.current);
        const y = fallback ? Math.max(0, i.delta) : yRef.current;
        const decision = sheetReleaseDecision({ y, vy: i.velocity, height: fallback ? 0 : heightRef.current, dismissible: dismissibleRef.current });
        if (decision === 'stay') { settleBack(i.velocity); return; }
        if (fallback) { setOffset(0); onCloseRef.current(); return; }
        // 保持目前位置；open 變 false 時以放手速度進入退場
        releaseVelocity.current = i.velocity;
        onCloseRef.current();
        // 下一幀 open 仍為真：父層拒絕關閉 → 回到 0
        nextFrame(() => {
            releaseVelocity.current = 0;
            if (openRef.current && phaseRef.current !== 'exiting' && phaseRef.current !== 'closed') animateY(0, 0, SPRINGS.sheet);
        });
    };

    // 位移超過 GESTURE.lockSlop 才進入拖曳：沒有位移的單點不停住進場動畫、放手也不判定關閉
    const drag = usePointerDrag({
        axis: 'y',
        slop: GESTURE.lockSlop,
        canStart: e => dismissibleRef.current && !exitingRef.current && !excluded(e),
        onStart: i => {
            dragCancel.current = i.cancel;
            if (!canAnimate(panelRef.current)) { dragFrom.current = 0; return; }
            stopY(); // 減少動態的進場淡入被拖曳中斷：不透明度回到 1
            if (phaseRef.current === 'entering') go('open'); // 進場中被抓住：視為就緒，從畫面上的位置接手
            dragFrom.current = yRef.current;
            heightRef.current = measureHeight(panelRef.current) || heightRef.current;
        },
        onMove: i => {
            if (!dismissibleRef.current) { cancelDrag(); return; }
            if (!canAnimate(panelRef.current)) { setOffset(Math.max(0, i.delta)); return; }
            const raw = dragFrom.current + i.delta;
            yRef.current = raw >= 0 ? raw : rubberband(raw, heightRef.current, GESTURE.rubberband);
            applyTransform();
        },
        onEnd: release,
    });

    const onGrabPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!dismissibleRef.current && !exitingRef.current && !excluded(e)) bump();
        drag.onPointerDown(e);
    };

    const onBackdropClick = (e: ReactMouseEvent<HTMLDivElement>) => {
        e.stopPropagation?.();
        if (e.target !== e.currentTarget || exitingRef.current) return;
        if (dismissibleRef.current) onCloseRef.current();
        else bump();
    };
    const onBackdropPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => { e.stopPropagation?.(); };

    // ---- context ----
    const presencePhase: SheetPresence['phase'] = !open ? 'exiting' : phase === 'open' ? 'open' : 'entering';
    const presence = useMemo<SheetPresence>(() => ({
        phase: presencePhase,
        settled: presencePhase === 'open',
        shownAt,
        isExiting: () => exitingRef.current,
    }), [presencePhase, shownAt]);

    // ---- render ----
    // 同步模式（節點不能動畫）：關閉立即卸載；可動畫時保留凍結內容直到退場結束
    if (!open && (phase === 'closed' || !canAnimate(panelRef.current))) return null;
    if (root === null) return null;

    const exiting = !open;
    const stackIndex = shown.stackIndex;
    const baseZ = layer === 'confirm' ? Z.confirm : Z.sheet;
    const dataPhase = presencePhase;
    const sheetTitle = shown.title;
    const showClose = shown.dismissible;

    const content = (
        <SheetPresenceContext.Provider value={presence}>
            <div
                ref={backdropRef}
                className={layer === 'confirm' ? `${styles.backdrop} ${styles.backdropConfirm}` : styles.backdrop}
                data-testid={testId ? (exiting ? `${testId}-closing-backdrop` : `${testId}-backdrop`) : undefined}
                data-layer={layer}
                data-stacked={stackIndex > 0 ? 'true' : 'false'}
                data-phase={dataPhase}
                style={stackIndex > 0 ? { zIndex: baseZ + Z.sheetStep * stackIndex } : undefined}
                onClick={onBackdropClick}
                onPointerDown={onBackdropPointerDown}
            >
                <div ref={scrimRef} className={styles.scrim} aria-hidden='true' />
                <div
                    ref={panelRef}
                    className={styles.panel}
                    role='dialog'
                    aria-modal='true'
                    aria-labelledby={sheetTitle ? titleId : undefined}
                    aria-label={sheetTitle ? undefined : ariaLabel}
                    aria-hidden={exiting ? 'true' : undefined}
                    inert={exiting || undefined}
                    tabIndex={-1}
                    data-testid={testId ? (exiting ? `${testId}-closing` : testId) : undefined}
                    data-tone={shown.tone ?? undefined}
                    data-detent={detent}
                    data-phase={dataPhase}
                    style={offset > 0 ? { transform: `translateY(${offset}px)` } : undefined}
                >
                    <div className={styles.toneLayer.buy} aria-hidden='true' />
                    <div className={styles.toneLayer.sell} aria-hidden='true' />
                    <div
                        className={styles.grabArea}
                        data-testid={testId ? `${testId}-grab` : undefined}
                        onPointerDown={onGrabPointerDown}
                        onPointerMove={drag.onPointerMove}
                        onPointerUp={drag.onPointerUp}
                        onPointerCancel={drag.onPointerCancel}
                        onLostPointerCapture={drag.onLostPointerCapture}
                    >
                        <div className={styles.handle} aria-hidden='true' />
                        {(sheetTitle || showClose) && (
                            <div className={styles.header}>
                                {sheetTitle
                                    ? <h2 ref={titleRef} id={titleId} className={styles.title} tabIndex={-1}>{sheetTitle}</h2>
                                    : <span className={styles.title} />}
                                {showClose && (
                                    <button type='button' className={styles.closeButton} onClick={() => onCloseRef.current()} aria-label='關閉'>
                                        <span className={styles.closeGlyph} aria-hidden='true'><X size={18} strokeWidth={2.5} /></span>
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                    {shown.pinned != null && <div className={styles.pinned} data-sheet-pinned=''>{shown.pinned}</div>}
                    <SheetFooterTargetContext.Provider value={footerEl}>
                        <div className={styles.body} data-sheet-body=''>{shown.children}</div>
                        <div ref={footerRef} className={styles.footer} data-sheet-footer=''>{shown.footer}</div>
                    </SheetFooterTargetContext.Provider>
                </div>
            </div>
        </SheetPresenceContext.Provider>
    );

    return root === 'inline' ? content : createPortal(content, root);
}
