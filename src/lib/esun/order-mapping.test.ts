// src/lib/esun/order-mapping.test.ts — Unit tests for E.SUN Securities order and portfolio mapping

import { describe, expect, it } from 'vitest';
import type { ContractBase } from '../types/contract';
import type { StockOrderReq, Trade } from '../types/order';
import type { Account } from '../types/portfolio';
import {
    clampEsunDateRange180Days,
    formatEsunErrorMessage,
    fromEsunBalance,
    fromEsunBalanceToReserveSummary,
    fromEsunInventoryToPosition,
    fromEsunOrderResponse,
    fromEsunOrderResult,
    fromEsunSettlements,
    fromEsunTradeStatusToLimits,
    fromEsunTransactionsToProfitLoss,
    fromEsunTransactionsToProfitLossSummary,
    esunMktSeqNum,
    isEsunAccount,
    isEsunBroker,
    isReservationOrder,
    toEsunOrderPayload,
    validateEsunOrderPriceMutation,
    validateEsunOrderQtyMutation,
    validateEsunStockOrder,
} from './order-mapping';
import {
    ESUN_BROKER_CODE,
    EsunApCode,
    EsunBsFlag,
    EsunErrorCode,
    EsunOrderResult,
    EsunPriceFlag,
    EsunSide,
    EsunTradeType,
} from './types';

const esunAccount: Account = {
    account_type: 'S',
    broker_id: ESUN_BROKER_CODE,
    account_id: '9600123',
    signed: true,
    username: '測試玉山帳戶',
    person_id: 'A123456789',
};

const sinopacAccount: Account = {
    account_type: 'S',
    broker_id: '9A95',
    account_id: '9876543',
    signed: true,
    username: '永豐帳戶',
    person_id: 'A123456789',
};

const stockContract: ContractBase = {
    code: '2884',
    security_type: 'STK',
    exchange: 'TSE',
    target_code: null,
};

const oesContract: ContractBase = {
    code: '6789',
    security_type: 'STK',
    exchange: 'OES',
    target_code: null,
};

const futuresContract: ContractBase = {
    code: 'TXFR1',
    security_type: 'FUT',
    exchange: 'TAIFEX',
    target_code: null,
};

const sampleTrade: Trade = {
    contract: stockContract,
    order: {
        id: 'E00001',
        seqno: 'E00001',
        ordno: 'E00001',
        action: 'Buy',
        price: 25.0,
        quantity: 5,
        order_type: 'ROD',
        price_type: 'LMT',
    },
    status: {
        id: 'E00001',
        status: 'Submitted',
        status_code: '000000',
        msg: '',
        order_quantity: 5,
        deal_quantity: 0,
        cancel_quantity: 0,
        modified_price: 0,
        deals: [],
    },
};

describe('Dual-Broker Account Identification (isEsunBroker and isEsunAccount)', () => {
    it('correctly identifies E.SUN broker identifiers', () => {
        expect(isEsunBroker('8840')).toBe(true);
        expect(isEsunBroker('884M')).toBe(true);
        expect(isEsunBroker('8849')).toBe(true);
        expect(isEsunBroker('8840-SIM')).toBe(true);
        // 96xx 是其他券商（例如富邦）的代號，不是玉山 (B-14)
        expect(isEsunBroker('9600')).toBe(false);
        expect(isEsunBroker('9601')).toBe(false);
        expect(isEsunBroker('96AB')).toBe(false);
        expect(isEsunBroker('88401')).toBe(false);
        expect(isEsunBroker('esun')).toBe(true);
        expect(isEsunBroker('ESUN')).toBe(true);
        expect(isEsunBroker('E.SUN')).toBe(true);
        expect(isEsunBroker('ESUNSEC')).toBe(true);
        expect(isEsunBroker('玉山')).toBe(true);
        expect(isEsunBroker('玉山證券')).toBe(true);

        expect(isEsunBroker('9A95')).toBe(false);
        expect(isEsunBroker('Sinopac')).toBe(false);
        expect(isEsunBroker('')).toBe(false);
        expect(isEsunBroker(null)).toBe(false);
        expect(isEsunBroker(undefined)).toBe(false);
    });

    it('identifies E.SUN accounts', () => {
        expect(isEsunAccount(esunAccount)).toBe(true);
        expect(isEsunAccount({ broker_id: '8840' })).toBe(true);
        expect(isEsunAccount({ broker_id: '8840-SIM' })).toBe(true);
        expect(isEsunAccount({ broker_id: '9600' })).toBe(false);
        expect(isEsunAccount(sinopacAccount)).toBe(false);
        expect(isEsunAccount(null)).toBe(false);
    });
});

describe('validateEsunStockOrder', () => {
    it('rejects non-STK securities (Futures, Options)', () => {
        const order: StockOrderReq = {
            action: 'Buy',
            price: 25,
            quantity: 1,
            price_type: 'LMT',
            order_type: 'ROD',
        };
        expect(validateEsunStockOrder(futuresContract, order)).toContain('僅支援台股現貨交易');
    });

    it('rejects invalid quantities', () => {
        const order: StockOrderReq = {
            action: 'Buy',
            price: 25,
            quantity: 0,
            price_type: 'LMT',
            order_type: 'ROD',
        };
        expect(validateEsunStockOrder(stockContract, order)).toContain('正整數');
    });

    it('enforces 1 to 499 sheets limit for Common and Fixing lots', () => {
        // Common lot
        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Buy',
                price: 25,
                quantity: 499,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Common',
            }),
        ).toBeNull();

        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Buy',
                price: 25,
                quantity: 500,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Common',
            }),
        ).toContain('1 至 499 張');

        // Fixing lot
        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Buy',
                price: 25,
                quantity: 499,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Fixing',
            }),
        ).toBeNull();

        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Buy',
                price: 25,
                quantity: 500,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Fixing',
            }),
        ).toContain('1 至 499 張');
    });

    it('enforces odd lot constraints (1 to 999 shares, Cash only, LMT only, ROD only)', () => {
        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Buy',
                price: 25,
                quantity: 1000,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'IntradayOdd',
            }),
        ).toContain('1 至 999 股');

        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Buy',
                price: 25,
                quantity: 999,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'IntradayOdd',
            }),
        ).toBeNull();

        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Buy',
                price: 25,
                quantity: 100,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'IntradayOdd',
                order_cond: 'MarginTrading',
            }),
        ).toContain('融資券');

        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Buy',
                price: 0,
                quantity: 100,
                price_type: 'MKT',
                order_type: 'ROD',
                order_lot: 'IntradayOdd',
            }),
        ).toContain('不支援市價');

        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Buy',
                price: 25,
                quantity: 100,
                price_type: 'LMT',
                order_type: 'IOC',
                order_lot: 'IntradayOdd',
            }),
        ).toContain('只能為 ROD');

        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Sell',
                price: 25,
                quantity: 100,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'IntradayOdd',
                daytrade_short: true,
            }),
        ).toContain('不支援現股當沖');
    });

    it('blocks emerging stocks (ap_code 4 is in shares; the App order quantity is in sheets) (B-07)', () => {
        for (const quantity of [2, 500, 2000]) {
            expect(
                validateEsunStockOrder(oesContract, {
                    action: 'Buy',
                    price: 50,
                    quantity,
                    price_type: 'LMT',
                    order_type: 'ROD',
                }),
            ).toContain('興櫃');
        }
    });

    it('enforces daytrade_short constraints', () => {
        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Buy',
                price: 25,
                quantity: 1,
                price_type: 'LMT',
                order_type: 'ROD',
                daytrade_short: true,
            }),
        ).toContain('僅支援賣出');

        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Sell',
                price: 25,
                quantity: 1,
                price_type: 'LMT',
                order_type: 'ROD',
                order_cond: 'MarginTrading',
                daytrade_short: true,
            }),
        ).toContain('現股條件');

        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Sell',
                price: 25,
                quantity: 1,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'Fixing',
                daytrade_short: true,
            }),
        ).toContain('整股交易');
    });

    it('blocks BlockTrade and SBL short', () => {
        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Buy',
                price: 25,
                quantity: 1,
                price_type: 'LMT',
                order_type: 'ROD',
                order_lot: 'BlockTrade',
            }),
        ).toContain('鉅額交易');

        expect(
            validateEsunStockOrder(stockContract, {
                action: 'Sell',
                price: 25,
                quantity: 1,
                price_type: 'LMT',
                order_type: 'ROD',
                order_cond: 'SBLShort',
            }),
        ).toContain('借券賣出');
    });
});

describe('Mutation validations (validateEsunOrderPriceMutation and validateEsunOrderQtyMutation)', () => {
    it('blocks reservation orders on price modification with AG0006 error', () => {
        const presubmittedTrade: Trade = {
            ...sampleTrade,
            status: { ...sampleTrade.status, status: 'PreSubmitted' },
        };
        const err = validateEsunOrderPriceMutation(presubmittedTrade, 26);
        expect(err).toContain('AG0006');
        expect(err).toContain('預約單不可改單');
    });

    it('blocks non-ROD or Market orders on price modification', () => {
        const iocTrade: Trade = {
            ...sampleTrade,
            order: { ...sampleTrade.order, order_type: 'IOC' },
        };
        expect(validateEsunOrderPriceMutation(iocTrade, 26)).toContain('僅支援 ROD 限價單改價');

        const mktTrade: Trade = {
            ...sampleTrade,
            order: { ...sampleTrade.order, price_type: 'MKT' },
        };
        expect(validateEsunOrderPriceMutation(mktTrade, 26)).toContain('僅支援 ROD 限價單改價');
    });

    it('validates price value', () => {
        expect(validateEsunOrderPriceMutation(sampleTrade, 0)).toContain('大於 0');
        expect(validateEsunOrderPriceMutation(sampleTrade, 26.5)).toBeNull();
    });

    it('blocks reservation orders on quantity modification with AG0006 error', () => {
        const presubmittedTrade: Trade = {
            ...sampleTrade,
            status: { ...sampleTrade.status, status: 'PreSubmitted' },
        };
        const err = validateEsunOrderQtyMutation(presubmittedTrade, 3);
        expect(err).toContain('AG0006');
        expect(err).toContain('預約單不可改單');
    });

    it('validates the reduction (reduce-by) against the remaining quantity (B-02)', () => {
        expect(validateEsunOrderQtyMutation(sampleTrade, 0)).toContain('正整數');
        expect(validateEsunOrderQtyMutation(sampleTrade, 1.5)).toContain('正整數');
        expect(validateEsunOrderQtyMutation(sampleTrade, 3)).toBeNull();
        expect(validateEsunOrderQtyMutation(sampleTrade, 5)).toBeNull();
        expect(validateEsunOrderQtyMutation(sampleTrade, 6)).toContain('減量');
        const partly = { ...sampleTrade, status: { ...sampleTrade.status, status: 'PartFilled' as const, deal_quantity: 2, cancel_quantity: 1 } };
        expect(validateEsunOrderQtyMutation(partly, 2)).toBeNull();
        expect(validateEsunOrderQtyMutation(partly, 3)).toContain('剩餘 2');
    });

    it('identifies reservation orders correctly', () => {
        expect(isReservationOrder({ ...sampleTrade, status: { ...sampleTrade.status, status: 'PreSubmitted' } })).toBe(true);
        expect(isReservationOrder({ ...sampleTrade, status: { ...sampleTrade.status, status_code: '1' } })).toBe(true);
        expect(isReservationOrder({ ...sampleTrade, order: { ...sampleTrade.order, ordno: '', seqno: 'PRE01' } })).toBe(true);
        expect(isReservationOrder(sampleTrade)).toBe(false);

        // Python snake_case reservation order tests
        expect(isReservationOrder({ ord_status: '1' })).toBe(true);
        expect(isReservationOrder({ pre_ord_no: 'PRE01', ord_no: '' })).toBe(true);
        expect(isReservationOrder({ pre_ord_no: 'PRE01', ord_no: 'O01', ord_status: '0' })).toBe(false);
    });
});

describe('formatEsunErrorMessage', () => {
    it('maps official E.Sun error codes to Traditional Chinese', () => {
        expect(formatEsunErrorMessage(EsunErrorCode.AGR0000)).toContain('每分鐘登入次數超限');
        expect(formatEsunErrorMessage(EsunErrorCode.AGR0001)).toContain('今日下單委託筆數已達上限');
        expect(formatEsunErrorMessage(EsunErrorCode.AGR0002)).toContain('下單頻率超限');
        expect(formatEsunErrorMessage(EsunErrorCode.AGR0003)).toContain('庫存或成交查詢頻率超限');
        expect(formatEsunErrorMessage(EsunErrorCode.AGR0004)).toContain('今日登入次數已達上限');
        expect(formatEsunErrorMessage(EsunErrorCode.AGR0005)).toContain('委託回報查詢頻率超限');
        expect(formatEsunErrorMessage(EsunErrorCode.AGR0006)).toContain('交割款查詢頻率超限');
        expect(formatEsunErrorMessage(EsunErrorCode.AGA0000)).toContain('密碼錯誤超過 3 次');
        expect(formatEsunErrorMessage(EsunErrorCode.AGA0002)).toContain('IP 未在玉山白名單綁定');
        expect(formatEsunErrorMessage(EsunErrorCode.AGA0005)).toContain('系統時間與玉山伺服器誤差過大');
        expect(formatEsunErrorMessage(EsunErrorCode.AG0003)).toContain('查無委託資料');
        expect(formatEsunErrorMessage(EsunErrorCode.AG0005)).toContain('委託已成交或已取消');
        expect(formatEsunErrorMessage(EsunErrorCode.AG0006)).toContain('預約單不可改單');
        expect(formatEsunErrorMessage(EsunErrorCode.AG00004)).toContain('查無委託紀錄');
        expect(formatEsunErrorMessage(EsunErrorCode.AW00002)).toContain('不可超過 180 天');
        expect(formatEsunErrorMessage(EsunErrorCode.AW00003)).toContain('起始日期不可大於結束日期');
        expect(formatEsunErrorMessage(EsunErrorCode.WS1001)).toContain('WebSocket 連線數已達上限');
    });

    it('formats unmapped errors cleanly', () => {
        expect(formatEsunErrorMessage('UNKNOWN_CODE', 'Custom error')).toBe('[UNKNOWN_CODE] Custom error');
        expect(formatEsunErrorMessage(null, 'Some error')).toBe('Some error');
    });
});

describe('clampEsunDateRange180Days', () => {
    it('leaves date range <= 180 days unchanged', () => {
        const res = clampEsunDateRange180Days('2026-05-01', '2026-06-01');
        expect(res.clamped).toBe(false);
        expect(res.beginDate).toBe('2026-05-01');
        expect(res.endDate).toBe('2026-06-01');
    });

    it('clamps date range > 180 days to 180 days', () => {
        const res = clampEsunDateRange180Days('2025-01-01', '2026-01-01');
        expect(res.clamped).toBe(true);
        expect(res.endDate).toBe('2026-01-01');
        const start = new Date(res.beginDate);
        const end = new Date(res.endDate);
        const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(180);
    });

    it('handles begin date > end date by setting begin to end', () => {
        const res = clampEsunDateRange180Days('2026-10-25', '2026-10-20');
        expect(res.clamped).toBe(true);
        expect(res.beginDate).toBe('2026-10-20');
        expect(res.endDate).toBe('2026-10-20');
    });

    it('supports YYYYMMDD without hyphens', () => {
        const res = clampEsunDateRange180Days('20260101', '20260201');
        expect(res.beginDate).toBe('20260101');
        expect(res.endDate).toBe('20260201');
    });
});

describe('toEsunOrderPayload', () => {
    it('maps lots to the matching ap_code', () => {
        const base: StockOrderReq = { action: 'Buy', price: 50, quantity: 1, price_type: 'LMT', order_type: 'ROD' };
        expect(toEsunOrderPayload(oesContract, base).apCode).toBe(EsunApCode.Emg);
        expect(toEsunOrderPayload(stockContract, base).apCode).toBe(EsunApCode.Common);
        expect(toEsunOrderPayload(stockContract, { ...base, order_lot: 'IntradayOdd' }).apCode).toBe(EsunApCode.IntradayOdd);
        expect(toEsunOrderPayload(stockContract, { ...base, order_lot: 'Odd' }).apCode).toBe(EsunApCode.Odd);
        expect(toEsunOrderPayload(stockContract, { ...base, order_lot: 'Fixing' }).apCode).toBe(EsunApCode.AfterMarket);
    });

    it('truncates custom_field / userDef to 50 characters', () => {
        const longField = 'A'.repeat(70);
        const payload = toEsunOrderPayload(stockContract, {
            action: 'Buy',
            price: 25,
            quantity: 1,
            price_type: 'LMT',
            order_type: 'ROD',
            custom_field: longField,
        });
        expect(payload.userDef).toHaveLength(50);
        expect(payload.userDef).toBe('A'.repeat(50));
    });
});

describe('fromEsunOrderResponse and fromEsunOrderResult', () => {
    it('maps order response and result cleanly', () => {
        const res = {
            retCode: '000000',
            retMsg: '委託成功',
            workDate: '20261023',
            ordType: '0',
            ordNo: 'B1234',
            ordDate: '20261023',
            ordTime: '090001',
        };
        const orderReq: StockOrderReq = {
            action: 'Buy',
            price: 25,
            quantity: 1,
            price_type: 'LMT',
            order_type: 'ROD',
        };
        const trade = fromEsunOrderResponse(res, stockContract, orderReq, esunAccount);
        expect(trade.status.status).toBe('Submitted');
        expect(trade.order.ordno).toBe('B1234');

        const item: EsunOrderResult = {
            workDate: '20261023',
            ordDate: '20261023',
            ordTime: '090000',
            ordStatus: '1',
            ordNo: '',
            preOrdNo: 'P0001',
            stockNo: '2884',
            buySell: 'B',
            apCode: '1',
            priceFlag: '0',
            trade: '0',
            odPrice: '25.0',
            orgQty: '2',
            orgQtyShare: '2000',
            matQty: '0',
            matQtyShare: '0',
            celQty: '0',
            celQtyShare: '0',
            celable: 'Y',
            errCode: '000000',
            errMsg: '',
            avgPrice: '0',
            bsFlag: 'R',
            memo: '',
        };
        const mappedResult = fromEsunOrderResult(item, esunAccount)!;
        expect(mappedResult.status.status).toBe('PreSubmitted');
        expect(mappedResult.order.id).toBe('P0001');
        expect(mappedResult.order.order_type).toBe('ROD');
        expect(mappedResult.order.price_type).toBe('LMT');
    });

    it('maps raw Python snake_case order response', () => {
        const pythonRes = {
            ret_code: '000000',
            ret_msg: '委託成功',
            work_date: '20261023',
            ord_type: '0',
            ord_no: 'B5678',
            ord_date: '20261023',
            ord_time: '090100',
        };
        const orderReq: StockOrderReq = {
            action: 'Buy',
            price: 28,
            quantity: 3,
            price_type: 'LMT',
            order_type: 'ROD',
        };
        const trade = fromEsunOrderResponse(pythonRes, stockContract, orderReq, esunAccount);
        expect(trade.status.status).toBe('Submitted');
        expect(trade.order.ordno).toBe('B5678');
        expect(trade.order.quantity).toBe(3);
    });

    it('maps raw Python snake_case order result and correctly populates order_type and price_type', () => {
        const pythonItem = {
            work_date: '20261023',
            ord_date: '20261023',
            ord_time: '090105',
            ord_status: '0',
            ord_no: 'O9988',
            pre_ord_no: '',
            stock_no: '2330',
            buy_sell: 'S',
            ap_code: '1',
            price_flag: '4', // Market
            bs_flag: 'I',    // IOC
            trade: '0',
            od_price: '0.0',
            org_qty: '5',
            org_qty_share: '5000',
            mat_qty: '2',
            mat_qty_share: '2000',
            cel_qty: '0',
            cel_qty_share: '0',
            avg_price: '950.0',
            user_def: 'my-custom-order',
            ret_code: '000000',
            ret_msg: '',
        };

        const trade = fromEsunOrderResult(pythonItem as any, esunAccount)!;
        expect(trade.order.ordno).toBe('O9988');
        expect(trade.contract.code).toBe('2330');
        expect(trade.order.action).toBe('Sell');
        expect(trade.order.quantity).toBe(5);
        expect(trade.order.order_type).toBe('IOC');
        expect(trade.order.price_type).toBe('MKT');
        expect(trade.order.custom_field).toBe('my-custom-order');
        expect(trade.status.status).toBe('PartFilled');
        expect(trade.status.deal_quantity).toBe(2);
        // 均價不是委託價：不寫入 modified_price，改以一筆彙總成交呈現 (B-10)
        expect(trade.status.modified_price).toBe(0);
        expect(trade.status.deals).toEqual([{ seq: 'O9988:agg', price: 950, quantity: 2, ts: expect.any(Number) }]);
    });

    it('maps raw Python snake_case FOK and Limit order result with ap_code and numeric quantities', () => {
        const pythonItem = {
            ord_no: 'O1122',
            stock_no: '2884',
            buy_sell: 'B',
            ap_code: '5', // IntradayOdd
            price_flag: '0', // Limit
            bs_flag: 'F', // FOK
            od_price: 25.5,
            org_qty: 100,
            mat_qty: 100,
            cel_qty: 0,
            ord_status: 'Filled',
        };

        const trade = fromEsunOrderResult(pythonItem as any, esunAccount)!;
        expect(trade.order.order_type).toBe('FOK');
        expect(trade.order.price_type).toBe('LMT');
        expect(trade.order.order_lot).toBe('IntradayOdd');
        expect(trade.status.status).toBe('Filled');
        expect(trade.order.quantity).toBe(100);
        expect(trade.status.deal_quantity).toBe(100);
    });
});

describe('fromEsunOrderResult per-fill deals (esun_fills)', () => {
    const row = (over: Record<string, unknown> = {}) => ({
        ord_no: 'C0001', pre_ord_no: '', stock_no: '2884', buy_sell: 'B', ap_code: '1', price_flag: '0', bs_flag: 'R',
        trade: '0', od_price: 25.5, org_qty: 5, org_qty_share: 5000, mat_qty: 2, mat_qty_share: 2000, cel_qty: 0, cel_qty_share: 0,
        avg_price: 25.4, ord_date: '20261023', ord_time: '090512345', ...over,
    });
    const deals = (over: Record<string, unknown>) => fromEsunOrderResult(row(over) as EsunOrderResult, esunAccount)!.status.deals
        .map(d => ({ seq: d.seq, price: d.price, quantity: d.quantity }));

    it('uses mkt_seq_num and mat_price per fill, in lots for common shares', () => {
        expect(deals({ esun_fills: [
            { mkt_seq_num: '000417', mat_qty_share: 1000, mat_price: 25.5 },
            { mkt_seq_num: '000418', mat_qty_share: 1000, mat_price: 25.3 },
        ] })).toEqual([
            { seq: '000417', price: 25.5, quantity: 1 },
            { seq: '000418', price: 25.3, quantity: 1 },
        ]);
    });

    it('adds only the part of the fill quantity the fills do not cover as `${id}:agg`', () => {
        expect(deals({ mat_qty: 3, mat_qty_share: 3000, esun_fills: [{ mkt_seq_num: '000417', mat_qty_share: 1000, mat_price: null }] })).toEqual([
            { seq: '000417', price: 25.4, quantity: 1 }, // 沒有成交價：用均價
            { seq: 'C0001:agg', price: 25.4, quantity: 2 },
        ]);
    });

    it('folds a fill that is not a whole lot, or has no sequence number, into the aggregate', () => {
        expect(deals({ esun_fills: [
            { mkt_seq_num: '000417', mat_qty_share: 1500, mat_price: 25.5 },
            { mkt_seq_num: 0, mat_qty_share: 500, mat_price: 25.5 },
        ] })).toEqual([{ seq: 'C0001:agg', price: 25.4, quantity: 2 }]);
    });

    it('keeps odd-lot fills in shares', () => {
        expect(deals({ ap_code: '5', org_qty: 0.1, org_qty_share: 100, mat_qty: 0.03, mat_qty_share: 30,
            esun_fills: [{ mkt_seq_num: '9', mat_qty_share: 30, mat_price: 25.5 }] })).toEqual([{ seq: '9', price: 25.5, quantity: 30 }]);
    });

    it('keeps the legacy aggregate when the row has no fills, or fills exceed the fill quantity', () => {
        expect(deals({})).toEqual([{ seq: 'C0001:agg', price: 25.4, quantity: 2 }]);
        expect(deals({ esun_fills: [{ mkt_seq_num: '1', mat_qty_share: 3000, mat_price: 25.5 }] })).toEqual([{ seq: 'C0001:agg', price: 25.4, quantity: 2 }]);
    });

    it('reads mkt_seq_num like the bridge (0 and empty string mean none)', () => {
        expect(esunMktSeqNum({ mkt_seq_num: 0, mktSeqNum: ' 12 ' })).toBe('12');
        expect(esunMktSeqNum({ mkt_seq_num: '' })).toBe('');
        expect(esunMktSeqNum({ mkt_seq_num: 0 })).toBe('');
        expect(esunMktSeqNum({ mkt_seq_num: 7 })).toBe('7');
    });
});

describe('Portfolio & SSE Mapping', () => {
    it('maps inventory items to StockPosition (Common vs Share unit)', () => {
        const rawItem = {
            stk_no: '2884',
            cost_qty: 2500,
            price_avg: 24.5,
            price_mkt: 26.0,
            make_a_sum: 3750,
            qty_l: 2500,
            qty_c: 2500,
        };

        const posCommon = fromEsunInventoryToPosition(rawItem, 'Common');
        expect(posCommon.code).toBe('2884');
        expect(posCommon.quantity).toBe(2); // 2500 / 1000 = 2 sheets
        expect(posCommon.price).toBe(24.5);
        expect(posCommon.last_price).toBe(26.0);
        expect(posCommon.pnl).toBe(3750);
        expect(posCommon.direction).toBe('Buy');
        expect(posCommon.cond).toBe('Cash');

        const posShare = fromEsunInventoryToPosition(rawItem, 'Share');
        expect(posShare.quantity).toBe(2500); // 2500 shares
    });

    it('maps balance and reserve summary', () => {
        const rawBalance = {
            available_balance: 650000,
            stock_pre_save_amount: 50000,
            updated_at: '2026-10-23T08:30:00.000Z',
        };

        const balance = fromEsunBalance(rawBalance);
        expect(balance.acc_balance).toBe(650000);
        expect(balance.date).toBe('2026-10-23T08:30:00.000Z');

        // 圈存金額不是股數：不放進 reserved_share (B-13)
        const reserve = fromEsunBalanceToReserveSummary(rawBalance, esunAccount);
        expect(reserve.stocks).toEqual([]);
        expect(reserve.account.broker_id).toBe(ESUN_BROKER_CODE);

        // 快取的餘額以實際取得時間為資料時間，不假裝剛更新
        const cached = fromEsunBalance({ available_balance: 1, cache_age_sec: 120 });
        expect(Date.now() - Date.parse(cached.date)).toBeGreaterThanOrEqual(119_000);
        expect(fromEsunBalance({ available_balance: 1 }).date).toBe('');
    });

    it('maps settlements correctly', () => {
        const rawSettlements = [
            { date: '2026-10-23', price: 100000, T: 0 },
            { date: '2026-10-24', price: -50000, T: 1 },
        ];

        const mapped = fromEsunSettlements(rawSettlements);
        expect(mapped).toHaveLength(2);
        expect(mapped[0]?.amount).toBe(100000);
        expect(mapped[0]?.T).toBe(0);
        expect(mapped[1]?.amount).toBe(-50000);
        expect(mapped[1]?.T).toBe(1);
    });

    it('maps transactions to profit loss and summary', () => {
        const rawTx = [
            {
                stk_no: '2884',
                c_date: '2026-10-22',
                price_qty: 1000,
                cost: 24000,
                recv: 26000,
                make: 2000,
                make_per: 8.33,
                trade: '0',
            },
            {
                stk_no: '2884',
                c_date: '2026-10-23',
                price_qty: 1000,
                cost: 25000,
                recv: 27000,
                make: 2000,
                make_per: 8.0,
                trade: '0',
            },
        ];

        const plList = fromEsunTransactionsToProfitLoss(rawTx);
        expect(plList).toHaveLength(2);
        expect(plList[0]?.code).toBe('2884');
        expect(plList[0]?.pnl).toBe(2000);
        expect(plList[0]?.date).toBe('20261022');

        const plSummary = fromEsunTransactionsToProfitLossSummary(rawTx);
        expect(plSummary.profitloss_sum).toHaveLength(1);
        expect(plSummary.profitloss_sum[0]?.code).toBe('2884');
        expect(plSummary.profitloss_sum[0]?.quantity).toBe(2000);
        expect(plSummary.profitloss_sum[0]?.pnl).toBe(4000);
        expect(plSummary.total.quantity).toBe(2000);
        expect(plSummary.total.pnl).toBe(4000);
    });

    it('maps trade status to trading limits', () => {
        const rawStatus = {
            trade_limit: 2000000,
            trading_available: 1500000,
            margin_limit: 1000000,
            margin_available: 800000,
            short_limit: 500000,
            short_available: 400000,
        };

        const limits = fromEsunTradeStatusToLimits(rawStatus);
        expect(limits.trading_limit).toBe(2000000);
        expect(limits.trading_used).toBe(500000);
        expect(limits.trading_available).toBe(1500000);
        expect(limits.trading_used).toBe(500000);
        expect(limits.margin_limit).toBe(1000000);
        expect(limits.margin_available).toBe(800000);
        expect(limits.margin_used).toBe(200000);
        expect(limits.short_limit).toBe(500000);
        expect(limits.short_available).toBe(400000);
        expect(limits.short_used).toBe(100000);
    });
});
