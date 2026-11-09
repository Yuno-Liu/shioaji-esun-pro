// src/mobile/lib/trading-activity.ts — 交易活動閘門（送單路徑與玉山環境切換共用；延遲載入的 chunk 之間共用同一份狀態）
//
// 玉山模擬／正式切換（lib/esun-env-switch.ts）與所有送單路徑之間的互斥：
// - 環境切換中（含逾時後的「結果確認中」）：狀態在首屏的 mobile-store（envSwitch）；殼層的 EnvSwitchOverlay 顯示（換頁也不會消失）。
//   只擋玉山：玉山帳戶的新單、平倉、改單、刪單在送出前 assertNoEnvSwitch(account) 丟出「未送出」；永豐帳戶照常
//   （帳戶不明時視同玉山，一律擋）。
// - 委託送出中（新單、平倉）：送單流程以 beginOrderDispatch() 計數；環境切換據此擋下（lib 的確認在送出前就結束，
//   新單送出也不經 onTradeMutation）。送單流程都在延遲載入的 chunk 內，計數從第一次送單起才需要。
// - 刪改單送出中：首屏的 trade-mutation-tracker.ts 開機就訂閱 lib 的 onTradeMutation。

import { useSyncExternalStore } from 'react';
import { isEsunAccount } from '../../lib/esun/order-mapping';
import type { Account } from '../../lib/types/portfolio';
import { getMobileUi, setEnvSwitch, subscribeMobileUi, type EnvSwitchState } from './mobile-store';
import { MUTATION_STALE_MS, resetTradeMutationsForTest, subscribeTradeMutations, tradeMutationInFlight } from './trade-mutation-tracker';
import { notStarted } from './errors';

export { MUTATION_STALE_MS, setEnvSwitch, tradeMutationInFlight, type EnvSwitchState };

/** 送出前遇到環境切換：確定沒有送出 */
export const ENV_SWITCH_NOT_SENT = '玉山環境切換中，這筆玉山委託沒有送出（永豐不受影響）';

export interface TradingActivity {
    envSwitch: EnvSwitchState | null;
    /** 送出中的新單／平倉筆數 */
    dispatches: number;
}

let dispatches = 0;
let snapshot: TradingActivity = { envSwitch: null, dispatches: 0 };
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(l => l());

export function getTradingActivity(): TradingActivity {
    const envSwitch = getEnvSwitch();
    if (snapshot.envSwitch !== envSwitch || snapshot.dispatches !== dispatches) snapshot = { envSwitch, dispatches };
    return snapshot;
}

/** 切換狀態、送單計數、刪改單任一改變時通知 */
export function subscribeTradingActivity(listener: () => void): () => void {
    listeners.add(listener);
    const stops = [subscribeMobileUi(listener), subscribeTradeMutations(listener)];
    return () => {
        listeners.delete(listener);
        stops.forEach(stop => stop());
    };
}

export function useTradingActivity(): TradingActivity {
    return useSyncExternalStore(subscribeTradingActivity, getTradingActivity, getTradingActivity);
}

export function getEnvSwitch(): EnvSwitchState | null {
    return getMobileUi().envSwitch ?? null;
}

/** 這個帳戶目前被環境切換擋下：切換中且是玉山帳戶（帳戶不明時視同玉山） */
export function envSwitchBlocks(account: Pick<Account, 'broker_id'> | null | undefined): boolean {
    return getEnvSwitch() !== null && (!account || isEsunAccount(account));
}

/** 送單路徑在呼叫 lib 前與 beforeDispatch／beforeSend 內呼叫：環境切換中不送玉山（永豐照常） */
export function assertNoEnvSwitch(account: Pick<Account, 'broker_id'> | null | undefined): void {
    if (envSwitchBlocks(account)) throw notStarted(ENV_SWITCH_NOT_SENT);
}

/** 新單／平倉送出流程開始（含確認面板）；回傳的 release 只會生效一次 */
export function beginOrderDispatch(): () => void {
    dispatches += 1;
    changed();
    let done = false;
    return () => {
        if (done) return;
        done = true;
        dispatches -= 1;
        changed();
    };
}

export function orderDispatchInFlight(): boolean {
    return dispatches > 0;
}

/** 測試用 */
export function resetTradingActivityForTest(): void {
    dispatches = 0;
    resetTradeMutationsForTest();
    setEnvSwitch(null);
    changed();
}
