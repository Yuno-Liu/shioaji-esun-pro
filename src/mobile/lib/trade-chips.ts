// src/mobile/lib/trade-chips.ts — 「籌碼與當沖」面板的融資融券與券源（只在面板內使用，隨面板延遲載入）
//
// 請求紀律（設計規格 §13）：
// - 只在交易頁的「籌碼與當沖」面板開啟、而且商品是股票（STK）時才讀；資訊列本身不讀。
// - credit_enquire（lib/credit-eligibility 的 loadCreditEnquire，與下單面板共用成功快取）與
//   POST /api/v1/data/short_stock_sources 各自以「伺服器＋交易所＋代碼＋台北日期」（creditEnquireKey）為鍵，
//   每檔每個交易日最多各讀 1 次：成功與失敗都記住到當天結束，失敗不自動重試（不形成請求風暴）；
//   換商品或過了台北午夜才是新的鍵。失敗後只有使用者在面板按［重新查詢］（retryTradeChips）才重讀失敗的那一項，
//   成功或讀取中的不動。
// - 模組層快取：關閉面板、換頁再回來都不重讀。

import { useEffect, useSyncExternalStore } from 'react';
import { apiPost } from '../../lib/api';
import { creditEnquireKey, loadCreditEnquire, type CreditEnquire } from '../../lib/credit-eligibility';
import type { ContractBase } from '../../lib/types/contract';

export const SHORT_SOURCES_PATH = '/api/v1/data/short_stock_sources';

export interface ShortSource {
    code: string;
    short_stock_source: number;
    datetime: string;
}

export type ChipEntry<T> =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ok'; value: T | undefined }
    | { status: 'failed' };

type ChipsContract = Pick<ContractBase, 'code' | 'security_type' | 'exchange'>;

/** 快取上限（每檔每天 2 筆；超過時刪最舊的已完成項目） */
const MAX_ENTRIES = 200;

const entries = new Map<string, ChipEntry<unknown>>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
    version += 1;
    listeners.forEach(l => l());
}

function prune() {
    if (entries.size <= MAX_ENTRIES) return;
    for (const [k, e] of entries) {
        if (entries.size <= MAX_ENTRIES) break;
        if (e.status !== 'loading') entries.delete(k);
    }
}

function ensure<T>(key: string, load: () => Promise<T | undefined>): void {
    if (entries.has(key)) return;
    entries.set(key, { status: 'loading' });
    prune();
    emit();
    let p: Promise<T | undefined>;
    try {
        p = load();
    } catch {
        p = Promise.reject(new Error('load failed'));
    }
    p.then(
        value => { entries.set(key, { status: 'ok', value }); emit(); },
        () => { entries.set(key, { status: 'failed' }); emit(); },
    );
}

export function chipsKeys(contract: ChipsContract): { credit: string; short: string } {
    const k = creditEnquireKey(contract);
    return { credit: `credit|${k}`, short: `short|${k}` };
}

function loadShortSource(contract: ChipsContract): Promise<ShortSource | undefined> {
    return apiPost<ShortSource[]>(SHORT_SOURCES_PATH, {
        contracts: [{ security_type: contract.security_type, exchange: contract.exchange, code: contract.code }],
    // 只採用這一檔的回覆（同 loadCreditEnquire）
    }).then(rows => (Array.isArray(rows) ? rows.find(r => r?.code === contract.code) : undefined));
}

/** 讀取（若今天還沒讀過）；非股票不讀 */
export function ensureTradeChips(contract: ChipsContract): void {
    if (contract.security_type !== 'STK') return;
    const keys = chipsKeys(contract);
    ensure<CreditEnquire>(keys.credit, () => loadCreditEnquire(contract));
    ensure<ShortSource>(keys.short, () => loadShortSource(contract));
}

/** 使用者按［重新查詢］：只清除這一檔今天「失敗」的項目再讀一次（每次都要使用者操作，不自動重試） */
export function retryTradeChips(contract: ChipsContract): void {
    if (contract.security_type !== 'STK') return;
    const keys = chipsKeys(contract);
    for (const key of [keys.credit, keys.short]) {
        if (entries.get(key)?.status === 'failed') entries.delete(key);
    }
    ensureTradeChips(contract);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
const getVersion = () => version;

const IDLE = { status: 'idle' } as const;

export interface TradeChipsState {
    credit: ChipEntry<CreditEnquire>;
    short: ChipEntry<ShortSource>;
}

/** enabled（面板開啟中）且是股票時讀取；回傳目前商品今天的結果 */
export function useTradeChips(contract: ChipsContract, enabled: boolean): TradeChipsState {
    useSyncExternalStore(subscribe, getVersion, getVersion);
    const active = enabled && contract.security_type === 'STK';
    const keys = contract.security_type === 'STK' ? chipsKeys(contract) : null;
    const credit = keys?.credit ?? '';
    const short = keys?.short ?? '';
    useEffect(() => {
        if (active) ensureTradeChips(contract);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, credit, short]);
    return {
        credit: (keys && (entries.get(credit) as ChipEntry<CreditEnquire> | undefined)) ?? IDLE,
        short: (keys && (entries.get(short) as ChipEntry<ShortSource> | undefined)) ?? IDLE,
    };
}

/** 測試用 */
export function resetTradeChipsForTest(): void {
    entries.clear();
    listeners.clear();
    version = 0;
}
