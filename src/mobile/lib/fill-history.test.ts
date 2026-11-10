// 成交明細純函式：玉山攤平與淨收付正負號、交易類別、永豐估算（整股、零股、賣出稅）、總計與三種排序。
import { describe, expect, it } from 'vitest';
import type { EsunTransactionDetail, EsunTransactionFill } from '../../lib/esun';
import type { TradingCostSettings } from '../../lib/trading-cost-settings';
import type { Trade } from '../../lib/types/order';
import {
    fillTotals,
    fromEsunDetails,
    fromSinopacDeals,
    groupFillsByDate,
    sortFillRecords,
    summarizeByDate,
    summarizeByStock,
    type FillRecord,
} from './fill-history';
import type { DealRow } from './order-fills';

function fill(p: Partial<EsunTransactionFill>): EsunTransactionFill {
    return {
        code: '', name: '', buySell: '', action: null, tradeType: '', tradeTypeLabel: '', marketCode: '', market: null,
        orderNo: '', tradeDate: '', tradeTime: '', settleDate: '', price: null, shares: null, priceQty: null,
        fee: null, shortFee: null, tax: null, capitalGainsTax: null, netAmount: null, realizedPnl: null, realizedPnlPct: null, userDef: '',
        ...p,
    };
}

function detail(p: Partial<EsunTransactionDetail>): EsunTransactionDetail {
    return {
        rowId: 1, code: '2330', name: '台積電', buySell: 'B', action: 'Buy', tradeType: '0', tradeTypeLabel: '現股', cond: 'Cash',
        marketCode: 'H', market: 'TSE', tradeDate: '2026-11-03', settleDate: '2026-11-05', profitLossDate: '20261103',
        shares: null, avgPrice: null, priceQty: null, cost: null, income: null, realizedPnl: null, realizedPnlPct: null, realized: false,
        fills: [],
        ...p,
    };
}

describe('fromEsunDetails', () => {
    it('flattens multiple fills with the row name, code and trade type; fill side wins', () => {
        const recs = fromEsunDetails([
            detail({
                fills: [
                    fill({ orderNo: 'A1', tradeDate: '2026-11-03', tradeTime: '09:01:00', price: 600, shares: 1000, priceQty: 600000, fee: 855, netAmount: -600855 }),
                    fill({ orderNo: 'A2', buySell: 'S', action: 'Sell', tradeDate: '2026-11-03', tradeTime: '10:00:00', price: 610, shares: 1000, priceQty: 610000, fee: 869, tax: 1830, netAmount: 607301 }),
                ],
            }),
        ]);
        expect(recs).toHaveLength(2);
        expect(recs[0]).toMatchObject({ broker: 'esun', code: '2330', name: '台積電', action: 'Buy', tradeTypeLabel: '現股', orderNo: 'A1', time: '09:01:00', amount: 600000, fee: 855, net: -600855, estimated: false, realizedPnl: null });
        expect(recs[1]).toMatchObject({ action: 'Sell', orderNo: 'A2', tax: 1830, net: 607301 });
    });

    it('uses the row itself when there are no fills (net derived from amount)', () => {
        const [buy, sell] = fromEsunDetails([
            detail({ shares: 2000, avgPrice: 25, priceQty: 50000 }),
            detail({ rowId: 2, code: '2884', name: '玉山金', buySell: 'S', action: 'Sell', shares: 1000, avgPrice: 26, priceQty: 26000, realized: true, realizedPnl: 1000 }),
        ]);
        expect(buy).toMatchObject({ code: '2330', price: 25, shares: 2000, amount: 50000, fee: 0, net: -50000, time: null, orderNo: '', tradeDate: '2026-11-03' });
        expect(sell).toMatchObject({ code: '2884', action: 'Sell', net: 26000, realizedPnl: 1000 });
    });

    it('uses the broker pay_n as-is, sign included (short sale margin is a debit, a cover refunds); derives net only for cash rows', () => {
        const recs = fromEsunDetails([
            // 現股買進：扣款（玉山資料一致：pay_n＝−(價金＋手續費)）
            detail({ fills: [fill({ price: 10, shares: 1000, priceQty: 10000, fee: 20, netAmount: -10020 })] }),
            // 融券賣出：繳保證金（扣款，負數）——原本取絕對值再依賣出給正號，會被顯示成收款
            detail({ action: 'Sell', buySell: 'S', tradeType: '4', tradeTypeLabel: '融券', cond: 'ShortSelling',
                fills: [fill({ price: 100, shares: 1000, priceQty: 100000, fee: 142, tax: 300, shortFee: 80, netAmount: -90000 })] }),
            // 融券買進回補：退回保證金與擔保價款（入帳，正數）——原本依買進給負號，會被顯示成付款
            detail({ tradeType: '4', tradeTypeLabel: '融券', cond: 'ShortSelling', realized: true, realizedPnl: 5000,
                fills: [fill({ price: 95, shares: 1000, priceQty: 95000, fee: 135, netAmount: 104523, realizedPnl: 5000 })] }),
            // 現股賣出、缺 pay_n：以公式推算（估）
            detail({ action: 'Sell', buySell: 'S', fills: [fill({ price: 10, shares: 1000, priceQty: 10000, fee: 20, tax: 30, capitalGainsTax: 5, shortFee: 8 })] }),
            // 現股買進、缺 pay_n 與 price_qty：價金＝價×量
            detail({ fills: [fill({ price: 10, shares: 1000, fee: 20, tax: 0 })] }),
            // 融資買進、缺 pay_n：自備款由券商計算，無從推算 → null
            detail({ tradeType: '3', tradeTypeLabel: '融資', cond: 'MarginTrading', fills: [fill({ price: 50, shares: 1000, priceQty: 50000, fee: 71 })] }),
        ]);
        expect(recs.map(r => r.net)).toEqual([-10020, -90000, 104523, 10000 - 20 - 30 - 13, -10020, null]);
        expect(recs.map(r => r.estimated)).toEqual([false, false, false, true, true, false]);
        expect(recs[3]).toMatchObject({ otherFees: 13 });
        expect(recs[4]!.amount).toBe(10000);
        // 合計只加有值的淨收付，另計無法得知的筆數
        expect(fillTotals(recs)).toMatchObject({ net: -10020 - 90000 + 104523 + 9937 - 10020, netUnknown: 1 });
    });

    it('keeps the credit trade types and realized P&L only on realized rows (no double counting)', () => {
        const recs = fromEsunDetails([
            detail({ tradeType: '3', tradeTypeLabel: '融資', fills: [fill({ price: 50, shares: 1000, priceQty: 50000 })] }),
            detail({ action: 'Sell', buySell: 'S', tradeType: '4', tradeTypeLabel: '融券', fills: [fill({ price: 50, shares: 1000, priceQty: 50000 })] }),
            // 融券買回：買進但為已實現列
            detail({ tradeType: '4', tradeTypeLabel: '融券', realized: true, realizedPnl: 800, fills: [fill({ price: 49, shares: 1000, priceQty: 49000, realizedPnl: 800 })] }),
            // 信用當沖賣出：兩筆逐筆都沒有 make → 列的 make 只記在第一筆
            detail({ action: 'Sell', buySell: 'S', tradeType: '9', tradeTypeLabel: '信用當沖', realized: true, realizedPnl: 1200, fills: [fill({ price: 51, shares: 500 }), fill({ price: 51, shares: 500 })] }),
            detail({ action: 'Sell', buySell: 'S', tradeType: 'A', tradeTypeLabel: '現股當沖賣', realized: true, realizedPnl: 300, fills: [fill({ price: 20, shares: 1000, realizedPnl: 100 }), fill({ price: 20, shares: 1000, realizedPnl: 200 })] }),
            detail({ action: null, buySell: '', fills: [fill({ price: 1, shares: 1 })] }), // 沒有買賣別：略過
        ]);
        expect(recs.map(r => [r.tradeTypeLabel, r.action, r.realizedPnl])).toEqual([
            ['融資', 'Buy', null],
            ['融券', 'Sell', null],
            ['融券', 'Buy', 800],
            ['信用當沖', 'Sell', 1200],
            ['信用當沖', 'Sell', null],
            ['現股當沖賣', 'Sell', 100],
            ['現股當沖賣', 'Sell', 200],
        ]);
        expect(fillTotals(recs).realizedPnl).toBe(2300);
    });
});

describe('fromSinopacDeals', () => {
    const NOW = Date.UTC(2026, 10, 9, 2, 0, 0); // 2026-11-09 10:00 台北
    const settings: TradingCostSettings = { feeDiscount: 0.6, rebateMode: 'monthly', marginAnnualRate: null, shortFeeRate: 0.0008 };
    function row(p: { code: string; action: 'Buy' | 'Sell'; price: number | null; qty: number; lot?: string; type?: string; cond?: string; ts?: number; name?: string; daytradeShort?: boolean }): DealRow {
        const trade = {
            contract: { code: p.code, security_type: p.type ?? 'STK', exchange: 'TSE', target_code: null, ...(p.name ? { name: p.name } : {}) },
            order: { id: `id-${p.code}`, seqno: 's', ordno: `N${p.code}`, action: p.action, price: p.price ?? 0, quantity: p.qty, order_type: 'ROD', price_type: 'LMT', order_lot: p.lot ?? 'Common', order_cond: p.cond, daytrade_short: p.daytradeShort },
            status: { id: 'x', status: 'Filled', status_code: '', msg: '', order_quantity: p.qty, deal_quantity: p.qty, cancel_quantity: 0, modified_price: 0, deals: [] },
        } as unknown as Trade;
        return { key: p.code, trade, deal: null, price: p.price, quantity: p.qty, ts: p.ts ?? 0, unit: '張', aggregate: false };
    }

    it('estimates fee on whole lots and odd lots, sell tax by contract, and marks everything estimated; credit trades have no net', () => {
        const recs = fromSinopacDeals([
            row({ code: '2330', action: 'Buy', price: 600, qty: 1, ts: NOW / 1000 - 3600, name: '台積電' }),
            row({ code: '2330', action: 'Buy', price: 600, qty: 10, lot: 'IntradayOdd' }),
            row({ code: '2317', action: 'Sell', price: 150.5, qty: 2, cond: 'MarginTrading' }),
            row({ code: '0050', action: 'Sell', price: 180, qty: 1, cond: 'ShortSelling' }),
            row({ code: '2603', action: 'Sell', price: 100, qty: 1, daytradeShort: true }),
        ], { settings, now: NOW });
        expect(recs.map(r => [r.code, r.shares, r.amount, r.fee, r.tax, r.net, r.tradeTypeLabel])).toEqual([
            ['2330', 1000, 600000, 855, 0, -600855, '現股'],
            ['2330', 10, 6000, 9, 0, -6009, '現股'],
            // 信用交易：交割金額牽涉融資金額與保證金（融券賣出是扣保證金），永豐沒有資料 → 不估算淨收付
            ['2317', 2000, 301000, 429, 903, null, '融資'],
            ['0050', 1000, 180000, 257, 180, null, '融券'], // ETF 0.1%
            ['2603', 1000, 100000, 143, 300, 100000 - 143 - 300, '當沖先賣'], // 不判斷當沖減半
        ]);
        expect(recs.every(r => r.estimated && r.realizedPnl === null && r.broker === 'sinopac' && r.tradeDate === '2026-11-09')).toBe(true);
        expect(recs[0]).toMatchObject({ time: '09:00:00', name: '台積電', orderNo: 'N2330' });
        expect(recs[1]).toMatchObject({ time: null, name: '' });
    });

    it('skips futures, options and rows without a price', () => {
        const recs = fromSinopacDeals([
            row({ code: 'TXFL6', action: 'Buy', price: 23000, qty: 1, type: 'FUT' }),
            row({ code: 'TXO', action: 'Buy', price: 50, qty: 1, type: 'OPT' }),
            row({ code: '2330', action: 'Buy', price: null, qty: 1 }),
        ], { settings, now: NOW });
        expect(recs).toEqual([]);
    });

    it('uses 0.3% when the contract code is missing', () => {
        const [r] = fromSinopacDeals([row({ code: '', action: 'Sell', price: 100, qty: 1 })], { settings, now: NOW });
        expect(r!.tax).toBe(300);
    });
});

function rec(p: Partial<FillRecord>): FillRecord {
    return {
        broker: 'esun', tradeDate: '2026-11-03', time: null, code: '2330', name: '台積電', action: 'Buy', tradeTypeLabel: '現股',
        price: 0, shares: 0, amount: 0, fee: 0, tax: 0, otherFees: 0, net: 0, realizedPnl: null, orderNo: '', estimated: false,
        ...p,
    };
}

describe('totals and summaries', () => {
    const records = [
        rec({ code: '2330', action: 'Buy', shares: 1000, amount: 600000, fee: 855, net: -600855 }),
        rec({ code: '2330', action: 'Sell', shares: 1000, amount: 610000, fee: 869, tax: 1830, net: 607301, realizedPnl: 8000, tradeDate: '2026-11-05', time: '10:00:00' }),
        rec({ code: '2884', name: '玉山金', action: 'Sell', shares: 2000, amount: 52000, fee: 74, tax: 156, otherFees: 10, net: 51760, realizedPnl: -500, tradeDate: '2026-11-04' }),
        rec({ code: '1101', name: '', action: 'Buy', shares: 10, amount: 400, fee: 1, net: -401, tradeDate: '2026-11-05', time: '09:00:00', estimated: true }),
    ];

    it('fillTotals sums both sides, costs and only known P&L', () => {
        expect(fillTotals(records)).toEqual({
            count: 4, buyShares: 1010, buyAmount: 600400, sellShares: 3000, sellAmount: 662000,
            fee: 1799, tax: 1986, otherFees: 10, net: -600855 + 607301 + 51760 - 401, netUnknown: 0, realizedPnl: 7500, estimated: true,
        });
        expect(fillTotals([records[0]!]).realizedPnl).toBeNull();
        expect(fillTotals([]).count).toBe(0);
        // 淨收付無法得知的筆不計入合計，另計 netUnknown
        expect(fillTotals([rec({ net: null }), rec({ net: -100 })])).toMatchObject({ count: 2, net: -100, netUnknown: 1 });
    });

    it('summarizeByStock: one row per code, sorted by |net| descending', () => {
        const rows = summarizeByStock(records);
        expect(rows.map(r => [r.code, r.name, r.count, r.net, r.realizedPnl])).toEqual([
            ['2884', '玉山金', 1, 51760, -500],
            ['2330', '台積電', 2, 6446, 8000],
            ['1101', '', 1, -401, null],
        ]);
    });

    it('summarizeByDate: one row per day, newest first', () => {
        expect(summarizeByDate(records).map(r => [r.date, r.count, r.buyAmount, r.sellAmount])).toEqual([
            ['2026-11-05', 2, 400, 610000],
            ['2026-11-04', 1, 0, 52000],
            ['2026-11-03', 1, 600000, 0],
        ]);
    });

    it('sortFillRecords: newest day first, newest time first, rows without time last; groups keep the order', () => {
        const sorted = sortFillRecords([
            ...records,
            rec({ code: '9999', tradeDate: '2026-11-05', time: null }),
            rec({ code: '8888', tradeDate: '2026-11-05', time: '13:00:00' }),
        ]);
        expect(sorted.map(r => `${r.tradeDate} ${r.time ?? '-'} ${r.code}`)).toEqual([
            '2026-11-05 13:00:00 8888',
            '2026-11-05 10:00:00 2330',
            '2026-11-05 09:00:00 1101',
            '2026-11-05 - 9999',
            '2026-11-04 - 2884',
            '2026-11-03 - 2330',
        ]);
        expect(groupFillsByDate(sorted).map(g => [g.date, g.records.length])).toEqual([['2026-11-05', 4], ['2026-11-04', 1], ['2026-11-03', 1]]);
    });
});
