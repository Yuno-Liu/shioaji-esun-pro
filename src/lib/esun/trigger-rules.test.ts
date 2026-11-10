import { describe, expect, it } from 'vitest';
import type { ContractBase } from '../types/contract';
import { esunTriggerProblem } from './trigger-rules';

const ESUN = { broker_id: '8840' };
const ESUN_SIM = { broker_id: '8840-SIM' };
const SINOPAC = { broker_id: '9A95' };
const stk = (over: Partial<ContractBase> = {}) => ({ code: '2890', security_type: 'STK', exchange: 'TSE', ...over }) as ContractBase;
const sell = { action: 'Sell' as const, quantity: 1, price: 44 };

describe('esunTriggerProblem（fork：觸價單建立時的玉山檢查）', () => {
    it('不是玉山帳戶一律不檢查', () => {
        expect(esunTriggerProblem(SINOPAC, stk({ security_type: 'WRT' } as never), sell)).toBeNull();
        expect(esunTriggerProblem(null, stk({ exchange: 'OES' } as never), sell)).toBeNull();
    });

    it('玉山不收的商品在建立時就擋下（正式與模擬帳戶都一樣）', () => {
        expect(esunTriggerProblem(ESUN, stk({ code: '030001', security_type: 'WRT' } as never), sell)).toContain('權證');
        expect(esunTriggerProblem(ESUN_SIM, stk({ code: '030001', security_type: 'WRT' } as never), sell)).toContain('權證');
        expect(esunTriggerProblem(ESUN, stk({ exchange: 'OES' } as never), sell)).toContain('興櫃');
        expect(esunTriggerProblem(ESUN, stk({ security_type: 'FUT' } as never), sell)).toContain('僅支援台股現貨');
    });

    it('玉山不收的條件與數量也在建立時擋下', () => {
        expect(esunTriggerProblem(ESUN, stk(), { ...sell, orderCond: 'SBLShort' })).toContain('借券');
        expect(esunTriggerProblem(ESUN, stk(), { ...sell, quantity: 500 })).toContain('1 至 499 張');
        expect(esunTriggerProblem(ESUN, stk(), { ...sell, orderLot: 'IntradayOdd', quantity: 1000 })).toContain('1 至 999 股');
    });

    it('一般的玉山股票觸價單照常建立（市價、限價、零股、信用、當沖先賣）', () => {
        expect(esunTriggerProblem(ESUN, stk(), sell)).toBeNull();
        expect(esunTriggerProblem(ESUN, stk(), { ...sell, send: { type: 'LMT' } })).toBeNull();
        // 零股觸發時以限價送出（orderPlanFor），不會被「零股不支援市價」擋下
        expect(esunTriggerProblem(ESUN, stk(), { ...sell, orderLot: 'IntradayOdd', quantity: 300 })).toBeNull();
        expect(esunTriggerProblem(ESUN, stk(), { ...sell, orderCond: 'MarginTrading' })).toBeNull();
        expect(esunTriggerProblem(ESUN, stk(), { ...sell, orderCond: 'ShortSelling' })).toBeNull();
        expect(esunTriggerProblem(ESUN, stk(), { ...sell, daytradeShort: true })).toBeNull();
    });

    it('收盤前平倉不檢查（數量 0、範圍可以是整個帳戶，時間到時逐筆檢查）', () => {
        const flatten = { action: 'Sell' as const, quantity: 0, price: 0, time: { kind: 'flatten' } };
        expect(esunTriggerProblem(ESUN, stk(), flatten)).toBeNull();
        expect(esunTriggerProblem(ESUN, stk({ code: '030001', security_type: 'WRT' } as never), flatten)).toBeNull();
        expect(esunTriggerProblem(ESUN, stk({ exchange: 'OES' } as never), flatten)).toBeNull();
    });

    it('數量未定（0）時不以數量擋下，但商品規則照樣檢查', () => {
        expect(esunTriggerProblem(ESUN, stk(), { action: 'Sell', quantity: 0, time: { kind: 'send' } })).toBeNull();
        expect(esunTriggerProblem(ESUN, stk({ code: '030001', security_type: 'WRT' } as never), { action: 'Sell', quantity: 0 })).toContain('權證');
    });

    it('價格要到觸發時才決定：沒有觸發價的限價單不因價格被擋', () => {
        expect(esunTriggerProblem(ESUN, stk(), { action: 'Buy', quantity: 1, send: { type: 'LMT' } })).toBeNull();
        expect(esunTriggerProblem(ESUN, stk(), { action: 'Buy', quantity: 1, price: 0, send: { type: 'LMT' } })).toBeNull();
    });
});
