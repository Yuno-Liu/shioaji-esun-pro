// 資金與交割行事曆純邏輯：風險指標門檻（比照桌面）、固定 T+0／1／2、資產市值待確認規則
import { describe, expect, it } from 'vitest';
import { marginLooksBlank, marginRisk, settlementSlots, stockAssetSummary, stockPositionKind } from './account-funds';

describe('marginRisk', () => {
    it('is not meaningful without initial margin or indicator', () => {
        expect(marginRisk(undefined)).toMatchObject({ meaningful: false, level: 'none' });
        expect(marginRisk({ initial_margin: 0, risk_indicator: 250 })).toMatchObject({ meaningful: false, level: 'none' });
        expect(marginRisk({ initial_margin: 100, risk_indicator: 0 })).toMatchObject({ meaningful: false, level: 'none' });
    });

    it('uses the desktop thresholds (<100 danger, <200 warn) and a 300% bar scale', () => {
        expect(marginRisk({ initial_margin: 1, risk_indicator: 99.9 })).toMatchObject({ level: 'danger' });
        expect(marginRisk({ initial_margin: 1, risk_indicator: 100 })).toMatchObject({ level: 'warn' });
        expect(marginRisk({ initial_margin: 1, risk_indicator: 199 })).toMatchObject({ level: 'warn' });
        expect(marginRisk({ initial_margin: 1, risk_indicator: 200 })).toMatchObject({ level: 'safe' });
        expect(marginRisk({ initial_margin: 1, risk_indicator: 150 }).barPercent).toBe(50);
        expect(marginRisk({ initial_margin: 1, risk_indicator: 900 }).barPercent).toBe(100);
    });

    it('detects all-zero simulation margin', () => {
        expect(marginLooksBlank({ equity: 0, initial_margin: 0, available_margin: 0, today_balance: 0 })).toBe(true);
        expect(marginLooksBlank({ equity: 1, initial_margin: 0, available_margin: 0, today_balance: 0 })).toBe(false);
        expect(marginLooksBlank(undefined)).toBe(false);
    });
});

describe('settlementSlots', () => {
    it('always returns T+0, T+1, T+2 and fills missing rows with 0', () => {
        const slots = settlementSlots([{ date: '2026-11-09', amount: -500, T: 2 }], Date.UTC(2026, 10, 5, 2));
        expect(slots.map(s => s.t)).toEqual([0, 1, 2]);
        expect(slots.map(s => s.amount)).toEqual([0, 0, -500]);
        expect(slots.map(s => s.reported)).toEqual([false, false, true]);
        expect(slots[2]!.dateLabel).toBe('11/09 (一)');
        expect(slots[0]!.dateLabel).toBe('11/05 (四)');
    });
});

describe('stockAssetSummary', () => {
    const ok = { cash: 1000, liquidation: { value: 5000, incomplete: false }, pending: -200, settlementsStale: false, priorDay: false };

    it('sums liquidation value, pending settlements and cash', () => {
        expect(stockAssetSummary(ok)).toEqual({ total: 5800, reasons: [] });
    });

    it('withholds the total with reasons when anything is uncertain', () => {
        expect(stockAssetSummary({ ...ok, settlementsStale: true }).total).toBeNull();
        expect(stockAssetSummary({ ...ok, priorDay: true }).reasons.join()).toContain('前一日');
        expect(stockAssetSummary({ ...ok, pending: null }).total).toBeNull();
        expect(stockAssetSummary({ ...ok, liquidation: { value: 5000, incomplete: true } }).total).toBeNull();
        expect(stockAssetSummary({ ...ok, cash: null }).reasons.join()).toContain('交割戶餘額');
    });
});

describe('stockPositionKind', () => {
    it('labels stock position kinds', () => {
        expect(stockPositionKind({ cond: 'Cash', direction: 'Buy' })).toBe('現股');
        expect(stockPositionKind({ direction: 'Sell' })).toBe('現股賣');
        expect(stockPositionKind({ cond: 'MarginTrading', direction: 'Buy' })).toBe('融資');
        expect(stockPositionKind({ cond: 'ShortSelling', direction: 'Sell' })).toBe('融券');
    });
});
