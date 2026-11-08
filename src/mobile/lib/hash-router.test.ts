import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, formatRoute, isCanonicalHash, isValidProductCode, MOBILE_TABS, parseHash, sameRoute } from './hash-router';

describe('parseHash', () => {
    it('defaults to the watchlist for empty or unknown hashes', () => {
        for (const hash of ['', '#', '#/', '#/nope', '#/orders/extra', '#/sector/extra', '#/sector/signals', '#/market/nope', '#/market/signals/x', 'garbage']) {
            expect(parseHash(hash)).toEqual(DEFAULT_ROUTE);
        }
    });

    it('parses every tab', () => {
        expect(parseHash('#/watchlist')).toEqual({ name: 'watchlist' });
        expect(parseHash('#/orders')).toEqual({ name: 'orders' });
        expect(parseHash('#/positions')).toEqual({ name: 'positions' });
        expect(parseHash('#/account')).toEqual({ name: 'account' });
        expect(parseHash('#/market')).toEqual({ name: 'market', segment: 'flow' });
        expect(parseHash('/market/signals/')).toEqual({ name: 'market', segment: 'signals' });
        expect(parseHash('#/market/signals?x=1')).toEqual({ name: 'market', segment: 'signals' });
    });

    it('舊書籤 #/sector → 市場分頁的產業流向分段（非正規，App 以 replace 改寫為 #/market）', () => {
        expect(parseHash('#/sector')).toEqual({ name: 'market', segment: 'flow' });
        expect(parseHash('/sector/')).toEqual({ name: 'market', segment: 'flow' });
        expect(isCanonicalHash('#/sector')).toBe(false);
        expect(formatRoute(parseHash('#/sector'))).toBe('#/market');
    });

    it('6 個分頁：市場在交易之後', () => {
        expect(MOBILE_TABS).toEqual(['watchlist', 'trade', 'market', 'orders', 'positions', 'account']);
    });

    it('parses the trade route with a product code', () => {
        expect(parseHash('#/trade/2330')).toEqual({ name: 'trade', code: '2330' });
        expect(parseHash('#/trade/TXFR1')).toEqual({ name: 'trade', code: 'TXFR1' });
        expect(parseHash('/trade/00878/')).toEqual({ name: 'trade', code: '00878' });
        expect(parseHash('#/trade/2330?from=watchlist')).toEqual({ name: 'trade', code: '2330' });
    });

    it('drops invalid product codes instead of passing them on', () => {
        expect(parseHash('#/trade')).toEqual({ name: 'trade', code: null });
        expect(parseHash('#/trade/%E0%A4%A')).toEqual({ name: 'trade', code: null }); // 無法解碼
        expect(parseHash('#/trade/<script>')).toEqual({ name: 'trade', code: null });
        expect(parseHash('#/trade/a%20b')).toEqual({ name: 'trade', code: null });
        expect(parseHash('#/trade/2330/extra')).toEqual({ name: 'trade', code: null });
        expect(parseHash(`#/trade/${'1'.repeat(33)}`)).toEqual({ name: 'trade', code: null });
    });
});

describe('formatRoute', () => {
    it('round-trips every route', () => {
        for (const hash of ['#/watchlist', '#/trade/2330', '#/trade', '#/market', '#/market/signals', '#/orders', '#/positions', '#/account']) {
            expect(formatRoute(parseHash(hash))).toBe(hash);
        }
    });

    it('never emits an invalid code', () => {
        expect(formatRoute({ name: 'trade', code: '../x' })).toBe('#/trade');
        expect(formatRoute({ name: 'trade', code: null })).toBe('#/trade');
    });

    it('detects canonical hashes and compares routes', () => {
        expect(isCanonicalHash('#/orders')).toBe(true);
        expect(isCanonicalHash('')).toBe(false);
        expect(isCanonicalHash('#/trade/2330/')).toBe(false);
        expect(sameRoute(parseHash('#/trade/2330'), { name: 'trade', code: '2330' })).toBe(true);
        expect(sameRoute(parseHash('#/trade/2330'), { name: 'trade', code: '2317' })).toBe(false);
    });

    it('validates product codes', () => {
        expect(isValidProductCode('2330')).toBe(true);
        expect(isValidProductCode('TXO22000L6')).toBe(true);
        expect(isValidProductCode('')).toBe(false);
        expect(isValidProductCode('23 30')).toBe(false);
    });
});
