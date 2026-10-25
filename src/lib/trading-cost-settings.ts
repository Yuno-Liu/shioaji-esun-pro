// src/lib/trading-cost-settings.ts — 交易成本設定（fork 模組）
//
// 使用者自訂的手續費折數與退佣方式、融資年利率、借券費率，以及套用這些設定的純計算函式。
// 下單面板成本列（trade-cost-summary）、玉山持倉與已實現損益明細共用。
// 鋪單面板（odd-spread）另有自己的手續費設定（'sj-pro-odd-spread-prefs-v1'），兩者互不影響。
//
// 退佣方式：
// - instant（成交即折）：交割時就以「牌告 × 折數」收取。
// - monthly（月退）：交割時收牌告手續費，事後（通常次月）退回「牌告 − 牌告 × 折數」。
//   玉山正式成交資料顯示交割收的是牌告手續費，因此預設月退。
//
// 金額四捨五入沿用 contract-cost 的 applyRateYuan（BigInt 到元、.5 進位）。

import { useSyncExternalStore } from 'react';
import { applyRateYuan, STOCK_FEE_RATE, STOCK_MIN_FEE_ODD, STOCK_MIN_FEE_ROUND } from './utils/contract-cost';

export type RebateMode = 'monthly' | 'instant';

export interface TradingCostSettings {
    /** 手續費折數小數（6 折 = 0.6；無折扣 = 1），範圍 (0, 1] */
    feeDiscount: number;
    /** 退佣方式：月退（交割收牌告、事後退回）或成交即折 */
    rebateMode: RebateMode;
    /** 融資年利率小數（6.45% = 0.0645），null＝未設定（不估算利息），範圍 [0, 0.3] */
    marginAnnualRate: number | null;
    /** 借券費率小數（融券賣出時收取，法定融券手續費 0.08% = 0.0008），範圍 [0, 0.01] */
    shortFeeRate: number;
}

export const TRADING_COST_SETTINGS_KEY = 'sj-pro-trading-cost-v1';

export const DEFAULT_TRADING_COST_SETTINGS: Readonly<TradingCostSettings> = Object.freeze({
    feeDiscount: 1,
    rebateMode: 'monthly',
    marginAnnualRate: null,
    shortFeeRate: 0.0008,
});

function finiteIn(v: unknown, lo: number, hi: number, loExclusive = false): number | null {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n > hi || (loExclusive ? n <= lo : n < lo)) return null;
    return n;
}

/** 不合法的欄位逐一退回預設值 */
export function sanitizeTradingCostSettings(v: unknown): TradingCostSettings {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const d = DEFAULT_TRADING_COST_SETTINGS;
    return {
        feeDiscount: finiteIn(o.feeDiscount, 0, 1, true) ?? d.feeDiscount,
        rebateMode: o.rebateMode === 'instant' || o.rebateMode === 'monthly' ? o.rebateMode : d.rebateMode,
        marginAnnualRate: o.marginAnnualRate === null ? null : finiteIn(o.marginAnnualRate, 0, 0.3) ?? d.marginAnnualRate,
        shortFeeRate: finiteIn(o.shortFeeRate, 0, 0.01) ?? d.shortFeeRate,
    };
}

// ---- 持久化（沿用 odd-spread 的 load／save 寫法） ----

// localStorage 不可用時只在本次有效
let memoryRaw: string | null = null;
let storageBroken = false;

function readRaw(): string | null {
    if (storageBroken) return memoryRaw;
    try {
        return localStorage.getItem(TRADING_COST_SETTINGS_KEY);
    } catch {
        return memoryRaw;
    }
}

function parse(raw: string | null): TradingCostSettings {
    try {
        return sanitizeTradingCostSettings(raw ? JSON.parse(raw) : null);
    } catch {
        return sanitizeTradingCostSettings(null);
    }
}

export function loadTradingCostSettings(): TradingCostSettings {
    return parse(readRaw());
}

export function saveTradingCostSettings(s: TradingCostSettings): void {
    const raw = JSON.stringify(sanitizeTradingCostSettings(s));
    memoryRaw = raw;
    try {
        localStorage.setItem(TRADING_COST_SETTINGS_KEY, raw);
        storageBroken = false;
    } catch {
        storageBroken = true;
    }
    for (const l of [...listeners]) l();
}

// ---- 訂閱與 React hook ----

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: TradingCostSettings = { ...DEFAULT_TRADING_COST_SETTINGS };

/** 目前設定；同一份儲存內容回傳同一個物件（useSyncExternalStore 快照） */
export function getTradingCostSettings(): TradingCostSettings {
    const raw = readRaw();
    if (raw !== cachedRaw) {
        cachedRaw = raw;
        cached = parse(raw);
    }
    return cached;
}

export function subscribeTradingCostSettings(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useTradingCostSettings(): TradingCostSettings {
    return useSyncExternalStore(subscribeTradingCostSettings, getTradingCostSettings, getTradingCostSettings);
}

/**
 * 更新部分設定。patch 內任一欄位不合法（sanitize 後與輸入不同）時整筆不寫入並回 false。
 */
export function setTradingCostSettings(patch: Partial<TradingCostSettings>): boolean {
    const next = { ...getTradingCostSettings(), ...patch };
    const clean = sanitizeTradingCostSettings(next);
    for (const k of Object.keys(patch) as (keyof TradingCostSettings)[]) {
        if (clean[k] !== patch[k]) return false;
    }
    saveTradingCostSettings(clean);
    return true;
}

export function resetTradingCostSettings(): void {
    saveTradingCostSettings({ ...DEFAULT_TRADING_COST_SETTINGS });
}

// ---- 顯示 ----

/** 0.6 → '6'、0.28 → '2.8'、1 → '10' */
export function discountText(feeDiscount: number): string {
    return String(Number((feeDiscount * 10).toFixed(4)));
}

/** 小數 → 百分比字串（0.0008 → '0.08'） */
export function percentText(rate: number): string {
    return String(Number((rate * 100).toFixed(6)));
}

/** 月退且有折扣時才有退佣 */
export function hasMonthlyRebate(settings: TradingCostSettings): boolean {
    return settings.rebateMode === 'monthly' && settings.feeDiscount < 1;
}

// ---- 純計算 ----

export interface FeeBreakdown {
    /** 交割時收取的手續費（元） */
    charged: number;
    /** 扣除退佣後的實際手續費（元） */
    net: number;
    /** 事後退佣（元）；成交即折為 0 */
    rebate: number;
}

/** 已收手續費（元）× 折數 → 四捨五入到元（不低於 0） */
function discounted(feeYuan: number, discount: number): number {
    return Math.max(0, applyRateYuan(feeYuan * 100, discount));
}

/** 已以牌告收取的手續費（元）在月退設定下的預估退佣；即折或無折扣回 0 */
export function feeRebate(chargedFee: number, settings: TradingCostSettings): number {
    if (!hasMonthlyRebate(settings) || !(chargedFee > 0)) return 0;
    return chargedFee - discounted(chargedFee, settings.feeDiscount);
}

/**
 * 單筆委託手續費拆解（元）。最低手續費沿用 contract-cost（整股 20 元、零股 1 元）。
 * - instant：charged＝max(最低手續費, 牌告 × 折數)，net＝charged，rebate＝0
 * - monthly：charged＝max(最低手續費, 牌告)，net＝max(0, round(charged × 折數))，rebate＝charged − net
 */
export function stockFeeBreakdown(
    notionalCents: number,
    opts: { odd: boolean },
    settings: TradingCostSettings,
): FeeBreakdown {
    if (!(notionalCents > 0)) return { charged: 0, net: 0, rebate: 0 };
    const minFee = opts.odd ? STOCK_MIN_FEE_ODD : STOCK_MIN_FEE_ROUND;
    if (settings.rebateMode === 'instant') {
        const charged = Math.max(minFee, applyRateYuan(notionalCents, STOCK_FEE_RATE * settings.feeDiscount));
        return { charged, net: charged, rebate: 0 };
    }
    const charged = Math.max(minFee, applyRateYuan(notionalCents, STOCK_FEE_RATE));
    const net = discounted(charged, settings.feeDiscount);
    return { charged, net, rebate: charged - net };
}

/** 融券賣出借券費（元）＝ 價金 × 借券費率 */
export function shortSellingFee(notionalCents: number, settings: TradingCostSettings): number {
    return applyRateYuan(notionalCents, settings.shortFeeRate);
}

/**
 * 融資成數：上市 6 成、上櫃 5 成（法定上限；個股可能因信用交易條件調降成數或停資，
 * 以券商實際核定為準，這裡只做估算）。其他市場（興櫃等）不可融資 → null。
 */
export function marginFinancingRatio(exchange: string | null | undefined): number | null {
    return exchange === 'TSE' ? 0.6 : exchange === 'OTC' ? 0.5 : null;
}

export interface MarginFinancing {
    /** 融資金額（元，取整到千元以下捨去） */
    financed: number;
    /** 自備款（元）＝ 價金 − 融資金額 */
    selfFunded: number;
}

/** 融資金額＝floor(價金 × 成數 ÷ 1000) × 1000；非上市櫃回 null */
export function marginFinancing(notionalCents: number, exchange: string | null | undefined): MarginFinancing | null {
    const ratio = marginFinancingRatio(exchange);
    if (ratio === null || !(notionalCents > 0)) return null;
    const tenths = Math.round(ratio * 10);
    const cents = Math.round(notionalCents);
    // 價金（分）× 成數 ÷ 100（元）÷ 1000 → 千元
    const financed = Math.floor((cents * tenths) / (10 * 100 * 1000)) * 1000;
    return { financed, selfFunded: cents / 100 - financed };
}

/** 融資利息（元）＝ round(融資金額 × 年利率 × 天數 ÷ 365)；未設定年利率回 null */
export function marginInterest(financedYuan: number, days: number, settings: TradingCostSettings): number | null {
    const rate = settings.marginAnnualRate;
    if (rate === null) return null;
    if (!(financedYuan > 0) || !(days > 0) || !(rate > 0)) return 0;
    // 年利率放大 1e8（6.45% = 6,450,000），BigInt 四捨五入到元
    const num = BigInt(Math.round(financedYuan)) * BigInt(Math.round(rate * 1e8)) * BigInt(Math.round(days));
    const den = 365n * 100_000_000n;
    return Number((num * 2n + den) / (2n * den));
}

const DAY_MS = 86_400_000;

function utcDay(ymd: string): number | null {
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(ymd.trim());
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isFinite(t) ? t : null;
}

/**
 * 融資計息天數（估）：交割日 ≈ 成交日後第 2 個週一至週五（不含國定假日），
 * 計到 today（台北日期 YYYY-MM-DD）的日曆天數；不足 0 則 0。日期無法解析回 null。
 */
export function marginInterestDays(tradeDate: string, today: string): number | null {
    const start = utcDay(tradeDate);
    const end = utcDay(today);
    if (start === null || end === null) return null;
    let settle = start;
    let left = 2;
    while (left > 0) {
        settle += DAY_MS;
        const wd = new Date(settle).getUTCDay();
        if (wd !== 0 && wd !== 6) left -= 1;
    }
    return Math.max(0, Math.round((end - settle) / DAY_MS));
}
