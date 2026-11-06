// src/mobile/lib/wake-lock.ts — 螢幕常亮（Screen Wake Lock，規格 Phase 3、選配）
//
// startWakeLock()：開關啟用時由 hooks/use-wake-lock 呼叫，回傳停止函式。
// - 頁面可見才 request('screen')；visibilitychange 回前景時重新取得；隱藏或停止時釋放。
// - 系統自行釋放（省電模式、切到背景）時記錄狀態，回前景再取得。
// - 取得失敗（例如 Safari 要求使用者手勢、省電模式）：記錄錯誤，下一次觸控（touchend／click）時再試一次。
// - request 進行中被停止或頁面轉為隱藏：拿到 sentinel 後立即釋放，不持有。
// 狀態以小型 store 提供給設定區塊顯示（useWakeLockStatus）。

import { useSyncExternalStore } from 'react';

export type WakeLockState =
    /** 瀏覽器不支援 */
    | 'unsupported'
    /** 開關關閉 */
    | 'off'
    /** 取得中 */
    | 'pending'
    /** 持有中：螢幕保持常亮 */
    | 'active'
    /** 頁面在背景：已釋放，回前景會再取得 */
    | 'hidden'
    /** 系統在前景時自行釋放（例如省電模式）：下一次回前景或觸控再取得 */
    | 'released'
    /** 取得失敗 */
    | 'error';

export interface WakeLockStatus {
    state: WakeLockState;
    error: string | null;
}

interface SentinelLike {
    released?: boolean;
    release(): Promise<void>;
    addEventListener?(type: 'release', listener: () => void): void;
}

export interface WakeLockNav {
    wakeLock?: { request(type: 'screen'): Promise<SentinelLike> } | null;
}

export interface WakeLockDoc extends EventTarget {
    visibilityState: DocumentVisibilityState | string;
}

/**
 * 取得失敗後的重試時機：下一次使用者手勢。觸控的 pointerdown 不算「使用者啟用」（HTML activation-triggering
 * 只有 touchend／pointerup／click 等），所以聽 touchend 與 click。
 */
const RETRY_EVENTS = ['touchend', 'click'] as const;

let status: WakeLockStatus = { state: 'off', error: null };
const listeners = new Set<() => void>();

function setStatus(state: WakeLockState, error: string | null = null): void {
    if (status.state === state && status.error === error) return;
    status = { state, error };
    listeners.forEach(l => l());
}

export function getWakeLockStatus(): WakeLockStatus {
    return status;
}

export function subscribeWakeLockStatus(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useWakeLockStatus(): WakeLockStatus {
    return useSyncExternalStore(subscribeWakeLockStatus, getWakeLockStatus, getWakeLockStatus);
}

/** 開關關閉（或不支援）時的狀態：由 hook 在未啟動時設定 */
export function setWakeLockIdle(supported: boolean): void {
    setStatus(supported ? 'off' : 'unsupported');
}

/** 測試用 */
export function resetWakeLockStatusForTest(): void {
    status = { state: 'off', error: null };
    listeners.clear();
}

function errorText(e: unknown): string {
    const name = (e as { name?: unknown } | null)?.name;
    if (name === 'NotAllowedError') return '瀏覽器拒絕（可能是省電模式或需要先觸控畫面）';
    return e instanceof Error && e.message ? e.message : '無法取得螢幕常亮';
}

function defaultNav(): WakeLockNav | undefined {
    return typeof navigator === 'undefined' ? undefined : (navigator as unknown as WakeLockNav);
}

function defaultDoc(): WakeLockDoc | undefined {
    return typeof document === 'undefined' ? undefined : document;
}

/** 啟動螢幕常亮；回傳停止函式（釋放並移除監聽）。不支援時設為 unsupported 並回傳空函式。 */
export function startWakeLock(nav: WakeLockNav | undefined = defaultNav(), doc: WakeLockDoc | undefined = defaultDoc()): () => void {
    const api = nav?.wakeLock;
    if (!api || typeof api.request !== 'function' || !doc) {
        setStatus('unsupported');
        return () => undefined;
    }
    const d: WakeLockDoc = doc;
    let stopped = false;
    let requesting = false;
    let sentinel: SentinelLike | null = null;
    let retryArmed = false;

    const visible = () => d.visibilityState === 'visible';

    const releaseHeld = () => {
        const s = sentinel;
        sentinel = null;
        if (s && !s.released) void s.release().catch(() => undefined);
    };

    const onRetryGesture = () => {
        disarmRetry();
        void acquire();
    };
    const armRetry = () => {
        if (retryArmed || stopped) return;
        retryArmed = true;
        for (const type of RETRY_EVENTS) d.addEventListener(type, onRetryGesture, { capture: true, passive: true });
    };
    function disarmRetry() {
        if (!retryArmed) return;
        retryArmed = false;
        for (const type of RETRY_EVENTS) d.removeEventListener(type, onRetryGesture, { capture: true });
    }

    async function acquire(): Promise<void> {
        if (stopped || requesting || sentinel) return;
        if (!visible()) {
            setStatus('hidden');
            return;
        }
        requesting = true;
        setStatus('pending');
        let s: SentinelLike;
        try {
            s = await api!.request('screen');
        } catch (e) {
            requesting = false;
            if (stopped) return;
            setStatus('error', errorText(e));
            armRetry();
            return;
        }
        requesting = false;
        // 等待期間已停止或轉到背景：不持有
        if (stopped || !visible()) {
            if (!s.released) void s.release().catch(() => undefined);
            if (!stopped) setStatus('hidden');
            return;
        }
        sentinel = s;
        disarmRetry();
        setStatus('active');
        s.addEventListener?.('release', () => {
            if (sentinel !== s) return; // 我們自己釋放的
            sentinel = null;
            if (stopped) return;
            if (visible()) {
                setStatus('released');
                armRetry();
            } else {
                setStatus('hidden');
            }
        });
    }

    const onVisibility = () => {
        if (stopped) return;
        if (visible()) {
            void acquire();
        } else {
            releaseHeld();
            setStatus('hidden');
        }
    };

    d.addEventListener('visibilitychange', onVisibility);
    void acquire();

    return () => {
        if (stopped) return;
        stopped = true;
        d.removeEventListener('visibilitychange', onVisibility);
        disarmRetry();
        releaseHeld();
        setStatus('off');
    };
}
