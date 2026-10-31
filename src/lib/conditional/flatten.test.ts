// src/lib/conditional/flatten.test.ts — 全平並取消 (#226): recomputed from
// fresh positions, closes exactly what is held, never reverses. All broker
// I/O is mocked: no order is sent.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountedPosition, Account } from '../types/portfolio';

const F: Account = { account_type: 'F', broker_id: 'bf', account_id: 'f1', person_id: '', signed: true, username: '' };
const S: Account = { account_type: 'S', broker_id: 'bs', account_id: 's1', person_id: '', signed: true, username: '' };

const m = vi.hoisted(() => ({
    trades: vi.fn(),
    positions: vi.fn(),
    cancel: vi.fn(),
    place: vi.fn(),
    order: [] as string[],
    same: true,
}));
vi.mock('../server-info-store', () => ({ captureServerMode: () => () => m.same }));
vi.mock('../account-store', () => ({ getAccountState: () => ({ accounts: [F, S] }) }));
vi.mock('../account-tradable', () => ({ canTrade: () => true }));
vi.mock('../account-query', () => ({ createAccountQuery: () => ({ read: (_t: string, a: Account, f: (a: Account) => unknown) => f(a) }) }));
vi.mock('../contracts-cache', () => ({ ensureContract: async (code: string) => { if (code === '9999') throw new Error('contract fetch failed'); return code === '2330'
    ? { code, security_type: 'STK', limit_up: 1100, limit_down: 900 } : { code, security_type: 'FUT', target_code: code }; } }));
vi.mock('../shioaji', () => ({
    fetchTrades: (t: string, a: Account) => { m.order.push(`trades:${a.account_id}`); return m.trades(a); },
    fetchPositions: (t: string, a: Account) => { m.order.push(`positions:${a.account_id}`); return m.positions(a); },
    cancelVerifiedOrder: (row: { order: { id: string } }) => { m.order.push(`cancel:${row.order.id}`); return m.cancel([row.order.id]).then((r: { status: string; value?: unknown; reason?: unknown }[]) => r[0]!.status === 'fulfilled' ? r[0]!.value : Promise.reject(r[0]!.reason)); },
}));
vi.mock('../trade', () => ({ placeQuickOrder: (...a: unknown[]) => { m.order.push(`place:${(a[0] as { code: string }).code}`); return m.place(...a); } }));

const { planFlatten, executeFlatten, loadFlattenPreview, quantityText, closeHowText } = await import('./flatten');
const noWait = async () => undefined;

const pos = (over: Partial<AccountedPosition> & Record<string, unknown>): AccountedPosition =>
    ({ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2, price: 1, last_price: 1, pnl: 0, account: F, ...over }) as AccountedPosition;
const working = (id: string, code: string, account: Account) => ({ contract: { code, target_code: code }, order: { id, account, quantity: 1 },
    status: { status: 'Submitted', deal_quantity: 0, cancel_quantity: 0, deals: [] } });

beforeEach(() => {
    m.same = true;
    m.order = [];
    for (const f of [m.trades, m.positions, m.cancel, m.place]) f.mockReset();
    m.trades.mockResolvedValue([]);
    m.positions.mockResolvedValue([]);
    m.place.mockResolvedValue({ order: { id: 'x' }, status: { status: 'PendingSubmit' } });
});

describe('planFlatten', () => {
    it('closes exactly what is held, on the opposite side; never more, never a reversal', () => {
        const plan = planFlatten([pos({}), pos({ code: 'MXFJ6', direction: 'Sell', quantity: 3 }), pos({ code: 'TXFJ6', quantity: 1 })], { type: 'all' });
        expect(plan.orders).toEqual([
            { account: { account_type: 'F', broker_id: 'bf', account_id: 'f1' }, code: 'TXFJ6', action: 'Sell', quantity: 3, market: 'futures' },
            { account: { account_type: 'F', broker_id: 'bf', account_id: 'f1' }, code: 'MXFJ6', action: 'Buy', quantity: 3, market: 'futures' },
        ]);
    });

    it('no position → no order; both-sided holdings are left to the user', () => {
        expect(planFlatten([], { type: 'all' }).orders).toEqual([]);
        const plan = planFlatten([pos({ code: 'MXFJ6' }), pos({ code: 'MXFJ6', direction: 'Sell' })], { type: 'all' });
        expect(plan.orders).toEqual([]);
        expect(plan.skipped.map(s => s.code)).toEqual(['MXFJ6']);
    });

    it('credit stock positions close with their own condition (whole lots) or are skipped — never as 現股', () => {
        const sa = { account_type: 'S', broker_id: 'bs', account_id: 's1' };
        const plan = planFlatten([pos({ code: '2330', account: S, quantity: 1000, cond: 'MarginTrading' }),
            pos({ code: '1234', account: S, direction: 'Sell', quantity: 2000, cond: 'ShortSelling' }),
            pos({ code: '3008', account: S, direction: 'Sell', quantity: 1500, cond: 'ShortSelling' }),
            pos({ code: '2603', account: S, quantity: 1000, cond: 'Cash' }), pos({ code: '2603', account: S, direction: 'Sell', quantity: 1000, cond: 'ShortSelling' })],
        { type: 'all' });
        expect(plan.orders).toEqual([
            { account: sa, code: '2330', action: 'Sell', quantity: 1000, market: 'stock', cond: 'MarginTrading' },
            { account: sa, code: '1234', action: 'Buy', quantity: 2000, market: 'stock', cond: 'ShortSelling' },
        ]);
        expect(plan.skipped.map(s => [s.code, s.reason])).toEqual([
            ['3008', expect.stringContaining('整張')],
            ['2603', expect.stringContaining('現股與信用部位')],
        ]);
        expect(closeHowText('stock', 2000, 'ShortSelling')).toBe('融券買進・整股市價');
    });

    it('scope: this product / this account', () => {
        const rows = [pos({}), pos({ code: '2330', account: S, quantity: 1500, cond: 'Cash' })];
        expect(planFlatten(rows, { type: 'code', codes: ['TXFJ6'], account: null }).orders.map(o => o.code)).toEqual(['TXFJ6']);
        expect(planFlatten(rows, { type: 'account', account: { account_type: 'S', broker_id: 'bs', account_id: 's1' } }).orders)
            .toEqual([{ account: { account_type: 'S', broker_id: 'bs', account_id: 's1' }, code: '2330', action: 'Sell', quantity: 1500, market: 'stock' }]);
    });
});

describe('executeFlatten', () => {
    const stopConditional = vi.fn(async () => ({ stopped: 2, failed: [] as string[] }));

    it('stops conditionals, cancels, then re-reads positions (fills during the cancel count) and closes with MKP + Cover', async () => {
        m.trades.mockImplementation(async (a: Account) => a === F ? [working('w1', 'TXFJ6', F)] : []);
        m.cancel.mockResolvedValue([{ status: 'fulfilled', value: { status: { status: 'Cancelled' } } }]);
        // the cancel raced a fill: 3 lots now, not the 2 shown before
        m.positions.mockImplementation(async (a: Account) => a === F ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 3 }] : []);
        const r = await executeFlatten({ type: 'code', codes: ['TXFJ6'], account: null }, { sleep: noWait, stopConditional });
        expect(stopConditional).toHaveBeenCalledTimes(1);
        expect(m.order.indexOf('cancel:w1')).toBeLessThan(m.order.indexOf('positions:f1'));
        expect(m.place).toHaveBeenCalledTimes(1);
        const [, action, price, qty, opts] = m.place.mock.calls[0]!;
        expect([action, price, qty, opts.ocType, opts.futuresPriceType, opts.account.account_id]).toEqual(['Sell', null, 3, 'Cover', 'MKP', 'f1']);
        expect(r).toMatchObject({ stopped: 2, cancelled: 1, sent: [{ code: 'TXFJ6', action: 'Sell', quantity: 3 }] });
    });

    it('the hold shared with the background engine lost: nothing more is cancelled or closed', async () => {
        m.trades.mockImplementation(async (a: Account) => a === F ? [working('w1', 'TXFJ6', F)] : []);
        m.cancel.mockResolvedValue([{ status: 'fulfilled', value: { status: { status: 'Cancelled' } } }]);
        m.positions.mockImplementation(async (a: Account) => a === F ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 1 }] : []);
        // still held for the cancels, lost before the close
        const owned = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
        const r = await executeFlatten({ type: 'code', codes: ['TXFJ6'], account: null }, { sleep: noWait, stopConditional, stillOwned: owned });
        expect(m.order).toContain('cancel:w1');
        expect(m.place).not.toHaveBeenCalled();
        expect(r.notSent.join()).toContain('執行權已失效');
        // lost before the cancels: nothing at all
        m.order = [];
        const none = await executeFlatten({ type: 'code', codes: ['TXFJ6'], account: null },
            { sleep: noWait, stopConditional, stillOwned: async () => false });
        expect(m.order.some(o => o.startsWith('cancel') || o.startsWith('place'))).toBe(false);
        expect(none.notSent.join()).toContain('執行權已失效');
    });

    it('a product whose cancel is not confirmed is not closed', async () => {
        m.trades.mockImplementation(async (a: Account) => a === F ? [working('w1', 'TXFJ6', F)] : []);
        m.cancel.mockResolvedValue([{ status: 'rejected', reason: new Error('CANCEL_UNCONFIRMED') }]);
        m.positions.mockImplementation(async (a: Account) => a === F ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2 }] : []);
        const r = await executeFlatten({ type: 'all' }, { sleep: noWait, stopConditional });
        expect(m.place).not.toHaveBeenCalled();
        expect(r.notSent.join()).toContain('刪單未確認，未平倉');
    });

    it('a failed position read sends nothing for that account; flat accounts send nothing', async () => {
        m.positions.mockImplementation(async (a: Account) => { if (a === F) throw new Error('timeout'); return []; });
        const r = await executeFlatten({ type: 'all' }, { sleep: noWait, stopConditional });
        expect(m.place).not.toHaveBeenCalled();
        expect(r.notSent.join()).toContain('持倉查詢失敗');
    });

    it('stocks: whole lots at market, the odd remainder as an odd-lot limit at the price limit', async () => {
        m.positions.mockImplementation(async (a: Account) => a === S ? [{ id: 1, code: '2330', direction: 'Buy', quantity: 2300, cond: 'Cash' }] : []);
        await executeFlatten({ type: 'account', account: { account_type: 'S', broker_id: 'bs', account_id: 's1' } }, { sleep: noWait, stopConditional });
        expect(m.place.mock.calls.map(c => [c[1], c[2], c[3], (c[4] as { orderLot?: string }).orderLot])).toEqual([
            ['Sell', null, 2, undefined], ['Sell', 900, 300, 'IntradayOdd']]);
    });

    it('a contract read that fails before sending is reported as not sent and is not read back (review)', async () => {
        m.positions.mockImplementation(async (a: Account) => a === S ? [{ id: 1, code: '9999', direction: 'Sell', quantity: 2000, cond: 'ShortSelling' }] : []);
        const reads = m.positions.mock.calls.length;
        const r = await executeFlatten({ type: 'account', account: { account_type: 'S', broker_id: 'bs', account_id: 's1' } }, { sleep: noWait, stopConditional });
        expect(m.place).not.toHaveBeenCalled();
        expect(r.sent).toEqual([]);
        expect(r.notSent).toEqual([expect.stringContaining('9999：未送出（商品資料讀取失敗，未送出委託：contract fetch failed）')]);
        expect(r.notSent.join()).not.toContain('結果不明');
        expect(r.remaining).toEqual([]);
        expect(m.positions.mock.calls.length - reads).toBe(1);
    });

    it('a short closes as ONE whole-lot Buy with ShortSelling (no odd leg)', async () => {
        m.positions.mockImplementation(async (a: Account) => a === S ? [{ id: 1, code: '2330', direction: 'Sell', quantity: 2000, cond: 'ShortSelling' }] : []);
        const r = await executeFlatten({ type: 'account', account: { account_type: 'S', broker_id: 'bs', account_id: 's1' } }, { sleep: noWait, stopConditional });
        expect(m.place.mock.calls.map(c => [c[1], c[2], c[3], (c[4] as { orderCond?: string }).orderCond, (c[4] as { orderLot?: string }).orderLot]))
            .toEqual([['Buy', null, 2, 'ShortSelling', undefined]]);
        expect(r.sent).toMatchObject([{ code: '2330', action: 'Buy', quantity: 2000 }]);
    });

    it('a conditional order that could not be stopped, or one still sending, blocks everything', async () => {
        m.positions.mockImplementation(async (a: Account) => a === F ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2 }] : []);
        const r1 = await executeFlatten({ type: 'all' }, { sleep: noWait, stopConditional: async () => ({ stopped: 0, failed: ['TXFJ6 觸價單：沒有回應'] }) });
        expect(r1.notSent.join()).toContain('沒有全部停止');
        const r2 = await executeFlatten({ type: 'all' }, { sleep: noWait, stopConditional, waitInFlight: async () => false });
        expect(r2.notSent.join()).toContain('送出中');
        expect(m.cancel).not.toHaveBeenCalled();
        expect(m.place).not.toHaveBeenCalled();
    });

    it('after waiting for in-flight orders the conditional orders are stopped again; a server switch stops the close', async () => {
        const stops = vi.fn(async () => ({ stopped: 1, failed: [] as string[] }));
        m.positions.mockImplementation(async (a: Account) => a === F ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2 }] : []);
        m.trades.mockImplementation(async () => { m.same = false; return []; }); // the mode changes meanwhile
        const r = await executeFlatten({ type: 'all' }, { sleep: noWait, stopConditional: stops, waitInFlight: async () => true });
        expect(stops).toHaveBeenCalledTimes(2);
        expect(m.place).not.toHaveBeenCalled();
        expect(r.notSent.join()).toContain('已切換');
    });

    it('every close carries the same server-mode guard', async () => {
        m.positions.mockImplementation(async (a: Account) => a === F ? [{ id: 1, code: 'TXFJ6', direction: 'Sell', quantity: 1 }] : []);
        await executeFlatten({ type: 'all' }, { sleep: noWait, stopConditional });
        expect(typeof (m.place.mock.calls[0]![4] as { serverMode: unknown }).serverMode).toBe('function');
        expect(m.place.mock.calls[0]![1]).toBe('Buy');
    });

    it('a switch while the conditional orders are being stopped: nothing is cancelled or closed', async () => {
        m.trades.mockImplementation(async (a: Account) => a === F ? [working('w1', 'TXFJ6', F)] : []);
        m.positions.mockImplementation(async (a: Account) => a === F ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2 }] : []);
        const r = await executeFlatten({ type: 'all' }, { sleep: noWait, stopConditional: async () => { m.same = false; return { stopped: 0, failed: [] }; } });
        expect(m.cancel).not.toHaveBeenCalled();
        expect(m.place).not.toHaveBeenCalled();
        expect(r.notSent.join()).toContain('已切換');
    });
});

describe('read-back after sending (2330 QA 10/12)', () => {
    const stopConditional = vi.fn(async () => ({ stopped: 0, failed: [] as string[] }));

    it('an IOC market sell that filled only partly: the rest is reported per product, in 張＋股', async () => {
        let reads = 0;
        // before: 8 張 + 6 股; after the sends: 7 張 still held (IOC cancelled the rest)
        m.positions.mockImplementation(async (a: Account) => a !== S ? []
            : [{ id: 1, code: '2330', direction: 'Buy', quantity: reads++ === 0 ? 8006 : 7000, cond: 'Cash' }]);
        const waits: number[] = [];
        const r = await executeFlatten({ type: 'account', account: { account_type: 'S', broker_id: 'bs', account_id: 's1' } },
            { stopConditional, sleep: async ms => { waits.push(ms); } });
        expect(r.sent).toMatchObject([{ code: '2330', quantity: 8006, market: 'stock' }]);
        expect(r.remaining).toEqual([{ account: { account_type: 'S', broker_id: 'bs', account_id: 's1' }, code: '2330', action: 'Sell', quantity: 7000, market: 'stock' }]);
        expect(waits.length).toBe(3); // kept checking, then reported
    });

    it('everything closed: nothing remaining after the first read-back', async () => {
        let reads = 0;
        m.positions.mockImplementation(async (a: Account) => a === F && reads++ === 0 ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 1 }] : []);
        const waits: number[] = [];
        const r = await executeFlatten({ type: 'all' }, { stopConditional, sleep: async ms => { waits.push(ms); } });
        expect(r.remaining).toEqual([]);
        expect(waits.length).toBe(1);
    });

    it('a failed read-back stays to be checked (unconfirmed), never reported as closed', async () => {
        let reads = 0;
        m.positions.mockImplementation(async (a: Account) => {
            if (a !== F) return [];
            if (reads++ === 0) return [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 1 }];
            throw new Error('timeout');
        });
        const r = await executeFlatten({ type: 'all' }, { stopConditional, sleep: noWait });
        expect(r.remaining).toMatchObject([{ code: 'TXFJ6', quantity: 1, unconfirmed: true }]);
    });

    it('a holding the read-back cannot read (both sides) stays unconfirmed, never closed (review)', async () => {
        let reads = 0;
        m.positions.mockImplementation(async (a: Account) => {
            if (a !== F) return [];
            return reads++ === 0 ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 1 }]
                : [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 1 }, { id: 2, code: 'TXFJ6', direction: 'Sell', quantity: 1 }];
        });
        const r = await executeFlatten({ type: 'all' }, { stopConditional, sleep: noWait });
        expect(r.remaining).toMatchObject([{ code: 'TXFJ6', unconfirmed: true }]);
    });

    it('stocks: whole lots sent, the odd remainder failed: counted as sent in part and read back (review)', async () => {
        let reads = 0;
        m.positions.mockImplementation(async (a: Account) => a !== S ? []
            : [{ id: 1, code: '2330', direction: 'Buy', quantity: reads++ === 0 ? 8006 : 6, cond: 'Cash' }]);
        m.place.mockImplementation(async (_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { orderLot?: string }) => {
            if (opts.orderLot === 'IntradayOdd') throw new Error('timeout');
            return { order: { id: 'x' }, status: { status: 'PendingSubmit' } };
        });
        const r = await executeFlatten({ type: 'account', account: { account_type: 'S', broker_id: 'bs', account_id: 's1' } }, { stopConditional, sleep: noWait });
        expect(r.sent).toMatchObject([{ code: '2330', quantity: 8000 }]);
        expect(r.notSent.join()).toContain('2330');
        expect(r.remaining).toMatchObject([{ code: '2330', quantity: 6 }]);
    });

    it('wording: 張＋股 and 整股市價、零股限價', () => {
        expect(quantityText('stock', 8006)).toBe('8 張＋6 股');
        expect(quantityText('stock', 300)).toBe('300 股');
        expect(quantityText('futures', 2)).toBe('2 口');
        expect(closeHowText('stock', 8006)).toBe('整股市價、零股限價');
        expect(closeHowText('stock', 2000)).toBe('整股市價');
        expect(closeHowText('stock', 6)).toBe('零股限價');
        expect(closeHowText('futures', 1)).toBe('範圍市價');
    });
});

describe('loadFlattenPreview (QA 10/12: preview showed 2 lots when 1 was held)', () => {
    it('reads positions and orders fresh for every account in scope', async () => {
        m.positions.mockImplementation(async (a: Account) => a === F ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 1 }] : []);
        m.trades.mockImplementation(async (a: Account) => a === F ? [working('w1', 'TXFJ6', F)] : []);
        const d = await loadFlattenPreview({ type: 'all' });
        expect(m.order.filter(o => o.startsWith('positions:')).sort()).toEqual(['positions:f1', 'positions:s1']);
        expect(planFlatten(d.positions, { type: 'all' }).orders).toMatchObject([{ code: 'TXFJ6', quantity: 1 }]);
        expect(d.trades).toHaveLength(1);
        expect(d.failed).toEqual([]);
    });

    it('a failed account is reported, the others still load', async () => {
        m.positions.mockImplementation(async (a: Account) => { if (a === S) throw new Error('timeout'); return [{ id: 1, code: 'TXFJ6', direction: 'Sell', quantity: 1 }]; });
        const d = await loadFlattenPreview({ type: 'all' });
        expect(d.failed.join()).toContain('證券帳戶查詢失敗');
        expect(d.positions).toHaveLength(1);
    });
});

