// src/mobile/components/sector/sector-model.ts — 產業流向分頁的純資料邏輯（無 React、無請求）
//
// 資料來源全部是既有模組（不修改它們）：
// - 漲跌與成交值：index_components 群組指標（lib/index-components 的 store；建底快照或串流，calculated_at 新者勝）。
// - 資金流向：lib/sector-flow-ic 的 icFlowRecorder（每分鐘成交值增量 × 加權漲跌方向），只在本頁掛載期間記錄。
// 這裡只負責把兩者組成列、判斷流向是否可用、排序與摘要。
//
// 產業列排序（使用者要求「市場-產業流向新增排序功能」）：選項對應列上顯示的數字——資金流向（累計淨流入，預設、由流入到流出，
// 即原本的預設「資金流入」）、近 5 分（近 5 分淨流入）、漲跌幅（加權漲跌）、成交值；再點目前的選項＝反向。
// 沒有資料（null；流向不可用時一律視為沒有）的列不論方向都排在最後；同值依成交值大到小、再依產業代碼。
// 偏好存在這台裝置（localStorage SECTOR_SORT_STORAGE_KEY；讀寫失敗只在本次有效）。只排序頁面上已有的資料，不發請求。

import { SESSION_SLOTS, type GroupFlow } from '../../../lib/chain-flow';
import type { IcIndexCode, IcKey } from '../../../lib/sector-flow-ic';
import type { IcGroupRow } from '../../../lib/types/market';

export type SectorMarket = 'twse' | 'tpex';

export const SECTOR_MARKETS: readonly SectorMarket[] = ['twse', 'tpex'];

export const MARKET_LABEL: Record<SectorMarket, string> = { twse: '上市', tpex: '上櫃' };

export const MARKET_INDEX: Record<SectorMarket, IcIndexCode> = { twse: 'IX0001', tpex: 'IX0043' };

/** 內部排序（摘要前 3、漲幅名次用） */
export type SectorSort = 'inflow' | 'outflow' | 'gain' | 'loss' | 'amount';

/** 產業列的排序選項（使用者可選；再點目前的選項＝反向） */
export type SectorSortKey = 'flow' | 'flow5' | 'pct' | 'amount';
export type SectorSortDir = 'asc' | 'desc';
export interface SectorSortPref {
    key: SectorSortKey;
    dir: SectorSortDir;
}

export const SECTOR_SORT_OPTIONS: readonly { value: SectorSortKey; label: string }[] = [
    { value: 'flow', label: '資金流向' },
    { value: 'flow5', label: '近5分' },
    { value: 'pct', label: '漲跌幅' },
    { value: 'amount', label: '成交值' },
];

/** 預設：資金流向由流入到流出（與原本的預設「資金流入」相同的順序） */
export const DEFAULT_SECTOR_SORT: SectorSortPref = { key: 'flow', dir: 'desc' };

/** localStorage 鍵（本裝置） */
export const SECTOR_SORT_STORAGE_KEY = 'sj-mobile-sector-sort-v1';

/** 點選一個選項：點目前的選項＝反向；其他選項由大到小（流入、漲、成交值大的在前） */
export function nextSectorSort(current: SectorSortPref, key: SectorSortKey): SectorSortPref {
    if (key === current.key) return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
    return { key, dir: 'desc' };
}

/** 方向文字（無障礙名稱） */
export function sectorSortDirText(pref: SectorSortPref): string {
    if (pref.key === 'flow' || pref.key === 'flow5') return pref.dir === 'desc' ? '由淨流入到淨流出' : '由淨流出到淨流入';
    if (pref.key === 'pct') return pref.dir === 'desc' ? '由漲到跌' : '由跌到漲';
    return pref.dir === 'desc' ? '由大到小' : '由小到大';
}

export function readSectorSort(): SectorSortPref {
    try {
        const v = JSON.parse(localStorage.getItem(SECTOR_SORT_STORAGE_KEY) ?? 'null') as Partial<SectorSortPref> | null;
        if (v && SECTOR_SORT_OPTIONS.some(o => o.value === v.key) && (v.dir === 'asc' || v.dir === 'desc')) return { key: v.key as SectorSortKey, dir: v.dir };
    } catch {
        // 讀取失敗：用預設
    }
    return DEFAULT_SECTOR_SORT;
}

export function writeSectorSort(pref: SectorSortPref): void {
    try {
        localStorage.setItem(SECTOR_SORT_STORAGE_KEY, JSON.stringify({ key: pref.key, dir: pref.dir }));
    } catch {
        // 儲存空間不可用：只在本次有效
    }
}

/** 一個產業自開啟本頁起量到的資金流向 */
export interface SectorFlow {
    /** 近 5 分淨流入（含目前這一分鐘） */
    flow5: number;
    /** 近 5 分量到的成交值 */
    turnover5: number;
    /** 累計淨流入 */
    net: number;
    /** 累計量到的成交值（流入＋流出＋平盤） */
    turnover: number;
    /** 每分鐘累計淨流入（走勢用，從第一筆量到的分鐘到 now） */
    series: readonly number[];
}

export interface SectorRow {
    /** recorder 的群組 key：`${index}:${category}` */
    key: IcKey;
    category: string;
    name: string;
    /** 成分檔數 */
    count: number;
    /** 加權漲跌（%） */
    pct: number | null;
    /** 當日累計成交值（元） */
    amount: number | null;
    /** 占本市場各產業成交值合計的比例（0–1） */
    share: number | null;
    /** 量到的資金流向；沒有記錄時為 null */
    flow: SectorFlow | null;
}

/**
 * 流向狀態（決定流向欄顯示數字或「—」）。是否顯示流向只看「本頁開啟後是否已量到成交值增量」，與時段無關：
 * - live：盤中，且已量到增量。
 * - ended：已收盤（建底／事件標示 closed），但本頁開啟期間已量到增量 → 仍顯示今日量到的流向。
 * - closed：已收盤，且沒有任何量測（例如盤後、週末、休市日才第一次開啟）。
 * - waiting：盤中但還沒量到增量（剛開啟、串流尚未送達、或沒有即時資料）。
 */
export type FlowStatus = 'live' | 'ended' | 'closed' | 'waiting';

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function toSectorFlow(g: GroupFlow, now: number | null): SectorFlow {
    let turnover = 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i < SESSION_SLOTS; i += 1) {
        const t = g.turnover[i]!;
        if (t === 0) continue;
        turnover += t;
        if (first < 0) first = i;
        last = i;
    }
    const end = now !== null ? Math.max(now, last) : last;
    const series: number[] = [];
    if (first >= 0) for (let i = first; i <= Math.min(end, SESSION_SLOTS - 1); i += 1) series.push(g.cumNet[i]!);
    return {
        flow5: g.flow5,
        turnover5: g.turnover5,
        net: g.cumNet[SESSION_SLOTS - 1]!,
        turnover,
        series,
    };
}

/**
 * 群組指標 → 產業列。amount／wperf 為同一指數的兩條群組投影；flowOf 回傳該群組的 recorder 彙總（沒有時 null）。
 * 只出現在其中一條投影的產業仍列出，缺的欄位為 null。
 */
export function buildSectorRows(
    index: IcIndexCode,
    amountGroups: readonly IcGroupRow[] | undefined,
    wperfGroups: readonly IcGroupRow[] | undefined,
    flowOf: (key: IcKey) => GroupFlow | null,
    now: number | null,
): SectorRow[] {
    const byCat = new Map<string, { name: string; count: number; amount: number | null; pct: number | null }>();
    for (const g of amountGroups ?? []) {
        byCat.set(g.category, { name: g.name, count: g.item_count, amount: finite(g.value) ? g.value : null, pct: null });
    }
    for (const g of wperfGroups ?? []) {
        const row = byCat.get(g.category);
        const pct = finite(g.value) ? g.value : null;
        if (row) row.pct = pct;
        else byCat.set(g.category, { name: g.name, count: g.item_count, amount: null, pct });
    }
    let total = 0;
    for (const r of byCat.values()) if (r.amount !== null && r.amount > 0) total += r.amount;
    const rows: SectorRow[] = [];
    for (const [category, r] of byCat) {
        const key: IcKey = `${index}:${category}`;
        const g = flowOf(key);
        rows.push({
            key,
            category,
            name: r.name || category,
            count: r.count,
            pct: r.pct,
            amount: r.amount,
            share: r.amount !== null && total > 0 ? r.amount / total : null,
            flow: g ? toSectorFlow(g, now) : null,
        });
    }
    return rows;
}

export function flowStatusOf(rows: readonly SectorRow[], marketPhase: string | undefined): FlowStatus {
    const measured = rows.some(r => r.flow !== null && r.flow.turnover > 0);
    if (marketPhase === 'closed') return measured ? 'ended' : 'closed';
    return measured ? 'live' : 'waiting';
}

/** 是否有量到的流向可顯示（盤中或收盤後皆可） */
export const flowShown = (status: FlowStatus): boolean => status === 'live' || status === 'ended';

/** 流向不可用時一律視為沒有流向（畫面顯示「—」，排序排在最後） */
export function visibleFlow(row: SectorRow, status: FlowStatus): SectorFlow | null {
    return flowShown(status) ? row.flow : null;
}

/** null 一律排最後；同值依成交值大到小、再依產業代碼 */
function byValue(get: (r: SectorRow) => number | null, dir: 1 | -1) {
    return (a: SectorRow, b: SectorRow): number => {
        const va = get(a);
        const vb = get(b);
        if (va === null && vb !== null) return 1;
        if (vb === null && va !== null) return -1;
        if (va !== null && vb !== null && va !== vb) return dir * (va - vb);
        const aa = a.amount ?? -1;
        const ab = b.amount ?? -1;
        if (aa !== ab) return ab - aa;
        return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
    };
}

export function sortSectorRows(rows: readonly SectorRow[], sort: SectorSort, status: FlowStatus): SectorRow[] {
    const net = (r: SectorRow) => visibleFlow(r, status)?.net ?? null;
    const cmp = {
        inflow: byValue(net, -1),
        outflow: byValue(net, 1),
        gain: byValue(r => r.pct, -1),
        loss: byValue(r => r.pct, 1),
        amount: byValue(r => r.amount, -1),
    }[sort];
    return [...rows].sort(cmp);
}

/** 依使用者選的排序排列產業列；沒有資料的列不論方向都在最後 */
export function sortSectorRowsBy(rows: readonly SectorRow[], pref: SectorSortPref, status: FlowStatus): SectorRow[] {
    const sign = pref.dir === 'desc' ? -1 : 1;
    const get = {
        flow: (r: SectorRow) => visibleFlow(r, status)?.net ?? null,
        flow5: (r: SectorRow) => visibleFlow(r, status)?.flow5 ?? null,
        pct: (r: SectorRow) => r.pct,
        amount: (r: SectorRow) => r.amount,
    }[pref.key];
    return [...rows].sort(byValue(get, sign));
}

/** 頂部摘要：累計淨流入前 n（>0）與淨流出前 n（<0）；流向不可用時兩邊都空 */
export function topFlows(rows: readonly SectorRow[], status: FlowStatus, n = 3): { inflow: SectorRow[]; outflow: SectorRow[] } {
    if (!flowShown(status)) return { inflow: [], outflow: [] };
    const withNet = rows.filter(r => r.flow !== null);
    return {
        inflow: sortSectorRows(withNet.filter(r => r.flow!.net > 0), 'inflow', status).slice(0, n),
        outflow: sortSectorRows(withNet.filter(r => r.flow!.net < 0), 'outflow', status).slice(0, n),
    };
}

/** 依加權漲跌的名次（1 起算）與總數；沒有漲跌時 null */
export function gainRank(rows: readonly SectorRow[], key: IcKey): { rank: number; of: number } | null {
    const ranked = sortSectorRows(rows.filter(r => r.pct !== null), 'gain', 'closed');
    const i = ranked.findIndex(r => r.key === key);
    return i < 0 ? null : { rank: i + 1, of: ranked.length };
}

export type Tone = 'up' | 'down' | 'flat';

export function toneOf(v: number | null | undefined): Tone {
    if (!finite(v) || v === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
}

/** 加權漲跌：▲／▼＋正負號（不只靠顏色）；沒有資料「—」 */
export function fmtSectorPct(v: number | null | undefined): string {
    if (!finite(v)) return '—';
    const arrow = v > 0 ? '▲' : v < 0 ? '▼' : '';
    const sign = v > 0 ? '+' : v < 0 ? '−' : '';
    return `${arrow}${sign}${Math.abs(v).toFixed(2)}%`;
}

/** 金額：兆／億／萬；signed 時正數加「+」、負數用「−」；沒有資料「—」 */
export function fmtSectorMoney(v: number | null | undefined, signed = false): string {
    if (!finite(v)) return '—';
    const sign = v < 0 ? '−' : signed && v > 0 ? '+' : '';
    const abs = Math.abs(v);
    if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)} 兆`;
    if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(abs >= 1e10 ? 0 : abs >= 1e9 ? 1 : 2)} 億`;
    if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString('en-US')} 萬`;
    return abs === 0 ? '0' : `${sign}${Math.round(abs)}`;
}

/** calculated_at（ISO，含時區 +08:00）→ 「HH:MM:SS」；無法辨識時 null */
export function fmtCalculatedAt(value: string | undefined): string | null {
    if (!value) return null;
    const m = /T(\d{2}:\d{2}:\d{2})/.exec(value);
    return m ? m[1]! : null;
}
