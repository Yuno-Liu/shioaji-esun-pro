// src/lib/esun/account-details.test.ts — 玉山完整帳務資訊的解析、標籤與 store（合成資料）

import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import type { Trade } from '../types/order';
import type { StockProfitLoss } from '../shioaji';
import {
    ESUN_AP_CODE_LABELS,
    ESUN_CELABLE_LABELS,
    ESUN_CREDIT_CODE_LABELS,
    ESUN_DAY_TRADE_CODE_LABELS,
    ESUN_MARKET_LABELS,
    ESUN_ORD_STATUS_LABELS,
    ESUN_TRADE_TYPE_LABELS,
    clearEsunInventoryDetails,
    clearEsunOrderMeta,
    clearEsunTransactionDetails,
    esunAccountDetailKey,
    esunApCodeLabel,
    esunBoolean,
    esunCelableLabel,
    esunCreditCodeLabel,
    esunDate,
    esunDayTradeCodeLabel,
    esunInventoryApCodeLabel,
    esunMarketLabel,
    esunMarketOf,
    esunNumber,
    esunOrdStatusLabel,
    esunOrderMetaOf,
    esunTime,
    esunTimestampIso,
    esunTradeTypeLabel,
    findEsunInventoryDetail,
    findEsunTransactionDetail,
    getEsunInventoryDetailsSnapshot,
    getEsunOrderMeta,
    getEsunTransactionDetailsSnapshot,
    parseEsunBalanceDetail,
    parseEsunInventoryDetail,
    parseEsunInventoryDetails,
    parseEsunInventoryLot,
    parseEsunMarketStatusDetail,
    parseEsunOrderMeta,
    parseEsunRealizedTransactionDetails,
    parseEsunTradeStatusDetail,
    parseEsunTransactionDetail,
    parseEsunTransactionFill,
    setEsunInventoryDetails,
    setEsunOrderMetaSnapshot,
    setEsunTransactionDetails,
    subscribeEsunInventoryDetails,
    subscribeEsunOrderMeta,
    subscribeEsunTransactionDetails,
    useEsunInventoryDetails,
    useEsunOrderMeta,
    useEsunTransactionDetails,
} from './account-details';
import { fromEsunInventoryToPosition, fromEsunTransactionsToProfitLoss } from './order-mapping';
import type { EsunTransactionItem } from './types';

const simAccount = { broker_id: '8840-SIM', account_id: '1234567' };
const prodAccount = { broker_id: '8840', account_id: '1234567' };

afterEach(() => {
    clearEsunInventoryDetails();
    clearEsunOrderMeta();
    clearEsunTransactionDetails();
});

describe('safe parsing', () => {
    it('parses numbers without turning missing values into 0', () => {
        expect(esunNumber(' 12.5 ')).toBe(12.5);
        expect(esunNumber('-300')).toBe(-300);
        expect(esunNumber(0)).toBe(0);
        expect(esunNumber('0')).toBe(0);
        for (const v of ['', '   ', 'abc', 'NaN', 'Infinity', NaN, Infinity, null, undefined, true, {}, []]) {
            expect(esunNumber(v)).toBeNull();
        }
    });

    it('parses booleans', () => {
        expect(esunBoolean(true)).toBe(true);
        expect(esunBoolean(false)).toBe(false);
        expect(esunBoolean(' TRUE ')).toBe(true);
        expect(esunBoolean('false')).toBe(false);
        for (const v of ['', 'yes', 1, 0, null, undefined]) expect(esunBoolean(v)).toBeNull();
    });

    it('formats dates as YYYY-MM-DD and rejects invalid calendar dates', () => {
        expect(esunDate('20261023')).toBe('2026-10-23');
        expect(esunDate(' 2026-10-23 ')).toBe('2026-10-23');
        expect(esunDate(20261023)).toBe('2026-10-23');
        for (const v of ['', '2026/10/23', '20261332', '20260230', '2026102', null, undefined]) expect(esunDate(v)).toBe('');
    });

    it('formats times as HH:MM:SS', () => {
        expect(esunTime('093015')).toBe('09:30:15');
        expect(esunTime('093015123')).toBe('09:30:15');
        expect(esunTime('93015123')).toBe('09:30:15'); // 前導零被去掉
        expect(esunTime('93015')).toBe('09:30:15');
        expect(esunTime('13:25:00')).toBe('13:25:00');
        for (const v of ['', '   ', '9', '246000', '096000', 'abcdef', '0930151234', null, undefined]) expect(esunTime(v)).toBe('');
    });

    it('converts epoch seconds, milliseconds and strings to ISO', () => {
        expect(esunTimestampIso(1792850400)).toBe('2026-10-24T14:00:00.000Z');
        expect(esunTimestampIso(1792850400123)).toBe('2026-10-24T14:00:00.123Z');
        expect(esunTimestampIso('1792850400')).toBe('2026-10-24T14:00:00.000Z');
        expect(esunTimestampIso('2026-10-24T22:00:00+08:00')).toBe('2026-10-24T14:00:00.000Z');
        expect(esunTimestampIso({ seconds: 1792850400 })).toBe('2026-10-24T14:00:00.000Z');
        for (const v of ['', 'not a date', 0, -1, NaN, null, undefined]) expect(esunTimestampIso(v)).toBe('');
    });
});

describe('code labels', () => {
    it('exposes every documented code', () => {
        expect(ESUN_MARKET_LABELS).toEqual({ H: '上市', O: '上櫃', R: '興櫃' });
        expect(ESUN_TRADE_TYPE_LABELS).toEqual({ '0': '現股', '3': '融資', '4': '融券', '9': '信用當沖', A: '現股當沖賣' });
        expect(ESUN_AP_CODE_LABELS).toEqual({ '1': '整股', '2': '盤後定價', '3': '盤後零股', '4': '興櫃', '5': '盤中零股' });
        expect(ESUN_DAY_TRADE_CODE_LABELS).toEqual({ X: '已啟用', Y: '僅可先買後賣', N: '未啟用', S: '暫停中' });
        expect(ESUN_CREDIT_CODE_LABELS).toEqual({ '0': '可買賣', '1': '可買', '2': '可賣', '9': '不可買賣' });
        expect(ESUN_ORD_STATUS_LABELS).toEqual({ '1': '預約單', '2': '盤中單' });
        expect(ESUN_CELABLE_LABELS).toEqual({ '1': '可取消', '2': '不可取消' });
    });

    it('maps known codes, unknown codes and empty values', () => {
        expect(esunMarketLabel('H')).toBe('上市');
        expect(esunMarketLabel('o')).toBe('上櫃');
        expect(esunMarketLabel('Z')).toBe('代碼 Z');
        expect(esunMarketLabel('')).toBe('');
        expect(esunTradeTypeLabel('9')).toBe('信用當沖');
        expect(esunTradeTypeLabel('A')).toBe('現股當沖賣');
        expect(esunTradeTypeLabel('7')).toBe('代碼 7');
        expect(esunTradeTypeLabel(undefined)).toBe('');
        expect(esunApCodeLabel('5')).toBe('盤中零股');
        expect(esunApCodeLabel('')).toBe('');
        expect(esunApCodeLabel('8')).toBe('代碼 8');
        expect(esunInventoryApCodeLabel('')).toBe('整股');
        expect(esunInventoryApCodeLabel(null)).toBe('整股');
        expect(esunInventoryApCodeLabel('5')).toBe('盤中零股');
        expect(esunInventoryApCodeLabel('8')).toBe('代碼 8');
        expect(esunDayTradeCodeLabel('X')).toBe('已啟用');
        expect(esunDayTradeCodeLabel('Y')).toBe('僅可先買後賣');
        expect(esunDayTradeCodeLabel('N')).toBe('未啟用');
        expect(esunDayTradeCodeLabel('S')).toBe('暫停中');
        expect(esunDayTradeCodeLabel('Q')).toBe('代碼 Q');
        expect(esunCreditCodeLabel('0')).toBe('可買賣');
        expect(esunCreditCodeLabel('1')).toBe('可買');
        expect(esunCreditCodeLabel('2')).toBe('可賣');
        expect(esunCreditCodeLabel('9')).toBe('不可買賣');
        expect(esunCreditCodeLabel('5')).toBe('代碼 5');
        expect(esunOrdStatusLabel('1')).toBe('預約單');
        expect(esunOrdStatusLabel('2')).toBe('盤中單');
        expect(esunOrdStatusLabel('3')).toBe('代碼 3');
        expect(esunCelableLabel('1')).toBe('可取消');
        expect(esunCelableLabel('2')).toBe('不可取消');
        expect(esunCelableLabel('')).toBe('');
        expect(esunCelableLabel('x')).toBe('代碼 x');
    });

    it('maps s_type to an exchange', () => {
        expect(esunMarketOf('H')).toBe('TSE');
        expect(esunMarketOf('O')).toBe('OTC');
        expect(esunMarketOf('R')).toBe('OES');
        expect(esunMarketOf('')).toBeNull();
        expect(esunMarketOf('X')).toBeNull();
    });
});

// 合成庫存列（數值為字串，與 SDK 相同）
const lotRaw = {
    buy_sell: 'B', cost_r: '0', fee: '21', make_a: '479', make_a_per: '1.91', ord_no: 'X0001',
    pay_n: '-25021', price: '25.00', price_evn: '25.12', qty: '1000', qty_c: '0', qty_h: '0', qty_r: '0',
    t_date: '20261022', t_time: '', tax: '0', tax_g: '0', trade: '0', value_mkt: '25500', value_now: '25450', user_def: 'memo',
};
const rowRaw = (extra: Record<string, unknown> = {}) => ({
    ap_code: '', cost_qty: '2000', cost_sum: '-50042', make_a_per: '1.91', make_a_sum: '958', price_avg: '25.00',
    price_evn: '25.12', price_mkt: '25.50', price_now: '25.45', price_qty_sum: '50000', qty_b: '1000', qty_bm: '500',
    qty_c: '-100', qty_l: '1000', qty_s: '0', qty_sm: '0', rec_va_sum: '50900', stk_na: '玉山金', stk_no: '2884',
    s_type: 'H', trade: '0', value_mkt: '51000', value_now: '50900', stk_dats: [lotRaw, { ...lotRaw, ord_no: 'X0002', t_time: '093015' }],
    ...extra,
});

describe('inventory parsing', () => {
    it('parses a row and its stk_dats with semantic names', () => {
        const d = parseEsunInventoryDetail(rowRaw(), 3);
        expect(d).toMatchObject({
            rowId: 3, code: '2884', name: '玉山金', tradeType: '0', cond: 'Cash', apCode: '', marketCode: 'H', market: 'TSE',
            costShares: 2000, costSum: -50042, avgPrice: 25, breakEvenPrice: 25.12, marketPrice: 25.5, marketPriceAdjusted: 25.45,
            priceQtySum: 50000, yesterdayShares: 1000, todayBuyShares: 1000, todayBuyFilledShares: 500, todaySellShares: 0,
            todaySellFilledShares: 0, adjustShares: -100, unrealizedIncome: 50900, marketValue: 51000, marketValueAdjusted: 50900,
            unrealizedPnl: 958, unrealizedPnlPct: 1.91,
        });
        expect(d.lots).toHaveLength(2);
        expect(d.lots[0]).toEqual({
            buySell: 'B', action: 'Buy', orderNo: 'X0001', tradeType: '0', tradeDate: '2026-10-22', tradeTime: '',
            price: 25, shares: 1000, adjustShares: 0, highWeightShares: 0, allocatedShares: 0, allocatedCost: 0, fee: 21,
            tax: 0, capitalGainsTax: 0, netAmount: -25021, breakEvenPrice: 25.12, unrealizedPnl: 479, unrealizedPnlPct: 1.91,
            marketValue: 25500, marketValueAdjusted: 25450, userDef: 'memo',
        });
        expect(d.lots[1]?.tradeTime).toBe('09:30:15');
    });

    it('keeps missing values as null / empty, never 0', () => {
        const d = parseEsunInventoryDetail({ stk_no: '1342', cost_qty: '', price_now: 'abc', trade: '3', s_type: 'R' }, 1);
        expect(d).toMatchObject({ code: '1342', name: '', cond: 'MarginTrading', market: 'OES', costShares: null, marketPriceAdjusted: null, unrealizedPnl: null, lots: [] });
        expect(parseEsunInventoryDetail({ trade: '4' }, 1).cond).toBe('ShortSelling');
        const lot = parseEsunInventoryLot({});
        expect(lot).toMatchObject({ buySell: '', action: null, price: null, shares: null, tradeDate: '', tradeTime: '', userDef: '' });
        expect(parseEsunInventoryLot(null).fee).toBeNull();
        expect(parseEsunInventoryDetail(null, 2)).toMatchObject({ rowId: 2, code: '', market: null, lots: [] });
    });

    it('numbers rows like fromEsunInventoryToPosition', () => {
        const rows = [rowRaw(), rowRaw({ ap_code: '5', cost_qty: '30' })];
        const details = parseEsunInventoryDetails(rows);
        const positions = rows.map((r, i) => fromEsunInventoryToPosition(r, 'Common', i + 1));
        expect(details.map(d => d.rowId)).toEqual(positions.map(p => p.id));
    });
});

describe('findEsunInventoryDetail', () => {
    const rows = [
        rowRaw(), // 1：2884 整股現股
        rowRaw({ stk_no: '1342', trade: '3' }), // 2：1342 融資
        rowRaw({ ap_code: '5', cost_qty: '30' }), // 3：2884 盤中零股現股
        rowRaw({ stk_no: '1342', trade: '0' }), // 4：1342 現股
    ];
    const details = parseEsunInventoryDetails(rows);
    // 持倉為 Share 單位（帳務 dock 的 position_unit）
    const pos = (id: number, code: string, cond?: string, quantity = 0, price = 0) => ({ id, code, cond, quantity, price });

    it('matches by code + cond when unique', () => {
        expect(findEsunInventoryDetail(details, pos(99, '1342', 'MarginTrading'))?.rowId).toBe(2);
        expect(findEsunInventoryDetail(details, pos(99, '1342', 'Cash'))?.rowId).toBe(4);
        expect(findEsunInventoryDetail(details, pos(4, '1342'))?.rowId).toBe(4); // cond 缺值視為 Cash
    });

    it('uses StockPosition.id (row order) when code + cond has several rows, checking shares and average price', () => {
        expect(findEsunInventoryDetail(details, pos(1, '2884', 'Cash', 2000, 25))?.apCode).toBe('');
        expect(findEsunInventoryDetail(details, pos(3, '2884', 'Cash', 30, 25.0000000001))?.apCode).toBe('5');
        expect(findEsunInventoryDetail(details, pos(2, '2884', 'Cash', 2000, 25))).toBeNull();
    });

    it('returns null when the row id matches but shares or average price disagree', () => {
        // 股數不符（例如持倉已被成交投影改動，或 Common 單位的張數）
        expect(findEsunInventoryDetail(details, pos(1, '2884', 'Cash', 2, 25))).toBeNull();
        expect(findEsunInventoryDetail(details, pos(1, '2884', 'Cash', 1000, 25))).toBeNull();
        // 均價不符
        expect(findEsunInventoryDetail(details, pos(1, '2884', 'Cash', 2000, 25.05))).toBeNull();
        expect(findEsunInventoryDetail(details, pos(1, '2884', 'Cash', 2000, Number.NaN))).toBeNull();
        // 兩邊均價都缺值視為一致
        const noAvg = parseEsunInventoryDetails([rowRaw({ price_avg: '' }), rowRaw({ ap_code: '5', cost_qty: '30', price_avg: '' })]);
        expect(findEsunInventoryDetail(noAvg, pos(2, '2884', 'Cash', 30, Number.NaN))?.rowId).toBe(2);
    });

    it('returns null without a match', () => {
        expect(findEsunInventoryDetail(details, pos(1, '2330', 'Cash'))).toBeNull();
        expect(findEsunInventoryDetail(details, pos(1, '2884', 'ShortSelling'))).toBeNull();
        expect(findEsunInventoryDetail([], pos(1, '2884', 'Cash'))).toBeNull();
        expect(findEsunInventoryDetail(null, pos(1, '2884', 'Cash'))).toBeNull();
    });
});

describe('balance, trade status and market status', () => {
    it('parses the production balance shape', () => {
        expect(parseEsunBalanceDetail({
            available_balance: 300000, exchange_balance: 1500, stock_pre_save_amount: 20000, is_latest_data: true,
            updated_at: 1792850400, cached: true, cache_age_sec: 4.5,
        })).toEqual({
            availableBalance: 300000, exchangeBalance: 1500, preSaveAmount: 20000, isLatestData: true,
            updatedAt: '2026-10-24T14:00:00.000Z', cached: true, cacheAgeSec: 4.5,
        });
    });

    it('accepts the documented exange_balance spelling and string values', () => {
        const b = parseEsunBalanceDetail({ available_balance: '1000', exange_balance: '25', updated_at: '1792850400123' });
        expect(b).toMatchObject({ availableBalance: 1000, exchangeBalance: 25, updatedAt: '2026-10-24T14:00:00.123Z' });
    });

    it('keeps missing balance fields as null', () => {
        expect(parseEsunBalanceDetail({})).toEqual({
            availableBalance: null, exchangeBalance: null, preSaveAmount: null, isLatestData: null, updatedAt: '', cached: null, cacheAgeSec: null,
        });
        expect(parseEsunBalanceDetail(null).availableBalance).toBeNull();
    });

    it('parses trade status limits and permission codes', () => {
        expect(parseEsunTradeStatusDetail({ trade_limit: 900000, margin_limit: '400000', short_limit: 0, day_trade_code: 'y', margin_code: '1', short_code: '9' })).toEqual({
            tradeLimit: 900000, marginLimit: 400000, shortLimit: 0,
            dayTradeCode: 'Y', dayTradeLabel: '僅可先買後賣',
            marginCode: '1', marginLabel: '可買',
            shortCode: '9', shortLabel: '不可買賣',
        });
        expect(parseEsunTradeStatusDetail({})).toMatchObject({ tradeLimit: null, marginLimit: null, shortLimit: null, dayTradeCode: '', dayTradeLabel: '', marginLabel: '' });
    });

    it('parses market status', () => {
        expect(parseEsunMarketStatusDetail({ is_trading_day: false, last_trading_day: '20261023', next_trading_day: '20261026' }))
            .toEqual({ isTradingDay: false, lastTradingDay: '2026-10-23', nextTradingDay: '2026-10-26' });
        expect(parseEsunMarketStatusDetail({ isTradingDay: true, nextTradingDay: '2026-10-27' }))
            .toEqual({ isTradingDay: true, lastTradingDay: '', nextTradingDay: '2026-10-27' });
        expect(parseEsunMarketStatusDetail({ is_trading_day: 'maybe' }).isTradingDay).toBeNull();
    });
});

describe('inventory store', () => {
    it('keys snapshots by broker_id + account_id (simulation broker ids carry -SIM)', () => {
        expect(esunAccountDetailKey(simAccount)).not.toBe(esunAccountDetailKey(prodAccount));
        const details = parseEsunInventoryDetails([rowRaw()]);
        setEsunInventoryDetails(simAccount, details, 1000);
        expect(getEsunInventoryDetailsSnapshot(simAccount)).toEqual({ details, fetchedAt: 1000 });
        expect(getEsunInventoryDetailsSnapshot(prodAccount)).toBeNull();
        expect(getEsunInventoryDetailsSnapshot(null)).toBeNull();
    });

    it('returns a stable snapshot, replaces it on set and notifies subscribers', () => {
        let calls = 0;
        const stop = subscribeEsunInventoryDetails(() => { calls++; });
        setEsunInventoryDetails(simAccount, [], 1);
        const first = getEsunInventoryDetailsSnapshot(simAccount);
        expect(getEsunInventoryDetailsSnapshot(simAccount)).toBe(first);
        setEsunInventoryDetails(simAccount, parseEsunInventoryDetails([rowRaw()]), 2);
        expect(getEsunInventoryDetailsSnapshot(simAccount)).not.toBe(first);
        expect(getEsunInventoryDetailsSnapshot(simAccount)?.details).toHaveLength(1);
        clearEsunInventoryDetails(simAccount);
        expect(getEsunInventoryDetailsSnapshot(simAccount)).toBeNull();
        clearEsunInventoryDetails(simAccount); // 沒有資料：不通知
        stop();
        setEsunInventoryDetails(simAccount, [], 3);
        expect(calls).toBe(3);
    });

    it('useEsunInventoryDetails re-renders on updates', () => {
        const seen: (number | null)[] = [];
        const Probe = () => {
            const snap = useEsunInventoryDetails(simAccount);
            seen.push(snap ? snap.fetchedAt : null);
            return null;
        };
        let renderer!: ReturnType<typeof create>;
        act(() => { renderer = create(createElement(Probe)); });
        act(() => { setEsunInventoryDetails(simAccount, [], 42); });
        act(() => { setEsunInventoryDetails(prodAccount, [], 43); }); // 其他帳戶：值不變
        expect(seen[0]).toBeNull();
        expect(seen[seen.length - 1]).toBe(42);
        act(() => renderer.unmount());
    });
});

describe('order meta', () => {
    it('parses reservation, dates, time and cancellable', () => {
        expect(parseEsunOrderMeta({ ord_status: '1', pre_ord_no: 'P01', ord_no: '', work_date: '20261026', ord_date: '20261023', ord_time: '183015123', celable: '1' }))
            .toEqual({ reservation: true, pendingReservation: true, workDate: '2026-10-26', orderDate: '2026-10-23', orderTime: '18:30:15', cancellable: true });
        expect(parseEsunOrderMeta({ ord_status: '2', pre_ord_no: '', ord_no: 'A0001', celable: '2', ord_time: '90000500' }))
            .toMatchObject({ reservation: false, pendingReservation: false, cancellable: false, orderTime: '09:00:00', workDate: '' });
        // ord_status 不是 1，但只有預約單號：仍是尚未進入撮合的預約單
        expect(parseEsunOrderMeta({ ord_status: '2', pre_ord_no: 'P02', ord_no: '' })).toMatchObject({ reservation: true, pendingReservation: true });
        // 預約單開盤後有了委託書號：仍是預約來源（徽章），但已可改單
        expect(parseEsunOrderMeta({ ord_status: '2', pre_ord_no: 'P03', ord_no: 'A0003' })).toMatchObject({ reservation: true, pendingReservation: false });
        // ord_status '1' 但已有委託書號：同上
        expect(parseEsunOrderMeta({ ord_status: '1', pre_ord_no: '', ord_no: 'A0004' })).toMatchObject({ reservation: true, pendingReservation: false });
        expect(parseEsunOrderMeta({ celable: '' }).cancellable).toBeNull();
        expect(parseEsunOrderMeta({ celable: '3' }).cancellable).toBeNull();
        expect(parseEsunOrderMeta({ ordStatus: '1', workDate: '20261026', ordTime: '090000000' })).toMatchObject({ reservation: true, workDate: '2026-10-26', orderTime: '09:00:00' });
    });

    const trade = (account: { broker_id: string; account_id: string } | undefined, id: string) =>
        ({ order: { id, seqno: id, ordno: id, action: 'Buy', price: 25, quantity: 1, ...(account ? { account: { ...account, account_type: 'S' } } : {}) } }) as Pick<Trade, 'order'>;

    it('replaces the whole account snapshot and keys rows by esunOrderId', () => {
        setEsunOrderMetaSnapshot(simAccount, [
            { ord_status: '1', pre_ord_no: 'P01', ord_no: '', celable: '1' },
            { ord_status: '2', pre_ord_no: '', ord_no: 'A0001', celable: '2' },
            { ord_status: '2', pre_ord_no: '', ord_no: '' }, // 沒有編號：略過
        ]);
        expect(esunOrderMetaOf(trade(simAccount, 'P01'))?.reservation).toBe(true);
        expect(esunOrderMetaOf(trade(simAccount, 'A0001'))?.cancellable).toBe(false);
        expect(esunOrderMetaOf(trade(prodAccount, 'A0001'))).toBeNull();
        expect(esunOrderMetaOf(trade(undefined, 'A0001'))).toBeNull();
        expect(esunOrderMetaOf(null)).toBeNull();
        expect(getEsunOrderMeta(simAccount, '')).toBeNull();

        setEsunOrderMetaSnapshot(simAccount, [{ ord_status: '2', ord_no: 'A0002', celable: '1' }]);
        expect(esunOrderMetaOf(trade(simAccount, 'P01'))).toBeNull(); // 舊資料不殘留
        expect(esunOrderMetaOf(trade(simAccount, 'A0002'))?.cancellable).toBe(true);
    });

    it('notifies subscribers and drives useEsunOrderMeta', () => {
        let calls = 0;
        const stop = subscribeEsunOrderMeta(() => { calls++; });
        const t = trade(simAccount, 'A0009');
        const seen: (boolean | null | undefined)[] = [];
        const Probe = () => {
            seen.push(useEsunOrderMeta(t)?.cancellable);
            return null;
        };
        let renderer!: ReturnType<typeof create>;
        act(() => { renderer = create(createElement(Probe)); });
        act(() => { setEsunOrderMetaSnapshot(simAccount, [{ ord_no: 'A0009', celable: '1' }]); });
        expect(seen[0]).toBeUndefined();
        expect(seen[seen.length - 1]).toBe(true);
        act(() => renderer.unmount());
        stop();
        expect(calls).toBe(1);
    });
});

describe('transaction details', () => {
    const fillRaw = {
        buy_sell: 'S', c_date: '20261026', db_fee: '0', fee: '38', make: '1450', make_per: '5.71', order_no: 'Y0001',
        pay_n: '26872', price: '26.90', price_qty: '26900', qty: '1000', s_type: 'H', stk_na: '玉山金', stk_no: '2884',
        t_date: '20261022', t_time: '101530', tax: '80', tax_g: '0', trade: '0', user_def: '',
    };
    const sumRaw = (extra: Record<string, unknown> = {}): EsunTransactionItem => ({
        buy_sell: 'S', c_date: '20261026', cost: '-25422', make: '1450', make_per: '5.71', price_avg: '26.90', price_qty: '26900',
        qty: '1000', recv: '26872', s_type: 'H', stk_na: '玉山金', stk_no: '2884', t_date: '20261022', trade: '0',
        mat_dats: [fillRaw], ...extra,
    });

    it('parses a fill', () => {
        expect(parseEsunTransactionFill(fillRaw)).toEqual({
            code: '2884', name: '玉山金', buySell: 'S', action: 'Sell', tradeType: '0', tradeTypeLabel: '現股', marketCode: 'H',
            market: 'TSE', orderNo: 'Y0001', tradeDate: '2026-10-22', tradeTime: '10:15:30', settleDate: '2026-10-26', price: 26.9,
            shares: 1000, priceQty: 26900, fee: 38, shortFee: 0, tax: 80, capitalGainsTax: 0, netAmount: 26872, realizedPnl: 1450,
            realizedPnlPct: 5.71, userDef: '',
        });
        expect(parseEsunTransactionFill({})).toMatchObject({ action: null, price: null, shortFee: null, tradeTime: '', market: null });
    });

    it('parses a summary row with fills, labels and the realized flag', () => {
        const d = parseEsunTransactionDetail(sumRaw(), 1);
        expect(d).toMatchObject({
            rowId: 1, code: '2884', name: '玉山金', buySell: 'S', action: 'Sell', tradeType: '0', tradeTypeLabel: '現股', cond: 'Cash',
            marketCode: 'H', market: 'TSE', tradeDate: '2026-10-22', settleDate: '2026-10-26', profitLossDate: '20261022',
            shares: 1000, avgPrice: 26.9, priceQty: 26900, cost: -25422, income: 26872, realizedPnl: 1450, realizedPnlPct: 5.71, realized: true,
        });
        expect(d.fills).toHaveLength(1);
        expect(parseEsunTransactionDetail(sumRaw({ buy_sell: 'B', make: '0' }), 1).realized).toBe(false);
        expect(parseEsunTransactionDetail(sumRaw({ trade: '9' }), 1)).toMatchObject({ cond: 'MarginTrading', tradeTypeLabel: '信用當沖' });
        expect(parseEsunTransactionDetail(sumRaw({ s_type: 'O', make: '' }), 1)).toMatchObject({ market: 'OTC', realizedPnl: null, realized: false });
        expect(parseEsunTransactionDetail(null, 1)).toMatchObject({ realized: false, fills: [], cost: null });
    });

    const rows: EsunTransactionItem[] = [
        sumRaw({ buy_sell: 'B', make: '0', t_date: '20261021' }), // 建倉：不是已實現
        sumRaw(), // 2884 賣出
        sumRaw({ stk_no: '1342', t_date: '20261023', qty: '40' }),
        sumRaw({ stk_no: '1342', buy_sell: 'S', trade: '4', make: '0' }), // 融券賣出建倉：不是已實現
        sumRaw({ stk_no: '2885', buy_sell: 'B', trade: '4', t_date: '20261023' }), // 融券回補
    ];

    it('keeps only realized rows, in the same order as fromEsunTransactionsToProfitLoss', () => {
        const details = parseEsunRealizedTransactionDetails(rows);
        const pl = fromEsunTransactionsToProfitLoss(rows);
        expect(details.map(d => [d.rowId, d.code, d.profitLossDate])).toEqual(pl.map(r => [r.id, r.code, r.date]));
        expect(details.map(d => d.code)).toEqual(['2884', '1342', '2885']);
        for (const row of pl) expect(findEsunTransactionDetail(details, row)?.rowId).toBe(row.id);
    });

    it('findEsunTransactionDetail checks the credit condition (missing cond means Cash)', () => {
        const details = parseEsunRealizedTransactionDetails(rows);
        const row = (id: number, code: string, date: string, cond?: string) =>
            ({ id, code, date, cond }) as Pick<StockProfitLoss, 'id' | 'code' | 'date' | 'cond'>;
        expect(findEsunTransactionDetail(details, row(1, '2884', '20261022', 'Cash'))?.rowId).toBe(1);
        expect(findEsunTransactionDetail(details, row(1, '2884', '20261022', undefined))?.rowId).toBe(1);
        expect(findEsunTransactionDetail(details, row(1, '2884', '20261022', 'MarginTrading'))).toBeUndefined();
        // 2885 融券回補（trade 4）→ ShortSelling；cond 缺值視為 Cash → 不一致
        expect(findEsunTransactionDetail(details, row(3, '2885', '20261023', 'ShortSelling'))?.rowId).toBe(3);
        expect(findEsunTransactionDetail(details, row(3, '2885', '20261023'))).toBeUndefined();
    });

    it('findEsunTransactionDetail checks code and date', () => {
        const details = parseEsunRealizedTransactionDetails(rows);
        const row = (id: number, code: string, date: string) => ({ id, code, date }) as Pick<StockProfitLoss, 'id' | 'code' | 'date' | 'cond'>;
        expect(findEsunTransactionDetail(details, row(2, '1342', '20261023'))?.code).toBe('1342');
        expect(findEsunTransactionDetail(details, row(2, '1342', '2026-10-23'))?.code).toBe('1342');
        expect(findEsunTransactionDetail(details, row(2, '2884', '20261023'))).toBeUndefined();
        expect(findEsunTransactionDetail(details, row(2, '1342', '20261022'))).toBeUndefined();
        expect(findEsunTransactionDetail(details, row(9, '1342', '20261023'))).toBeUndefined();
        expect(findEsunTransactionDetail(details, row(0, '2884', '20261022'))).toBeUndefined();
        expect(findEsunTransactionDetail(null, row(1, '2884', '20261022'))).toBeUndefined();
    });

    it('stores snapshots by account + range and drives useEsunTransactionDetails', () => {
        let calls = 0;
        const stop = subscribeEsunTransactionDetails(() => { calls++; });
        const details = parseEsunRealizedTransactionDetails(rows);
        setEsunTransactionDetails(simAccount, '20261001', '20261023', details, 5);
        expect(getEsunTransactionDetailsSnapshot(simAccount, '20261001', '20261023'))
            .toEqual({ details, fetchedAt: 5, beginDate: '20261001', endDate: '20261023' });
        expect(getEsunTransactionDetailsSnapshot(simAccount, '20261023', '20261023')).toBeNull();
        expect(getEsunTransactionDetailsSnapshot(prodAccount, '20261001', '20261023')).toBeNull();

        const seen: (number | null)[] = [];
        const Probe = () => {
            const snap = useEsunTransactionDetails(simAccount, '20261023', '20261023');
            seen.push(snap ? snap.details.length : null);
            return null;
        };
        let renderer!: ReturnType<typeof create>;
        act(() => { renderer = create(createElement(Probe)); });
        act(() => { setEsunTransactionDetails(simAccount, '20261023', '20261023', details.slice(0, 1)); });
        expect(seen[0]).toBeNull();
        expect(seen[seen.length - 1]).toBe(1);
        act(() => renderer.unmount());

        clearEsunTransactionDetails(simAccount);
        expect(getEsunTransactionDetailsSnapshot(simAccount, '20261001', '20261023')).toBeNull();
        stop();
        expect(calls).toBe(3);
    });
});
