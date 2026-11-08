// 前景憑證到期提醒（lib/ca-expiry-check.ts）：
// - 純函式：台北日期、玉山到期日格式、門檻（≤30 info、≤7 或過期 err；同 server-card caTone）、合併文字不含身分證字號與帳號。
// - 請求紀律（計數）：每次開啟最多一次、每個台北日最多一次（localStorage 只存日期）；永豐 health 最多 1 次、
//   帳戶頁 60 秒內讀過或讀取中就沿用（0 次）；玉山每位 person_id 最多 1 次 ca_expiretime；失敗不通知、當天不重試；
//   沒有帳戶、帳戶未載入（逾時放棄）0 次。
// lib 以 vi.mock 隔離；不連任何網路。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Acc = { account_type: string; person_id: string; broker_id: string; account_id: string; signed: boolean; username: string };
const m = vi.hoisted(() => ({
    state: { accounts: [] as unknown[], loaded: true, loadError: false, selectedStock: null, selectedFutures: null },
    listeners: new Set<() => void>(),
    fetchHealth: vi.fn(),
    fetchCaExpire: vi.fn(),
    notify: vi.fn(),
}));
vi.mock('../../lib/account-store', () => ({
    getAccountState: () => m.state,
    subscribeAccounts: (l: () => void) => {
        m.listeners.add(l);
        return () => { m.listeners.delete(l); };
    },
}));
vi.mock('../../lib/esun/order-mapping', () => ({ isEsunAccount: (a?: { broker_id: string } | null) => !!a && a.broker_id.startsWith('8840') }));
vi.mock('../../lib/shioaji', () => ({ fetchHealth: m.fetchHealth, fetchCaExpire: m.fetchCaExpire }));
vi.mock('../../lib/trade', () => ({ notify: m.notify }));

import {
    ACCOUNTS_WAIT_MS,
    CA_CHECK_DATE_KEY,
    caReminderNotice,
    esunFinding,
    HEALTH_FRESH_MS,
    parseExpireDate,
    resetCaExpiryCheckForTest,
    runCaExpiryCheck,
    shareHealth,
    sinopacFinding,
    taipeiDate,
} from './ca-expiry-check';

// 假資料（非真實帳號、身分證字號）
const sinopacStock: Acc = { account_type: 'S', person_id: 'Z999999999', broker_id: '9A95', account_id: '0000001', signed: true, username: '測試' };
const sinopacFut: Acc = { account_type: 'F', person_id: 'Z999999999', broker_id: 'F002000', account_id: '0000002', signed: true, username: '測試' };
const esunA1: Acc = { account_type: 'S', person_id: 'Y*******01', broker_id: '8840', account_id: '0000003', signed: true, username: '玉山證券' };
const esunA2: Acc = { account_type: 'S', person_id: 'Y*******01', broker_id: '8840-SIM', account_id: '0000004', signed: true, username: '玉山證券' };
const esunB: Acc = { account_type: 'S', person_id: 'X*******02', broker_id: '8840', account_id: '0000005', signed: true, username: '玉山證券' };
const IDS = ['Z999999999', 'Y*******01', 'X*******02', '0000001', '0000002', '0000003', '0000004', '0000005'];

/** 2026-11-08 10:00 台北 */
const NOW = new Date('2026-11-08T10:00:00+08:00').getTime();

let store: Map<string, string>;
let setItem: ReturnType<typeof vi.fn>;

function setAccounts(accounts: Acc[], loaded = true) {
    m.state = { ...m.state, accounts, loaded };
}
function emitAccounts() {
    m.listeners.forEach(l => l());
}
async function settle() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    store = new Map();
    setItem = vi.fn((k: string, v: string) => { store.set(k, String(v)); });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem, removeItem: (k: string) => store.delete(k) });
    m.listeners.clear();
    m.fetchHealth.mockReset().mockResolvedValue({ status: 'healthy', ca_expires_in_days: 120, ca_expired: false });
    m.fetchCaExpire.mockReset().mockResolvedValue({ person_id: 'x', expire_time: '2027/12/31' });
    m.notify.mockReset();
    setAccounts([sinopacStock]);
    resetCaExpiryCheckForTest();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('純函式', () => {
    it('taipeiDate：以台北日曆日計（UTC 16:00 已是台北隔天）', () => {
        expect(taipeiDate(new Date('2026-11-07T15:59:59Z').getTime())).toBe('2026-11-07');
        expect(taipeiDate(new Date('2026-11-07T16:00:00Z').getTime())).toBe('2026-11-08');
    });

    it('parseExpireDate：玉山常見格式；無法辨識或不存在的日期為 null', () => {
        expect(parseExpireDate('2027/12/31')).toBe('2027-12-31');
        expect(parseExpireDate('2027-12-31')).toBe('2027-12-31');
        expect(parseExpireDate('2030-01-01 08:00:00')).toBe('2030-01-01');
        expect(parseExpireDate('20271231')).toBe('2027-12-31');
        expect(parseExpireDate('2027/1/5')).toBe('2027-01-05');
        expect(parseExpireDate('')).toBeNull();
        expect(parseExpireDate(null)).toBeNull();
        expect(parseExpireDate('明年')).toBeNull();
        expect(parseExpireDate('2027-02-30')).toBeNull();
        expect(parseExpireDate('2027-13-01')).toBeNull();
    });

    it('永豐門檻同 server-card caTone：31 天不提醒、30 天提醒、已過期一定提醒；沒有欄位不提醒', () => {
        const today = '2026-11-08';
        expect(sinopacFinding({ ca_expires_in_days: 31, ca_expired: false }, today)).toBeNull();
        expect(sinopacFinding({ ca_expires_in_days: 30, ca_expired: false }, today)).toEqual({ broker: '永豐', expired: false, days: 30, date: '2026-12-08' });
        expect(sinopacFinding({ ca_expires_in_days: 3, ca_expired: true }, today)).toMatchObject({ expired: true });
        expect(sinopacFinding({ ca_expired: true }, today)).toEqual({ broker: '永豐', expired: true, days: null, date: null });
        expect(sinopacFinding({}, today)).toBeNull();
        expect(sinopacFinding(null, today)).toBeNull();
    });

    it('玉山：到期日與台北今天相差天數；今天到期為 0 天（未過期），昨天為已過期', () => {
        const today = '2026-11-08';
        expect(esunFinding('2026-12-09', today)).toBeNull();
        expect(esunFinding('2026-12-08', today)).toEqual({ broker: '玉山', expired: false, days: 30, date: '2026-12-08' });
        expect(esunFinding('2026/11/08', today)).toEqual({ broker: '玉山', expired: false, days: 0, date: '2026-11-08' });
        expect(esunFinding('2026-11-07 23:59:59', today)).toEqual({ broker: '玉山', expired: true, days: -1, date: '2026-11-07' });
        expect(esunFinding('', today)).toBeNull();
    });

    it('caReminderNotice：≤30 天 info、≤7 天或已過期 err；多券商合併一則，文字指向帳戶頁', () => {
        expect(caReminderNotice([])).toBeNull();
        const info = caReminderNotice([{ broker: '永豐', expired: false, days: 20, date: '2026-11-28' }])!;
        expect(info).toEqual({
            kind: 'info',
            title: '憑證即將到期',
            body: '永豐憑證剩 20 天（2026-11-28 到期）。憑證過期後無法下單，請到「帳戶頁」確認並更新憑證。',
        });
        expect(caReminderNotice([{ broker: '玉山', expired: false, days: 7, date: '2026-11-15' }])!.kind).toBe('err');
        expect(caReminderNotice([{ broker: '玉山', expired: false, days: 0, date: '2026-11-08' }])!.body).toContain('玉山憑證今天到期（2026-11-08）');
        const both = caReminderNotice([
            { broker: '永豐', expired: false, days: 25, date: '2026-12-03' },
            { broker: '玉山', expired: true, days: -2, date: '2026-11-06' },
        ])!;
        expect(both.kind).toBe('err');
        expect(both.title).toBe('憑證已過期');
        expect(both.body).toBe('永豐憑證剩 25 天（2026-12-03 到期）；玉山憑證已過期（2026-11-06）。憑證過期後無法下單，請到「帳戶頁」確認並更新憑證。');
    });
});

describe('執行與請求紀律', () => {
    it('永豐：1 次 health；剩 20 天 → notify 一次（info）；localStorage 只寫一次日期', async () => {
        m.fetchHealth.mockResolvedValue({ status: 'healthy', ca_expires_in_days: 20, ca_expired: false });
        await runCaExpiryCheck();
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);
        expect(m.fetchCaExpire).not.toHaveBeenCalled();
        expect(m.notify).toHaveBeenCalledTimes(1);
        expect(m.notify.mock.calls[0]![0]).toMatchObject({ kind: 'info', title: '憑證即將到期' });
        expect(setItem).toHaveBeenCalledTimes(1);
        expect(setItem).toHaveBeenCalledWith(CA_CHECK_DATE_KEY, '2026-11-08');
        expect([...store.values()].every(v => /^\d{4}-\d{2}-\d{2}$/.test(v))).toBe(true);
    });

    it('還很久才到期：不通知（請求照常 1 次）', async () => {
        await runCaExpiryCheck();
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);
        expect(m.notify).not.toHaveBeenCalled();
    });

    it('玉山：每位 person_id 只查 1 次（同一人兩個帳戶 → 1 次）；只經 fetchCaExpire 並帶玉山帳戶；永豐另 1 次 health', async () => {
        setAccounts([sinopacStock, sinopacFut, esunA1, esunA2, esunB]);
        m.fetchCaExpire.mockImplementation(async (pid: string) => ({ person_id: pid, expire_time: pid === esunA1.person_id ? '2026/11/12' : '2028/01/01' }));
        await runCaExpiryCheck();
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);
        expect(m.fetchCaExpire).toHaveBeenCalledTimes(2);
        expect(m.fetchCaExpire).toHaveBeenCalledWith(esunA1.person_id, esunA1);
        expect(m.fetchCaExpire).toHaveBeenCalledWith(esunB.person_id, esunB);
        expect(m.notify).toHaveBeenCalledTimes(1);
        const n = m.notify.mock.calls[0]![0] as { kind: string; title: string; body: string };
        expect(n).toEqual({ kind: 'err', title: '憑證即將到期', body: '玉山憑證剩 4 天（2026-11-12 到期）。憑證過期後無法下單，請到「帳戶頁」確認並更新憑證。' });
        for (const id of IDS) expect(`${n.title}${n.body}`).not.toContain(id);
    });

    it('只有玉山帳戶：不讀永豐 health', async () => {
        setAccounts([esunA1]);
        await runCaExpiryCheck();
        expect(m.fetchHealth).not.toHaveBeenCalled();
        expect(m.fetchCaExpire).toHaveBeenCalledTimes(1);
    });

    it('同一次開啟只跑一次；重新開啟（模組重設）同一個台北日 0 次；隔天再查', async () => {
        await runCaExpiryCheck();
        await runCaExpiryCheck();
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);
        resetCaExpiryCheckForTest();
        vi.setSystemTime(new Date('2026-11-08T23:59:00+08:00'));
        await runCaExpiryCheck();
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);
        resetCaExpiryCheckForTest();
        vi.setSystemTime(new Date('2026-11-09T00:01:00+08:00'));
        await runCaExpiryCheck();
        expect(m.fetchHealth).toHaveBeenCalledTimes(2);
        expect(store.get(CA_CHECK_DATE_KEY)).toBe('2026-11-09');
    });

    it('失敗：不通知、不丟出；當天重新開啟也不重試（日期在發出前已記下）', async () => {
        setAccounts([sinopacStock, esunA1]);
        m.fetchHealth.mockRejectedValue(new Error('503'));
        m.fetchCaExpire.mockRejectedValue(new Error('玉山下單服務未提供憑證效期查詢'));
        await expect(runCaExpiryCheck()).resolves.toBeUndefined();
        expect(m.notify).not.toHaveBeenCalled();
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);
        expect(m.fetchCaExpire).toHaveBeenCalledTimes(1);
        resetCaExpiryCheckForTest();
        await runCaExpiryCheck();
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);
        expect(m.fetchCaExpire).toHaveBeenCalledTimes(1);
    });

    it('一邊失敗另一邊照常：玉山失敗、永豐 5 天 → 仍通知（err）', async () => {
        setAccounts([sinopacStock, esunA1]);
        m.fetchHealth.mockResolvedValue({ status: 'healthy', ca_expires_in_days: 5, ca_expired: false });
        m.fetchCaExpire.mockRejectedValue(new Error('timeout'));
        await runCaExpiryCheck();
        expect(m.notify).toHaveBeenCalledTimes(1);
        expect(m.notify.mock.calls[0]![0]).toMatchObject({ kind: 'err', body: expect.stringContaining('永豐憑證剩 5 天（2026-11-13 到期）') });
    });

    it('沒有帳戶：0 次請求、不記日期', async () => {
        setAccounts([]);
        await runCaExpiryCheck();
        expect(m.fetchHealth).not.toHaveBeenCalled();
        expect(m.fetchCaExpire).not.toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();
    });

    it('帳戶尚未載入：等到載入完成才查；逾時（ACCOUNTS_WAIT_MS）放棄、0 次請求、不記日期', async () => {
        setAccounts([], false);
        const run = runCaExpiryCheck();
        await settle();
        expect(m.fetchHealth).not.toHaveBeenCalled();
        setAccounts([sinopacStock], true);
        emitAccounts();
        await run;
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);

        resetCaExpiryCheckForTest();
        store.clear();
        setItem.mockClear();
        setAccounts([], false);
        const late = runCaExpiryCheck();
        await settle();
        await vi.advanceTimersByTimeAsync(ACCOUNTS_WAIT_MS);
        await late;
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);
        expect(setItem).not.toHaveBeenCalled();
        expect(m.listeners.size).toBe(0);
    });

    it('帳戶頁剛讀過 health（60 秒內，已完成）：沿用、0 次新 GET', async () => {
        shareHealth(Promise.resolve({ status: 'healthy', ca_expires_in_days: 10, ca_expired: false } as never));
        await runCaExpiryCheck();
        expect(m.fetchHealth).not.toHaveBeenCalled();
        expect(m.notify).toHaveBeenCalledTimes(1);
    });

    it('帳戶頁的 health 讀取中：等它，不另發', async () => {
        let resolve!: (v: unknown) => void;
        shareHealth(new Promise(r => { resolve = r; }) as never);
        const run = runCaExpiryCheck();
        await settle();
        expect(m.fetchHealth).not.toHaveBeenCalled();
        resolve({ status: 'healthy', ca_expires_in_days: 2, ca_expired: false });
        await run;
        expect(m.fetchHealth).not.toHaveBeenCalled();
        expect(m.notify.mock.calls[0]![0]).toMatchObject({ kind: 'err' });
    });

    it('超過 HEALTH_FRESH_MS 的 health 不沿用（自己讀 1 次）；沿用的那次失敗（例如帳戶頁中止）才自己讀 1 次', async () => {
        shareHealth(Promise.resolve({ status: 'healthy' } as never), NOW - HEALTH_FRESH_MS);
        await runCaExpiryCheck();
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);

        resetCaExpiryCheckForTest();
        store.clear();
        shareHealth(Promise.reject(new DOMException('aborted', 'AbortError')) as never);
        await runCaExpiryCheck();
        expect(m.fetchHealth).toHaveBeenCalledTimes(2);
    });

    it('localStorage 讀寫丟例外：照常執行、不丟出', async () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('SecurityError'); },
            setItem: () => { throw new Error('QuotaExceededError'); },
        });
        m.fetchHealth.mockResolvedValue({ status: 'healthy', ca_expired: true });
        await expect(runCaExpiryCheck()).resolves.toBeUndefined();
        expect(m.fetchHealth).toHaveBeenCalledTimes(1);
        expect(m.notify.mock.calls[0]![0]).toMatchObject({ kind: 'err', title: '憑證已過期', body: expect.stringContaining('永豐憑證已過期。') });
    });
});
