// src/mobile/lib/account-settlements.ts — 帳戶頁交割款（自 routes/account-page.tsx 拆出，行為不變）
//
// 交割款＝src/lib/shioaji fetchSettlements（玉山帳戶在 src/lib 內部改走 esunTradeService.fetchSettlements）。
// 不自行輪詢（§9.1：玉山交割 25 秒快取、3 次／分）；SETTLEMENT_REUSE_MS 內重用上次結果，手動更新也受同一間隔限制。

import { useEffect, useReducer, useRef, useState } from 'react';
import { fetchSettlements, type Settlement } from '../../lib/shioaji';
import type { Account } from '../../lib/types/portfolio';
import { accountKeyOf } from './account-format';

/** 交割款：這段時間內重用上次結果（玉山交割 25 秒快取、3 次／分；§9.1） */
export const SETTLEMENT_REUSE_MS = 30_000;

const settlementCache = new Map<string, { rows: Settlement[]; at: number }>();

/** 測試用：清除交割款快取 */
export function resetSettlementCacheForTest(): void {
    settlementCache.clear();
}

export interface SettlementState {
    key: string;
    rows: Settlement[] | null;
    at: number | null;
    loading: boolean;
    error: string | null;
}

export function useSettlements(account: Account | null): SettlementState & { refresh: () => void } {
    const key = accountKeyOf(account);
    const accountRef = useRef(account);
    accountRef.current = account;
    const [state, setState] = useState<SettlementState>(() => {
        const c = settlementCache.get(key);
        return { key, rows: c?.rows ?? null, at: c?.at ?? null, loading: false, error: null };
    });
    const [nonce, bump] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
        const acc = accountRef.current;
        const cached = settlementCache.get(key);
        if (!acc || !key) {
            setState({ key, rows: null, at: null, loading: false, error: null });
            return;
        }
        if (cached && Date.now() - cached.at < SETTLEMENT_REUSE_MS) {
            setState({ key, rows: cached.rows, at: cached.at, loading: false, error: null });
            return;
        }
        let active = true;
        setState(s => ({
            key,
            rows: s.key === key ? s.rows : cached?.rows ?? null,
            at: s.key === key ? s.at : cached?.at ?? null,
            loading: true,
            error: null,
        }));
        fetchSettlements(acc).then(
            rows => {
                const at = Date.now();
                settlementCache.set(key, { rows, at });
                if (active) setState({ key, rows, at, loading: false, error: null });
            },
            (e: unknown) => {
                if (active) setState(s => ({ ...s, key, loading: false, error: e instanceof Error && e.message ? e.message : '交割款查詢失敗' }));
            },
        );
        return () => { active = false; };
    }, [key, nonce]);

    const current = state.key === key ? state : { key, rows: null, at: null, loading: false, error: null };
    return { ...current, refresh: bump };
}
