// src/lib/esun/account-details.ts — 玉山帳戶的完整帳務資訊（fork 模組）
//
// 上游的 StockPosition／AccountBalance／TradingLimits 只容得下部分欄位；這裡把玉山 SDK 的原始回傳
// （get_inventories、get_balance、get_trade_status、get_market_status、get_order_results）解析成
// 語意化、型別明確的資料，並以帳戶為鍵保存最近一次查詢結果，供 UI 顯示：
// - 數值欄位一律安全解析：缺值、空字串、非有限值 → null（絕不把缺值當成 0）。
// - 日期 → YYYY-MM-DD、時間 → HH:MM:SS，缺值 → ''。
// - 代碼標籤：未知代碼回「代碼 X」，空值回 ''。
//
// 帳戶鍵：broker_id＋account_id。玉山模擬環境帳戶的 broker_id 帶 -SIM 後綴（ESUN_SIMULATION_BROKER_SUFFIX，
// 由 esunAccountForEnvironment 產生），模擬與正式的帳戶鍵本來就不同，不需要再加入環境。

import { useSyncExternalStore } from 'react';
import type { Account, StockPosition } from '../types/portfolio';
import type { Trade } from '../types/order';
import type { StockProfitLoss } from '../shioaji';
import { esunInventoryCondOf, esunOrderId, esunTransactionCondOf, isEsunRealizedTransaction } from './order-mapping';
import type { EsunOrderResult, EsunTransactionItem } from './types';

// ---- 共用解析 ----

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** 數值安全解析：number 須為有限值；字串去空白後 Number；其他（含空字串、null、boolean）→ null */
export function esunNumber(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/** 布林安全解析：boolean 原樣；字串 'true'／'false'（不分大小寫）；其他 → null */
export function esunBoolean(v: unknown): boolean | null {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true') return true;
        if (s === 'false') return false;
    }
    return null;
}

/** 字串欄位：去空白；非字串／數值 → '' */
function str(v: unknown): string {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return '';
}

/** YYYYMMDD 或 YYYY-MM-DD（須為合法日曆日）→ YYYY-MM-DD；其他 → '' */
export function esunDate(v: unknown): string {
    const s = str(v);
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return '';
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
    return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * 玉山時間的數字串（去掉 ':'、'.'）。6 碼以內視為 HHMMSS（前補零到 6 碼），7～9 碼視為
 * HHMMSSmmm 被去掉前導零（前補零到 9 碼）。非數字或超過 9 碼 → null。
 */
function timeDigits(v: unknown): string | null {
    const s = str(v).replace(/[:.]/g, '');
    if (!/^\d+$/.test(s) || s.length < 5 || s.length > 9) return null;
    return s.length <= 6 ? s.padStart(6, '0') : s.padStart(9, '0');
}

/** HHMMSS／HHMMSSmmm／HH:MM:SS → HH:MM:SS；空值或不合法 → '' */
export function esunTime(v: unknown): string {
    const d = timeDigits(v);
    if (!d) return '';
    const hh = Number(d.slice(0, 2));
    const mm = Number(d.slice(2, 4));
    const ss = Number(d.slice(4, 6));
    if (hh > 23 || mm > 59 || ss > 59) return '';
    return `${d.slice(0, 2)}:${d.slice(2, 4)}:${d.slice(4, 6)}`;
}

/** epoch（≥ 1e12 視為毫秒，否則為秒）、數字字串或可解析的日期字串 → ISO 字串；其他 → '' */
export function esunTimestampIso(v: unknown): string {
    let ms: number | null = null;
    if (typeof v === 'number' || (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v))) {
        const n = esunNumber(v);
        if (n !== null && n > 0) ms = n >= 1e12 ? n : n * 1000;
    } else if (typeof v === 'string' && v.trim()) {
        const t = Date.parse(v.trim());
        if (Number.isFinite(t)) ms = t;
    } else if (isRecord(v) && 'seconds' in v) {
        const sec = esunNumber(v.seconds);
        if (sec !== null && sec > 0) ms = sec * 1000;
    }
    if (ms === null) return '';
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

// ---- 代碼標籤 ----

/** 市場別 s_type */
export const ESUN_MARKET_LABELS: Readonly<Record<string, string>> = { H: '上市', O: '上櫃', R: '興櫃' };
/** 交易類別 trade */
export const ESUN_TRADE_TYPE_LABELS: Readonly<Record<string, string>> = {
    '0': '現股', '3': '融資', '4': '融券', '9': '信用當沖', A: '現股當沖賣',
};
/** 盤別 ap_code */
export const ESUN_AP_CODE_LABELS: Readonly<Record<string, string>> = {
    '1': '整股', '2': '盤後定價', '3': '盤後零股', '4': '興櫃', '5': '盤中零股',
};
/** 當沖權限 day_trade_code */
export const ESUN_DAY_TRADE_CODE_LABELS: Readonly<Record<string, string>> = {
    X: '已啟用', Y: '僅可先買後賣', N: '未啟用', S: '暫停中',
};
/** 融資／融券權限 margin_code、short_code */
export const ESUN_CREDIT_CODE_LABELS: Readonly<Record<string, string>> = {
    '0': '可買賣', '1': '可買', '2': '可賣', '9': '不可買賣',
};
/** 委託單狀態 ord_status（get_order_results） */
export const ESUN_ORD_STATUS_LABELS: Readonly<Record<string, string>> = { '1': '預約單', '2': '盤中單' };
/** 可否取消 celable */
export const ESUN_CELABLE_LABELS: Readonly<Record<string, string>> = { '1': '可取消', '2': '不可取消' };

function labelOf(map: Readonly<Record<string, string>>, raw: unknown): string {
    const code = str(raw);
    if (!code) return '';
    return Object.prototype.hasOwnProperty.call(map, code) ? map[code]! : `代碼 ${code}`;
}

export const esunMarketLabel = (code: unknown): string => labelOf(ESUN_MARKET_LABELS, typeof code === 'string' ? code.toUpperCase() : code);
export const esunTradeTypeLabel = (code: unknown): string => labelOf(ESUN_TRADE_TYPE_LABELS, typeof code === 'string' ? code.toUpperCase() : code);
/** 委託的盤別（空值回 ''） */
export const esunApCodeLabel = (code: unknown): string => labelOf(ESUN_AP_CODE_LABELS, code);
/** 庫存的盤別：只有盤中零股有值，空字串視為整股 */
export const esunInventoryApCodeLabel = (code: unknown): string =>
    str(code) === '' ? ESUN_AP_CODE_LABELS['1']! : labelOf(ESUN_AP_CODE_LABELS, code);
export const esunDayTradeCodeLabel = (code: unknown): string => labelOf(ESUN_DAY_TRADE_CODE_LABELS, typeof code === 'string' ? code.toUpperCase() : code);
/** margin_code／short_code */
export const esunCreditCodeLabel = (code: unknown): string => labelOf(ESUN_CREDIT_CODE_LABELS, code);
export const esunOrdStatusLabel = (code: unknown): string => labelOf(ESUN_ORD_STATUS_LABELS, code);
export const esunCelableLabel = (code: unknown): string => labelOf(ESUN_CELABLE_LABELS, code);

// ---- 庫存明細 ----

export type EsunMarket = 'TSE' | 'OTC' | 'OES';

/** s_type → 交易所（H 上市 TSE、O 上櫃 OTC、R 興櫃 OES），其他 → null */
export function esunMarketOf(sType: unknown): EsunMarket | null {
    const s = str(sType).toUpperCase();
    return s === 'H' ? 'TSE' : s === 'O' ? 'OTC' : s === 'R' ? 'OES' : null;
}

/** get_inventories 的 stk_dats 一筆（成交明細） */
export interface EsunInventoryLot {
    /** 買賣別原碼（'B'／'S'，缺值 ''） */
    buySell: string;
    action: 'Buy' | 'Sell' | null;
    /** 委託書編號 ord_no */
    orderNo: string;
    /** 交易類別原碼 trade */
    tradeType: string;
    /** 成交日期 t_date（YYYY-MM-DD） */
    tradeDate: string;
    /** 成交時間 t_time（HH:MM:SS；僅成交當日有值） */
    tradeTime: string;
    /** 成交價格 price */
    price: number | null;
    /** 庫存股數 qty */
    shares: number | null;
    /** 調整股數 qty_c */
    adjustShares: number | null;
    /** 實高權值股數 qty_h */
    highWeightShares: number | null;
    /** 已分攤股數 qty_r */
    allocatedShares: number | null;
    /** 已分攤成本 cost_r */
    allocatedCost: number | null;
    /** 手續費 fee */
    fee: number | null;
    /** 交易稅 tax */
    tax: number | null;
    /** 證所稅 tax_g */
    capitalGainsTax: number | null;
    /** 淨收付金額 pay_n */
    netAmount: number | null;
    /** 平衡損益價 price_evn */
    breakEvenPrice: number | null;
    /** 未實現損益 make_a */
    unrealizedPnl: number | null;
    /** 未實現獲益率（%）make_a_per */
    unrealizedPnlPct: number | null;
    /** 市值（無假除權息）value_mkt */
    marketValue: number | null;
    /** 市值（有假除權息）value_now */
    marketValueAdjusted: number | null;
    /** 自訂欄位 user_def */
    userDef: string;
}

/** get_inventories 的一列（stk_sums）與其明細 */
export interface EsunInventoryDetail {
    /** 原始列序（1 起算），與同一批 fromEsunInventoryToPosition 的 StockPosition.id 相同 */
    rowId: number;
    code: string;
    name: string;
    /** 交易類別原碼 trade（'0' 現股、'3' 融資、'4' 融券…） */
    tradeType: string;
    /** 與 StockPosition.cond 相同的信用別（Cash／MarginTrading／ShortSelling） */
    cond: string;
    /** 盤別原碼 ap_code（只有盤中零股有值；空字串為整股） */
    apCode: string;
    /** 市場別原碼 s_type */
    marketCode: string;
    market: EsunMarket | null;
    /** 成本股數 cost_qty */
    costShares: number | null;
    /** 成本總計 cost_sum（原樣保留正負號） */
    costSum: number | null;
    /** 成交均價 price_avg */
    avgPrice: number | null;
    /** 損益平衡價 price_evn */
    breakEvenPrice: number | null;
    /** 即時價格（無假除權息）price_mkt */
    marketPrice: number | null;
    /** 即時價格（有假除權息）price_now */
    marketPriceAdjusted: number | null;
    /** 價金總計 price_qty_sum */
    priceQtySum: number | null;
    /** 昨餘額股數 qty_l */
    yesterdayShares: number | null;
    /** 今委買股數 qty_b */
    todayBuyShares: number | null;
    /** 今委買成交股數 qty_bm */
    todayBuyFilledShares: number | null;
    /** 今委賣股數 qty_s */
    todaySellShares: number | null;
    /** 今委賣成交股數 qty_sm */
    todaySellFilledShares: number | null;
    /** 調整股數 qty_c（現償或匯撥，負值為減庫存） */
    adjustShares: number | null;
    /** 未實現收入小計 rec_va_sum */
    unrealizedIncome: number | null;
    /** 市值（無假除權息）value_mkt */
    marketValue: number | null;
    /** 市值（有假除權息）value_now */
    marketValueAdjusted: number | null;
    /** 未實現損益小計 make_a_sum */
    unrealizedPnl: number | null;
    /** 未實現獲利率（%）make_a_per */
    unrealizedPnlPct: number | null;
    lots: EsunInventoryLot[];
}

/** stk_dats 一筆 → EsunInventoryLot（非物件回傳全空值的明細） */
export function parseEsunInventoryLot(raw: unknown): EsunInventoryLot {
    const r = isRecord(raw) ? raw : {};
    const buySell = str(r.buy_sell).toUpperCase();
    return {
        buySell,
        action: buySell === 'B' ? 'Buy' : buySell === 'S' ? 'Sell' : null,
        orderNo: str(r.ord_no),
        tradeType: str(r.trade).toUpperCase(),
        tradeDate: esunDate(r.t_date),
        tradeTime: esunTime(r.t_time),
        price: esunNumber(r.price),
        shares: esunNumber(r.qty),
        adjustShares: esunNumber(r.qty_c),
        highWeightShares: esunNumber(r.qty_h),
        allocatedShares: esunNumber(r.qty_r),
        allocatedCost: esunNumber(r.cost_r),
        fee: esunNumber(r.fee),
        tax: esunNumber(r.tax),
        capitalGainsTax: esunNumber(r.tax_g),
        netAmount: esunNumber(r.pay_n),
        breakEvenPrice: esunNumber(r.price_evn),
        unrealizedPnl: esunNumber(r.make_a),
        unrealizedPnlPct: esunNumber(r.make_a_per),
        marketValue: esunNumber(r.value_mkt),
        marketValueAdjusted: esunNumber(r.value_now),
        userDef: typeof r.user_def === 'string' ? r.user_def : '',
    };
}

/** 庫存一列 → EsunInventoryDetail；rowId 為原始列序（1 起算） */
export function parseEsunInventoryDetail(raw: unknown, rowId: number): EsunInventoryDetail {
    const r = isRecord(raw) ? raw : {};
    const tradeType = str(r.trade).toUpperCase();
    const marketCode = str(r.s_type).toUpperCase();
    return {
        rowId,
        code: str(r.stk_no),
        name: str(r.stk_na),
        tradeType,
        cond: esunInventoryCondOf(tradeType),
        apCode: str(r.ap_code),
        marketCode,
        market: esunMarketOf(marketCode),
        costShares: esunNumber(r.cost_qty),
        costSum: esunNumber(r.cost_sum),
        avgPrice: esunNumber(r.price_avg),
        breakEvenPrice: esunNumber(r.price_evn),
        marketPrice: esunNumber(r.price_mkt),
        marketPriceAdjusted: esunNumber(r.price_now),
        priceQtySum: esunNumber(r.price_qty_sum),
        yesterdayShares: esunNumber(r.qty_l),
        todayBuyShares: esunNumber(r.qty_b),
        todayBuyFilledShares: esunNumber(r.qty_bm),
        todaySellShares: esunNumber(r.qty_s),
        todaySellFilledShares: esunNumber(r.qty_sm),
        adjustShares: esunNumber(r.qty_c),
        unrealizedIncome: esunNumber(r.rec_va_sum),
        marketValue: esunNumber(r.value_mkt),
        marketValueAdjusted: esunNumber(r.value_now),
        unrealizedPnl: esunNumber(r.make_a_sum),
        unrealizedPnlPct: esunNumber(r.make_a_per),
        lots: Array.isArray(r.stk_dats) ? r.stk_dats.map(parseEsunInventoryLot) : [],
    };
}

/** 整批庫存列 → EsunInventoryDetail[]（rowId 依列序 1 起算） */
export function parseEsunInventoryDetails(rows: readonly unknown[]): EsunInventoryDetail[] {
    return rows.map((row, idx) => parseEsunInventoryDetail(row, idx + 1));
}

/** 均價一致（容許浮點誤差）；兩邊都缺值（null／非正數／NaN）也視為一致 */
function sameAvgPrice(detailPrice: number | null, positionPrice: number): boolean {
    const a = detailPrice !== null && detailPrice > 0 ? detailPrice : null;
    const b = Number.isFinite(positionPrice) && positionPrice > 0 ? positionPrice : null;
    if (a === null || b === null) return a === b;
    return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));
}

/**
 * 找出 StockPosition 對應的庫存明細：先依 code＋cond 篩選；只有一列時直接採用。
 * 有多列（例如同一檔的整股與盤中零股）時以 StockPosition.id 對應原始列序（rowId），並核對
 * 成本股數＝持倉數量（position 為 Share 單位，即帳務 dock 的 position_unit）與均價一致；
 * 任一不一致（例如明細與持倉來自不同次查詢、持倉已被成交投影改動）回 null，不顯示錯列的明細。
 */
export function findEsunInventoryDetail(
    details: readonly EsunInventoryDetail[] | null | undefined,
    position: Pick<StockPosition, 'id' | 'code' | 'cond' | 'quantity' | 'price'>,
): EsunInventoryDetail | null {
    if (!details?.length) return null;
    const code = String(position.code ?? '').trim();
    const cond = position.cond || 'Cash';
    const matches = details.filter(d => d.code === code && d.cond === cond);
    if (matches.length === 1) return matches[0]!;
    const byRow = matches.find(d => d.rowId === position.id);
    if (!byRow) return null;
    if (byRow.costShares === null || byRow.costShares !== position.quantity) return null;
    return sameAvgPrice(byRow.avgPrice, position.price) ? byRow : null;
}

// ---- 成交明細（get_transactions_by_date） ----

/** mat_dats 一筆（逐筆成交） */
export interface EsunTransactionFill {
    code: string;
    name: string;
    /** 買賣別原碼（'B'／'S'，缺值 ''） */
    buySell: string;
    action: 'Buy' | 'Sell' | null;
    /** 交易類別原碼 trade */
    tradeType: string;
    tradeTypeLabel: string;
    /** 市場別原碼 s_type */
    marketCode: string;
    market: EsunMarket | null;
    /** 委託書號 order_no */
    orderNo: string;
    /** 成交日期 t_date（YYYY-MM-DD） */
    tradeDate: string;
    /** 成交時間 t_time（HH:MM:SS；僅成交當日有值） */
    tradeTime: string;
    /** 日期 c_date（YYYY-MM-DD） */
    settleDate: string;
    /** 成交價格 price */
    price: number | null;
    /** 成交數量（股）qty */
    shares: number | null;
    /** 價金 price_qty */
    priceQty: number | null;
    /** 手續費 fee */
    fee: number | null;
    /** 融券手續費 db_fee */
    shortFee: number | null;
    /** 交易稅 tax */
    tax: number | null;
    /** 證所稅 tax_g */
    capitalGainsTax: number | null;
    /** 淨收付款 pay_n */
    netAmount: number | null;
    /** 已實現損益 make */
    realizedPnl: number | null;
    /** 已實現獲利率（%）make_per */
    realizedPnlPct: number | null;
    /** 自訂欄位 user_def */
    userDef: string;
}

/** mat_sums 一列（彙總）與其逐筆成交 */
export interface EsunTransactionDetail {
    /** 列序（1 起算）：存入 store 的已實現列與 StockProfitLoss.id 相同 */
    rowId: number;
    code: string;
    name: string;
    buySell: string;
    action: 'Buy' | 'Sell' | null;
    tradeType: string;
    tradeTypeLabel: string;
    /** 與 StockProfitLoss.cond 相同的信用別 */
    cond: string;
    marketCode: string;
    market: EsunMarket | null;
    /** 成交日期 t_date（YYYY-MM-DD） */
    tradeDate: string;
    /** 日期 c_date（YYYY-MM-DD） */
    settleDate: string;
    /** 與 fromEsunTransactionsToProfitLoss 的 StockProfitLoss.date 相同的值（核對列用） */
    profitLossDate: string;
    /** 數量（股）qty */
    shares: number | null;
    /** 成交均價 price_avg */
    avgPrice: number | null;
    /** 價金小計 price_qty */
    priceQty: number | null;
    /** 已實現損益成本小計 cost（原樣保留正負號） */
    cost: number | null;
    /** 已實現損益收入小計 recv */
    income: number | null;
    /** 已實現損益 make */
    realizedPnl: number | null;
    /** 已實現獲利率（%）make_per */
    realizedPnlPct: number | null;
    /** isEsunRealizedTransaction 的結果 */
    realized: boolean;
    fills: EsunTransactionFill[];
}

function actionOf(buySell: string): 'Buy' | 'Sell' | null {
    return buySell === 'B' ? 'Buy' : buySell === 'S' ? 'Sell' : null;
}

/** mat_dats 一筆 → EsunTransactionFill（非物件回傳全空值） */
export function parseEsunTransactionFill(raw: unknown): EsunTransactionFill {
    const r = isRecord(raw) ? raw : {};
    const buySell = str(r.buy_sell).toUpperCase();
    const tradeType = str(r.trade).toUpperCase();
    const marketCode = str(r.s_type).toUpperCase();
    return {
        code: str(r.stk_no),
        name: str(r.stk_na),
        buySell,
        action: actionOf(buySell),
        tradeType,
        tradeTypeLabel: esunTradeTypeLabel(tradeType),
        marketCode,
        market: esunMarketOf(marketCode),
        orderNo: str(r.order_no),
        tradeDate: esunDate(r.t_date),
        tradeTime: esunTime(r.t_time),
        settleDate: esunDate(r.c_date),
        price: esunNumber(r.price),
        shares: esunNumber(r.qty),
        priceQty: esunNumber(r.price_qty),
        fee: esunNumber(r.fee),
        shortFee: esunNumber(r.db_fee),
        tax: esunNumber(r.tax),
        capitalGainsTax: esunNumber(r.tax_g),
        netAmount: esunNumber(r.pay_n),
        realizedPnl: esunNumber(r.make),
        realizedPnlPct: esunNumber(r.make_per),
        userDef: typeof r.user_def === 'string' ? r.user_def : '',
    };
}

/** mat_sums 一列 → EsunTransactionDetail；rowId 為呼叫端指定的列序（1 起算） */
export function parseEsunTransactionDetail(raw: unknown, rowId: number): EsunTransactionDetail {
    const r = isRecord(raw) ? raw : {};
    const buySell = str(r.buy_sell).toUpperCase();
    const tradeType = str(r.trade).toUpperCase();
    const marketCode = str(r.s_type).toUpperCase();
    return {
        rowId,
        code: str(r.stk_no ?? r.code),
        name: str(r.stk_na),
        buySell,
        action: actionOf(buySell),
        tradeType,
        tradeTypeLabel: esunTradeTypeLabel(tradeType),
        cond: esunTransactionCondOf(tradeType),
        marketCode,
        market: esunMarketOf(marketCode),
        tradeDate: esunDate(r.t_date),
        settleDate: esunDate(r.c_date),
        // 與 fromEsunTransactionsToProfitLoss 相同的取值
        profitLossDate: String(r.t_date ?? r.date ?? r.c_date ?? '').replace(/-/g, ''),
        shares: esunNumber(r.qty ?? r.quantity),
        avgPrice: esunNumber(r.price_avg),
        priceQty: esunNumber(r.price_qty),
        cost: esunNumber(r.cost),
        income: esunNumber(r.recv),
        realizedPnl: esunNumber(r.make),
        realizedPnlPct: esunNumber(r.make_per),
        realized: isRecord(raw) ? isEsunRealizedTransaction(raw as EsunTransactionItem) : false,
        fills: Array.isArray(r.mat_dats) ? r.mat_dats.map(parseEsunTransactionFill) : [],
    };
}

/**
 * 原始成交列 → 已實現列的 EsunTransactionDetail[]：與 fromEsunTransactionsToProfitLoss 使用同一個
 * isEsunRealizedTransaction 篩選，rowId 依篩選後的順序 1 起算，與 StockProfitLoss.id 一一對應。
 */
export function parseEsunRealizedTransactionDetails(rows: readonly EsunTransactionItem[]): EsunTransactionDetail[] {
    return rows.filter(isEsunRealizedTransaction).map((row, idx) => parseEsunTransactionDetail(row, idx + 1));
}

/**
 * 找出 StockProfitLoss 對應的成交明細：以 1 起算的 id 對應列序，並核對 code、日期與信用別
 * （row.cond 缺值視為 Cash）一致才回傳；不一致（例如明細與損益列來自不同次查詢）回 undefined。
 */
export function findEsunTransactionDetail(
    details: readonly EsunTransactionDetail[] | null | undefined,
    row: Pick<StockProfitLoss, 'id' | 'code' | 'date'> & { cond?: string },
): EsunTransactionDetail | undefined {
    if (!details?.length || !Number.isSafeInteger(row.id) || row.id < 1) return undefined;
    const detail = details[row.id - 1];
    if (!detail || detail.rowId !== row.id) return undefined;
    if (detail.code !== String(row.code ?? '').trim()) return undefined;
    if (detail.profitLossDate !== String(row.date ?? '').replace(/-/g, '')) return undefined;
    if (detail.cond !== (row.cond || 'Cash')) return undefined;
    return detail;
}

// ---- 餘額、交易額度、市場狀態 ----

export interface EsunBalanceDetail {
    /** 可用銀行餘額 available_balance */
    availableBalance: number | null;
    /** 今日票據交換金額 exchange_balance（文件拼為 exange_balance，兩者皆接受） */
    exchangeBalance: number | null;
    /** 圈存金額 stock_pre_save_amount */
    preSaveAmount: number | null;
    /** 正式環境 is_latest_data */
    isLatestData: boolean | null;
    /** 正式環境 updated_at → ISO 字串；缺值 '' */
    updatedAt: string;
    /** bridge：本次是否回傳快取 */
    cached: boolean | null;
    /** bridge：快取資料的年齡（秒） */
    cacheAgeSec: number | null;
}

export function parseEsunBalanceDetail(raw: unknown): EsunBalanceDetail {
    const r = isRecord(raw) ? raw : {};
    return {
        availableBalance: esunNumber(r.available_balance ?? r.availableBalance),
        exchangeBalance: esunNumber(r.exchange_balance ?? r.exange_balance ?? r.exchangeBalance),
        preSaveAmount: esunNumber(r.stock_pre_save_amount ?? r.stockPreSaveAmount),
        isLatestData: esunBoolean(r.is_latest_data ?? r.isLatestData),
        updatedAt: esunTimestampIso(r.updated_at ?? r.updatedAt),
        cached: esunBoolean(r.cached),
        cacheAgeSec: esunNumber(r.cache_age_sec),
    };
}

export interface EsunTradeStatusDetail {
    /** 交易額度 trade_limit（文件沒有已用／剩餘） */
    tradeLimit: number | null;
    /** 融資額度 margin_limit */
    marginLimit: number | null;
    /** 融券額度 short_limit */
    shortLimit: number | null;
    dayTradeCode: string;
    dayTradeLabel: string;
    marginCode: string;
    marginLabel: string;
    shortCode: string;
    shortLabel: string;
}

export function parseEsunTradeStatusDetail(raw: unknown): EsunTradeStatusDetail {
    const r = isRecord(raw) ? raw : {};
    const dayTradeCode = str(r.day_trade_code).toUpperCase();
    const marginCode = str(r.margin_code);
    const shortCode = str(r.short_code);
    return {
        tradeLimit: esunNumber(r.trade_limit ?? r.trading_limit),
        marginLimit: esunNumber(r.margin_limit),
        shortLimit: esunNumber(r.short_limit),
        dayTradeCode,
        dayTradeLabel: esunDayTradeCodeLabel(dayTradeCode),
        marginCode,
        marginLabel: esunCreditCodeLabel(marginCode),
        shortCode,
        shortLabel: esunCreditCodeLabel(shortCode),
    };
}

export interface EsunMarketStatusDetail {
    isTradingDay: boolean | null;
    /** 上一個交易日（YYYY-MM-DD，缺值 ''） */
    lastTradingDay: string;
    /** 下一個交易日（YYYY-MM-DD，缺值 ''） */
    nextTradingDay: string;
}

export function parseEsunMarketStatusDetail(raw: unknown): EsunMarketStatusDetail {
    const r = isRecord(raw) ? raw : {};
    return {
        isTradingDay: esunBoolean(r.is_trading_day ?? r.isTradingDay),
        lastTradingDay: esunDate(r.last_trading_day ?? r.lastTradingDay),
        nextTradingDay: esunDate(r.next_trading_day ?? r.nextTradingDay),
    };
}

export interface EsunAccountOverview {
    balance: EsunBalanceDetail;
    tradeStatus: EsunTradeStatusDetail;
    /** market status 查詢失敗時為 null */
    marketStatus: EsunMarketStatusDetail | null;
}

// ---- 帳戶鍵與簡易 store ----

export type EsunAccountRef = Pick<Account, 'broker_id' | 'account_id'>;

/** 帳戶鍵：broker_id＋account_id（模擬帳戶 broker_id 帶 -SIM，與正式帳戶天然不同） */
export function esunAccountDetailKey(account: EsunAccountRef): string {
    return `${String(account.broker_id ?? '').trim().toUpperCase()}:${String(account.account_id ?? '').trim()}`;
}

function createListeners() {
    const listeners = new Set<() => void>();
    return {
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        emit(): void {
            listeners.forEach(l => l());
        },
    };
}

// ---- 庫存明細 store ----

export interface EsunInventorySnapshot {
    details: readonly EsunInventoryDetail[];
    /** 查詢完成時間（epoch ms） */
    fetchedAt: number;
}

const inventoryByAccount = new Map<string, EsunInventorySnapshot>();
const inventoryListeners = createListeners();

/** 訂閱庫存明細 store 的任何變更 */
export const subscribeEsunInventoryDetails = inventoryListeners.subscribe;

/** 該帳戶最近一次的庫存明細快照（同一快照回傳同一物件；沒有資料回 null） */
export function getEsunInventoryDetailsSnapshot(account: EsunAccountRef | null | undefined): EsunInventorySnapshot | null {
    if (!account) return null;
    return inventoryByAccount.get(esunAccountDetailKey(account)) ?? null;
}

/** 以新的查詢結果整批取代該帳戶的庫存明細 */
export function setEsunInventoryDetails(
    account: EsunAccountRef,
    details: readonly EsunInventoryDetail[],
    fetchedAt: number = Date.now(),
): void {
    inventoryByAccount.set(esunAccountDetailKey(account), { details: [...details], fetchedAt });
    inventoryListeners.emit();
}

/** 清除單一帳戶或全部帳戶的庫存明細 */
export function clearEsunInventoryDetails(account?: EsunAccountRef): void {
    if (account) {
        if (!inventoryByAccount.delete(esunAccountDetailKey(account))) return;
    } else {
        if (inventoryByAccount.size === 0) return;
        inventoryByAccount.clear();
    }
    inventoryListeners.emit();
}

/** React hook：該帳戶最近一次的庫存明細快照（沒有資料為 null） */
export function useEsunInventoryDetails(account: EsunAccountRef | null | undefined): EsunInventorySnapshot | null {
    const key = account ? esunAccountDetailKey(account) : null;
    return useSyncExternalStore(
        subscribeEsunInventoryDetails,
        () => (key === null ? null : inventoryByAccount.get(key) ?? null),
        () => null,
    );
}

// ---- 成交明細 store ----

export interface EsunTransactionSnapshot {
    /** 已實現列（順序與同一次 fetchProfitLoss 回傳的 StockProfitLoss[] 相同） */
    details: readonly EsunTransactionDetail[];
    /** 查詢完成時間（epoch ms） */
    fetchedAt: number;
    /** 查詢時傳入的區間（原樣，未經 180 天裁切） */
    beginDate: string;
    endDate: string;
}

const transactionsByKey = new Map<string, EsunTransactionSnapshot>();
const transactionListeners = createListeners();

/** 成交明細 store 的鍵：帳戶＋查詢區間（區間以呼叫 fetchProfitLoss 時的字串為準） */
export function esunTransactionDetailKey(account: EsunAccountRef, beginDate: string, endDate: string): string {
    return `${esunAccountDetailKey(account)}|${String(beginDate ?? '').trim()}|${String(endDate ?? '').trim()}`;
}

/** 訂閱成交明細 store 的任何變更 */
export const subscribeEsunTransactionDetails = transactionListeners.subscribe;

/** 該帳戶＋區間最近一次的成交明細快照（沒有資料回 null） */
export function getEsunTransactionDetailsSnapshot(
    account: EsunAccountRef | null | undefined,
    beginDate: string,
    endDate: string,
): EsunTransactionSnapshot | null {
    if (!account) return null;
    return transactionsByKey.get(esunTransactionDetailKey(account, beginDate, endDate)) ?? null;
}

/** 以新的查詢結果整批取代該帳戶＋區間的成交明細 */
export function setEsunTransactionDetails(
    account: EsunAccountRef,
    beginDate: string,
    endDate: string,
    details: readonly EsunTransactionDetail[],
    fetchedAt: number = Date.now(),
): void {
    transactionsByKey.set(esunTransactionDetailKey(account, beginDate, endDate), {
        details: [...details],
        fetchedAt,
        beginDate: String(beginDate ?? '').trim(),
        endDate: String(endDate ?? '').trim(),
    });
    transactionListeners.emit();
}

/** 清除單一帳戶（所有區間）或全部帳戶的成交明細 */
export function clearEsunTransactionDetails(account?: EsunAccountRef): void {
    let changed = false;
    if (account) {
        const prefix = `${esunAccountDetailKey(account)}|`;
        for (const key of [...transactionsByKey.keys()]) {
            if (key.startsWith(prefix)) changed = transactionsByKey.delete(key) || changed;
        }
    } else {
        changed = transactionsByKey.size > 0;
        transactionsByKey.clear();
    }
    if (changed) transactionListeners.emit();
}

/** React hook：該帳戶＋區間最近一次的成交明細快照（沒有資料為 null） */
export function useEsunTransactionDetails(
    account: EsunAccountRef | null | undefined,
    beginDate: string,
    endDate: string,
): EsunTransactionSnapshot | null {
    const key = account ? esunTransactionDetailKey(account, beginDate, endDate) : null;
    return useSyncExternalStore(
        subscribeEsunTransactionDetails,
        () => (key === null ? null : transactionsByKey.get(key) ?? null),
        () => null,
    );
}

// ---- 委託中繼資料 store ----

export interface EsunOrderMeta {
    /** 預約來源（徽章用）：ord_status '1'，或 pre_ord_no 有值（開盤後取得 ord_no 仍為 true） */
    reservation: boolean;
    /** 尚未進入盤中撮合的預約單：reservation 且 ord_no 空白（不可改價、改量） */
    pendingReservation: boolean;
    /** 有效交易日期 work_date（YYYY-MM-DD，缺值 ''） */
    workDate: string;
    /** 原始委託日期 ord_date（YYYY-MM-DD，缺值 ''） */
    orderDate: string;
    /** 原始委託時間 ord_time（HH:MM:SS，缺值 ''） */
    orderTime: string;
    /** celable：'1' → true、'2' → false、其他 → null */
    cancellable: boolean | null;
}

/** get_order_results 一列 → EsunOrderMeta（支援 snake_case 與 camelCase） */
export function parseEsunOrderMeta(raw: unknown): EsunOrderMeta {
    const r = isRecord(raw) ? raw : {};
    const ordStatus = str(r.ord_status ?? r.ordStatus);
    const preOrdNo = str(r.pre_ord_no ?? r.preOrdNo);
    const ordNo = str(r.ord_no ?? r.ordNo);
    const celable = str(r.celable);
    const reservation = ordStatus === '1' || preOrdNo !== '';
    return {
        reservation,
        pendingReservation: reservation && ordNo === '',
        workDate: esunDate(r.work_date ?? r.workDate),
        orderDate: esunDate(r.ord_date ?? r.ordDate),
        orderTime: esunTime(r.ord_time ?? r.ordTime),
        cancellable: celable === '1' ? true : celable === '2' ? false : null,
    };
}

const orderMetaByAccount = new Map<string, ReadonlyMap<string, EsunOrderMeta>>();
const orderMetaListeners = createListeners();

/** 訂閱委託中繼資料 store 的任何變更 */
export const subscribeEsunOrderMeta = orderMetaListeners.subscribe;

/**
 * 以一次委託查詢的快照整批取代該帳戶的委託中繼資料（舊資料不殘留）。
 * 鍵為 esunOrderId（pre_ord_no 優先），與 fromEsunOrderResult 的 trade.order.id 相同；沒有編號的列略過。
 */
export function setEsunOrderMetaSnapshot(account: EsunAccountRef, rows: readonly (EsunOrderResult | Json)[]): void {
    const map = new Map<string, EsunOrderMeta>();
    for (const row of rows) {
        if (!isRecord(row)) continue;
        const id = esunOrderId(row);
        if (id) map.set(id, parseEsunOrderMeta(row));
    }
    orderMetaByAccount.set(esunAccountDetailKey(account), map);
    orderMetaListeners.emit();
}

/** 以帳戶與委託 id 查詢委託中繼資料 */
export function getEsunOrderMeta(account: EsunAccountRef | null | undefined, orderId: string | null | undefined): EsunOrderMeta | null {
    if (!account || !orderId) return null;
    return orderMetaByAccount.get(esunAccountDetailKey(account))?.get(String(orderId).trim()) ?? null;
}

/** 以 trade.order.account 與 trade.order.id 查詢委託中繼資料（非玉山或沒有資料回 null） */
export function esunOrderMetaOf(trade: Pick<Trade, 'order'> | null | undefined): EsunOrderMeta | null {
    const order = trade?.order;
    if (!order?.account) return null;
    return getEsunOrderMeta(order.account, order.id);
}

/** 清除單一帳戶或全部帳戶的委託中繼資料 */
export function clearEsunOrderMeta(account?: EsunAccountRef): void {
    if (account) {
        if (!orderMetaByAccount.delete(esunAccountDetailKey(account))) return;
    } else {
        if (orderMetaByAccount.size === 0) return;
        orderMetaByAccount.clear();
    }
    orderMetaListeners.emit();
}

/** React hook：trade 的委託中繼資料（store 更新時重新渲染） */
export function useEsunOrderMeta(trade: Pick<Trade, 'order'> | null | undefined): EsunOrderMeta | null {
    return useSyncExternalStore(
        subscribeEsunOrderMeta,
        () => esunOrderMetaOf(trade),
        () => null,
    );
}
