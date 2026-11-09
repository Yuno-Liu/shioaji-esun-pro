// src/mobile/lib/line-flow.ts — 走勢副圖「分時買賣力」「大單／小單買賣力」的逐筆彙總（設計規格 §7.3）
//
// 範圍：股票＋ETF（security_type STK；權證、指數、期貨、選擇權不提供：lineFlowSupported）。
//
// 資料：
// - 開啟指標時才以 fetchHistoryTicks(contract, 日期) 下載該日全部逐筆（POST /api/v1/data/ticks，欄位式陣列），
//   O(n) 一次彙總成每分鐘的桶；之後由即時成交（onAnyTick，沿用頁面既有的報價訂閱，不另訂閱）累加。不輪詢。
// - 量的單位是「張」（股票、ETF 的 tick volume 與 kbar 相同為張）；單筆成交金額＝價格 × 張 × 1000（元）。
// - tick_type：1＝外盤（主動買）、2＝內盤（主動賣）；0 或其他＝無法判斷，不計入買賣力。
//   零股（intraday_odd）、試撮（simtrade）、量 ≤ 0 的成交不計（onAnyTick 本來就不送，這裡再擋一次）。
//   開盤前（≤ 09:00）的成交不計。集合競價的撮合沒有主動買賣方，tick_type 只是標記：當日第一筆且在 09:00:30 前
//   （開盤集合競價）與 13:25 起（收盤集合競價、盤後定價）都不計。真實資料（2330，2026-11-06）開盤那筆 9,656 張、
//   收盤那筆 5,833 張，約占全天 16%，計入會讓累積線一開盤就大幅偏移。成交量副圖不受影響（量照常計）。
// - 分鐘：與走勢 K 棒相同的 label（tickBucket：時間無條件進位到分，夾在 (09:00, 13:30]）。
// - 大單：單筆成交金額 ≥ 門檻（LINE_FLOW_THRESHOLDS 每個門檻各記一份，改門檻不必重抓）；其餘為小單。
//   這是依單筆金額的估算，不是實際的投資人身分。
//
// 歷史與即時的接合（不重複、不漏）：
// - 第一次 retain 時就開始收即時成交；請求進行中先緩衝。歷史回來後，緩衝裡只接「晚於最後一筆歷史」的成交：
//   時間（到微秒）早於最後一筆歷史的略過；與最後一筆歷史同一時間的，略過與歷史同時間筆數相同的筆數，其餘接上。
// - 之後以累計量（total_volume）檢查即時成交是否連續：本筆前的累計量 > 上一筆的累計量＝中間漏了（例如離開這檔、
//   訂閱被釋放）→ 標記過期；有人在看且距上次下載 ≥ FLOW_GAP_REFETCH_MIN_MS 才重抓一次（否則下次 retain 時）。
//
// 快取與請求：
// - 以「代碼＋日期」為鍵存在記憶體（最多 MAX_FLOW_ENTRIES 份，先清沒人在看、最久沒用的）；
//   換檔、換週期再回到走勢沿用。正常情況每檔每日 1 次請求；只有偵測到漏量才再抓。
// - 失敗不自動重試：下次 retain（重新開關指標、重新進入走勢）且距失敗 ≥ FLOW_RETRY_MIN_MS 才重抓。

import { isWarrantContract } from '../../lib/contract-market';
import { fetchHistoryTicks } from '../../lib/shioaji';
import { onAnyTick } from '../../lib/stream';
import type { ContractBase } from '../../lib/types/contract';
import type { SseTick } from '../../lib/types/market';
import type { HistoryTicks } from '../../lib/types/tick';
import { LINE_FLOW_THRESHOLDS } from './line-indicators';

export const MAX_FLOW_ENTRIES = 8;
/** 失敗後重新 retain 時，距上次失敗至少這麼久才重抓（避免連續開關狂打） */
export const FLOW_RETRY_MIN_MS = 30_000;
/** 偵測到漏量後重抓的最短間隔 */
export const FLOW_GAP_REFETCH_MIN_MS = 120_000;
/** 請求進行中緩衝的即時成交上限（超過就不再緩衝，標記過期，下次重抓） */
const MAX_BUFFER = 200_000;

const DAY = 86400;
const H = 3600;
/** 盤中連續交易結束（13:25 起為收盤集合競價）：這之後的成交不計入買賣力 */
export const CONTINUOUS_END_SOD = 13 * H + 25 * 60;
/** 當日第一筆成交若在 09:00 之後這幾秒內，視為開盤集合競價的撮合，不計入買賣力 */
export const OPEN_AUCTION_WINDOW_S = 30;

/**
 * 股票＋ETF 才提供（權證、指數、期貨、選擇權不提供）。
 * 權證以 lib isWarrantContract 判斷：SDK 1.7 以前權證可能標成 STK，此時看代號編碼區間（上游 #394）。
 */
export function lineFlowSupported(contract: { security_type?: string | null; code?: string } | null | undefined): boolean {
    if (!contract || contract.security_type !== 'STK') return false;
    return !isWarrantContract({ security_type: contract.security_type, code: contract.code });
}

// ---- 純函式：解析、分桶、彙總 ----

/** 字串中的 HH:MM:SS(.ffffff) → 當日秒數（含小數）；找不到回傳 NaN */
export function tickSecondsOfDay(s: string): number {
    const m = /(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?/.exec(s); // 日期部分沒有冒號，不會誤配
    if (!m) return NaN;
    const frac = m[4] ? Number(`0.${m[4]}`) : 0;
    return Number(m[1]) * H + Number(m[2]) * 60 + Number(m[3]) + frac;
}

/** 'YYYY-MM-DD'、'YYYY/MM/DD'、'YYYYMMDD'（可帶時間）→ 8 位數字日期；認不得回傳 '' */
export function dateDigits(s: string): string {
    const m = /^(\d{4})\D?(\d{2})\D?(\d{2})/.exec(s);
    return m ? `${m[1]}${m[2]}${m[3]}` : '';
}

/** 8 位數字日期 → 當日 00:00 的牆鐘秒數（當 UTC，與圖表時間軸相同） */
export function dayStartUtc(digits: string): number {
    return Date.UTC(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)) - 1, Number(digits.slice(6, 8))) / 1000;
}

export interface FlowMinute {
    /** 分鐘 label（牆鐘秒數，當 UTC） */
    time: number;
    /** 外盤量（張） */
    buy: number;
    /** 內盤量（張） */
    sell: number;
    /** 各門檻（LINE_FLOW_THRESHOLDS 同索引）的大單外盤量、內盤量（張） */
    bigBuy: number[];
    bigSell: number[];
}

export interface FlowAgg {
    minutes: Map<number, FlowMinute>;
    /** 計入的成交筆數（外盤＋內盤） */
    ticks: number;
    /** 已看過當日盤中第一筆成交（開盤集合競價的判斷只做一次） */
    openingSeen: boolean;
}

export function newFlowAgg(): FlowAgg {
    return { minutes: new Map(), ticks: 0, openingSeen: false };
}

/** 一筆成交計入彙總；回傳是否計入。dayUtc＝當日 00:00，sod＝當日秒數（含小數） */
export function addFlowTick(agg: FlowAgg, dayUtc: number, sod: number, price: number, volume: number, tickType: number): boolean {
    if (!(volume > 0) || !(price > 0) || !Number.isFinite(sod)) return false;
    const start = dayUtc + 9 * H;
    const end = dayUtc + 13.5 * H;
    const t = dayUtc + sod;
    // 盤前、收盤集合競價（13:25 起）與盤後定價不計
    if (t <= start || sod >= CONTINUOUS_END_SOD) return false;
    // 當日盤中第一筆（不論 tick_type）：在 09:00:30 前＝開盤集合競價的撮合，不計；之後才開始的第一筆是連續交易，照常計
    if (!agg.openingSeen) {
        agg.openingSeen = true;
        if (sod < 9 * H + OPEN_AUCTION_WINDOW_S) return false;
    }
    if (tickType !== 1 && tickType !== 2) return false;
    const label = Math.min(Math.max(Math.ceil(t / 60) * 60, start + 60), end);
    let m = agg.minutes.get(label);
    if (!m) {
        const n = LINE_FLOW_THRESHOLDS.length;
        m = { time: label, buy: 0, sell: 0, bigBuy: new Array<number>(n).fill(0), bigSell: new Array<number>(n).fill(0) };
        agg.minutes.set(label, m);
    }
    const amount = price * volume * 1000;
    const buy = tickType === 1;
    if (buy) m.buy += volume;
    else m.sell += volume;
    const big = buy ? m.bigBuy : m.bigSell;
    for (let k = 0; k < LINE_FLOW_THRESHOLDS.length; k++) {
        if (amount >= LINE_FLOW_THRESHOLDS[k]! * 10_000) big[k]! += volume;
    }
    agg.ticks += 1;
    return true;
}

/** 接合點：最後一筆歷史的時間（當日秒數），以及與它同時間的歷史筆數（緩衝裡同時間的要略過這麼多筆） */
export interface FlowJoin {
    lastSod: number;
    sameCount: number;
}

/** 一次 O(n) 彙總歷史逐筆 */
export function aggregateHistory(h: HistoryTicks, dayUtc: number): { agg: FlowAgg; join: FlowJoin } {
    const agg = newFlowAgg();
    const join: FlowJoin = { lastSod: -Infinity, sameCount: 0 };
    const n = h.datetime?.length ?? 0;
    for (let i = 0; i < n; i++) {
        const dt = h.datetime[i];
        if (!dt) continue;
        const sod = tickSecondsOfDay(dt);
        if (!Number.isFinite(sod)) continue;
        if (sod > join.lastSod) {
            join.lastSod = sod;
            join.sameCount = 1;
        } else if (sod === join.lastSod) join.sameCount += 1;
        addFlowTick(agg, dayUtc, sod, Number(h.close[i]), Number(h.volume[i]), Number(h.tick_type[i]));
    }
    return { agg, join };
}

/** 緩衝裡的這筆（時間 sod）是否要接在歷史之後；會消耗 join.sameCount */
export function takeAfterJoin(join: FlowJoin, sod: number): boolean {
    if (!Number.isFinite(sod)) return false;
    if (sod < join.lastSod) return false;
    if (sod === join.lastSod && join.sameCount > 0) {
        join.sameCount -= 1;
        return false;
    }
    return true;
}

/** 即時成交是否可計入（再擋一次零股、試撮、沒有量） */
function liveTickUsable(tk: SseTick): boolean {
    return !tk.simtrade && !tk.intraday_odd && tk.volume > 0;
}

function addLiveTick(agg: FlowAgg, dayUtc: number, tk: SseTick): boolean {
    return addFlowTick(agg, dayUtc, tickSecondsOfDay(tk.time), Number(tk.close), tk.volume, tk.tick_type);
}

export interface FlowView {
    times: number[];
    /** 每分鐘外盤、內盤量（張） */
    buy: number[];
    sell: number[];
    /** 累積淨買力 Σ(外盤 − 內盤)（張） */
    cumNet: number[];
    /** 累積大單淨買、小單淨買（張） */
    bigNet: number[];
    smallNet: number[];
    /** time → 索引 */
    index: Map<number, number>;
    totalBuy: number;
    totalSell: number;
}

/** 彙總 → 畫圖用的序列（時間由舊到新）；thrIdx＝大單門檻在 LINE_FLOW_THRESHOLDS 的索引 */
export function flowView(agg: FlowAgg, thrIdx: number): FlowView {
    const ms = [...agg.minutes.values()].sort((a, b) => a.time - b.time);
    const v: FlowView = { times: [], buy: [], sell: [], cumNet: [], bigNet: [], smallNet: [], index: new Map(), totalBuy: 0, totalSell: 0 };
    let cum = 0;
    let big = 0;
    let small = 0;
    for (const m of ms) {
        const bb = m.bigBuy[thrIdx] ?? 0;
        const bs = m.bigSell[thrIdx] ?? 0;
        cum += m.buy - m.sell;
        big += bb - bs;
        small += (m.buy - bb) - (m.sell - bs);
        v.index.set(m.time, v.times.length);
        v.times.push(m.time);
        v.buy.push(m.buy);
        v.sell.push(m.sell);
        v.cumNet.push(cum);
        v.bigNet.push(big);
        v.smallNet.push(small);
        v.totalBuy += m.buy;
        v.totalSell += m.sell;
    }
    return v;
}

/** 外盤比（%）；沒有成交回傳 null */
export function buyRatio(buy: number, sell: number): number | null {
    const total = buy + sell;
    return total > 0 ? (buy / total) * 100 : null;
}

// ---- 記憶體快取＋即時累加 ----

export type FlowStatus = 'loading' | 'ready' | 'error';

interface Entry {
    key: string;
    contract: ContractBase;
    date: string;
    dayUtc: number;
    status: FlowStatus;
    agg: FlowAgg;
    version: number;
    /** 進行中的下載（含緩衝的即時成交）；null＝沒有 */
    pending: { buffer: SseTick[]; overflow: boolean } | null;
    fetchedAt: number;
    failedAt: number;
    /** 偵測到漏量（或緩衝溢出）：下次 retain 或節流到期時重抓 */
    stale: boolean;
    /** 上一筆即時成交的累計量（連續性檢查） */
    lastTotal: number | null;
    subs: Set<() => void>;
    lastUsed: number;
    /** 測試／除錯：送出的請求數 */
    requests: number;
}

export interface LineFlowSnapshot {
    status: FlowStatus;
    agg: FlowAgg;
    /** 有變動就加一（畫圖節流用） */
    version: number;
    date: string;
}

const entries = new Map<string, Entry>();
let offTick: (() => void) | null = null;

const keyOf = (code: string, digits: string) => `${code}|${digits}`;

function notify(e: Entry) {
    e.version += 1;
    for (const fn of [...e.subs]) fn();
}

function ensureTickListener() {
    if (offTick) return;
    offTick = onAnyTick(tk => {
        const e = entries.get(keyOf(tk.code, dateDigits(tk.date ?? '')));
        if (!e || !liveTickUsable(tk)) return;
        // 連續性：本筆之前的累計量比上一筆的累計量多＝中間漏了成交
        const total = Number(tk.total_volume);
        if (Number.isFinite(total)) {
            if (e.lastTotal !== null && total - tk.volume > e.lastTotal) markStale(e);
            e.lastTotal = e.lastTotal === null ? total : Math.max(e.lastTotal, total);
        }
        if (e.pending) {
            if (e.pending.buffer.length < MAX_BUFFER) e.pending.buffer.push(tk);
            else e.pending.overflow = true;
        }
        if (e.status === 'ready' && addLiveTick(e.agg, e.dayUtc, tk)) notify(e);
    });
}

function markStale(e: Entry) {
    e.stale = true;
    if (e.subs.size > 0 && !e.pending && Date.now() - e.fetchedAt >= FLOW_GAP_REFETCH_MIN_MS) load(e);
}

function load(e: Entry) {
    if (e.pending) return;
    const pending = { buffer: [] as SseTick[], overflow: false };
    e.pending = pending;
    e.fetchedAt = Date.now();
    e.stale = false;
    e.requests += 1;
    // 第一次下載顯示「讀取中」；重抓（漏量）時保留目前的彙總，換上新的再通知
    if (e.status !== 'ready') {
        e.status = 'loading';
        notify(e);
    }
    fetchHistoryTicks(e.contract, e.date).then(
        h => {
            if (entries.get(e.key) !== e) return;
            const { agg, join } = aggregateHistory(h, e.dayUtc);
            for (const tk of pending.buffer) {
                if (takeAfterJoin(join, tickSecondsOfDay(tk.time))) addLiveTick(agg, e.dayUtc, tk);
            }
            e.pending = null;
            e.agg = agg;
            e.status = 'ready';
            if (pending.overflow) e.stale = true;
            notify(e);
        },
        () => {
            if (entries.get(e.key) !== e) return;
            e.pending = null;
            e.failedAt = Date.now();
            // 重抓失敗時保留原本的彙總（仍為過期）；第一次就失敗才顯示錯誤
            if (e.status !== 'ready') e.status = 'error';
            else e.stale = true;
            notify(e);
        },
    );
}

function evict() {
    if (entries.size <= MAX_FLOW_ENTRIES) return;
    const idle = [...entries.values()].filter(e => e.subs.size === 0 && !e.pending).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of idle) {
        if (entries.size <= MAX_FLOW_ENTRIES) break;
        entries.delete(e.key);
    }
}

/**
 * 開始使用某檔某日的買賣力彙總：沒有快取（或過期、上次失敗且已過 FLOW_RETRY_MIN_MS）才下載。
 * date：'YYYY-MM-DD'（走勢目前時段的日期）。onChange 在彙總或狀態改變時呼叫（每筆成交都可能呼叫，呼叫端自行節流）。
 */
export function retainLineFlow(contract: ContractBase, date: string, onChange: () => void): { get: () => LineFlowSnapshot; release: () => void } {
    ensureTickListener();
    const digits = dateDigits(date);
    const key = keyOf(contract.code, digits);
    let e = entries.get(key);
    const now = Date.now();
    if (!e) {
        e = {
            key, contract, date, dayUtc: dayStartUtc(digits), status: 'loading', agg: newFlowAgg(), version: 0,
            pending: null, fetchedAt: 0, failedAt: 0, stale: false, lastTotal: null, subs: new Set(), lastUsed: now, requests: 0,
        };
        entries.set(key, e);
        load(e);
        evict();
    } else if (!e.pending && ((e.status === 'error' && now - e.failedAt >= FLOW_RETRY_MIN_MS)
        || (e.stale && now - e.fetchedAt >= FLOW_GAP_REFETCH_MIN_MS))) {
        load(e);
    }
    const entry = e;
    entry.subs.add(onChange);
    entry.lastUsed = now;
    return {
        get: () => ({ status: entry.status, agg: entry.agg, version: entry.version, date: entry.date }),
        release: () => {
            entry.subs.delete(onChange);
            entry.lastUsed = Date.now();
        },
    };
}

/** 測試用：某檔某日送出的請求數 */
export function lineFlowRequestsForTest(code: string, date: string): number {
    return entries.get(keyOf(code, dateDigits(date)))?.requests ?? 0;
}

/** 測試用：清掉快取與即時監聽 */
export function resetLineFlowForTest() {
    entries.clear();
    offTick?.();
    offTick = null;
}

/** 牆鐘秒數（當 UTC）→ 'YYYY-MM-DD' */
export function dateOfWallClock(t: number): string {
    const d = new Date(Math.floor(t / DAY) * DAY * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
