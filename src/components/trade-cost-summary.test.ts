// fork：下單面板股票成本列文字（tradeCostText）。合約與金額皆為合成值。
import { describe, expect, it } from 'vitest';
import { DEFAULT_TRADING_COST_SETTINGS, type TradingCostSettings } from '../lib/trading-cost-settings';
import type { ContractInfo } from '../lib/types/contract';
import { tradeCostText, type TradeCostInput } from './trade-cost-summary';

const S = (over: Partial<TradingCostSettings> = {}): TradingCostSettings => ({ ...DEFAULT_TRADING_COST_SETTINGS, ...over });
const tse = { code: '9999', name: '合成股', security_type: 'STK', exchange: 'TSE' } as unknown as ContractInfo;
const otc = { ...tse, code: '9998', exchange: 'OTC' } as ContractInfo;
const oes = { ...tse, code: '9997', exchange: 'OES' } as ContractInfo;
const etf = { ...tse, code: '00999' } as ContractInfo;
const base: TradeCostInput = { contract: tse, action: 'Buy', price: 100, qty: 1, odd: false, daytrade: false, orderCond: 'Cash' };
const text = (over: Partial<TradeCostInput>, settings = S()) => tradeCostText({ ...base, ...over }, settings);

describe('現股', () => {
    it('買進：月退且有折扣時列交割與退佣後手續費', () => {
        expect(text({})).toBe('金額 100,000 · 手續費 ≈ 143 · 預估應付 ≈ 100,143（估算）');
        expect(text({}, S({ feeDiscount: 0.28 }))).toBe('金額 100,000 · 手續費 交割 ≈ 143，退佣後 ≈ 40 · 預估應付 ≈ 100,143（估算）');
        // 即折 2.8 折：100,000 × 0.0399% = 39.9 → 40
        expect(text({}, S({ feeDiscount: 0.28, rebateMode: 'instant' }))).toBe('金額 100,000 · 手續費 ≈ 40（2.8 折） · 預估應付 ≈ 100,040（估算）');
    });
    it('賣出：證交稅沿用當沖減半與 ETF 0.1%', () => {
        expect(text({ action: 'Sell' })).toBe('金額 100,000 · 手續費 ≈ 143 · 證交稅 ≈ 300 · 預估應收 ≈ 99,557（估算）');
        expect(text({ action: 'Sell', daytrade: true })).toBe('金額 100,000 · 手續費 ≈ 143 · 證交稅 ≈ 150 · 預估應收 ≈ 99,707（估算）');
        expect(text({ action: 'Sell', contract: etf })).toBe('金額 100,000 · 手續費 ≈ 143 · 證交稅 ≈ 100 · 預估應收 ≈ 99,757（估算）');
        // 月退：應收以交割（牌告）手續費計
        expect(text({ action: 'Sell' }, S({ feeDiscount: 0.6 }))).toBe('金額 100,000 · 手續費 交割 ≈ 143，退佣後 ≈ 86 · 證交稅 ≈ 300 · 預估應收 ≈ 99,557（估算）');
    });
    it('整股最低 20 元、零股最低 1 元', () => {
        // 10 元 × 1 張 = 10,000：牌告 14 → 20；月退 2.8 折 → round(5.6) = 6
        expect(text({ price: 10 }, S({ feeDiscount: 0.28 }))).toBe('金額 10,000 · 手續費 交割 ≈ 20，退佣後 ≈ 6 · 預估應付 ≈ 10,020（估算）');
        expect(text({ price: 10 }, S({ feeDiscount: 0.28, rebateMode: 'instant' }))).toBe('金額 10,000 · 手續費 ≈ 20（2.8 折） · 預估應付 ≈ 10,020（估算）');
        expect(text({ odd: true, qty: 3 })).toBe('金額 300 · 手續費 ≈ 1 · 預估應付 ≈ 301（估算）');
    });
    it('價格或數量不合法回 null', () => {
        expect(text({ price: 0 })).toBeNull();
        expect(text({ qty: 0 })).toBeNull();
        expect(text({ price: Number.NaN })).toBeNull();
    });
});

describe('融資', () => {
    it('買進：上市 6 成、上櫃 5 成，千元以下捨去；有年利率時估每日利息', () => {
        expect(text({ orderCond: 'MarginTrading' })).toBe('金額 100,000 · 手續費 ≈ 143 · 融資金額 ≈ 60,000（上市 6 成估算） · 自備款 ≈ 40,000 · 預估應付 ≈ 40,143 · 設定融資年利率以估算利息（估算）');
        // 33.33 × 1,000 = 33,330：× 0.5 = 16,665 → 16,000；16,000 × 7% ÷ 365 = 3.07 → 3
        expect(text({ orderCond: 'MarginTrading', contract: otc, price: 33.33 }, S({ marginAnnualRate: 0.07 })))
            .toBe('金額 33,330 · 手續費 ≈ 47 · 融資金額 ≈ 16,000（上櫃 5 成估算） · 自備款 ≈ 17,330 · 預估應付 ≈ 17,377 · 每日利息 ≈ 3（估算）');
    });
    it('非上市櫃無法估算融資金額，也不顯示全額應付', () => {
        const t = text({ orderCond: 'MarginTrading', contract: oes })!;
        expect(t).toBe('金額 100,000 · 手續費 ≈ 143 · 融資金額無法估算（僅上市櫃可融資）（估算）');
        expect(t).not.toContain('預估應付');
    });
    it('賣出：註明未扣融資本金與利息', () => {
        expect(text({ orderCond: 'MarginTrading', action: 'Sell' })).toBe('金額 100,000 · 手續費 ≈ 143 · 證交稅 ≈ 300 · 預估應收 ≈ 99,557（估算；未扣融資本金與利息）');
    });
});

describe('融券', () => {
    it('賣出：借券費＝金額 × 借券費率，計入應收', () => {
        expect(text({ orderCond: 'ShortSelling', action: 'Sell' }, S({ shortFeeRate: 0.0012 })))
            .toBe('金額 100,000 · 手續費 ≈ 143 · 證交稅 ≈ 300 · 借券費 ≈ 120 · 預估應收 ≈ 99,437（估算；另需繳融券保證金，未計）');
    });
    it('買進回補：應付＝金額＋手續費，註明保證金與賣出價款另行退還', () => {
        expect(text({ orderCond: 'ShortSelling', action: 'Buy' })).toBe('金額 100,000 · 手續費 ≈ 143 · 預估應付 ≈ 100,143（估算；保證金與賣出價款另行退還，未計）');
    });
});
