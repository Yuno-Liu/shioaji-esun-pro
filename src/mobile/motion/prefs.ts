// src/mobile/motion/prefs.ts — 系統動態與透明度偏好（設計規格 §5.3、§9）
//
// - 減少動態只跟系統（matchMedia '(prefers-reduced-motion: reduce)'），本輪沒有 App 內開關；沒有 matchMedia 時為 false。
// - 降低透明度：html[data-sj-transparency="reduced"]（App 內開關或低階 Android 預設，見 lib/ui-settings.ts），
//   或屬性不是 "full" 且系統 '(prefers-reduced-transparency: reduce)' 成立（iOS Safari 不支援此查詢，只能靠 App 內開關）。

import { useSyncExternalStore } from 'react';
import { REDUCED_MOTION as REDUCED_MOTION_QUERY, REDUCED_TRANSPARENCY as REDUCED_TRANSPARENCY_QUERY } from '../styles/tokens';

export const TRANSPARENCY_ATTR = 'data-sj-transparency';

type MqlLike = {
    matches: boolean;
    addEventListener?: (type: 'change', cb: () => void) => void;
    removeEventListener?: (type: 'change', cb: () => void) => void;
    addListener?: (cb: () => void) => void;
    removeListener?: (cb: () => void) => void;
};

function query(q: string): MqlLike | null {
    try {
        return typeof matchMedia === 'function' ? (matchMedia(q) as unknown as MqlLike) : null;
    } catch {
        return null;
    }
}

export function prefersReducedMotion(): boolean {
    return !!query(REDUCED_MOTION_QUERY)?.matches;
}

/** 系統減少動態設定改變時通知；回傳解除函式 */
export function subscribeReducedMotion(cb: () => void): () => void {
    const mql = query(REDUCED_MOTION_QUERY);
    if (!mql) return () => undefined;
    if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', cb);
        return () => mql.removeEventListener?.('change', cb);
    }
    // Safari 13 以前只有 addListener（15.4 已有 addEventListener，留作後備）
    mql.addListener?.(cb);
    return () => mql.removeListener?.(cb);
}

const serverSnapshot = () => false;

export function useReducedMotion(): boolean {
    return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, serverSnapshot);
}

/** 目前是否應降低透明度（材質改實心、不用 backdrop-filter） */
export function transparencyReduced(): boolean {
    let attr: string | null = null;
    try {
        attr = typeof document === 'undefined' ? null : document.documentElement?.getAttribute?.(TRANSPARENCY_ATTR) ?? null;
    } catch {
        attr = null;
    }
    if (attr === 'reduced') return true;
    if (attr === 'full') return false;
    return !!query(REDUCED_TRANSPARENCY_QUERY)?.matches;
}
