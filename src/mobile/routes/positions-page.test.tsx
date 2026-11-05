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

import { addOnBlockReason, addOnPlanFor, closePlanFor, POSITIONS_TEXT, PositionsPage, REFRESH_COOLDOWN_MS, reconcileText, yesterdayText } from './positions-page';

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
        expect(textOf(one('position-total'))).toBe('+127,500');
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
        expect(textOf(one('position-total-pct'))).toBe('（+2.65%）'); // 97,500 ÷ (1,052.5 × 3,500)
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
        expect(headers[0]).toContain('損益 +87,500');
        expect(headers[1]).toContain('玉山證券 ***7777');
        expect(headers[1]).toContain('1 筆');
        expect(headers[1]).toContain('市值 220,000');
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
        expect(textOf(inRow('2330', 'position-return'))).toBe('+2.65%');
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
