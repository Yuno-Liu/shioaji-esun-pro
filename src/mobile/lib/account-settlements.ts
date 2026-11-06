// src/mobile/lib/account-settlements.ts — 帳戶頁交割款（自 routes/account-page.tsx 拆出，行為不變）
//
// 交割款＝src/lib/shioaji fetchSettlements（玉山帳戶在 src/lib 內部改走 esunTradeService.fetchSettlements）。
// 不自行輪詢（§9.1：玉山交割 25 秒快取、3 次／分）；SETTLEMENT_REUSE_MS 內重用上次結果，手動更新也受同一間隔限制。
// 冷卻以「發出查詢的時間」（settlementAttempts，成功或失敗都算；同 account-on-demand 的 attemptedAt）計算：
// 失敗後不能連按，切回帳戶頁也不會在冷卻內再查（顯示上次的錯誤）；卸載時仍在查詢的請求，重新掛載後接著等它的結果。

import { useEffect, useReducer, useRef, useState } from 'react';
import { fetchSettlements, type Settlement } from '../../lib/shioaji';
import type { Account } from '../../lib/types/portfolio';
import { accountKeyOf } from './account-format';

/** 交割款：這段時間內重用上次結果（玉山交割 25 秒快取、3 次／分；§9.1） */
export const SETTLEMENT_REUSE_MS = 30_000;

const settlementCache = new Map<string, { rows: Settlement[]; at: number }>();

interface SettlementAttempt {
    /** 發出查詢的時間（ms） */
    at: number;
    /** 最後一次失敗的訊息；成功為 null */
    error: string | null;
    inFlight: Promise<void> | null;
}
const settlementAttempts = new Map<string, SettlementAttempt>();

/** 測試用：清除交割款快取 */
export function resetSettlementCacheForTest(): void {
    settlementCache.clear();
    settlementAttempts.clear();
}

export interface SettlementState {
    key: string;
    rows: Settlement[] | null;
    at: number | null;
    loading: boolean;
    error: string | null;
    /** 最後一次發出查詢的時間（成功或失敗）；冷卻以它計算。null＝這段時間內沒查過 */
    attemptedAt: number | null;
}

/** 冷卻剩餘毫秒（0＝可再查） */
export function settlementCooldownMs(attemptedAt: number | null, now: number): number {
    return attemptedAt === null ? 0 : Math.min(SETTLEMENT_REUSE_MS, Math.max(0, SETTLEMENT_REUSE_MS - (now - attemptedAt)));
}

function errorText(e: unknown): string {
    return e instanceof Error && e.message ? e.message : '交割款查詢失敗';
}

export function useSettlements(account: Account | null): SettlementState & { refresh: () => void } {
    const key = accountKeyOf(account);
    const accountRef = useRef(account);
    accountRef.current = account;
    const [state, setState] = useState<SettlementState>(() => {
        const c = settlementCache.get(key);
        return { key, rows: c?.rows ?? null, at: c?.at ?? null, loading: false, error: null, attemptedAt: settlementAttempts.get(key)?.at ?? null };
    });
    const [nonce, bump] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
        const acc = accountRef.current;
        if (!acc || !key) {
            setState({ key, rows: null, at: null, loading: false, error: null, attemptedAt: null });
            return;
        }
        let active = true;
        const settled = () => {
            if (!active) return;
            const c = settlementCache.get(key);
            const a = settlementAttempts.get(key);
            setState({ key, rows: c?.rows ?? null, at: c?.at ?? null, loading: false, error: a?.error ?? null, attemptedAt: a?.at ?? null });
        };
        const cached = settlementCache.get(key);
        const attempt = settlementAttempts.get(key);
        const now = Date.now();
        // 冷卻中（成功或失敗都算）：不再查；仍在查詢中就接著等它的結果
        const recentAttempt = attempt && now - attempt.at < SETTLEMENT_REUSE_MS ? attempt : null;
        if (recentAttempt || (cached && now - cached.at < SETTLEMENT_REUSE_MS)) {
            if (recentAttempt?.inFlight) {
                setState({ key, rows: cached?.rows ?? null, at: cached?.at ?? null, loading: true, error: null, attemptedAt: recentAttempt.at });
                void recentAttempt.inFlight.then(settled);
            } else {
                settled();
            }
            return () => { active = false; };
        }
        const record: SettlementAttempt = { at: now, error: null, inFlight: null };
        settlementAttempts.set(key, record);
        setState(s => ({
            key,
            rows: s.key === key ? s.rows : cached?.rows ?? null,
            at: s.key === key ? s.at : cached?.at ?? null,
            loading: true,
            error: null,
            attemptedAt: now,
        }));
        record.inFlight = fetchSettlements(acc).then(
            rows => {
                settlementCache.set(key, { rows, at: Date.now() });
                record.error = null;
            },
            (e: unknown) => {
                record.error = errorText(e);
            },
        ).finally(() => {
            record.inFlight = null;
        }).then(settled);
        return () => { active = false; };
    }, [key, nonce]);

    const current = state.key === key ? state : { key, rows: null, at: null, loading: false, error: null, attemptedAt: null };
    return { ...current, refresh: bump };
}
