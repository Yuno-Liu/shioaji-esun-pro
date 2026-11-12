// src/mobile/lib/account-format.ts — 帳戶頁共用格式（純函式）
//
// 金額一律交給呼叫端以 maskMoney 遮蔽；這裡只負責文字。數字經 num-format 的快取 Intl.NumberFormat（輸出同 toLocaleString）。

import { formatNumber } from './num-format';
import { taipeiClock } from './taipei-clock';

function pad2(n: number) {
    return String(n).padStart(2, '0');
}

/** HH:mm:ss（台北時間，不依裝置時區）；沒有值顯示 — */
export function formatClock(ms: number | null | undefined): string {
    return taipeiClock(ms);
}

/** 金額：$1,234；帶正負號時 +$1,234／−$1,234 */
export function formatTwd(v: number | undefined | null, signed = false): string {
    if (v === undefined || v === null || !Number.isFinite(v)) return '—';
    const abs = formatNumber(Math.abs(v), 'en-US', { maximumFractionDigits: 0 });
    if (!signed) return `${v < 0 ? '−' : ''}$${abs}`;
    return v > 0 ? `+$${abs}` : v < 0 ? `−$${abs}` : '$0';
}

/** 股數：1,000 股；非有限值 — */
export function formatShares(v: number | null | undefined): string {
    if (v === undefined || v === null || !Number.isFinite(v)) return '—';
    return `${formatNumber(Math.abs(v), 'en-US')} 股`;
}

/** 價格：保留到兩位小數、去掉多餘的 0；非有限值 — */
export function formatPrice(v: number | null | undefined): string {
    if (v === undefined || v === null || !Number.isFinite(v)) return '—';
    return formatNumber(v, 'en-US', { maximumFractionDigits: 2 });
}

/** 百分比（帶正負號）：+1.23%；非有限值 — */
export function formatPct(v: number | null | undefined): string {
    if (v === undefined || v === null || !Number.isFinite(v)) return '—';
    const s = Math.abs(v).toFixed(2);
    return v > 0 ? `+${s}%` : v < 0 ? `−${s}%` : `${s}%`;
}

/** 數值正負 → 漲跌方向（顏色用 vars.color.up／down，文字另帶正負號） */
export function signDir(v: number | null | undefined): 'up' | 'down' | 'flat' {
    if (v === undefined || v === null || !Number.isFinite(v) || v === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
}

/** ISO 時間 → 台北時間 YYYY-MM-DD HH:mm:ss；無法解析回 '' */
export function formatTaipeiDateTime(iso: string | null | undefined): string {
    const t = Date.parse(String(iso ?? ''));
    if (!iso || !Number.isFinite(t)) return '';
    const d = new Date(t + 8 * 3600_000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** 帳戶鍵（類別:券商:帳號） */
export function accountKeyOf(account: { account_type: string; broker_id: string; account_id: string } | null | undefined): string {
    return account ? `${account.account_type}:${account.broker_id}:${account.account_id}` : '';
}
