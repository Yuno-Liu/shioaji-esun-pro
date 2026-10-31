import { describe, expect, it } from 'vitest';
import { cashOrderCreditWarning, manualStockCreditHint, NO_SHORT_TO_COVER_NOTE, stockExitFor } from './stock-exit-cond';

describe('stockExitFor', () => {
    it('maps holdings to their closing side and condition', () => {
        expect(stockExitFor('Buy', 'Cash', 1500)).toEqual({ exit: 'Sell' });
        expect(stockExitFor('Sell', undefined, 300)).toEqual({ exit: 'Buy' });
        expect(stockExitFor('Sell', 'ShortSelling', 2000)).toEqual({ exit: 'Buy', orderCond: 'ShortSelling' });
        expect(stockExitFor('Buy', 'MarginTrading', 1000)).toEqual({ exit: 'Sell', orderCond: 'MarginTrading' });
    });
    it('refuses what it cannot close correctly (never falls back to 現股)', () => {
        expect(stockExitFor('Sell', 'ShortSelling', 1500)).toContain('整張');
        expect(stockExitFor('Buy', 'MarginTrading', 0)).toContain('整張');
        expect(stockExitFor('Buy', 'ShortSelling', 1000)).toContain('方向與條件不符');
        expect(stockExitFor('Sell', 'MarginTrading', 1000)).toContain('方向與條件不符');
        expect(stockExitFor('Sell', 'SBLShort', 1000)).toContain('借券');
        expect(stockExitFor('Hold', 'Cash', 1000)).toContain('方向不明');
    });
});

describe('cashOrderCreditWarning', () => {
    const acc = { account_type: 'S', broker_id: 'b', account_id: 'a' };
    const short = { code: '1234', direction: 'Sell', cond: 'ShortSelling', account: acc };
    const margin = { code: '1234', direction: 'Buy', cond: 'MarginTrading', account: acc };
    it('warns that a 現股 buy does not cover a short held in the same account', () => {
        expect(cashOrderCreditWarning([short], acc, '1234', ['Buy'])).toContain('現股買進不會回補融券');
        expect(cashOrderCreditWarning([margin], acc, '1234', ['Sell'])).toContain('現股賣出不會了結融資');
        expect(cashOrderCreditWarning([short, margin], acc, '1234', ['Buy', 'Sell'])).toMatch(/回補融券.*了結融資/);
    });
    it('stays quiet for other sides, codes and accounts', () => {
        expect(cashOrderCreditWarning([short], acc, '1234', ['Sell'])).toBeNull();
        expect(cashOrderCreditWarning([short], acc, '2330', ['Buy'])).toBeNull();
        expect(cashOrderCreditWarning([short], { ...acc, account_id: 'other' }, '1234', ['Buy'])).toBeNull();
        expect(cashOrderCreditWarning([{ ...short, cond: 'Cash' }], acc, '1234', ['Buy'])).toBeNull();
        expect(cashOrderCreditWarning([short], null, '1234', ['Buy'])).toBeNull();
    });
});

describe('manualStockCreditHint', () => {
    const acc = { account_type: 'S', broker_id: 'b', account_id: 'a' };
    const short = { code: '1234', direction: 'Sell', cond: 'ShortSelling', account: acc, quantity: 2000 };
    const margin = { code: '1234', direction: 'Buy', cond: 'MarginTrading', account: acc, quantity: 1000 };
    it('a 現股 buy with a short / a 現股 sell with a margin long: hint and suggest the credit condition', () => {
        expect(manualStockCreditHint([short], acc, '1234', 'Buy', 'Cash')).toMatchObject({ suggest: 'ShortSelling' });
        expect(manualStockCreditHint([short], acc, '1234', 'Buy', 'Cash')!.text).toContain('現股買進不會回補融券');
        expect(manualStockCreditHint([margin], acc, '1234', 'Sell', undefined)).toMatchObject({ suggest: 'MarginTrading' });
        expect(manualStockCreditHint([margin], acc, '1234', 'Sell', 'Cash')!.text).toContain('現股賣出不會了結融資');
    });
    it('a 融券 buy without a short of that stock: hint only (no suggestion, no block)', () => {
        expect(manualStockCreditHint([], acc, '1234', 'Buy', 'ShortSelling')).toEqual({ text: NO_SHORT_TO_COVER_NOTE, suggest: null });
        expect(manualStockCreditHint([{ ...short, quantity: 0 }], acc, '1234', 'Buy', 'ShortSelling')!.text).toBe(NO_SHORT_TO_COVER_NOTE);
        expect(manualStockCreditHint([{ ...short, account: { ...acc, account_id: 'x' } }], acc, '1234', 'Buy', 'ShortSelling')!.text).toBe(NO_SHORT_TO_COVER_NOTE);
        expect(manualStockCreditHint([short], acc, '1234', 'Buy', 'ShortSelling')).toBeNull();
    });
    it('stays quiet otherwise, and when positions are not loaded', () => {
        expect(manualStockCreditHint(null, acc, '1234', 'Buy', 'ShortSelling')).toBeNull();
        expect(manualStockCreditHint([short], acc, '1234', 'Sell', 'Cash')).toBeNull();
        expect(manualStockCreditHint([margin], acc, '1234', 'Buy', 'Cash')).toBeNull();
        expect(manualStockCreditHint([short], acc, '2330', 'Buy', 'Cash')).toBeNull();
        expect(manualStockCreditHint([{ ...short, quantity: 0 }], acc, '1234', 'Buy', 'Cash')).toBeNull();
        expect(manualStockCreditHint([margin], acc, '1234', 'Sell', 'MarginTrading')).toBeNull();
        expect(manualStockCreditHint([short], { ...acc, account_type: 'F' }, '1234', 'Buy', 'Cash')).toBeNull();
    });
});
