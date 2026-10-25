// fork：交易成本設定的計算、sanitize 與持久化。金額全為合成值。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_TRADING_COST_SETTINGS,
    discountText,
    feeRebate,
    getTradingCostSettings,
    loadTradingCostSettings,
    marginFinancing,
    marginInterest,
    marginInterestDays,
    resetTradingCostSettings,
    sanitizeTradingCostSettings,
    saveTradingCostSettings,
    setTradingCostSettings,
    shortSellingFee,
    stockFeeBreakdown,
    subscribeTradingCostSettings,
    TRADING_COST_SETTINGS_KEY,
    type TradingCostSettings,
} from './trading-cost-settings';

const S = (over: Partial<TradingCostSettings> = {}): TradingCostSettings => ({ ...DEFAULT_TRADING_COST_SETTINGS, ...over });
let store: Map<string, string>;
beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('stockFeeBreakdown', () => {
    it('預設（月退、無折扣）等於牌告手續費，無退佣', () => {
        // 100,000 × 0.1425% = 142.5 → 143
        expect(stockFeeBreakdown(10_000_000, { odd: false }, S())).toEqual({ charged: 143, net: 143, rebate: 0 });
    });
    it('月退：交割收牌告，退佣後＝round(牌告 × 折數)', () => {
        // 143 × 0.6 = 85.8 → 86；退 57
        expect(stockFeeBreakdown(10_000_000, { odd: false }, S({ feeDiscount: 0.6 }))).toEqual({ charged: 143, net: 86, rebate: 57 });
    });
    it('即折：交割就收 max(最低, 牌告 × 折數)', () => {
        // 100,000 × 0.0855% = 85.5 → 86
        expect(stockFeeBreakdown(10_000_000, { odd: false }, S({ feeDiscount: 0.6, rebateMode: 'instant' }))).toEqual({ charged: 86, net: 86, rebate: 0 });
    });
    it('最低手續費：整股 20、零股 1；月退以最低手續費為交割額再打折', () => {
        // 10,000 × 0.1425% = 14.25 → 14 < 20
        expect(stockFeeBreakdown(1_000_000, { odd: false }, S({ feeDiscount: 0.28 }))).toEqual({ charged: 20, net: 6, rebate: 14 });
        expect(stockFeeBreakdown(1_000_000, { odd: false }, S({ feeDiscount: 0.28, rebateMode: 'instant' }))).toEqual({ charged: 20, net: 20, rebate: 0 });
        // 零股 1 股 × 100 元：0.1425 → 0 < 1
        expect(stockFeeBreakdown(10_000, { odd: true }, S({ rebateMode: 'instant' }))).toEqual({ charged: 1, net: 1, rebate: 0 });
        expect(stockFeeBreakdown(10_000, { odd: true }, S({ feeDiscount: 0.5 }))).toEqual({ charged: 1, net: 1, rebate: 0 });
    });
    it('非正值價金回 0', () => {
        expect(stockFeeBreakdown(0, { odd: false }, S())).toEqual({ charged: 0, net: 0, rebate: 0 });
    });
});

it('feeRebate 只在月退且折數 < 1 時有值', () => {
    expect(feeRebate(1000, S({ feeDiscount: 0.6 }))).toBe(400);
    expect(feeRebate(1000, S({ feeDiscount: 0.6, rebateMode: 'instant' }))).toBe(0);
    expect(feeRebate(1000, S())).toBe(0);
});

it('shortSellingFee＝價金 × 借券費率（預設 0.08%）', () => {
    expect(shortSellingFee(10_000_000, S())).toBe(80);
    expect(shortSellingFee(10_000_000, S({ shortFeeRate: 0.001 }))).toBe(100);
    expect(shortSellingFee(10_000_000, S({ shortFeeRate: 0 }))).toBe(0);
});

describe('marginFinancing', () => {
    it('上市 6 成、上櫃 5 成，千元以下捨去', () => {
        expect(marginFinancing(10_000_000, 'TSE')).toEqual({ financed: 60_000, selfFunded: 40_000 });
        expect(marginFinancing(10_000_000, 'OTC')).toEqual({ financed: 50_000, selfFunded: 50_000 });
        // 33,330 × 0.6 = 19,998 → 19,000；× 0.5 = 16,665 → 16,000
        expect(marginFinancing(3_333_000, 'TSE')).toEqual({ financed: 19_000, selfFunded: 14_330 });
        expect(marginFinancing(3_333_000, 'OTC')).toEqual({ financed: 16_000, selfFunded: 17_330 });
    });
    it('其他交易所回 null', () => {
        expect(marginFinancing(10_000_000, 'OES')).toBeNull();
        expect(marginFinancing(10_000_000, null)).toBeNull();
    });
});

describe('marginInterest', () => {
    it('未設定年利率回 null', () => {
        expect(marginInterest(60_000, 10, S())).toBeNull();
    });
    it('round(融資金額 × 年利率 × 天數 ÷ 365)', () => {
        // 60,000 × 6.45% × 1 ÷ 365 = 10.60 → 11；× 30 天 = 318.08 → 318
        expect(marginInterest(60_000, 1, S({ marginAnnualRate: 0.0645 }))).toBe(11);
        expect(marginInterest(60_000, 30, S({ marginAnnualRate: 0.0645 }))).toBe(318);
        expect(marginInterest(60_000, 0, S({ marginAnnualRate: 0.0645 }))).toBe(0);
        expect(marginInterest(60_000, 30, S({ marginAnnualRate: 0 }))).toBe(0);
    });
});

it('marginInterestDays：交割日＝成交日後第 2 個週一至週五，到今天的日曆天數，不足 0 為 0', () => {
    // 2026-10-20（二）→ 交割 10-22（四）
    expect(marginInterestDays('2026-10-20', '2026-10-26')).toBe(4);
    // 2026-10-22（四）→ 交割 10-26（一）
    expect(marginInterestDays('20261022', '2026-10-26')).toBe(0);
    expect(marginInterestDays('2026-10-23', '2026-10-26')).toBe(0);
    expect(marginInterestDays('', '2026-10-26')).toBeNull();
});

describe('sanitize／load／save', () => {
    it('範圍外或型別錯誤的欄位退回預設', () => {
        expect(sanitizeTradingCostSettings(null)).toEqual(DEFAULT_TRADING_COST_SETTINGS);
        expect(sanitizeTradingCostSettings({ feeDiscount: 0, rebateMode: 'weekly', marginAnnualRate: 0.31, shortFeeRate: 0.02 })).toEqual(DEFAULT_TRADING_COST_SETTINGS);
        expect(sanitizeTradingCostSettings({ feeDiscount: 1.1, marginAnnualRate: -0.01, shortFeeRate: -1 })).toEqual(DEFAULT_TRADING_COST_SETTINGS);
        expect(sanitizeTradingCostSettings({ feeDiscount: '0.6', marginAnnualRate: true, shortFeeRate: '' })).toEqual({ ...DEFAULT_TRADING_COST_SETTINGS, feeDiscount: 0.6 });
        expect(sanitizeTradingCostSettings({ feeDiscount: 1, rebateMode: 'instant', marginAnnualRate: 0.3, shortFeeRate: 0.01 }))
            .toEqual({ feeDiscount: 1, rebateMode: 'instant', marginAnnualRate: 0.3, shortFeeRate: 0.01 });
        expect(sanitizeTradingCostSettings({ marginAnnualRate: 0, shortFeeRate: 0 })).toMatchObject({ marginAnnualRate: 0, shortFeeRate: 0 });
    });
    it('load 讀取並清理；JSON 損壞或 localStorage 例外時回預設', () => {
        expect(loadTradingCostSettings()).toEqual(DEFAULT_TRADING_COST_SETTINGS);
        store.set(TRADING_COST_SETTINGS_KEY, JSON.stringify({ feeDiscount: 0.28, rebateMode: 'instant', marginAnnualRate: 0.065, shortFeeRate: 5 }));
        expect(loadTradingCostSettings()).toEqual({ feeDiscount: 0.28, rebateMode: 'instant', marginAnnualRate: 0.065, shortFeeRate: 0.0008 });
        store.set(TRADING_COST_SETTINGS_KEY, '{not json');
        expect(loadTradingCostSettings()).toEqual(DEFAULT_TRADING_COST_SETTINGS);
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
        expect(loadTradingCostSettings()).toEqual(DEFAULT_TRADING_COST_SETTINGS);
    });
    it('save 寫入清理後的 JSON 並通知訂閱者；setItem 例外時本次仍有效', () => {
        const listener = vi.fn();
        const stop = subscribeTradingCostSettings(listener);
        saveTradingCostSettings({ feeDiscount: 0.6, rebateMode: 'instant', marginAnnualRate: null, shortFeeRate: 9 });
        expect(JSON.parse(store.get(TRADING_COST_SETTINGS_KEY)!)).toEqual({ feeDiscount: 0.6, rebateMode: 'instant', marginAnnualRate: null, shortFeeRate: 0.0008 });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(getTradingCostSettings()).toBe(getTradingCostSettings());
        expect(getTradingCostSettings().feeDiscount).toBe(0.6);
        stop();
        vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota'); } });
        saveTradingCostSettings(S({ feeDiscount: 0.5 }));
        expect(getTradingCostSettings().feeDiscount).toBe(0.5);
        expect(listener).toHaveBeenCalledTimes(1);
        // 儲存恢復可用後寫回 localStorage
        vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
        resetTradingCostSettings();
        expect(JSON.parse(store.get(TRADING_COST_SETTINGS_KEY)!)).toEqual(DEFAULT_TRADING_COST_SETTINGS);
    });
    it('setTradingCostSettings 拒絕不合法的欄位且不寫入；reset 還原預設', () => {
        expect(setTradingCostSettings({ feeDiscount: 0.6 })).toBe(true);
        expect(setTradingCostSettings({ feeDiscount: 1.5 })).toBe(false);
        expect(setTradingCostSettings({ marginAnnualRate: 0.5 })).toBe(false);
        expect(getTradingCostSettings()).toEqual(S({ feeDiscount: 0.6 }));
        expect(setTradingCostSettings({ marginAnnualRate: 0.07 })).toBe(true);
        resetTradingCostSettings();
        expect(getTradingCostSettings()).toEqual(DEFAULT_TRADING_COST_SETTINGS);
    });
});

it('discountText', () => {
    expect(discountText(0.6)).toBe('6');
    expect(discountText(0.28)).toBe('2.8');
    expect(discountText(1)).toBe('10');
});
