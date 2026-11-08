// 持倉多選市價出清的確認授權（§10 S10）：沒有批次回 none；完全相符才 approve 且只一次；任一欄位不符、
// 沒有 arm、等待模式逾時都 reject 並中止整批；end 清除狀態。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountConfirmLabel, type OrderConfirmRequest } from '../../lib/order-confirm';
import {
    armBatchExit,
    BATCH_WAIT_MS,
    batchExitAbortReason,
    decideBatchConfirm,
    isBatchExitActive,
    setBatchExit,
    subscribeBatchExit,
    type ExpectedConfirm,
} from './batch-exit-auth';

const acc = { account_type: 'S', broker_id: '9A95', account_id: '1234567', person_id: 'A', signed: true, username: '' };
const acc2 = { ...acc, account_id: '7654321' };

const expected: ExpectedConfirm = { code: '2330', action: 'Sell', quantity: 3500, unit: '股', credit: undefined, account: acc, simulation: true };

/** 與 lib placeStockExitByShares 的確認請求相同的欄位（市價、股、帳戶標籤、已取得模式） */
const request = (over: Partial<OrderConfirmRequest> = {}): OrderConfirmRequest => ({
    code: '2330', name: '台積電', action: 'Sell', price: null, quantity: 3500, unit: '股',
    accountLabel: accountConfirmLabel(acc), note: '拆為 3 張市價＋500 股盤中零股限價', simulation: true, awaitingMode: false, modeUnavailable: false,
    ...over,
});

beforeEach(() => { setBatchExit(false); });
afterEach(() => {
    setBatchExit(false);
    vi.useRealTimers();
});

describe('decideBatchConfirm', () => {
    it('沒有批次：一律 none（確認面板照常）', () => {
        expect(isBatchExitActive()).toBe(false);
        expect(decideBatchConfirm(request())).toBe('none');
        armBatchExit(expected); // 沒有批次時 arm 無效
        expect(decideBatchConfirm(request())).toBe('none');
    });

    it('完全相符：approve 一次；同一筆再來（或下一個請求）→ reject 並中止', () => {
        setBatchExit(true);
        armBatchExit(expected);
        expect(decideBatchConfirm(request())).toBe('approve');
        expect(batchExitAbortReason()).toBeNull();
        expect(decideBatchConfirm(request())).toBe('reject');
        expect(batchExitAbortReason()).toBe('unarmed');
        // 中止後再 arm 也無效
        armBatchExit(expected);
        expect(decideBatchConfirm(request())).toBe('reject');
    });

    it('融資（信用名稱）與期貨（口、無信用）相符時 approve', () => {
        setBatchExit(true);
        armBatchExit({ ...expected, credit: '融資', quantity: 2000 });
        expect(decideBatchConfirm(request({ credit: '融資', quantity: 2000 }))).toBe('approve');
        const fut = { ...acc, account_type: 'F', broker_id: 'F002000' };
        armBatchExit({ code: 'TXFL6', action: 'Buy', quantity: 2, unit: '口', credit: undefined, account: fut, simulation: false });
        expect(decideBatchConfirm(request({ code: 'TXFL6', action: 'Buy', quantity: 2, unit: '口', accountLabel: accountConfirmLabel(fut), simulation: false }))).toBe('approve');
    });

    const cases: [string, Partial<OrderConfirmRequest>, string][] = [
        ['商品', { code: '2317' }, 'code'],
        ['買賣', { action: 'Buy' }, 'action'],
        ['數量', { quantity: 3000 }, 'quantity'],
        ['限價', { price: 963 }, 'price'],
        ['單位', { unit: '張' }, 'unit'],
        ['信用多出', { credit: '融資' }, 'credit'],
        ['帳戶', { accountLabel: accountConfirmLabel(acc2) }, 'accountLabel'],
        ['帳戶缺', { accountLabel: undefined }, 'accountLabel'],
        ['觸價行情', { livePriceCode: '2330' }, 'livePriceCode'],
        ['環境不同', { simulation: false }, 'simulation'],
        ['環境未知', { simulation: null }, 'simulation'],
        ['伺服器變更', { serverChanged: true }, 'mode'],
        ['模式無法確認', { modeUnavailable: true }, 'mode'],
    ];
    for (const [name, over, reason] of cases) {
        it(`不符（${name}）→ reject 並中止，記錄原因`, () => {
            setBatchExit(true);
            armBatchExit(expected);
            expect(decideBatchConfirm(request(over))).toBe('reject');
            expect(batchExitAbortReason()).toBe(reason);
            // 一次性：不符後 armed 已清除
            expect(decideBatchConfirm(request())).toBe('reject');
        });
    }

    it('預期有信用、請求沒有 → reject', () => {
        setBatchExit(true);
        armBatchExit({ ...expected, credit: '融券' });
        expect(decideBatchConfirm(request())).toBe('reject');
        expect(batchExitAbortReason()).toBe('credit');
    });

    it('批次進行中但沒有 arm（例如其他流程的確認）→ reject', () => {
        setBatchExit(true);
        expect(decideBatchConfirm(request())).toBe('reject');
        expect(batchExitAbortReason()).toBe('unarmed');
    });

    it('解除 arm（null）後的請求 → reject', () => {
        setBatchExit(true);
        armBatchExit(expected);
        armBatchExit(null);
        expect(decideBatchConfirm(request())).toBe('reject');
    });

    it('awaitingMode：wait；模式取得後相符 → approve', () => {
        vi.useFakeTimers();
        setBatchExit(true);
        armBatchExit(expected);
        expect(decideBatchConfirm(request({ awaitingMode: true, simulation: null }))).toBe('wait');
        vi.advanceTimersByTime(BATCH_WAIT_MS - 1);
        expect(decideBatchConfirm(request({ awaitingMode: true, simulation: null, modeUnavailable: true }))).toBe('wait');
        expect(decideBatchConfirm(request())).toBe('approve');
    });

    it('awaitingMode 超過 10 秒：逾時時通知訂閱者，重新判斷 → reject', () => {
        vi.useFakeTimers();
        const listener = vi.fn();
        const off = subscribeBatchExit(listener);
        setBatchExit(true);
        armBatchExit(expected);
        listener.mockClear();
        expect(decideBatchConfirm(request({ awaitingMode: true, simulation: null }))).toBe('wait');
        vi.advanceTimersByTime(BATCH_WAIT_MS);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(decideBatchConfirm(request({ awaitingMode: true, simulation: null }))).toBe('reject');
        expect(batchExitAbortReason()).toBe('timeout');
        off();
    });

    it('結束批次（finally）清除：之後回 none；再開始的批次沒有舊的 arm 與中止原因', () => {
        const listener = vi.fn();
        const off = subscribeBatchExit(listener);
        setBatchExit(true);
        armBatchExit(expected);
        decideBatchConfirm(request({ code: '2317' }));
        expect(batchExitAbortReason()).not.toBeNull();
        setBatchExit(false);
        expect(isBatchExitActive()).toBe(false);
        expect(decideBatchConfirm(request())).toBe('none');
        expect(listener).toHaveBeenCalledTimes(2);
        setBatchExit(true);
        expect(batchExitAbortReason()).toBeNull();
        expect(decideBatchConfirm(request())).toBe('reject');
        off();
    });
});
