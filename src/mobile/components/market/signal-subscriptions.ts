// src/mobile/components/market/signal-subscriptions.ts — 盤中異動的掃描訊號訂閱（每個「規則 × 市場」一個鍵）
//
// 觸發：只在「市場」分頁的「盤中異動」分段掛載、且文件在前景時，對目前篩選的每個鍵各呼叫 1 次 subscribeMarketSignal。
// - 篩選改變：只送差異（新增的鍵 subscribe 1 次、移除的鍵 unsubscribe 1 次），其餘不動。
// - 離開分段、切走分頁或 App 退到背景：全部退訂；回前景再依目前篩選重新訂閱（每鍵 1 次）。
// - 失敗：不自動重試（lib 對暫時性錯誤的內建退避除外，見 lib/shioaji updateCapabilitySubscription）；
//   只有使用者按［重試］時，對失敗的鍵各再送 1 次 subscribe。
// - 本頁內每個鍵最多持有 1 份（頁內 ref-count＝0 或 1）；同一瀏覽器內的共用由 lib 的 capability ref-count 負責。
// - 失敗的鍵不退訂（lib 沒有為它加 ref-count，退訂會扣掉別人的 ref）；訂閱中被移除的鍵等結果出來，成功才退訂 1 次。
// - 釋放寬限 RELEASE_GRACE_MS（模組層，同 lib/quote-ownership 的行情釋放寬限）：釋放的鍵先寄放，寬限內再要
//   （切回盤中異動分段、篩選來回切換、短暫切到背景）就沿用原本的訂閱，不送退訂與重新訂閱；寬限結束才退訂。
//   避免快速切換分段或篩選時連續送出成對的 subscribe／unsubscribe。

import { useEffect, useState } from 'react';
import { subscribeMarketSignal, unsubscribeMarketSignal } from '../../../lib/shioaji';
import { parseSignalKey, type SignalKey } from './signal-model';

export type SignalSubStatus = 'pending' | 'ok' | 'failed';

export interface SignalCoverage {
    /** 目前要訂閱的鍵數 */
    total: number;
    ok: number;
    pending: number;
    failed: number;
}

export interface SignalSubscriptionApi {
    subscribe(key: SignalKey): Promise<unknown>;
    unsubscribe(key: SignalKey): Promise<unknown>;
}

export const libSignalApi: SignalSubscriptionApi = {
    subscribe: key => {
        const { rule, exchange } = parseSignalKey(key);
        return subscribeMarketSignal(rule, exchange);
    },
    unsubscribe: key => {
        const { rule, exchange } = parseSignalKey(key);
        return unsubscribeMarketSignal(rule, exchange);
    },
};

interface Entry {
    status: SignalSubStatus;
    /** subscribe 的結果（true＝成功）；退訂等它決定 */
    settled: Promise<boolean>;
}

/** 釋放寬限（毫秒）：寬限內再要同一個鍵就沿用，不送退訂與重新訂閱 */
export const RELEASE_GRACE_MS = 1_500;

/** 寄放中的鍵（模組層：分段卸載再掛載也能沿用） */
const parked = new Map<SignalKey, { entry: Entry; api: SignalSubscriptionApi; timer: ReturnType<typeof setTimeout> }>();

/** 測試用：清掉寄放（不送退訂） */
export function resetParkedSignalsForTest(): void {
    for (const p of parked.values()) clearTimeout(p.timer);
    parked.clear();
}

export class SignalSubscriptions {
    private readonly entries = new Map<SignalKey, Entry>();

    constructor(
        private readonly api: SignalSubscriptionApi,
        private readonly onChange: () => void,
        private readonly graceMs: number = RELEASE_GRACE_MS,
    ) {}

    /** 把持有的鍵調成 keys：只送差異 */
    sync(keys: Iterable<SignalKey>): void {
        const next = new Set(keys);
        let changed = false;
        for (const [key, entry] of [...this.entries]) {
            if (next.has(key)) continue;
            this.entries.delete(key);
            this.release(key, entry);
            changed = true;
        }
        for (const key of next) {
            if (this.entries.has(key)) continue;
            this.acquire(key);
            changed = true;
        }
        if (changed) this.onChange();
    }

    /** 使用者按［重試］：失敗的鍵各再送 1 次 subscribe */
    retry(): void {
        let changed = false;
        for (const [key, entry] of this.entries) {
            if (entry.status !== 'failed') continue;
            this.acquire(key);
            changed = true;
        }
        if (changed) this.onChange();
    }

    coverage(): SignalCoverage {
        const c: SignalCoverage = { total: this.entries.size, ok: 0, pending: 0, failed: 0 };
        for (const entry of this.entries.values()) c[entry.status] += 1;
        return c;
    }

    private acquire(key: SignalKey): void {
        // 寬限內寄放的同一個鍵（未失敗）：沿用，不送 subscribe
        const held = parked.get(key);
        if (held && held.api === this.api && held.entry.status !== 'failed') {
            clearTimeout(held.timer);
            parked.delete(key);
            this.hold(key, held.entry);
            return;
        }
        const entry: Entry = { status: 'pending', settled: Promise.resolve(false) };
        // 狀態與持有者無關（寄放後被別的實例沿用時也要更新）；通知只給目前持有它的實例
        entry.settled = this.api.subscribe(key).then(
            () => true,
            () => false,
        ).then(ok => {
            entry.status = ok ? 'ok' : 'failed';
            return ok;
        });
        this.hold(key, entry);
    }

    private hold(key: SignalKey, entry: Entry): void {
        this.entries.set(key, entry);
        if (entry.status === 'pending') {
            void entry.settled.then(() => {
                if (this.entries.get(key) === entry) this.onChange();
            });
        }
    }

    private release(key: SignalKey, entry: Entry): void {
        const unsubscribe = () => {
            void entry.settled.then(ok => (ok ? this.api.unsubscribe(key).catch(() => undefined) : undefined));
        };
        // 失敗的鍵沒有持有（不寄放、不退訂）；同一個鍵已有別的寄放（另一個實例）時這份直接退訂
        if (entry.status === 'failed') return;
        if (this.graceMs <= 0 || parked.has(key)) {
            unsubscribe();
            return;
        }
        const timer = setTimeout(() => {
            if (parked.get(key)?.entry !== entry) return;
            parked.delete(key);
            unsubscribe();
        }, this.graceMs);
        parked.set(key, { entry, api: this.api, timer });
    }
}

/**
 * active 為 true 時持有 keys 的訂閱（差異同步），false 或卸載時全部退訂。
 * keys 以內容比較（呼叫端每次渲染產生新陣列也只在內容改變時同步）。
 */
export function useSignalSubscriptions(keys: readonly SignalKey[], active: boolean, api: SignalSubscriptionApi = libSignalApi, graceMs: number = RELEASE_GRACE_MS) {
    const [, setVersion] = useState(0);
    const [subs] = useState(() => new SignalSubscriptions(api, () => setVersion(v => v + 1), graceMs));
    const signature = keys.join(',');
    useEffect(() => {
        subs.sync(active && signature ? (signature.split(',') as SignalKey[]) : []);
    }, [subs, signature, active]);
    useEffect(() => () => subs.sync([]), [subs]);
    return { coverage: subs.coverage(), retry: () => subs.retry() };
}
