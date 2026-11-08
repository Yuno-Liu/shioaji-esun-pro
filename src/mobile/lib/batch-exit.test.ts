// 持倉多選市價出清的執行器（§7.7、§10 S10）：依序一次一筆；每筆送出前重新驗證與檢查閘門；
// 授權經真正的 lib/batch-exit-auth：假的 lib 送單函式以與 lib 相同的欄位呼叫假的 requestOrderConfirm，
// 由 decideBatchConfirm() 決定核准或取消（同根層 OrderConfirmSheet 的處理）。不打任何 API。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { creditLabel, orderQtyUnit } from '../../lib/odd-lot';
import { accountConfirmLabel, type OrderConfirmRequest } from '../../lib/order-confirm';
import type { ContractInfo } from '../../lib/types/contract';
import type { Action } from '../../lib/types/order';
import type { Account, AccountedPosition } from '../../lib/types/portfolio';
import type { ClosePlan } from '../routes/positions-page';

const m = vi.hoisted(() => {
    class OrderConfirmCancelled extends Error {
        readonly mutationNotStarted = true as const;
        constructor() { super('已取消下單'); this.name = 'OrderConfirmCancelled'; }
    }
    return { OrderConfirmCancelled, notify: vi.fn(), reconcile: vi.fn() };
});

vi.mock('../../lib/trade', () => ({ notify: m.notify }));
vi.mock('../../lib/order-outcome', () => ({ reconcileAfterUnknownOutcome: m.reconcile }));
vi.mock('../hooks/use-mobile-ticket', () => ({
    OUTCOME_UNKNOWN_TITLE: '結果未知：請到委託頁按『更新』核對，勿重送',
    classifyTicketOutcome: (err: unknown) =>
        err instanceof m.OrderConfirmCancelled ? 'cancelled' : (err as { mutationNotStarted?: boolean } | null)?.mutationNotStarted === true ? 'not-sent' : 'unknown',
}));

import { abortBatchExit, BATCH_STOPPED, batchExitAbortReason, decideBatchConfirm, isBatchExitActive, setBatchExit } from './batch-exit-auth';
import { BATCH_GAP_MS, BATCH_TEXT, expectedConfirmOf, runBatchExit, type BatchExitItem, type BatchItemState, type BatchRunDeps } from './batch-exit';

const acc = (over: Partial<Account> = {}): Account => ({ account_type: 'S', broker_id: '9A95', account_id: '1234567', person_id: 'A', signed: true, username: '', ...over }) as Account;
const sinopac = acc();
const esun = acc({ broker_id: 'ESUN1', account_id: '7777777' });
const fut = acc({ account_type: 'F', broker_id: 'F002000', account_id: '7654321' });

const stk = (code: string, over: Partial<ContractInfo> = {}) => ({
    exchange: 'TSE', code, security_type: 'STK', target_code: null, name: `名稱${code}`, currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 1070, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0, ...over,
}) as ContractInfo;
const txf = stk('TXFL6', { exchange: 'TAIFEX', security_type: 'FUT', name: '台指期' });

const pos = (code: string, account: Account, quantity: number, direction: Action = 'Buy', cond?: string, id = 1) =>
    ({ id, code, direction, quantity, price: 100, last_price: 101, pnl: 0, account, ...(account.account_type === 'S' ? { yd_quantity: quantity, cond: cond ?? 'Cash' } : {}) }) as AccountedPosition;

const stockPlan = (code: string, account: Account, action: Action, shares: number, orderCond?: 'MarginTrading' | 'ShortSelling'): ClosePlan =>
    ({ kind: 'stock', account, contract: stk(code), action, shares, ...(orderCond ? { orderCond } : {}) });
const futPlan = (action: Action, lots: number): ClosePlan => ({ kind: 'futures', account: fut, contract: txf, action, lots });

const item = (key: string, position: AccountedPosition, plan: ClosePlan, simulation = true): BatchExitItem => ({ key, position, plan, simulation });

/** 混合批次：現股含零股（拆兩腳）、融資賣出、玉山帳戶融券買進回補、期貨平倉 */
const mixed = (): BatchExitItem[] => [
    item('a', pos('2330', sinopac, 3500), stockPlan('2330', sinopac, 'Sell', 3500)),
    item('b', pos('2317', sinopac, 2000, 'Buy', 'MarginTrading', 2), stockPlan('2317', sinopac, 'Sell', 2000, 'MarginTrading')),
    item('c', pos('2603', esun, 1000, 'Sell', 'ShortSelling', 3), stockPlan('2603', esun, 'Buy', 1000, 'ShortSelling')),
    item('d', pos('TXFL6', fut, 2, 'Buy', undefined, 4), futPlan('Sell', 2)),
];

// ---- 假的 lib：與 src/lib/trade.ts 的確認欄位相同（一次確認：價格 null、股數、盤中零股單位、信用名稱、帳戶標籤） ----

let env = { simulation: true as boolean | null, awaitingFirst: false };
const requests: OrderConfirmRequest[] = [];
const sends: string[] = [];
/** 每筆送出時呼叫（測試在送出途中改變狀態用）；回傳 Error 則以它結束（模擬 lib 丟出） */
let onSend: ((code: string) => Error | void) | null = null;
/** 模擬 lib 的錯誤：送出的確認內容與實際不同 */
let tamper: ((r: OrderConfirmRequest) => OrderConfirmRequest) | null = null;

/** 假的 requestOrderConfirm：先（可選）awaitingMode 再取得模式；交給授權判斷（同 OrderConfirmSheet 批次路徑） */
async function fakeConfirm(req: Omit<OrderConfirmRequest, 'simulation'>): Promise<boolean> {
    const known = { ...req, simulation: env.simulation, awaitingMode: false, modeUnavailable: false };
    const seq = env.awaitingFirst ? [{ ...known, simulation: null, awaitingMode: true }, known] : [known];
    for (const r0 of seq) {
        const r = tamper ? tamper(r0) : r0;
        requests.push(r);
        const d = decideBatchConfirm(r);
        if (d === 'approve') return true;
        if (d === 'reject' || d === 'none') return false;
    }
    return false;
}

async function placeStockExitByShares(contract: ContractInfo, action: Action, shares: number, account: Account, opts: { orderCond?: string; beforeSend?: () => void }) {
    const orderCond = opts.orderCond && opts.orderCond !== 'Cash' ? opts.orderCond : undefined;
    const lots = Math.floor(shares / 1000);
    const odd = shares % 1000;
    const credit = creditLabel(action, orderCond);
    const ok = await fakeConfirm({
        code: contract.code, name: contract.name, action, price: null, quantity: shares, unit: orderQtyUnit(false, 'IntradayOdd'),
        accountLabel: accountConfirmLabel(account), note: lots > 0 && odd > 0 ? `拆為 ${lots} 張市價＋${odd} 股盤中零股限價` : undefined,
        ...(credit ? { credit } : {}),
    });
    if (!ok) throw new m.OrderConfirmCancelled();
    opts.beforeSend?.();
    const err = onSend?.(contract.code);
    if (err) throw err;
    if (lots > 0) sends.push(`${contract.code} ${action} ${lots}張 MKT IOC${orderCond ? ` ${orderCond}` : ''}`);
    if (odd > 0) sends.push(`${contract.code} ${action} ${odd}股 LMT ${action === 'Sell' ? contract.limit_down : contract.limit_up} IntradayOdd`);
}

async function placeQuickOrder(contract: ContractInfo, action: Action, price: number | null, quantity: number, opts: { account: Account; beforeSend?: () => void }) {
    const ok = await fakeConfirm({ code: contract.code, name: contract.name, action, price, quantity, unit: orderQtyUnit(true), accountLabel: accountConfirmLabel(opts.account), note: '市價・IOC・平倉' });
    if (!ok) throw new m.OrderConfirmCancelled();
    opts.beforeSend?.();
    const err = onSend?.(contract.code);
    if (err) throw err;
    sends.push(`${contract.code} ${action} ${quantity}口 MKT IOC Cover`);
}

/** 同 positions-page executeClose（beforeSend: closeBeforeSend 由 beforeSend spy 代表） */
const beforeSend = vi.fn();
const execute = vi.fn((plan: ClosePlan) => (plan.kind === 'stock'
    ? placeStockExitByShares(plan.contract, plan.action, plan.shares, plan.account, { orderCond: plan.orderCond, beforeSend })
    : placeQuickOrder(plan.contract, plan.action, null, plan.lots, { account: plan.account, beforeSend })));

function deps(items: BatchExitItem[], over: Partial<BatchRunDeps> = {}) {
    const states: Record<number, BatchItemState[]> = {};
    const waits: number[] = [];
    const d: BatchRunDeps = {
        current: (it) => ({ position: it.position, plan: it.plan }),
        gateProblem: () => null,
        execute,
        stopRequested: () => false,
        onState: (i, s) => { (states[i] ??= []).push(s); },
        wait: async (ms) => { waits.push(ms); },
        ...over,
    };
    return { d, states, waits, items };
}

const notSentErr = (msg: string) => Object.assign(new Error(msg), { mutationNotStarted: true as const });

beforeEach(() => {
    env = { simulation: true, awaitingFirst: false };
    requests.length = 0;
    sends.length = 0;
    onSend = null;
    tamper = null;
    m.notify.mockReset();
    m.reconcile.mockReset();
    beforeSend.mockReset();
    execute.mockClear();
});
afterEach(() => { setBatchExit(false); });

describe('expectedConfirmOf：與 lib 的確認欄位相同', () => {
    it('股票＝股數、股、信用名稱（融資賣出、融券買進）；期貨＝口數、口、無信用', () => {
        expect(expectedConfirmOf(stockPlan('2330', sinopac, 'Sell', 3500), true)).toEqual({ code: '2330', action: 'Sell', quantity: 3500, unit: '股', credit: undefined, account: sinopac, simulation: true });
        expect(expectedConfirmOf(stockPlan('2317', sinopac, 'Sell', 2000, 'MarginTrading'), false)).toMatchObject({ unit: '股', credit: '融資', simulation: false });
        expect(expectedConfirmOf(stockPlan('2603', esun, 'Buy', 1000, 'ShortSelling'), true)).toMatchObject({ action: 'Buy', credit: '融券' });
        expect(expectedConfirmOf(futPlan('Sell', 2), true)).toEqual({ code: 'TXFL6', action: 'Sell', quantity: 2, unit: '口', credit: undefined, account: fut, simulation: true });
    });
});

describe('runBatchExit', () => {
    it('混合批次（現股含零股、融資、玉山融券回補、期貨，跨帳戶）：依序逐筆、每筆一次確認並自動核准、間隔 ≥300ms、摘要通知', async () => {
        const { d, states, waits, items } = deps(mixed());
        const result = await runBatchExit(items, d);
        expect(result.map(s => s.status)).toEqual(['sent', 'sent', 'sent', 'sent']);
        // 送出的內容與順序（跨帳戶依清單順序）
        expect(sends).toEqual([
            '2330 Sell 3張 MKT IOC',
            '2330 Sell 500股 LMT 963 IntradayOdd',
            '2317 Sell 2張 MKT IOC MarginTrading',
            '2603 Buy 1張 MKT IOC ShortSelling',
            'TXFL6 Sell 2口 MKT IOC Cover',
        ]);
        // 每筆一次確認（股票兩腳合併確認）
        expect(requests.map(r => [r.code, r.quantity, r.unit, r.credit])).toEqual([
            ['2330', 3500, '股', undefined], ['2317', 2000, '股', '融資'], ['2603', 1000, '股', '融券'], ['TXFL6', 2, '口', undefined],
        ]);
        expect(requests[2]!.accountLabel).toBe(accountConfirmLabel(esun));
        expect(beforeSend).toHaveBeenCalledTimes(4);
        expect(waits).toEqual([BATCH_GAP_MS, BATCH_GAP_MS, BATCH_GAP_MS]);
        expect(BATCH_GAP_MS).toBeGreaterThanOrEqual(300);
        expect(states[0]!.map(s => s.status)).toEqual(['sending', 'sent']);
        expect(m.notify).toHaveBeenCalledTimes(1);
        expect(m.notify.mock.calls[0]![0]).toEqual({ kind: 'ok', title: BATCH_TEXT.summaryTitle, body: '已送出 4 筆' });
        expect(m.reconcile).not.toHaveBeenCalled();
        expect(isBatchExitActive()).toBe(false);
    });

    it('送出前持倉數量改變（或找不到、平倉方式不同）：略過（持倉已變動）並繼續', async () => {
        const items = mixed().slice(0, 3);
        const { d } = deps(items, {
            current: (it) => (it.key === 'a' ? { position: { ...it.position, quantity: 3000 }, plan: it.plan }
                : it.key === 'b' ? null
                    : { position: it.position, plan: it.plan }),
        });
        const result = await runBatchExit(items, d);
        expect(result).toEqual([
            { status: 'skipped', reason: BATCH_TEXT.changed },
            { status: 'skipped', reason: BATCH_TEXT.changed },
            { status: 'sent' },
        ]);
        expect(sends).toEqual(['2603 Buy 1張 MKT IOC ShortSelling']);
        expect(requests).toHaveLength(1);
        // closePlanFor 重算後的內容不同（例如變成不能平倉的原因）也略過
        const { d: d2 } = deps(items.slice(2), { current: (it) => ({ position: it.position, plan: '商品資料（含漲跌停價）尚未載入，暫時無法平倉' }) });
        expect((await runBatchExit(items.slice(2), d2))[0]).toEqual({ status: 'skipped', reason: BATCH_TEXT.changed });
    });

    it('批次中閘門關閉：這筆與其餘標未送出（原因）並停止', async () => {
        let n = 0;
        const { d, items } = deps(mixed(), { gateProblem: () => (++n >= 3 ? '回到前景後正在重新同步行情與委託，暫停平倉' : null) });
        const result = await runBatchExit(items, d);
        // 第 1 筆送出前檢查（n=1）、送出後未發生錯誤；第 2 筆（n=2）送出；第 3 筆（n=3）閘門關閉
        expect(result.map(s => s.status)).toEqual(['sent', 'sent', 'not-sent', 'not-sent']);
        expect(result[2]!.reason).toBe('回到前景後正在重新同步行情與委託，暫停平倉');
        expect(result[3]!.reason).toBe('回到前景後正在重新同步行情與委託，暫停平倉');
        expect(requests).toHaveLength(2);
        expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ kind: 'info', body: '已送出 2 筆・未送出 2 筆' });
    });

    it('未送出（mutationNotStarted）：記錄原因，閘門仍允許就繼續下一筆', async () => {
        onSend = code => (code === '2330' ? notSentErr('券商拒絕：非交易時段') : undefined);
        const { d, items } = deps(mixed().slice(0, 2));
        const result = await runBatchExit(items, d);
        expect(result).toEqual([{ status: 'not-sent', reason: '券商拒絕：非交易時段' }, { status: 'sent' }]);
        expect(sends).toEqual(['2317 Sell 2張 MKT IOC MarginTrading']);
    });

    it('未送出後閘門已不允許：停止其餘', async () => {
        let closed = false;
        onSend = code => { if (code === '2330') { closed = true; return notSentErr('回到前景後正在重新同步行情與委託，這筆沒有送出'); } };
        const { d, items } = deps(mixed(), { gateProblem: () => (closed ? '連線未恢復，暫停平倉；請重新整理頁面' : null) });
        const result = await runBatchExit(items, d);
        expect(result.map(s => s.status)).toEqual(['not-sent', 'not-sent', 'not-sent', 'not-sent']);
        expect(result[1]!.reason).toBe('連線未恢復，暫停平倉；請重新整理頁面');
        expect(requests).toHaveLength(1);
    });

    it('結果未知：通知 OUTCOME_UNKNOWN、觸發對帳、停止，不重送（S8）', async () => {
        onSend = code => (code === '2317' ? new Error('timeout') : undefined);
        const { d, items } = deps(mixed());
        const result = await runBatchExit(items, d);
        expect(result.map(s => s.status)).toEqual(['sent', 'unknown', 'not-sent', 'not-sent']);
        expect(result[2]!.reason).toBe(BATCH_TEXT.afterUnknown);
        expect(execute).toHaveBeenCalledTimes(2);
        expect(m.reconcile).toHaveBeenCalledTimes(1);
        expect(m.notify.mock.calls[0]![0]).toMatchObject({ kind: 'err', title: '結果未知：請到委託頁按『更新』核對，勿重送' });
        expect(m.notify.mock.calls[1]![0]).toMatchObject({ kind: 'err', title: BATCH_TEXT.summaryTitle, body: '已送出 1 筆・未送出 2 筆・結果未知 1 筆' });
    });

    it('「停止剩餘」：送出中的這筆照常完成，之後不再送', async () => {
        let stop = false;
        onSend = () => { stop = true; };
        const { d, items } = deps(mixed(), { stopRequested: () => stop });
        const result = await runBatchExit(items, d);
        expect(result.map(s => s.status)).toEqual(['sent', 'not-sent', 'not-sent', 'not-sent']);
        expect(result[1]!.reason).toBe(BATCH_TEXT.stopped);
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('等待伺服器模式時使用者停止（abortBatchExit）：這一筆也取消並標「已停止剩餘」，其餘不送', async () => {
        env.awaitingFirst = true;
        let stop = false;
        // 模式取得的那一刻之前使用者按了停止
        tamper = r => {
            if (!r.awaitingMode && !stop) { stop = true; abortBatchExit(BATCH_STOPPED); }
            return r;
        };
        const { d, items } = deps(mixed(), { stopRequested: () => stop });
        const result = await runBatchExit(items, d);
        expect(result.map(s => s.status)).toEqual(['not-sent', 'not-sent', 'not-sent', 'not-sent']);
        expect(result[0]!.reason).toBe(BATCH_TEXT.stopped);
        expect(result[1]!.reason).toBe(BATCH_TEXT.stopped);
        expect(sends).toEqual([]);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(isBatchExitActive()).toBe(false);
    });

    it('授權不符（lib 送出的確認與預期不同）：取消、這筆未送出並記錄原因、中止其餘', async () => {
        tamper = r => (r.code === '2317' ? { ...r, quantity: 1000 } : r);
        const { d, items } = deps(mixed());
        const result = await runBatchExit(items, d);
        expect(result.map(s => s.status)).toEqual(['sent', 'not-sent', 'not-sent', 'not-sent']);
        expect(result[1]!.reason).toBe('自動確認不符（數量），未送出');
        expect(result[2]!.reason).toBe(BATCH_TEXT.aborted);
        expect(sends).toEqual(['2330 Sell 3張 MKT IOC', '2330 Sell 500股 LMT 963 IntradayOdd']);
        expect(isBatchExitActive()).toBe(false);
        expect(batchExitAbortReason()).toBeNull();
    });

    it('環境與預覽不同（預覽模擬、確認時正式）：不核准、不送出、中止', async () => {
        env.simulation = false;
        const { d, items } = deps(mixed().slice(0, 2));
        const result = await runBatchExit(items, d);
        expect(result[0]).toEqual({ status: 'not-sent', reason: '自動確認不符（環境），未送出' });
        expect(result[1]!.status).toBe('not-sent');
        expect(sends).toEqual([]);
    });

    it('確認先等待伺服器模式（awaitingMode）再相符：核准送出', async () => {
        env.awaitingFirst = true;
        const { d, items } = deps(mixed().slice(3));
        const result = await runBatchExit(items, d);
        expect(result).toEqual([{ status: 'sent' }]);
        expect(requests.map(r => r.awaitingMode)).toEqual([true, false]);
    });

    it('執行器本身出錯：仍在 finally 結束批次（之後的確認回到一般面板）', async () => {
        const { d, items } = deps(mixed(), { current: () => { throw new Error('boom'); } });
        await expect(runBatchExit(items, d)).rejects.toThrow('boom');
        expect(isBatchExitActive()).toBe(false);
        expect(sends).toEqual([]);
    });
});
