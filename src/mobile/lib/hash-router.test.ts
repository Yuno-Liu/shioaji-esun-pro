import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, formatRoute, isCanonicalHash, isValidProductCode, parseHash, sameRoute } from './hash-router';

describe('parseHash', () => {
    it('defaults to the watchlist for empty or unknown hashes', () => {
        for (const hash of ['', '#', '#/', '#/nope', '#/orders/extra', 'garbage']) {
            expect(parseHash(hash)).toEqual(DEFAULT_ROUTE);
        }
    });

    it('parses every tab', () => {
        expect(parseHash('#/watchlist')).toEqual({ name: 'watchlist' });
        expect(parseHash('#/orders')).toEqual({ name: 'orders' });
        expect(parseHash('#/positions')).toEqual({ name: 'positions' });
        expect(parseHash('#/account')).toEqual({ name: 'account' });
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
        for (const hash of ['#/watchlist', '#/trade/2330', '#/trade', '#/orders', '#/positions', '#/account']) {
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
