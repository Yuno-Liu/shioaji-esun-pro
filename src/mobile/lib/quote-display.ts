// src/mobile/lib/quote-display.ts — 交易頁標頭的價格來源（純函式；規格 §6.2）
//
// 優先序：
//   1. 即時成交（非試撮 tick）／指數 quote_idx
//   2. 本頁看過的上一筆真實成交（目前 tick 是試撮揭示時）
//   3. 報價快照（close／change_price／change_rate／total_volume）
//   4. 合約參考價（標示「參考價」，不顯示漲跌）
// 成交（1、2）早於快照時間時改用快照（與 src/hooks/use-live-snapshots 的 atLeastSnapshot 規則相同）。
//
// - 試撮（tick.simtrade）揭示價可能是天地價，**不當成最新成交價**：只回傳在 sim 供「試撮」徽章顯示。
// - 漲跌幅一律以漲跌與參考價推算（指數用 index.reference），不使用 tick.pct_chg（股票與期權串流單位不同）。
// - headerStats（統計格）、innerOuterRatio（內外盤比）、splitPercent（五檔買賣比例）也在這裡，與價格來源規則共用。

import { marketTime } from '../../lib/display-book';
import type { Snapshot } from '../../lib/types/market';

export type QuoteSource = 'tick' | 'index' | 'snapshot' | 'reference' | 'none';

export interface HeaderTick {
    date?: string;
    time?: string;
    close: string;
    price_chg?: string;
    total_volume?: number;
    simtrade?: boolean;
    // 統計格（headerStats）與內外盤比（innerOuterRatio）用；串流 Decimal 欄位是字串
    open?: string;
    high?: string;
    low?: string;
    avg_price?: string;
    /** 最後一筆成交量（單量） */
    volume?: number;
    total_amount?: string;
    /** 內盤累計量（以買價成交） */
    bid_side_total_vol?: number;
    /** 外盤累計量（以賣價成交） */
    ask_side_total_vol?: number;
}

export interface HeaderIndex {
    date?: string;
    time?: string;
    close: string;
    reference: string;
    open?: string;
    high?: string;
    low?: string;
}

export interface HeaderQuoteInput {
    /** 合約參考價 */
    reference: number | undefined;
    tick?: HeaderTick;
    index?: HeaderIndex;
    /** 本頁看過的上一筆非試撮成交（目前 tick 為試撮時使用） */
    lastRealTick?: HeaderTick;
    snapshot?: Snapshot;
}

export interface HeaderQuote {
    price: number | null;
    change: number | null;
    pct: number | null;
    dir: 'up' | 'down' | 'flat';
    source: QuoteSource;
    /** 累計成交量（指數、只有參考價時為 null） */
    totalVolume: number | null;
    /** 目前的試撮揭示（只供徽章顯示，不是成交價） */
    sim: { price: number; change: number | null } | null;
}

const num = (v: unknown): number => (v === undefined || v === null || v === '' ? NaN : Number(v));
const dirOf = (c: number | null): HeaderQuote['dir'] => (c === null || !Number.isFinite(c) || c === 0 ? 'flat' : c > 0 ? 'up' : 'down');

/** 成交時間不早於快照時間（時間無法比較時視為較新：串流本來就比一次性的快照新） */
function notOlderThan(tick: HeaderTick, snapshot: Snapshot): boolean {
    const a = marketTime(tick.date, tick.time);
    const b = marketTime(snapshot.datetime);
    return !Number.isFinite(a) || !Number.isFinite(b) || a >= b;
}

function fromTick(tick: HeaderTick, reference: number | undefined): Omit<HeaderQuote, 'sim'> | null {
    const price = num(tick.close);
    if (!Number.isFinite(price) || price <= 0) return null;
    const chgRaw = num(tick.price_chg);
    const ref = reference && reference > 0 ? reference : null;
    const change = Number.isFinite(chgRaw) ? chgRaw : ref !== null ? price - ref : null;
    // 參考價優先用合約；沒有時用串流自身的參考（現價 − 漲跌）
    const base = ref ?? (change !== null && price - change > 0 ? price - change : null);
    const pct = change !== null && base !== null ? (change / base) * 100 : null;
    const total = num(tick.total_volume);
    return { price, change, pct, dir: dirOf(change), source: 'tick', totalVolume: Number.isFinite(total) ? total : null };
}

/** 採用的真實成交：非試撮、價格有效，且不早於快照（否則回 undefined，改用快照） */
function chosenTick({ tick, lastRealTick, snapshot }: HeaderQuoteInput): HeaderTick | undefined {
    const real = tick && tick.simtrade !== true ? tick : lastRealTick && lastRealTick.simtrade !== true ? lastRealTick : undefined;
    if (!real || !(num(real.close) > 0)) return undefined;
    return !snapshot || !(snapshot.close > 0) || notOlderThan(real, snapshot) ? real : undefined;
}

const validIndex = (index: HeaderIndex | undefined): index is HeaderIndex => !!index && num(index.close) > 0;
const validSnapshot = (s: Snapshot | undefined): s is Snapshot => !!s && Number.isFinite(s.close) && s.close > 0;

export function headerQuote(input: HeaderQuoteInput): HeaderQuote {
    const { reference, tick, index, snapshot } = input;
    const sim = tick?.simtrade === true && num(tick.close) > 0
        ? { price: num(tick.close), change: Number.isFinite(num(tick.price_chg)) ? num(tick.price_chg) : null }
        : null;

    if (index) {
        const price = num(index.close);
        const ref = num(index.reference);
        if (Number.isFinite(price) && price > 0) {
            const change = Number.isFinite(ref) && ref > 0 ? price - ref : null;
            const pct = change !== null ? (change / ref) * 100 : null;
            return { price, change, pct, dir: dirOf(change), source: 'index', totalVolume: null, sim: null };
        }
    }

    const real = chosenTick(input);
    if (real) {
        const q = fromTick(real, reference);
        if (q) return { ...q, sim };
    }

    if (validSnapshot(snapshot)) {
        const change = Number.isFinite(snapshot.change_price) ? snapshot.change_price : null;
        const pct = Number.isFinite(snapshot.change_rate) ? snapshot.change_rate : null;
        const total = Number.isFinite(snapshot.total_volume) ? snapshot.total_volume : null;
        return { price: snapshot.close, change, pct, dir: dirOf(change), source: 'snapshot', totalVolume: total, sim };
    }

    if (reference && reference > 0) {
        return { price: reference, change: null, pct: null, dir: 'flat', source: 'reference', totalVolume: null, sim };
    }
    return { price: null, change: null, pct: null, dir: 'flat', source: 'none', totalVolume: null, sim };
}

// ---- 統計格（開、高、低、參、均、總量、單量、成交金額） ----

export interface HeaderStats {
    /** 資料來源與 headerQuote 一致：成交、指數或快照；只有參考價時為 'none' */
    source: 'tick' | 'index' | 'snapshot' | 'none';
    open: number | null;
    high: number | null;
    low: number | null;
    /** 參考價（合約；沒有時由成交價與漲跌推回） */
    reference: number | null;
    /** 均價 */
    avg: number | null;
    /** 累計成交量（整股：張；零股：股；期權：口） */
    totalVolume: number | null;
    /** 最後一筆成交量（單量） */
    lastVolume: number | null;
    /** 累計成交金額（元；只對股票有意義） */
    totalAmount: number | null;
}

const positive = (v: unknown): number | null => {
    const n = num(v);
    return Number.isFinite(n) && n > 0 ? n : null;
};
const nonNegative = (v: unknown): number | null => {
    const n = num(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * 統計格的數值：與 headerQuote 採用同一個來源（成交／指數／快照），不逐欄混用——
 * 避免把前一日快照的累計量接在今日成交上。試撮 tick 的開高低與量不採用。
 */
export function headerStats(input: HeaderQuoteInput): HeaderStats {
    const { reference, index, snapshot } = input;
    const contractRef = reference && reference > 0 ? reference : null;
    const empty = { open: null, high: null, low: null, avg: null, totalVolume: null, lastVolume: null, totalAmount: null };

    if (validIndex(index)) {
        return { ...empty, source: 'index', open: positive(index.open), high: positive(index.high), low: positive(index.low), reference: positive(index.reference) ?? contractRef };
    }

    const real = chosenTick(input);
    if (real) {
        const close = num(real.close);
        const chg = num(real.price_chg);
        const derived = Number.isFinite(chg) && close - chg > 0 ? close - chg : null;
        return {
            source: 'tick',
            open: positive(real.open),
            high: positive(real.high),
            low: positive(real.low),
            reference: contractRef ?? derived,
            avg: positive(real.avg_price),
            totalVolume: nonNegative(real.total_volume),
            lastVolume: nonNegative(real.volume),
            totalAmount: nonNegative(real.total_amount),
        };
    }

    if (validSnapshot(snapshot)) {
        const derived = Number.isFinite(snapshot.change_price) && snapshot.close - snapshot.change_price > 0 ? snapshot.close - snapshot.change_price : null;
        return {
            source: 'snapshot',
            open: positive(snapshot.open),
            high: positive(snapshot.high),
            low: positive(snapshot.low),
            reference: contractRef ?? derived,
            avg: positive(snapshot.average_price),
            totalVolume: nonNegative(snapshot.total_volume),
            lastVolume: nonNegative(snapshot.volume),
            totalAmount: nonNegative(snapshot.total_amount),
        };
    }

    return { ...empty, source: 'none', reference: contractRef };
}

/** 價格相對參考價的方向（著色用；沒有參考價時為 flat） */
export function toneVsReference(price: number | null | undefined, reference: number | null | undefined): 'up' | 'down' | 'flat' {
    if (price === null || price === undefined || !Number.isFinite(price) || !reference || reference <= 0) return 'flat';
    return price > reference ? 'up' : price < reference ? 'down' : 'flat';
}

/** 成交價是否鎖在漲停／跌停（漲跌停 ≤ 0 視為沒有） */
export function limitHit(price: number | null, limitUp: number | undefined, limitDown: number | undefined): 'up' | 'down' | null {
    if (price === null || !Number.isFinite(price) || price <= 0) return null;
    if (limitUp && limitUp > 0 && Math.abs(price - limitUp) < 1e-6) return 'up';
    if (limitDown && limitDown > 0 && Math.abs(price - limitDown) < 1e-6) return 'down';
    return null;
}

// ---- 比例條（五檔買賣總量、內外盤） ----

export interface SplitPercent {
    left: number;
    right: number;
    /** 整數百分比，左右相加為 100 */
    leftPct: number;
    rightPct: number;
}

/** 兩個量的比例（四捨五入到整數、相加為 100）；缺值、非有限、負值或總和為 0 時回傳 null */
export function splitPercent(left: number | null | undefined, right: number | null | undefined): SplitPercent | null {
    if (left === null || left === undefined || right === null || right === undefined) return null;
    if (!Number.isFinite(left) || !Number.isFinite(right) || left < 0 || right < 0) return null;
    const total = left + right;
    if (total <= 0) return null;
    const leftPct = Math.round((left / total) * 100);
    return { left, right, leftPct, rightPct: 100 - leftPct };
}

/** 內外盤比（左＝內盤 bid_side_total_vol、右＝外盤 ask_side_total_vol）；欄位缺漏、試撮或全為 0 時回傳 null（隱藏） */
export function innerOuterRatio(tick: HeaderTick | undefined): SplitPercent | null {
    if (!tick || tick.simtrade === true) return null;
    return splitPercent(tick.bid_side_total_vol, tick.ask_side_total_vol);
}

/** 量的單位：股票整股以張、零股以股、期權以口；指數等無單位 */
export function volumeUnit(securityType: string | null | undefined, oddLot = false): '張' | '股' | '口' | '' {
    if (securityType === 'STK') return oddLot ? '股' : '張';
    // 權證走股票路徑、沒有零股：一律以張
    if (securityType === 'WRT') return '張';
    if (securityType === 'FUT' || securityType === 'OPT') return '口';
    return '';
}
