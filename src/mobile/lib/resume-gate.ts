// src/mobile/lib/resume-gate.ts — ResumeGate 狀態機（純邏輯，規格 §7.4）
//
// 問題：手機切到背景後 EventSource 可能早已中斷，但看門狗的恢復寬限期內（最長約 30 秒）
// getStreamStatus() 仍是 'live'，此時報價、委託、持倉與下單面板帶入的價格都可能是舊的。
// 解法：隱藏 ≥ 5 秒後回到前景，先進入 resyncing（停用新單／改價／減量），等下列條件成立才回到 ready：
//   ① getStreamStatus() === 'live'
//   ② 回前景後的串流活動：回前景之後發生的重新連線（streamConnectionEpoch() 與回前景當下不同），
//      或回前景後至少 ACTIVITY_SETTLE_MS 才收到的 tick／bidask／heartbeat（比規格 §7.4 字面更嚴格，理由見下）
//   ③ 委託（reconcileOrdersOnce）、持倉（refreshTradingState('positions')）確實重新讀取完成
//   ④ 目前商品的快照已重新取得（fetchSnapshots）
// ③④ 失敗 → stale-data（banner＋重試；新單需勾選「我了解資料可能過期」）；45 秒內未恢復 → failed。
//
// 本檔只描述判斷；事件來源、時鐘與讀取由執行期（resume-gate-runtime.ts，T2）注入。

export type ResumeGateState = 'ready' | 'resyncing' | 'stale-data' | 'failed';

/** 隱藏少於 5 秒（例如快速切換 App）不重新同步 */
export const HIDDEN_THRESHOLD_MS = 5_000;
/** 回前景後超過 45 秒仍未恢復 → failed */
export const RESYNC_TIMEOUT_MS = 45_000;

/**
 * ② 的活動必須在回前景（或重試）之後至少這麼久才收到才算數。
 *
 * 比規格 §7.4「回前景後觀察到串流活動」字面更嚴格（fail-safe，只會更晚 ready、不會更早）：
 * - 背景期間 EventSource 已收到、但頁面被凍結而尚未派送的事件，會在回前景後立刻派送；
 *   src/lib/stream.ts 的報價另有 50 ms 批次派送。這些舊事件不能證明串流此刻仍活著。
 * - 隱藏期間發生的重新連線同理：那條連線可能在背景中又已中斷，所以重連的基準是「回前景當下」的連線世代，
 *   不是隱藏時的世代（見 resume-gate-runtime.ts）。
 * 休市時只有心跳（HEARTBEAT_PERIOD_MS＝30 秒）：回前景後第一秒內的心跳不算，下一次心跳最晚約 31 秒後到，
 * 仍在 RESYNC_TIMEOUT_MS（45 秒）內；串流已死時看門狗會判 stale 並重連，新連線世代即滿足 ②。
 */
export const ACTIVITY_SETTLE_MS = 1_000;

/** ② 的串流事件是否算數（回前景後經過的毫秒數） */
export function countsAsResumeActivity(msSinceResume: number): boolean {
    return Number.isFinite(msSinceResume) && msSinceResume >= ACTIVITY_SETTLE_MS;
}

export type ReadSettled = 'pending' | 'ok' | 'failed';

export interface ResumeChecks {
    /** ① getStreamStatus() === 'live' */
    streamLive: boolean;
    /** ② 回前景後 ACTIVITY_SETTLE_MS 以上才收到 tick／bidask／heartbeat，或回前景後重新連線（連線世代改變） */
    activitySinceResume: boolean;
    /** ③ orders＋positions 確實重新讀取（完成時間晚於本週期開始） */
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
