// src/mobile/lib/watchlist-context.tsx — 常駐的自選清單狀態（規格 §6.1、§9.1）
//
// useWatchlist() 掛載時會讀取清單（GET watchlist、逐筆合約資訊、快照），伺服器暫時不可用時還會在背景重試。
// 若放在 WatchlistPage 內，每次切回「自選」分頁都會重建 hook：清單先閃空白、整份重新讀取，
// 重試迴圈也會隨每次掛載多開一條。因此改由 MobileShell 掛載 WatchlistProvider 一次（常駐），
// 頁面以 useMobileWatchlist() 取用；清單、合約與快照只在第一次與明確重新整理（重試）時讀取。
// 可見列的行情訂閱仍在 WatchlistPage（只有頁面掛載且列可見時訂閱，離開即釋放）。
//
// 只能在 MobileShell（secure context）內掛載：非 secure context 不得讀取任何資料（R1）。

import { createContext, createElement, useContext, useLayoutEffect, type ReactNode } from 'react';
import { useWatchlist } from '../../hooks/use-watchlist';

export type MobileWatchlist = ReturnType<typeof useWatchlist>;

const WatchlistContext = createContext<MobileWatchlist | null>(null);

/** 常駐 Provider 最近一次提交的狀態（getLatestMobileWatchlist） */
let latest: MobileWatchlist | null = null;

export function WatchlistProvider({ children }: { children?: ReactNode }) {
    const wl = useWatchlist();
    useLayoutEffect(() => { latest = wl; });
    useLayoutEffect(() => () => { latest = null; }, []);
    return createElement(WatchlistContext.Provider, { value: wl }, children);
}

/**
 * 常駐 Provider 最近一次提交的自選狀態（沒有掛載時 null）。給延遲載入面板裡的非同步流程用：
 * 流程中途面板可能被卸載（例如刪除目前群組會切換清單、結束編輯模式），之後仍要讀到最新狀態才能正確判斷與回報。
 */
export const getLatestMobileWatchlist = (): MobileWatchlist | null => latest;

/** 取得常駐的自選清單狀態；必須在 WatchlistProvider 之內 */
export function useMobileWatchlist(): MobileWatchlist {
    const wl = useContext(WatchlistContext);
    if (!wl) throw new Error('useMobileWatchlist 必須在 WatchlistProvider（MobileShell）之內使用');
    return wl;
}

/** 同 useMobileWatchlist，但不在 WatchlistProvider 內時回傳 null（交易頁切換商品面板：沒有自選資料就不顯示自選區與加入鍵） */
export function useOptionalMobileWatchlist(): MobileWatchlist | null {
    return useContext(WatchlistContext);
}
