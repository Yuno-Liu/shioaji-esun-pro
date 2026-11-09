// src/mobile/lib/watch-sort.ts — 自選清單的檢視排序（使用者要求「自選清單增加排序功能 股票代號、股價、漲幅%數、漲幅價格」；設計規格 §7.2）
//
// - 只改變這台裝置上的顯示順序，絕不寫回伺服器清單的順序（不呼叫任何 use-watchlist 寫入）。
// - 選項：自訂順序（只有使用者自己的清單；伺服器順序，預設）、股票代號、股價、漲幅%（漲跌幅）、漲跌（漲跌價差）。
//   固定清單（股期近月／遠月）沒有自訂順序，預設股票代號。
//   再點目前的選項＝反向；預設方向：代號由小到大，股價、漲幅%、漲跌由大到小。
// - 股票代號：固定清單依標的股票代號，同一標的一般在小型前（反向時只反轉標的順序）；自己的清單依商品代碼。
// - 股價類排序：依「排序依據」那一次的批次快照（lib fetchSnapshots，每次最多 SNAPSHOT_BATCH 檔，超過時分批），
//   之後的即時行情只更新可見列的數字，不會一直重排；［⟳］重新取一次快照再排（最短間隔 SORT_MIN_INTERVAL_MS）。
//   沒有資料（沒有成交、快照沒有這檔）的列不論方向都排在最後；同值依基準順序（穩定）。
//   連續月代碼（如 TXFR1）的快照可能以實際月份代碼回傳：先找代碼、再找 target_code（同 hooks/use-live-snapshots）。
// - 偏好存在這台裝置：localStorage SORT_STORAGE_KEY，{ [清單 id]: { key, dir } }；讀寫失敗只在本次有效。

import { fetchSnapshots } from '../../lib/shioaji';
import { SNAPSHOT_BATCH } from '../../lib/option-window';
import type { ContractBase } from '../../lib/types/contract';
import type { Snapshot } from '../../lib/types/market';

export type SortKey = 'manual' | 'code' | 'price' | 'pct' | 'chg';
export type SortDir = 'asc' | 'desc';
export interface SortPref {
    key: SortKey;
    dir: SortDir;
}

/** localStorage 鍵（本裝置；清單 id → { key, dir }） */
export const SORT_STORAGE_KEY = 'sj-mobile-watch-sort-v1';
/** ［⟳］重新排序的最短間隔（ms）；清單開啟時這段時間內取過的排序依據直接沿用 */
export const SORT_MIN_INTERVAL_MS = 5_000;

export const SORT_LABEL: Readonly<Record<SortKey, string>> = {
    manual: '自訂順序',
    code: '股票代號',
    price: '股價',
    pct: '漲幅%',
    chg: '漲跌',
};

/** 選項順序（固定清單沒有「自訂順序」） */
export const sortKeys = (fixed: boolean): SortKey[] =>
    fixed ? ['code', 'price', 'pct', 'chg'] : ['manual', 'code', 'price', 'pct', 'chg'];

export const isPriceKey = (key: SortKey): boolean => key === 'price' || key === 'pct' || key === 'chg';

export const defaultDir = (key: SortKey): SortDir => (isPriceKey(key) ? 'desc' : 'asc');

export const defaultSortPref = (fixed: boolean): SortPref => ({ key: fixed ? 'code' : 'manual', dir: 'asc' });

/** 點選一個選項後的偏好：點目前的選項（自訂順序除外）＝反向；其他選項用預設方向 */
export function nextSortPref(current: SortPref, key: SortKey): SortPref {
    if (key === current.key && key !== 'manual') return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
    return { key, dir: defaultDir(key) };
}

/** 方向文字（無障礙名稱與選項說明） */
export function sortDirText(pref: SortPref): string {
    if (pref.key === 'manual') return '與桌面相同的清單順序';
    if (pref.key === 'code') return pref.dir === 'asc' ? '由小到大' : '由大到小';
    return pref.dir === 'asc' ? '由低到高' : '由高到低';
}

function readAll(): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? 'null');
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** 讀取清單的排序偏好；沒有、格式不對、讀取失敗時用預設（固定清單不接受「自訂順序」） */
export function readSortPref(listId: string, fixed: boolean): SortPref {
    const v = readAll()[listId] as Partial<SortPref> | undefined;
    const keys = sortKeys(fixed);
    if (v && keys.includes(v.key as SortKey) && (v.dir === 'asc' || v.dir === 'desc')) return { key: v.key as SortKey, dir: v.dir };
    return defaultSortPref(fixed);
}

/** 寫入清單的排序偏好（只寫這台裝置；失敗時只在本次有效） */
export function writeSortPref(listId: string, pref: SortPref): void {
    try {
        const all = readAll();
        all[listId] = { key: pref.key, dir: pref.dir };
        localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(all));
    } catch {
        // 儲存空間不可用：只在本次有效
    }
}

// ---------------------------------------------------------------------------
// 排序

export interface SortValues {
    price?: number;
    pct?: number;
    chg?: number;
}

export interface SortItem {
    contract: ContractBase;
    /** 固定清單：標的股票代號（股票代號排序用） */
    under?: string;
    /** 固定清單：乘數（同一標的一般 2000 在小型 100 前） */
    mult?: number;
}

const finite = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);

/** 快照 → 排序值；收盤價 ≤ 0（沒有成交）視為沒有資料。代碼找不到時以 target_code 對應（連續月） */
export function snapshotIndex(contracts: readonly ContractBase[], snapshots: readonly Snapshot[]): Map<string, Snapshot> {
    const byCode = new Map<string, Snapshot>();
    for (const s of Array.isArray(snapshots) ? snapshots : []) if (s && typeof s.code === 'string') byCode.set(s.code, s);
    const out = new Map<string, Snapshot>();
    for (const c of contracts) {
        const s = byCode.get(c.code) ?? (c.target_code ? byCode.get(c.target_code) : undefined);
        if (s) out.set(c.code, s);
    }
    return out;
}

export function sortValuesOf(s: Snapshot | undefined): SortValues {
    const price = finite(s?.close);
    if (price === undefined || price <= 0) return {};
    return { price, pct: finite(s!.change_rate), chg: finite(s!.change_price) };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 依偏好排出代碼順序；自訂順序回傳 null（照伺服器順序）。
 * 股價類：沒有資料的列不論方向都在最後；同值、都沒有資料時依 items 的順序（穩定）。
 */
export function sortCodes(items: readonly SortItem[], pref: SortPref, snapshots?: ReadonlyMap<string, Snapshot>): string[] | null {
    if (pref.key === 'manual') return null;
    const sign = pref.dir === 'asc' ? 1 : -1;
    const rows = items.map((item, index) => ({ item, index, v: isPriceKey(pref.key) ? sortValuesOf(snapshots?.get(item.contract.code))[pref.key as 'price' | 'pct' | 'chg'] : undefined }));
    rows.sort((a, b) => {
        if (pref.key === 'code') {
            const byUnder = cmp(a.item.under ?? a.item.contract.code, b.item.under ?? b.item.contract.code);
            if (byUnder) return sign * byUnder;
            const byMult = (b.item.mult ?? 0) - (a.item.mult ?? 0);
            if (byMult) return byMult;
            return sign * cmp(a.item.contract.code, b.item.contract.code) || a.index - b.index;
        }
        if (a.v === undefined || b.v === undefined) {
            if (a.v === b.v) return a.index - b.index;
            return a.v === undefined ? 1 : -1;
        }
        return sign * (a.v - b.v) || a.index - b.index;
    });
    return rows.map(r => r.item.contract.code);
}

// ---------------------------------------------------------------------------
// 排序依據（批次快照）

/** 一次批次快照（每批最多 SNAPSHOT_BATCH 檔；300 檔左右的清單只有 1 個請求） */
export async function fetchSortSnapshots(contracts: readonly ContractBase[]): Promise<Snapshot[]> {
    const out: Snapshot[] = [];
    for (let i = 0; i < contracts.length; i += SNAPSHOT_BATCH) {
        const rows = await fetchSnapshots(contracts.slice(i, i + SNAPSHOT_BATCH));
        if (Array.isArray(rows)) out.push(...rows);
    }
    return out;
}

export interface SortBasisEntry {
    /** 取得時間（ms） */
    at: number;
    snapshots: Map<string, Snapshot>;
}

/** 模組層：每個清單最近一次的排序依據（切換清單再回來、SORT_MIN_INTERVAL_MS 內不重取） */
const basisCache = new Map<string, SortBasisEntry>();

export const getSortBasis = (listId: string): SortBasisEntry | undefined => basisCache.get(listId);
export const setSortBasis = (listId: string, entry: SortBasisEntry): void => { basisCache.set(listId, entry); };

/** 測試用 */
export function resetSortBasisForTest(): void {
    basisCache.clear();
}
