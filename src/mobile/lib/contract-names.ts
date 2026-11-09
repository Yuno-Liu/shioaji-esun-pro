// src/mobile/lib/contract-names.ts — 委託、成交、已實現損益、盤中異動、產業成分股列的商品名稱（名稱為主、代碼為次）
//
// 名稱來源依序：
//   1. 資料本身帶的名稱（trade.contract.name、損益列或玉山成交明細的 name）；
//   2. src/lib/contracts-cache 的全域合約快取（useContract；持倉、交易頁解析過的合約就在裡面）；
//   3. 都沒有時以 ensureContract(code) 查一次合約（結果進同一份快取）。
// 每個不重複代碼在本 session 最多查一次：成功後由快取供應，失敗（或查到的名稱就是代碼，例如權證）不重試，
// 只顯示代碼。名稱載入前只顯示代碼，呼叫端以單行（不換行、省略號）排版，名稱到達時版面不跳動。
// 查詢排隊：同時最多 NAME_LOOKUP_CONCURRENCY（2）個 ensureContract，其餘排隊；呼叫端不再需要（列不可見、卸載）時，
// 尚未開始的查詢移出佇列，且不算用掉這個代碼的一次（之後再可見時才查）；已開始的無法中止，結果照樣進快取。
// 清單型呼叫端（盤中異動、產業成分股）以 visible 只為可見列查詢（useContractName 第 4 個參數）。
// 只讀取合約資料（永豐 shioaji 合約 API），不讀外部網站、不訂閱行情、不送任何委託。

import { useEffect } from 'react';
import { ensureContract, useContract } from '../../lib/contracts-cache';
import { canonicalBrokerCode, realizedCodeCandidates } from '../../lib/realized-name';
import type { SecurityType } from '../../lib/types/contract';

/** 同時進行的名稱查詢上限 */
export const NAME_LOOKUP_CONCURRENCY = 2;

/** 已開始（或已結束）合約查詢的代碼：本 session 不再查 */
const requested = new Set<string>();

interface Job {
    code: string;
    type?: SecurityType;
    /** 目前仍需要這個查詢的呼叫端數 */
    waiters: number;
}

/** 排隊中（尚未開始）的查詢 */
const queued = new Map<string, Job>();
const queue: Job[] = [];
let running = 0;
/** resetContractNamesForTest 之後，舊查詢結算時不再動計數 */
let generation = 0;

function pump(): void {
    while (running < NAME_LOOKUP_CONCURRENCY && queue.length > 0) {
        const job = queue.shift()!;
        queued.delete(job.code);
        requested.add(job.code);
        running++;
        const gen = generation;
        // ensureContract 會先看快取並合併同時進行中的查詢；失敗不重試
        void ensureContract(job.code, job.type ?? undefined)
            .catch(() => undefined)
            .finally(() => {
                if (gen !== generation) return;
                running--;
                pump();
            });
    }
}

function noop(): void { /* 不需要取消 */ }

/**
 * 需要時查一次合約（同一代碼本 session 最多一次；失敗不重試）；回傳取消函式：
 * 尚未開始時移出佇列（不算用掉這一次），已開始則無作用。
 */
export function requestContractName(code: string, type?: SecurityType): () => void {
    const key = code.trim();
    if (!key || requested.has(key)) return noop;
    let job = queued.get(key);
    if (job) {
        job.waiters++;
    } else {
        job = { code: key, type, waiters: 1 };
        queued.set(key, job);
        queue.push(job);
        pump();
    }
    const own = job;
    let done = false;
    return () => {
        if (done) return;
        done = true;
        own.waiters--;
        if (own.waiters > 0 || queued.get(own.code) !== own) return;
        queued.delete(own.code);
        const i = queue.indexOf(own);
        if (i >= 0) queue.splice(i, 1);
    };
}

function cleanName(name: unknown, code: string): string | null {
    const text = typeof name === 'string' ? name.trim() : '';
    // 權證等合約的 name 會回填成代碼：視為沒有名稱
    return text && text !== code ? text : null;
}

/**
 * 商品名稱；沒有名稱（載入前、查詢失敗）回 null，呼叫端只顯示代碼。
 * known＝資料本身帶的名稱，有值時不讀快取也不查詢。
 * visible＝false 時不查詢（清單只為可見列查）；變成不可見或卸載時取消尚未開始的查詢。
 */
export function useContractName(code: string | null | undefined, known?: string | null, type?: SecurityType, visible = true): string | null {
    const key = (code ?? '').trim();
    const own = cleanName(known, key);
    // 一律訂閱該代碼的快取（即使 known 有值）：known 若來自非響應式來源（例如盤中異動的 getCachedContract），
    // 合約到達時本列的 hook 值也會改變，React 才會提交新名稱（否則重繪會被視為無變化而略過）
    const cached = useContract(key || null);
    const fromCache = own ? null : cleanName(cached?.name, key);
    const need = !own && !fromCache && !!key && visible;
    useEffect(() => (need ? requestContractName(key, type) : undefined), [need, key, type]);
    return own ?? fromCache;
}

/** 「名稱 代碼」（沒有名稱只回代碼）：aria-label、面板標題、清單文字用 */
export function instrumentText(code: string, name: string | null): string {
    return name ? `${name} ${code}` : code;
}

/**
 * 已實現損益列的查詢代碼：券商帳務的代碼不保證與合約代碼一字不差（src/lib/realized-name.ts）。
 * 正規化後，期貨「商品＋YYYYMM」長格式改用合約代碼（TMF202610 → TMFJ6），只查這一個候選。
 */
export function realizedLookupCode(code: string, market: 'S' | 'F'): string {
    const candidates = realizedCodeCandidates(String(code ?? ''), market);
    return candidates[candidates.length - 1] ?? canonicalBrokerCode(String(code ?? ''));
}

/** 測試用：目前進行中與排隊中的查詢數 */
export function contractNameQueueStats(): { running: number; queued: number } {
    return { running, queued: queue.length };
}

/** 測試用：清除已查詢紀錄與佇列 */
export function resetContractNamesForTest(): void {
    requested.clear();
    queued.clear();
    queue.length = 0;
    running = 0;
    generation++;
}
