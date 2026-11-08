// src/mobile/lib/ca-expiry-check.ts — 前景憑證到期提醒（不用推播服務；延遲載入：lib/deferred-modules.ts loadNoticeCenterSheet）
//
// 觸發：殼層閒置預載序列的最後一項（app.tsx DEFERRED_MODULES；省流量時也執行）import 通知中心面板的 chunk
// （components/notice-center-sheet 轉出本檔的 runCaExpiryCheck）並呼叫一次。不在首屏。
// 次數與快取（請求紀律）：
// - 每次開啟 App 最多跑一次（模組層 started）；每個台北日曆日最多一次：localStorage 只存日期字串
//   （CA_CHECK_DATE_KEY，不存任何身分證字號、帳號或結果；讀寫失敗只吞掉）。
// - 帳戶載入完成才判斷（最多等 ACCOUNTS_WAIT_MS，等不到就放棄、不記日期）；沒有帳戶不發任何請求。
// - 發出請求「之前」就記下日期：當天之後的開啟不再查（失敗也一樣），所以每天最多
//   1 次 GET /api/v1/health（有永豐帳戶時；帳戶頁 HEALTH_FRESH_MS 內讀過或讀取中就沿用，見 shareHealth）
//   ＋每位玉山使用者（person_id）1 次 GET /esun/ca_expiretime（只經 lib fetchCaExpire，不碰其他玉山端點）。
// - 失敗：不通知、不重試（下一個台北日再查）。
// 結果：任一券商已過期或剩 ≤30 天時 notify() 一次（多個券商合併成一則）：已過期或 ≤7 天為 'err'，其餘 'info'
// （門檻同帳戶頁 server-card 的 caTone）。文字只有券商名、剩餘天數與日期，不含 person_id 或帳號。

import { getAccountState, subscribeAccounts, type AccountState } from '../../lib/account-store';
import { isEsunAccount } from '../../lib/esun/order-mapping';
import { fetchCaExpire, fetchHealth } from '../../lib/shioaji';
import { notify, type AppNotice } from '../../lib/trade';
import type { Health } from '../../lib/types/health';
import type { Account } from '../../lib/types/portfolio';

// ---- health 短期共用（不發請求，只記錄別人發出的）----
// 帳戶頁「伺服器」卡（server-card.tsx）每次讀取都以 shareHealth 登記；這裡 HEALTH_FRESH_MS 內有登記（進行中或已完成）就沿用。
// 放在本檔而不是獨立小檔：兩邊都延遲載入，獨立成檔會多一個 chunk（首屏的預載對照表多一個檔名）。

/** 多久內的 health 算新鮮（以發出時間計） */
export const HEALTH_FRESH_MS = 60_000;

let lastHealth: { at: number; promise: Promise<Health> } | null = null;

/** 登記一次 health 讀取（回傳同一個 promise）；只吞掉未處理的 rejection，不影響呼叫端 */
export function shareHealth(promise: Promise<Health>, now: number = Date.now()): Promise<Health> {
    lastHealth = { at: now, promise };
    promise.catch(() => undefined);
    return promise;
}

/** HEALTH_FRESH_MS 內登記的讀取（進行中或已完成）；沒有則 null */
export function recentHealth(now: number = Date.now()): Promise<Health> | null {
    const age = lastHealth ? now - lastHealth.at : -1;
    return lastHealth && age >= 0 && age < HEALTH_FRESH_MS ? lastHealth.promise : null;
}

/** localStorage：上次檢查的台北日期（YYYY-MM-DD），只存日期 */
export const CA_CHECK_DATE_KEY = 'sj-mobile-ca-check-date';
/** ≤ 這麼多天提醒（info） */
export const CA_WARN_DAYS = 30;
/** ≤ 這麼多天或已過期為錯誤（err） */
export const CA_DANGER_DAYS = 7;
/** 等帳戶載入的上限 */
export const ACCOUNTS_WAIT_MS = 60_000;

const DAY_MS = 86_400_000;
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

export interface CaFinding {
    broker: '永豐' | '玉山';
    expired: boolean;
    /** 剩餘天數（0＝今天到期）；未知為 null */
    days: number | null;
    /** 到期日 YYYY-MM-DD；未知為 null */
    date: string | null;
}

/** 台北日曆日 YYYY-MM-DD（台灣沒有日光節約） */
export function taipeiDate(now: number): string {
    return new Date(now + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

function dayNumber(date: string): number {
    return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS;
}

function addDays(date: string, days: number): string {
    return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** 玉山 ca_expiretime（'2027/12/31'、'2027-12-31'、'2027-12-31 23:59:59'、'20271231'）→ YYYY-MM-DD；無法辨識為 null */
export function parseExpireDate(raw: string | null | undefined): string | null {
    const s = String(raw ?? '').trim();
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s) ?? /^(\d{4})(\d{2})(\d{2})/.exec(s);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const date = `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    // 不存在的日期（例如 02-30）會被 Date.UTC 進位，進位後不同就不採用
    return new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10) === date ? date : null;
}

const needsNotice = (f: CaFinding) => f.expired || (f.days !== null && f.days <= CA_WARN_DAYS);

/** 永豐：health.ca_expired／ca_expires_in_days（門檻同 server-card caTone）；不需提醒為 null */
export function sinopacFinding(health: Pick<Health, 'ca_expired' | 'ca_expires_in_days'> | null | undefined, today: string): CaFinding | null {
    if (!health) return null;
    const days = typeof health.ca_expires_in_days === 'number' && Number.isFinite(health.ca_expires_in_days) ? Math.floor(health.ca_expires_in_days) : null;
    const f: CaFinding = { broker: '永豐', expired: health.ca_expired === true || (days !== null && days < 0), days, date: days !== null ? addDays(today, days) : null };
    return needsNotice(f) ? f : null;
}

/** 玉山：到期日與今天（台北）相差的天數；不需提醒或無法辨識為 null */
export function esunFinding(expireTime: string | null | undefined, today: string): CaFinding | null {
    const date = parseExpireDate(expireTime);
    if (!date) return null;
    const days = dayNumber(date) - dayNumber(today);
    const f: CaFinding = { broker: '玉山', expired: days < 0, days, date };
    return needsNotice(f) ? f : null;
}

function describe(f: CaFinding): string {
    if (f.expired) return `${f.broker}憑證已過期${f.date ? `（${f.date}）` : ''}`;
    if (f.days === 0) return `${f.broker}憑證今天到期（${f.date}）`;
    return `${f.broker}憑證剩 ${f.days} 天（${f.date} 到期）`;
}

/** 合併成一則通知；沒有需要提醒的為 null */
export function caReminderNotice(findings: readonly CaFinding[]): AppNotice | null {
    if (!findings.length) return null;
    const expired = findings.some(f => f.expired);
    const urgent = expired || findings.some(f => f.days !== null && f.days <= CA_DANGER_DAYS);
    return {
        kind: urgent ? 'err' : 'info',
        title: expired ? '憑證已過期' : '憑證即將到期',
        body: `${findings.map(describe).join('；')}。憑證過期後無法下單，請到「帳戶頁」確認並更新憑證。`,
    };
}

function readCheckedDate(): string | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(CA_CHECK_DATE_KEY);
    } catch {
        return null;
    }
}

function writeCheckedDate(date: string): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(CA_CHECK_DATE_KEY, date);
    } catch {
        // 無法寫入（私密模式等）：本次照常，下次開啟可能再查一次
    }
}

/** 帳戶載入完成的狀態；ACCOUNTS_WAIT_MS 內沒載入完成為 null */
function accountsLoaded(): Promise<AccountState | null> {
    const now = getAccountState();
    if (now.loaded) return Promise.resolve(now);
    return new Promise(resolve => {
        let off = () => {};
        const timer = setTimeout(() => { off(); resolve(null); }, ACCOUNTS_WAIT_MS);
        off = subscribeAccounts(() => {
            const s = getAccountState();
            if (!s.loaded) return;
            clearTimeout(timer);
            off();
            resolve(s);
        });
    });
}

/** 帳戶頁剛讀過（或讀取中）就沿用；沿用的那次失敗（例如帳戶頁卸載而中止）才自己讀一次 */
async function readHealth(): Promise<Health> {
    const shared = recentHealth();
    if (shared) {
        try {
            return await shared;
        } catch {
            // 落到自己讀一次
        }
    }
    return shareHealth(fetchHealth());
}

let started = false;

/** 每次開啟 App 最多執行一次；任何失敗都不通知、不丟出 */
export async function runCaExpiryCheck(): Promise<void> {
    if (started) return;
    started = true;
    try {
        const today = taipeiDate(Date.now());
        if (readCheckedDate() === today) return;
        const state = await accountsLoaded();
        if (!state) return;
        const sinopac = state.accounts.some(a => !isEsunAccount(a));
        const esunPeople = new Map<string, Account>();
        for (const a of state.accounts) {
            if (isEsunAccount(a) && !esunPeople.has(a.person_id ?? '')) esunPeople.set(a.person_id ?? '', a);
        }
        if (!sinopac && esunPeople.size === 0) return;
        writeCheckedDate(today);
        const [health, ...esun] = await Promise.allSettled([
            sinopac ? readHealth() : Promise.resolve(null),
            ...[...esunPeople].map(([personId, account]) => fetchCaExpire(personId, account)),
        ]);
        const findings: CaFinding[] = [];
        if (health.status === 'fulfilled') {
            const f = sinopacFinding(health.value as Health | null, today);
            if (f) findings.push(f);
        }
        for (const r of esun) {
            if (r.status !== 'fulfilled') continue;
            const f = esunFinding((r.value as { expire_time?: string } | null)?.expire_time, today);
            if (f) findings.push(f);
        }
        const notice = caReminderNotice(findings);
        if (notice) notify(notice);
    } catch {
        // 靜默：下一個台北日再查
    }
}

/** 測試用：回到尚未執行、清掉 health 共用 */
export function resetCaExpiryCheckForTest(): void {
    started = false;
    lastHealth = null;
}
