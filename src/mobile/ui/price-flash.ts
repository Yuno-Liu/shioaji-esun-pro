// src/mobile/ui/price-flash.ts — 跳價閃爍（設計規格 §6.12、§13）
//
// usePriceFlash(ref, value, { enabled, source, masked })：ref 指向 price-flash.css.ts 的 overlay 覆蓋層。
// - 與上一筆比較：上漲寫 upFlash、下跌寫 downFlash 底色，element.animate([{opacity:1},{opacity:0}], 600ms ease-out)。
// - 同一格距上次閃爍 <350ms 不閃（節流）。
// - 不閃：第一次渲染、資料來源切換（快照→成交）、金額遮蔽、元素不可見（共用 IntersectionObserver）、
//   減少動態、enabled=false；沒有 element.animate（WAAPI）時略過。
// 顏色只用 vars.color.upFlash／downFlash（隨配色），不自訂 hex；只動畫 opacity。

import { useEffect, useRef, type RefObject } from 'react';
import { vars } from '../../theme.css';
import { prefersReducedMotion } from '../motion/prefs';
import { motionNow, writeStyle } from '../motion/spring';
import { DUR } from '../styles/tokens';

export interface PriceFlashOptions {
    /** false 時不閃（預設 true） */
    enabled?: boolean;
    /** 資料來源（例如 'snapshot'／'trade'）；改變的那一次不閃 */
    source?: string;
    /** 金額遮蔽中不閃 */
    masked?: boolean;
}

export type FlashDirection = 'up' | 'down';

/** 每格的比較狀態（純資料，供測試） */
export interface FlashGate {
    initialized: boolean;
    prev: number | null;
    source: string | undefined;
    /** 上次實際閃爍的時間（ms）；尚未閃過為 −∞ */
    lastAt: number;
}

export function createFlashGate(): FlashGate {
    return { initialized: false, prev: null, source: undefined, lastAt: Number.NEGATIVE_INFINITY };
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 決定這一筆要不要閃（並更新 gate）。allow 為 false（停用、遮蔽、不可見、減少動態、沒有 WAAPI）時只記錄數值。
 * 只有真的閃了才更新 lastAt：被節流或不允許的那筆不延長節流窗。
 */
export function nextFlash(g: FlashGate, value: number | null | undefined, source: string | undefined, now: number, allow: boolean): FlashDirection | null {
    const prev = g.prev;
    const prevSource = g.source;
    const first = !g.initialized;
    g.initialized = true;
    g.prev = finite(value) ? value : null;
    g.source = source;
    if (first || !allow) return null;
    if (prevSource !== source) return null;
    if (!finite(value) || prev === null || value === prev) return null;
    if (now - g.lastAt < DUR.flashGap) return null;
    g.lastAt = now;
    return value > prev ? 'up' : 'down';
}

// ---- 共用 IntersectionObserver（只閃可見格） ----

const visibility = new WeakMap<Element, boolean>();
let observer: IntersectionObserver | null = null;
let observed = 0;

function hasIO(): boolean {
    return typeof IntersectionObserver === 'function';
}

function observe(el: Element): () => void {
    if (!hasIO()) return () => undefined;
    try {
        if (!observer) {
            observer = new IntersectionObserver(entries => {
                for (const e of entries) visibility.set(e.target, e.isIntersecting);
            });
        }
        observer.observe(el);
        observed += 1;
    } catch {
        return () => undefined;
    }
    return () => {
        visibility.delete(el);
        try {
            observer?.unobserve(el);
        } catch {
            // 忽略
        }
        observed -= 1;
        if (observed <= 0) {
            observed = 0;
            observer?.disconnect();
            observer = null;
        }
    };
}

/** 元素目前是否可見：沒有 IntersectionObserver 時視為可見；有時以最近一次回報為準（尚未回報＝不可見） */
export function isFlashVisible(el: unknown): boolean {
    if (!hasIO()) return true;
    return !!el && typeof el === 'object' && visibility.get(el as Element) === true;
}

type Animatable = { animate?: (k: Keyframe[], o: KeyframeAnimationOptions) => unknown };

const canFlash = (el: unknown): el is Animatable & object =>
    !!el && typeof el === 'object' && typeof (el as Animatable).animate === 'function';

export function usePriceFlash(ref: RefObject<HTMLElement | null>, value: number | null | undefined, opts: PriceFlashOptions = {}): void {
    const gate = useRef<FlashGate | null>(null);
    if (!gate.current) gate.current = createFlashGate();
    const watch = useRef<{ el: Element | null; release: () => void }>({ el: null, release: () => undefined });

    // 追蹤覆蓋層節點（ref 指到的節點換了就重新觀察）
    useEffect(() => {
        const el = ref.current;
        if (watch.current.el === el) return;
        watch.current.release();
        watch.current = { el, release: el && typeof el === 'object' && 'nodeType' in el ? observe(el) : () => undefined };
    });
    useEffect(() => () => {
        watch.current.release();
        watch.current = { el: null, release: () => undefined };
    }, []);

    const { enabled = true, source, masked = false } = opts;
    useEffect(() => {
        const el = ref.current;
        const allow = enabled && !masked && canFlash(el) && isFlashVisible(el) && !prefersReducedMotion();
        const dir = nextFlash(gate.current!, value, source, motionNow(), allow);
        if (!dir || !canFlash(el)) return;
        writeStyle(el, { backgroundColor: dir === 'up' ? vars.color.upFlash : vars.color.downFlash });
        try {
            el.animate!([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.flash, easing: 'ease-out' });
        } catch {
            // WAAPI 失敗只少一個視覺提示
        }
    }, [value, source, masked, enabled, ref]);
}
