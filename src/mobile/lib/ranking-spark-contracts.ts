// src/mobile/lib/ranking-spark-contracts.ts — 排行迷你走勢的合約解析佇列（只被延遲載入的 ranking-list 使用）
//
// 排行資料（scanner）沒有交易所欄位，K 線請求需要合約。可見、可畫走勢、走勢開關開啟的排行列，若合約不在快取，
// 經 src/lib/contracts-cache 的 ensureContract(code) 解析一次（沿用其快取與同代碼去重；結果寫進同一份合約快取，
// 列以 useContract 收到後顯示市場標記與走勢）。
//
// 請求上限：
// - 同時最多 SPARK_CONTRACT_CONCURRENCY（2）個解析；其餘排隊。
// - 列不可見、走勢開關關閉、列卸載（離開排行）時，尚未開始的解析移出佇列；已送出的無法中止，結果照樣進快取。
// - 已在快取：0 個。同代碼同時只排一次。
// - 失敗（查無合約、網路錯誤）：SPARK_CONTRACT_RETRY_MS 內不再為走勢解析同一代碼（列維持空白佔位）。
// 因此每次進入排行，最多多出「捲動到可見範圍、且尚未在合約快取的不同代碼數」個合約 GET（每種排行 ≤ RANKING_COUNT＝30）；
// 同一個 session 再進入時，已解析的代碼為 0。

import { ensureContract, getCachedContract } from '../../lib/contracts-cache';

/** 同時進行的合約解析上限 */
export const SPARK_CONTRACT_CONCURRENCY = 2;
/** 解析失敗後，再次為走勢解析同一代碼前的最短間隔（ms） */
export const SPARK_CONTRACT_RETRY_MS = 5 * 60_000;

interface Job {
    code: string;
    /** 目前仍需要這個解析的列數 */
    waiters: number;
    started: boolean;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
const failedAt = new Map<string, number>();
let running = 0;
/** resetSparkContractsForTest 之後，舊的請求結算時不再動計數 */
let generation = 0;

function pump() {
    while (running < SPARK_CONTRACT_CONCURRENCY && queue.length > 0) {
        const job = queue.shift()!;
        if (getCachedContract(job.code)) {
            jobs.delete(job.code);
            continue;
        }
        job.started = true;
        running++;
        const gen = generation;
        ensureContract(job.code)
            .then(
                () => { if (gen === generation) failedAt.delete(job.code); },
                () => { if (gen === generation) failedAt.set(job.code, Date.now()); },
            )
            .finally(() => {
                if (gen !== generation) return;
                running--;
                jobs.delete(job.code);
                pump();
            });
    }
}

/**
 * 要求為走勢解析 code 的合約；回傳取消函式（列不可見、開關關閉、卸載時呼叫）。
 * 已在快取、近期失敗過時不排隊（回傳 no-op）。
 */
export function requestSparkContract(code: string): () => void {
    if (getCachedContract(code)) return noop;
    const failed = failedAt.get(code);
    if (failed !== undefined && Date.now() - failed < SPARK_CONTRACT_RETRY_MS) return noop;
    let job = jobs.get(code);
    if (job) {
        job.waiters++;
    } else {
        job = { code, waiters: 1, started: false };
        jobs.set(code, job);
        queue.push(job);
        pump();
    }
    const own = job;
    let done = false;
    return () => {
        if (done) return;
        done = true;
        own.waiters--;
        if (own.waiters > 0 || own.started) return;
        const i = queue.indexOf(own);
        if (i >= 0) queue.splice(i, 1);
        if (jobs.get(own.code) === own) jobs.delete(own.code);
    };
}

function noop() { /* 不需要取消 */ }

/** 測試用：目前進行中與排隊中的解析數 */
export function sparkContractQueueStats(): { running: number; queued: number } {
    return { running, queued: queue.length };
}

/** 測試用：清空佇列、計數與失敗記錄 */
export function resetSparkContractsForTest(): void {
    jobs.clear();
    queue.length = 0;
    failedAt.clear();
    running = 0;
    generation++;
}
