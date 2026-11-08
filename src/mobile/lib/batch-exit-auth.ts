// src/mobile/lib/batch-exit-auth.ts — 持倉「多選市價出清」的確認授權（首屏；設計規格 §10 S10）
//
// 使用者在出清預覽面板滑動一次＝核准整批；之後每筆 lib 仍會呼叫 requestOrderConfirm()（同一個確認佇列），
// 由根層 OrderConfirmSheet 交給 decideBatchConfirm() 決定，不顯示確認面板。這是唯一會自動核准確認的地方：
// - 只在批次進行中（active）有效；沒有批次時回 'none'，確認面板行為與原本完全相同。
// - 每筆送出前 armBatchExit(預期內容)，一次性：核准後立即清除；沒有 arm、內容不符、等待模式逾時一律 'reject'，
//   reject 同時中止整批（之後的 arm 無效，原因以欄位代碼記在 abortReason）。
// - 比對：代碼、買賣、數量、市價（price === null）、單位、信用名稱、無 livePriceCode、帳戶標籤
//   （決定當下以 accountConfirmLabel(account) 重算）、環境（request.simulation 與預覽時看到的布林值 ===，null 一定不符）、
//   modeUnavailable／serverChanged 皆為假。awaitingMode 時先 'wait'（最多 BATCH_WAIT_MS，逾時通知訂閱者，再判斷為 'reject'）。
// - 首屏體積：原因只記英文欄位代碼，顯示文字由持倉頁 chunk 對照（lib/batch-exit.ts 的 BATCH_ABORT_TEXT）。

import { accountConfirmLabel, type OrderConfirmRequest } from '../../lib/order-confirm';
import type { Action } from '../../lib/types/order';
import type { Account } from '../../lib/types/portfolio';

/** 這一筆 lib 確認請求應有的內容 */
export interface ExpectedConfirm {
    code: string;
    action: Action;
    /** 股票＝股數、期貨＝口數 */
    quantity: number;
    /** orderQtyUnit(isFutures, isFutures ? undefined : 'IntradayOdd') */
    unit: string;
    /** 股票＝creditLabel(action, orderCond)；期貨＝undefined */
    credit: string | undefined;
    account: Pick<Account, 'broker_id' | 'account_id'>;
    /** 預覽面板顯示的這個帳戶環境（true＝模擬、false＝正式） */
    simulation: boolean;
}

export type BatchDecision = 'none' | 'wait' | 'approve' | 'reject';

/** 等待伺服器模式的上限 */
export const BATCH_WAIT_MS = 10_000;

let active = false;
let armed: ExpectedConfirm | null = null;
let abortReason: string | null = null;
// 等待模式：第一次 wait 起算；逾時由計時器設旗標（不比對牆鐘：系統時間被調整也不會永遠等待）
let waitStarted = false;
let timedOut = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(l => l());

export function subscribeBatchExit(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export const isBatchExitActive = (): boolean => active;
/** 中止原因（欄位代碼、'mode'、'unarmed'、'timeout'）；沒有中止為 null */
export const batchExitAbortReason = (): string | null => abortReason;

/** 這一筆送出前設定預期內容（null＝解除）；批次未進行或已中止時一律解除。一併清除等待模式的計時 */
export function armBatchExit(expected: ExpectedConfirm | null): void {
    armed = active && abortReason === null ? expected : null;
    clearTimeout(timer);
    waitStarted = false;
    timedOut = false;
}

/** 開始（true）或結束（false，finally 一定呼叫）批次；兩者都清除 arm 與中止原因 */
export function setBatchExit(on: boolean): void {
    active = on;
    abortReason = null;
    armBatchExit(null);
    emit();
}

function reject(reason: string): 'reject' {
    abortReason ??= reason;
    armBatchExit(null);
    return 'reject';
}

/** 不符的欄位名稱（OrderConfirmRequest 的欄位；'mode'＝modeUnavailable／serverChanged）；全部相符回 null */
function mismatch(r: OrderConfirmRequest, a: ExpectedConfirm): string | null {
    const want: Partial<Record<keyof OrderConfirmRequest, unknown>> = {
        code: a.code,
        action: a.action,
        quantity: a.quantity,
        price: null,
        unit: a.unit,
        credit: a.credit,
        livePriceCode: undefined,
        accountLabel: accountConfirmLabel(a.account),
        simulation: a.simulation,
    };
    for (const k in want) if (r[k as keyof OrderConfirmRequest] !== want[k as keyof OrderConfirmRequest]) return k;
    return r.modeUnavailable || r.serverChanged ? 'mode' : null;
}

/** 根層確認面板在批次進行中對每個確認請求呼叫；'approve' 為一次性 */
export function decideBatchConfirm(r: OrderConfirmRequest): BatchDecision {
    if (!active) return 'none';
    const a = armed;
    if (!a) return reject('unarmed');
    if (r.awaitingMode) {
        if (!waitStarted) {
            waitStarted = true;
            timer = setTimeout(() => { timedOut = true; emit(); }, BATCH_WAIT_MS);
        }
        return timedOut ? reject('timeout') : 'wait';
    }
    const why = mismatch(r, a);
    if (why) return reject(why);
    armBatchExit(null);
    return 'approve';
}
