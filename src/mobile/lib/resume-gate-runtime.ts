// src/mobile/lib/resume-gate-runtime.ts — ResumeGate 執行期單例（規格 §7.4）
//
// 【目前為樁（T1）】狀態固定為 'ready'，startResumeGate() 尚未監聽任何事件。
// T2 會在這個檔案實作：
//   - 監聽 visibilitychange／pagehide／pageshow（不依賴 freeze／resume）；隱藏 ≥ HIDDEN_THRESHOLD_MS 或
//     pageshow(persisted) 回前景 → resyncing；
//   - 進入 resyncing 時 resolveOrderConfirm(false) 關閉進行中的確認面板、resumeSeq 遞增（下單面板據此標示「價格可能過期」）；
//   - 以 getStreamStatus()、onAnyTick()、onAnyBidAsk()、onStreamEvent('heartbeat', …)、streamConnectionEpoch()
//     判斷 ①②；之後才發出 refreshTradingState('orders'／'positions') 與目前商品（mobile-store 的 currentCode）的快照讀取；
//   - 以 nextResumeState() 推進狀態，RESYNC_TIMEOUT_MS 逾時 → failed。
// 對外介面（本檔匯出的函式與 ResumeGateSnapshot）是其他任務的依賴，T2 實作時不要改簽章。

import { notStarted } from './errors';
import { resumeAllowsNewOrders, type ResumeChecks, type ResumeGateState } from './resume-gate';

export interface ResumeGateSnapshot {
    state: ResumeGateState;
    /** 進入目前狀態的時間（Date.now()） */
    since: number;
    /** 進行中的同步檢查；ready 時為 null */
    checks: ResumeChecks | null;
    /** stale-data 時使用者已勾選「我了解委託／持倉資料可能過期」；離開 stale-data 時重設為 false */
    staleAcknowledged: boolean;
    /**
     * 每次進入 resyncing 遞增。下單面板記下帶入價格當時的 resumeSeq，
     * 之後不同就標示「價格可能過期」，需重新點選快捷價或手動確認後才能預覽。
     */
    resumeSeq: number;
    /** 給狀態列／banner 的說明（failed、stale-data 時的原因）；ready 時為 null */
    message: string | null;
}

const READY: ResumeGateSnapshot = { state: 'ready', since: 0, checks: null, staleAcknowledged: false, resumeSeq: 0, message: null };

let snapshot: ResumeGateSnapshot = READY;
const listeners = new Set<() => void>();

function publish(next: ResumeGateSnapshot) {
    snapshot = next;
    listeners.forEach(l => l());
}

/** 目前快照（useSyncExternalStore 用；內容不變時回傳同一個物件） */
export function getResumeGate(): ResumeGateSnapshot {
    return snapshot;
}

export function subscribeResumeGate(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** stale-data 時使用者勾選「我了解資料可能過期」；其他狀態呼叫無效 */
export function acknowledgeStaleData(): void {
    if (snapshot.state !== 'stale-data' || snapshot.staleAcknowledged) return;
    publish({ ...snapshot, staleAcknowledged: true });
}

/**
 * stale-data／failed 時使用者按「重試」：重新進入 resyncing 並重跑檢查。
 * 【樁】目前沒有同步流程，不做任何事（T2 實作）。
 */
export function retryResume(): void {
    // T2：重新進入 resyncing（resumeSeq 遞增）並重跑 ①–④
}

/**
 * 新單、改價、減量送出前的 ResumeGate 閘門；不通過就丟出 mutationNotStarted 錯誤（確定沒有送出）。
 * - ready：通過。
 * - stale-data：只有 opts.allowStale === true 且使用者已 acknowledgeStaleData() 才通過
 *   （新單在使用者勾選後傳 allowStale: true；改價／減量建議不傳，要求先重試同步）。
 * - resyncing、failed：一律不通過。
 * 刪單與全部刪單是降低風險的動作，**不呼叫**這個閘門（規格 §7.3）。
 */
export function assertResumeReady(opts: { allowStale?: boolean } = {}): void {
    const s = snapshot;
    if (s.state === 'ready') return;
    if (opts.allowStale === true && resumeAllowsNewOrders(s.state, s.staleAcknowledged)) return;
    if (s.state === 'resyncing') throw notStarted('回到前景後正在重新同步行情與委託，這筆沒有送出，請稍候再試');
    if (s.state === 'stale-data') throw notStarted('委託／持倉資料可能過期，這筆沒有送出；請按「重試」或勾選「我了解資料可能過期」後重新下單');
    throw notStarted('連線未恢復，這筆沒有送出，請重新整理頁面');
}

let started = false;

/**
 * 啟動 ResumeGate（App 根層呼叫一次；重複呼叫無副作用）。回傳停止函式（測試與 HMR 用）。
 * 【樁】目前不監聽任何事件，狀態維持 'ready'（T2 實作）。
 */
export function startResumeGate(): () => void {
    if (started) return () => undefined;
    started = true;
    return () => { started = false; };
}

/** 測試用：直接設定快照（其他任務的元件測試可用來模擬 resyncing／stale-data／failed） */
export function setResumeGateForTest(next: Partial<ResumeGateSnapshot> | null): void {
    publish(next ? { ...READY, ...next } : READY);
}
