// src/mobile/lib/watch-sparkline-data.ts — 自選列迷你走勢的資料（目前時段的 1 分 K 收盤價＋即時尾段）
//
// 時段（設計規格 §9.3）：與 lib/intraday-session.ts 的 sessionWindowFor() 相同的時段框架（本檔內複本，見下方說明），
// 不用日曆日。
// - 盤中或收盤後（下一段開始前）：目前這一段。期貨日盤 08:45–13:45、夜盤 15:00–翌日 05:00 各自一段，
//   跨午夜不換段；股票 09:00–13:30。
// - 盤前、週末：最近一段（期貨 07:30 顯示前一晚夜盤，週六顯示週五夜盤；股票週六顯示週五）。
// - K 棒以 wallClockToUtc(datetime) 落在 (start, end + CLOSE_GRACE] 篩選；請求範圍是該時段的日期
//   （股票只有當日，期貨夜盤是起訖兩天）。
// - 最近一段沒有資料（假日），且這段已不在盤中：同一次排隊內往前補找一次（SPARK_FALLBACK_DAYS 天），
//   顯示找到的最近一段；仍沒有就保持空白，直到時段鍵改變，不每 15 分鐘重抓。
//
// 請求上限（使用者要求的迷你走勢，有限制地做；設計規格 §7.2、§13）：
// - 只有「畫面上看得到、且設定開啟」的列才 retain（自選頁沿用 IntersectionObserver 的可見列判斷）。
// - 模組層快取，鍵＝代碼＋時段起點：每檔每段成功讀取後不再請求（切換分頁、捲動來回都不重抓），
//   只有「盤中讀過、收盤後重新 retain」時補讀一次（每檔每段最多 2 次成功讀取），補上盤中沒看到的部分。
// - 盤中失敗或資料不足 2 根：SPARK_RETRY_MS 後才重試；列一直可見時由計時器到期重新排隊。
// - 佇列同時最多 SPARK_CONCURRENCY 個請求；列不可見或離開頁面（retain 全部釋放）時，尚未開始的請求移出佇列。
//   已送出的請求無法中止（fetchKbars 沒有 signal），結果照樣寫入快取。
// - 時段鍵由每分鐘一次的時鐘推得（只在有 active 列時計時）；鍵改變或時段收盤時列重新 retain。
//
// 即時尾段（不增加請求）：列收到的已節流成交（排除試撮）以 1 分 K label（分鐘結束）為桶寫入：
// 同一分鐘取代、新分鐘 append，只接受同一時段、晚於最後一根 K 棒的分鐘。走勢＝K 棒＋尾段，超過
// SPARK_MAX_POINTS 等距抽樣（保留最後一點）。列不可見或 App 在背景時沒有成交寫入尾段（見下方時間軸）。
//
// 時間軸（使用者要求「x 軸固定是開盤期間 9 點–13 點半」）：每個點另存它在「實際顯示的時段」內的位置 xs
// （0＝開盤、1＝收盤；label 是分鐘結束，收盤寬限內的 label 夾在 1），與抽樣後的點一一對應，和點同時重算、
// 放在同一個快照（SparkSeries），列只訂閱一次、點與位置不會錯開。股票、指數 09:00–13:30；期貨／選擇權日盤
// 08:45–13:45、夜盤 15:00–05:00。盤中線只畫到最後一點（約為現在）；列不可見期間沒寫入尾段的空檔畫成直線，
// 收盤後的補讀會補齊。

import { useEffect, useSyncExternalStore } from 'react';
import type { SessionWindow } from '../../lib/intraday-session';
import { fetchKbars } from '../../lib/shioaji';
import type { ContractBase, SecurityType } from '../../lib/types/contract';
import type { KBars } from '../../lib/types/market';
import { nowWallClockUtc, wallClockToUtc } from '../../lib/utils/kbars';

/** 同時進行的 K 線請求上限 */
export const SPARK_CONCURRENCY = 2;
/** 盤中失敗或資料不足時，再次嘗試前的最短間隔（ms） */
export const SPARK_RETRY_MS = 15 * 60_000;
/** 每條走勢最多的點數（抽樣） */
export const SPARK_MAX_POINTS = 120;
/** 最近一段沒有資料（假日）時往前補找的天數（每段最多補找一次） */
export const SPARK_FALLBACK_DAYS = 5;
/** 時段鍵時鐘的間隔（ms） */
export const SPARK_CLOCK_MS = 60_000;

const H = 3600;
const DAY = 86400;

type Status = 'idle' | 'queued' | 'loading' | 'ok' | 'empty' | 'error';

interface Bar {
    /** 1 分 K label（分鐘結束，台灣牆鐘編碼的 UTC 秒） */
    t: number;
    c: number;
}

/** 走勢快照：收盤價與每點在顯示時段內的位置（0＝開盤、1＝收盤），一一對應 */
export interface SparkSeries {
    points: readonly number[];
    xs: readonly number[];
}

interface Entry {
    key: string;
    contract: ContractBase;
    /** 鍵代表的時段 */
    target: SessionWindow;
    /** 實際顯示的時段（假日補找時早於 target） */
    win: SessionWindow;
    status: Status;
    /** 排隊前的狀態（取消排隊或補讀失敗時還原） */
    before: Status;
    bars: Bar[];
    tail: Bar[];
    /** 抽樣後的點與時間軸位置（不足 2 點時 null） */
    series: SparkSeries | null;
    retryAt: number;
    /** 最近一次成功讀取的牆鐘秒（0＝尚未） */
    fetchedAt: number;
    /** 成功讀取次數（≥2 根） */
    reads: number;
    holders: number;
    timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();
const queue: string[] = [];
let inflight = 0;
/** 測試重設後，舊請求的完成不再影響計數 */
let generation = 0;
const listeners = new Set<() => void>();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

const emit = () => listeners.forEach(l => l());

// ---------------------------------------------------------------------------
// 時段
//
// sessionWindowFor／hasNightSession／CLOSE_GRACE 與 lib/intraday-session.ts 相同（測試逐分鐘比對）。
// 不 import 該模組：它與桌面共用，一 import 整個模組（含 findKbarGap 等桌面用函式）都會進首屏共用 chunk，
// 超出首屏預算（≤219 KiB，設計規格 §13）。只 import 型別。

/** 收盤定盤寬限（秒），同 lib/intraday-session.ts CLOSE_GRACE */
export const CLOSE_GRACE = 240;

const hasNightSession = (sec: SecurityType) => sec === 'FUT' || sec === 'OPT';

/** 同 lib/intraday-session.ts sessionWindowFor：期/選日盤 08:45–13:45、夜盤 15:00–翌日 05:00；其他 09:00–13:30 */
export function sessionWindowFor(sec: SecurityType, t: number): SessionWindow {
    const d0 = Math.floor(t / DAY) * DAY;
    const tod = t - d0;
    if (hasNightSession(sec)) {
        if (tod <= 5 * H) return { start: d0 - DAY + 15 * H, end: d0 + 5 * H, night: true };
        if (tod <= 13.75 * H) return { start: d0 + 8.75 * H, end: d0 + 13.75 * H, night: false };
        return { start: d0 + 15 * H, end: d0 + DAY + 5 * H, night: true };
    }
    return { start: d0 + 9 * H, end: d0 + 13.5 * H, night: false };
}

function isWeekendStart(win: SessionWindow): boolean {
    const wd = new Date(win.start * 1000).getUTCDay(); // 牆鐘編碼 → 台灣星期
    return wd === 0 || wd === 6;
}

function prevWindow(sec: SecurityType, win: SessionWindow): SessionWindow {
    // 期貨：夜盤的前一段是當天日盤（13:00 落在日盤），日盤的前一段是前一晚夜盤（04:45 落在夜盤）
    if (hasNightSession(sec)) return sessionWindowFor(sec, win.start - (win.night ? 2 : 4) * H);
    return sessionWindowFor(sec, win.start - DAY);
}

/** 1 分 K label 所屬時段：收盤寬限內的 label（期貨 13:46–13:49、夜盤 05:01–05:04）歸剛收的那段 */
function labelWindow(sec: SecurityType, t: number): SessionWindow {
    const w = sessionWindowFor(sec, t);
    return t > w.start ? w : sessionWindowFor(sec, t - CLOSE_GRACE);
}

const inWindow = (win: SessionWindow, t: number) => t > win.start && t <= win.end + CLOSE_GRACE;

/**
 * 走勢要畫的時段：目前這段已開始（盤中或已收、下一段未開始）就是它（current）；
 * 盤前、週末則退到最近一段已開始的時段。國定假日無從得知，由讀取時補找處理。
 */
export function sparkTarget(sec: SecurityType, now: number): { win: SessionWindow; current: boolean } {
    let win = sessionWindowFor(sec, now);
    if (now > win.start && !isWeekendStart(win)) return { win, current: true };
    for (let i = 0; i < 8; i++) {
        win = prevWindow(sec, win);
        if (!isWeekendStart(win)) break;
    }
    return { win, current: false };
}

export function sparkKey(code: string, sessionStart: number): string {
    return `${code}|${sessionStart}`;
}

/** 目前的快取鍵（代碼＋時段起點） */
export function currentSparkKey(code: string, sec: SecurityType, now: number = nowWallClockUtc()): string {
    return sparkKey(code, sparkTarget(sec, now).win.start);
}

/** 目標時段是否已收盤（含寬限）；收盤時列重新 retain，讓盤中讀過的補讀一次 */
export function sparkSessionClosed(sec: SecurityType, now: number = nowWallClockUtc()): boolean {
    return now > sparkTarget(sec, now).win.end + CLOSE_GRACE;
}

const wallDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// K 棒

/** 落在時段 (start, end + CLOSE_GRACE] 的收盤價（datetime 為台灣牆鐘），略過無效值 */
export function sessionBars(k: KBars, win: SessionWindow): Bar[] {
    const out: Bar[] = [];
    for (let i = 0; i < k.datetime.length; i++) {
        const dt = k.datetime[i];
        if (!dt) continue;
        const t = wallClockToUtc(dt);
        if (!inWindow(win, t)) continue;
        const c = Number(k.Close[i]);
        if (Number.isFinite(c) && c > 0) out.push({ t, c });
    }
    return out;
}

/** 不晚於 before 的最近一段有資料的時段 */
function latestSessionBars(k: KBars, sec: SecurityType, before: number): { win: SessionWindow; bars: Bar[] } | null {
    for (let i = k.datetime.length - 1; i >= 0; i--) {
        const dt = k.datetime[i];
        const c = Number(k.Close[i]);
        if (!dt || !(c > 0)) continue;
        const t = wallClockToUtc(dt);
        if (!(t <= before)) continue;
        const win = labelWindow(sec, t);
        const bars = sessionBars(k, win);
        if (bars.length > 0) return { win, bars };
    }
    return null;
}

/** 抽樣的索引：不超過 SPARK_MAX_POINTS 時全取；否則等距抽樣並保留最後一點 */
function sampleIndices(n: number): number[] {
    if (n <= SPARK_MAX_POINTS) return Array.from({ length: n }, (_, i) => i);
    const step = n / (SPARK_MAX_POINTS - 1);
    const out: number[] = [];
    for (let i = 0; i < SPARK_MAX_POINTS - 1; i++) out.push(Math.floor(i * step));
    out.push(n - 1);
    return out;
}

/** 超過上限時等距抽樣並保留最後一點 */
export function samplePoints(closes: readonly number[]): number[] {
    return sampleIndices(closes.length).map(i => closes[i]!);
}

function recompute(e: Entry): void {
    const all = e.tail.length > 0 ? [...e.bars, ...e.tail] : e.bars;
    if (all.length < 2) {
        e.series = null;
        return;
    }
    const idx = sampleIndices(all.length);
    // 時間軸位置：K 棒與尾段的 t 是分鐘結束的 label；盤中只到最後一點，收盤寬限內的 label 夾在 1
    const span = e.win.end - e.win.start;
    e.series = {
        points: idx.map(i => all[i]!.c),
        xs: idx.map(i => Math.min(1, Math.max(0, (all[i]!.t - e.win.start) / span))),
    };
}

// ---------------------------------------------------------------------------
// 佇列

interface LoadResult {
    win: SessionWindow;
    bars: Bar[];
    wall: number;
    inProgress: boolean;
}

async function load(e: Entry): Promise<LoadResult> {
    const { target } = e;
    const sec = e.contract.security_type;
    const k = await fetchKbars(e.contract, wallDate(target.start), wallDate(target.end));
    const wall = nowWallClockUtc();
    const inProgress = wall > target.start && wall <= target.end + CLOSE_GRACE;
    const bars = sessionBars(k, target);
    if (bars.length > 0 || inProgress) return { win: target, bars, wall, inProgress };
    // 假日：這段沒有資料、也不在盤中 → 往前補找一次，顯示最近一段
    const older = await fetchKbars(e.contract, wallDate(target.start - SPARK_FALLBACK_DAYS * DAY), wallDate(target.end));
    const found = latestSessionBars(older, sec, target.start);
    return found ? { ...found, wall, inProgress } : { win: target, bars, wall, inProgress };
}

function apply(e: Entry, r: LoadResult): void {
    if (r.bars.length < 2 && e.before === 'ok') {
        // 收盤後補讀反而沒拿到：保留原本的 K 棒與尾段，不再補讀
        e.status = 'ok';
        e.reads = 2;
        return;
    }
    e.win = r.win;
    e.bars = r.bars;
    const lastT = r.bars.length > 0 ? r.bars[r.bars.length - 1]!.t : -Infinity;
    e.tail = r.win.start === e.target.start ? e.tail.filter(b => b.t > lastT) : [];
    recompute(e);
    if (r.bars.length >= 2) {
        e.status = 'ok';
        e.reads++;
        e.fetchedAt = r.wall;
        e.retryAt = 0;
    } else {
        e.status = 'empty';
        // 盤中可能只是還沒成交：稍後再試；已不在盤中（收盤、假日）：保持空白到時段鍵改變
        e.retryAt = r.inProgress ? Date.now() + SPARK_RETRY_MS : Number.POSITIVE_INFINITY;
    }
}

function fail(e: Entry): void {
    e.status = e.before === 'ok' ? 'ok' : 'error';
    e.retryAt = Date.now() + SPARK_RETRY_MS;
}

function needsCloseRefresh(e: Entry, wall: number): boolean {
    return e.reads === 1 && e.win.start === e.target.start && e.fetchedAt > 0
        && e.fetchedAt <= e.target.end && wall > e.target.end + CLOSE_GRACE;
}

function isDue(e: Entry, nowMs: number, wall: number): boolean {
    if (e.status === 'idle') return true;
    if (e.status === 'error' || e.status === 'empty') return nowMs >= e.retryAt;
    if (e.status === 'ok') return needsCloseRefresh(e, wall) && nowMs >= e.retryAt;
    return false;
}

function clearTimer(e: Entry): void {
    if (e.timer !== null) clearTimeout(e.timer);
    e.timer = null;
}

function enqueue(e: Entry): void {
    clearTimer(e);
    e.before = e.status;
    e.status = 'queued';
    queue.push(e.key);
    pump();
}

/** 列仍可見時，重試時間到就重新排隊（不必等列重新可見） */
function scheduleRetry(e: Entry): void {
    clearTimer(e);
    if (e.holders <= 0 || !Number.isFinite(e.retryAt)) return;
    const wall = nowWallClockUtc();
    const waiting = e.status === 'error' || e.status === 'empty' || (e.status === 'ok' && needsCloseRefresh(e, wall));
    if (!waiting || typeof setTimeout !== 'function') return;
    e.timer = setTimeout(() => {
        e.timer = null;
        if (e.holders > 0 && entries.get(e.key) === e && isDue(e, Date.now(), nowWallClockUtc())) enqueue(e);
    }, Math.max(0, e.retryAt - Date.now()));
}

function pump(): void {
    while (inflight < SPARK_CONCURRENCY && queue.length > 0) {
        const key = queue.shift()!;
        const e = entries.get(key);
        if (!e || e.status !== 'queued') continue;
        e.status = 'loading';
        inflight++;
        const gen = generation;
        // Promise.resolve 包起來：同步拋錯或回傳非 Promise 都走失敗分支，不會讓排隊卡住
        Promise.resolve()
            .then(() => load(e))
            .then(r => apply(e, r), () => fail(e))
            .finally(() => {
                if (gen !== generation) return;
                inflight--;
                emit();
                scheduleRetry(e);
                pump();
            });
    }
}

/** 同一代碼換時段後，移除舊時段、沒有持有者也沒有進行中請求的項目（快取不跨段累積） */
function pruneCode(code: string, keep: string): void {
    for (const [key, e] of entries) {
        if (key !== keep && e.contract.code === code && e.status !== 'loading' && e.holders <= 0) {
            clearTimer(e);
            entries.delete(key);
        }
    }
}

/**
 * 列可見時呼叫：需要時排入佇列。回傳釋放函式；最後一個持有者釋放時，尚未開始的請求移出佇列。
 */
export function retainSparkline(contract: ContractBase): () => void {
    const wall = nowWallClockUtc();
    const { win } = sparkTarget(contract.security_type, wall);
    const key = sparkKey(contract.code, win.start);
    let e = entries.get(key);
    if (!e) {
        pruneCode(contract.code, key);
        e = {
            key, contract, target: win, win, status: 'idle', before: 'idle', bars: [], tail: [], series: null,
            retryAt: 0, fetchedAt: 0, reads: 0, holders: 0, timer: null,
        };
        entries.set(key, e);
    }
    const entry = e;
    entry.holders++;
    if (isDue(entry, Date.now(), wall)) enqueue(entry);
    else if (entry.holders === 1 && entry.status !== 'queued' && entry.status !== 'loading') scheduleRetry(entry);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        entry.holders--;
        if (entry.holders > 0) return;
        clearTimer(entry);
        if (entry.status === 'queued') {
            const i = queue.indexOf(key);
            if (i >= 0) queue.splice(i, 1);
            entry.status = entry.before;
        }
    };
}

/**
 * 即時成交寫入尾段（t＝成交時間，台灣牆鐘編碼的 UTC 秒）。只寫入已有的項目（列 retain 過）、
 * 同一時段、晚於最後一根 K 棒的分鐘；與最後一根同一分鐘時更新它的收盤。
 */
export function recordSparkTick(code: string, sec: SecurityType, price: number, t: number): void {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(t)) return;
    const label = Math.floor(t / 60) * 60 + 60;
    const w = labelWindow(sec, label);
    if (!inWindow(w, label)) return;
    const e = entries.get(sparkKey(code, w.start));
    if (!e || e.win.start !== w.start) return;
    const lastBar = e.bars[e.bars.length - 1];
    if (lastBar && label <= lastBar.t) {
        if (label < lastBar.t || lastBar.c === price) return;
        lastBar.c = price;
    } else {
        const last = e.tail[e.tail.length - 1];
        if (last && label < last.t) return;
        if (last && label === last.t) {
            if (last.c === price) return;
            last.c = price;
        } else {
            e.tail.push({ t: label, c: price });
        }
    }
    recompute(e);
    emit();
}

/** 目前時段快取的點（沒有資料時 null） */
export function getSparklinePoints(code: string, sec: SecurityType = 'STK'): readonly number[] | null {
    return entries.get(currentSparkKey(code, sec))?.series?.points ?? null;
}

/** 目前時段每個點在顯示時段內的位置（0–1，與 getSparklinePoints 一一對應；沒有資料時 null） */
export function getSparklineXs(code: string, sec: SecurityType = 'STK'): readonly number[] | null {
    return entries.get(currentSparkKey(code, sec))?.series?.xs ?? null;
}

export function subscribeSparklines(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** 每 SPARK_CLOCK_MS 通知一次（只在有訂閱者時計時），讓列的時段鍵跟著時間前進 */
export function subscribeSparkClock(listener: () => void): () => void {
    clockListeners.add(listener);
    if (clockTimer === null && typeof setInterval === 'function') {
        clockTimer = setInterval(() => clockListeners.forEach(l => l()), SPARK_CLOCK_MS);
    }
    return () => {
        clockListeners.delete(listener);
        if (clockListeners.size === 0 && clockTimer !== null) {
            clearInterval(clockTimer);
            clockTimer = null;
        }
    };
}

const noopSubscribe = () => () => {};

/**
 * 列用：active（列可見、設定開啟、可畫走勢的商品）時 retain，回傳目前時段快取的走勢快照（點＋時間軸位置）。
 * 時段鍵改變（換段）或時段收盤時重新 retain。active 為 false 時不排隊、不請求、不計時，只讀快取。
 */
export function useSparkline(contract: ContractBase, active: boolean): SparkSeries | null {
    const code = contract.code;
    const sec = contract.security_type;
    const clock = active ? subscribeSparkClock : noopSubscribe;
    const key = useSyncExternalStore(clock, () => currentSparkKey(code, sec), () => '');
    const closed = useSyncExternalStore(clock, () => sparkSessionClosed(sec), () => false);
    useEffect(() => {
        if (!active) return;
        return retainSparkline(contract);
        // 合約物件可能因清單重讀換新；以代碼為準
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [code, active, key, closed]);
    return useSyncExternalStore(subscribeSparklines, () => entries.get(key)?.series ?? null, () => null);
}

/** 列用：把已節流的即時成交寫入尾段（試撮不算；沒有成交時間時用現在） */
export function useSparkTick(
    contract: ContractBase,
    tick: { close?: string | number | null; date?: string; time?: string; simtrade?: boolean } | undefined,
): void {
    const code = contract.code;
    const sec = contract.security_type;
    useEffect(() => {
        if (!tick || tick.simtrade === true) return;
        const t = tick.date && tick.time ? wallClockToUtc(`${tick.date}T${tick.time}`) : NaN;
        recordSparkTick(code, sec, Number(tick.close), Number.isFinite(t) && t > 0 ? t : nowWallClockUtc());
    }, [tick, code, sec]);
}

/** 測試用：目前排隊與進行中的數量 */
export function sparklineQueueForTest(): { queued: number; inflight: number } {
    return { queued: queue.length, inflight };
}

/** 測試用：清空快取、佇列、計時與監聽 */
export function resetSparklinesForTest(): void {
    generation++;
    for (const e of entries.values()) clearTimer(e);
    entries.clear();
    queue.length = 0;
    inflight = 0;
    listeners.clear();
    clockListeners.clear();
    if (clockTimer !== null) clearInterval(clockTimer);
    clockTimer = null;
}
