// src/mobile/lib/contract-names.ts — 委託、成交、已實現損益列的商品名稱（名稱為主、代碼為次）
//
// 名稱來源依序：
//   1. 資料本身帶的名稱（trade.contract.name、損益列或玉山成交明細的 name）；
//   2. src/lib/contracts-cache 的全域合約快取（useContract；持倉、交易頁解析過的合約就在裡面）；
//   3. 都沒有時以 ensureContract(code) 查一次合約（結果進同一份快取）。
// 每個不重複代碼在本 session 最多查一次：成功後由快取供應，失敗（或查到的名稱就是代碼，例如權證）不重試，
// 只顯示代碼。名稱載入前只顯示代碼，呼叫端以單行（不換行、省略號）排版，名稱到達時版面不跳動。
// 只讀取合約資料，不訂閱行情、不送任何委託。

import { useEffect } from 'react';
import { ensureContract, useContract } from '../../lib/contracts-cache';
import { canonicalBrokerCode, realizedCodeCandidates } from '../../lib/realized-name';
import type { SecurityType } from '../../lib/types/contract';

/** 已發出（或已確定不需發出）合約查詢的代碼 */
const requested = new Set<string>();

/**
 * 需要時查一次合約（同一代碼本 session 最多一次；失敗不重試）。
 * ensureContract 本身會先看快取並合併同時進行中的查詢。
 */
export function requestContractName(code: string, type?: SecurityType): void {
    const key = code.trim();
    if (!key || requested.has(key)) return;
    requested.add(key);
    void ensureContract(key, type ?? undefined).catch(() => undefined);
}

function cleanName(name: unknown, code: string): string | null {
    const text = typeof name === 'string' ? name.trim() : '';
    // 權證等合約的 name 會回填成代碼：視為沒有名稱
    return text && text !== code ? text : null;
}

/**
 * 商品名稱；沒有名稱（載入前、查詢失敗）回 null，呼叫端只顯示代碼。
 * known＝資料本身帶的名稱，有值時不讀快取也不查詢。
 */
export function useContractName(code: string | null | undefined, known?: string | null, type?: SecurityType): string | null {
    const key = (code ?? '').trim();
    const own = cleanName(known, key);
    const cached = useContract(own || !key ? null : key);
    const fromCache = cleanName(cached?.name, key);
    const need = !own && !fromCache && !!key;
    useEffect(() => {
        if (need) requestContractName(key, type);
    }, [need, key, type]);
    return own ?? fromCache;
}

/** 「名稱 代碼」（沒有名稱只回代碼）：aria-label、面板標題、清單文字用 */
export function instrumentText(code: string, name: string | null): string {
    return name ? `${name} ${code}` : code;
}

/**
 * 已實現損益列的查詢代碼：券商帳務的代碼不保證與合約代碼一字不差（src/lib/realized-name.ts）。
 * 正規化後，期貨「商品＋YYYYMM」長格式改用合約代碼（TMF202610 → TMFJ6），只查這一個候選。
 */
export function realizedLookupCode(code: string, market: 'S' | 'F'): string {
    const candidates = realizedCodeCandidates(String(code ?? ''), market);
    return candidates[candidates.length - 1] ?? canonicalBrokerCode(String(code ?? ''));
}

/** 測試用：清除已查詢紀錄 */
export function resetContractNamesForTest(): void {
    requested.clear();
}
