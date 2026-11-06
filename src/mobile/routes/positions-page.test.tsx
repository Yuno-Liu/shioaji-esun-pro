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
        /** useContract 呼叫次數（每個持倉列每次渲染呼叫一次；稽核 P2 重繪範圍） */
        contractCalls: new Map<string, number>(),
        privMoney: false,
        locked: false,
        ydNotice: undefined as string | undefined,
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
        /** 今日額度查詢（摘要卡的額度列經 hooks/use-trading-limits 呼叫）；一律 mock，不靠錯誤邊界吞錯 */
        fetchTradingLimits: vi.fn(),
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
    useContract: (code: string | null) => {
        if (code) m.contractCalls.set(code, (m.contractCalls.get(code) ?? 0) + 1);
        return code ? m.contracts[code] : undefined;
    },
    getCachedContract: (code: string) => m.contracts[code],
    ensureContract: m.ensureContract,
}));
vi.mock('../../lib/server-info-store', () => ({
    useServerInfo: () => null,
    yesterdayQuantityNotice: () => m.ydNotice,
}));
vi.mock('../components/position-esun-details', () => ({
    PositionEsunDetails: ({ position }: { position: { code: string } }) => createElement('div', { 'data-testid': 'stub-esun-detail' }, `明細 ${position.code}`),
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
vi.mock('../../lib/shioaji', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../lib/shioaji')>()),
    fetchTradingLimits: m.fetchTradingLimits,
}));

import { resetTradingCostSettings, setTradingCostSettings } from '../../lib/trading-cost-settings';
import { resetTradingLimitsForTest } from '../hooks/use-trading-limits';
import { POSITIONS_VIEW_KEY, readPositionsView } from '../lib/positions-view';
import { addOnBlockReason, addOnPlanFor, closePlanFor, COMPACT_TEXT, POSITIONS_TEXT, PositionsPage, REFRESH_COOLDOWN_MS, reconcileText, yesterdayText } from './positions-page';

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

const tradingLimits = (over: Record<string, number> = {}) => ({
    trading_limit: 1_000_000, trading_used: 200_000, trading_available: 800_000,
    margin_limit: 0, margin_used: 0, margin_available: 0, short_limit: 0, short_used: 0, short_available: 0, ...over,
});

function setPositions(positions: AccountedPosition[], query: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    m.trading = { positions, queries: { positions: { updatedAt: 1, needsReconcile: false, error: null, reasons: [], ...query } }, ...extra };
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
    m.ydNotice = undefined;
    setPositions([stockPos(), futPos()]);
    for (const f of [m.placeStockExitByShares, m.placeQuickOrder, m.notify, m.reconcileAfterUnknownOutcome, m.openTicket, m.navigate, m.selectAccount, m.assertResumeReady, m.acknowledgeStaleData, m.retryResume]) f.mockReset();
    m.placeStockExitByShares.mockResolvedValue([]);
    m.placeQuickOrder.mockResolvedValue({});
    m.refreshTradingState.mockClear();
    m.ensureContract.mockClear();
    resetTradingLimitsForTest();
    m.fetchTradingLimits.mockReset().mockResolvedValue(tradingLimits());
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

    it('closePlanFor：權證走股票平倉（同 lib contractMarket）；權證沒有零股；其他非證券商品仍是市場不符', () => {
        const wrt = { ...stk2330, code: '030392', security_type: 'WRT', name: '台積電元大5A購01', limit_up: 3.28, limit_down: 0.01 } as ContractInfo;
        expect(closePlanFor(stockPos({ code: '030392', quantity: 2000 }), wrt)).toEqual({ kind: 'stock', account: stockAcc, contract: wrt, action: 'Sell', shares: 2000 });
        expect(closePlanFor(stockPos({ code: '030392', quantity: 1500 }), wrt)).toBe(POSITIONS_TEXT.warrantOddLot);
        expect(closePlanFor(stockPos(), { ...stk2330, security_type: 'IND' } as ContractInfo)).toBe(POSITIONS_TEXT.contractMismatch);
        expect(closePlanFor(stockPos(), txf)).toBe(POSITIONS_TEXT.contractMismatch);
    });

    it('addOnPlanFor：各種部位帶入的方向、單位、信用條件與當沖先賣', () => {
        const noDayTrade = { ...stk2330, day_trade: 'No' } as ContractInfo;
        // 現股多單＝Buy＋Cash（整股）
        expect(addOnPlanFor(stockPos(), stk2330)).toEqual({ request: { code: '2330', action: 'Buy', source: 'position', lot: 'Common', cond: 'Cash' }, note: null });
        // 融資多單＝Buy＋MarginTrading；整張時只說明信用只能整張
        const margin = addOnPlanFor(stockPos({ cond: 'MarginTrading', quantity: 2000 }), stk2330);
        expect(margin).toMatchObject({ request: { action: 'Buy', lot: 'Common', cond: 'MarginTrading' } });
        expect(typeof margin !== 'string' && margin.note).toMatch(/^融資加碼只能整張/);
        expect(typeof margin !== 'string' && margin.note).not.toMatch(/含零股/);
        // 融券空單＝Sell＋ShortSelling；含零股時另外說明
        const short = addOnPlanFor(stockPos({ cond: 'ShortSelling', direction: 'Sell', quantity: 1500 }), stk2330);
        expect(short).toMatchObject({ request: { action: 'Sell', lot: 'Common', cond: 'ShortSelling' } });
        expect(typeof short !== 'string' && short.note).toMatch(/融券加碼只能整張.*含零股/);
        expect(typeof short !== 'string' && short.request.daytradeShort).toBeUndefined();
        // 現股空單＝當沖先賣：可當沖才可用
        expect(addOnPlanFor(stockPos({ direction: 'Sell' }), stk2330)).toMatchObject({
            request: { action: 'Sell', lot: 'Common', cond: 'Cash', daytradeShort: true },
            note: expect.stringContaining('當沖先賣'),
        });
        expect(addOnPlanFor(stockPos({ direction: 'Sell' }), noDayTrade)).toMatch(/不可當沖先賣/);
        expect(addOnPlanFor(stockPos({ direction: 'Sell' }), { ...stk2330, day_trade: 'OnlyBuy' } as ContractInfo)).toMatch(/不可當沖先賣/);
        expect(addOnPlanFor(stockPos({ direction: 'Sell' }), undefined)).toMatch(/商品資料尚未載入/);
        // 期權：只帶同方向
        expect(addOnPlanFor(futPos({ direction: 'Sell' }), txf)).toEqual({ request: { code: 'TXFL6', action: 'Sell', source: 'position' }, note: null });
    });

    it('addOnBlockReason：帳戶不明、方向與條件不符、借券停用；現股多單與期貨可加碼', () => {
        expect(addOnBlockReason(stockPos({ account: undefined }), stk2330)).toMatch(/帳戶歸屬不明/);
        expect(addOnBlockReason(stockPos({ cond: 'MarginTrading', direction: 'Sell' }), stk2330)).toMatch(/方向與信用條件不符/);
        expect(addOnBlockReason(stockPos({ cond: 'SBLShortSelling', direction: 'Sell' }), stk2330)).toMatch(/借券/);
        expect(addOnBlockReason(stockPos({ cond: 'MarginTrading' }), stk2330)).toBeNull();
        expect(addOnBlockReason(stockPos(), undefined)).toBeNull();
        expect(addOnBlockReason(futPos({ direction: 'Sell' }))).toBeNull();
    });

    it('yesterdayText：股票顯示張＋股；永豐昨餘單位待確認時顯示「待確認」（玉山不套用）；遮蔽金額', () => {
        expect(yesterdayText(stockPos({ yd_quantity: 2500 }), undefined, false)).toBe('2張+500股');
        expect(yesterdayText(stockPos(), '模擬昨餘單位待確認', false)).toBe('待確認');
        expect(yesterdayText(stockPos({ account: stockAcc2, yd_quantity: 1000 }), '模擬昨餘單位待確認', false)).toBe('1張');
        expect(yesterdayText(stockPos(), undefined, true)).toBe('•••••');
        expect(yesterdayText(futPos(), undefined, false)).toBeNull();
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
        // 合計改為淨損益：2330 淨損益 91,697（見「淨損益與損益兩平價」）＋期貨券商損益 30,000
        expect(textOf(one('position-total'))).toBe('+121,697');
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
        // 2317 商品資料未載入 → 淨損益無法計算：合計顯示「—」並標「合計待確認」，不以券商 −1,000 代替
        expect(textOf(one('position-total'))).toBe('—');
        expect(textOf(one('position-total-pending'))).toContain('合計待確認：1 筆');
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
        // X3 F2:F5：清單不能說「目前沒有持倉」，比照委託頁提示尚未讀取成功
        expect(textOf(one('position-empty'))).toBe(POSITIONS_TEXT.readFailed);
        expect(pageText()).not.toContain(POSITIONS_TEXT.empty);
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

const margin = (over: Record<string, unknown> = {}) => ({ equity: 1_234_567, initial_margin: 300_000, risk_indicator: 350, ...over });
const txo = { ...txf, code: 'TXO22000L6', security_type: 'OPT', name: '台指選' } as ContractInfo;
const optPos = (over: Record<string, unknown> = {}) =>
    ({ id: 3, code: 'TXO22000L6', direction: 'Sell', quantity: 1, price: 100, last_price: 80, pnl: 1000, account: futAcc, ...over }) as AccountedPosition;
const rowCodes = () => all('position-row').map(n => n.props['data-code'] as string);
async function pickMarket(key: string) {
    await click(one(`position-market-${key}`));
}
async function pickSort(value: string) {
    await act(async () => { one('position-sort').props.onChange({ target: { value } }); });
}

describe('摘要、篩選、排序與分組', () => {
    it('摘要卡：未實現損益合計、股票總市值、期貨權益數與風險指標（附文字）', async () => {
        setPositions([stockPos(), futPos()], {}, { margin: margin() });
        await render();
        expect(textOf(one('position-total'))).toBe('+121,697'); // 淨損益 91,697 ＋ 期貨券商損益 30,000
        expect(all('position-total-pct')).toHaveLength(0); // 混合股票與期貨：不給報酬率合計
        expect(textOf(one('position-market-value'))).toBe('3,797,500'); // 3,500 × 1,085
        expect(textOf(one('position-equity'))).toBe('1,234,567');
        expect(textOf(one('position-risk'))).toBe('350%（正常）');
        expect(textOf(one('position-summary'))).toContain('***4321'); // 期貨帳戶標籤
    });

    it('摘要卡：只看股票時有報酬率合計、不顯示期貨保證金；風險指標無意義時顯示「—」並說明', async () => {
        setPositions([stockPos(), futPos()], {}, { margin: margin({ initial_margin: 0, risk_indicator: 0 }) });
        await render();
        expect(textOf(one('position-risk'))).toBe('—');
        expect(all('position-risk-note')).toHaveLength(1);
        await pickMarket('stock');
        expect(all('position-equity')).toHaveLength(0);
        expect(textOf(one('position-total-pct'))).toBe('（+2.49%）'); // 淨損益 91,697 ÷ (1,052.5 × 3,500)
    });

    it('摘要卡：風險指標低於 100% 標示「危險」；篩選到非目前期貨帳戶時不顯示保證金', async () => {
        const futAcc2 = { ...futAcc, account_id: '1111111' };
        setPositions([futPos(), futPos({ id: 9, account: futAcc2 })], {}, { margin: margin({ risk_indicator: 80 }) });
        await render();
        expect(textOf(one('position-risk'))).toBe('80%（危險）');
        await act(async () => { one('position-account-filter').props.onChange({ target: { value: 'F:F002000:1111111' } }); });
        expect(all('position-equity')).toHaveLength(0);
        await act(async () => { one('position-account-filter').props.onChange({ target: { value: 'F:F002000:7654321' } }); });
        expect(all('position-equity')).toHaveLength(1);
    });

    it('遮蔽金額：市值、權益數、分組小計都遮蔽；不畫損益條', async () => {
        m.privMoney = true;
        setPositions([stockPos(), futPos()], {}, { margin: margin() });
        await render();
        expect(textOf(one('position-market-value'))).toBe('•••••');
        expect(textOf(one('position-equity'))).toBe('•••••');
        for (const h of all('position-group-header')) expect(textOf(h)).not.toMatch(/\d{1,3},\d{3}/);
        expect(all('position-pnl-bar')).toHaveLength(0);
        expect(textOf(rowOf('2330'))).not.toContain('3,683,750'); // 成本
        expect(textOf(rowOf('2330'))).not.toContain('3,797,500'); // 市值
    });

    it('市場分段：股票／期貨／選擇權；期權商品資料未載入時不歸類並說明', async () => {
        m.contracts = { ...m.contracts, TXO22000L6: txo };
        setPositions([stockPos(), futPos(), optPos()]);
        await render();
        expect(rowCodes()).toEqual(['2330', 'TXFL6', 'TXO22000L6']);
        await pickMarket('stock');
        expect(rowCodes()).toEqual(['2330']);
        expect(one('position-market-stock').props['aria-pressed']).toBe(true);
        await pickMarket('futures');
        expect(rowCodes()).toEqual(['TXFL6']);
        expect(textOf(one('position-total'))).toBe('+30,000');
        await pickMarket('options');
        expect(rowCodes()).toEqual(['TXO22000L6']);
        expect(textOf(rowOf('TXO22000L6'))).toContain('選擇權');

        m.contracts = { '2330': stk2330, TXFL6: txf };
        await rerender();
        expect(rowCodes()).toEqual([]);
        expect(textOf(one('position-unclassified'))).toMatch(/^1 筆期權持倉的商品資料尚未載入/);
        expect(pageText()).toContain('此篩選條件下沒有持倉');
    });

    it('排序：損益、報酬率、市值、代碼', async () => {
        setPositions([
            stockPos({ id: 1, code: '2330', price: 1000, quantity: 1000, last_price: 1100, pnl: 100_000 }), // +10%、市值 1,100,000
            stockPos({ id: 2, code: '0050', price: 100, quantity: 2000, last_price: 130, pnl: 60_000 }), // +30%、市值 260,000
            stockPos({ id: 3, code: '2317', price: 200, quantity: 10_000, last_price: 190, pnl: -100_000 }), // −5%、市值 1,900,000
        ]);
        await render();
        expect(rowCodes()).toEqual(['2330', '0050', '2317']);
        await pickSort('pnl');
        expect(rowCodes()).toEqual(['2330', '0050', '2317']);
        await pickSort('return');
        expect(rowCodes()).toEqual(['0050', '2330', '2317']);
        await pickSort('value');
        expect(rowCodes()).toEqual(['2317', '2330', '0050']);
        await pickSort('code');
        expect(rowCodes()).toEqual(['0050', '2317', '2330']);
    });

    it('依帳戶分組：表頭顯示帳戶、筆數、市值、損益小計', async () => {
        m.contracts = { ...m.contracts, '2317': { ...stk2330, code: '2317', name: '鴻海' }, '2454': { ...stk2330, code: '2454', name: '聯發科' } };
        setPositions([
            stockPos(),
            stockPos({ id: 5, code: '2317', account: stockAcc2, quantity: 2000, price: 100, last_price: 110, pnl: 20_000 }),
            stockPos({ id: 6, code: '2454', quantity: 1000, price: 1000, last_price: 990, pnl: -10_000 }),
            futPos(),
        ]);
        await render();
        const headers = all('position-group-header').map(textOf);
        expect(headers).toHaveLength(3);
        expect(headers[0]).toContain('永豐證券 ***4567');
        expect(headers[0]).toContain('2 筆');
        expect(headers[0]).toContain('市值 4,787,500'); // 3,797,500 ＋ 990,000
        // 淨損益：2330 +91,697、2454 −15,806（990,000 − 1,411 − 2,970 − 1,001,425）
        expect(headers[0]).toContain('損益 +75,891');
        expect(headers[1]).toContain('玉山證券 ***7777');
        expect(headers[1]).toContain('1 筆');
        expect(headers[1]).toContain('市值 220,000');
        expect(headers[1]).toContain('損益 +18,741'); // 220,000 − 314 − 660 − 200,285
        expect(headers[2]).toContain('永豐期貨 ***4321');
        expect(headers[2]).not.toContain('市值');
        expect(headers[2]).toContain('損益 +30,000');
    });

    it('持倉列：昨餘、成本、市值、報酬率與損益條；期貨列不顯示成本市值', async () => {
        setPositions([stockPos({ yd_quantity: 2000 }), futPos({ direction: 'Sell', last_price: 22572, pnl: -45_600 })]);
        await render();
        expect(textOf(inRow('2330', 'position-yd'))).toBe('2張');
        expect(textOf(inRow('2330', 'position-cost'))).toBe('3,683,750');
        expect(textOf(inRow('2330', 'position-value'))).toBe('3,797,500');
        expect(textOf(inRow('2330', 'position-return'))).toBe('+2.49%'); // 淨損益 91,697 ÷ 3,683,750
        expect(rowOf('TXFL6').findAll(n => n.props['data-testid'] === 'position-cost')).toHaveLength(0);
        expect(textOf(inRow('TXFL6', 'position-return'))).toBe('+1.00%'); // 空單：(22,572 − 22,800) ÷ 22,800 × −1
        const bar = inRow('2330', 'position-pnl-bar');
        expect(bar.props['aria-hidden']).toBe('true');
        const fill = bar.find(n => typeof n.type === 'string' && n.props.style !== undefined);
        // 設計規格 §14 刻意更新 2：損益條改 scaleX（只動畫 transform），寬度 50% → scaleX(0.5)
        expect(fill.props.style.transform).toBe('scaleX(0.5)');
        m.ydNotice = '模擬昨餘單位待確認';
        await rerender();
        expect(textOf(inRow('2330', 'position-yd'))).toBe('待確認');
    });

    it('玉山股票列可展開庫存明細；永豐與期貨列沒有展開鍵', async () => {
        setPositions([stockPos(), stockPos({ id: 7, code: '2317', account: stockAcc2 }), futPos()]);
        await render();
        expect(rowOf('2330').findAll(n => n.props['data-testid'] === 'position-detail-toggle')).toHaveLength(0);
        expect(rowOf('TXFL6').findAll(n => n.props['data-testid'] === 'position-detail-toggle')).toHaveLength(0);
        const toggle = inRow('2317', 'position-detail-toggle');
        expect(toggle.props['aria-expanded']).toBe(false);
        expect(all('stub-esun-detail')).toHaveLength(0);
        await click(toggle);
        expect(inRow('2317', 'position-detail-toggle').props['aria-expanded']).toBe(true);
        expect(textOf(one('stub-esun-detail'))).toBe('明細 2317');
        await click(inRow('2317', 'position-detail-toggle'));
        expect(all('stub-esun-detail')).toHaveLength(0);
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

    // 設計規格 §10 S1：持倉加碼只呼叫 openTicket；平倉鍵只開說明面板；lib 送出函式呼叫 0 次
    it('S1：加碼只呼叫 openTicket、平倉鍵只開說明面板，lib 送出函式呼叫 0 次', async () => {
        await render();
        await click(inRow('2330', 'position-add'));
        await click(inRow('TXFL6', 'position-add'));
        expect(m.openTicket).toHaveBeenCalledTimes(2);
        await click(inRow('2330', 'position-close'));
        expect(all('position-close-sheet')).toHaveLength(1);
        await click(inRow('2330', 'position-chart'));
        expect(m.placeStockExitByShares).not.toHaveBeenCalled();
        expect(m.placeQuickOrder).not.toHaveBeenCalled();
        expect(m.notify).not.toHaveBeenCalled();
    });

    it('現股多單：帶入 Buy＋整股＋現股', async () => {
        await render();
        await click(inRow('2330', 'position-add'));
        expect(m.openTicket).toHaveBeenCalledWith({ code: '2330', action: 'Buy', source: 'position', lot: 'Common', cond: 'Cash' });
    });

    it('帳戶不同：不直接開啟面板，先說明；確認後切換帳戶再開啟', async () => {
        m.accounts = { ...m.accounts, selectedStock: stockAcc2 };
        await render();
        await click(inRow('2330', 'position-add'));
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(all('position-switch-sheet')).toHaveLength(1);
        await click(one('position-switch-confirm'));
        expect(m.selectAccount).toHaveBeenCalledWith(stockAcc);
        expect(m.openTicket).toHaveBeenCalledWith({ code: '2330', action: 'Buy', source: 'position', lot: 'Common', cond: 'Cash' });
        expect(all('position-switch-sheet')).toHaveLength(0);
    });

    it('帳戶不同的融券空單：切換後帶入 Sell＋ShortSelling', async () => {
        setPositions([stockPos({ account: stockAcc2, cond: 'ShortSelling', direction: 'Sell', quantity: 2000 })]);
        await render();
        await click(inRow('2330', 'position-add'));
        expect(m.openTicket).not.toHaveBeenCalled();
        await click(one('position-switch-confirm'));
        expect(m.selectAccount).toHaveBeenCalledWith(stockAcc2);
        expect(m.openTicket).toHaveBeenCalledWith({ code: '2330', action: 'Sell', source: 'position', lot: 'Common', cond: 'ShortSelling' });
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

    it('融資多單：可加碼，帶入 Buy＋MarginTrading；顯示信用只能整張的說明（含零股時另外說明）', async () => {
        setPositions([stockPos({ cond: 'MarginTrading', quantity: 2500 })]);
        await render();
        expect(inRow('2330', 'position-add').props.disabled).toBe(false);
        expect(textOf(inRow('2330', 'position-add-note'))).toMatch(/融資加碼只能整張.*含零股/);
        expect(pageText()).not.toContain('後續版本');
        await click(inRow('2330', 'position-add'));
        expect(m.openTicket).toHaveBeenCalledWith({ code: '2330', action: 'Buy', source: 'position', lot: 'Common', cond: 'MarginTrading' });
    });

    it('現股空單（當沖先賣）：可當沖時帶入 daytradeShort；不可當沖時停用並說明', async () => {
        setPositions([stockPos({ direction: 'Sell', quantity: 1000 })]);
        await render();
        expect(inRow('2330', 'position-add').props.disabled).toBe(false);
        await click(inRow('2330', 'position-add'));
        expect(m.openTicket).toHaveBeenCalledWith({ code: '2330', action: 'Sell', source: 'position', lot: 'Common', cond: 'Cash', daytradeShort: true });

        m.openTicket.mockReset();
        m.contracts = { ...m.contracts, '2330': { ...stk2330, day_trade: 'No' } };
        await rerender();
        expect(inRow('2330', 'position-add').props.disabled).toBe(true);
        expect(textOf(inRow('2330', 'position-add-note'))).toMatch(/不可當沖先賣/);
        await click(inRow('2330', 'position-add'));
        expect(m.openTicket).not.toHaveBeenCalled();

        m.contracts = { TXFL6: txf };
        await rerender();
        expect(inRow('2330', 'position-add').props.disabled).toBe(true);
        expect(textOf(inRow('2330', 'position-add-note'))).toMatch(/商品資料尚未載入/);
    });

    it('持倉帳戶不可交易（未簽署）：加碼停用並說明', async () => {
        m.accounts = { ...m.accounts, accounts: [{ ...stockAcc, signed: false }, stockAcc2, futAcc] };
        await render();
        expect(inRow('2330', 'position-add').props.disabled).toBe(true);
        expect(textOf(inRow('2330', 'position-add-note'))).toMatch(/不可交易/);
    });
});

describe('摘要卡的今日額度列（fetchTradingLimits 已 mock）', () => {
    const errorSpy = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
    /** console.error 的呼叫（排除 react-test-renderer 的棄用提示） */
    const reported = (spy: ReturnType<typeof errorSpy>) =>
        spy.mock.calls.filter(args => !String(args[0]).includes('react-test-renderer is deprecated'));
    /** 呼叫參數中是否含指定訊息的 Error */
    const mentions = (args: unknown[], message: string) =>
        args.some(a => (a instanceof Error && a.message === message) || (typeof a === 'string' && a.includes(message)));

    it('全部帳戶：顯示目前選取證券帳戶的額度，標籤帶券商名稱；查詢正常完成、未觸發錯誤邊界', async () => {
        const spy = errorSpy();
        try {
            await render();
            const line = one('position-limits-line');
            expect(line.props['data-status']).toBe('ok');
            expect(textOf(line)).toContain('永豐 今日剩餘額度');
            expect(textOf(one('position-limits-value'))).toBe('$800,000');
            expect(m.fetchTradingLimits).toHaveBeenCalledTimes(1);
            expect(m.fetchTradingLimits).toHaveBeenCalledWith({ broker_id: '9A95', account_id: '1234567' });
            expect(reported(spy)).toEqual([]);
        } finally {
            spy.mockRestore();
        }
        expect(m.placeStockExitByShares).not.toHaveBeenCalled();
        expect(m.placeQuickOrder).not.toHaveBeenCalled();
    });

    it('篩選單一證券帳戶：顯示該帳戶的額度（不是目前選取的帳戶）；篩選期貨帳戶只剩期貨列時不顯示', async () => {
        m.fetchTradingLimits.mockImplementation(async (a: { broker_id: string }) =>
            (a.broker_id === 'ESUN1' ? tradingLimits({ trading_limit: 500_000, trading_used: 0, trading_available: 450_000 }) : tradingLimits()));
        setPositions([stockPos(), stockPos({ id: 9, account: stockAcc2 }), futPos()]);
        await render();
        expect(textOf(one('position-limits-value'))).toBe('$800,000');
        await act(async () => { one('position-account-filter').props.onChange({ target: { value: 'S:ESUN1:7777777' } }); });
        expect(m.fetchTradingLimits).toHaveBeenLastCalledWith({ broker_id: 'ESUN1', account_id: '7777777' });
        expect(textOf(one('position-limits-value'))).toBe('$450,000');
        // 切回全部：回到目前選取的證券帳戶（快取，不重查）
        await act(async () => { one('position-account-filter').props.onChange({ target: { value: '' } }); });
        expect(textOf(one('position-limits-value'))).toBe('$800,000');
        expect(m.fetchTradingLimits).toHaveBeenCalledTimes(2);
        // 期貨帳戶：只剩期貨列 → 依現有規則不顯示證券額度
        await act(async () => { one('position-account-filter').props.onChange({ target: { value: 'F:F002000:7654321' } }); });
        expect(all('position-limits-line')).toHaveLength(0);
        expect(m.fetchTradingLimits).toHaveBeenCalledTimes(2);
    });

    it('錯誤邊界：額度查詢同步丟出時只隱藏額度列，持倉列、合計與平倉入口照常', async () => {
        const spy = errorSpy();
        try {
            m.fetchTradingLimits.mockImplementation(() => { throw new Error('boom'); });
            await render();
            expect(m.fetchTradingLimits).toHaveBeenCalledTimes(1);
            expect(all('position-limits-line')).toHaveLength(0);
            expect(textOf(one('position-total'))).toBe('+121,697');
            expect(all('position-row')).toHaveLength(2);
            expect(inRow('2330', 'position-close').props.disabled).toBe(false);
            // React 有回報被邊界攔下的錯誤（不是被吞掉而無聲）
            expect(reported(spy).some(args => mentions(args, 'boom'))).toBe(true);
        } finally {
            spy.mockRestore();
        }
        expect(m.placeStockExitByShares).not.toHaveBeenCalled();
        expect(m.placeQuickOrder).not.toHaveBeenCalled();
    });

    it('查詢非同步失敗不經錯誤邊界：額度列顯示「暫時無法取得」', async () => {
        m.fetchTradingLimits.mockRejectedValue(new Error('timeout'));
        await render();
        expect(one('position-limits-line').props['data-status']).toBe('error');
        expect(textOf(one('position-limits-value'))).toBe('暫時無法取得');
    });
});

describe('淨損益與損益兩平價', () => {
    // 當沖稅率只在台北 13:30 前適用：固定在盤中（只假造 Date，不影響 act 的計時器）
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-11-06T10:00:00+08:00'));
    });
    afterEach(() => { resetTradingCostSettings(); });

    const okQuery = { updatedAt: 1, needsReconcile: false, error: null, reasons: [] };
    /** 委託查詢成功＋今日成交 */
    const withTrades = (positions: AccountedPosition[], trades: unknown[]) =>
        setPositions(positions, {}, { trades, queries: { positions: okQuery, orders: okQuery } });
    const buyTrade = (lots: number) => ({
        contract: { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null },
        order: { id: 't1', seqno: '', ordno: '', action: 'Buy', price: 1080, quantity: lots, order_lot: 'Common', order_cond: 'Cash' },
        status: { id: 't1', status: 'Filled', status_code: '', order_quantity: lots, deal_quantity: lots, cancel_quantity: 0, modified_price: 0, msg: '', deals: [{ seq: '1', price: 1080, quantity: lots, ts: 0 }] },
        account: stockAcc,
    });
    const sheetNode = () => view!.root.find(n => n.props['data-testid'] === 'position-pnl-sheet' && typeof n.type === 'string');

    it('股票列：淨損益為主、券商損益小字並列；兩平價依跳動價位格式化並以文字標示高於／低於', async () => {
        await render();
        // 3,500 股 × 均價 1,052.5：買進手續費 4,499＋750（整張、零股兩筆）；現價 1,085 賣出手續費 4,638＋773、證交稅 11,393
        expect(textOf(inRow('2330', 'position-pnl'))).toBe('+91,697');
        expect(textOf(inRow('2330', 'position-broker-pnl'))).toBe('券商 +97,500');
        expect(textOf(rowOf('2330'))).toContain('淨損益（含手續費、證交稅）');
        // 代數解 1,058.7 → 往上取到 5 元檔 1,060；1,055 為虧損
        expect(textOf(inRow('2330', 'position-breakeven'))).toBe('1,060');
        expect(textOf(inRow('2330', 'position-breakeven-relation'))).toBe('現價高於兩平價・已過兩平');
        const tags = textOf(inRow('2330', 'position-pnl-tags'));
        expect(tags).toContain('手續費以牌告計（無折扣）');
        expect(tags).toContain('未判斷當沖'); // 委託查詢未成功：取不到今日成交
        expect(tags).toContain('估算');
        // 期權：維持券商損益並標示未扣費稅
        expect(textOf(inRow('TXFL6', 'position-pnl'))).toBe('+30,000');
        expect(textOf(inRow('TXFL6', 'position-pnl-note'))).toBe('券商損益・未扣費稅');
        expect(rowOf('TXFL6').findAll(n => n.props['data-testid'] === 'position-pnl-info')).toHaveLength(0);
        expect(textOf(one('position-total-deriv'))).toContain('未扣費稅');
        expect(all('position-total-pending')).toHaveLength(0);
    });

    it('手續費折數與今日成交：2.8 折、今日買進 1 張以當沖稅率 0.15% 計；明細面板列出各項', async () => {
        setTradingCostSettings({ feeDiscount: 0.28 });
        withTrades([stockPos({ yd_quantity: 2500 })], [buyTrade(1)]);
        await render();
        const tags = textOf(inRow('2330', 'position-pnl-tags'));
        expect(tags).toContain('手續費以 2.8 折計');
        expect(tags).toContain('當沖稅率 0.15%');
        expect(tags).not.toContain('未判斷當沖');
        expect(textOf(rowOf('2330'))).toContain('淨損益（含手續費 2.8 折、證交稅）');
        // 2.8 折：買進 1,260＋210；賣出 1,299＋216；稅 1,085,000 × 0.15% ＋ 2,712,500 × 0.3% = 1,628 ＋ 8,138
        expect(textOf(inRow('2330', 'position-pnl'))).toBe('+100,999');
        await click(inRow('2330', 'position-pnl-info'));
        const sheet = textOf(sheetNode());
        expect(sheet).toContain('損益計算明細');
        expect(textOf(one('pnl-open-fee'))).toBe('1,470');
        expect(textOf(one('pnl-close-fee'))).toBe('1,515');
        expect(textOf(one('pnl-tax-rate'))).toBe('當沖 0.15% × 1,000 股＋0.3% × 2,500 股');
        expect(textOf(one('pnl-close-tax'))).toBe('9,766');
        expect(textOf(one('pnl-net'))).toBe('+100,999');
        expect(sheet).toContain('買進手續費（估算）');
        expect(sheet).toContain('證券交易稅條例第 2 條之 1');
    });

    it('收盤後（台北 13:31）今日買進不再以當沖稅率計：標示「今日已收盤」，稅率回到 0.3%', async () => {
        vi.setSystemTime(Date.parse('2026-11-06T13:31:00+08:00'));
        setTradingCostSettings({ feeDiscount: 0.28 });
        withTrades([stockPos({ yd_quantity: 2500 })], [buyTrade(1)]);
        await render();
        const tags = textOf(inRow('2330', 'position-pnl-tags'));
        expect(tags).toContain('今日已收盤・一般稅率');
        expect(tags).not.toContain('當沖稅率 0.15%');
        // 稅 3,797,500 × 0.3% = 11,393（盤中為 9,766）→ 淨損益少 1,627
        expect(textOf(inRow('2330', 'position-pnl'))).toBe('+99,372');
        await click(inRow('2330', 'position-pnl-info'));
        expect(textOf(one('pnl-tax-rate'))).toBe('0.3%');
        expect(textOf(one('pnl-close-tax'))).toBe('11,393');
        expect(textOf(sheetNode())).toContain('最早下一個交易日才能賣出');
    });

    it('融券：借券費與兩平價（回補價 ≤ 兩平才不虧），現價低於兩平以文字標示', async () => {
        setPositions([stockPos({ direction: 'Sell', cond: 'ShortSelling', quantity: 1000, price: 1100, last_price: 1085, pnl: 12_000, yd_quantity: 1000 })]);
        await render();
        // 賣出 1,100,000：手續費 1,568、稅 3,300、借券費 880；回補 1,085,000＋1,546
        expect(textOf(inRow('2330', 'position-pnl'))).toBe('+7,706');
        expect(textOf(inRow('2330', 'position-breakeven'))).toBe('1,090');
        expect(textOf(inRow('2330', 'position-breakeven-relation'))).toBe('現價低於兩平價・已過兩平');
        await click(inRow('2330', 'position-pnl-info'));
        expect(textOf(one('pnl-borrow-fee'))).toBe('880');
        expect(textOf(one('pnl-basis'))).toBe('1,095,132');
    });

    it('合計待確認：有列算不出淨損益（商品資料未載入）時只加總可計算的列並標示，列內說明原因', async () => {
        setPositions([stockPos(), stockPos({ id: 8, code: '9999', pnl: 5_000 })]);
        await render();
        expect(textOf(one('position-total'))).toBe('+91,697');
        expect(textOf(one('position-total-pending'))).toBe('合計待確認：1 筆無法計算淨損益，未計入');
        expect(textOf(inRow('9999', 'position-pnl'))).toBe('—');
        expect(textOf(inRow('9999', 'position-broker-pnl'))).toBe('券商 +5,000');
        expect(textOf(inRow('9999', 'position-pnl-reason'))).toBe(POSITIONS_TEXT.pnlNoContract);
        expect(all('position-total-pct')).toHaveLength(0);
        expect(textOf(one('position-group-pnl'))).toContain('（待確認）');
    });

    it('遮蔽金額：淨損益、券商損益、明細金額與股數都遮蔽（兩平價為價格，同均價不遮蔽）', async () => {
        m.privMoney = true;
        setTradingCostSettings({ feeDiscount: 0.28 });
        withTrades([stockPos()], [buyTrade(1)]);
        await render();
        expect(textOf(inRow('2330', 'position-pnl'))).toBe('•••••');
        expect(textOf(inRow('2330', 'position-broker-pnl'))).toBe('券商 •••••');
        expect(textOf(inRow('2330', 'position-breakeven'))).not.toBe('—');
        await click(inRow('2330', 'position-pnl-info'));
        for (const id of ['pnl-open-fee', 'pnl-close-fee', 'pnl-close-tax', 'pnl-net', 'pnl-basis']) expect(textOf(one(id))).toBe('•••••');
        expect(textOf(one('pnl-tax-rate'))).toBe('當沖 0.15% × •••••＋0.3% × •••••');
        expect(textOf(sheetNode())).not.toContain('3張');
    });

    it('S1：開啟／關閉計算明細不呼叫任何送單函式、不開下單面板；面板內沒有平倉／加碼鍵；平倉流程不變', async () => {
        await render();
        await click(inRow('2330', 'position-pnl-info'));
        expect(all('position-pnl-sheet')).toHaveLength(1);
        const buttons = sheetNode().findAll(n => n.type === 'button').map(n => String(n.props['data-testid'] ?? ''));
        expect(buttons.filter(id => /close|add|continue|confirm/.test(id))).toEqual([]);
        await act(async () => { view!.root.find(n => n.props.testId === 'position-pnl-sheet').props.onClose(); });
        expect(all('position-pnl-sheet')).toHaveLength(0);
        expect(m.placeStockExitByShares).not.toHaveBeenCalled();
        expect(m.placeQuickOrder).not.toHaveBeenCalled();
        expect(m.openTicket).not.toHaveBeenCalled();
        // 平倉鍵仍只開說明面板
        await click(inRow('2330', 'position-close'));
        expect(all('position-close-sheet')).toHaveLength(1);
        expect(m.placeStockExitByShares).not.toHaveBeenCalled();
    });
});

describe('「詳細｜精簡」檢視', () => {
    /** 以 Map 模擬 localStorage（測試環境沒有） */
    function fakeStorage(initial: Record<string, string> = {}) {
        const map = new Map(Object.entries(initial));
        return {
            map,
            getItem: vi.fn((k: string) => (map.has(k) ? map.get(k)! : null)),
            setItem: vi.fn((k: string, v: string) => { map.set(k, String(v)); }),
            removeItem: (k: string) => { map.delete(k); },
        };
    }
    /** 同代碼有多列（例如現股＋融資）時取第一列 */
    const compactRowOf = (code: string) => {
        const rows = view!.root.findAll(n => n.props['data-testid'] === 'position-compact-row' && n.props['data-code'] === code && typeof n.type === 'string');
        expect(rows.length).toBeGreaterThan(0);
        return rows[0]!;
    };
    const inCompact = (code: string, id: string) => compactRowOf(code).find(n => n.props['data-testid'] === id && typeof n.type === 'string');
    const compactCodes = () => all('position-compact-row').map(n => n.props['data-code'] as string);
    const sendFns = () => [m.placeStockExitByShares, m.placeQuickOrder];
    async function pickView(v: 'detail' | 'compact') {
        await click(one(`position-view-${v}`));
    }

    it('預設為詳細：沒有儲存值時顯示既有詳細卡片，切換鍵以 aria-pressed 標示目前檢視', async () => {
        await render();
        const group = one('position-view');
        expect(group.props.role).toBe('group');
        expect(group.props['aria-label']).toBe('持倉顯示方式');
        expect(one('position-view-detail').props['aria-pressed']).toBe(true);
        expect(one('position-view-compact').props['aria-pressed']).toBe(false);
        expect(textOf(one('position-view-detail'))).toBe('詳細');
        expect(textOf(one('position-view-compact'))).toBe('精簡');
        expect(all('position-row')).toHaveLength(2);
        expect(all('position-compact-row')).toHaveLength(0);
        expect(readPositionsView()).toBe('detail');
    });

    it('切換並存 localStorage（sj-mobile-positions-view）；重新開啟頁面沿用；切回詳細也記住', async () => {
        const storage = fakeStorage();
        vi.stubGlobal('localStorage', storage);
        await render();
        await pickView('compact');
        expect(one('position-view-compact').props['aria-pressed']).toBe(true);
        expect(compactCodes()).toEqual(['2330', 'TXFL6']);
        expect(all('position-row')).toHaveLength(0);
        expect(storage.map.get(POSITIONS_VIEW_KEY)).toBe('compact');
        // 帳戶分組、摘要卡照常
        expect(all('position-group')).toHaveLength(2);
        expect(textOf(one('position-total'))).toBe('+121,697');

        await act(async () => view!.unmount());
        await render();
        expect(compactCodes()).toEqual(['2330', 'TXFL6']);
        await pickView('detail');
        expect(storage.map.get(POSITIONS_VIEW_KEY)).toBe('detail');
        expect(all('position-row')).toHaveLength(2);
        // 點目前已選的段不重寫
        storage.setItem.mockClear();
        await pickView('detail');
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('localStorage 壞值、讀取丟例外：一律回到詳細；寫入丟例外：本次仍可切換', async () => {
        vi.stubGlobal('localStorage', fakeStorage({ [POSITIONS_VIEW_KEY]: 'COMPACT ' }));
        await render();
        expect(all('position-row')).toHaveLength(2);
        expect(one('position-view-detail').props['aria-pressed']).toBe(true);
        await act(async () => view!.unmount());

        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } });
        expect(readPositionsView()).toBe('detail');
        await render();
        expect(all('position-row')).toHaveLength(2);
        await pickView('compact');
        expect(compactCodes()).toEqual(['2330', 'TXFL6']);
        expect(one('position-view-compact').props['aria-pressed']).toBe(true);
    });

    it('精簡列內容：股票（現股／融資／融券）、期貨、玉山與永豐；淨損益、報酬率與兩平狀態文字', async () => {
        m.contracts = { ...m.contracts, '2317': { ...stk2330, code: '2317', name: '鴻海' } };
        setPositions([
            stockPos(),
            stockPos({ id: 4, cond: 'MarginTrading', quantity: 2000, yd_quantity: 2000 }),
            stockPos({ id: 5, code: '2317', account: stockAcc2, direction: 'Sell', cond: 'ShortSelling', quantity: 1000, price: 1100, last_price: 1085, pnl: 12_000, yd_quantity: 1000 }),
            futPos({ direction: 'Sell', quantity: 1, last_price: 22572, pnl: -45_600 }),
            stockPos({ id: 8, code: '9999', pnl: 5_000 }),
        ]);
        vi.stubGlobal('localStorage', fakeStorage({ [POSITIONS_VIEW_KEY]: 'compact' }));
        await render();
        const headers = all('position-group-header').map(textOf);
        expect(headers.some(h => h.includes('永豐證券 ***4567'))).toBe(true);
        expect(headers.some(h => h.includes('玉山證券 ***7777'))).toBe(true);
        expect(headers.some(h => h.includes('永豐期貨 ***4321'))).toBe(true);

        // 永豐現股多單：名稱／代碼・現股・多 3張+500股｜淨損益（與詳細卡片同值）／報酬率・已過兩平
        const cash = textOf(compactRowOf('2330'));
        expect(cash).toContain('台積電');
        expect(cash).toContain('2330');
        expect(cash).toContain('現股');
        expect(cash).toContain('淨損益（含手續費、證交稅）');
        expect(textOf(inCompact('2330', 'position-compact-qty'))).toBe('多 3張+500股');
        expect(textOf(inCompact('2330', 'position-compact-pnl'))).toBe('+91,697');
        expect(textOf(inCompact('2330', 'position-compact-return'))).toBe('+2.49%');
        expect(textOf(inCompact('2330', 'position-compact-status'))).toBe(COMPACT_TEXT.aboveBreakEven);

        // 融資：條件膠囊
        const marginRow = all('position-compact-row').filter(n => n.props['data-code'] === '2330')[1]!;
        expect(textOf(marginRow)).toContain('融資');
        expect(textOf(marginRow)).toContain('多 2張');

        // 玉山融券空單：現價低於兩平價＝已過兩平（文字，不只靠顏色）
        expect(textOf(compactRowOf('2317'))).toContain('融券');
        expect(textOf(inCompact('2317', 'position-compact-qty'))).toBe('空 1張');
        expect(textOf(inCompact('2317', 'position-compact-status'))).toBe('已過兩平');

        // 期貨空單：券商損益＋未扣費稅
        expect(textOf(compactRowOf('TXFL6'))).toContain('期貨');
        expect(textOf(compactRowOf('TXFL6'))).toContain('損益（券商，未扣費稅）');
        expect(textOf(inCompact('TXFL6', 'position-compact-qty'))).toBe('空 1 口');
        expect(textOf(inCompact('TXFL6', 'position-compact-pnl'))).toBe('-45,600');
        expect(textOf(inCompact('TXFL6', 'position-compact-return'))).toBe('+1.00%');
        expect(textOf(inCompact('TXFL6', 'position-compact-status'))).toBe(COMPACT_TEXT.derivNote);

        // 商品資料未載入：名稱以代碼代替、淨損益不猜（—）、待確認、改顯示現價
        expect(textOf(inCompact('9999', 'position-compact-pnl'))).toBe('—');
        expect(textOf(inCompact('9999', 'position-compact-status'))).toBe(COMPACT_TEXT.pending);
        expect(textOf(inCompact('9999', 'position-compact-price'))).toBe('現價 1,085');
        expect(compactRowOf('9999').findAll(n => n.props['data-testid'] === 'position-compact-return')).toHaveLength(0);
        expect(textOf(one('position-total-pending'))).toContain('合計待確認：1 筆');
    });

    it('遮蔽金額：精簡列的淨損益與數量都遮蔽（報酬率不含金額照常）', async () => {
        m.privMoney = true;
        vi.stubGlobal('localStorage', fakeStorage({ [POSITIONS_VIEW_KEY]: 'compact' }));
        await render();
        expect(textOf(inCompact('2330', 'position-compact-pnl'))).toBe('•••••');
        expect(textOf(inCompact('2330', 'position-compact-qty'))).toBe('多 •••••');
        expect(textOf(inCompact('TXFL6', 'position-compact-pnl'))).toBe('•••••');
        expect(textOf(inCompact('TXFL6', 'position-compact-qty'))).toBe('多 •••••');
        expect(textOf(inCompact('2330', 'position-compact-return'))).toBe('+2.49%');
        expect(textOf(one('position-total'))).toBe('•••••');
        const text = pageText();
        for (const s of ['97,500', '91,697', '30,000', '3張', '2 口']) expect(text).not.toContain(s);
    });

    it('未展開不掛詳細卡片子樹；點列展開（aria-expanded／aria-controls）出現既有平倉、加碼、看圖鍵，再點收合', async () => {
        setPositions([stockPos(), stockPos({ id: 7, code: '2317', account: stockAcc2 }), futPos()]);
        vi.stubGlobal('localStorage', fakeStorage({ [POSITIONS_VIEW_KEY]: 'compact' }));
        await render();
        for (const id of ['position-row', 'position-close', 'position-add', 'position-chart', 'position-pnl-info', 'position-pnl-bar']) expect(all(id)).toHaveLength(0);
        // 收合時列內只有一顆鍵（展開鍵），不新增任何送單入口
        expect(compactRowOf('2330').findAll(n => n.type === 'button')).toHaveLength(1);

        const toggle = inCompact('2330', 'position-compact-toggle');
        expect(toggle.props['aria-expanded']).toBe(false);
        expect(toggle.props['aria-controls']).toBeUndefined();
        await click(toggle);
        const opened = inCompact('2330', 'position-compact-toggle');
        expect(opened.props['aria-expanded']).toBe(true);
        expect(all('position-row')).toHaveLength(1);
        expect(inCompact('2330', 'position-row').props.id).toBe(opened.props['aria-controls']);
        // 既有詳細卡片內容（不重複第一行的損益）
        expect(all('position-close')).toHaveLength(1);
        expect(all('position-add')).toHaveLength(1);
        expect(all('position-chart')).toHaveLength(1);
        expect(textOf(inRow('2330', 'position-broker-pnl'))).toBe('券商 +97,500');
        expect(textOf(inRow('2330', 'position-cost'))).toBe('3,683,750');
        expect(textOf(inRow('2330', 'position-breakeven'))).toBe('1,060');
        expect(rowOf('2330').findAll(n => n.props['data-testid'] === 'position-pnl')).toHaveLength(0);
        // 其他列仍未展開
        expect(inCompact('TXFL6', 'position-compact-toggle').props['aria-expanded']).toBe(false);

        // 玉山列展開後仍可開庫存明細
        await click(inCompact('2317', 'position-compact-toggle'));
        await click(inRow('2317', 'position-detail-toggle'));
        expect(textOf(one('stub-esun-detail'))).toBe('明細 2317');

        await click(inCompact('2330', 'position-compact-toggle'));
        expect(inCompact('2330', 'position-compact-toggle').props['aria-expanded']).toBe(false);
        expect(compactRowOf('2330').findAll(n => n.props['data-testid'] === 'position-row')).toHaveLength(0);
        expect(all('position-row')).toHaveLength(1); // 2317 仍展開
    });

    it('展開後的平倉與加碼走既有流程：加碼只呼叫 openTicket、平倉只開說明面板，按「繼續」才呼叫 lib', async () => {
        vi.stubGlobal('localStorage', fakeStorage({ [POSITIONS_VIEW_KEY]: 'compact' }));
        await render();
        await click(inCompact('TXFL6', 'position-compact-toggle'));
        await click(inRow('TXFL6', 'position-add'));
        expect(m.openTicket).toHaveBeenCalledWith({ code: 'TXFL6', action: 'Buy', source: 'position' });
        await click(inRow('TXFL6', 'position-close'));
        expect(all('position-close-sheet')).toHaveLength(1);
        for (const f of sendFns()) expect(f).not.toHaveBeenCalled();
        await click(one('position-close-continue'));
        expect(m.placeQuickOrder).toHaveBeenCalledTimes(1);
        expect(firstCall(m.placeQuickOrder)[0]).toBe(txf);
        expect(firstCall(m.placeQuickOrder)[1]).toBe('Sell');
        expect(firstCall(m.placeQuickOrder)[3]).toBe(2);
        expect(firstCall(m.placeQuickOrder)[4]).toMatchObject({ account: futAcc, ocType: 'Cover', source: 'manual' });
    });

    it('S1：切換檢視、展開／收合、展開後開平倉說明面板，lib 送單／改單／刪單 0 次、不開下單面板', async () => {
        vi.stubGlobal('localStorage', fakeStorage());
        await render();
        await pickView('compact');
        await click(inCompact('2330', 'position-compact-toggle'));
        await click(inCompact('TXFL6', 'position-compact-toggle'));
        await click(inCompact('TXFL6', 'position-compact-toggle'));
        await click(inRow('2330', 'position-close'));
        expect(all('position-close-sheet')).toHaveLength(1);
        await act(async () => { view!.root.find(n => n.props.testId === 'position-close-sheet').props.onClose(); });
        await pickView('detail');
        await pickView('compact');
        for (const f of sendFns()) expect(f).not.toHaveBeenCalled();
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.notify).not.toHaveBeenCalled();
        expect(m.reconcileAfterUnknownOutcome).not.toHaveBeenCalled();
    });
});

describe('列的重繪範圍（稽核 P2）', () => {
    const renders = (code: string) => m.contractCalls.get(code) ?? 0;

    it('期貨跳價（只換該列持倉物件）：股票列不重繪、期貨列重繪且數值正確；最大損益改變時全部列重繪（損益條比例）', async () => {
        const stock = stockPos();
        setPositions([stock, futPos()]);
        await render();
        const s0 = renders('2330');
        const f0 = renders('TXFL6');
        expect(s0).toBeGreaterThan(0);

        setPositions([stock, futPos({ last_price: 22955, pnl: 31_000 })]);
        await rerender();
        expect(renders('2330')).toBe(s0);
        expect(renders('TXFL6')).toBeGreaterThan(f0);
        expect(textOf(inRow('TXFL6', 'position-pnl'))).toBe('+31,000');
        expect(textOf(inRow('2330', 'position-pnl'))).toBe('+91,697');
        expect(textOf(one('position-total'))).toBe('+122,697');

        // 期貨損益超過股票：本頁最大 |損益| 改變 → 股票列的損益條比例要跟著變，因此重繪
        const s1 = renders('2330');
        setPositions([stock, futPos({ last_price: 25000, pnl: 440_000 })]);
        await rerender();
        expect(renders('2330')).toBeGreaterThan(s1);
        expect(textOf(inRow('TXFL6', 'position-pnl'))).toBe('+440,000');
    });

    it('同一批持倉物件重繪頁面（例如其他狀態更新）：所有列都不重繪', async () => {
        const rows = [stockPos(), futPos()];
        setPositions(rows);
        await render();
        const s0 = renders('2330');
        const f0 = renders('TXFL6');
        setPositions(rows);
        await rerender();
        await rerender();
        expect(renders('2330')).toBe(s0);
        expect(renders('TXFL6')).toBe(f0);
    });

    it('遮蔽金額、平倉停用等列用到的值改變時重繪', async () => {
        const rows = [stockPos(), futPos()];
        setPositions(rows);
        await render();
        const s0 = renders('2330');
        m.privMoney = true;
        await rerender();
        expect(renders('2330')).toBeGreaterThan(s0);
        expect(textOf(inRow('2330', 'position-pnl'))).toBe('•••••');
        const s1 = renders('2330');
        m.live = false;
        await rerender();
        expect(renders('2330')).toBeGreaterThan(s1);
        expect(inRow('2330', 'position-close').props.disabled).toBe(true);
    });

    it('略過重繪的列，按鈕仍用最新狀態：切換選取帳戶後按加碼走帳戶切換確認，不直接開下單面板', async () => {
        const stock = stockPos();
        setPositions([stock, futPos()]);
        await render();
        const s0 = renders('2330');
        // 選取的證券帳戶改成另一個（列的 props 不變 → 不重繪）
        m.accounts = { ...m.accounts, selectedStock: stockAcc2 };
        setPositions([stock, futPos({ last_price: 22960 })]);
        await rerender();
        expect(renders('2330')).toBe(s0);
        await click(inRow('2330', 'position-add'));
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(all('position-switch-sheet')).toHaveLength(1);
    });

    it('精簡檢視：收合的列只在自己的持倉或淨損益改變時重繪；展開的列另比詳細卡片的值', async () => {
        vi.stubGlobal('localStorage', { getItem: () => 'compact', setItem: () => undefined });
        const stock = stockPos();
        setPositions([stock, futPos()]);
        await render();
        expect(all('position-compact-row')).toHaveLength(2);
        const s0 = renders('2330');
        setPositions([stock, futPos({ last_price: 22955, pnl: 31_000 })]);
        await rerender();
        expect(renders('2330')).toBe(s0);
        const futRow = view!.root.find(n => n.props['data-testid'] === 'position-compact-row' && n.props['data-code'] === 'TXFL6' && typeof n.type === 'string');
        expect(textOf(futRow.find(n => n.props['data-testid'] === 'position-compact-pnl'))).toBe('+31,000');
    });
});

describe('精簡列的無障礙名稱', () => {
    it('按鈕內含淨損益與報酬率（估）的報讀標籤；視覺數字不變', async () => {
        vi.stubGlobal('localStorage', { getItem: () => 'compact', setItem: () => undefined });
        await render();
        const toggle = view!.root.find(n => n.props['data-testid'] === 'position-compact-toggle' && n.parent?.props['data-code'] === '2330' && typeof n.type === 'string');
        const name = textOf(toggle);
        expect(name).toContain('淨損益（含手續費、證交稅）');
        expect(name).toContain(`${COMPACT_TEXT.returnSrLabel}+2.49%`);
        expect(COMPACT_TEXT.returnSrLabel).toBe('報酬率（估）');
        expect(textOf(toggle.find(n => n.props['data-testid'] === 'position-compact-return'))).toBe('+2.49%');
    });

    it('展開的精簡列：詳細卡片跟著列用到的值更新（平倉停用）', async () => {
        vi.stubGlobal('localStorage', { getItem: () => 'compact', setItem: () => undefined });
        const rows = [stockPos(), futPos()];
        setPositions(rows);
        await render();
        await click(view!.root.find(n => n.props['data-testid'] === 'position-compact-toggle' && n.parent?.props['data-code'] === '2330' && typeof n.type === 'string'));
        expect(inRow('2330', 'position-close').props.disabled).toBe(false);
        m.live = false;
        setPositions(rows);
        await rerender();
        expect(inRow('2330', 'position-close').props.disabled).toBe(true);
    });
});