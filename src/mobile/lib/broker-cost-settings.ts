// src/mobile/lib/broker-cost-settings.ts — 手機版依券商的手續費折數與退佣方式
//
// 使用者決定永豐、玉山的手續費折數與退佣方式分開設定（只做在手機版；桌面版維持共用設定 sj-pro-trading-cost-v1）。
// - 存在本裝置 localStorage 'sj-mobile-broker-cost-v1'：Partial<Record<CostBroker, { feeDiscount, rebateMode }>>。
//   sanitize 規則同 sanitizeTradingCostSettings（折數 (0, 1]、rebateMode 只接受 monthly／instant）；不合法的券商整筆忽略。
// - 某券商沒有覆寫時沿用共用設定的 feeDiscount／rebateMode；融資年利率、借券費率一律用共用設定。
// - 寫法照 src/lib/trading-cost-settings.ts：記憶體後備、listeners、useSyncExternalStore、同一份 raw 回同一個物件。
// 券商判斷只用 lib/esun 的 isEsunAccount（玉山 → 'esun'，其他 → 'sinopac'）。

import { useMemo, useSyncExternalStore } from 'react';
import { isEsunAccount } from '../../lib/esun';
import { getTradingCostSettings, useTradingCostSettings, type RebateMode, type TradingCostSettings } from '../../lib/trading-cost-settings';
import type { Account } from '../../lib/types/portfolio';

export type CostBroker = 'sinopac' | 'esun';

export const COST_BROKERS: readonly CostBroker[] = ['sinopac', 'esun'];

export const COST_BROKER_TEXT: Record<CostBroker, string> = { sinopac: '永豐', esun: '玉山' };

export interface BrokerFeeSettings {
    feeDiscount: number;
    rebateMode: RebateMode;
}

export type BrokerCostOverrides = Partial<Record<CostBroker, BrokerFeeSettings>>;

export const BROKER_COST_SETTINGS_KEY = 'sj-mobile-broker-cost-v1';

/** 帳戶所屬券商：玉山 → 'esun'，其他（含帳戶不明）→ 'sinopac' */
export function brokerOfAccount(account?: Pick<Account, 'broker_id'> | null): CostBroker {
    return account && isEsunAccount(account) ? 'esun' : 'sinopac';
}

/** `${broker_id}:${account_id}`（以最後一個 ':' 切開）所屬券商 */
export function brokerOfAccountKey(key: string): CostBroker {
    const idx = key.lastIndexOf(':');
    const broker_id = idx > 0 ? key.slice(0, idx) : key;
    return broker_id ? brokerOfAccount({ broker_id }) : 'sinopac';
}

function validDiscount(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;
}

function validMode(v: unknown): v is RebateMode {
    return v === 'monthly' || v === 'instant';
}

function sanitizeEntry(v: unknown): BrokerFeeSettings | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    // 數字字串也接受（與 sanitizeTradingCostSettings 的 Number() 一致）
    const d = typeof o.feeDiscount === 'string' && o.feeDiscount.trim() !== '' ? Number(o.feeDiscount) : o.feeDiscount;
    if (!validDiscount(d) || !validMode(o.rebateMode)) return null;
    return { feeDiscount: d, rebateMode: o.rebateMode };
}

/** 不合法的券商整筆忽略 */
export function sanitizeBrokerCostOverrides(v: unknown): BrokerCostOverrides {
    const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
    const out: BrokerCostOverrides = {};
    for (const b of COST_BROKERS) {
        const e = sanitizeEntry(o[b]);
        if (e) out[b] = e;
    }
    return out;
}

/** 某券商的有效設定（純函式）：沒有覆寫時回傳 base 本身；融資年利率、借券費率一律沿用 base */
export function costSettingsFor(base: TradingCostSettings, overrides: BrokerCostOverrides, broker: CostBroker): TradingCostSettings {
    const o = overrides[broker];
    if (!o) return base;
    if (o.feeDiscount === base.feeDiscount && o.rebateMode === base.rebateMode) return base;
    return { ...base, feeDiscount: o.feeDiscount, rebateMode: o.rebateMode };
}

// ---- 持久化 ----

// localStorage 不可用時只在本次有效
let memoryRaw: string | null = null;
let storageBroken = false;

function readRaw(): string | null {
    if (storageBroken) return memoryRaw;
    try {
        return localStorage.getItem(BROKER_COST_SETTINGS_KEY);
    } catch {
        return memoryRaw;
    }
}

function parse(raw: string | null): BrokerCostOverrides {
    try {
        return sanitizeBrokerCostOverrides(raw ? JSON.parse(raw) : null);
    } catch {
        return {};
    }
}

function save(next: BrokerCostOverrides): void {
    const raw = JSON.stringify(sanitizeBrokerCostOverrides(next));
    memoryRaw = raw;
    try {
        localStorage.setItem(BROKER_COST_SETTINGS_KEY, raw);
        storageBroken = false;
    } catch {
        storageBroken = true;
    }
    for (const l of [...listeners]) l();
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: BrokerCostOverrides = {};

/** 目前的覆寫；同一份儲存內容回傳同一個物件（useSyncExternalStore 快照） */
export function getBrokerCostOverrides(): BrokerCostOverrides {
    const raw = readRaw();
    if (raw !== cachedRaw) {
        cachedRaw = raw;
        cached = parse(raw);
    }
    return cached;
}

export function subscribeBrokerCostOverrides(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useBrokerCostOverrides(): BrokerCostOverrides {
    return useSyncExternalStore(subscribeBrokerCostOverrides, getBrokerCostOverrides, getBrokerCostOverrides);
}

/** 兩家券商的有效設定；共用設定與覆寫都沒變時物件身分不變 */
export function useBrokerCostSettings(): Record<CostBroker, TradingCostSettings> {
    const base = useTradingCostSettings();
    const overrides = useBrokerCostOverrides();
    return useMemo(() => ({
        sinopac: costSettingsFor(base, overrides, 'sinopac'),
        esun: costSettingsFor(base, overrides, 'esun'),
    }), [base, overrides]);
}

/**
 * 更新某券商的折數或退佣方式。patch 內任一欄位不合法時不寫入並回 false。
 * 第一次寫入（該券商尚未覆寫）時以目前有效值（共用設定）補齊另一個欄位。
 */
export function setBrokerFeeSettings(broker: CostBroker, patch: Partial<BrokerFeeSettings>): boolean {
    if ('feeDiscount' in patch && !validDiscount(patch.feeDiscount)) return false;
    if ('rebateMode' in patch && !validMode(patch.rebateMode)) return false;
    const current = getBrokerCostOverrides();
    const base = getTradingCostSettings();
    const prev = current[broker] ?? { feeDiscount: base.feeDiscount, rebateMode: base.rebateMode };
    const entry = sanitizeEntry({ ...prev, ...patch });
    if (!entry) return false;
    save({ ...current, [broker]: entry });
    return true;
}

/** 清除兩家券商的覆寫（回到共用設定） */
export function resetBrokerCostSettings(): void {
    save({});
}
