// src/mobile/hooks/use-media-query.ts — 訂閱一個 media query 的成立與否
//
// - 以 matchMedia 判斷，查詢結果改變（旋轉、分割畫面、視窗縮放）時重新渲染。
// - 沒有 matchMedia（測試、極舊瀏覽器）或呼叫丟例外時一律 false，且不訂閱。
// - change 事件：addEventListener 優先，退回舊版 addListener（iOS 15.4 已有 addEventListener，留作後備；同 motion/prefs.ts）。

import { useCallback, useSyncExternalStore } from 'react';

type MqlLike = {
    matches: boolean;
    addEventListener?: (type: 'change', cb: () => void) => void;
    removeEventListener?: (type: 'change', cb: () => void) => void;
    addListener?: (cb: () => void) => void;
    removeListener?: (cb: () => void) => void;
};

function mediaQueryList(query: string): MqlLike | null {
    try {
        return typeof matchMedia === 'function' ? (matchMedia(query) as unknown as MqlLike | null) ?? null : null;
    } catch {
        return null;
    }
}

/** 目前是否成立；沒有 matchMedia 時 false */
export function matchesMediaQuery(query: string): boolean {
    return !!mediaQueryList(query)?.matches;
}

/** 查詢結果改變時通知；回傳解除函式（沒有 matchMedia 時不做事） */
export function subscribeMediaQuery(query: string, cb: () => void): () => void {
    const mql = mediaQueryList(query);
    if (!mql) return () => undefined;
    if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', cb);
        return () => mql.removeEventListener?.('change', cb);
    }
    mql.addListener?.(cb);
    return () => mql.removeListener?.(cb);
}

const serverSnapshot = () => false;

export function useMediaQuery(query: string): boolean {
    const subscribe = useCallback((cb: () => void) => subscribeMediaQuery(query, cb), [query]);
    const snapshot = useCallback(() => matchesMediaQuery(query), [query]);
    return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
