// 走勢圖「漲跌停範圍」可用條件（lib/chart-limit-range hasLimitRange）
import { describe, expect, it } from 'vitest';
import { hasLimitRange } from './chart-limit-range';

describe('hasLimitRange', () => {
    const stk = { security_type: 'STK', exchange: 'TSE', limit_up: 110, limit_down: 90 };

    it('有正數漲跌停的股票、期貨可用', () => {
        expect(hasLimitRange(stk)).toBe(true);
        expect(hasLimitRange({ ...stk, security_type: 'FUT', exchange: 'TAIFEX' })).toBe(true);
    });

    it('指數、興櫃（沒有漲跌停）、漲跌停缺少或不合理時不可用', () => {
        expect(hasLimitRange({ ...stk, security_type: 'IND' })).toBe(false);
        expect(hasLimitRange({ ...stk, exchange: 'OES' })).toBe(false);
        expect(hasLimitRange({ ...stk, limit_up: 0, limit_down: 0 })).toBe(false);
        expect(hasLimitRange({ ...stk, limit_up: 90, limit_down: 110 })).toBe(false);
    });
});
