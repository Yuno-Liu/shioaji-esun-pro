// src/mobile/lib/idle-prefetch.ts — 閒置預載的排程（稽核 P10）
//
// - 依序執行：每個 task 各自排一個 idle callback（沒有 requestIdleCallback，例如 iOS Safari，改用 setTimeout 間隔），
//   上一個 task 的 promise 結束（成功或失敗）後才排下一個。避免同一個 callback 一次發出全部 import()
//   （modulepreload／CSS 插入與模組評估擠在一起，冷啟動約 2.2 秒處出現 55–75ms 長任務）。
// - 省流量（navigator.connection.saveData）或有效網路類型為 2g／3g 時，由呼叫端只排必要模組。
//   不支援 Network Information API（iOS Safari、Firefox）時視為一般網路。

/** 沒有 requestIdleCallback 時，相鄰兩個預載之間的間隔 */
export const PREFETCH_GAP_MS = 100;
/** requestIdleCallback 的 timeout：一直不閒置時最晚多久執行 */
export const PREFETCH_IDLE_TIMEOUT_MS = 2_000;

export interface NetworkInformationLike {
    saveData?: boolean;
    effectiveType?: string;
}

/** 省流量模式，或有效網路類型為 slow-2g／2g／3g */
export function constrainedNetwork(connection: NetworkInformationLike | null | undefined): boolean {
    if (!connection) return false;
    if (connection.saveData === true) return true;
    const t = connection.effectiveType;
    return t === 'slow-2g' || t === '2g' || t === '3g';
}

/** 目前瀏覽器的網路資訊（不支援時 undefined；讀取丟例外也當作不支援） */
export function currentConnection(): NetworkInformationLike | undefined {
    try {
        return (globalThis as { navigator?: { connection?: NetworkInformationLike } }).navigator?.connection ?? undefined;
    } catch {
        return undefined;
    }
}

type IdleScheduler = (cb: () => void, opts?: { timeout: number }) => number;
type IdleCanceller = (handle: number) => void;

/**
 * 依序執行 tasks，每個一個 idle callback（或 setTimeout 間隔；此時第一個在呼叫當下同步執行）；
 * task 丟例外或 reject 都只當作結束、繼續下一個。
 * 回傳取消函式：清掉尚未執行的排程（已發出的 import 不中止）。
 */
export function schedulePrefetchSequence(tasks: readonly (() => Promise<unknown>)[]): () => void {
    const g = globalThis as { requestIdleCallback?: IdleScheduler; cancelIdleCallback?: IdleCanceller };
    let cancelled = false;
    let cancelPending: (() => void) | null = null;

    const runAt = (i: number) => {
        cancelPending = null;
        if (cancelled) return;
        let done: Promise<unknown>;
        try {
            done = tasks[i]!();
        } catch {
            done = Promise.resolve();
        }
        const next = () => { if (!cancelled) scheduleAt(i + 1); };
        done.then(next, next);
    };

    const scheduleAt = (i: number) => {
        if (i >= tasks.length) return;
        const idle = g.requestIdleCallback;
        if (typeof idle === 'function') {
            const handle = idle(() => runAt(i), { timeout: PREFETCH_IDLE_TIMEOUT_MS });
            cancelPending = () => { if (typeof g.cancelIdleCallback === 'function') g.cancelIdleCallback(handle); };
        } else if (i === 0) {
            // 沒有 idle callback：第一個直接執行（呼叫端已在首屏後延遲排程），之後每個間隔 PREFETCH_GAP_MS
            runAt(0);
        } else {
            const handle = setTimeout(() => runAt(i), PREFETCH_GAP_MS);
            cancelPending = () => clearTimeout(handle);
        }
    };

    scheduleAt(0);
    return () => {
        cancelled = true;
        cancelPending?.();
        cancelPending = null;
    };
}
