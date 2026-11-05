// src/mobile/lib/resume-gate.ts — ResumeGate 狀態機（純邏輯，規格 §7.4）
//
// 問題：手機切到背景後 EventSource 可能早已中斷，但看門狗的恢復寬限期內（最長約 30 秒）
// getStreamStatus() 仍是 'live'，此時報價、委託、持倉與下單面板帶入的價格都可能是舊的。
// 解法：隱藏 ≥ 5 秒後回到前景，先進入 resyncing（停用新單／改價／減量），等下列條件成立才回到 ready：
//   ① getStreamStatus() === 'live'
//   ② 回前景後觀察到串流活動（tick／bidask／heartbeat），或 streamConnectionEpoch() 與隱藏前不同
//   ③ refreshTradingState('orders')、('positions') 已結束
//   ④ 目前商品的快照已重新取得（fetchSnapshots）
// ③④ 失敗 → stale-data（banner＋重試；新單需勾選「我了解資料可能過期」）；45 秒內未恢復 → failed。
//
// 本檔只描述判斷；事件來源、時鐘與讀取由執行期（resume-gate-runtime.ts，T2）注入。

export type ResumeGateState = 'ready' | 'resyncing' | 'stale-data' | 'failed';

/** 隱藏少於 5 秒（例如快速切換 App）不重新同步 */
export const HIDDEN_THRESHOLD_MS = 5_000;
/** 回前景後超過 45 秒仍未恢復 → failed */
export const RESYNC_TIMEOUT_MS = 45_000;

export type ReadSettled = 'pending' | 'ok' | 'failed';

export interface ResumeChecks {
    /** ① getStreamStatus() === 'live' */
    streamLive: boolean;
    /** ② 回前景後收到 tick／bidask／heartbeat，或連線世代改變 */
    activitySinceResume: boolean;
    /** ③ orders＋positions 重新讀取 */
    tradingReadSettled: ReadSettled;
    /** ④ 目前商品快照（沒有目前商品時由執行期直接給 'ok'） */
    snapshotSettled: ReadSettled;
}

/** 剛進入 resyncing 時的檢查狀態 */
export const INITIAL_RESUME_CHECKS: ResumeChecks = {
    streamLive: false,
    activitySinceResume: false,
    tradingReadSettled: 'pending',
    snapshotSettled: 'pending',
};

/** 隱藏多久之後回前景需要重新同步（pageshow persisted＝bfcache 還原，一律視為需要） */
export function shouldResync(hiddenMs: number, opts: { persisted?: boolean } = {}): boolean {
    if (opts.persisted) return true;
    return Number.isFinite(hiddenMs) && hiddenMs >= HIDDEN_THRESHOLD_MS;
}

/** 依目前檢查結果與經過時間決定下一個狀態（純函式） */
export function nextResumeState(checks: ResumeChecks, elapsedMs: number): ResumeGateState {
    const reads = [checks.tradingReadSettled, checks.snapshotSettled];
    if (checks.streamLive && checks.activitySinceResume && !reads.includes('pending')) {
        // 連線已恢復：讀取都成功才算 ready，否則提示資料可能過期
        return reads.includes('failed') ? 'stale-data' : 'ready';
    }
    return elapsedMs >= RESYNC_TIMEOUT_MS ? 'failed' : 'resyncing';
}

/** ③④ 是否可以發出：①② 成立後才讀（先確認串流活著再讀快照，符合「先訂閱再快照」） */
export function readsMayStart(checks: Pick<ResumeChecks, 'streamLive' | 'activitySinceResume'>): boolean {
    return checks.streamLive && checks.activitySinceResume;
}

/** 新單／改價／減量是否允許（刪單與全部刪單不受 ResumeGate 限制，見規格 §7.3） */
export function resumeAllowsNewOrders(state: ResumeGateState, staleAcknowledged: boolean): boolean {
    return state === 'ready' || (state === 'stale-data' && staleAcknowledged);
}
