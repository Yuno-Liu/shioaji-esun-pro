import { afterEach, describe, expect, it } from 'vitest';
import { clearEsunInventoryDetails, parseEsunInventoryDetails, setEsunInventoryDetails } from './esun';
import {
    isPriorTaipeiDay,
    pendingSettlementAmount,
    settlementsOlderThanPositions,
    stockPositionsSignature,
    stockLiquidationValue,
    stockMarketValue,
    sumStockLiquidationValue,
    sumStockMarketValue,
    type ValuedStockPosition,
} from './position-value';
import type { Account } from './types/portfolio';

// 全部為合成資料（帳號、代號、金額皆非真實）
const esun: Account = { account_type: 'S', broker_id: '8840', account_id: 'T0001', person_id: '', signed: true, username: '' };
const sinopac: Account = { account_type: 'S', broker_id: '9A95', account_id: 'S0001', person_id: '', signed: true, username: '' };
const row = (extra: Partial<ValuedStockPosition> & Record<string, unknown> = {}): ValuedStockPosition => ({
    id: 1, code: '2603', direction: 'Buy', quantity: 2000, price: 200, last_price: 500, pnl: 0, yd_quantity: 2000, cond: 'Cash', ...extra,
} as ValuedStockPosition);
const short = (extra: Partial<ValuedStockPosition> & Record<string, unknown> = {}) =>
    row({ id: 2, code: '1234', direction: 'Sell', cond: 'ShortSelling', price: 380.5, last_price: 392, pnl: -28537, account: esun, ...extra });
// rowId 依列序：1＝2603 現股、2＝1234 融券（與 row／short 的 id 相同，同一批查詢）
const shortDetail = (costQty = '2000') => parseEsunInventoryDetails([
    { stk_no: '2603', trade: '0', s_type: 'H', cost_qty: '2000', cost_sum: '400000', price_avg: '200' },
    { stk_no: '1234', trade: '4', s_type: 'O', cost_qty: costQty, cost_sum: '-685000', make_a_sum: '-28537', price_avg: '380.50', value_mkt: '784000' },
]);

afterEach(() => clearEsunInventoryDetails());

describe('stockMarketValue', () => {
    it('counts short positions as positive gross value', () => {
        expect(stockMarketValue(short())).toBe(784000);
        expect(sumStockMarketValue([row(), short()])).toEqual({ value: 1_000_000 + 784000, incomplete: false });
        expect(sumStockMarketValue([short()]).value).toBe(784000);
    });
    it('skips non-finite rows and flags incomplete instead of spreading NaN', () => {
        expect(stockMarketValue(row({ last_price: NaN }))).toBeNull();
        const sum = sumStockMarketValue([row(), row({ id: 3, last_price: NaN })]);
        expect(sum).toEqual({ value: 1_000_000, incomplete: true });
    });
});

describe('stockLiquidationValue', () => {
    it('keeps the upstream cash long estimate (regression)', () => {
        expect(stockLiquidationValue(row({ last_price: 500 }))).toBeCloseTo(995575, 6);
        expect(stockLiquidationValue(row({ account: esun }))).toBeCloseTo(995575, 6);
        expect(stockLiquidationValue(row({ account: sinopac }))).toBeCloseTo(995575, 6);
        // ETF 0.1% 證交稅
        expect(stockLiquidationValue(row({ code: '0050', quantity: 1000, last_price: 100 }))).toBeCloseTo(100000 * (1 - 0.001425 - 0.001), 6);
    });
    it('E.SUN short = |cost_sum| (margin) + pnl, and follows live pnl', () => {
        setEsunInventoryDetails(esun, shortDetail());
        expect(stockLiquidationValue(short())).toBe(656463);
        // tick 392 → 396：markPosition 使 pnl 再減 8,000
        expect(stockLiquidationValue(short({ last_price: 396, pnl: -36537 }))).toBe(648463);
        expect(sumStockLiquidationValue([row(), short()]).value).toBeCloseTo(995575 + 656463, 6);
    });
    it('E.SUN credit rows never use a stale detail whose cost_qty differs from the position', () => {
        setEsunInventoryDetails(esun, shortDetail('3000'));
        expect(stockLiquidationValue(short())).toBeNull();
        expect(sumStockLiquidationValue([row(), short()])).toEqual({ value: expect.closeTo(995575, 6), incomplete: true });
    });
    it('E.SUN credit rows need the same rowId and average price as the detail (projection rebuilt rows are unknown)', () => {
        setEsunInventoryDetails(esun, shortDetail());
        // 回補後再融券賣出 2,000 @450：投影新建 id<0、均價 450 的列，股數與明細相同
        expect(stockLiquidationValue(short({ id: -1, price: 450 }))).toBeNull();
        expect(stockLiquidationValue(short({ id: -1 }))).toBeNull();
        expect(stockLiquidationValue(short({ price: 392.375 }))).toBeNull();
        expect(stockLiquidationValue(short({ price: NaN }))).toBeNull();
        expect(stockLiquidationValue(short())).toBe(656463);
        setEsunInventoryDetails(esun, parseEsunInventoryDetails([
            { stk_no: '2603', trade: '0', cost_qty: '2000', price_avg: '200' },
            { stk_no: '1234', trade: '4', cost_qty: '2000', cost_sum: '-685000' },
        ]));
        expect(stockLiquidationValue(short())).toBeNull(); // 明細沒有均價：無法核對
    });
    it('zero or negative margin / loan / cost_sum are unknown, never counted as 0', () => {
        setEsunInventoryDetails(esun, parseEsunInventoryDetails([
            { stk_no: '2603', trade: '0', cost_qty: '2000', price_avg: '200' },
            { stk_no: '1234', trade: '4', cost_qty: '2000', cost_sum: '0', price_avg: '380.50' },
        ]));
        expect(stockLiquidationValue(short())).toBeNull();
        const p = short({ account: sinopac });
        expect(stockLiquidationValue({ ...p, short_sale_margin: 0 } as ValuedStockPosition)).toBeNull();
        expect(stockLiquidationValue({ ...p, short_sale_margin: -685000 } as ValuedStockPosition)).toBeNull();
        const m = row({ code: '2330', cond: 'MarginTrading', quantity: 1000, last_price: 100, pnl: 0, account: sinopac });
        expect(stockLiquidationValue({ ...m, margin_purchase_amount: 0, interest: 0 } as ValuedStockPosition)).toBeNull();
        expect(stockLiquidationValue({ ...m, margin_purchase_amount: 60000, interest: -1 } as ValuedStockPosition)).toBeNull();
        // 利息 0（當日融資）仍可計算
        expect(stockLiquidationValue({ ...m, margin_purchase_amount: 60000, interest: 0 } as ValuedStockPosition))
            .toBeCloseTo(100000 * (1 - 0.001425 - 0.003) - 60000, 6);
    });
    it('E.SUN credit rows without a detail or cost_sum are unknown', () => {
        expect(stockLiquidationValue(short())).toBeNull();
        setEsunInventoryDetails(esun, parseEsunInventoryDetails([{ stk_no: '1234', trade: '4', cost_qty: '2000', cost_sum: '' }]));
        expect(stockLiquidationValue(short())).toBeNull();
    });
    it('E.SUN margin = |cost_sum| (own funds) + pnl, never full market value', () => {
        setEsunInventoryDetails(esun, parseEsunInventoryDetails([{ stk_no: '2330', trade: '3', s_type: 'H', cost_qty: '1000', cost_sum: '-40142', price_avg: '100' }]));
        const margin = row({ code: '2330', cond: 'MarginTrading', quantity: 1000, price: 100, last_price: 105, pnl: 4400, account: esun });
        expect(stockLiquidationValue(margin)).toBe(44542);
    });
    it('Sinopac short without a margin field is unknown, never −market value', () => {
        const p = short({ account: sinopac });
        expect(stockLiquidationValue(p)).toBeNull();
        expect(stockLiquidationValue({ ...p, short_sale_margin: 685000 } as ValuedStockPosition)).toBe(656463);
    });
    it('Sinopac margin deducts margin_purchase_amount and interest, unknown when missing', () => {
        const p = row({ code: '2330', cond: 'MarginTrading', quantity: 1000, last_price: 100, pnl: 0, account: sinopac });
        expect(stockLiquidationValue(p)).toBeNull();
        expect(stockLiquidationValue({ ...p, margin_purchase_amount: 60000 } as ValuedStockPosition)).toBeNull();
        expect(stockLiquidationValue({ ...p, margin_purchase_amount: 60000, interest: 25 } as ValuedStockPosition))
            .toBeCloseTo(100000 * (1 - 0.001425 - 0.003) - 60000 - 25, 6);
    });
    it('unknown shapes (cash short, SBL, direction mismatch, NaN pnl) are null', () => {
        expect(stockLiquidationValue(row({ direction: 'Sell' }))).toBeNull();
        expect(stockLiquidationValue(row({ cond: 'SBLShort', direction: 'Sell' }))).toBeNull();
        expect(stockLiquidationValue(row({ cond: 'ShortSelling', direction: 'Buy', short_sale_margin: 1 }))).toBeNull();
        expect(stockLiquidationValue(short({ account: sinopac, short_sale_margin: 685000, pnl: NaN }))).toBeNull();
        expect(stockLiquidationValue(row({ last_price: NaN }))).toBeNull();
    });
});

describe('pendingSettlementAmount', () => {
    const now = Date.parse('2026-10-27T10:00:00+08:00');
    it('sums rows settling after Taipei today; today counts as already settled', () => {
        expect(pendingSettlementAmount([
            { T: 0, date: '2026-10-27', amount: 5000 },
            { T: 1, date: '2026-10-28', amount: 0 },
            { T: 2, date: '2026-10-29', amount: -685000 },
        ], now)).toBe(-685000);
    });
    it('is null while settlements are unknown or malformed', () => {
        expect(pendingSettlementAmount(undefined, now)).toBeNull();
        expect(pendingSettlementAmount([{ T: 1, date: '10/28', amount: 1 }], now)).toBeNull();
        expect(pendingSettlementAmount([{ T: 1, date: '2026-10-28', amount: NaN }], now)).toBeNull();
        expect(pendingSettlementAmount([], now)).toBe(0);
    });
    it('judges "today" by the balance snapshot day, and a prior-day snapshot is flagged', () => {
        const rows = [{ T: 1, date: '2026-10-28', amount: -685000 }, { T: 2, date: '2026-10-29', amount: 656463 }];
        const snapshot = Date.parse('2026-10-27T08:50:00+08:00');
        const nextDay = Date.parse('2026-10-28T09:00:00+08:00');
        // 快照 10/27 的餘額還沒扣 10/28 的應付 → 兩列都未交割（不以「現在」10/28 排除）
        expect(pendingSettlementAmount(rows, snapshot)).toBe(-685000 + 656463);
        expect(pendingSettlementAmount(rows, nextDay)).toBe(656463);
        expect(pendingSettlementAmount(rows, NaN)).toBeNull();
        expect(isPriorTaipeiDay(snapshot, nextDay)).toBe(true);
        expect(isPriorTaipeiDay(snapshot, Date.parse('2026-10-27T23:59:00+08:00'))).toBe(false);
        // 台北午夜跨日（UTC 仍同一天）
        expect(isPriorTaipeiDay(Date.parse('2026-10-27T23:59:00+08:00'), Date.parse('2026-10-28T00:01:00+08:00'))).toBe(true);
        expect(isPriorTaipeiDay(null, nextDay)).toBe(true);
        expect(isPriorTaipeiDay(undefined, nextDay)).toBe(true);
    });
    it('same-day short: pending margin payment leaves only the P&L', () => {
        setEsunInventoryDetails(esun, shortDetail());
        const pending = pendingSettlementAmount([{ T: 2, date: '2026-10-29', amount: -685000 }], now)!;
        expect(stockLiquidationValue(short())! + pending).toBe(-28537);
    });
});

describe('settlementsOlderThanPositions', () => {
    const a = stockPositionsSignature([row({ account: esun }), short()]);
    const b = stockPositionsSignature([row({ account: esun })]);
    it('signature ignores order, price and pnl but not quantity/cond/direction/account', () => {
        expect(stockPositionsSignature([short(), row({ account: esun })])).toBe(a);
        expect(stockPositionsSignature([row({ account: esun, last_price: 1, pnl: 9 }), short({ price: 1 })])).toBe(a);
        expect(stockPositionsSignature([row({ account: esun }), short({ quantity: 1000 })])).not.toBe(a);
        expect(stockPositionsSignature([row({ account: sinopac }), short()])).not.toBe(a);
    });
    it('flags positions that changed after the snapshot; a new snapshot re-baselines', () => {
        const key = 'k1';
        expect(settlementsOlderThanPositions(key, null, true, a)).toBe(false);
        expect(settlementsOlderThanPositions(key, 100, false, a)).toBe(false);
        expect(settlementsOlderThanPositions(key, 100, false, b)).toBe(true);
        expect(settlementsOlderThanPositions(key, 100, false, a)).toBe(false);
        expect(settlementsOlderThanPositions(key, 200, false, b)).toBe(false);
    });
    it('a fill while the settlements query is in flight still counts as stale', () => {
        const key = 'k2';
        settlementsOlderThanPositions(key, 100, false, a);
        expect(settlementsOlderThanPositions(key, 100, true, a)).toBe(false); // refresh starts
        expect(settlementsOlderThanPositions(key, 200, false, b)).toBe(true); // fill landed before the response
        // a failed refresh (updatedAt unchanged) discards the captured start signature
        settlementsOlderThanPositions(key, 200, true, b);
        settlementsOlderThanPositions(key, 200, false, b);
        expect(settlementsOlderThanPositions(key, 300, false, b)).toBe(false);
    });
});
