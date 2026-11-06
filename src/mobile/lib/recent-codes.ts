// src/mobile/lib/recent-codes.ts — 交易頁「最近查看」商品（切換商品面板空白查詢時顯示）
//
// 只是本機便利紀錄（localStorage 'sj-mobile-recent-codes'）：最多 RECENT_CODES_MAX 筆，最新在前、以代碼去重。
// 讀寫一律 try/catch；解析失敗、形狀不對都當空清單，個別壞項目略過。不含任何交易資料。

import { isValidProductCode } from './hash-router';

export const RECENT_CODES_KEY = 'sj-mobile-recent-codes';
export const RECENT_CODES_MAX = 10;
/** 名稱長度上限（防止異常資料撐爆畫面） */
const NAME_MAX = 64;

export interface RecentCode {
    code: string;
    name: string;
    securityType?: string;
}

function sanitize(raw: unknown): RecentCode | null {
    if (!raw || typeof raw !== 'object') return null;
    const { code, name, securityType } = raw as Record<string, unknown>;
    if (typeof code !== 'string' || !isValidProductCode(code)) return null;
    const entry: RecentCode = { code, name: typeof name === 'string' ? name.slice(0, NAME_MAX) : '' };
    if (typeof securityType === 'string' && /^[A-Z]{1,8}$/.test(securityType)) entry.securityType = securityType;
    return entry;
}

function normalize(list: readonly unknown[]): RecentCode[] {
    const out: RecentCode[] = [];
    const seen = new Set<string>();
    for (const raw of list) {
        const entry = sanitize(raw);
        if (!entry || seen.has(entry.code)) continue;
        seen.add(entry.code);
        out.push(entry);
        if (out.length >= RECENT_CODES_MAX) break;
    }
    return out;
}

/** 讀取最近查看（最新在前）；不能讀或資料壞掉時回傳空清單 */
export function loadRecentCodes(): RecentCode[] {
    try {
        const text = typeof localStorage === 'undefined' ? null : localStorage.getItem(RECENT_CODES_KEY);
        if (!text) return [];
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? normalize(parsed) : [];
    } catch {
        return [];
    }
}

/** 記錄一筆（移到最前、去重、截到上限）並回傳新清單；寫入失敗只在本次有效 */
export function recordRecentCode(entry: RecentCode): RecentCode[] {
    const next = normalize([entry, ...loadRecentCodes()]);
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(RECENT_CODES_KEY, JSON.stringify(next));
    } catch {
        // 只在本次有效
    }
    return next;
}
