// src/lib/position-value.ts — 股票持倉的市值與清算價值（fork 模組；帳務 dock 摘要列與 FundsSection 共用）。
//
// - 市值（stockMarketValue）＝|股數|×現價，融券也以正值計（與玉山 value_mkt 一致）。
// - 清算價值（stockLiquidationValue）＝部位今天了結後對淨資產的貢獻：
//   現股多單沿用上游估算 市值×(1−手續費−證交稅)；
//   融券＝保證金＋未實現損益、融資＝自備款＋未實現損益（玉山以庫存明細 cost_sum 取得）；
//   永豐信用列只在持倉資料帶有 short_sale_margin／margin_purchase_amount／interest 時計算；
//   保證金、融資金額或玉山 cost_sum 為 0／負值視為未知；玉山明細須與持倉同列序、同股數、同均價。
//   任何取不到的情況回 null（不猜），加總時標示 incomplete，畫面改顯示「合計待確認」。

import { useSyncExternalStore } from 'react';
import {
    findEsunInventoryDetail,
    getEsunInventoryDetailsSnapshot,
    isEsunBroker,
    subscribeEsunInventoryDetails,
    type EsunInventorySnapshot,
} from './esun';
import { taipeiToday } from './option-expiry';
import type { Settlement } from './shioaji';
import type { ContractInfo } from './types/contract';
import type { Account, StockPosition } from './types/portfolio';
import { STOCK_FEE_RATE, stockTaxRate } from './utils/contract-cost';

export type ValuedStockPosition = StockPosition & { account?: Account };

export interface PositionValueContext {
    /** 玉山庫存明細快照；預設讀 account-details store */
    esunInventory?: (account: Account) => EsunInventorySnapshot | null;
}

export interface ValueSum {
    value: number;
    /** 有任何一列無法計算（已略過） */
    incomplete: boolean;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 持倉資料上券商額外帶出的數值欄位（永豐 Shioaji StockPosition；型別未宣告） */
function extraNumber(p: StockPosition, key: string): number | null {
    const v = (p as unknown as Record<string, unknown>)[key];
    return finite(v) ? v : null;
}

/** 明細均價與持倉均價一致（兩邊都必須是正的有限值；容許浮點誤差） */
function sameAvgPrice(detailPrice: number | null, positionPrice: number): boolean {
    if (!finite(detailPrice) || !finite(positionPrice) || detailPrice <= 0 || positionPrice <= 0) return false;
    return Math.abs(detailPrice - positionPrice) <= 1e-6 * Math.max(1, detailPrice);
}

/** |股數|×現價；任一非有限值回 null */
export function stockMarketValue(p: StockPosition): number | null {
    if (!finite(p.quantity) || !finite(p.last_price)) return null;
    return Math.abs(p.quantity * p.last_price);
}

/** 上游估算：賣出時扣手續費與證交稅後的價金 */
function netOfSellCost(p: StockPosition, marketValue: number): number {
    const taxRate = stockTaxRate({ code: p.code } as ContractInfo);
    return marketValue * (1 - STOCK_FEE_RATE - taxRate);
}

/**
 * 部位今天了結後對淨資產的貢獻（元）；無法可靠計算回 null。
 * 帳戶交割戶餘額另計，不含在內。
 */
export function stockLiquidationValue(p: ValuedStockPosition, ctx: PositionValueContext = {}): number | null {
    const cond = p.cond || 'Cash';
    if (cond === 'Cash') {
        // 現股先賣（當沖）列的價值是損益而非市值，資料不足以判斷 — 不猜
        if (p.direction !== 'Buy') return null;
        const mv = stockMarketValue(p);
        return mv === null ? null : netOfSellCost(p, mv);
    }
    const credit = (cond === 'ShortSelling' && p.direction === 'Sell') || (cond === 'MarginTrading' && p.direction === 'Buy');
    if (!credit || !finite(p.pnl)) return null;

    if (p.account && isEsunBroker(p.account.broker_id)) {
        const snapshot = (ctx.esunInventory ?? getEsunInventoryDetailsSnapshot)(p.account);
        const detail = findEsunInventoryDetail(snapshot?.details, p);
        // 只有一列符合時 findEsunInventoryDetail 不核對列序、數量與均價；成交投影新建（id<0）、
        // 改過股數或加權均價的列都是過期明細。cost_sum 為 0 視為未知（不可當 0 保證金計）。
        if (!detail || detail.rowId !== p.id || detail.costShares !== p.quantity || !sameAvgPrice(detail.avgPrice, p.price)) return null;
        if (detail.costSum === null || !(Math.abs(detail.costSum) > 0)) return null;
        return Math.abs(detail.costSum) + p.pnl;
    }

    // 永豐：保證金／融資金額為 0 或負值視為未知（模擬環境或預設值），不可當 0 計入
    if (cond === 'ShortSelling') {
        const margin = extraNumber(p, 'short_sale_margin');
        return margin === null || margin <= 0 ? null : margin + p.pnl;
    }
    const loan = extraNumber(p, 'margin_purchase_amount');
    const interest = extraNumber(p, 'interest');
    const mv = stockMarketValue(p);
    if (loan === null || loan <= 0 || interest === null || interest < 0 || mv === null) return null;
    return netOfSellCost(p, mv) - loan - interest;
}

function sumOf(rows: readonly ValuedStockPosition[], valueOf: (p: ValuedStockPosition) => number | null): ValueSum {
    let value = 0;
    let incomplete = false;
    for (const p of rows) {
        const v = valueOf(p);
        if (v === null || !Number.isFinite(v)) incomplete = true;
        else value += v;
    }
    return { value, incomplete };
}

export function sumStockMarketValue(rows: readonly StockPosition[]): ValueSum {
    return sumOf(rows, stockMarketValue);
}

export function sumStockLiquidationValue(rows: readonly ValuedStockPosition[], ctx: PositionValueContext = {}): ValueSum {
    return sumOf(rows, p => stockLiquidationValue(p, ctx));
}

/**
 * 交割行事曆中尚未入扣交割戶的款項（正＝應收、負＝應付）：交割日晚於「交割戶餘額快照當天」（台北日期）的列。
 * 當天的列視為已入扣帳。呼叫端應傳入餘額快照時間；資料尚未取得或日期無法解析回 null。
 */
export function pendingSettlementAmount(settlements: readonly Settlement[] | undefined, balanceSnapshotMs: number = Date.now()): number | null {
    if (!settlements || !finite(balanceSnapshotMs)) return null;
    const today = taipeiToday(balanceSnapshotMs);
    let total = 0;
    for (const s of settlements) {
        const date = /^\d{4}-\d{2}-\d{2}/.exec(String(s.date ?? ''))?.[0];
        if (!date || !finite(s.amount)) return null;
        if (date > today) total += s.amount;
    }
    return total;
}

/** 快照時間未知，或快照的台北日期早於現在（跨日未更新）；帳務合計應改為待確認 */
export function isPriorTaipeiDay(snapshotMs: number | null | undefined, nowMs: number = Date.now()): boolean {
    if (!finite(snapshotMs)) return true;
    return taipeiToday(snapshotMs) < taipeiToday(nowMs);
}

/**
 * 股票持倉簽章（帳戶｜代號｜信用別｜方向｜股數），與順序無關。交割款快照取得時記下，
 * 之後簽章不同代表快照後有成交（或持倉重讀），未交割款已過期。
 */
export function stockPositionsSignature(rows: readonly ValuedStockPosition[]): string {
    return rows.map(p => [
        p.account ? `${p.account.account_type}:${p.account.broker_id}:${p.account.account_id}` : '',
        String(p.code ?? '').trim(), p.cond || 'Cash', p.direction, p.quantity,
    ].join('|')).sort().join('\n');
}

const settlementBaselines = new Map<string, { at: number | null; sig: string; startSig?: string }>();

/**
 * 交割款快照是否早於目前持倉（module 範圍記錄，pane 卸載重掛仍有效）。
 * - 查詢開始（loading）時先記下當下簽章；查詢結果到達（updatedAt 改變）時以開始時的簽章為基準，
 *   查詢期間發生的成交因此仍會判為過期（保守）。看不到 loading 時以結果到達當下的簽章為基準。
 * - 不自動重查（玉山交割款查詢每分鐘限 3 次），只回報過期，由使用者按更新帳務。
 */
export function settlementsOlderThanPositions(key: string, updatedAt: number | null, loading: boolean, signature: string): boolean {
    let base = settlementBaselines.get(key);
    if (!base) { base = { at: updatedAt, sig: signature }; settlementBaselines.set(key, base); }
    if (loading) base.startSig ??= signature;
    if (updatedAt !== base.at) {
        base.at = updatedAt;
        base.sig = base.startSig ?? signature;
        base.startSig = undefined;
    } else if (!loading) base.startSig = undefined;
    return updatedAt !== null && base.sig !== signature;
}

// 每個庫存快照物件給一個序號，讓 useSyncExternalStore 的 snapshot 可用字串比較
const snapshotIds = new WeakMap<EsunInventorySnapshot, number>();
let nextSnapshotId = 1;
function snapshotId(s: EsunInventorySnapshot | null): number {
    if (!s) return 0;
    let id = snapshotIds.get(s);
    if (id === undefined) { id = nextSnapshotId++; snapshotIds.set(s, id); }
    return id;
}

/** React hook：Σ清算價值與各列清算價值（null＝未知），玉山庫存明細更新時重新計算 */
export function useStockLiquidationValue(rows: readonly ValuedStockPosition[]): ValueSum & { values: (number | null)[] } {
    const accounts = rows.filter(p => p.account && isEsunBroker(p.account.broker_id)).map(p => p.account!);
    useSyncExternalStore(
        subscribeEsunInventoryDetails,
        () => accounts.map(a => snapshotId(getEsunInventoryDetailsSnapshot(a))).join(','),
        () => '',
    );
    const values = rows.map(p => {
        const v = stockLiquidationValue(p);
        return v !== null && Number.isFinite(v) ? v : null;
    });
    return {
        value: values.reduce<number>((sum, v) => sum + (v ?? 0), 0),
        incomplete: values.some(v => v === null),
        values,
    };
}
