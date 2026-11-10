// src/lib/account-identity.ts — fork：帳戶身分比對與彈出視窗識別碼（輕量模組）。
// 與上游 flash-account.ts 的 accountMatches／newPopoutWindowId 同一語意；獨立出來，
// 讓 tauri（boot 會載入）、order-route 與手機版不必為了這兩個小函式載入閃電下單模組
// （flash-account → flash-trigger → trigger-credit／bracket-rules），手機首屏預算有限。
// 兩邊語意必須一致：account-identity.test.ts 逐案比對上游實作。
import type { Account } from './types/portfolio';

type AccountIdentity = Pick<Account, 'account_type' | 'broker_id' | 'account_id'>;

/** 同一帳戶：帳戶類型、券商代號、帳號都相同；任一方缺漏或沒有券商代號／帳號一律不算 */
export function accountMatches(a: AccountIdentity | null | undefined, b: AccountIdentity | null | undefined): boolean {
    return !!a && !!b && !!a.broker_id && !!a.account_id && a.account_type === b.account_type
        && a.broker_id === b.broker_id && a.account_id === b.account_id;
}

/** 新彈出視窗的識別碼（只需唯一，不需和上游同一格式） */
export function newPopoutWindowId(): string {
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
