// src/mobile/lib/account-pnl.ts — 已實現損益的區間與合計規則（純函式；比照桌面 bottom-dock-account.tsx pnlFetcher）
//
// 合計規則（逐市場、逐帳戶）：profitloss_sum 有料（total.pnl ≠ 0 或彙總列非空）就用 sum；
// 沒料（模擬環境 sum 全 0 但列表有 paper 資料）改用列表加總。sum 查詢失敗也退回列表加總；
// 列表失敗但 sum 有料時只用 sum（沒有明細列）；兩者都失敗 → 合計不完整。
// 列依 |損益| 由大到小排序。
//
// 自訂區間（customRangeProblem）：兩家券商一律最多 PNL_MAX_RANGE_DAYS（180）天、含起訖日（迄日 − 起日 ≤ 179），
// 比玉山 AW00002／AW00003 的 180 天裁切（clampEsunDateRange180Days 允許相差 180 天）更保守，查詢區間永遠不會被裁。
// 不合法時只回傳原因，不自動修正日期。

import type { ProfitLoss, ProfitLossSummaryTotal } from '../../lib/shioaji';

/** 依今天推算的固定區間 */
export type PnlPreset = 'today' | 'week' | 'month' | '30d';
export type PnlPeriod = PnlPreset | 'custom';

export const PNL_PERIODS: readonly { value: PnlPeriod; text: string }[] = [
    { value: 'today', text: '今日' },
    { value: 'week', text: '本週' },
    { value: 'month', text: '本月' },
    { value: '30d', text: '近 30 天' },
    { value: 'custom', text: '自訂' },
];

/** 已實現損益：同一區間＋帳戶在這段時間內不重查（與 useQuery 不同，手機只在使用者操作時讀取） */
export const PNL_COOLDOWN_MS = 30_000;

/**
 * 玉山已實現損益：任意 60 秒內最多查詢幾次（不分區間；自訂區間每換一次就是新的 key，不受 PNL_COOLDOWN_MS 保護）。
 * 依據：bridge 的 profit_loss_limiter 限 10 次／分，且只在快取未命中時取額度（esun_trade_server.py _cached_query：
 * single-flight 填充鎖之後、快取鍵＝日期區間、TTL 10 秒）。每次「查詢」對玉山證券帳戶發出 2 個同區間的
 * GET /esun/portfolio/profit-loss（fetchProfitLoss＋fetchProfitLossSummary），通常只占 1 個額度，最壞 2 個（第一個失敗）。
 * 4 次查詢 ≤ 8 個額度 < 10 次／分，留空間給同一個 bridge 上的桌面版。永豐沒有這道限制（只有同區間 30 秒不重查）。
 */
export const PNL_ESUN_QUERIES_PER_MIN = 4;

/** 自訂區間最多天數（含起訖日） */
export const PNL_MAX_RANGE_DAYS = 180;

const DAY_MS = 86_400_000;
const TW_OFFSET_MS = 8 * 3600_000;

function ymd(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 台北日期的查詢區間（YYYY-MM-DD，含頭尾）；本週從週一起算，近 30 天含今天共 30 天 */
export function pnlDateRange(period: PnlPreset, nowMs: number = Date.now()): { begin: string; end: string } {
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

/** YYYY-MM-DD → 該日 00:00 UTC 的 ms；格式不符或不存在的日期（02-30）回 null */
function parseYmd(s: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return ymd(new Date(t)) === s ? t : null;
}

/** 區間天數（含起訖日）；任一日期無效回 null */
export function pnlRangeDays(begin: string, end: string): number | null {
    const b = parseYmd(begin);
    const e = parseYmd(end);
    return b === null || e === null ? null : Math.round((e - b) / DAY_MS) + 1;
}

/**
 * 自訂區間的問題（null＝可查詢）：空白或無效日期、迄日晚於今天（台北）、起日晚於迄日、超過 180 天（含起訖日）。
 * 只回傳原因，不修正日期。
 */
export function customRangeProblem(begin: string, end: string, nowMs: number = Date.now()): string | null {
    if (!begin) return '請選擇起日。';
    if (!end) return '請選擇迄日。';
    const b = parseYmd(begin);
    const e = parseYmd(end);
    if (b === null) return '起日不是有效的日期。';
    if (e === null) return '迄日不是有效的日期。';
    const today = pnlDateRange('today', nowMs).end;
    if (end > today) return `迄日不能晚於今天（${today}）。`;
    if (b > e) return '起日不能晚於迄日。';
    const days = Math.round((e - b) / DAY_MS) + 1;
    if (days > PNL_MAX_RANGE_DAYS) return `區間最多 ${PNL_MAX_RANGE_DAYS} 天（目前 ${days} 天）。`;
    return null;
}

/**
 * 日期欄的 min／max（原生選擇器的提示；手動輸入仍以 customRangeProblem 驗證）：
 * 迄日最大＝今天；起日最大＝迄日（迄日無效或晚於今天時用今天）；起日最小＝該日 − 179 天。
 */
export function customRangeBounds(end: string, nowMs: number = Date.now()): { endMax: string; beginMin: string; beginMax: string } {
    const today = pnlDateRange('today', nowMs).end;
    const anchor = parseYmd(end) !== null && end <= today ? end : today;
    return {
        endMax: today,
        beginMax: anchor,
        beginMin: ymd(new Date(parseYmd(anchor)! - (PNL_MAX_RANGE_DAYS - 1) * DAY_MS)),
    };
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
