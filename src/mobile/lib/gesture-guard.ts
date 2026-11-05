// src/mobile/lib/gesture-guard.ts — 禁止頁面雙指縮放（使用者需求：「手勢縮放或選取到文字可以禁止嗎」）
//
// iOS Safari 10+ 為了無障礙會忽略 viewport 的 user-scalable=no／maximum-scale=1，
// 只能在 gesturestart／gesturechange／gestureend（Safari 專有）與兩指以上的 touchmove 上 preventDefault。
// - 監聽器以 { passive: false, capture: true } 掛在 document：必須非 passive 才能 preventDefault；
//   capture 讓子元素 stopPropagation 也擋得到。preventDefault 不會阻止事件送到元件自己的監聽器。
// - 單指 touchmove 一律不處理：不影響捲動、滑動確認、下拉面板與輸入框。
// - gesturestart／gesturechange／gestureend 不論目標在哪裡一律 preventDefault（頁面永遠不縮放）：
//   iOS 的頁面縮放由這三個事件驅動；lightweight-charts 的圖表雙指縮放只用 touchstart／touchmove，不受影響。
//   早期版本對 [data-allow-pinch] 內的 gesture 事件放行，但該屬性掛在整個圖表 frame 上，
//   價格軸／時間軸／委託線標籤／選價列都沒有自己的 pinch 處理，兩指放在這些位置會縮放整頁（審查 M-PLAT-2）。
// - [data-allow-pinch="true"] 只用來放行該區域內的兩指 touchmove，讓圖表 pane 自己的雙指縮放照常收到事件。
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

/** iOS gesture 事件：一律擋（不看 data-allow-pinch） */
function onGesture(e: Event): void {
    if (e.cancelable) e.preventDefault();
}

/** 兩指以上 touchmove：圖表區（data-allow-pinch）內放行給圖表自己的雙指縮放，其餘擋下 */
function onTouchMove(e: Event): void {
    const touches = (e as TouchEvent).touches;
    if (!touches || touches.length < 2) return;
    if (e.cancelable && !isInPinchAllowedArea(e.target)) e.preventDefault();
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
