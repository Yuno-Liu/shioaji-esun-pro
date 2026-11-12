// lib/limit-hit（與 quote-display 的 limitHit 包裝）：漲停／跌停判斷（半個最小跳動的容差、缺少漲跌停、指數、試撮）。
import { describe, expect, it } from 'vitest';
import { LIMIT_TOLERANCE, quoteLimit } from './limit-hit';
import { limitHit } from './quote-display';

describe('limitHit', () => {
    it('成交價等於漲停／跌停價', () => {
        expect(limitHit(1175, 1175, 963)).toBe('up');
        expect(limitHit(963, 1175, 963)).toBe('down');
        expect(limitHit(1170, 1175, 963)).toBeNull();
    });

    it('不用浮點數相等：差距小於半個最小跳動（0.005）視為相等，一個跳動（0.01）不算', () => {
        expect(LIMIT_TOLERANCE).toBe(0.005);
        // 0.1 + 0.2 之類的浮點誤差
        expect(limitHit(0.1 + 0.2, 0.3, 0.2)).toBe('up');
        expect(limitHit(10.45 * 3, 31.35, 25.65)).toBe('up');
        expect(limitHit(9.0049, 9.01, 8.99)).toBe(null);
        expect(limitHit(9.0051, 9.01, 7)).toBe('up');
        expect(limitHit(9.0, 9.01, 7.37)).toBeNull();
        expect(limitHit(7.38, 9.01, 7.37)).toBeNull();
    });

    it('漲跌停以字串送來也可判斷；缺少、0、非數字時不判斷', () => {
        expect(limitHit(110, '110', '90')).toBe('up');
        expect(limitHit(90, '110.00', '90.00')).toBe('down');
        expect(limitHit(110, undefined, undefined)).toBeNull();
        expect(limitHit(0, 0, 0)).toBeNull();
        expect(limitHit(100, 0, 0)).toBeNull();
        expect(limitHit(100, 'x', null)).toBeNull();
    });

    it('價格無效時不判斷', () => {
        expect(limitHit(null, 110, 90)).toBeNull();
        expect(limitHit(undefined, 110, 90)).toBeNull();
        expect(limitHit(Number.NaN, 110, 90)).toBeNull();
        expect(limitHit(-90, 110, 90)).toBeNull();
    });
});

describe('quoteLimit', () => {
    const stock = { security_type: 'STK', limit_up: 110, limit_down: 90 };

    it('股票、期權依合約漲跌停', () => {
        expect(quoteLimit(stock, 110)).toBe('up');
        expect(quoteLimit(stock, 90)).toBe('down');
        expect(quoteLimit({ security_type: 'FUT', limit_up: 25080, limit_down: 20520 }, 20520)).toBe('down');
        expect(quoteLimit(stock, 100)).toBeNull();
    });

    it('指數、試撮、沒有合約或沒有漲跌停時不標示', () => {
        expect(quoteLimit({ security_type: 'IND', limit_up: 110, limit_down: 90 }, 110)).toBeNull();
        expect(quoteLimit(stock, 110, true)).toBeNull();
        expect(quoteLimit(undefined, 110)).toBeNull();
        expect(quoteLimit(null, 110)).toBeNull();
        expect(quoteLimit({ security_type: 'STK' }, 110)).toBeNull();
        expect(quoteLimit({ security_type: 'STK', limit_up: 0, limit_down: 0 }, 110)).toBeNull();
    });
});

describe('quoteLimit：選擇權與興櫃不判（2026-11-13 稽核）', () => {
    it('選擇權：跌停只是最小跳動的地板，價格等於停板價也不標示', () => {
        expect(quoteLimit({ security_type: 'OPT', exchange: 'TAIFEX', limit_up: 1500, limit_down: 0.1 }, 0.1)).toBeNull();
        expect(quoteLimit({ security_type: 'OPT', exchange: 'TAIFEX', limit_up: 1500, limit_down: 0.1 }, 1500)).toBeNull();
    });

    it('興櫃：沒有漲跌停', () => {
        expect(quoteLimit({ security_type: 'STK', exchange: 'OES', limit_up: 110, limit_down: 90 }, 110)).toBeNull();
    });

    it('上市股票、期貨照常判斷', () => {
        expect(quoteLimit({ security_type: 'STK', exchange: 'TSE', limit_up: 110, limit_down: 90 }, 110)).toBe('up');
        expect(quoteLimit({ security_type: 'FUT', exchange: 'TAIFEX', limit_up: 25000, limit_down: 20000 }, 20000)).toBe('down');
    });
});
