// 持倉頁（規格 §6.6、§7.2、§14.1）：
// 股票平倉呼叫 placeStockExitByShares（含 orderCond）；stockExitFor 回傳原因時不送出；期貨平倉 ocType 'Cover'、價格 null；
// 說明面板未按「繼續」不呼叫 lib；ResumeGate 不允許時 beforeSend 丟出；結果分類（取消／未送出／結果未知）；
// 加碼在帳戶不同時不直接開啟面板；信用部位加碼停用；合計與遮蔽；更新鍵冷卻。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { AccountedPosition } from '../../lib/types/portfolio';

const m = vi.hoisted(() => {
    class OrderConfirmCancelled extends Error {
        readonly mutationNotStarted = true as const;
        constructor() { super('已取消下單'); this.name = 'OrderConfirmCancelled'; }
    }
    return {
        OrderConfirmCancelled,
        live: true,
        gate: { state: 'ready', since: 0, checks: null, staleAcknowledged: false, resumeSeq: 0, message: null } as {
            state: 'ready' | 'resyncing' | 'stale-data' | 'failed'; since: number; checks: null; staleAcknowledged: boolean; resumeSeq: number; message: string | null;
        },
        trading: {} as Record<string, unknown>,
        accounts: {} as { accounts: unknown[]; selectedStock: unknown; selectedFutures: unknown },
        contracts: {} as Record<string, unknown>,
        privMoney: false,
        locked: false,
        placeStockExitByShares: vi.fn(),
        placeQuickOrder: vi.fn(),
        notify: vi.fn(),
        refreshTradingState: vi.fn(async () => undefined),
        ensureContract: vi.fn(async () => undefined),
        reconcileAfterUnknownOutcome: vi.fn(),
        openTicket: vi.fn(),
        navigate: vi.fn(),
        selectAccount: vi.fn(),
        assertResumeReady: vi.fn(),
        acknowledgeStaleData: vi.fn(),
        retryResume: vi.fn(),
    };
});

type Acc = { account_type: string; broker_id: string; account_id: string; signed?: boolean };
function same(a?: Acc | null, b?: Acc | null): boolean {
    return !!a && !!b && a.account_type === b.account_type && a.broker_id === b.broker_id && a.account_id === b.account_id;
}

vi.mock('../../hooks/use-stream', () => ({ useTradingLive: () => m.live }));
vi.mock('../../lib/account-store', () => ({
    useAccounts: () => m.accounts,
    getAccountState: () => m.accounts,
    selectAccount: (a: Acc) => {
        m.selectAccount(a);
        if (a.account_type === 'S') m.accounts = { ...m.accounts, selectedStock: a };
        else m.accounts = { ...m.accounts, selectedFutures: a };
    },
}));
vi.mock('../../lib/account-tradable', () => ({ canTrade: (a?: Acc | null) => !!a && a.signed !== false }));
vi.mock('../../lib/contracts-cache', () => ({
    useContract: (code: string | null) => (code ? m.contracts[code] : undefined),
    ensureContract: m.ensureContract,
}));
vi.mock('../../lib/esun', () => ({ isEsunAccount: (a?: { broker_id?: string } | null) => !!a?.broker_id?.startsWith('ESUN') }));
vi.mock('../../lib/flash-account', () => ({ accountMatches: (a?: Acc | null, b?: Acc | null) => same(a, b) }));
vi.mock('../../lib/order-outcome', () => ({ reconcileAfterUnknownOutcome: m.reconcileAfterUnknownOutcome }));
vi.mock('../../lib/privacy', () => ({
    maskMoney: (t: string, p: boolean) => (p ? '•••••' : t),
    secretMoney: (t: string | number) => String(t),
    usePrivacyMode: () => false,
    usePrivacyMoney: () => m.privMoney,
}));
vi.mock('../../lib/trade', () => ({
    notify: m.notify,
    placeQuickOrder: m.placeQuickOrder,
    placeStockExitByShares: m.placeStockExitByShares,
    OrderConfirmCancelled: m.OrderConfirmCancelled,
}));
vi.mock('../../lib/trading-state', () => ({
    RECONCILE_REASON_LABELS: { disconnect: '串流中斷', 'query-failed': '查詢失敗' },
    refreshTradingState: m.refreshTradingState,
    useTradingState: () => m.trading,
}));
vi.mock('../components/route-badge', () => ({ RouteBadge: () => null }));
vi.mock('../components/account-switch-sheet', () => ({
    mobileAccountLabel: (a: { account_id: string }) => `***${a.account_id.slice(-4)}`,
    useAccountSwitchLocked: () => m.locked,
}));
vi.mock('../hooks/use-mobile-ticket', () => ({
    OUTCOME_UNKNOWN_TITLE: '結果未知：請到委託頁按『更新』核對，勿重送',
    classifyTicketOutcome: (err: unknown) =>
        err instanceof m.OrderConfirmCancelled ? 'cancelled' : (err as { mutationNotStarted?: boolean } | null)?.mutationNotStarted === true ? 'not-sent' : 'unknown',
}));
vi.mock('../hooks/use-resume-gate', () => ({ useResumeGate: () => m.gate }));
vi.mock('../lib/resume-gate-runtime', () => ({
    getResumeGate: () => m.gate,
    acknowledgeStaleData: () => {
        m.acknowledgeStaleData();
        if (m.gate.state === 'stale-data') m.gate = { ...m.gate, staleAcknowledged: true };
    },
    retryResume: m.retryResume,
    assertResumeReady: (opts: { allowStale?: boolean } = {}) => {
        m.assertResumeReady(opts);
        const s = m.gate;
        if (s.state === 'ready') return;
        if (opts.allowStale === true && s.state === 'stale-data' && s.staleAcknowledged) return;
        throw Object.assign(new Error('回到前景後正在重新同步行情與委託，這筆沒有送出，請稍候再試'), { mutationNotStarted: true });
    },
}));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));
vi.mock('../lib/mobile-store', () => ({ openTicket: m.openTicket }));

import { addOnBlockReason, closePlanFor, PositionsPage, REFRESH_COOLDOWN_MS, reconcileText } from './positions-page';

const stockAcc = { account_type: 'S', broker_id: '9A95', account_id: '1234567', person_id: 'A', signed: true, username: '' };
const stockAcc2 = { account_type: 'S', broker_id: 'ESUN1', account_id: '7777777', person_id: 'A', signed: true, username: '' };
const futAcc = { account_type: 'F', broker_id: 'F002000', account_id: '7654321', person_id: 'A', signed: true, username: '' };

const stk2330 = {
    exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 1070, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as ContractInfo;
const txf = { ...stk2330, exchange: 'TAIFEX', code: 'TXFL6', security_type: 'FUT', name: '台指期', limit_up: 25000, limit_down: 20000 } as ContractInfo;

const stockPos = (over: Record<string, unknown> = {}) =>
    ({ id: 1, code: '2330', direction: 'Buy', quantity: 3500, price: 1052.5, last_price: 1085, pnl: 97500, yd_quantity: 3500, cond: 'Cash', account: stockAcc, ...over }) as AccountedPosition;
const futPos = (over: Record<string, unknown> = {}) =>
    ({ id: 2, code: 'TXFL6', direction: 'Buy', quantity: 2, price: 22800, last_price: 22950, pnl: 30000, account: futAcc, ...over }) as AccountedPosition;

function setPositions(positions: AccountedPosition[], query: Record<string, unknown> = {}) {
    m.trading = { positions, queries: { positions: { updatedAt: 1, needsReconcile: false, error: null, reasons: [], ...query } } };
}

let view: ReactTestRenderer | undefined;
async function render() {
    await act(async () => { view = create(createElement(PositionsPage)); });
}
async function rerender() {
    await act(async () => { view!.update(createElement(PositionsPage)); });
}
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string): ReactTestInstance => view!.root.find(n => n.props['data-testid'] === id && typeof n.type === 'string');
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const pageText = () => textOf(view!.root);
async function click(node: ReactTestInstance) {
    await act(async () => { node.props.onClick(); });
}
/** 第一次呼叫的參數（未呼叫時為空陣列，斷言會失敗） */
const firstCall = (f: ReturnType<typeof vi.fn>) => f.mock.calls[0] ?? [];
const rowOf = (code: string) => view!.root.find(n => n.props['data-testid'] === 'position-row' && n.props['data-code'] === code);
const inRow = (code: string, id: string) => rowOf(code).find(n => n.props['data-testid'] === id && typeof n.type === 'string');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.live = true;
    m.gate = { state: 'ready', since: 0, checks: null, staleAcknowledged: false, resumeSeq: 0, message: null };
    m.accounts = { accounts: [stockAcc, stockAcc2, futAcc], selectedStock: stockAcc, selectedFutures: futAcc };
    m.contracts = { '2330': stk2330, TXFL6: txf };
    m.privMoney = false;
    m.locked = false;
    setPositions([stockPos(), futPos()]);
    for (const f of [m.placeStockExitByShares, m.placeQuickOrder, m.notify, m.reconcileAfterUnknownOutcome, m.openTicket, m.navigate, m.selectAccount, m.assertResumeReady, m.acknowledgeStaleData, m.retryResume]) f.mockReset();
    m.placeStockExitByShares.mockResolvedValue([]);
    m.placeQuickOrder.mockResolvedValue({});
    m.refreshTradingState.mockClear();
    m.ensureContract.mockClear();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('純函式', () => {
    it('closePlanFor：現股、融資（整張）、融券零股拒絕、缺商品資料、缺帳戶', () => {
        expect(closePlanFor(stockPos(), stk2330)).toEqual({ kind: 'stock', account: stockAcc, contract: stk2330, action: 'Sell', shares: 3500 });
        expect(closePlanFor(stockPos({ cond: 'MarginTrading', quantity: 2000 }), stk2330)).toMatchObject({ action: 'Sell', shares: 2000, orderCond: 'MarginTrading' });
        expect(closePlanFor(stockPos({ cond: 'ShortSelling', direction: 'Sell', quantity: 1500 }), stk2330)).toMatch(/融券持倉股數不是整張/);
        expect(closePlanFor(stockPos(), undefined)).toMatch(/商品資料/);
        expect(closePlanFor(stockPos({ account: undefined }), stk2330)).toMatch(/帳戶歸屬不明/);
        expect(closePlanFor(futPos({ direction: 'Sell' }), txf)).toEqual({ kind: 'futures', account: futAcc, contract: txf, action: 'Buy', lots: 2 });
    });

    it('addOnBlockReason：信用部位與現股空單停用；現股多單與期貨可加碼', () => {
        expect(addOnBlockReason(stockPos({ cond: 'MarginTrading' }))).toBe('信用交易加碼將於後續版本提供');
        expect(addOnBlockReason(stockPos({ cond: 'ShortSelling', direction: 'Sell' }))).toBe('信用交易加碼將於後續版本提供');
        expect(addOnBlockReason(stockPos({ direction: 'Sell' }))).toMatch(/當沖先賣/);
        expect(addOnBlockReason(stockPos())).toBeNull();
        expect(addOnBlockReason(futPos({ direction: 'Sell' }))).toBeNull();
    });

    it('reconcileText：列出對帳原因', () => {
        expect(reconcileText({ needsReconcile: false, error: null, reasons: [] })).toBeNull();
        expect(reconcileText({ needsReconcile: true, error: null, reasons: ['disconnect', 'query-failed'] })).toMatch(/^待對帳：串流中斷、查詢失敗/);
    });
});

describe('PositionsPage 顯示', () => {
    it('每列顯示代碼名稱、條件、多空文字、股數以張＋股；合計標示（估）', async () => {
        await render();
        expect(all('position-row')).toHaveLength(2);
        const stockRow = textOf(rowOf('2330'));
        expect(stockRow).toContain('台積電');
        expect(stockRow).toContain('現股');
        expect(stockRow).toContain('多');
        expect(stockRow).toContain('3張+500股');
        expect(stockRow).toContain('+97,500');
        expect(textOf(rowOf('TXFL6'))).toContain('2 口');
        expect(textOf(rowOf('TXFL6'))).toContain('期貨');
        expect(textOf(one('position-total'))).toBe('+127,500');
        expect(pageText()).toContain('（估）');
    });

    it('遮蔽金額：合計、損益、數量都遮蔽', async () => {
        m.privMoney = true;
        await render();
        expect(textOf(one('position-total'))).toBe('•••••');
        expect(textOf(rowOf('2330'))).not.toContain('97,500');
        expect(textOf(rowOf('2330'))).not.toContain('3張');
    });

    it('帳戶篩選：只顯示該帳戶持倉，合計跟著改變', async () => {
        setPositions([stockPos(), stockPos({ id: 9, account: stockAcc2, pnl: -1000, code: '2317' }), futPos()]);
        await render();
        await act(async () => { one('position-account-filter').props.onChange({ target: { value: 'S:ESUN1:7777777' } }); });
        expect(all('position-row')).toHaveLength(1);
        expect(textOf(one('position-total'))).toBe('-1,000');
    });

    it('對帳 banner 與載入中', async () => {
        setPositions([stockPos()], { needsReconcile: true, reasons: ['disconnect'] });
        await render();
        expect(textOf(one('position-reconcile'))).toContain('串流中斷');
        setPositions([], { updatedAt: null });
        await rerender();
        expect(pageText()).toContain('持倉載入中');
    });

    it('「⟳」呼叫 refreshTradingState(positions)，6 秒內停用', async () => {
        vi.useFakeTimers();
        await render();
        await click(one('position-refresh'));
        expect(m.refreshTradingState).toHaveBeenCalledWith('positions');
        expect(one('position-refresh').props.disabled).toBe(true);
        await act(async () => { vi.advanceTimersByTime(REFRESH_COOLDOWN_MS - 1); });
        expect(one('position-refresh').props.disabled).toBe(true);
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(one('position-refresh').props.disabled).toBe(false);
    });

    it('Q2：持倉尚未讀到時合計顯示「—」，讀到後才顯示金額（含 0）', async () => {
        setPositions([], { updatedAt: null });
        await render();
        expect(textOf(one('position-total'))).toBe('—');
        // 首次讀取失敗、仍沒有資料：合計仍未知
        setPositions([], { updatedAt: null, error: 'S 持倉查詢失敗', needsReconcile: true, reasons: ['query-failed'] });
        await rerender();
        expect(textOf(one('position-total'))).toBe('—');
        setPositions([], { updatedAt: 5 });
        await rerender();
        expect(textOf(one('position-total'))).not.toBe('—');
        expect(textOf(one('position-total'))).toMatch(/0/);
    });

    it('看圖導向交易頁', async () => {
        await render();
        await click(inRow('TXFL6', 'position-chart'));
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: 'TXFL6' });
    });
});

describe('平倉', () => {
    it('說明面板未按「繼續」不呼叫 lib；取消關閉面板', async () => {
        await render();
        await click(inRow('2330', 'position-close'));
        expect(all('position-close-sheet')).toHaveLength(1);
        expect(textOf(one('position-close-sheet'))).toContain('整張以市價（IOC）');
        expect(textOf(one('position-close-sheet'))).toContain('盤中零股限價');
        expect(m.placeStockExitByShares).not.toHaveBeenCalled();
        expect(m.placeQuickOrder).not.toHaveBeenCalled();
        const cancel = one('position-close-sheet').find(n => n.type === 'button' && textOf(n) === '取消');
        await click(cancel);
        expect(all('position-close-sheet')).toHaveLength(0);
        expect(m.placeStockExitByShares).not.toHaveBeenCalled();
    });

    it('股票（融資）平倉：placeStockExitByShares(contract, 動作, 股數, 持倉帳戶, { orderCond, beforeSend })，成功通知並關閉', async () => {
        setPositions([stockPos({ cond: 'MarginTrading', quantity: 2000 })]);
        await render();
        await click(inRow('2330', 'position-close'));
        await click(one('position-close-continue'));
        expect(m.placeStockExitByShares).toHaveBeenCalledTimes(1);
        const [contract, action, shares, account, opts] = firstCall(m.placeStockExitByShares);
        expect(contract).toBe(stk2330);
        expect(action).toBe('Sell');
        expect(shares).toBe(2000);
        expect(account).toBe(stockAcc);
        expect(opts.orderCond).toBe('MarginTrading');
        expect(typeof opts.beforeSend).toBe('function');
        expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok', title: '平倉委託已送出' }));
        expect(all('position-close-sheet')).toHaveLength(0);
    });

    it('現股平倉：orderCond 為 undefined（現股）', async () => {
        await render();
        await click(inRow('2330', 'position-close'));
        await click(one('position-close-continue'));
        const [, action, shares, , opts] = firstCall(m.placeStockExitByShares);
        expect(action).toBe('Sell');
        expect(shares).toBe(3500);
        expect(opts.orderCond).toBeUndefined();
    });

    it('stockExitFor 回傳原因時顯示原因、「繼續」停用、不送出', async () => {
        setPositions([stockPos({ cond: 'ShortSelling', direction: 'Sell', quantity: 1500 })]);
        await render();
        await click(inRow('2330', 'position-close'));
        expect(textOf(one('position-close-problem'))).toMatch(/融券持倉股數不是整張/);
        expect(one('position-close-continue').props.disabled).toBe(true);
        await click(one('position-close-continue'));
        expect(m.placeStockExitByShares).not.toHaveBeenCalled();
    });

    it('商品資料（漲跌停）取不到：停用並說明', async () => {
        m.contracts = { TXFL6: txf };
        await render();
        await click(inRow('2330', 'position-close'));
        expect(textOf(one('position-close-problem'))).toMatch(/商品資料/);
        expect(one('position-close-continue').props.disabled).toBe(true);
    });

    it('期貨平倉：placeQuickOrder(contract, 反向, null, 口數, { account, ocType: Cover, source: manual, beforeSend })', async () => {
        setPositions([futPos({ direction: 'Sell', quantity: 3 })]);
        await render();
        await click(inRow('TXFL6', 'position-close'));
        expect(textOf(one('position-close-sheet'))).toContain('倉別「平倉」');
        await click(one('position-close-continue'));
        expect(m.placeQuickOrder).toHaveBeenCalledTimes(1);
        const [contract, action, price, qty, opts] = firstCall(m.placeQuickOrder);
        expect(contract).toBe(txf);
        expect(action).toBe('Buy');
        expect(price).toBeNull();
        expect(qty).toBe(3);
        expect(opts).toMatchObject({ account: futAcc, ocType: 'Cover', source: 'manual' });
        expect(typeof opts.beforeSend).toBe('function');
    });

    it('beforeSend：ResumeGate 不允許時丟出（mutationNotStarted），允許時以 staleAcknowledged 傳 allowStale', async () => {
        await render();
        await click(inRow('2330', 'position-close'));
        await click(one('position-close-continue'));
        const beforeSend = firstCall(m.placeStockExitByShares)[4].beforeSend as () => void;
        expect(() => beforeSend()).not.toThrow();
        m.gate = { ...m.gate, state: 'resyncing' };
        expect(() => beforeSend()).toThrow(/重新同步/);
        m.gate = { ...m.gate, state: 'stale-data', staleAcknowledged: true };
        expect(() => beforeSend()).not.toThrow();
        expect(m.assertResumeReady).toHaveBeenLastCalledWith({ allowStale: true });
    });

    it('連線未就緒或 ResumeGate 不允許：平倉鍵停用並說明', async () => {
        m.live = false;
        await render();
        expect(inRow('2330', 'position-close').props.disabled).toBe(true);
        expect(textOf(one('position-gate-note'))).toContain('連線未就緒');
        m.live = true;
        m.gate = { ...m.gate, state: 'stale-data', staleAcknowledged: false };
        await rerender();
        expect(inRow('2330', 'position-close').props.disabled).toBe(true);
        m.gate = { ...m.gate, staleAcknowledged: true };
        await rerender();
        expect(inRow('2330', 'position-close').props.disabled).toBe(false);
    });

    it('A-1：stale-data 時頁面 banner 提供勾選「我了解委託／持倉資料可能過期」與「重試同步」；勾選後可平倉', async () => {
        m.gate = { ...m.gate, state: 'stale-data', staleAcknowledged: false, message: '委託／持倉或報價資料可能過期：持倉讀取失敗' };
        await render();
        expect(inRow('2330', 'position-close').props.disabled).toBe(true);
        const note = one('position-gate-stale');
        expect(textOf(note)).toContain('持倉讀取失敗');
        expect(textOf(note)).toContain('我了解委託／持倉資料可能過期');
        const ack = one('position-gate-stale-ack');
        expect(ack.props.type).toBe('checkbox');
        expect(ack.props.checked).toBe(false);

        await click(one('position-gate-stale-retry'));
        expect(m.retryResume).toHaveBeenCalledTimes(1);

        await act(async () => { ack.props.onChange(); });
        expect(m.acknowledgeStaleData).toHaveBeenCalledTimes(1);
        await rerender();
        expect(one('position-gate-stale-ack').props.checked).toBe(true);
        expect(inRow('2330', 'position-close').props.disabled).toBe(false);
        // 勾選本身不送出任何委託
        expect(m.placeStockExitByShares).not.toHaveBeenCalled();
        expect(m.placeQuickOrder).not.toHaveBeenCalled();
    });

    it('A-1：平倉說明面板開啟中轉為 stale-data → 面板內可勾選了解；勾選後「繼續」才可用，仍需確認面板', async () => {
        await render();
        await click(inRow('TXFL6', 'position-close'));
        m.gate = { ...m.gate, state: 'stale-data', staleAcknowledged: false, message: '委託讀取失敗' };
        await rerender();
        expect(one('position-close-continue').props.disabled).toBe(true);
        expect(textOf(one('position-close-problem'))).toContain('我了解委託／持倉資料可能過期');
        await act(async () => { one('position-close-stale-ack').props.onChange(); });
        await rerender();
        expect(one('position-close-continue').props.disabled).toBe(false);
        expect(m.placeQuickOrder).not.toHaveBeenCalled();
        await click(one('position-close-continue'));
        expect(m.placeQuickOrder).toHaveBeenCalledTimes(1);
        const beforeSend = firstCall(m.placeQuickOrder)[4].beforeSend as () => void;
        expect(() => beforeSend()).not.toThrow();
        expect(m.assertResumeReady).toHaveBeenLastCalledWith({ allowStale: true });
    });

    it('A-1：送出中停用勾選與重試', async () => {
        let resolve: (v: unknown) => void = () => undefined;
        m.placeQuickOrder.mockImplementation(() => new Promise(r => { resolve = r; }));
        m.gate = { ...m.gate, state: 'stale-data', staleAcknowledged: true, message: null };
        await render();
        await click(inRow('TXFL6', 'position-close'));
        await click(one('position-close-continue'));
        expect(one('position-gate-stale-retry').props.disabled).toBe(true);
        expect(one('position-close-stale-retry').props.disabled).toBe(true);
        await act(async () => { resolve({}); });
    });

    it('確認面板取消 → 顯示「已取消」，面板保留', async () => {
        m.placeStockExitByShares.mockRejectedValue(new m.OrderConfirmCancelled());
        await render();
        await click(inRow('2330', 'position-close'));
        await click(one('position-close-continue'));
        expect(textOf(one('position-close-feedback'))).toBe('已取消');
        expect(m.notify).not.toHaveBeenCalled();
        expect(m.reconcileAfterUnknownOutcome).not.toHaveBeenCalled();
    });

    it('未送出（mutationNotStarted）→ 顯示原因，面板保留，可再按繼續', async () => {
        m.placeQuickOrder.mockRejectedValue(Object.assign(new Error('風控已鎖單'), { mutationNotStarted: true }));
        await render();
        await click(inRow('TXFL6', 'position-close'));
        await click(one('position-close-continue'));
        expect(textOf(one('position-close-feedback'))).toBe('未送出：風控已鎖單');
        expect(one('position-close-continue').props.disabled).toBe(false);
        expect(m.reconcileAfterUnknownOutcome).not.toHaveBeenCalled();
    });

    it('結果未知 → 琥珀色通知、觸發對帳、關閉面板、不提供重送', async () => {
        m.placeQuickOrder.mockRejectedValue(new Error('timeout'));
        await render();
        await click(inRow('TXFL6', 'position-close'));
        await click(one('position-close-continue'));
        expect(m.placeQuickOrder).toHaveBeenCalledTimes(1);
        expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'err', title: expect.stringContaining('勿重送') }));
        expect(m.reconcileAfterUnknownOutcome).toHaveBeenCalledTimes(1);
        expect(all('position-close-sheet')).toHaveLength(0);
    });

    it('進行中停用「繼續」與其他平倉鍵，重複按不會重送', async () => {
        let resolve: (v: unknown) => void = () => undefined;
        m.placeStockExitByShares.mockImplementation(() => new Promise(r => { resolve = r; }));
        await render();
        await click(inRow('2330', 'position-close'));
        await click(one('position-close-continue'));
        expect(one('position-close-continue').props.disabled).toBe(true);
        expect(inRow('TXFL6', 'position-close').props.disabled).toBe(true);
        await click(one('position-close-continue'));
        expect(m.placeStockExitByShares).toHaveBeenCalledTimes(1);
        await act(async () => { resolve([]); });
        expect(all('position-close-sheet')).toHaveLength(0);
    });
});

describe('加碼', () => {
    it('持倉帳戶即目前選取帳戶：直接開啟下單面板（同方向）', async () => {
        await render();
        await click(inRow('TXFL6', 'position-add'));
        expect(m.openTicket).toHaveBeenCalledWith({ code: 'TXFL6', action: 'Buy', source: 'position' });
    });

    it('帳戶不同：不直接開啟面板，先說明；確認後切換帳戶再開啟', async () => {
        m.accounts = { ...m.accounts, selectedStock: stockAcc2 };
        await render();
        await click(inRow('2330', 'position-add'));
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(all('position-switch-sheet')).toHaveLength(1);
        await click(one('position-switch-confirm'));
        expect(m.selectAccount).toHaveBeenCalledWith(stockAcc);
        expect(m.openTicket).toHaveBeenCalledWith({ code: '2330', action: 'Buy', source: 'position' });
        expect(all('position-switch-sheet')).toHaveLength(0);
    });

    it('帳戶切換鎖定（下單面板或確認進行中）：不可切換', async () => {
        m.accounts = { ...m.accounts, selectedStock: stockAcc2 };
        m.locked = true;
        await render();
        await click(inRow('2330', 'position-add'));
        expect(one('position-switch-confirm').props.disabled).toBe(true);
        await click(one('position-switch-confirm'));
        expect(m.selectAccount).not.toHaveBeenCalled();
        expect(m.openTicket).not.toHaveBeenCalled();
    });

    it('信用部位：加碼鍵停用並說明', async () => {
        setPositions([stockPos({ cond: 'MarginTrading', quantity: 2000 })]);
        await render();
        expect(inRow('2330', 'position-add').props.disabled).toBe(true);
        expect(textOf(inRow('2330', 'position-add-note'))).toBe('信用交易加碼將於後續版本提供');
    });
});
