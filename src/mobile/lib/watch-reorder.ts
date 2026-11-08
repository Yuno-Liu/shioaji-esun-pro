// src/mobile/lib/watch-reorder.ts — 自選編輯模式的手指拖曳排序（設計規格 §8 手勢歸屬、§13 只動畫 transform）
//
// - 只有握把能拖（握把 touch-action: none＋pointer capture）；列的其他區域照常垂直捲動、點擊、長按。
// - 拖曳中不 setState：被拖的列以 transform 跟著手指，其他列即時以 transform 讓位（減少動態時不做讓位動畫）；
//   只有開始與結束各 setState 一次（拖曳中的列樣式）。
// - 手指靠近捲動容器（main）上下緣時自動捲動；底部扣掉 main 的 padding-bottom（＝分頁列＋配件槽 --sj-accessory-h）。
// - 放手時位置有變才呼叫一次 onMove(from, to)（use-watchlist 的 reorderSymbol：把 from 移到 to 的位置；每次是 GET＋PUT＋GET），
//   位置沒變不呼叫；pointercancel／失去 pointer capture 取消並還原；拖曳期間清單變動時放手也不呼叫。
// - 拖曳中與放手後 REORDER_CLICK_GUARD_MS 內 blocked() 為 true：呼叫端以此擋下列點擊與長按。
// - 鍵盤（握把上 ↑／↓）：一次移一格；忽略按住不放的自動重複（event.repeat）、停用（寫入中）時忽略，
//   上一次移動尚未反映到清單（REORDER_KEY_PENDING_MS 內）也忽略；清單順序更新後焦點回到被移動那列的握把，可連續移動。

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/** 自動捲動區：距可視上下緣這個距離內開始捲動（px） */
export const REORDER_EDGE_PX = 56;
/** 自動捲動最高速度（px／幀） */
export const REORDER_MAX_SPEED = 14;
/** 讓位動畫（ms；減少動態時 0） */
export const REORDER_SHIFT_MS = 160;
/** 放手後擋下列點擊的時間（ms） */
export const REORDER_CLICK_GUARD_MS = 350;
/** 移動超過這個距離（px）才算拖曳（點一下握把不算） */
export const REORDER_SLOP_PX = 4;
/** 鍵盤移動後、清單順序尚未更新時忽略方向鍵的最長時間（ms；移動沒被套用時不會永遠擋住） */
export const REORDER_KEY_PENDING_MS = 1_000;

export interface RowBox {
    top: number;
    height: number;
}

/** 被拖的列（第 from 列）位移 dy 後應落在的索引：以其他列的中線判斷 */
export function reorderIndex(rows: readonly RowBox[], from: number, dy: number): number {
    const r = rows[from];
    if (!r) return from;
    const center = r.top + r.height / 2 + dy;
    let target = from;
    for (let i = from - 1; i >= 0 && center < rows[i]!.top + rows[i]!.height / 2; i--) target = i;
    if (target !== from) return target;
    for (let i = from + 1; i < rows.length && center > rows[i]!.top + rows[i]!.height / 2; i++) target = i;
    return target;
}

/** 被拖的列從 from 落到 target 時，第 i 列的讓位位移（h＝被拖列的高度） */
export function reorderShift(i: number, from: number, target: number, h: number): number {
    if (target > from && i > from && i <= target) return -h;
    if (target < from && i >= target && i < from) return h;
    return 0;
}

/** 自動捲動速度（px／幀；負＝往上）：距上下緣 edge 內線性加速 */
export function autoScrollSpeed(y: number, top: number, bottom: number, edge = REORDER_EDGE_PX, max = REORDER_MAX_SPEED): number {
    if (y < top + edge) return -Math.ceil(max * Math.min(1, (top + edge - y) / edge));
    if (y > bottom - edge) return Math.ceil(max * Math.min(1, (y - (bottom - edge)) / edge));
    return 0;
}

/** 捲動容器的可視上下緣：底部扣掉 padding-bottom（main 的底部內距＝分頁列＋配件槽） */
export function scrollViewport(scroller: Element): { top: number; bottom: number } {
    const r = scroller.getBoundingClientRect();
    let pad = 0;
    try {
        pad = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
    } catch {
        pad = 0;
    }
    return { top: r.top, bottom: r.bottom - pad };
}

type StyledEl = Element & { style: CSSStyleDeclaration };

interface DragState {
    pointerId: number;
    from: number;
    target: number;
    codes: string[];
    rows: (RowBox & { el: StyledEl })[];
    startY: number;
    lastY: number;
    moved: boolean;
    scroller: Element | null;
    /** 捲動容器的可視上下緣（拖曳開始時量一次） */
    viewport: { top: number; bottom: number } | null;
    startScroll: number;
    raf: number | null;
}

export interface ListReorder {
    /** 拖曳中的代碼（開始與結束各更新一次） */
    dragging: string | null;
    /**
     * 拖曳中或剛放手：呼叫端擋下列點擊、長按。code＝被點的列（列點擊時傳入；自選多選中 WatchEditReorder 以此切換勾選並擋下）
     */
    blocked(code?: string): boolean;
    /** 握把事件（穩定的參照，列可 memo） */
    grip: {
        onPointerDown(code: string, e: ReactPointerEvent<HTMLElement>): void;
        onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
        onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
        onPointerCancel(e: ReactPointerEvent<HTMLElement>): void;
        /** 鍵盤／輔助技術在握把上按方向鍵：上下移一格 */
        onKeyDown(code: string, e: ReactKeyboardEvent<HTMLElement>): void;
        onClick(e: ReactMouseEvent<HTMLElement>): void;
    };
}

export function useListReorder({ listRef, codes, disabled, onMove, reducedMotion }: {
    listRef: RefObject<HTMLElement | null>;
    codes: readonly string[];
    disabled: boolean;
    onMove: (from: string, to: string) => void;
    /**
     * 系統減少動態（呼叫端傳 motion/prefs 的 prefersReducedMotion）。本檔不 import motion/prefs：本檔在延遲載入的
     * chunk（components/watch-edit-controls.tsx），若 import 會讓 prefs 從首屏共用 chunk 拆成另一個首屏請求。
     */
    reducedMotion: () => boolean;
}): ListReorder {
    const [dragging, setDragging] = useState<string | null>(null);
    const drag = useRef<DragState | null>(null);
    const guardUntil = useRef(0);
    const latest = useRef({ codes, disabled, onMove, reducedMotion });
    latest.current = { codes, disabled, onMove, reducedMotion };

    const grip = useRef<ListReorder['grip'] | null>(null);
    const helpers = useRef<{ finish(commit: boolean): void } | null>(null);
    /** 鍵盤移動：移動前的清單（順序更新後把焦點還給同一個握把） */
    const keyMove = useRef<{ el: HTMLElement; codes: readonly string[]; at: number } | null>(null);

    if (!grip.current) {
        const scrollDelta = (d: DragState) => (d.scroller ? d.scroller.scrollTop - d.startScroll : 0);
        const paint = (d: DragState) => {
            const dy = d.lastY - d.startY + scrollDelta(d);
            const dragged = d.rows[d.from]!;
            dragged.el.style.transform = `translateY(${dy}px)`;
            const target = reorderIndex(d.rows, d.from, dy);
            if (target === d.target) return;
            d.target = target;
            const transition = latest.current.reducedMotion() ? 'none' : `transform ${REORDER_SHIFT_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
            d.rows.forEach((r, i) => {
                if (i === d.from) return;
                const shift = reorderShift(i, d.from, target, dragged.height);
                r.el.style.transition = transition;
                r.el.style.transform = shift ? `translateY(${shift}px)` : '';
            });
        };
        const step = () => {
            const d = drag.current;
            if (!d) return;
            d.raf = null;
            if (!d.scroller || !d.viewport) return;
            const v = autoScrollSpeed(d.lastY, d.viewport.top, d.viewport.bottom);
            if (v === 0) return;
            const before = d.scroller.scrollTop;
            d.scroller.scrollTop = before + v;
            if (d.scroller.scrollTop === before) return; // 已到頂或底
            paint(d);
            d.raf = requestAnimationFrame(step);
        };
        const finish = (commit: boolean) => {
            const d = drag.current;
            if (!d) return;
            drag.current = null;
            if (d.raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(d.raf);
            for (const r of d.rows) {
                r.el.style.transition = 'none';
                r.el.style.transform = '';
                r.el.style.willChange = '';
            }
            setDragging(null);
            if (d.moved) guardUntil.current = Date.now() + REORDER_CLICK_GUARD_MS;
            if (!commit || d.target === d.from) return;
            const { codes: now, onMove: move } = latest.current;
            // 拖曳期間清單變了（其他裝置同步、移除）：不套用這次拖曳
            if (now.length !== d.codes.length || now.some((c, i) => c !== d.codes[i])) return;
            move(d.codes[d.from]!, d.codes[d.target]!);
        };
        helpers.current = { finish };
        grip.current = {
            onPointerDown(code, e) {
                const { codes: list, disabled: off } = latest.current;
                if (off || drag.current) return;
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                const root = listRef.current;
                if (!root) return;
                const els = Array.from(root.children).filter(el => el.getAttribute('data-code') !== null) as StyledEl[];
                const from = list.indexOf(code);
                if (from < 0 || els.length !== list.length || els.some((el, i) => el.getAttribute('data-code') !== list[i])) return;
                e.preventDefault();
                try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                    // 沒有 pointer capture（舊瀏覽器、測試）：仍可拖，只是手指離開握把後收不到事件
                }
                const scroller = typeof root.closest === 'function' ? root.closest('main') : null;
                const rows = els.map(el => {
                    const r = el.getBoundingClientRect();
                    el.style.transition = 'none';
                    return { el, top: r.top, height: r.height };
                });
                rows[from]!.el.style.willChange = 'transform';
                drag.current = {
                    pointerId: e.pointerId,
                    from,
                    target: from,
                    codes: [...list],
                    rows,
                    startY: e.clientY,
                    lastY: e.clientY,
                    moved: false,
                    scroller,
                    viewport: scroller ? scrollViewport(scroller) : null,
                    startScroll: scroller ? scroller.scrollTop : 0,
                    raf: null,
                };
                setDragging(code);
            },
            onPointerMove(e) {
                const d = drag.current;
                if (!d || e.pointerId !== d.pointerId) return;
                d.lastY = e.clientY;
                if (Math.abs(d.lastY - d.startY) > REORDER_SLOP_PX) d.moved = true;
                paint(d);
                // 進入上下緣的捲動區才排 rAF（離開後 step 自行停止）
                if (d.raf === null && d.viewport && typeof requestAnimationFrame === 'function'
                    && autoScrollSpeed(d.lastY, d.viewport.top, d.viewport.bottom) !== 0) d.raf = requestAnimationFrame(step);
            },
            onPointerUp(e) {
                const d = drag.current;
                if (!d || e.pointerId !== d.pointerId) return;
                d.lastY = e.clientY;
                paint(d);
                finish(true);
            },
            onPointerCancel(e) {
                const d = drag.current;
                if (!d || e.pointerId !== d.pointerId) return;
                finish(false);
            },
            onKeyDown(code, e) {
                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                const { codes: list, disabled: off, onMove: move } = latest.current;
                e.preventDefault();
                // 按住不放的自動重複、停用（寫入中）、拖曳中：忽略
                if (e.repeat || off || drag.current) return;
                // 上一次鍵盤移動還沒反映到清單：忽略（避免以舊順序計算目標）
                const pending = keyMove.current;
                if (pending && pending.codes === list && Date.now() - pending.at < REORDER_KEY_PENDING_MS) return;
                const i = list.indexOf(code);
                const j = i + (e.key === 'ArrowUp' ? -1 : 1);
                if (i < 0 || j < 0 || j >= list.length) return;
                keyMove.current = { el: e.currentTarget, codes: list, at: Date.now() };
                move(code, list[j]!);
            },
            onClick(e) {
                // 握把本身沒有點擊動作；避免冒泡成其他行為
                e.preventDefault();
            },
        };
    }

    // 鍵盤移動後清單順序更新：焦點回到被移動那列的握把（列以代碼為 key，握把是同一個元素；
    // DOM 搬移時瀏覽器可能讓它失焦），可以接著再按方向鍵
    useLayoutEffect(() => {
        const k = keyMove.current;
        if (!k || k.codes === codes) return;
        keyMove.current = null;
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        if (active !== k.el && typeof k.el.focus === 'function') k.el.focus();
    }, [codes]);

    // 寫入中停用：拖曳到一半變成忙碌時取消並還原；卸載時也還原
    useEffect(() => {
        if (disabled) helpers.current?.finish(false);
    }, [disabled]);
    useEffect(() => () => helpers.current?.finish(false), []);

    const blocked = useCallback(() => drag.current !== null || Date.now() < guardUntil.current, []);
    return { dragging, blocked, grip: grip.current };
}
