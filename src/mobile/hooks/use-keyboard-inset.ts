// src/mobile/hooks/use-keyboard-inset.ts — 螢幕鍵盤高度寫入面板 backdrop 的 --sj-kb（設計規格 §6.1「鍵盤」）
//
// - 監聽 visualViewport 的 resize／scroll：inset = max(0, innerHeight − vv.height − vv.offsetTop)。
// - 寫在目標元素（面板 backdrop）的 CSS 自訂屬性 --sj-kb；backdrop 以 padding-bottom 讓出鍵盤，
//   面板 max-height 隨之縮小，footer（CTA）留在鍵盤上方。
// - 沒有 visualViewport、目標不是真實節點（測試的 node mock）時不做事；停用或卸載時把 --sj-kb 歸零。
// - 實機若 iOS 15 偏移異常，後備為 inset=0（footer 隨面板），見設計規格 §16 第 3 項。

import { useEffect, type RefObject } from 'react';
import { SHELL_VAR } from '../styles/tokens';

export interface ViewportLike {
    height: number;
    offsetTop: number;
}

/** 鍵盤（或其他遮住版面底部的視窗縮小）高度，px；量不到時為 0 */
export function keyboardInset(innerHeight: number, vv: ViewportLike | null | undefined): number {
    if (!vv || !Number.isFinite(innerHeight) || !Number.isFinite(vv.height)) return 0;
    const offsetTop = Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0;
    return Math.max(0, Math.round(innerHeight - vv.height - offsetTop));
}

type StyleTarget = { style?: { setProperty?: (name: string, value: string) => void } } | null | undefined;

function writeInset(el: StyleTarget, px: number): void {
    try {
        el?.style?.setProperty?.(SHELL_VAR.kb, `${px}px`);
    } catch {
        // 忽略
    }
}

type VisualViewportLike = ViewportLike & {
    addEventListener?: (type: string, cb: () => void) => void;
    removeEventListener?: (type: string, cb: () => void) => void;
};

export function useKeyboardInset(target: RefObject<HTMLElement | null>, enabled: boolean): void {
    useEffect(() => {
        if (!enabled || typeof window === 'undefined') return;
        const vv = (window as unknown as { visualViewport?: VisualViewportLike }).visualViewport;
        if (!vv || typeof vv.addEventListener !== 'function') return;
        let last = -1;
        const update = () => {
            const px = keyboardInset(window.innerHeight, vv);
            if (px === last) return;
            last = px;
            writeInset(target.current, px);
        };
        update();
        vv.addEventListener('resize', update);
        vv.addEventListener('scroll', update);
        return () => {
            vv.removeEventListener?.('resize', update);
            vv.removeEventListener?.('scroll', update);
            writeInset(target.current, 0);
        };
    }, [target, enabled]);
}
