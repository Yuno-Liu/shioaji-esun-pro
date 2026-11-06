// src/mobile/lib/account-pnl.ts — 已實現損益的區間與合計規則（純函式；比照桌面 bottom-dock-account.tsx pnlFetcher）
//
// 合計規則（逐市場、逐帳戶）：profitloss_sum 有料（total.pnl ≠ 0 或彙總列非空）就用 sum；
// 沒料（模擬環境 sum 全 0 但列表有 paper 資料）改用列表加總。sum 查詢失敗也退回列表加總；
// 列表失敗但 sum 有料時只用 sum（沒有明細列）；兩者都失敗 → 合計不完整。
// 列依 |損益| 由大到小排序。

import type { ProfitLoss, ProfitLossSummaryTotal } from '../../lib/shioaji';

export type PnlPeriod = 'today' | 'week' | 'month' | '30d';

export const PNL_PERIODS: readonly { value: PnlPeriod; text: string }[] = [
    { value: 'today', text: '今日' },
    { value: 'week', text: '本週' },
    { value: 'month', text: '本月' },
    { value: '30d', text: '近 30 天' },
];

/** 已實現損益：同一區間＋帳戶在這段時間內不重查（與 useQuery 不同，手機只在使用者操作時讀取） */
export const PNL_COOLDOWN_MS = 30_000;

const DAY_MS = 86_400_000;
const TW_OFFSET_MS = 8 * 3600_000;

function ymd(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 台北日期的查詢區間（YYYY-MM-DD，含頭尾）；本週從週一起算，近 30 天含今天共 30 天 */
export function pnlDateRange(period: PnlPeriod, nowMs: number = Date.now()): { begin: string; end: string } {
    const today = new Date(nowMs + TW_OFFSET_MS); // 只讀 getUTC*（＝台北牆鐘）
    const end = ymd(today);
    const startOfDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    let begin: number;
    switch (period) {
        case 'week': {
            const sinceMonday = (today.getUTCDay() + 6) % 7;
            begin = startOfDay - sinceMonday * DAY_MS;
            break;
        }
        case 'month':
            begin = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
            break;
        case '30d':
            begin = startOfDay - 29 * DAY_MS;
            break;
        default:
            begin = startOfDay;
    }
    return { begin: ymd(new Date(begin)), end };
}

export type PnlMarket = 'S' | 'F';

export type RealizedPnlRow = ProfitLoss & { market: PnlMarket; accountKey: string };

/** 一個帳戶的查詢結果（list／sum 失敗為 null） */
export interface PnlPart {
    market: PnlMarket;
    /** `${broker_id}:${account_id}`（與桌面 accountKey 相同格式） */
    accountKey: string;
    list: readonly ProfitLoss[] | null;
    sum: ProfitLossSummaryTotal | null;
    /** list 與 sum 的錯誤訊息（沒有錯誤為空陣列） */
    errors: string[];
}

export type PnlTotalSource = 'sum' | 'list' | 'none';

/** 單一帳戶的合計：sum 有料用 sum，否則列表加總；兩者都沒有回 null */
export function marketPnlTotal(list: readonly Pick<ProfitLoss, 'pnl'>[] | null, sum: ProfitLossSummaryTotal | null): { total: number | null; source: PnlTotalSource } {
    const haveSum = !!sum && !!sum.total && Number.isFinite(sum.total.pnl)
        && (sum.total.pnl !== 0 || (Array.isArray(sum.profitloss_sum) && sum.profitloss_sum.length > 0));
    if (haveSum) return { total: sum!.total.pnl, source: 'sum' };
    if (list) return { total: list.reduce((s, r) => s + (Number.isFinite(r.pnl) ? r.pnl : 0), 0), source: 'list' };
    return { total: null, source: 'none' };
}

export interface MarketPnlSummary {
    market: PnlMarket;
    accountKey: string;
    total: number | null;
    source: PnlTotalSource;
}

export interface RealizedPnlResult {
    rows: RealizedPnlRow[];
    /** 合計（已知部分）；全部帳戶都失敗時為 null */
    total: number | null;
    /** 有帳戶的合計無法取得（total 只含其餘帳戶） */
    incomplete: boolean;
    markets: MarketPnlSummary[];
    errors: string[];
}

export function aggregateRealizedPnl(parts: readonly PnlPart[]): RealizedPnlResult {
    const rows: RealizedPnlRow[] = [];
    const markets: MarketPnlSummary[] = [];
    const errors: string[] = [];
    let total = 0;
    let known = 0;
    for (const part of parts) {
        for (const r of part.list ?? []) rows.push({ ...r, market: part.market, accountKey: part.accountKey });
        const t = marketPnlTotal(part.list, part.sum);
        markets.push({ market: part.market, accountKey: part.accountKey, ...t });
        if (t.total !== null) {
            total += t.total;
            known += 1;
        }
        errors.push(...part.errors);
    }
    rows.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
    return {
        rows,
        total: known > 0 ? total : null,
        incomplete: markets.some(m => m.total === null),
        markets,
        errors,
    };
}

/** 列表裡同一筆的鍵（帳戶＋市場＋id＋明細序號或日期） */
export function realizedRowKey(r: RealizedPnlRow, index: number): string {
    const seq = 'dseq' in r && r.dseq ? r.dseq : r.date;
    return `${r.accountKey}-${r.market}-${r.id}-${seq}-${index}`;
}
