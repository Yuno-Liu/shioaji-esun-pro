// src/mobile/lib/batch-exit.ts — 持倉「多選市價出清」的執行器（持倉頁 chunk；設計規格 §7.7、§10 S10）
//
// 使用者在預覽面板滑動一次後由持倉頁呼叫 runBatchExit()：
// - 依序一次一筆，筆與筆之間至少 BATCH_GAP_MS；整批期間 setBatchExit(true)，finally 一定 setBatchExit(false)。
// - 每筆送出前：以目前交易狀態重新驗證（同一帳戶、同一持倉、數量、方向、條件不變，closePlanFor 重算後內容相同），
//   不同就「略過（持倉已變動）」並繼續；ResumeGate／連線不允許就把這筆與其餘標「未送出（原因）」並停止。
// - armBatchExit(預期確認) → execute(plan)（＝executeClose，保留 beforeSend: closeBeforeSend）→ 解除 arm。
//   lib 內部的確認請求由根層 OrderConfirmSheet 交給 lib/batch-exit-auth 判斷（不顯示面板）。
// - 結果（classifyTicketOutcome）：成功＝已送出；cancelled（授權不符或確認被取消）＝停止其餘；
//   not-sent＝記錄原因，閘門此時不允許就停止，否則繼續；結果未知＝通知 OUTCOME_UNKNOWN、reconcileAfterUnknownOutcome()，
//   並停止（S8：不重送）。
// - 「停止剩餘」：送出中的那一筆無法取消，送完（或略過）後不再送下一筆。
// - 結束時送一則摘要通知（只有筆數，沒有金額與帳號）。

import { creditLabel, orderQtyUnit } from '../../lib/odd-lot';
import { reconcileAfterUnknownOutcome } from '../../lib/order-outcome';
import { notify } from '../../lib/trade';
import type { AccountedPosition } from '../../lib/types/portfolio';
import { accountKeyOf } from '../components/position-metrics';
import { classifyTicketOutcome, OUTCOME_UNKNOWN_TITLE } from '../hooks/use-mobile-ticket';
import type { ClosePlan } from '../routes/positions-page';
import { armBatchExit, batchExitAbortReason, setBatchExit, type ExpectedConfirm } from './batch-exit-auth';

/** 筆與筆之間的最短間隔 */
export const BATCH_GAP_MS = 300;

export type BatchItemStatus = 'waiting' | 'sending' | 'sent' | 'not-sent' | 'skipped' | 'unknown';

export interface BatchItemState {
    status: BatchItemStatus;
    /** 未送出、略過、結果未知的原因 */
    reason?: string;
}

/** 滑動當下的一筆（持倉快照、平倉方式、預覽時看到的該帳戶環境） */
export interface BatchExitItem {
    /** positionKey（帳戶、代碼、方向、條件、id） */
    key: string;
    position: AccountedPosition;
    plan: ClosePlan;
    simulation: boolean;
}

export const BATCH_TEXT = {
    changed: '持倉已變動',
    stopped: '已停止剩餘',
    aborted: '批次已中止',
    afterUnknown: '前一筆結果未知，已停止',
    confirmCancelled: '確認已取消（例如畫面重新同步），未送出',
    summaryTitle: '市價出清結果',
} as const;

/** 授權不符的欄位代碼（lib/batch-exit-auth）→ 顯示文字 */
export const BATCH_ABORT_TEXT: Record<string, string> = {
    code: '商品',
    action: '買賣',
    quantity: '數量',
    price: '價格（非市價）',
    unit: '單位',
    credit: '信用條件',
    livePriceCode: '觸價行情',
    accountLabel: '帳戶',
    simulation: '環境',
    mode: '伺服器模式',
    unarmed: '非預期的確認',
    timeout: '確認伺服器模式逾時',
};

export function abortReasonText(code: string): string {
    return `自動確認不符（${BATCH_ABORT_TEXT[code] ?? code}），未送出`;
}

/** 這一筆 lib 確認請求應有的內容（同 lib：股票一次確認兩腳＝股數、單位以盤中零股計；期貨＝口數） */
export function expectedConfirmOf(plan: ClosePlan, simulation: boolean): ExpectedConfirm {
    const fut = plan.kind === 'futures';
    return {
        code: plan.contract.code,
        action: plan.action,
        quantity: plan.kind === 'futures' ? plan.lots : plan.shares,
        unit: orderQtyUnit(fut, fut ? undefined : 'IntradayOdd'),
        credit: plan.kind === 'futures' ? undefined : creditLabel(plan.action, plan.orderCond),
        account: plan.account,
        simulation,
    };
}

/** 兩個平倉方式送出的內容相同（帳戶、商品、買賣、數量、信用條件） */
export function samePlan(a: ClosePlan, b: ClosePlan): boolean {
    if (a.kind !== b.kind || a.action !== b.action || a.contract.code !== b.contract.code || accountKeyOf(a.account) !== accountKeyOf(b.account)) return false;
    if (a.kind === 'stock' && b.kind === 'stock') return a.shares === b.shares && a.orderCond === b.orderCond;
    return a.kind === 'futures' && b.kind === 'futures' && a.lots === b.lots;
}

export interface BatchRunDeps {
    /** 目前交易狀態中同一個 positionKey 的持倉與 closePlanFor 結果；找不到回 null */
    current: (item: BatchExitItem) => { position: AccountedPosition; plan: ClosePlan | string } | null;
    /** closeGateProblem(live, getResumeGate())：不允許的原因；允許為 null */
    gateProblem: () => string | null;
    /** executeClose(plan) */
    execute: (plan: ClosePlan) => Promise<void>;
    /** 使用者按了「停止剩餘」 */
    stopRequested: () => boolean;
    onState: (index: number, state: BatchItemState) => void;
    wait?: (ms: number) => Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err ?? ''));
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/** 摘要（通知與完成畫面）：只有筆數，沒有金額與帳號 */
export function batchSummaryText(states: readonly BatchItemState[]): string {
    const n = (s: BatchItemStatus) => states.filter(x => x.status === s).length;
    const parts = [`已送出 ${n('sent')} 筆`];
    for (const [s, label] of [['not-sent', '未送出'], ['skipped', '略過'], ['unknown', '結果未知']] as const) if (n(s)) parts.push(`${label} ${n(s)} 筆`);
    return parts.join('・');
}

export async function runBatchExit(items: readonly BatchExitItem[], deps: BatchRunDeps): Promise<BatchItemState[]> {
    const states: BatchItemState[] = items.map(() => ({ status: 'waiting' }));
    const set = (i: number, s: BatchItemState) => {
        states[i] = s;
        deps.onState(i, s);
    };
    const stopFrom = (from: number, reason: string) => {
        for (let j = from; j < items.length; j++) if (states[j]!.status === 'waiting') set(j, { status: 'not-sent', reason });
    };
    const wait = deps.wait ?? sleep;
    setBatchExit(true);
    try {
        for (let i = 0; i < items.length; i++) {
            const item = items[i]!;
            if (i > 0) await wait(BATCH_GAP_MS);
            if (deps.stopRequested()) { stopFrom(i, BATCH_TEXT.stopped); break; }
            // 1. 以目前交易狀態重新驗證（同一持倉、同數量，closePlanFor 重算後內容相同）
            const now = deps.current(item);
            const plan = now && now.position.quantity === item.position.quantity && now.position.direction === item.position.direction
                && typeof now.plan !== 'string' && samePlan(now.plan, item.plan) ? now.plan : null;
            if (!plan) { set(i, { status: 'skipped', reason: BATCH_TEXT.changed }); continue; }
            // 2. 閘門
            const gate = deps.gateProblem();
            if (gate) { stopFrom(i, gate); break; }
            // 3. 送出（只核准這一筆的確認）
            set(i, { status: 'sending' });
            armBatchExit(expectedConfirmOf(plan, item.simulation));
            try {
                await deps.execute(plan);
                set(i, { status: 'sent' });
            } catch (err) {
                const outcome = classifyTicketOutcome(err);
                if (outcome === 'cancelled') {
                    const why = batchExitAbortReason();
                    set(i, { status: 'not-sent', reason: why ? abortReasonText(why) : BATCH_TEXT.confirmCancelled });
                    stopFrom(i + 1, BATCH_TEXT.aborted);
                    break;
                }
                if (outcome === 'not-sent') {
                    set(i, { status: 'not-sent', reason: errorText(err) });
                    const after = deps.gateProblem();
                    if (after) { stopFrom(i + 1, after); break; }
                    continue;
                }
                // 結果未知：不重送（S8）、觸發對帳、停止
                set(i, { status: 'unknown', reason: errorText(err) });
                notify({ kind: 'err', title: OUTCOME_UNKNOWN_TITLE, body: `${plan.contract.code} 市價出清：${errorText(err)}` });
                reconcileAfterUnknownOutcome();
                stopFrom(i + 1, BATCH_TEXT.afterUnknown);
                break;
            } finally {
                armBatchExit(null);
            }
        }
    } finally {
        setBatchExit(false);
    }
    const bad = states.some(s => s.status === 'unknown');
    notify({ kind: bad ? 'err' : states.every(s => s.status === 'sent') ? 'ok' : 'info', title: BATCH_TEXT.summaryTitle, body: batchSummaryText(states) });
    return states;
}
