// src/mobile/components/sector/sector-retry.ts — 產業頁的建底錯誤冷卻與手動重試（不修改 src/lib）
//
// lib/index-components 的建底紀律（ADR 0001）：每次 retainIndexComponents 都會 ensureBootstrap，
// 狀態為 error 時就重新建底。產業頁每次進入都經 useIcSectorFlow 重新 retain，若不處理，
// 非 429 錯誤後每次切回「產業」分頁都會自動重查。本檔在手機層補上：
//
// 1. 冷卻：記錄每個指數最後一次「進入 error」的時間（訂閱 index_components store 觀察 pending → error 的轉換；
//    模組層、session 期間），任一指數仍在 error 且距錯誤未滿 SECTOR_BOOTSTRAP_ERROR_COOLDOWN_MS（60 秒）時，
//    頁面延後 retain（不訂閱、不建底），顯示錯誤與［重試］；冷卻結束（或按［重試］）才開始 retain。
// 2. 手動重試（頁面已 retain 時）：以「租約」再 retain 一次並持有到頁面卸載（不 retain 後立刻 release）。
//    - 指數有訂閱失敗的投影：只 retain 失敗的那幾條 → 每條實際重送 1 次 subscribe（失敗時 lib 重設錯誤訊息），
//      卸載時與頁面本身的 release 一起退訂，capability 層 ref-count 保證只送 1 次 unsubscribe。
//    - 只有建底失敗：retain 一條訂閱正常的投影（capability 層只加 ref-count、不送 subscribe），
//      觸發 lib 重新建底；卸載時只減 ref-count、不多送 unsubscribe。
//    - 不碰其他投影：仍存在的訂閱錯誤提示不會被清掉。

import {
    getIcBootstrapStatus,
    getIcSubError,
    projectionKey,
    retainIndexComponents,
    subscribeIcStore,
    type IcBootstrapStatus,
} from '../../../lib/index-components';
import { GM_AMOUNT, GM_WPERF, IC_INDICES, type IcIndexCode } from '../../../lib/sector-flow-ic';

/** 非 429 建底錯誤後，再次進入本頁不自動重新建底的期間（ms） */
export const SECTOR_BOOTSTRAP_ERROR_COOLDOWN_MS = 60_000;

const INDEX_CODES = Object.keys(IC_INDICES) as IcIndexCode[];
const PROJECTIONS = [GM_AMOUNT, GM_WPERF];

const lastErrorAt = new Map<IcIndexCode, number>();
let watching = false;

/** 開始觀察建底狀態（第一次掛載產業頁時呼叫；之後 session 期間持續，頁面離開時的錯誤也記得到） */
export function watchSectorBootstrapErrors(): void {
    if (watching) return;
    watching = true;
    const last = new Map<IcIndexCode, IcBootstrapStatus>(INDEX_CODES.map(code => [code, getIcBootstrapStatus(code).status]));
    subscribeIcStore(() => {
        for (const code of INDEX_CODES) {
            const status = getIcBootstrapStatus(code).status;
            if (status === 'error' && last.get(code) !== 'error') lastErrorAt.set(code, Date.now());
            last.set(code, status);
        }
    });
}

/** 冷卻結束的時間（所有仍在 error 的指數中最晚的）；沒有冷卻中的指數時 null */
export function sectorCooldownEnd(now = Date.now()): number | null {
    let end: number | null = null;
    for (const code of INDEX_CODES) {
        const at = lastErrorAt.get(code);
        if (at === undefined || getIcBootstrapStatus(code).status !== 'error') continue;
        const until = at + SECTOR_BOOTSTRAP_ERROR_COOLDOWN_MS;
        if (until > now) end = end === null ? until : Math.max(end, until);
    }
    return end;
}

/**
 * 頁面已 retain 時的手動重試：依上方規則 retain 需要的投影，回傳租約（呼叫端持有到卸載再 release）。
 * 建底正常且沒有訂閱錯誤時不做任何事（回傳空陣列）。
 */
export function retainSectorRetry(code: IcIndexCode): (() => void)[] {
    const failed = PROJECTIONS.filter(p => getIcSubError(code, projectionKey(p)) !== undefined);
    const healthy = PROJECTIONS.filter(p => !failed.includes(p));
    const targets = failed.length > 0
        ? failed
        : getIcBootstrapStatus(code).status === 'error' && healthy[0] ? [healthy[0]] : [];
    return targets.map(p => retainIndexComponents(IC_INDICES[code], p));
}

/** 測試用 */
export function resetSectorRetryForTest(): void {
    lastErrorAt.clear();
    watching = false;
}
