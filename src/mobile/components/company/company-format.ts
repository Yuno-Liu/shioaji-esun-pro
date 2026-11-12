// src/mobile/components/company/company-format.ts — 交易頁「公司」分頁的純函式（格式與規則與桌面 company-panel.tsx 相同）
//
// 桌面面板（src/components/company-panel.tsx）不可修改，且匯入它會把桌面樣式、圖示與即時快照一起拉進手機 chunk，
// 所以這裡照抄它的小工具（companyTarget、金額與比率格式），由 company-format.test.ts 以桌面測試的同一組案例鎖住行為。
// 資料讀取一律走 hooks/use-company-data 與 lib/company-data（不另寫讀取邏輯）。

import { normalizeCompanyCode, twCodeOf } from '../../../lib/company-data';
import type { ContractInfo } from '../../../lib/types/contract';
import { isValidProductCode } from '../../lib/hash-router';

/** 公司資料的對象：股票本身，或個股期貨／選擇權的標的公司；指數與指數類衍生性商品沒有（同桌面 companyTarget） */
export function companyTarget(contract: Pick<ContractInfo, 'security_type' | 'code' | 'underlying_code' | 'underlying_kind'>): { code: string; viaUnderlying: boolean } | null {
    if (contract.security_type === 'STK') {
        const code = normalizeCompanyCode(contract.code);
        return code ? { code, viaUnderlying: false } : null;
    }
    if (contract.security_type === 'IND' || contract.underlying_kind === 'I') return null;
    const underlying = normalizeCompanyCode(contract.underlying_code ?? '');
    return underlying ? { code: underlying, viaUnderlying: true } : null;
}

/** 新台幣金額 → 兆／億／萬（同桌面 fmtTwd） */
export function fmtTwd(v: number | null | undefined): string {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e12) return `${(v / 1e12).toFixed(2)} 兆`;
    if (a >= 1e8) return `${(v / 1e8).toLocaleString('en-US', { maximumFractionDigits: a >= 1e10 ? 0 : 1 })} 億`;
    if (a >= 1e4) return `${(v / 1e4).toLocaleString('en-US', { maximumFractionDigits: 0 })} 萬`;
    return v.toLocaleString('en-US');
}

/** 財報金額（千元）→ 兆／億 */
export const fmtK = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : fmtTwd(v * 1000));
export const fmtRatio = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);
export const fmtGrowth = (v: number | null | undefined): string =>
    v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;

/**
 * 營收組成的色階（前 3 段同桌面 MIX_OPACITY）。第 4 段起改為對比等比遞減：桌面的 0.36／0.25／0.17／0.12／0.10
 * 疊在深色 muted 上只有 1.75→1.13:1、相鄰段 1.03:1，分不出來。改後各段對軌道底 深色 2.03→1.32、淺色 1.82→1.30，
 * 相鄰段 深色約 1.11–1.12、淺色約 1.09（前 3 段不變）。
 */
export const MIX_OPACITY = [1, 0.7, 0.5, 0.44, 0.38, 0.32, 0.26];
export const MIX_OPACITY_FLOOR = 0.2;
export const mixOpacity = (i: number): number => MIX_OPACITY[i] ?? MIX_OPACITY_FLOOR;

/**
 * 外部連結：只接受 http／https（公司網站可能沒有通訊協定，補 https://，同桌面）；其他（javascript:、mailto: 等）回 null，
 * 呼叫端改顯示純文字。
 */
export function externalHref(raw: string | null | undefined): string | null {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
    try {
        const url = new URL(withScheme);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
        return null;
    }
}

/** 網站顯示文字：去掉通訊協定（同桌面） */
export const siteText = (raw: string): string => raw.replace(/^https?:\/\//, '');

/** 關聯公司的台股代碼（可開交易頁）；非台股或代碼不合法時 null */
export function tradableCodeOf(entityId: string): string | null {
    const code = twCodeOf(entityId);
    return code && isValidProductCode(code) ? code : null;
}
