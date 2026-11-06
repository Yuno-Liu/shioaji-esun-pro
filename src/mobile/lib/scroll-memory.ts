// src/mobile/lib/scroll-memory.ts — 分頁捲動記憶（設計規格 §6.6）
//
// 殼層只有一個捲動容器（main），切換分頁時會殘留上一頁的位置；這裡依路由（formatRoute，交易頁依代碼分開）
// 記住各頁的 scrollTop，回到該頁時還原（沒有紀錄則回頂）。
//
// 時序（React layout effect 由子到父執行）：
// - main 上的被動 scroll 監聽以 rAF 合併，記錄「目前已還原的路由」的 scrollTop；pending 期間不記錄
//   （切頁後內容變短、瀏覽器夾住 scrollTop 所觸發的 scroll，不可覆寫上一頁的紀錄）。
// - 殼層在 routeKey 改變的 layout effect 呼叫 beginNavigation(key)：若同一次提交裡 ScrollRestorer 已還原該路由
//   （子元件 layout effect 先跑）就什麼都不做，否則標記 pending＝key（分頁模組仍在載入，Suspense 顯示 fallback）。
// - <ScrollRestorer> 放在 Suspense 內、RoutePage 之後：路由頁面真正提交後於 layout effect 還原並清除 pending。
// - 只記錄、還原數值，不做動畫；不改變任何交易狀態。

import { useEffect, useLayoutEffect } from 'react';

/** 記住的路由數上限（交易頁依代碼分開，避免無限成長；超過時淘汰最久未用的） */
export const SCROLL_MEMORY_LIMIT = 40;

export interface ScrollTarget {
    scrollTop: number;
    addEventListener?: (type: 'scroll', cb: () => void, opts?: AddEventListenerOptions) => void;
    removeEventListener?: (type: 'scroll', cb: () => void) => void;
}

export interface ScrollMemory {
    /** 目前已還原（正在顯示）的路由；尚未還原過為 null */
    readonly activeKey: string | null;
    /** 等待還原的路由；null＝沒有等待（可記錄） */
    readonly pending: string | null;
    get(key: string): number | undefined;
    /** 記錄 key 的位置：只在沒有 pending 且 key 為目前已還原的路由時生效；回傳是否寫入 */
    record(key: string, top: number): boolean;
    /** 殼層：路由改變（同一次提交已還原則忽略，否則標記 pending） */
    beginNavigation(key: string): void;
    /** ScrollRestorer：還原 key 的位置到 target（沒有紀錄則 0），設為目前路由並清除 pending */
    restore(key: string, target: ScrollTarget | null | undefined): void;
}

export function createScrollMemory(limit = SCROLL_MEMORY_LIMIT): ScrollMemory {
    const map = new Map<string, number>();
    let activeKey: string | null = null;
    let pending: string | null = null;

    const touch = (key: string, top: number) => {
        map.delete(key);
        map.set(key, top);
        while (map.size > limit) {
            const oldest = map.keys().next().value;
            if (oldest === undefined) break;
            map.delete(oldest);
        }
    };

    return {
        get activeKey() { return activeKey; },
        get pending() { return pending; },
        get: key => map.get(key),
        record(key, top) {
            if (pending !== null || key !== activeKey) return false;
            if (!Number.isFinite(top) || top < 0) return false;
            touch(key, top);
            return true;
        },
        beginNavigation(key) {
            pending = key === activeKey ? null : key;
        },
        restore(key, target) {
            const top = map.get(key) ?? 0;
            activeKey = key;
            pending = null;
            if (!target) return;
            try {
                target.scrollTop = top;
            } catch {
                // 唯讀等：忽略
            }
        },
    };
}

type Raf = (cb: () => void) => number;
type Caf = (id: number) => void;

function frameScheduler(): { request: Raf; cancel: Caf } {
    const g = globalThis as { requestAnimationFrame?: Raf; cancelAnimationFrame?: Caf };
    if (typeof g.requestAnimationFrame === 'function' && typeof g.cancelAnimationFrame === 'function') {
        return { request: cb => g.requestAnimationFrame!(cb), cancel: id => g.cancelAnimationFrame!(id) };
    }
    return { request: cb => setTimeout(cb, 16) as unknown as number, cancel: id => clearTimeout(id) };
}

/**
 * 在捲動容器上掛被動 scroll 監聽（rAF 合併）：記錄事件當下的路由的位置。
 * target 不是真實節點（測試的 null）時不做事。
 */
export function attachScrollRecorder(target: ScrollTarget | null | undefined, memory: ScrollMemory): () => void {
    if (!target || typeof target.addEventListener !== 'function') return () => undefined;
    const frames = frameScheduler();
    let frame: number | null = null;
    let keyAtEvent: string | null = null;
    const flush = () => {
        frame = null;
        // 事件後才切頁（或仍在等待還原）：放棄這筆，避免記到別的路由
        if (keyAtEvent === null || keyAtEvent !== memory.activeKey) return;
        memory.record(keyAtEvent, target.scrollTop);
    };
    const onScroll = () => {
        if (memory.pending !== null) return;
        keyAtEvent = memory.activeKey;
        if (frame === null) frame = frames.request(flush);
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => {
        target.removeEventListener?.('scroll', onScroll);
        if (frame !== null) frames.cancel(frame);
        frame = null;
    };
}

/** 殼層：在 routeKey 改變的 layout effect 標記 pending（同一次提交已還原則忽略） */
export function useScrollNavigation(memory: ScrollMemory, routeKey: string): void {
    useLayoutEffect(() => {
        memory.beginNavigation(routeKey);
    }, [memory, routeKey]);
}

/** 殼層：在 main 上掛記錄器 */
export function useScrollRecorder(getTarget: () => ScrollTarget | null | undefined, memory: ScrollMemory): void {
    useEffect(() => attachScrollRecorder(getTarget(), memory), [getTarget, memory]);
}

/**
 * 放在 Suspense 內、RoutePage 之後：路由頁面提交後於 layout effect 還原位置並清除 pending。
 * 不輸出任何節點。
 */
export function ScrollRestorer({ routeKey, memory, getTarget }: {
    routeKey: string;
    memory: ScrollMemory;
    getTarget: () => ScrollTarget | null | undefined;
}): null {
    useLayoutEffect(() => {
        memory.restore(routeKey, getTarget());
    }, [routeKey, memory, getTarget]);
    return null;
}
