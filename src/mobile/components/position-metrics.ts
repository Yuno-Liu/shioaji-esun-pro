// src/mobile/components/position-metrics.ts — 持倉頁的純計算（比照桌面 bottom-dock／bottom-dock-positions）
//
// - 市場分段：股票（positionMarket＝'S'）、期貨／選擇權（'F' 再依商品 security_type 區分）；
//   期權商品資料尚未載入時「無法歸類」，只在「全部」顯示，不猜。
// - 報酬率：股票＝損益 ÷（均價 × |股數|）；期貨＝(現價 − 均價) ÷ 均價 × 方向（桌面 retPctOf 同式）；算不出回 null。
// - 成本＝均價 × |股數|、市值＝|股數| × 現價（stockMarketValue），只對股票；期權沒有乘數資訊回 null。
// - 摘要與分組小計：損益加總、股票市值（sumMarketValue：與列相同用 positionMarketValue，現價 ≤ 0 或缺值的列略過並標示不完整）；
//   報酬率合計只在全部為股票時提供（期貨是保證金交易，沒有成本基礎）。
// - 期貨風險指標：initial_margin 與 risk_indicator 都 > 0 才有意義（模擬或未押保證金時全 0，顯示「—」）。

import { positionMarket } from '../../components/bottom-dock-shared';
import { stockMarketValue, type ValueSum } from '../../lib/position-value';
import type { ContractInfo } from '../../lib/types/contract';
import type { Account, AccountedPosition, Margin, Position, StockPosition } from '../../lib/types/portfolio';

export type PositionMarketFilter = 'all' | 'stock' | 'futures' | 'options';
export type PositionSegment = Exclude<PositionMarketFilter, 'all'>;
export type PositionSortMode = 'default' | 'pnl' | 'return' | 'value' | 'code';

export const MARKET_FILTERS: readonly { key: PositionMarketFilter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'stock', label: '股票' },
    { key: 'futures', label: '期貨' },
    { key: 'options', label: '選擇權' },
];

export const SORT_MODES: readonly { key: PositionSortMode; label: string }[] = [
    { key: 'default', label: '券商順序' },
    { key: 'pnl', label: '損益' },
    { key: 'return', label: '報酬率' },
    { key: 'value', label: '市值' },
    { key: 'code', label: '代碼' },
];

type ContractOf = (code: string) => Pick<ContractInfo, 'security_type'> | undefined;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isStock(p: Position): p is StockPosition {
    return positionMarket(p) === 'S';
}

/** 市場分段；期權商品資料未載入（或不是 FUT／OPT）回 null */
export function positionSegment(p: Position, contract?: Pick<ContractInfo, 'security_type'>): PositionSegment | null {
    if (isStock(p)) return 'stock';
    if (contract?.security_type === 'OPT') return 'options';
    if (contract?.security_type === 'FUT') return 'futures';
    return null;
}

/** 依市場分段篩選；回傳無法歸類（期權商品資料未載入）的筆數，供畫面說明 */
export function filterByMarket<T extends AccountedPosition>(
    rows: readonly T[],
    market: PositionMarketFilter,
    contractOf: ContractOf,
): { rows: T[]; unclassified: number } {
    if (market === 'all') return { rows: [...rows], unclassified: 0 };
    let unclassified = 0;
    const out = rows.filter(p => {
        const seg = positionSegment(p, contractOf(p.code));
        if (seg === null) {
            // 股票分段不受期權商品資料影響
            if (market !== 'stock') unclassified += 1;
            return false;
        }
        return seg === market;
    });
    return { rows: out, unclassified };
}

/** 成本＝均價 × |股數|（只對股票；缺值回 null） */
export function positionCost(p: Position): number | null {
    if (!isStock(p) || !finite(p.price) || !finite(p.quantity) || p.price <= 0) return null;
    return p.price * Math.abs(p.quantity);
}

/** 市值＝|股數| × 現價（只對股票；缺值或現價 ≤ 0 回 null） */
export function positionMarketValue(p: Position): number | null {
    if (!isStock(p) || !(p.last_price > 0)) return null;
    return stockMarketValue(p);
}

/** 報酬率（%）；算不出回 null */
export function positionReturnPct(p: Position): number | null {
    if (!finite(p.price) || p.price <= 0) return null;
    if (isStock(p)) {
        if (!finite(p.quantity) || p.quantity === 0 || !finite(p.pnl)) return null;
        return (p.pnl / (p.price * Math.abs(p.quantity))) * 100;
    }
    if (!finite(p.last_price) || p.last_price <= 0) return null;
    const sign = p.direction === 'Buy' ? 1 : p.direction === 'Sell' ? -1 : 0;
    if (sign === 0) return null;
    return ((p.last_price - p.price) / p.price) * 100 * sign;
}

const desc = (a: number | null, b: number | null): number => {
    // null 一律排最後
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a;
};

/** 排序（穩定排序；不改原陣列）。default＝券商順序 */
export function sortPositions<T extends AccountedPosition>(rows: readonly T[], mode: PositionSortMode): T[] {
    const out = [...rows];
    if (mode === 'pnl') out.sort((a, b) => desc(finite(a.pnl) ? a.pnl : null, finite(b.pnl) ? b.pnl : null));
    else if (mode === 'return') out.sort((a, b) => desc(positionReturnPct(a), positionReturnPct(b)));
    else if (mode === 'value') out.sort((a, b) => desc(positionMarketValue(a), positionMarketValue(b)));
    else if (mode === 'code') out.sort((a, b) => a.code.localeCompare(b.code));
    return out;
}

/**
 * 股票市值合計：與列相同用 positionMarketValue（現價 0 也算缺價），缺價列不計入並標示 incomplete。
 * 不用 lib 的 sumStockMarketValue：它只把非有限值當缺價，現價 0 會被當成市值 0 悄悄加總。
 */
export function sumMarketValue(stocks: readonly Position[]): ValueSum {
    let value = 0;
    let incomplete = false;
    for (const p of stocks) {
        const v = positionMarketValue(p);
        if (v === null || !finite(v)) incomplete = true;
        else value += v;
    }
    return { value, incomplete };
}

const sumPnl = (rows: readonly Position[]): number => rows.reduce((s, p) => s + (finite(p.pnl) ? p.pnl : 0), 0);

export interface PositionsSummary {
    count: number;
    pnl: number;
    /** 股票市值合計；沒有股票列時為 null */
    marketValue: ValueSum | null;
    /** 股票成本合計（均價 × 股數）；沒有股票列時為 null */
    stockCost: number | null;
    /** 損益 ÷ 成本（%）：只在全部為股票且成本 > 0 時提供 */
    pnlPct: number | null;
}

export function summarizePositions(rows: readonly AccountedPosition[]): PositionsSummary {
    const stocks = rows.filter(isStock);
    const pnl = sumPnl(rows);
    const stockCost = stocks.length ? stocks.reduce((s, p) => s + (positionCost(p) ?? 0), 0) : null;
    const allStock = rows.length > 0 && stocks.length === rows.length;
    return {
        count: rows.length,
        pnl,
        marketValue: stocks.length ? sumMarketValue(stocks) : null,
        stockCost,
        pnlPct: allStock && stockCost !== null && stockCost > 0 ? (pnl / stockCost) * 100 : null,
    };
}

export interface PositionGroup<T extends AccountedPosition = AccountedPosition> {
    /** 帳戶鍵（type:broker:id）；帳戶不明為 '' */
    key: string;
    account?: Account;
    rows: T[];
    count: number;
    pnl: number;
    /** 股票市值小計；該組沒有股票列時為 null */
    value: ValueSum | null;
}

export function accountKeyOf(a: Pick<Account, 'account_type' | 'broker_id' | 'account_id'> | null | undefined): string {
    return a ? `${a.account_type}:${a.broker_id}:${a.account_id}` : '';
}

/** 依帳戶分組（組的順序＝該帳戶第一筆出現的順序，組內保留傳入順序）並計算小計 */
export function groupPositionsByAccount<T extends AccountedPosition>(rows: readonly T[]): PositionGroup<T>[] {
    const map = new Map<string, PositionGroup<T>>();
    for (const p of rows) {
        const key = accountKeyOf(p.account);
        let g = map.get(key);
        if (!g) {
            g = { key, ...(p.account ? { account: p.account } : {}), rows: [], count: 0, pnl: 0, value: null };
            map.set(key, g);
        }
        g.rows.push(p);
    }
    for (const g of map.values()) {
        const stocks = (g.rows as readonly Position[]).filter(isStock);
        g.count = g.rows.length;
        g.pnl = sumPnl(g.rows);
        g.value = stocks.length ? sumMarketValue(stocks) : null;
    }
    return [...map.values()];
}

export type RiskLevel = 'danger' | 'warn' | 'ok';

export interface FuturesRisk {
    equity: number | null;
    /** 風險指標（%）；沒有意義時為 null */
    risk: number | null;
    level: RiskLevel | null;
}

/** 期貨權益數與風險指標；沒有保證金資料回 null */
export function futuresRiskOf(margin: Pick<Margin, 'equity' | 'initial_margin' | 'risk_indicator'> | null | undefined): FuturesRisk | null {
    if (!margin) return null;
    const equity = finite(margin.equity) ? margin.equity : null;
    const meaningful = finite(margin.initial_margin) && margin.initial_margin > 0 && finite(margin.risk_indicator) && margin.risk_indicator > 0;
    if (!meaningful) return { equity, risk: null, level: null };
    const risk = margin.risk_indicator;
    return { equity, risk, level: risk < 100 ? 'danger' : risk < 200 ? 'warn' : 'ok' };
}

export const RISK_LEVEL_TEXT: Record<RiskLevel, string> = { danger: '危險', warn: '注意', ok: '正常' };

/** 損益條寬度（0–50，單位 %，以 0 為中心）；maxAbs 為 0 或缺值時回 0 */
export function pnlBarWidth(pnl: number, maxAbs: number): number {
    if (!finite(pnl) || !finite(maxAbs) || maxAbs <= 0) return 0;
    return Math.min(50, (Math.abs(pnl) / maxAbs) * 50);
}
