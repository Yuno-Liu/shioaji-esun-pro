// src/mobile/lib/resume-gate-runtime.ts — ResumeGate 執行期單例（規格 §7.4）
//
// - 監聽 visibilitychange／pagehide／pageshow（iOS 與 Android 皆支援；不依賴 Chromium 才有的 freeze／resume）。
//   隱藏 ≥ HIDDEN_THRESHOLD_MS 後回前景 → resyncing。
// - pageshow(persisted)（bfcache 還原）：先進入 resyncing 擋下送單，再**重新載入頁面**。src/lib/quote-ownership.ts
//   在 pagehide 時已永久拆除報價訂閱狀態（{ once: true }，還原後不會重建），畫面報價可能全部凍結，
//   但串流心跳仍在、ResumeGate 會判 ready；在頁面內無法可靠修復，所以直接重新載入。
// - 進入 resyncing：resumeSeq 遞增（下單面板據此標示「價格可能過期」）、resolveOrderConfirm(false) 關閉進行中的確認面板；
//   新單／改價／減量由 assertResumeReady() 擋下（刪單與全部刪單不呼叫它）。
// - ① getStreamStatus() === 'live'；② 回前景之後的串流活動：回前景後發生的重新連線（streamConnectionEpoch()
//   與回前景當下不同），或回前景 ACTIVITY_SETTLE_MS 之後才收到的 tick／bidask／heartbeat（理由見 resume-gate.ts）；
//   ①② 成立後才發出 ③ 委託 reconcileOrdersOnce() → 持倉 refreshTradingState('positions')
//   與 ④ 目前商品（mobile-store 的 currentCode，經 contracts 快取取得合約）的 fetchSnapshots；
//   以 nextResumeState() 推進，RESYNC_TIMEOUT_MS 逾時 → failed；③④ 失敗 → stale-data。
// - ③ 必須確認真的讀過：lib 的 refreshTradingState() 可能回傳其他範圍進行中的讀取，或在 1.5 秒冷卻內直接 resolve。
//   讀完後以 queries[scope].updatedAt 確認完成時間不早於本週期開始，否則冷卻後重讀一次；仍不符合 → stale-data。
// - 每個同步週期 ③ 每個範圍最多讀 MAX_READS_PER_SCOPE 次、④ 最多一次；活動監聽在第一筆算數的活動後立即解除，
//   所以頻繁切換 App 不會造成查詢風暴。
// - 時鐘、事件來源與 src/lib 呼叫都經 ResumeGateDeps 注入（單元測試用）；預設值在 startResumeGate() 呼叫時才取用。

import { resolveOrderConfirm as libResolveOrderConfirm } from '../../lib/order-confirm';
import { fetchSnapshots as libFetchSnapshots } from '../../lib/shioaji';
import { getCachedContract as libGetCachedContract } from '../../lib/contracts-cache';
import {
    getStreamStatus as libGetStreamStatus,
    onAnyBidAsk as libOnAnyBidAsk,
    onAnyTick as libOnAnyTick,
    onStreamEvent as libOnStreamEvent,
    streamConnectionEpoch as libStreamConnectionEpoch,
    subscribeStatusStore as libSubscribeStatusStore,
} from '../../lib/stream';
import {
    getTradingState as libGetTradingState,
    reconcileOrdersOnce as libReconcileOrdersOnce,
    refreshTradingState as libRefreshTradingState,
} from '../../lib/trading-state';
import type { ContractBase } from '../../lib/types/contract';
import { notStarted } from './errors';
import { getMobileUi } from './mobile-store';
import {
    countsAsResumeActivity,
    INITIAL_RESUME_CHECKS,
    nextResumeState,
    readsMayStart,
    resumeAllowsNewOrders,
    shouldResync,
    type ReadSettled,
    type ResumeChecks,
    type ResumeGateState,
} from './resume-gate';

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
    /**
     * 最近一次開始重新同步（進入 resyncing）的時間（deps.now()，預設 Date.now()）；缺省＝本次執行尚未重新同步過。
     * 下單面板以此與 openTicket 的時間比較：帶入價格之後才開始的同步，即使面板掛載時已 ready，價格也要重新確認。
     */
    resyncStartedAt?: number;
    /** 給狀態列／banner 的說明（failed、stale-data 時的原因）；ready 時為 null */
    message: string | null;
}

/** 最小事件目標介面（document／window 皆符合） */
export interface ResumeEventTarget {
    addEventListener(type: string, listener: (ev: Event) => void): void;
    removeEventListener(type: string, listener: (ev: Event) => void): void;
}

/** resyncing 期間的輪詢間隔（只讀本地狀態、不發任何請求；事件驅動之外的保險，並負責逾時判斷） */
export const RESUME_POLL_MS = 1_000;

/** 讀取失敗的判定：refreshTradingState() 失敗時不 reject，而是在 queries[scope].reasons 留下這些原因 */
const READ_FAILURE_REASONS: readonly string[] = ['query-failed', 'not-subscribed'];

/** ③ 每個同步週期每個範圍最多讀幾次（第一次＋冷卻後重讀一次） */
export const MAX_READS_PER_SCOPE = 2;
/** 持倉重讀前的等待：src/lib/trading-state.ts 每範圍讀完後冷卻 1.5 秒，加一點餘裕 */
export const READ_RETRY_DELAY_MS = 1_600;

/** ResumeGate 的外部依賴（全部可注入；未提供者使用 src/lib 與瀏覽器的預設值） */
export interface ResumeGateDeps {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    /** visibilitychange 的目標與 visibilityState 來源；null＝不監聽 */
    document: (ResumeEventTarget & { readonly visibilityState?: string }) | null;
    /** pagehide／pageshow 的目標；null＝不監聽 */
    window: ResumeEventTarget | null;
    getStreamStatus(): string;
    /** 串流連線世代；非 live 時為 -1 */
    streamConnectionEpoch(): number;
    subscribeStreamStatus(listener: () => void): () => void;
    onAnyTick(listener: () => void): () => void;
    onAnyBidAsk(listener: () => void): () => void;
    onHeartbeat(listener: () => void): () => void;
    /** 委託：一次真正的讀取（等進行中的讀取與冷卻結束；src/lib 的 reconcileOrdersOnce） */
    readOrders(): Promise<void>;
    /** 持倉：refreshTradingState('positions')（可能被冷卻或其他讀取吸收，讀完以 tradingUpdatedAt 確認） */
    readPositions(): Promise<void>;
    /** 讀取完成後：該範圍讀取失敗時回傳原因，成功回傳 null */
    tradingReadFailed(scope: 'orders' | 'positions'): string | null;
    /** 該範圍最後一次完整讀取的完成時間（queries[scope].updatedAt；與 now() 同一時鐘） */
    tradingUpdatedAt(scope: 'orders' | 'positions'): number | null;
    getCurrentCode(): string | null;
    getCachedContract(code: string): ContractBase | undefined;
    fetchSnapshots(contracts: ContractBase[]): Promise<unknown>;
    resolveOrderConfirm(approved: boolean): void;
    /** bfcache 還原時重新載入頁面 */
    reload(): void;
}

const SCOPE_LABEL = { orders: '委託', positions: '持倉' } as const;

function defaultDeps(): ResumeGateDeps {
    return {
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
        document: typeof document === 'undefined' ? null : document,
        window: typeof window === 'undefined' ? null : window,
        // 一律包成箭頭函式：在呼叫時才取用 src/lib 的匯出（其他測試部分 mock 這些模組時不受影響）
        getStreamStatus: () => libGetStreamStatus(),
        streamConnectionEpoch: () => libStreamConnectionEpoch(),
        subscribeStreamStatus: listener => libSubscribeStatusStore(listener),
        onAnyTick: listener => libOnAnyTick(() => listener()),
        onAnyBidAsk: listener => libOnAnyBidAsk(() => listener()),
        onHeartbeat: listener => libOnStreamEvent('heartbeat', () => listener()),
        readOrders: () => libReconcileOrdersOnce(),
        readPositions: () => libRefreshTradingState('positions'),
        tradingReadFailed: scope => {
            const query = libGetTradingState().queries[scope];
            if (!query.reasons.some(r => READ_FAILURE_REASONS.includes(r))) return null;
            return `${SCOPE_LABEL[scope]}讀取失敗${query.error ? `（${query.error}）` : ''}`;
        },
        tradingUpdatedAt: scope => libGetTradingState().queries[scope].updatedAt,
        getCurrentCode: () => getMobileUi().currentCode,
        getCachedContract: code => libGetCachedContract(code),
        fetchSnapshots: contracts => libFetchSnapshots(contracts),
        resolveOrderConfirm: approved => libResolveOrderConfirm(approved),
        reload: () => { if (typeof location !== 'undefined') location.reload(); },
    };
}

const READY: ResumeGateSnapshot = { state: 'ready', since: 0, checks: null, staleAcknowledged: false, resumeSeq: 0, message: null };

const RESYNC_MESSAGE = '回到前景，正在重新同步行情、委託與持倉';
const FAILED_STREAM_MESSAGE = '連線未恢復：回到前景後 45 秒內行情串流仍未恢復，請重新整理頁面';
const FAILED_READ_MESSAGE = '同步逾時：委託／持倉或報價讀取 45 秒內未完成，請重新整理頁面';

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

// ---- 執行期 ----

/** 一次同步週期（進入 resyncing 到離開） */
interface Cycle {
    /** 回前景（或按重試）的時間；② 的活動與 ③ 的讀取完成時間都以此為基準 */
    startedAt: number;
    checks: ResumeChecks;
    /** 回前景當下（或重試時）的連線世代；之後不同＝回前景後重新連上（隱藏期間的重連不算） */
    baselineEpoch: number;
    readsStarted: boolean;
    readErrors: string[];
    cleanup: Array<() => void>;
    pollHandle: unknown;
}

interface Runtime {
    deps: ResumeGateDeps;
    /** 進入背景的時間；null＝目前在前景 */
    hiddenAt: number | null;
    cycle: Cycle | null;
    /** ② 成立時的連線世代（stale-data 重試時若同一條連線仍 live，沿用已觀察到的活動） */
    activeEpoch: number | null;
    detach: () => void;
}

let runtime: Runtime | null = null;

function endCycle(rt: Runtime) {
    const cycle = rt.cycle;
    if (!cycle) return;
    rt.cycle = null;
    cycle.cleanup.splice(0).forEach(fn => { try { fn(); } catch { /* 解除監聽失敗不影響狀態 */ } });
    if (cycle.pollHandle !== null) rt.deps.clearTimeout(cycle.pollHandle);
    cycle.pollHandle = null;
}

function staleMessage(errors: string[]): string {
    const detail = [...new Set(errors)].join('；');
    return `委託／持倉或報價資料可能過期${detail ? `：${detail}` : ''}；請按「重試同步」，或勾選「我了解委託／持倉資料可能過期」後再下新單`;
}

/** 依目前檢查推進狀態；離開 resyncing 時結束週期 */
function evaluate(rt: Runtime) {
    const cycle = rt.cycle;
    if (!cycle) return;
    const { deps } = rt;
    const live = deps.getStreamStatus() === 'live';
    let { activitySinceResume } = cycle.checks;
    if (!activitySinceResume && live) {
        // 回前景後重新連上（看門狗 stale→live 或 EventSource 重連）時連線世代會遞增；
        // 基準是回前景當下的世代，隱藏期間的重連不算（那條連線可能在背景中又已中斷）
        const epoch = deps.streamConnectionEpoch();
        if (epoch >= 0 && epoch !== cycle.baselineEpoch) activitySinceResume = true;
    }
    if (live !== cycle.checks.streamLive || activitySinceResume !== cycle.checks.activitySinceResume) {
        cycle.checks = { ...cycle.checks, streamLive: live, activitySinceResume };
    }
    if (live && activitySinceResume && rt.activeEpoch === null) rt.activeEpoch = deps.streamConnectionEpoch();
    if (!cycle.readsStarted && readsMayStart(cycle.checks)) startReads(rt, cycle);

    const next = nextResumeState(cycle.checks, deps.now() - cycle.startedAt);
    if (next === 'resyncing') {
        if (snapshot.checks !== cycle.checks) publish({ ...snapshot, checks: cycle.checks });
        return;
    }
    endCycle(rt);
    const since = deps.now();
    const base = { ...snapshot, since, staleAcknowledged: false };
    if (next === 'ready') publish({ ...base, state: 'ready', checks: null, message: null });
    else if (next === 'stale-data') publish({ ...base, state: 'stale-data', checks: cycle.checks, message: staleMessage(cycle.readErrors) });
    else {
        const streamOk = cycle.checks.streamLive && cycle.checks.activitySinceResume;
        publish({ ...base, state: 'failed', checks: cycle.checks, message: streamOk ? FAILED_READ_MESSAGE : FAILED_STREAM_MESSAGE });
    }
}

function settle(rt: Runtime, cycle: Cycle, key: 'tradingReadSettled' | 'snapshotSettled', value: ReadSettled, error?: string) {
    if (rt.cycle !== cycle) return; // 週期已結束（逾時、重新觸發或停止）：結果不再影響狀態
    if (error) cycle.readErrors.push(error);
    cycle.checks = { ...cycle.checks, [key]: value };
    evaluate(rt);
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** 週期內的等待；週期結束時計時器一併清除（promise 不再 resolve，呼叫端也不再推進） */
function cycleDelay(rt: Runtime, cycle: Cycle, ms: number): Promise<void> {
    return new Promise(resolve => {
        const handle = rt.deps.setTimeout(resolve, ms);
        cycle.cleanup.push(() => rt.deps.clearTimeout(handle));
    });
}

/**
 * ③ 讀一個範圍，並確認真的讀過：完成後 queries[scope].updatedAt 不早於本週期開始。
 * 不符合（被冷卻吸收、共用了只讀其他範圍的讀取，或讀取期間有回報／串流中斷而 lib 未標記完成）→ 冷卻後重讀一次；
 * 仍不符合 → 視為讀取失敗（stale-data）。每個範圍最多 MAX_READS_PER_SCOPE 次。回傳錯誤文字或 null。
 */
async function readScope(rt: Runtime, cycle: Cycle, scope: 'orders' | 'positions'): Promise<string | null> {
    const { deps } = rt;
    for (let attempt = 1; ; attempt += 1) {
        try {
            await (scope === 'orders' ? deps.readOrders() : deps.readPositions());
        } catch (err) {
            return `${SCOPE_LABEL[scope]}讀取失敗：${errorText(err)}`;
        }
        if (rt.cycle !== cycle) return null;
        const failed = deps.tradingReadFailed(scope);
        if (failed) return failed;
        const updatedAt = deps.tradingUpdatedAt(scope);
        if (updatedAt !== null && updatedAt >= cycle.startedAt) return null;
        if (attempt >= MAX_READS_PER_SCOPE) return `${SCOPE_LABEL[scope]}未能確認已重新讀取（讀取期間可能有回報或連線中斷）`;
        // 委託的 reconcileOrdersOnce() 自己會等冷卻；持倉在這裡等冷卻結束再讀
        if (scope === 'positions') {
            await cycleDelay(rt, cycle, READ_RETRY_DELAY_MS);
            if (rt.cycle !== cycle) return null;
        }
    }
}

/** ①② 成立後發出 ③④（每個週期各一次） */
function startReads(rt: Runtime, cycle: Cycle) {
    cycle.readsStarted = true;
    const { deps } = rt;
    // ③ 委託 → 持倉依序讀：refreshTradingState() 執行中再呼叫會共用進行中的那一次讀取，同時發出會漏讀持倉；
    // 委託先用 reconcileOrdersOnce() 等完回前景前就在跑的讀取，持倉才不會共用到舊的那一次
    void (async () => {
        const errors: string[] = [];
        for (const scope of ['orders', 'positions'] as const) {
            const failed = await readScope(rt, cycle, scope);
            if (rt.cycle !== cycle) return;
            if (failed) errors.push(failed);
        }
        if (errors.length) settle(rt, cycle, 'tradingReadSettled', 'failed', errors.join('；'));
        else settle(rt, cycle, 'tradingReadSettled', 'ok');
    })();
    // ④ 目前商品快照；沒有目前商品或合約尚未進快取（畫面上也還沒有它的報價）→ 視為完成
    const code = deps.getCurrentCode();
    const contract = code ? deps.getCachedContract(code) : undefined;
    if (!contract) {
        cycle.checks = { ...cycle.checks, snapshotSettled: 'ok' };
        return;
    }
    let request: Promise<unknown>;
    try {
        request = Promise.resolve(deps.fetchSnapshots([contract]));
    } catch (err) {
        request = Promise.reject(err);
    }
    request.then(
        () => settle(rt, cycle, 'snapshotSettled', 'ok'),
        err => settle(rt, cycle, 'snapshotSettled', 'failed', `${code} 報價快照讀取失敗：${errorText(err)}`),
    );
}

/** 進入 resyncing 並開始新的同步週期 */
function beginResync(rt: Runtime, baselineEpoch: number, opts: { carryActivity?: boolean } = {}) {
    endCycle(rt);
    const { deps } = rt;
    const startedAt = deps.now();
    const carry = opts.carryActivity === true;
    const cycle: Cycle = {
        startedAt,
        checks: { ...INITIAL_RESUME_CHECKS, activitySinceResume: carry },
        baselineEpoch,
        readsStarted: false,
        readErrors: [],
        cleanup: [],
        pollHandle: null,
    };
    rt.cycle = cycle;
    if (!carry) rt.activeEpoch = null;
    publish({ state: 'resyncing', since: startedAt, checks: cycle.checks, staleAcknowledged: false, resumeSeq: snapshot.resumeSeq + 1, resyncStartedAt: startedAt, message: RESYNC_MESSAGE });
    // 進行中的確認面板一律取消（確認時看到的價格與資料可能已過期）
    try { deps.resolveOrderConfirm(false); } catch { /* 取消失敗不影響閘門：送單仍會被 assertResumeReady 擋下 */ }
    if (rt.cycle !== cycle) return;

    // ② 活動：回前景 ACTIVITY_SETTLE_MS 內派送的事件可能是背景期間排隊的舊事件，不算（見 resume-gate.ts）；
    // 第一筆算數的活動就解除全部活動監聽，tick 洪流不會反覆觸發
    if (!carry) {
        const activityOff: Array<() => void> = [];
        const onActivity = () => {
            if (rt.cycle !== cycle || cycle.checks.activitySinceResume) return;
            if (!countsAsResumeActivity(deps.now() - cycle.startedAt)) return;
            cycle.checks = { ...cycle.checks, activitySinceResume: true };
            activityOff.splice(0).forEach(fn => fn());
            evaluate(rt);
        };
        activityOff.push(deps.onAnyTick(onActivity), deps.onAnyBidAsk(onActivity), deps.onHeartbeat(onActivity));
        cycle.cleanup.push(() => activityOff.splice(0).forEach(fn => fn()));
    }
    cycle.cleanup.push(deps.subscribeStreamStatus(() => evaluate(rt)));

    const poll = () => {
        if (rt.cycle !== cycle) return;
        cycle.pollHandle = null;
        evaluate(rt);
        if (rt.cycle === cycle) cycle.pollHandle = deps.setTimeout(poll, RESUME_POLL_MS);
    };
    cycle.pollHandle = deps.setTimeout(poll, RESUME_POLL_MS);
    evaluate(rt);
}

function markHidden(rt: Runtime) {
    if (rt.hiddenAt !== null) return;
    rt.hiddenAt = rt.deps.now();
}

function markVisible(rt: Runtime, opts: { persisted?: boolean } = {}) {
    const hiddenAt = rt.hiddenAt;
    rt.hiddenAt = null;
    if (hiddenAt === null) {
        // 同一次還原的另一個事件已處理過（例如 visibilitychange 先、pageshow(persisted) 後）
        if (!opts.persisted || snapshot.state === 'resyncing') return;
        beginResync(rt, rt.deps.streamConnectionEpoch());
        return;
    }
    // ② 的重連基準＝回前景當下的連線世代（不是隱藏時的）
    if (shouldResync(rt.deps.now() - hiddenAt, opts)) beginResync(rt, rt.deps.streamConnectionEpoch());
}

/**
 * stale-data／failed 時使用者按「重試」：重新進入 resyncing（resumeSeq 遞增）並重跑 ①–④。
 * ready、resyncing 時不做任何事（避免連按造成重複查詢）；ResumeGate 尚未啟動時也不做任何事。
 */
export function retryResume(): void {
    const rt = runtime;
    if (!rt || (snapshot.state !== 'stale-data' && snapshot.state !== 'failed')) return;
    const epoch = rt.deps.streamConnectionEpoch();
    // stale-data：同一條連線仍 live 且先前已觀察到活動 → 不必再等下一次心跳（非交易時段最長 30 秒）
    const carryActivity = snapshot.state === 'stale-data' && rt.deps.getStreamStatus() === 'live'
        && rt.activeEpoch !== null && epoch === rt.activeEpoch;
    beginResync(rt, epoch, { carryActivity });
}

/**
 * 新單、改價、減量送出前的 ResumeGate 閘門；不通過就丟出 mutationNotStarted 錯誤（確定沒有送出）。
 * - ready：通過。
 * - stale-data：只有 opts.allowStale === true 且使用者已 acknowledgeStaleData() 才通過
 *   （新單、改價、減量、平倉都只在使用者勾選「我了解資料可能過期」後才傳 allowStale: true）。
 * - resyncing、failed：一律不通過。
 * 刪單與全部刪單是降低風險的動作，**不呼叫**這個閘門（規格 §7.3）。
 */
export function assertResumeReady(opts: { allowStale?: boolean } = {}): void {
    const s = snapshot;
    if (s.state === 'ready') return;
    if (opts.allowStale === true && resumeAllowsNewOrders(s.state, s.staleAcknowledged)) return;
    if (s.state === 'resyncing') throw notStarted('回到前景後正在重新同步行情與委託，這筆沒有送出，請稍候再試');
    if (s.state === 'stale-data') throw notStarted('委託／持倉資料可能過期，這筆沒有送出；請按「重試」或勾選「我了解委託／持倉資料可能過期」後重新下單');
    throw notStarted('連線未恢復，這筆沒有送出，請重新整理頁面');
}

/**
 * 啟動 ResumeGate（App 根層呼叫一次；已啟動時重複呼叫無副作用，回傳空的停止函式）。回傳停止函式（測試與 HMR 用）。
 * `deps` 只供測試注入；正式環境不傳，使用 src/lib 與瀏覽器事件。
 * 停止後狀態保留（fail-closed）；再次啟動時若仍在 resyncing 會重新開始同步週期。
 */
export function startResumeGate(deps?: Partial<ResumeGateDeps>): () => void {
    if (runtime) return () => undefined;
    const merged: ResumeGateDeps = { ...defaultDeps(), ...deps };
    const rt: Runtime = { deps: merged, hiddenAt: null, cycle: null, activeEpoch: null, detach: () => undefined };
    runtime = rt;

    const onVisibility = () => {
        if (runtime !== rt) return;
        if (merged.document?.visibilityState === 'hidden') markHidden(rt);
        else markVisible(rt);
    };
    const onPageHide = () => { if (runtime === rt) markHidden(rt); };
    const onPageShow = (ev: Event) => {
        if (runtime !== rt) return;
        const persisted = (ev as { persisted?: boolean }).persisted === true;
        markVisible(rt, { persisted });
        // bfcache 還原：quote-ownership 已在 pagehide 永久拆除報價訂閱，畫面報價可能凍結而閘門仍會判 ready。
        // 上面已進入 resyncing（擋下送單、關閉確認面板），這裡直接重新載入頁面重建全部狀態。
        if (persisted) {
            try { merged.reload(); } catch { /* 重新載入失敗：閘門停在 resyncing，45 秒後 failed（請使用者重新整理） */ }
        }
    };
    merged.document?.addEventListener('visibilitychange', onVisibility);
    merged.window?.addEventListener('pagehide', onPageHide);
    merged.window?.addEventListener('pageshow', onPageShow);
    rt.detach = () => {
        merged.document?.removeEventListener('visibilitychange', onVisibility);
        merged.window?.removeEventListener('pagehide', onPageHide);
        merged.window?.removeEventListener('pageshow', onPageShow);
    };

    if (merged.document?.visibilityState === 'hidden') markHidden(rt);
    if (snapshot.state === 'resyncing') beginResync(rt, merged.streamConnectionEpoch());

    return () => {
        if (runtime !== rt) return;
        endCycle(rt);
        rt.detach();
        runtime = null;
    };
}

/** 測試用：直接設定快照（其他任務的元件測試可用來模擬 resyncing／stale-data／failed） */
export function setResumeGateForTest(next: Partial<ResumeGateSnapshot> | null): void {
    publish(next ? { ...READY, ...next } : READY);
}
