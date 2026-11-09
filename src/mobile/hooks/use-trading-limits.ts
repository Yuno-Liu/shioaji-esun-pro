// src/mobile/hooks/use-trading-limits.ts — 證券帳戶交易額度（規格 Phase 2）
//
// 下單面板的「剩餘交易額度」與帳戶頁的「交易額度」共用這一份快取：
// - 只查股票帳戶（account_type 'S'）；交易日 08:30–15:00 才有值，模擬環境回全 0（src/lib/shioaji.ts:1323）。
// - 模組層快取：同一帳戶 TRADING_LIMITS_TTL_MS 內重用結果；同時多個元件只發一次請求；
//   手動重新整理也至少間隔 TRADING_LIMITS_MIN_REFRESH_MS（玉山與永豐都有查詢頻率限制）。
// - 只讀取，不送任何委託；查詢經由 src/lib 的 fetchTradingLimits（玉山帳戶由 lib 自動轉往 bridge）。
// - 永豐即時更新（委託事件後自動重查）：事件來源是共用交易狀態 useTradingState().trades（委託查詢＋SSE 回報投影，
//   含新委託回應、刪改單、成交；只讀）。永豐證券帳戶的委託列有新增或狀態／數量／價格改變 → 排程重查「該帳戶」：
//   - 去抖 LIMITS_EVENT_DEBOUNCE_MS（連續事件合併成一次；持續不斷時最晚在第一筆事件後 LIMITS_EVENT_MAX_WAIT_MS）；
//   - 絕不違反 TRADING_LIMITS_MIN_REFRESH_MS：仍在最短間隔內就排在最早允許的時間；
//   - 事件之後已經有任何一次查詢開始（TTL、手動重新整理）就視為已涵蓋，不再補查；
//   - 只查有畫面正在顯示的帳戶（useTradingLimits 掛載中）；沒有顯示時記下，下次顯示時補查一次；
//   - 只在頁面可見時查；隱藏期間的事件記下，回到可見時補查一次。
//   期貨帳戶與玉山帳戶不因事件重查（玉山不另發請求，剩餘以 hooks/use-esun-limit-estimate 就地估算）。
//   第一次讀到委託（queries.orders.updatedAt 由 null 變有值）只當基準，不觸發。

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { isEsunAccount } from '../../lib/esun/order-mapping';
import { fetchTradingLimits, type TradingLimits } from '../../lib/shioaji';
import { useTradingState } from '../../lib/trading-state';
import type { AccountedTrade } from '../../lib/types/order';
import type { Account } from '../../lib/types/portfolio';
import type { TicketCond } from '../lib/mobile-store';

export const TRADING_LIMITS_TTL_MS = 60_000;
export const TRADING_LIMITS_MIN_REFRESH_MS = 10_000;
/** 委託事件後的去抖（連續事件合併） */
export const LIMITS_EVENT_DEBOUNCE_MS = 2_000;
/** 事件持續不斷時，最晚在第一筆事件後多久重查（仍受最短間隔限制） */
export const LIMITS_EVENT_MAX_WAIT_MS = 6_000;

export interface TradingLimitsState {
    data: TradingLimits | null;
    error: string | null;
    loading: boolean;
    /** 最後一次成功取得的時間（ms）；null＝尚未取得 */
    updatedAt: number | null;
}

type LimitsAccount = Pick<Account, 'broker_id' | 'account_id' | 'account_type'>;

const EMPTY: TradingLimitsState = { data: null, error: null, loading: false, updatedAt: null };

interface Entry {
    state: TradingLimitsState;
    inFlight: Promise<void> | null;
    attemptedAt: number | null;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let clock: () => number = () => Date.now();

export function tradingLimitsKey(account: Pick<Account, 'broker_id' | 'account_id'>): string {
    return `${account.broker_id}:${account.account_id}`;
}

function isStockAccount(account: LimitsAccount | null | undefined): account is LimitsAccount {
    return !!account && account.account_type === 'S';
}

function emit(): void {
    listeners.forEach(l => l());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/**
 * 讀取（或重用快取的）交易額度。force＝使用者手動重新整理（仍受最短間隔限制）。
 * 非證券帳戶直接略過。回傳的 promise 不會 reject（錯誤寫進 state.error）。
 */
export function loadTradingLimits(account: LimitsAccount, opts: { force?: boolean } = {}): Promise<void> {
    if (!isStockAccount(account)) return Promise.resolve();
    const key = tradingLimitsKey(account);
    let entry = entries.get(key);
    if (!entry) {
        entry = { state: EMPTY, inFlight: null, attemptedAt: null };
        entries.set(key, entry);
    }
    if (entry.inFlight) return entry.inFlight;
    const since = entry.attemptedAt === null ? Infinity : clock() - entry.attemptedAt;
    const minGap = opts.force ? TRADING_LIMITS_MIN_REFRESH_MS : TRADING_LIMITS_TTL_MS;
    if (since < minGap) return Promise.resolve();
    const target = entry;
    target.attemptedAt = clock();
    target.state = { ...target.state, loading: true, error: null };
    emit();
    const request = fetchTradingLimits({ broker_id: account.broker_id, account_id: account.account_id })
        .then(data => {
            target.state = { data, error: null, loading: false, updatedAt: clock() };
        })
        .catch((err: unknown) => {
            target.state = { ...target.state, loading: false, error: err instanceof Error ? err.message : String(err) };
        })
        .finally(() => {
            target.inFlight = null;
            emit();
            if (pendingRefresh.size > 0) scheduleEventRefresh();
        });
    target.inFlight = request;
    return request;
}

export function getTradingLimitsState(account: LimitsAccount | null | undefined): TradingLimitsState {
    if (!isStockAccount(account)) return EMPTY;
    return entries.get(tradingLimitsKey(account))?.state ?? EMPTY;
}

// ---- 永豐：委託事件後自動重查 ----

interface PendingRefresh {
    account: LimitsAccount;
    firstAt: number;
    lastAt: number;
}

/** 有未涵蓋委託事件的帳戶 */
const pendingRefresh = new Map<string, PendingRefresh>();
/** 每個帳戶目前掛載中的 useTradingLimits 數量 */
const consumers = new Map<string, number>();
/** 上次看到的委託列指紋（帳戶鍵|委託 id → 狀態指紋）；null＝尚未建立基準 */
let seenTrades: Map<string, string> | null = null;
let seenRef: readonly AccountedTrade[] | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityTarget: Document | null = null;

/** 會因委託事件自動重查的帳戶：永豐（非玉山）證券帳戶 */
export function autoRefreshEligible(account: Partial<LimitsAccount> | null | undefined): account is LimitsAccount {
    return !!account && account.account_type === 'S' && !!account.broker_id && !!account.account_id && !isEsunAccount(account as LimitsAccount);
}

function pageVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function tradeFingerprint(t: AccountedTrade): string {
    const s = t.status;
    return [s.status, s.deal_quantity, s.cancel_quantity, s.modified_price, t.order.price, t.order.quantity, s.deals?.length ?? 0].join('|');
}

/** 記下一筆委託事件（新委託、刪改單、成交）並排程重查該帳戶 */
export function noteLimitsOrderEvent(account: LimitsAccount): void {
    if (!autoRefreshEligible(account)) return;
    const key = tradingLimitsKey(account);
    const now = clock();
    const prev = pendingRefresh.get(key);
    if (prev) prev.lastAt = now;
    else pendingRefresh.set(key, { account, firstAt: now, lastAt: now });
    scheduleEventRefresh();
}

/**
 * 由共用交易狀態的委託清單找出永豐證券帳戶的委託事件。同一份清單（同一個參考）只看一次；
 * 委託尚未讀到（ordersLoaded false）時不建立基準，第一次讀到的清單只當基準。
 */
export function observeLimitsTrades(trades: readonly AccountedTrade[], ordersLoaded: boolean): void {
    if (trades === seenRef && seenTrades !== null) return;
    if (!ordersLoaded) {
        seenRef = null;
        seenTrades = null;
        return;
    }
    seenRef = trades;
    const prev = seenTrades;
    const next = new Map<string, string>();
    const changed = new Map<string, LimitsAccount>();
    for (const t of trades) {
        const account = (t.account ?? t.order?.account) as LimitsAccount | undefined;
        if (!autoRefreshEligible(account) || !t.order?.id || !t.status) continue;
        const key = tradingLimitsKey(account);
        const id = `${key}|${t.order.id}`;
        const fp = tradeFingerprint(t);
        next.set(id, fp);
        if (prev && prev.get(id) !== fp) changed.set(key, account);
    }
    seenTrades = next;
    changed.forEach(account => noteLimitsOrderEvent(account));
}

function onVisibilityChange(): void {
    if (pageVisible() && pendingRefresh.size > 0) scheduleEventRefresh();
}

function bindVisibility(): void {
    if (visibilityTarget || typeof document === 'undefined') return;
    visibilityTarget = document;
    document.addEventListener('visibilitychange', onVisibilityChange);
}

/** 依待處理事件排定（或立即執行）重查；頁面隱藏時不排，回到可見時再排 */
function scheduleEventRefresh(): void {
    if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
    if (!pageVisible()) return;
    const now = clock();
    let next = Infinity;
    for (const [key, p] of [...pendingRefresh]) {
        const entry = entries.get(key);
        // 事件之後已有查詢開始（TTL、手動、或先前的自動重查）：已涵蓋
        if (entry && entry.attemptedAt !== null && entry.attemptedAt > p.lastAt) {
            pendingRefresh.delete(key);
            continue;
        }
        if ((consumers.get(key) ?? 0) === 0 || entry?.inFlight) continue;
        const debounced = Math.min(p.lastAt + LIMITS_EVENT_DEBOUNCE_MS, p.firstAt + LIMITS_EVENT_MAX_WAIT_MS);
        const allowed = entry && entry.attemptedAt !== null ? entry.attemptedAt + TRADING_LIMITS_MIN_REFRESH_MS : -Infinity;
        const due = Math.max(debounced, allowed);
        if (due <= now) {
            pendingRefresh.delete(key);
            void loadTradingLimits(p.account, { force: true });
        } else next = Math.min(next, due);
    }
    if (next !== Infinity) refreshTimer = setTimeout(scheduleEventRefresh, next - now);
}

/** 證券帳戶的交易額度；account 為 null 或期貨帳戶時回空狀態且不發請求 */
export function useTradingLimits(account: LimitsAccount | null | undefined): TradingLimitsState & { refresh(): void } {
    const key = isStockAccount(account) ? tradingLimitsKey(account) : null;
    const state = useSyncExternalStore(subscribe, () => (key ? entries.get(key)?.state ?? EMPTY : EMPTY));
    const { trades, queries } = useTradingState();
    const ordersLoaded = queries?.orders?.updatedAt !== null && queries?.orders?.updatedAt !== undefined;
    useEffect(() => {
        if (isStockAccount(account)) void loadTradingLimits(account);
        // 只依帳戶鍵觸發（帳戶物件每次 render 可能是新的參考）
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    // 委託事件 → 永豐帳戶自動重查（同一份清單只看一次）
    useEffect(() => {
        if (trades) observeLimitsTrades(trades, ordersLoaded);
    }, [trades, ordersLoaded]);
    // 掛載中的帳戶才會被自動重查；掛載時補查先前記下的事件
    useEffect(() => {
        if (!key || !autoRefreshEligible(account)) return;
        bindVisibility();
        consumers.set(key, (consumers.get(key) ?? 0) + 1);
        scheduleEventRefresh();
        return () => {
            const n = (consumers.get(key) ?? 1) - 1;
            if (n > 0) consumers.set(key, n);
            else consumers.delete(key);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    const refresh = useCallback(() => {
        if (isStockAccount(account)) void loadTradingLimits(account, { force: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return { ...state, refresh };
}

/**
 * 依信用條件取「剩餘」額度（元）：現股 trading_available、融資 margin_available、融券 short_available。
 * 沒有資料回 null；模擬環境或非交易時段 lib 會回全 0，呼叫端應把「上限也是 0」視為無資料（見 limitsLookEmpty）。
 */
export function availableLimitFor(limits: TradingLimits | null | undefined, cond: TicketCond = 'Cash'): number | null {
    if (!limits) return null;
    const value = cond === 'MarginTrading' ? limits.margin_available : cond === 'ShortSelling' ? limits.short_available : limits.trading_available;
    return Number.isFinite(value) ? value : null;
}

/**
 * 玉山 get_trade_status 只提供額度「上限」；lib 在沒有可用／已用欄位時把可用填成上限、已用填 0
 * （src/lib/esun/order-mapping.ts fromEsunTradeStatusToLimits）。玉山帳戶的畫面只能稱為「上限」，
 * 不可顯示成「剩餘」或「可用」。
 */
export function limitsAreCapsOnly(account: Pick<Account, 'broker_id'> | null | undefined): boolean {
    return isEsunAccount(account);
}

/** 上限與可用都是 0（模擬環境或非 08:30–15:00）：畫面應顯示「—」並說明，而不是「剩餘 0 元」 */
export function limitsLookEmpty(limits: TradingLimits | null | undefined): boolean {
    if (!limits) return true;
    return [limits.trading_limit, limits.margin_limit, limits.short_limit, limits.trading_available, limits.margin_available, limits.short_available]
        .every(v => !Number.isFinite(v) || v === 0);
}

/** 測試用：清空快取並可注入時鐘 */
export function resetTradingLimitsForTest(nextClock?: () => number): void {
    entries.clear();
    pendingRefresh.clear();
    consumers.clear();
    seenTrades = null;
    seenRef = null;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    visibilityTarget?.removeEventListener('visibilitychange', onVisibilityChange);
    visibilityTarget = null;
    clock = nextClock ?? (() => Date.now());
    emit();
}
