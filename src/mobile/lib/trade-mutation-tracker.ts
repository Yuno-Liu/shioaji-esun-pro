// src/mobile/lib/trade-mutation-tracker.ts — 刪改單送出中追蹤（首屏；殼層 app.tsx 匯入，開機即訂閱）
//
// 訂閱 lib 的 onTradeMutation（begin／settled，含同源其他分頁），玉山環境切換據此擋下（lib/trading-activity.ts）。
// 開機就訂閱，不等帳戶頁 chunk：省流量或 2g／3g 不預載帳戶頁時，之前送出的刪改單也看得到。
// 只匯入 lib/trade-mutations（已在首屏）：不讓首屏多切共用 chunk。

import { onTradeMutation } from '../../lib/trade-mutations';

/** 視窗在 settled 前關閉時不會有 settled：超過這個時間的 begin 視為已結束（刪改單請求本身的逾時遠短於此） */
export const MUTATION_STALE_MS = 120_000;

const mutations = new Map<string, number>();
const listeners = new Set<() => void>();

try {
    onTradeMutation(event => {
        if (event.phase === 'begin') mutations.set(event.token, Date.now());
        else mutations.delete(event.token);
        listeners.forEach(l => l());
    });
} catch {
    // 只有單元測試的不完整 mock 會沒有 onTradeMutation；正式環境一定有
}

export function tradeMutationInFlight(now: number = Date.now()): boolean {
    for (const [token, at] of mutations) {
        if (now - at >= MUTATION_STALE_MS) mutations.delete(token);
    }
    return mutations.size > 0;
}

export function subscribeTradeMutations(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** 測試用 */
export function resetTradeMutationsForTest(): void {
    mutations.clear();
}
