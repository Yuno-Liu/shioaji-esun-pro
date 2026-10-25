// src/lib/esun/order-mapping.test.ts — Unit tests for E.SUN Securities order and portfolio mapping

import { describe, expect, it } from 'vitest';
import type { ContractBase } from '../types/contract';
import type { StockOrderReq, Trade } from '../types/order';
import type { Account } from '../types/portfolio';
import type { StockProfitLossSummary } from '../shioaji';
import { markPosition } from '../portfolio-projection';
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
    esunOrderSortKey,
    esunTransactionCondOf,
    isEsunAccount,
    isEsunBroker,
    isEsunRealizedTransaction,
    isEstimatedEsunSettlement,
    isReservationOrder,
    mergeSettlementSlot,
    sortEsunOrderResultsOldestFirst,
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
        expect(posCommon.quantity).toBe(2.5); // 2500 / 1000 = 2.5 張（精確換算，不取整）
        expect(posCommon.yd_quantity).toBe(2.5);
        expect(posCommon.price).toBe(24.5);
        expect(posCommon.last_price).toBe(26.0);
        expect(posCommon.pnl).toBe(3750);
        expect(posCommon.direction).toBe('Buy');
        expect(posCommon.cond).toBe('Cash');

        const posShare = fromEsunInventoryToPosition(rawItem, 'Share');
        expect(posShare.quantity).toBe(2500); // 2500 shares
        expect(posShare.yd_quantity).toBe(2500);
    });

    it('converts Common quantity and yd_quantity to exact lots (shares / 1000)', () => {
        const at = (cost_qty: number, qty_l: number) => fromEsunInventoryToPosition({ stk_no: '1342', cost_qty, qty_l, trade: '0' }, 'Common');
        expect(at(3000, 1000)).toMatchObject({ quantity: 3, yd_quantity: 1 });
        expect(at(1200, 1800)).toMatchObject({ quantity: 1.2, yd_quantity: 1.8 });
        expect(at(37, 0)).toMatchObject({ quantity: 0.037, yd_quantity: 0 });
    });

    it('never maps blank or zero price fields to 0 (first finite positive wins, otherwise NaN)', () => {
        const pos = (extra: Record<string, unknown>) =>
            fromEsunInventoryToPosition({ stk_no: '2884', cost_qty: 1000, trade: '0', ...extra }, 'Share');
        // 空字串的市價退到 price_now
        expect(pos({ price_mkt: '', price_now: '25.5', price_avg: '24' })).toMatchObject({ price: 24, last_price: 25.5 });
        // 市價、現價皆缺或為 0 → 以均價為參考價
        expect(pos({ price_mkt: '0', price_now: ' ', price_avg: '24' })).toMatchObject({ price: 24, last_price: 24 });
        // 均價缺值 → 退到舊欄位 price；都沒有 → NaN（不是 0）
        expect(pos({ price_avg: '', price: '23.1', price_mkt: 26 }).price).toBe(23.1);
        const blank = pos({ price_avg: '', price_mkt: '', price_now: '' });
        expect(blank.price).toBeNaN();
        expect(blank.last_price).toBeNaN();
        // 參考價未知時第一個 tick 不會把損益加上「價格×股數」
        const marked = markPosition({ ...blank, pnl: 1200 }, 26, 1);
        expect(marked.pnl).toBe(1200);
        const normal = markPosition({ ...pos({ price_mkt: '', price_now: '', price_avg: '24' }), pnl: 0 }, 26, 1);
        expect(normal.pnl).toBe(2000);
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

    it('maps numeric epoch updated_at (production shape) to ISO date', () => {
        // 正式環境 updated_at 是整數 epoch 秒
        expect(fromEsunBalance({ available_balance: 1, updated_at: 1792850400 }).date)
            .toBe('2026-10-24T14:00:00.000Z');
        // ≥ 1e12 視為毫秒
        expect(fromEsunBalance({ available_balance: 1, updated_at: 1792850400123 }).date)
            .toBe('2026-10-24T14:00:00.123Z');
        // 非有限數值不採用，沿用既有退回邏輯
        expect(fromEsunBalance({ available_balance: 1, updated_at: Number.NaN }).date).toBe('');
    });

    describe('fromEsunSettlements（交割行事曆 T+n）', () => {
        // 台北時間 → epoch ms
        const taipei = (iso: string, hh = 12, mm = 0) => {
            const [y, m, d] = iso.split('-').map(Number);
            return Date.UTC(y!, m! - 1, d!, hh - 8, mm);
        };
        const row = (cDate: string, price: string, date = '20261021') => ({ c_date: cDate, date, price });
        const sundayStatus = { is_trading_day: false, last_trading_day: '20261022', next_trading_day: '20261027' };
        const tradingStatus = { is_trading_day: true, last_trading_day: '20261022', next_trading_day: '20261028' };
        const slots = (list: { T: number; date: string; amount: number }[]) => list.map(s => [s.T, s.date, s.amount]);

        it('maps the production shape on a Sunday: c_date is the settlement day, date (trade day) is ignored', () => {
            const raw = [row('20261027', '120000', '20261022'), row('20261028', '-35500', '20261023')];
            expect(slots(fromEsunSettlements(raw, sundayStatus, taipei('2026-10-25')))).toEqual([
                [0, '2026-10-27', 120000],
                [1, '2026-10-28', -35500],
                [2, '2026-10-29', 0],
            ]);
        });

        it('maps each pending day to its own slot on a trading day', () => {
            const raw = [row('20261027', '1'), row('20261028', '-2'), row('20261029', '3')];
            expect(slots(fromEsunSettlements(raw, tradingStatus, taipei('2026-10-27')))).toEqual([
                [0, '2026-10-27', 1],
                [1, '2026-10-28', -2],
                [2, '2026-10-29', 3],
            ]);
        });

        it('keeps the T+1 slot (amount 0) when a trading day has no T+1 settlement', () => {
            const raw = [row('20261027', '10'), row('20261029', '30')];
            expect(slots(fromEsunSettlements(raw, tradingStatus, taipei('2026-10-27')))).toEqual([
                [0, '2026-10-27', 10],
                [1, '2026-10-28', 0],
                [2, '2026-10-29', 30],
            ]);
        });

        it('anchors T+0 on the next trading day when a non-trading day has no T+0 settlement', () => {
            expect(slots(fromEsunSettlements([row('20261028', '5')], sundayStatus, taipei('2026-10-25')))).toEqual([
                [0, '2026-10-27', 0],
                [1, '2026-10-28', 5],
                [2, '2026-10-29', 0],
            ]);
        });

        it('falls back to weekday arithmetic without market_status', () => {
            const raw = [row('2026-10-28', '7'), row('20261029', '8')];
            expect(slots(fromEsunSettlements(raw, null, taipei('2026-10-28')))).toEqual([
                [0, '2026-10-28', 7],
                [1, '2026-10-29', 8],
                [2, '2026-10-30', 0],
            ]);
            // 週末：T+0 為下一個週一、T+2 跳過週末
            expect(slots(fromEsunSettlements([], undefined, taipei('2026-10-24')))).toEqual([
                [0, '2026-10-26', 0],
                [1, '2026-10-27', 0],
                [2, '2026-10-28', 0],
            ]);
            expect(slots(fromEsunSettlements([], null, taipei('2026-10-29')))).toEqual([
                [0, '2026-10-29', 0],
                [1, '2026-10-30', 0],
                [2, '2026-11-02', 0],
            ]);
        });

        it('ignores an unusable market_status (non-boolean flag or invalid next day)', () => {
            const today = taipei('2026-10-28');
            for (const status of [
                { is_trading_day: 'true', next_trading_day: '20261029' },
                { is_trading_day: true, next_trading_day: '20261332' },
                { is_trading_day: true },
            ]) {
                expect(slots(fromEsunSettlements([], status as never, today)).map(s => s[1]))
                    .toEqual(['2026-10-28', '2026-10-29', '2026-10-30']);
            }
            // camelCase 欄位同樣可用
            expect(fromEsunSettlements([], { isTradingDay: false, nextTradingDay: '20261027' }, taipei('2026-10-25'))[0]!.date)
                .toBe('2026-10-27');
        });

        it('handles a stale overnight cache: next==today anchors on today, next<today falls back', () => {
            const justAfterMidnight = taipei('2026-10-27', 0, 30);
            expect(Date.UTC(2026, 9, 26, 16, 30)).toBe(justAfterMidnight); // 10/26 UTC 仍是台北 10/27
            expect(slots(fromEsunSettlements([row('20261027', '9')], sundayStatus, justAfterMidnight))).toEqual([
                [0, '2026-10-27', 9],
                [1, '2026-10-28', 0],
                [2, '2026-10-29', 0],
            ]);
            // N < today：過期，退回只跳週末的推算
            expect(slots(fromEsunSettlements([row('20261029', '4')], sundayStatus, taipei('2026-10-28')))).toEqual([
                [0, '2026-10-28', 0],
                [1, '2026-10-29', 4],
                [2, '2026-10-30', 0],
            ]);
            // 交易日但 N < today 同樣視為過期
            expect(fromEsunSettlements([], tradingStatus, taipei('2026-10-29'))[0]!.date).toBe('2026-10-29');
        });

        it('drops already-settled rows, sums rows with the same settlement day, accepts numeric strings', () => {
            const raw = [
                row('20261022', '999999'),
                row('20261027', '100'),
                { c_date: '20261027', date: '20261022', price: '-40' },
                { cDate: '20261028', amount: 12.5 },
            ];
            expect(slots(fromEsunSettlements(raw, sundayStatus, taipei('2026-10-25')))).toEqual([
                [0, '2026-10-27', 60],
                [1, '2026-10-28', 12.5],
                [2, '2026-10-29', 0],
            ]);
        });

        it('rejects malformed rows', () => {
            const today = taipei('2026-10-25');
            const bad = [
                [{ date: '20261027', price: '1' }],
                [{ c_date: '20261027', price: 'abc' }],
                [{ c_date: '20261027', price: '' }],
                [{ c_date: '20261027' }],
                [{ c_date: '20261332', price: '1' }],
                [{ c_date: '2026/10/27', price: '1' }],
                [{ c_date: '20261027', price: '1', T: 0 }, { T: 1, price: '2' }],
                [null],
            ];
            for (const raw of bad) {
                expect(() => fromEsunSettlements(raw as never, sundayStatus, today)).toThrow('玉山交割款回應格式錯誤');
            }
            expect(() => fromEsunSettlements({} as never, sundayStatus, today)).toThrow('玉山交割款回應格式錯誤');
        });

        it('rejects pending settlement days beyond T+2', () => {
            const raw = [row('20261027', '1'), row('20261028', '2'), row('20261029', '3'), row('20261030', '4')];
            expect(() => fromEsunSettlements(raw, sundayStatus, taipei('2026-10-25')))
                .toThrow('玉山交割款日期超出 T+2（2026-10-30），無法對應交割行事曆');
        });

        it('marks only slots without E.SUN amounts as estimated', () => {
            const list = fromEsunSettlements([row('20261028', '0')], sundayStatus, taipei('2026-10-25'));
            // 10/28 有一筆金額為 0 的真實列 → 不是推算格
            expect(list.map(isEstimatedEsunSettlement)).toEqual([true, false, true]);
        });
    });

    describe('mergeSettlementSlot（多帳戶交割合計）', () => {
        const taipeiNoon = (iso: string) => {
            const [y, m, d] = iso.split('-').map(Number);
            return Date.UTC(y!, m! - 1, d!, 4);
        };
        // 合成：無 market_status，只跳週末推算 → T+1 推算為 10/29
        const esun = () => fromEsunSettlements([{ c_date: '20261028', price: '300' }], null, taipeiNoon('2026-10-28'));
        const real = (T: number, date: string, amount: number) => ({ T, date, amount });

        it('takes the real row date when the other side is an estimated E.SUN slot (either order)', () => {
            const est = esun()[1]!;
            expect(isEstimatedEsunSettlement(est)).toBe(true);
            const a = mergeSettlementSlot(mergeSettlementSlot(undefined, est), real(1, '2026-10-30', -50));
            expect(a).toEqual({ T: 1, date: '2026-10-30', amount: -50 });
            expect(isEstimatedEsunSettlement(a)).toBe(false);
            const b = mergeSettlementSlot(mergeSettlementSlot(undefined, real(1, '2026-10-30', -50)), est);
            expect(b).toEqual({ T: 1, date: '2026-10-30', amount: -50 });
        });

        it('keeps the estimated mark only when both sides are estimated', () => {
            const merged = mergeSettlementSlot(mergeSettlementSlot(undefined, esun()[2]!), esun()[2]!);
            expect(isEstimatedEsunSettlement(merged)).toBe(true);
            // 之後再遇到真實列仍可讓位
            expect(mergeSettlementSlot(merged, real(2, '2026-11-02', 20))).toEqual({ T: 2, date: '2026-11-02', amount: 20 });
        });

        it('still rejects two real rows with different dates and sums matching ones', () => {
            const first = mergeSettlementSlot(undefined, esun()[0]!);
            expect(isEstimatedEsunSettlement(first)).toBe(false);
            expect(() => mergeSettlementSlot(first, real(0, '2026-10-29', 1))).toThrow('帳戶交割日期不一致，合計待確認');
            expect(mergeSettlementSlot(first, real(0, '2026-10-28', 100))).toEqual({ T: 0, date: '2026-10-28', amount: 400 });
        });
    });

    it('maps transactions to profit loss and summary', () => {
        const rawTx = [
            {
                stk_no: '2884',
                c_date: '2026-10-22',
                qty: 1000,
                price_qty: 26000,
                cost: 24000,
                recv: 26000,
                make: 2000,
                make_per: 8.33,
                trade: '0',
            },
            {
                stk_no: '2884',
                c_date: '2026-10-23',
                qty: 1000,
                price_qty: 27000,
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
        // quantity 為張（2000 股 → 2 張），與明細一致
        expect(plSummary.profitloss_sum[0]?.quantity).toBe(2);
        expect(plSummary.profitloss_sum[0]?.pnl).toBe(4000);
        expect(plSummary.total.quantity).toBe(2);
        expect(plSummary.total.pnl).toBe(4000);
    });

    describe('fromEsunTransactionsToProfitLossSummary（code＋cond 分組、張、價格以股數計）', () => {
        const rows = [
            // 現股：兩筆賣出合併
            { stk_no: '2884', buy_sell: 'S', trade: '0', t_date: '20261022', qty: '1000', price_qty: '30000', cost: '-28000', recv: '29900', make: '1900' },
            { stk_no: '2884', buy_sell: 'S', trade: '0', t_date: '20261023', qty: '500', price_qty: '15600', cost: '-14000', recv: '15550', make: '1550' },
            // 同一檔融資賣出：另成一組
            { stk_no: '2884', buy_sell: 'S', trade: '3', t_date: '20261023', qty: '2000', price_qty: '62000', cost: '24000', recv: '25500', make: '1500' },
            // 零股：缺 price_qty 時以 price×股數補
            { stk_no: '1342', buy_sell: 'S', trade: '0', t_date: '20261023', qty: '40', price: '512', cost: '20000', recv: '20400', make: '400' },
            // 建倉買進：不列入
            { stk_no: '2884', buy_sell: 'B', trade: '0', t_date: '20261021', qty: '1000', price_qty: '28000', cost: '28000', make: '0' },
        ];

        it('groups by code + cond and reports lots, share-based prices and 玉山 cost / recv subtotals', () => {
            const sum = fromEsunTransactionsToProfitLossSummary(rows as never);
            const groupsOf = sum.profitloss_sum as StockProfitLossSummary[];
            const groups = groupsOf.map(g => [g.code, g.cond, g.quantity]);
            expect(groups).toEqual([['2884', 'Cash', 1.5], ['2884', 'MarginTrading', 2], ['1342', 'Cash', 0.04]]);

            const cash = groupsOf[0]!;
            expect(cash.entry_cost).toBe(42000); // Σ|cost|
            expect(cash.cover_cost).toBe(45450); // Σrecv
            expect(cash.cover_price).toBeCloseTo(45600 / 1500, 10); // Σprice_qty／Σ股數
            expect(cash.entry_price).toBeCloseTo(42000 / 1500, 10); // entry_cost／Σ股數
            expect(cash.pnl).toBe(3450);
            expect(cash.buy_cost).toBe(42000);
            expect(cash.sell_cost).toBe(45450);

            const margin = groupsOf[1]!;
            expect(margin.entry_cost).toBe(24000);
            expect(margin.cover_price).toBe(31);
            expect(margin.entry_price).toBe(12); // 自備款成本／股數，僅供參考

            const odd = groupsOf[2]!;
            expect(odd.cover_price).toBe(512);
            expect(odd.entry_price).toBe(500);

            expect(sum.total.quantity).toBe(3.54);
            expect(sum.total.pnl).toBe(5350);
            expect(sum.total.entry_amount).toBe(86000);
            expect(sum.total.cover_amount).toBe(91350);
        });

        it('returns an empty summary when nothing is realized', () => {
            const sum = fromEsunTransactionsToProfitLossSummary([rows[4]] as never);
            expect(sum.profitloss_sum).toEqual([]);
            expect(sum.total.quantity).toBe(0);
        });
    });

    describe('trade 9（信用當沖）', () => {
        const base = { stk_no: '2884', t_date: '20261023', qty: '1000', trade: '9' };

        it('counts the S side whenever make is finite and the B side only when make ≠ 0', () => {
            expect(isEsunRealizedTransaction({ ...base, buy_sell: 'S', make: '0' })).toBe(true);
            expect(isEsunRealizedTransaction({ ...base, buy_sell: 'S', make: '-300' })).toBe(true);
            expect(isEsunRealizedTransaction({ ...base, buy_sell: 'B', make: '0' })).toBe(false);
            expect(isEsunRealizedTransaction({ ...base, buy_sell: 'B', make: '250' })).toBe(true);
            expect(isEsunRealizedTransaction({ ...base, buy_sell: 'S', make: '' })).toBe(false);
            expect(isEsunRealizedTransaction({ ...base, buy_sell: 'B' })).toBe(false);
        });

        it('maps trade 9 to cond MarginTrading in rows and summary', () => {
            const rows = [
                { ...base, buy_sell: 'B', make: '0', cost: '10000' },
                { ...base, buy_sell: 'S', make: '800', cost: '10000', recv: '10800', price_qty: '31000' },
            ];
            const pl = fromEsunTransactionsToProfitLoss(rows as never);
            expect(pl.map(r => [r.code, r.cond, r.pnl, r.quantity])).toEqual([['2884', 'MarginTrading', 800, 1]]);
            const sum = fromEsunTransactionsToProfitLossSummary(rows as never);
            expect((sum.profitloss_sum as StockProfitLossSummary[]).map(g => [g.code, g.cond, g.quantity])).toEqual([['2884', 'MarginTrading', 1]]);
            expect(esunTransactionCondOf('9')).toBe('MarginTrading');
            expect(esunTransactionCondOf('3')).toBe('MarginTrading');
            expect(esunTransactionCondOf('4')).toBe('ShortSelling');
            expect(esunTransactionCondOf('A')).toBe('Cash');
            expect(esunTransactionCondOf('0')).toBe('Cash');
        });

        it('keeps the existing rules for other trade types', () => {
            expect(isEsunRealizedTransaction({ buy_sell: 'B', trade: '0', make: '100' })).toBe(false);
            expect(isEsunRealizedTransaction({ buy_sell: 'S', trade: '0', make: '0' })).toBe(true);
            expect(isEsunRealizedTransaction({ buy_sell: 'B', trade: '4', make: '100' })).toBe(true);
            expect(isEsunRealizedTransaction({ buy_sell: 'S', trade: '4', make: '0' })).toBe(false);
        });
    });

    describe('sortEsunOrderResultsOldestFirst', () => {
        const r = (id: string, ord_date?: string, ord_time?: string) => ({ id, ord_date, ord_time });
        const ids = (rows: { id: string }[]) => rows.map(x => x.id);

        it('sorts by (ord_date, ord_time) oldest first, by milliseconds within a second', () => {
            const rows = [
                r('c', '20261023', '090000500'),
                r('a', '20261022', '133000000'),
                r('d', '20261023', '090000501'),
                r('b', '20261023', '090000050'),
            ];
            expect(ids(sortEsunOrderResultsOldestFirst(rows))).toEqual(['a', 'b', 'c', 'd']);
        });

        it('pads ord_time to 9 digits (leading zero dropped) and treats 6 digits as HHMMSS', () => {
            const rows = [r('late', '20261023', '100000000'), r('early', '20261023', '93000123'), r('hhmmss', '20261023', '093000')];
            expect(ids(sortEsunOrderResultsOldestFirst(rows))).toEqual(['hhmmss', 'early', 'late']);
            expect(esunOrderSortKey({ ord_date: '2026-10-23', ord_time: '93000123' })).toBe('20261023093000123');
            expect(esunOrderSortKey({ ord_date: '20261023', ord_time: '093000' })).toBe('20261023093000000');
        });

        it('keeps rows without date or time first, in their original relative order, and is stable', () => {
            const rows = [
                r('t2', '20261023', '090000000'),
                r('noTime1', '20261023', ''),
                r('t1', '20261022', '090000000'),
                r('noDate', undefined, '090000000'),
                r('same1', '20261023', '090000000'),
                r('noTime2', '20261023'),
            ];
            expect(ids(sortEsunOrderResultsOldestFirst(rows))).toEqual(['noTime1', 'noDate', 'noTime2', 't1', 't2', 'same1']);
            expect(ids(rows)).toEqual(['t2', 'noTime1', 't1', 'noDate', 'same1', 'noTime2']); // 不改動輸入
        });
    });

    it('converts production transaction qty (shares) to lots for profit loss rows', () => {
        // 正式環境形狀（合成數值）：qty 是股數，price_qty = 價 × 股
        const rawTx = [
            { stk_no: '2884', t_date: '20261023', buy_sell: 'S', trade: '0', qty: '3000', price: '30.50', price_qty: '91500', make: '1200' },
            { stk_no: '1342', t_date: '20261023', buy_sell: 'S', trade: '0', qty: '40', price: '512', price_qty: '20480', make: '-500' },
            { stk_no: '2885', t_date: '20261023', buy_sell: 'S', trade: '0', qty: '2500', price: '25', price_qty: '62500', make: '100' },
        ];
        const pl = fromEsunTransactionsToProfitLoss(rawTx as never);
        expect(pl.map(r => [r.code, r.quantity])).toEqual([
            ['2884', 3],
            ['1342', 0.04],
            ['2885', 2.5],
        ]);
        // 價格仍是每股價
        expect(pl[0]?.price).toBe(30.5);
        expect(pl[1]?.price).toBe(512);
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
