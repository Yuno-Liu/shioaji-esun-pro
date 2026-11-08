// src/mobile/lib/account-on-demand.ts — 帳戶頁「按需讀取」的模組層快取（已實現損益、玉山帳務概覽、永豐預收／圈存）
//
// - 只有使用者開啟區塊或按「查詢」時才讀取（呼叫 loadOnDemand）；不自動輪詢、不在背景重試。
// - 同一個 key 同時只發一次請求；距離上次「發出」請求未滿 cooldownMs 時直接略過（券商與 bridge 有查詢頻率限制）。
// - 失敗時保留上一份資料並寫入 error；不自動重送（這些都是唯讀查詢，重查也只由使用者觸發）。
// - key 由呼叫端組成，須包含帳戶（及玉山環境、查詢區間），避免不同帳戶或環境的資料互相覆蓋。
// - gate（選用）：跨 key 共用的滑動視窗（例如玉山已實現損益的不同區間）：windowMs 內已通過 max 次時同樣略過。

import { useSyncExternalStore } from 'react';

export interface OnDemandState<T> {
    data: T | null;
    error: string | null;
    loading: boolean;
    /** 最後一次成功取得的時間（ms） */
    updatedAt: number | null;
    /** 最後一次發出請求的時間（ms；冷卻以此計算） */
    attemptedAt: number | null;
}

interface Entry {
    state: OnDemandState<unknown>;
    inFlight: Promise<void> | null;
}

const EMPTY: OnDemandState<never> = { data: null, error: null, loading: false, updatedAt: null, attemptedAt: null };

/** 跨 key 的滑動視窗：同名閘門在任意 windowMs 內最多通過 max 次 */
export interface OnDemandGate {
    name: string;
    max: number;
    windowMs: number;
}

const entries = new Map<string, Entry>();
/** 閘門名稱 → 視窗內各次通過（發出請求）的時間（由舊到新） */
const gates = new Map<string, number[]>();
const listeners = new Set<() => void>();
let clock: () => number = () => Date.now();

function emit(): void {
    listeners.forEach(l => l());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function onDemandNow(): number {
    return clock();
}

export function getOnDemandState<T>(key: string | null | undefined): OnDemandState<T> {
    if (!key) return EMPTY;
    return (entries.get(key)?.state ?? EMPTY) as OnDemandState<T>;
}

/** 可以再查詢：沒有進行中的請求，且距離上次發出請求已滿冷卻時間 */
export function canLoadOnDemand(state: Pick<OnDemandState<unknown>, 'loading' | 'attemptedAt'>, cooldownMs: number, now: number = clock()): boolean {
    if (state.loading) return false;
    return state.attemptedAt === null || now - state.attemptedAt >= cooldownMs;
}

/** 冷卻剩餘秒數（無冷卻回 0） */
export function cooldownLeftSec(state: Pick<OnDemandState<unknown>, 'attemptedAt'>, cooldownMs: number, now: number = clock()): number {
    if (state.attemptedAt === null) return 0;
    return Math.max(0, Math.ceil((cooldownMs - (now - state.attemptedAt)) / 1000));
}

/**
 * 視窗內仍有效的通過時間（順便剪掉已滑出視窗的舊紀錄）。
 * 晚於 now 的紀錄（裝置時間往回調）也丟掉：否則會鎖住整段回調的時間；超量時仍由 bridge 端的限制擋下。
 */
function gateHits(gate: OnDemandGate, now: number): number[] {
    const hits = (gates.get(gate.name) ?? []).filter(t => t <= now && now - t < gate.windowMs);
    gates.set(gate.name, hits);
    return hits;
}

/** 閘門剩餘秒數（0＝可通過）：已滿 max 次時，等最舊一次滑出視窗 */
export function gateLeftSec(gate: OnDemandGate, now: number = clock()): number {
    const hits = gateHits(gate, now);
    if (hits.length < gate.max) return 0;
    return Math.max(0, Math.ceil((hits[hits.length - gate.max]! + gate.windowMs - now) / 1000));
}

/**
 * 讀取（受冷卻與選用的 gate 限制）。回傳的 promise 不會 reject；被冷卻、閘門或進行中略過時回傳 false。
 * 進行中的請求會沿用（回傳 true，等待同一請求）。
 */
export function loadOnDemand<T>(key: string, fetcher: () => Promise<T>, cooldownMs: number, gate?: OnDemandGate): Promise<boolean> {
    let entry = entries.get(key);
    if (!entry) {
        entry = { state: EMPTY, inFlight: null };
        entries.set(key, entry);
    }
    if (entry.inFlight) return entry.inFlight.then(() => true);
    if (!canLoadOnDemand(entry.state, cooldownMs)) return Promise.resolve(false);
    if (gate && gateLeftSec(gate) > 0) return Promise.resolve(false);
    const target = entry;
    const at = clock();
    if (gate) gates.set(gate.name, [...gateHits(gate, at), at]);
    target.state = { ...target.state, loading: true, error: null, attemptedAt: at };
    emit();
    let request: Promise<T>;
    try {
        request = fetcher();
    } catch (err) {
        request = Promise.reject(err);
    }
    const done = request
        .then(data => {
            target.state = { ...target.state, data, error: null, loading: false, updatedAt: clock() };
        })
        .catch((err: unknown) => {
            target.state = { ...target.state, loading: false, error: err instanceof Error && err.message ? err.message : String(err || '查詢失敗') };
        })
        .finally(() => {
            target.inFlight = null;
            emit();
        });
    target.inFlight = done;
    return done.then(() => true);
}

/** 訂閱某個 key 的狀態；key 為 null 時回空狀態 */
export function useOnDemand<T>(key: string | null): OnDemandState<T> {
    return useSyncExternalStore(subscribe, () => getOnDemandState<T>(key), () => EMPTY as OnDemandState<T>);
}

/** 測試用：清空快取並可注入時鐘 */
export function resetOnDemandForTest(nextClock?: () => number): void {
    entries.clear();
    gates.clear();
    clock = nextClock ?? (() => Date.now());
    emit();
}
