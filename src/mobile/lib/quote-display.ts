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
}

export interface HeaderIndex {
    date?: string;
    time?: string;
    close: string;
    reference: string;
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

export function headerQuote(input: {
    /** 合約參考價 */
    reference: number | undefined;
    tick?: HeaderTick;
    index?: HeaderIndex;
    /** 本頁看過的上一筆非試撮成交（目前 tick 為試撮時使用） */
    lastRealTick?: HeaderTick;
    snapshot?: Snapshot;
}): HeaderQuote {
    const { reference, tick, index, lastRealTick, snapshot } = input;
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

    const real = tick && tick.simtrade !== true ? tick : lastRealTick && lastRealTick.simtrade !== true ? lastRealTick : undefined;
    if (real && (!snapshot || !(snapshot.close > 0) || notOlderThan(real, snapshot))) {
        const q = fromTick(real, reference);
        if (q) return { ...q, sim };
    }

    if (snapshot && Number.isFinite(snapshot.close) && snapshot.close > 0) {
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
