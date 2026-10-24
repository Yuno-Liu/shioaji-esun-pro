// src/lib/esun/order-mapping-wire.test.ts — 以 esun_trade SDK 實際欄位形狀做的映射回歸測試
//
// 形狀依據：sdk.py 以 order_result["ap_code"]／["stock_no"] 等 snake_case 鍵存取；
// recover_order_result 對 ap_code 3/4/5 把所有 *qty 乘以每張股數再送 API（因此委託查詢的
// 零股／興櫃 *_qty 是「張」的小數，*_qty_share 才是股數）；成功碼 err_code 為 8 碼 '00000000'。

import { describe, expect, it } from 'vitest';
import type { Trade } from '../types/order';
import type { Account } from '../types/portfolio';
import {
    clampEsunDateRange180Days,
    esunAccountForEnvironment,
    esunEnvironmentOfAccount,
    esunOrderId,
    esunRetCode,
    esunWireBrokerId,
    fromEsunInventoryToPosition,
    fromEsunOrderResult,
    fromEsunTransactionsToProfitLoss,
    fromEsunTransactionsToProfitLossSummary,
    isEsunFailureCode,
    isEsunSuccessCode,
    toEsunMutationPayload,
} from './order-mapping';

const account: Account = {
    account_type: 'S', broker_id: '8840-SIM', account_id: '1234567', signed: true, username: '玉山證券', person_id: '',
};

// get_order_results 的一列（去識別化；欄位名稱與型別比照 SDK）
const sdkRow = (over: Record<string, unknown> = {}) => ({
    work_date: '20261023', ord_date: '20261023', ord_time: '090512345', ord_status: '2',
    ord_no: 'C0001', pre_ord_no: '', stock_no: '2884', buy_sell: 'B', ap_code: '1', price_flag: '0',
    bs_flag: 'R', trade: '0', od_price: 25.5, org_qty: 5, org_qty_share: 5000, mat_qty: 0,
    mat_qty_share: 0, cel_qty: 0, cel_qty_share: 0, celable: '1', err_code: '00000000', err_msg: '',
    avg_price: 0, user_def: '',
    ...over,
});

describe('account identity keyed by environment', () => {
    it('adds -SIM for simulation accounts and strips it for the wire', () => {
        const sim = esunAccountForEnvironment({ broker_id: '8840', account_id: '1234567' }, 'SIMULATION');
        const prod = esunAccountForEnvironment({ broker_id: '8840', account_id: '1234567' }, 'PRODUCTION');
        expect(sim.broker_id).toBe('8840-SIM');
        expect(prod.broker_id).toBe('8840');
        expect(`${sim.broker_id}-${sim.account_id}`).not.toBe(`${prod.broker_id}-${prod.account_id}`);
        expect(esunEnvironmentOfAccount(sim)).toBe('SIMULATION');
        expect(esunEnvironmentOfAccount(prod)).toBe('PRODUCTION');
        expect(esunEnvironmentOfAccount({ broker_id: '9A95' })).toBeNull();
        expect(esunWireBrokerId('8840-SIM')).toBe('8840');
        // 已帶後綴的 broker 不會重複加
        expect(esunAccountForEnvironment(sim, 'SIMULATION').broker_id).toBe('8840-SIM');
    });
});

describe('success codes (B-05 / B-09)', () => {
    it('reads snake_case ret_code first and treats only all-zero codes as success', () => {
        expect(esunRetCode({ ret_code: 'AG0005', retCode: '000000' })).toBe('AG0005');
        expect(esunRetCode({ retCode: '000000' })).toBe('000000');
        expect(esunRetCode({})).toBeUndefined();
        for (const ok of ['0', '000000', '00000000']) expect(isEsunSuccessCode(ok)).toBe(true);
        expect(isEsunSuccessCode('')).toBe(false);
        expect(isEsunFailureCode('AG0005')).toBe(true);
        expect(isEsunFailureCode('00000000')).toBe(false);
        expect(isEsunFailureCode(undefined)).toBe(false);
    });

    it('keeps a working order with the 8-digit success err_code working', () => {
        const trade = fromEsunOrderResult(sdkRow(), account)!;
        expect(trade.status.status).toBe('Submitted');
        expect(trade.status.status_code).toBe('00000000');
    });

    it('marks a real error code as Failed', () => {
        expect(fromEsunOrderResult(sdkRow({ err_code: 'AG0003', err_msg: '查無委託' }), account)!.status.status).toBe('Failed');
    });
});

describe('order result quantities and status (B-07 / B-09)', () => {
    it('reads odd-lot quantities in shares (*_qty is a fraction of a lot)', () => {
        const trade = fromEsunOrderResult(sdkRow({
            ap_code: '5', org_qty: 0.1, org_qty_share: 100, mat_qty: 0.03, mat_qty_share: 30, cel_qty: 0, cel_qty_share: 0,
        }), account)!;
        expect(trade.order.order_lot).toBe('IntradayOdd');
        expect(trade.order.quantity).toBe(100);
        expect(trade.status.deal_quantity).toBe(30);
        expect(trade.status.status).toBe('PartFilled');
        // 沒有 *_share 欄位時由張的小數換算
        const lotsOnly = fromEsunOrderResult(sdkRow({ ap_code: '5', org_qty: 0.1, org_qty_share: undefined }), account)!;
        expect(lotsOnly.order.quantity).toBe(100);
    });

    it('reads emerging rows in shares and keeps the OES exchange', () => {
        const trade = fromEsunOrderResult(sdkRow({ ap_code: '4', org_qty: 2, org_qty_share: 2000 }), account)!;
        expect(trade.order.quantity).toBe(2000);
        expect(trade.contract.exchange).toBe('OES');
    });

    it('ends an order whose fills and cancels cover the quantity as Cancelled with the fills kept', () => {
        const trade = fromEsunOrderResult(sdkRow({ mat_qty: 2, mat_qty_share: 2000, cel_qty: 3, cel_qty_share: 3000, avg_price: 25.4 }), account)!;
        expect(trade.status.status).toBe('Cancelled');
        expect(trade.status.deal_quantity).toBe(2);
        expect(trade.status.cancel_quantity).toBe(3);
        expect(trade.status.deals).toEqual([expect.objectContaining({ quantity: 2, price: 25.4 })]);
    });

    it('takes the exchange from the contract cache resolver', () => {
        const trade = fromEsunOrderResult(sdkRow(), account, { exchangeOf: () => 'OTC' })!;
        expect(trade.contract.exchange).toBe('OTC');
    });

    it('uses pre_ord_no as the stable id of a reservation that later got an ord_no (B-11)', () => {
        const before = fromEsunOrderResult(sdkRow({ ord_no: '', pre_ord_no: 'P0007' }), account)!;
        const after = fromEsunOrderResult(sdkRow({ ord_no: 'C0042', pre_ord_no: 'P0007' }), account)!;
        expect(before.order.id).toBe('P0007');
        expect(after.order.id).toBe('P0007');
        expect(after.order.ordno).toBe('C0042');
        expect(esunOrderId({ ord_no: 'C1' })).toBe('C1');
    });

    it('skips rows that lack identity fields instead of defaulting them to Sell / 0 (B-11)', () => {
        // 舊 bridge 把下單回應寫進委託快取：只有 ret_code 與 ord_no
        expect(fromEsunOrderResult({ ret_code: '000000', ord_no: 'C0001' }, account)).toBeNull();
        expect(fromEsunOrderResult(sdkRow({ buy_sell: '' }), account)).toBeNull();
        expect(fromEsunOrderResult(sdkRow({ stock_no: '' }), account)).toBeNull();
        expect(fromEsunOrderResult(sdkRow({ ord_no: '', pre_ord_no: '' }), account)).toBeNull();
        expect(fromEsunOrderResult(sdkRow({ org_qty: 0 }), account)).toBeNull();
    });
});

describe('mutation payload (B-12)', () => {
    it('carries the full order so the bridge never synthesizes a default buy', () => {
        const trade = fromEsunOrderResult(sdkRow({ buy_sell: 'S', ap_code: '5', org_qty_share: 300, trade: '0' }), account)! as Trade;
        expect(toEsunMutationPayload(trade)).toMatchObject({
            ordNo: 'C0001', stockNo: '2884', buySell: 'S', apCode: '5', priceFlag: '0', bsFlag: 'R', trade: '0', price: 25.5, quantity: 300,
        });
    });
});

describe('inventory direction and credit from `trade` (B-08)', () => {
    it('ignores today\'s order/fill fields when deciding the side', () => {
        // 現股多單 3,000 股，今天掛一張賣單（qty_s）：仍是現股買進部位
        const cash = fromEsunInventoryToPosition({ stk_no: '2884', cost_qty: 3000, qty_s: 1000, qty_bm: 1000, trade: '0' }, 'Share');
        expect(cash).toMatchObject({ direction: 'Buy', cond: 'Cash', quantity: 3000 });
        expect(fromEsunInventoryToPosition({ stk_no: '2884', cost_qty: 2000, trade: '3' }, 'Share')).toMatchObject({ direction: 'Buy', cond: 'MarginTrading' });
        expect(fromEsunInventoryToPosition({ stk_no: '2884', cost_qty: 2000, trade: '4' }, 'Share')).toMatchObject({ direction: 'Sell', cond: 'ShortSelling' });
    });
});

describe('realized P&L only (B-13)', () => {
    it('drops opening fills and dates rows by trade date', () => {
        const rows = [
            { stk_no: '2884', buy_sell: 'B', trade: '0', t_date: '20261021', c_date: '20261023', qty: 1000, cost: 25000, make: 0 },
            { stk_no: '2884', buy_sell: 'S', trade: '0', t_date: '20261022', c_date: '20261024', qty: 1000, cost: 25000, recv: 26000, make: 1000 },
            { stk_no: '2330', buy_sell: 'S', trade: '4', t_date: '20261022', qty: 1000, cost: 500000, make: 0 }, // 融券賣出建倉
            { stk_no: '2330', buy_sell: 'B', trade: '4', t_date: '20261023', qty: 1000, cost: 480000, make: 20000 }, // 融券回補
        ];
        const pl = fromEsunTransactionsToProfitLoss(rows);
        expect(pl.map(r => [r.code, r.date, r.pnl])).toEqual([['2884', '20261022', 1000], ['2330', '20261023', 20000]]);
        const sum = fromEsunTransactionsToProfitLossSummary(rows);
        expect(sum.total.quantity).toBe(2000);
        expect(sum.total.pnl).toBe(21000);
    });
});

describe('date range clamp (B-16)', () => {
    it('never produces NaN dates for empty or invalid input', () => {
        const res = clampEsunDateRange180Days('', '');
        expect(res.beginDate).toMatch(/^\d{8}$/);
        expect(res.endDate).toBe(res.beginDate);
        expect(clampEsunDateRange180Days('2026-10-01', 'garbage').beginDate).not.toContain('NaN');
    });
});
