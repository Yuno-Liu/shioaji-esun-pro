// src/mobile/lib/day-trade-tax.ts — 現股當日沖銷的證交稅率（持倉淨損益與損益兩平價用）
//
// 法源：證券交易稅條例第 2 條之 1——現股當日沖銷交易（同一帳戶當日現款買進與現券賣出同種類、同數量股票）
// 的賣出證交稅率減半為千分之一・五（0.15%），適用期間至 2027-12-31。
// - 只適用一般股票（stockTaxRate 為 0.3% 者）；ETF、權證本來就是 0.1%，不減半，沿用 stockTaxRate；
//   債券 ETF 停徵期間為 0（同 stockTaxRate）。
// - 資券當沖（融資買進＋融券賣出）不是現股當沖，不適用。
// - 以台灣時間判斷：2028-01-01 00:00（+08:00）起自動回到一般稅率。
// - 只有今天還能沖銷時（台北時間 13:30 前）才把今日買進當成可當沖；收盤後回到一般稅率。
// 費率本身不另寫常數：一般股票的當沖稅率＝stockTaxRate ÷ 2（法條文字即「減半」）。

import type { ContractInfo } from '../../lib/types/contract';
import { stockTaxRate } from '../../lib/utils/contract-cost';

/** 減半適用的最後一天（台灣日期，含當日） */
export const DAY_TRADE_HALF_TAX_LAST_DAY = '2027-12-31';
/** 期滿時點（epoch ms）：台灣時間 2028-01-01 00:00 起不再減半 */
export const DAY_TRADE_HALF_TAX_UNTIL = Date.parse('2028-01-01T00:00:00+08:00');

export type TaxContract = Pick<ContractInfo, 'code' | 'security_type'> & Partial<Pick<ContractInfo, 'underlying_kind'>>;

/** 證交稅率（賣出）；只讀 code、security_type、underlying_kind（同 stockTaxRate） */
export function sellTaxRate(contract: TaxContract, now: number): number {
    return stockTaxRate(contract as ContractInfo, now);
}

/**
 * 一般股票（減半的適用對象）：與 stockTaxRate 同一套分類——權證（WRT）、ETF（代號 00 開頭或
 * underlying_kind 'E'）不是一般股票。
 */
export function isGeneralStock(contract: TaxContract): boolean {
    if (contract.security_type !== 'STK') return false;
    return !contract.code.startsWith('00') && contract.underlying_kind !== 'E';
}

/** 減半是否仍在適用期間（台灣時間） */
export function dayTradeHalfTaxActive(now: number): boolean {
    return now < DAY_TRADE_HALF_TAX_UNTIL;
}

/**
 * 今天還能以現股當沖沖銷的最後時點（台北時間時:分，不含）：一般交易時段 13:30 收盤後不能再下單沖銷。
 * 盤後定價（14:00–14:30）是否可做現股當沖沖銷未確認，保守以 13:30 為準。
 */
export const DAY_TRADE_CUTOFF_HHMM = 13 * 60 + 30;

/** 台北時間當天的分鐘數（0–1439） */
function taipeiMinuteOfDay(now: number): number {
    const d = new Date(now + 8 * 3_600_000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * 今天的買進（或當沖先賣）是否還能在今天沖銷：台北時間 13:30 前。
 * 收盤後今天買進的股數最早下一個交易日才能賣出，證交稅回到一般稅率。
 */
export function dayTradeSessionOpen(now: number): boolean {
    return taipeiMinuteOfDay(now) < DAY_TRADE_CUTOFF_HHMM;
}

/**
 * 現股當沖賣出的證交稅率：一般股票在適用期間內＝一般稅率 ÷ 2（0.15%）；
 * 其他（ETF、權證、債券 ETF）或期滿後＝stockTaxRate。
 */
export function dayTradeSellTaxRate(contract: TaxContract, now: number): number {
    const base = sellTaxRate(contract, now);
    return isGeneralStock(contract) && dayTradeHalfTaxActive(now) ? base / 2 : base;
}
