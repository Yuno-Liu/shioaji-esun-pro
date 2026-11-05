// src/mobile/motion/gesture.ts — 拖曳追蹤、放手速度與拖曳後攔截 click（設計規格 §4.9、§5.2、§8）
//
// - usePointerDrag 一律回傳 React props（不以 ref 綁原生監聽）：既有測試直接呼叫 props.onPointerDown(...) 仍可運作。
// - 事件欄位容錯：只在 isPrimary === false 時拒絕（測試的假事件沒有 isPrimary）；滑鼠非左鍵拒絕；
//   座標缺欄位時沿用上一次的值（起點為 0）；時間取 e.timeStamp || motionNow()；setPointerCapture 以 ?. 呼叫並吞例外。
// - 只追蹤第一個指標；位移超過 slop 後才鎖定方向，不屬本軸立即放棄（交還原生捲動），確定軸向後才 capture。
// - pointercancel／lostpointercapture 走取消路徑（velocity 0、cancelled: true）。
// - 本模組只回報位置與速度；是否「送出」由呼叫端只看放手位置判定（§10 S2），速度只作回彈初速。

import { useRef, useState } from 'react';
import { GESTURE } from '../styles/tokens';
import { motionNow } from './spring';

/** 方向鎖定門檻（px）、速度窗 100ms、過期 50ms、click 攔截 350ms：唯一來源為 styles/tokens.ts 的 GESTURE */
const DEFAULT_SLOP = GESTURE.lockSlop;
const VELOCITY_WINDOW_MS = GESTURE.velocityWindowMs;
const VELOCITY_STALE_MS = GESTURE.velocityStaleMs;
const CLICK_SUPPRESS_MS = GESTURE.clickSuppressMs;

/** 面板拖曳不接手的起點（按鈕、連結、輸入、滑塊、明確標記） */
export const DRAG_EXCLUDE_SELECTOR = 'button, a, input, select, textarea, [role="slider"], [data-sheet-nodrag]';

/**
 * 速度追蹤：最近 100ms 樣本的最小平方斜率（px/s）；最後樣本早於 now 超過 50ms → 0。
 * 放手時由 createPointerDrag 先以「放手前最後一個移動樣本」判斷停頓，再加入放手樣本計算。
 */
export class VelocityTracker {
    private samples: { t: number; p: number }[] = [];

    reset(): void {
        this.samples = [];
    }

    /** 最後一個樣本的時間；沒有樣本為 null */
    lastTime(): number | null {
        const last = this.samples[this.samples.length - 1];
        return last ? last.t : null;
    }

    add(t: number, pos: number): void {
        if (!Number.isFinite(t) || !Number.isFinite(pos)) return;
        const last = this.samples[this.samples.length - 1];
        // 時間倒退（混用事件時間與時鐘）時重新開始，避免斜率失真
        if (last && t < last.t) this.samples = [];
        this.samples.push({ t, p: pos });
        const cutoff = t - VELOCITY_WINDOW_MS;
        while (this.samples.length > 2 && this.samples[0]!.t < cutoff) this.samples.shift();
    }

    velocity(now: number): number {
        const last = this.samples[this.samples.length - 1];
        if (!last || now - last.t > VELOCITY_STALE_MS) return 0;
        const pts = this.samples.filter(s => s.t >= now - VELOCITY_WINDOW_MS);
        if (pts.length < 2) return 0;
        let mt = 0;
        let mp = 0;
        for (const s of pts) { mt += s.t; mp += s.p; }
        mt /= pts.length;
        mp /= pts.length;
        let num = 0;
        let den = 0;
        for (const s of pts) {
            const dt = s.t - mt;
            num += dt * (s.p - mp);
            den += dt * dt;
        }
        return den > 0 ? (num / den) * 1000 : 0;
    }
}

/** 拖曳 handler 接受的事件形狀（React PointerEvent 與測試假事件皆可） */
export interface PointerLike {
    pointerId?: number;
    clientX?: number;
    clientY?: number;
    timeStamp?: number;
    isPrimary?: boolean;
    pointerType?: string;
    button?: number;
    target?: unknown;
    currentTarget?: unknown;
}

export interface DragInfo {
    pointerId: number;
    /** 按下時本軸座標 */
    start: number;
    /** 目前本軸座標 */
    position: number;
    /** 本軸位移（position − start，保留抓取偏移、1:1） */
    delta: number;
    /** 另一軸位移 */
    deltaCross: number;
    /** 按下時的 currentTarget（例如交給 suppressClicksAfterDrag） */
    element: unknown;
    /** 觸發這次回呼的事件 */
    event: PointerLike;
    /** 由呼叫端放棄這次拖曳（例如拖曳中變成不可關閉）：不再回呼，也不呼叫 onEnd */
    cancel(): void;
}

export interface DragEndInfo extends DragInfo {
    /** 放手速度（px/s）；取消時為 0 */
    velocity: number;
    cancelled: boolean;
}

export interface PointerDragOptions {
    axis: 'x' | 'y';
    /** 方向鎖定門檻（px），預設 10；把手類（touch-action:none）可設 0＝按下即開始並 capture */
    slop?: number;
    /** 按下時是否接手（例如起點不符合 DRAG_EXCLUDE_SELECTOR、當下可關閉） */
    canStart?(e: PointerLike): boolean;
    onStart?(i: DragInfo): void;
    onMove?(i: DragInfo): void;
    onEnd?(i: DragEndInfo): void;
}

export interface PointerDragProps {
    onPointerDown(e: PointerLike): void;
    onPointerMove(e: PointerLike): void;
    onPointerUp(e: PointerLike): void;
    onPointerCancel(e: PointerLike): void;
    onLostPointerCapture(e: PointerLike): void;
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function capture(el: unknown, pointerId: number): void {
    try {
        (el as { setPointerCapture?: (id: number) => void } | null | undefined)?.setPointerCapture?.(pointerId);
    } catch {
        // 指標已不在作用中（InvalidStateError）等：忽略，拖曳照常進行
    }
}

/** 不依賴 React 的拖曳狀態機；usePointerDrag 以它產生穩定的 handler */
export function createPointerDrag(getOptions: () => PointerDragOptions): PointerDragProps {
    let s: {
        id: number; x0: number; y0: number; x: number; y: number;
        element: unknown; started: boolean; captured: boolean;
    } | null = null;
    const tracker = new VelocityTracker();

    const info = (e: PointerLike): DragInfo => {
        const st = s!;
        const { axis } = getOptions();
        const main = axis === 'x' ? st.x : st.y;
        const start = axis === 'x' ? st.x0 : st.y0;
        const cross = axis === 'x' ? st.y - st.y0 : st.x - st.x0;
        return { pointerId: st.id, start, position: main, delta: main - start, deltaCross: cross, element: st.element, event: e, cancel: abandon };
    };
    function abandon(): void { s = null; tracker.reset(); }
    const time = (e: PointerLike) => num(e.timeStamp, 0) || motionNow();
    const update = (e: PointerLike, t: number = time(e)) => {
        const st = s!;
        st.x = num(e.clientX, st.x);
        st.y = num(e.clientY, st.y);
        tracker.add(t, getOptions().axis === 'x' ? st.x : st.y);
    };
    const begin = (e: PointerLike) => {
        const st = s!;
        st.started = true;
        if (!st.captured) { capture(e.currentTarget ?? st.element, st.id); st.captured = true; }
        getOptions().onStart?.(info(e));
    };
    const matches = (e: PointerLike) => !!s && num(e.pointerId, 0) === s.id;

    const end = (e: PointerLike, cancelled: boolean) => {
        if (!matches(e)) return;
        const st = s!;
        // 停頓判定看「放手前」最後一個樣本：放手樣本本身一定是最新的，先加入會讓 50ms 規則永遠不觸發（§5.2）
        const now = time(e);
        const lastMove = tracker.lastTime();
        const paused = lastMove === null || now - lastMove > VELOCITY_STALE_MS;
        if (!cancelled) update(e, now);
        const started = st.started;
        const i = info(e);
        const velocity = cancelled || paused ? 0 : tracker.velocity(now);
        s = null;
        tracker.reset();
        if (started) getOptions().onEnd?.({ ...i, velocity, cancelled });
    };

    return {
        onPointerDown(e) {
            if (s) return; // 只追蹤第一個指標
            if (e.isPrimary === false) return;
            if (e.pointerType === 'mouse' && num(e.button, 0) > 0) return;
            const o = getOptions();
            if (o.canStart && !o.canStart(e)) return;
            const x = num(e.clientX, 0);
            const y = num(e.clientY, 0);
            s = { id: num(e.pointerId, 0), x0: x, y0: y, x, y, element: e.currentTarget, started: false, captured: false };
            tracker.reset();
            tracker.add(time(e), o.axis === 'x' ? x : y);
            if ((o.slop ?? DEFAULT_SLOP) <= 0) begin(e);
        },
        onPointerMove(e) {
            if (!matches(e)) return;
            update(e);
            const st = s!;
            const o = getOptions();
            if (!st.started) {
                const dx = Math.abs(st.x - st.x0);
                const dy = Math.abs(st.y - st.y0);
                if (Math.max(dx, dy) <= (o.slop ?? DEFAULT_SLOP)) return;
                const mainD = o.axis === 'x' ? dx : dy;
                const crossD = o.axis === 'x' ? dy : dx;
                if (crossD > mainD) { abandon(); return; } // 不屬本軸：交還原生捲動
                begin(e);
                if (s !== st) return; // onStart 內放棄
            }
            o.onMove?.(info(e));
        },
        onPointerUp(e) { end(e, false); },
        onPointerCancel(e) { end(e, true); },
        onLostPointerCapture(e) { end(e, true); },
    };
}

/** 拖曳 hook：回傳可直接展開到元素上的 React props（handler 參照穩定，選項每次 render 更新） */
export function usePointerDrag(o: PointerDragOptions): PointerDragProps {
    const ref = useRef(o);
    ref.current = o;
    const [props] = useState(() => createPointerDrag(() => ref.current));
    return props;
}

/** 拖曳後 ms 內在 capture 階段攔下 el 內的 click（stopPropagation＋preventDefault）；el 不支援監聽時不做事 */
export function suppressClicksAfterDrag(el: Element, ms = CLICK_SUPPRESS_MS): void {
    const target = el as unknown as {
        addEventListener?: (t: string, h: (e: Event) => void, capture: boolean) => void;
        removeEventListener?: (t: string, h: (e: Event) => void, capture: boolean) => void;
    };
    if (typeof target?.addEventListener !== 'function') return;
    const until = Date.now() + ms;
    const handler = (e: Event) => {
        if (Date.now() > until) { remove(); return; }
        e.stopPropagation();
        e.preventDefault();
    };
    const remove = () => target.removeEventListener?.('click', handler, true);
    target.addEventListener('click', handler, true);
    setTimeout(remove, ms);
}
