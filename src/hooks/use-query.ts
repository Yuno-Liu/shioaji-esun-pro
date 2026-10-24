import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getApiBase } from '../lib/runtime';
import { createAccountQuery } from '../lib/account-query';
import type { Account } from '../lib/types/portfolio';

interface Result<T> { data?: T; error: string | null; loading: boolean; updatedAt: number | null }
interface Entry { result: Result<unknown>; listeners: Set<() => void>; pending?: Promise<void>; attempted: boolean; nextAt: number; version: number; pendingVersion?: number; accountScoped?: boolean }
const cache = new Map<string, Entry>();
function entryFor(key: string) {
    let entry = cache.get(key);
    if (!entry) {
        entry = { result: { error: null, loading: false, updatedAt: null }, listeners: new Set(), attempted: false, nextAt: 0, version: 0 };
        cache.set(key, entry);
    }
    return entry;
}
const empty: Result<unknown> = { error: null, loading: false, updatedAt: null };

/** Session snapshot shared by scope; only first use and manual refresh query.
 * No focus/reconnect/timer refresh, no queued clicks, and failed refreshes keep data.
 */
export function useQuery<T>(fetcher: () => Promise<T>, key: string, enabled = true, accounts?: readonly Account[]) {
    const accountScope = accounts?.map(a => `${a.account_type}:${a.broker_id}:${a.account_id}`).join('|');
    const entry = entryFor(`${getApiBase()}:${key}`);
    if (accounts) entry.accountScoped = true;
    const result = useSyncExternalStore(useCallback((listener: () => void) => {
        entry.listeners.add(listener);
        return () => { entry.listeners.delete(listener); };
    }, [entry]), () => enabled ? entry.result : empty) as Result<T>;
    const refresh = useCallback((): Promise<void> => {
        if (!enabled) return Promise.resolve();
        if (entry.pending && entry.pendingVersion === entry.version) return entry.pending;
        if (Date.now() < entry.nextAt) return Promise.resolve();
        entry.attempted = true;
        const version = entry.version;
        const emit = () => entry.listeners.forEach(l => l());
        entry.result = { ...entry.result, error: null, loading: true };
        emit();
        // Start on a microtask so synchronous throws also reach the error path.
        const query = accounts && createAccountQuery();
        const assertCurrent = () => {
            query?.assertCurrent();
            for (const account of accounts ?? []) query!.account(account.account_type as 'S' | 'F', account);
        };
        const pending: Promise<void> = entry.pending = Promise.resolve().then(() => {
            assertCurrent();
            return fetcher();
        }).then(data => {
            assertCurrent();
            if (entry.version !== version) return; // invalidated meanwhile: the newer read owns the entry
            entry.result = { data, error: null, loading: false, updatedAt: Date.now() };
        }).catch(error => {
            if (entry.version !== version) return;
            entry.result = { ...entry.result, loading: false, error: error instanceof Error ? error.message : String(error) };
        }).finally(() => { if (entry.pending === pending) entry.pending = undefined; entry.nextAt = Date.now() + 1500; emit(); });
        entry.pendingVersion = version;
        return entry.pending;
    }, [entry, enabled, fetcher, accountScope]);
    useEffect(() => { if (enabled && !entry.attempted) void refresh(); }, [entry, entry.version, enabled, refresh]);
    return { ...result, refresh };
}

/** Fork（頂欄帳戶切換）：讓已掛載的帳務查詢（建立時帶 accounts）立即重新查詢。
 *  行情等非帳務查詢不受影響；進行中的舊請求結果一律丟棄，不會覆蓋新結果。 */
export function invalidateAllQueries(): void {
    for (const entry of cache.values()) {
        if (!entry.accountScoped) continue;
        entry.attempted = false;
        entry.nextAt = 0;
        entry.version++;
        entry.result = { ...entry.result };
        entry.listeners.forEach((l) => l());
    }
}
