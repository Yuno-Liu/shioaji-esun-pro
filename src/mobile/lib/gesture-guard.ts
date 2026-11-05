// src/mobile/lib/gesture-guard.ts — 禁止頁面雙指縮放（使用者需求：「手勢縮放或選取到文字可以禁止嗎」）
//
// iOS Safari 10+ 為了無障礙會忽略 viewport 的 user-scalable=no／maximum-scale=1，
// 只能在 gesturestart／gesturechange／gestureend（Safari 專有）與兩指以上的 touchmove 上 preventDefault。
// - 監聽器以 { passive: false, capture: true } 掛在 document：必須非 passive 才能 preventDefault；
//   capture 讓子元素 stopPropagation 也擋得到。preventDefault 不會阻止事件送到元件自己的監聽器。
// - 單指 touchmove 一律不處理：不影響捲動、滑動確認、下拉面板與輸入框。
// - 目標在 [data-allow-pinch="true"] 之內（例如 K 線圖容器）時完全不處理，元件自己的雙指縮放照常運作；
//   該區域的頁面縮放由元件自己的 touch-action 控制。
// - 不可取消的事件（cancelable=false，例如捲動中的 touchmove）不呼叫 preventDefault，避免瀏覽器警告。
// 雙擊放大由全域 CSS touch-action: manipulation 處理（styles/layout.css.ts）。

/** 允許雙指縮放的區域屬性（圖表容器加上 data-allow-pinch="true"） */
export const ALLOW_PINCH_ATTR = 'data-allow-pinch';
export const ALLOW_PINCH_SELECTOR = '[data-allow-pinch="true"]';

export const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const;

const LISTENER_OPTIONS: AddEventListenerOptions = { passive: false, capture: true };
const INSTALLED = '__sjMobileGestureGuard';

interface NodeLike {
    closest?: (selector: string) => unknown;
    parentElement?: NodeLike | null;
}

/** 事件目標是否在允許雙指縮放的區域內（文字節點沒有 closest，改用父元素） */
export function isInPinchAllowedArea(target: EventTarget | null): boolean {
    let node = target as NodeLike | null;
    if (node && typeof node.closest !== 'function') node = node.parentElement ?? null;
    if (!node || typeof node.closest !== 'function') return false;
    return node.closest(ALLOW_PINCH_SELECTOR) != null;
}

function block(e: Event): void {
    if (e.cancelable && !isInPinchAllowedArea(e.target)) e.preventDefault();
}

function onGesture(e: Event): void {
    block(e);
}

function onTouchMove(e: Event): void {
    const touches = (e as TouchEvent).touches;
    if (!touches || touches.length < 2) return;
    block(e);
}

type GuardTarget = EventTarget & { [INSTALLED]?: () => void };

/**
 * 安裝手勢防護；回傳解除函式。同一個 target 重複安裝（例如 HMR 重新執行入口）只會有一組監聽器。
 */
export function installGestureGuard(target?: EventTarget | null): () => void {
    const t = (target ?? (typeof document === 'undefined' ? null : document)) as GuardTarget | null;
    if (!t || typeof t.addEventListener !== 'function') return () => undefined;
    const existing = t[INSTALLED];
    if (existing) return existing;
    for (const type of GESTURE_EVENTS) t.addEventListener(type, onGesture, LISTENER_OPTIONS);
    t.addEventListener('touchmove', onTouchMove, LISTENER_OPTIONS);
    const uninstall = () => {
        for (const type of GESTURE_EVENTS) t.removeEventListener(type, onGesture, LISTENER_OPTIONS);
        t.removeEventListener('touchmove', onTouchMove, LISTENER_OPTIONS);
        if (t[INSTALLED] === uninstall) delete t[INSTALLED];
    };
    t[INSTALLED] = uninstall;
    return uninstall;
}
