// src/mobile/lib/chart-history-cache.ts — 手機圖表歷史的有上限快取（規格 §9.3、§9.4）
//
// src/lib/chart-history.ts 的 fetchChartHistory() 以 (apiBase, contract, 起訖, revision) 為 key 永久保存每份回應，
// 要累積到 100 份才淘汰最舊的，且沒有清除 API。手機每次回前景、離開交易頁逾 60 秒再回來、補抓缺口都會換新
// revision 背景重抓（chart-history-freshness.ts），舊 revision 之後再也用不到，記憶體會隨使用時間階梯式成長
// （日 K 股票一份約 1–2 MB）。手機因此不經過那份快取，改在這裡直接呼叫 fetchKbars()：
//   - 依 (apiBase, 商品, 起訖) 分組；每組只保留「最新一份成功的回應」＋進行中的查詢。
//   - revision 單調遞增（nextChartHistoryRevision）。要求的 revision ≤ 已成功的 revision 時直接給較新的那份
//     （沿用快取的語意本來就是「至少這麼新」）；更大的 revision 才發出查詢。
//   - 查詢成功後丟掉同組較舊的那份；失敗只丟掉這次的查詢（保留上一份成功的，背景重抓失敗時畫面仍可沿用）。
//   - 最多保留 MAX_HISTORY_GROUPS 組（最近使用者優先）。
// 記憶體上限：MAX_HISTORY_GROUPS ×（1 份成功回應＋最多 1 份進行中），日 K 股票最壞約 8 × 2 × 2 MB ≈ 32 MB，
// 實際通常只有目前與最近幾個 (商品, 週期) 各一份；不再隨 revision 次數成長。

import { getApiBase } from '../../lib/runtime';
import { fetchKbars } from '../../lib/shioaji';
import type { ContractBase } from '../../lib/types/contract';
import type { KBars } from '../../lib/types/market';

/** 最多保留幾組 (商品, 起訖) 的歷史 */
export const MAX_HISTORY_GROUPS = 8;

interface Slot {
    revision: number;
    promise: Promise<KBars>;
}

interface Group {
    /** 最新一份成功的回應 */
    settled: Slot | null;
    /** 進行中的查詢（revision → slot） */
    pending: Map<number, Slot>;
}

const groups = new Map<string, Group>();

function groupKey(contract: ContractBase, start: string, end: string): string {
    let base = '';
    try {
        base = getApiBase();
    } catch {
        // 取不到 API 位址時 fetchKbars 本身也會失敗；分組不受影響
    }
    return JSON.stringify([base, contract.security_type, contract.exchange, contract.code, start, end]);
}

function touch(key: string, g: Group) {
    groups.delete(key);
    groups.set(key, g);
    while (groups.size > MAX_HISTORY_GROUPS) groups.delete(groups.keys().next().value!);
}

/**
 * 與 fetchChartHistory() 相同的呼叫方式；同一組只保留最新一份成功的回應。
 * revision 相同或較舊、且已有成功回應時不再發出查詢。
 */
export function fetchMobileChartHistory(contract: ContractBase, start: string, end: string, opts: { timeoutMs?: number; revision: number }): Promise<KBars> {
    const key = groupKey(contract, start, end);
    const g = groups.get(key) ?? { settled: null, pending: new Map<number, Slot>() };
    touch(key, g);
    const { revision } = opts;
    if (g.settled && g.settled.revision >= revision) return g.settled.promise;
    const inflight = g.pending.get(revision);
    if (inflight) return inflight.promise;

    const promise = fetchKbars(contract, start, end, { timeoutMs: opts.timeoutMs });
    const slot: Slot = { revision, promise };
    g.pending.set(revision, slot);
    promise.then(
        () => {
            g.pending.delete(revision);
            if (!g.settled || g.settled.revision < revision) g.settled = slot;
            // 較舊的進行中查詢之後也用不到（成功也不會蓋掉較新的這份）
            for (const r of [...g.pending.keys()]) if (r < revision) g.pending.delete(r);
        },
        () => {
            g.pending.delete(revision);
        },
    );
    return promise;
}

/** 測試用：目前保留的回應份數（成功＋進行中） */
export function cachedHistoryCountForTest(): number {
    let n = 0;
    for (const g of groups.values()) n += (g.settled ? 1 : 0) + g.pending.size;
    return n;
}

/** 測試用 */
export function resetMobileChartHistoryForTest(): void {
    groups.clear();
}
