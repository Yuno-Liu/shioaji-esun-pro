// src/mobile/components/company/relation-quotes.ts — 上下游列的即時漲跌幅（同桌面 company-panel.tsx RelationsTab）
//
// - 來源與桌面相同：hooks/use-live-snapshots（一次快照批次＋即時成交更新）。
// - 只在「上下游」子分頁顯示、且公司分頁 active 時讀取與訂閱（live=false 時傳空清單：不讀、不訂閱）。
// - 對象：目前看得到的列（每組預覽 6 筆，展開後為全部）中，實體索引標為上市（twse）／上櫃（tpex）的台股，
//   依出現順序去重，一次批次最多 RELATION_LIVE_LIMIT（20）檔。桌面是 40 檔；手機調低，因為每檔訂閱 Tick＋BidAsk 兩筆，
//   40 檔會一次送出 80 筆，可能觸及永豐行情訂閱「50 次／5 秒」的限制（規格 §9.1）；20 檔即最多 40 筆。
// - 重新讀取：同桌面不定時重讀（use-query 以代碼組合快取整個 session）；另外以代碼為單位記錄上次讀取時間，
//   展開／收合造成代碼組合改變時，RELATION_SNAPSHOT_MIN_MS（30 秒）內讀過的代碼沿用上次結果，只讀其餘的。

import { useMemo } from 'react';
import { useLiveSnapshots } from '../../../hooks/use-live-snapshots';
import type { Entity, RelationRow } from '../../../lib/company-data/types';
import { fetchSnapshots } from '../../../lib/shioaji';
import type { ContractBase } from '../../../lib/types/contract';
import type { Snapshot } from '../../../lib/types/market';
import { tradableCodeOf } from './company-format';

/** 一次批次最多幾檔（桌面 LIVE_LIMIT 為 40；手機減半，避免一次送出超過永豐行情訂閱上限） */
export const RELATION_LIVE_LIMIT = 20;
/** 同一代碼兩次快照讀取的最短間隔（ms） */
export const RELATION_SNAPSHOT_MIN_MS = 30_000;

const EXCHANGE: Readonly<Record<string, 'TSE' | 'OTC'>> = { twse: 'TSE', tpex: 'OTC' };

/** 看得到的列 → 要讀即時漲跌的合約（上市櫃、去重、最多 RELATION_LIVE_LIMIT 檔） */
export function relationContracts(rows: readonly RelationRow[], index: Map<string, Entity> | null): ContractBase[] {
    if (!index) return [];
    const seen = new Set<string>();
    const out: ContractBase[] = [];
    for (const row of rows) {
        if (out.length >= RELATION_LIVE_LIMIT) break;
        const code = tradableCodeOf(row.id);
        const market = index.get(row.id)?.market;
        const exchange = market ? EXCHANGE[market] : undefined;
        if (!code || !exchange || seen.has(code)) continue;
        seen.add(code);
        out.push({ code, exchange, security_type: 'STK', target_code: null });
    }
    return out;
}

const recent = new Map<string, { snapshot: Snapshot | undefined; at: number }>();

/** 快照批次：30 秒內讀過的代碼用上次結果，其餘一次讀（失敗時丟錯，不記錄時間） */
export async function fetchRelationSnapshots(contracts: readonly ContractBase[]): Promise<Snapshot[]> {
    const now = Date.now();
    const due = contracts.filter(c => {
        const r = recent.get(c.code);
        return !r || now - r.at >= RELATION_SNAPSHOT_MIN_MS;
    });
    if (due.length > 0) {
        const got = await fetchSnapshots(due);
        const at = Date.now();
        const list = Array.isArray(got) ? got : [];
        for (const c of due) recent.set(c.code, { snapshot: list.find(s => s.code === c.code), at });
    }
    return contracts.map(c => recent.get(c.code)?.snapshot).filter((s): s is Snapshot => s !== undefined);
}

/** 測試用 */
export function resetRelationSnapshotsForTest(): void {
    recent.clear();
}

/** 上下游列的即時快照（代碼 → 快照）；live=false 時不讀不訂閱 */
export function useRelationSnapshots(rows: readonly RelationRow[], index: Map<string, Entity> | null, live: boolean): Map<string, Snapshot> {
    const rowKey = rows.map(r => r.id).join(',');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const contracts = useMemo(() => (live ? relationContracts(rows, index) : []), [live, index, rowKey]);
    const { snapshots } = useLiveSnapshots(contracts, () => fetchRelationSnapshots(contracts));
    return snapshots;
}
