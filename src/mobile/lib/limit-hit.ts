// src/mobile/lib/limit-hit.ts — 漲停／跌停判斷（報價列、交易頁主價、產業成分股列共用；設計規格 §7.2）
//
// - 只看真實成交價（試撮揭示價、參考價不算）是否等於合約的 limit_up／limit_down。
// - 不用浮點數相等：差距小於半個最小跳動單位（台股、期權最小跳動 0.01 → 0.005）視為相等。
// - 漲跌停 ≤ 0、缺少（指數、未載入合約、排行未解析的合約）時不判斷；指數一律不判斷。
// 本檔在首屏（QuoteRow），保持極小、不 import 其他模組；「漲停／跌停」文字由各呼叫端組（QuoteRow 重用 DIR_TEXT）。

/** 半個最小跳動單位：價格與漲跌停價差距小於此值視為相等 */
export const LIMIT_TOLERANCE = 0.005;

export type LimitState = 'up' | 'down';

/**
 * 成交價是否鎖在漲停／跌停：合約（含 security_type 與漲跌停，可為字串）＋成交價。
 * 試撮、指數、沒有合約、價格無效、漲跌停 ≤ 0 或缺少時 null。
 */
export function quoteLimit(
    contract: { security_type?: string | null; limit_up?: unknown; limit_down?: unknown } | null | undefined,
    price: number | null | undefined,
    simtrade?: boolean,
): LimitState | null {
    if (!contract || simtrade || contract.security_type === 'IND' || !(price! > 0)) return null;
    // 比較與減法本身就會把數字字串轉成數字（首屏位元組：不另呼叫 Number()）；非數字字串得到 NaN → false
    const at = (limit: unknown) => (limit as number) > 0 && Math.abs(price! - (limit as number)) < LIMIT_TOLERANCE;
    return at(contract.limit_up) ? 'up' : at(contract.limit_down) ? 'down' : null;
}
