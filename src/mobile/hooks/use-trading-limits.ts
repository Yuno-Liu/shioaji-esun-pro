// src/mobile/hooks/use-trading-limits.ts — 證券帳戶交易額度（規格 Phase 2）
//
// 下單面板的「剩餘交易額度」與帳戶頁的「交易額度」共用這一份快取：
// - 只查股票帳戶（account_type 'S'）；交易日 08:30–15:00 才有值，模擬環境回全 0（src/lib/shioaji.ts:1323）。
// - 模組層快取：同一帳戶 TRADING_LIMITS_TTL_MS 內重用結果；同時多個元件只發一次請求；
//   手動重新整理也至少間隔 TRADING_LIMITS_MIN_REFRESH_MS（玉山與永豐都有查詢頻率限制）。
// - 只讀取，不送任何委託；查詢經由 src/lib 的 fetchTradingLimits（玉山帳戶由 lib 自動轉往 bridge）。

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { fetchTradingLimits, type TradingLimits } from '../../lib/shioaji';
import type { Account } from '../../lib/types/portfolio';
import type { TicketCond } from '../lib/mobile-store';

export const TRADING_LIMITS_TTL_MS = 60_000;
export const TRADING_LIMITS_MIN_REFRESH_MS = 10_000;

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
        });
    target.inFlight = request;
    return request;
}

export function getTradingLimitsState(account: LimitsAccount | null | undefined): TradingLimitsState {
    if (!isStockAccount(account)) return EMPTY;
    return entries.get(tradingLimitsKey(account))?.state ?? EMPTY;
}

/** 證券帳戶的交易額度；account 為 null 或期貨帳戶時回空狀態且不發請求 */
export function useTradingLimits(account: LimitsAccount | null | undefined): TradingLimitsState & { refresh(): void } {
    const key = isStockAccount(account) ? tradingLimitsKey(account) : null;
    const state = useSyncExternalStore(subscribe, () => (key ? entries.get(key)?.state ?? EMPTY : EMPTY));
    useEffect(() => {
        if (isStockAccount(account)) void loadTradingLimits(account);
        // 只依帳戶鍵觸發（帳戶物件每次 render 可能是新的參考）
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

/** 上限與可用都是 0（模擬環境或非 08:30–15:00）：畫面應顯示「—」並說明，而不是「剩餘 0 元」 */
export function limitsLookEmpty(limits: TradingLimits | null | undefined): boolean {
    if (!limits) return true;
    return [limits.trading_limit, limits.margin_limit, limits.short_limit, limits.trading_available, limits.margin_available, limits.short_available]
        .every(v => !Number.isFinite(v) || v === 0);
}

/** 測試用：清空快取並可注入時鐘 */
export function resetTradingLimitsForTest(nextClock?: () => number): void {
    entries.clear();
    clock = nextClock ?? (() => Date.now());
    emit();
}
