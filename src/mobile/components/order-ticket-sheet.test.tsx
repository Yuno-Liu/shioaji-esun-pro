// 手機下單面板（規格 §6.3、§7.2、§14.1）：零股強制限價＋ROD＋現股、單位切換數量歸 1、升降單位／漲跌停／
// 環境未確認／連線閘門停用預覽、開啟後不自動跟價，以及四種結果分類（結果未知不提供重送）。
// Phase 2：依買賣著色與方向文字、信用條件與現沖先賣規則、盤後零股、帶入 lot／cond／daytradeShort、
// 剩餘交易額度、交易成本列、內嵌五檔帶價。
// 以 vi.mock 隔離 src/lib，不打任何真實 API；submitMobileOrder 也以 mock 取代。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { Account } from '../../lib/types/portfolio';

const h = vi.hoisted(() => {
    const stockAccount = { account_type: 'S', broker_id: '9A95', account_id: '0123456', signed: true, person_id: '', username: '' };
    const futuresAccount = { account_type: 'F', broker_id: 'F002000', account_id: '7654321', signed: true, person_id: '', username: '' };
    return {
        stockAccount,
        futuresAccount,
        captured: { S: stockAccount as unknown, F: futuresAccount as unknown } as Record<'S' | 'F', unknown>,
        selected: { S: stockAccount as unknown, F: futuresAccount as unknown } as Record<'S' | 'F', unknown>,
        contract: null as unknown,
        quote: undefined as unknown,
        oddQuote: undefined as unknown,
        snapshot: undefined as unknown,
        live: true,
        route: { esun: false, broker: '永豐', simulation: true } as { esun: boolean; broker: string; simulation: boolean | undefined } | null,
        privMoney: false,
        esunBrokers: new Set<string>(),
        positions: [] as unknown[],
        positionsLoaded: true,
        limits: { data: null, error: null, loading: false, updatedAt: null } as { data: unknown; error: string | null; loading: boolean; updatedAt: number | null },
        limitsAccount: undefined as unknown,
        ladder: null as Record<string, unknown> | null,
    };
});
const m = vi.hoisted(() => ({
    submit: vi.fn(),
    notify: vi.fn(),
    reconcile: vi.fn(),
    risk: vi.fn((): string | null => null),
    esunLeg: vi.fn((): string | null => null),
}));

vi.mock('../../lib/contracts-cache', () => ({
    useContract: (code: string | null) => (code && (h.contract as { code: string } | null)?.code === code ? h.contract : undefined),
    ensureContract: () => Promise.resolve(h.contract),
}));
vi.mock('../../hooks/use-stream', () => ({
    useQuote: (code: string | null, opts?: { oddLot?: boolean }) => (code ? (opts?.oddLot ? h.oddQuote : h.quote) : undefined),
    useTradingLive: () => h.live,
}));
// 市場快照（沒有真實成交時的價格來源）：測試直接決定快照內容，不讀取任何 API
vi.mock('../../hooks/use-display-book', () => ({
    useSnapshotBaseline: (_code: string, _supplied: unknown, contract: unknown) => ({ snapshot: h.snapshot, contract }),
}));
vi.mock('../../lib/account-store', () => ({
    useAccounts: () => ({ accounts: [], selectedStock: h.selected.S, selectedFutures: h.selected.F, loaded: true, loadError: false }),
}));
vi.mock('../../lib/order-account', () => ({ captureSelectedAccount: (type: 'S' | 'F') => h.captured[type] ?? undefined }));
vi.mock('../../lib/account-tradable', () => ({ canTrade: (a: Account | null | undefined) => !!a && a.signed }));
vi.mock('../../lib/esun', () => ({ isEsunAccount: (a?: { broker_id: string } | null) => !!a && h.esunBrokers.has(a.broker_id) }));
vi.mock('../../lib/order-route', () => ({ esunStockLegProblem: m.esunLeg }));
vi.mock('../../lib/risk', () => ({ checkOrderAllowed: m.risk, useRiskSettings: () => ({}) }));
vi.mock('../../lib/trade', () => {
    class OrderConfirmCancelled extends Error {
        readonly mutationNotStarted = true as const;
        constructor() { super('已取消下單'); }
    }
    return { notify: m.notify, OrderConfirmCancelled };
});
vi.mock('../../lib/order-outcome', () => ({ reconcileAfterUnknownOutcome: m.reconcile }));
vi.mock('../../lib/privacy', () => ({
    usePrivacyMode: () => false,
    usePrivacyMoney: () => h.privMoney,
    maskMoney: (text: string, priv: boolean) => (priv ? '•••••' : text),
}));
vi.mock('../../lib/tick-bands', () => ({ bandTickFor: () => undefined, prefetchTickBands: () => undefined }));
vi.mock('../lib/mobile-order', () => ({ submitMobileOrder: m.submit }));
vi.mock('./route-badge', () => ({
    useOrderRoute: (account: unknown) => (account ? h.route : null),
    RouteBadge: () => createElement('span', { 'data-testid': 'mobile-route-badge' }, '送往'),
}));
vi.mock('./account-switch-sheet', () => ({ mobileAccountLabel: (a: Account) => `${a.broker_id}-${a.account_id}` }));
// 持倉與委託（信用提醒、五檔的「我的委託」標示）：測試直接決定內容
vi.mock('../../lib/trading-state', () => ({
    useTradingState: () => ({ trades: [], positions: h.positions, queries: { positions: { updatedAt: h.positionsLoaded ? 1 : null } } }),
}));
// 交易額度：只替換讀取的 hook，availableLimitFor／limitsLookEmpty 用真的
vi.mock('../../lib/shioaji', () => ({ fetchTradingLimits: vi.fn() }));
vi.mock('../hooks/use-trading-limits', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../hooks/use-trading-limits')>()),
    useTradingLimits: (account: unknown) => {
        h.limitsAccount = account;
        return { ...h.limits, refresh: () => undefined };
    },
}));
// 五檔：記下面板傳入的 props（variant／oddLot／onPick），內容由交易頁負責者的測試涵蓋
vi.mock('./depth-ladder', () => ({
    DepthLadder: (props: Record<string, unknown>) => {
        h.ladder = props;
        return createElement('div', { 'data-testid': 'depth-ladder-stub' });
    },
}));

import { OrderConfirmCancelled } from '../../lib/trade';
import { OUTCOME_UNKNOWN_TITLE, TICKET_TEXT } from '../hooks/use-mobile-ticket';
import { notStarted } from '../lib/errors';
import { closeTicket, getMobileUi, openTicket, resetMobileUiForTest } from '../lib/mobile-store';
import { getResumeGate, setResumeGateForTest } from '../lib/resume-gate-runtime';
import { OrderTicketSheet } from './order-ticket-sheet';

const stock = {
    code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null,
    reference: 100, limit_up: 110, limit_down: 90, day_trade: 'Yes',
} as unknown as ContractInfo;
const futures = {
    code: 'TXFL6', name: '台指期', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFL6',
    reference: 22800, limit_up: 25080, limit_down: 20520, day_trade: '', multiplier: 200, tick: 1,
} as unknown as ContractInfo;

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const root = () => view!.root;
const buttons = () => root().findAllByType('button');
const btn = (label: string) => {
    const found = buttons().find(b => text(b).trim() === label);
    if (!found) throw new Error(`button ${label} not found`);
    return found;
};
const byTestId = (id: string) => root().findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => byTestId(id)[0]!;
const preview = () => one('ticket-preview');
const priceInput = () => one('ticket-price');
const qtyInput = () => one('ticket-qty');
const problemText = () => (byTestId('ticket-problem')[0] ? text(byTestId('ticket-problem')[0]!) : null);

async function render() {
    await act(async () => { view = create(createElement(OrderTicketSheet)); });
}
async function rerender() {
    await act(async () => { view!.update(createElement(OrderTicketSheet)); });
}
async function open(req: Parameters<typeof openTicket>[0]) {
    await act(async () => { openTicket(req); });
    if (!view) await render();
}
async function click(label: string) {
    await act(async () => { btn(label).props.onClick(); });
}
async function typePrice(value: string) {
    await act(async () => { priceInput().props.onChange({ target: { value } }); });
}
async function typeQty(value: string) {
    await act(async () => { qtyInput().props.onChange({ target: { value } }); });
}
async function pressPreview() {
    await act(async () => { await preview().props.onClick(); });
}
const priceType = () => one('ticket-price-type');
async function choosePriceType(value: string) {
    await act(async () => { priceType().props.onChange({ target: { value } }); });
}
const priceOption = (value: string) => priceType().findAll(n => n.type === 'option' && n.props.value === value)[0]!;
/** 展開條件摘要列（信用、時段、效期） */
async function expand() {
    if (byTestId('ticket-cond-panel').length === 0) await act(async () => { one('ticket-cond-summary').props.onClick(); });
}
const panel = () => root().findAll(n => n.props['data-testid'] === 'order-ticket-sheet' && typeof n.type === 'string')[0]!;
const stockLimits = (over: Record<string, number> = {}) => ({
    trading_limit: 500_000, trading_used: 200_000, trading_available: 300_000,
    margin_limit: 400_000, margin_used: 0, margin_available: 400_000,
    short_limit: 100_000, short_used: 0, short_available: 100_000, ...over,
});

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    m.risk.mockReturnValue(null);
    m.esunLeg.mockReturnValue(null);
    h.contract = stock;
    h.quote = { tick: { close: '100' }, bidask: { bid_price: ['99.5'], ask_price: ['100.5'] } };
    h.oddQuote = { tick: { close: '100.5' }, bidask: { bid_price: ['100'], ask_price: ['101'] } };
    h.snapshot = undefined;
    h.live = true;
    h.route = { esun: false, broker: '永豐', simulation: true };
    h.privMoney = false;
    h.esunBrokers.clear();
    h.captured = { S: h.stockAccount, F: h.futuresAccount };
    h.selected = { S: h.stockAccount, F: h.futuresAccount };
    h.positions = [];
    h.positionsLoaded = true;
    h.limits = { data: null, error: null, loading: false, updatedAt: null };
    h.limitsAccount = undefined;
    h.ladder = null;
    resetMobileUiForTest();
    setResumeGateForTest(null);
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('OrderTicketSheet — 欄位規則', () => {
    it('seeds the opening price once and shows the RouteBadge and fixed account', async () => {
        await open({ code: '2330', action: 'Buy' });
        expect(priceInput().props.value).toBe('100');
        expect(byTestId('mobile-route-badge')).toHaveLength(1);
        expect(text(one('ticket-account'))).toContain('永豐 9A95-0123456（證券）');
        expect(preview().props.disabled).toBe(false);
        expect(text(one('ticket-estimate'))).toContain('100,000');
        expect(text(one('ticket-estimate'))).toContain('不含手續費、稅');
    });

    it('does not follow the live price after opening (live price shown beside it)', async () => {
        await open({ code: '2330', action: 'Buy' });
        h.quote = { tick: { close: '101' }, bidask: { bid_price: ['100.5'], ask_price: ['101'] } };
        await rerender();
        expect(priceInput().props.value).toBe('100');
        expect(text(one('ticket-live-price'))).toContain('101');
        // 帶入價格（例如五檔）優先於成交價，同樣不跟價
        await act(async () => { closeTicket(); });
        await open({ code: '2330', action: 'Sell', price: 99.5, source: 'depth' });
        expect(priceInput().props.value).toBe('99.5');
        h.quote = { tick: { close: '102' } };
        await rerender();
        expect(priceInput().props.value).toBe('99.5');
    });

    it('fills the price once when the first quote arrives after opening, then stops following', async () => {
        h.quote = undefined;
        h.contract = { ...stock, reference: 0 };
        await open({ code: '2330', action: 'Buy' });
        expect(priceInput().props.value).toBe('');
        expect(problemText()).toContain(TICKET_TEXT.priceRequired);
        h.quote = { tick: { close: '100' } };
        await rerender();
        expect(priceInput().props.value).toBe('100');
        h.quote = { tick: { close: '103' } };
        await rerender();
        expect(priceInput().props.value).toBe('100');
    });

    it('odd lot forces limit + ROD + cash and sends IntradayOdd shares without order_cond', async () => {
        m.submit.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '77' } });
        await open({ code: '2330', action: 'Buy' });
        await choosePriceType('MKT');
        await expand();
        expect(priceType().props.value).toBe('MKT');
        expect(btn('IOC').props['aria-pressed']).toBe(true);
        await click('零股');
        expect(priceType().props.value).toBe('LMT');
        expect(btn('ROD').props['aria-pressed']).toBe(true);
        expect(priceOption('MKT').props.disabled).toBe(true);
        expect(btn('IOC').props.disabled).toBe(true);
        expect(btn('FOK').props.disabled).toBe(true);
        // 零股只能現股：融資、融券停用
        expect(btn('現股').props['aria-pressed']).toBe(true);
        expect(btn('融資').props.disabled).toBe(true);
        expect(btn('融券（回補）').props.disabled).toBe(true);
        expect(text(one('ticket-odd-note'))).toContain('限價 ROD');
        expect(qtyInput().props['aria-label']).toBe('數量（股）');
        // 價別／效期的設定函式也不接受零股不允許的值
        await act(async () => { priceType().props.onChange({ target: { value: 'MKT' } }); btn('IOC').props.onClick(); });
        expect(priceType().props.value).toBe('LMT');
        expect(btn('ROD').props['aria-pressed']).toBe(true);
        // 盤中零股看盤中零股五檔
        expect(h.ladder).toMatchObject({ variant: 'ticket', oddLot: true, code: '2330' });
        await typeQty('300');
        await pressPreview();
        expect(m.submit).toHaveBeenCalledTimes(1);
        const input = m.submit.mock.calls[0]![0];
        expect(input.isFutures).toBe(false);
        expect(input.orderLot).toBe('IntradayOdd');
        expect(input.stockOrder).toEqual({ action: 'Buy', price: 100, quantity: 300, price_type: 'LMT', order_type: 'ROD', order_lot: 'IntradayOdd' });
        expect('order_cond' in input.stockOrder).toBe(false);
        expect('daytrade_short' in input.stockOrder).toBe(false);
    });

    it('resets the quantity to 1 whenever the unit changes', async () => {
        await open({ code: '2330', action: 'Buy' });
        await typeQty('5');
        expect(qtyInput().props.value).toBe('5');
        await click('零股');
        expect(qtyInput().props.value).toBe('1');
        await typeQty('300');
        await click('整股');
        expect(qtyInput().props.value).toBe('1');
        expect(qtyInput().props['aria-label']).toBe('數量（張）');
    });

    it('summary row shows 現股 / 盤中 / ROD and expands to three segment groups; 整股盤後 is disabled with reason', async () => {
        await open({ code: '2330', action: 'Buy' });
        expect(text(one('ticket-cond-summary'))).toContain('現股 / 盤中 / ROD');
        expect(byTestId('ticket-cond-panel')).toHaveLength(0);
        await expand();
        expect(one('ticket-cond-summary').props['aria-expanded']).toBe(true);
        expect(btn('盤中').props['aria-pressed']).toBe(true);
        expect(btn('盤後').props.disabled).toBe(true);
        expect(text(one('ticket-after-hours-note'))).toContain(TICKET_TEXT.afterHoursCommon);
        // 借券類不提供
        expect(buttons().some(b => /借券/.test(text(b)))).toBe(false);
    });

    it('disables preview when the price is off the tick ladder', async () => {
        await open({ code: '2330', action: 'Buy' });
        await typePrice('100.3');
        expect(preview().props.disabled).toBe(true);
        expect(problemText()).toContain(TICKET_TEXT.priceTick);
        await act(async () => { priceInput().props.onBlur(); });
        expect(root().findAll(n => n.props.role === 'alert' && text(n).includes(TICKET_TEXT.priceTick))).toHaveLength(1);
        await typePrice('100.5');
        expect(preview().props.disabled).toBe(false);
        // 步進用升降單位
        await click('＋');
        expect(priceInput().props.value).toBe('101');
    });

    it('disables preview outside the limit-up / limit-down band; quick prices send limit', async () => {
        await open({ code: '2330', action: 'Buy' });
        await typePrice('111');
        expect(preview().props.disabled).toBe(true);
        expect(problemText()).toContain(TICKET_TEXT.priceRange);
        await choosePriceType('MKT');
        await click('漲停');
        expect(priceInput().props.value).toBe('110');
        expect(priceType().props.value).toBe('LMT');
        await expand();
        expect(btn('ROD').props['aria-pressed']).toBe(true);
        expect(preview().props.disabled).toBe(false);
        await click('跌停');
        expect(priceInput().props.value).toBe('90');
        await click('買一');
        expect(priceInput().props.value).toBe('99.5');
    });

    it('disables preview while the order environment is unconfirmed', async () => {
        h.route = { esun: false, broker: '永豐', simulation: undefined };
        await open({ code: '2330', action: 'Buy' });
        expect(preview().props.disabled).toBe(true);
        expect(problemText()).toContain(TICKET_TEXT.envUnknown);
    });

    it('requires a direction when the ticket was opened with price only', async () => {
        await open({ code: '2330', action: null, price: 100, source: 'depth' });
        expect(problemText()).toContain(TICKET_TEXT.noAction);
        await click('賣出');
        expect(problemText()).toBeNull();
    });

    it('shows the first risk reason and keeps preview disabled', async () => {
        m.risk.mockReturnValue('單筆上限 5 張（風控）');
        await open({ code: '2330', action: 'Buy' });
        expect(problemText()).toContain('單筆上限 5 張（風控）');
        expect(preview().props.disabled).toBe(true);
        expect(m.risk).toHaveBeenCalledWith(1, 'Common');
    });

    it('masks the estimated amount in privacy-money mode', async () => {
        h.privMoney = true;
        await open({ code: '2330', action: 'Buy' });
        expect(text(one('ticket-estimate'))).toContain('•••••');
        expect(text(one('ticket-estimate'))).not.toContain('100,000');
        // 成本列與剩餘額度也遮蔽
        expect(text(one('ticket-cost'))).toContain('•••••');
        h.limits = { data: stockLimits(), error: null, loading: false, updatedAt: 1 };
        await rerender();
        expect(text(one('ticket-limit'))).toContain('•••••');
        expect(text(one('ticket-limit'))).not.toContain('300,000');
    });
});

describe('OrderTicketSheet — 價格來源（B1）與試撮（B2）', () => {
    it('without a real trade, seeds the market snapshot close (not the reference) and labels it', async () => {
        h.quote = undefined;
        h.snapshot = { code: '2330', close: 98 };
        await open({ code: '2330', action: 'Buy' });
        expect(priceInput().props.value).toBe('98');
        expect(text(one('ticket-price-source'))).toContain('快照收盤');
        expect(text(one('ticket-live-price'))).toContain('快照');
        expect(text(one('ticket-live-price'))).toContain('98');
        expect(btn('成交').props['aria-label']).toMatch(/^成交 98(\.0+)?$/);
        expect(preview().props.disabled).toBe(false);
    });

    it('falls back to the reference price only without snapshot, labels it, and upgrades once when the snapshot arrives', async () => {
        h.quote = undefined;
        await open({ code: '2330', action: 'Buy' });
        expect(priceInput().props.value).toBe('100');
        expect(text(one('ticket-price-source'))).toContain('參考價');
        expect(text(one('ticket-live-price'))).toContain('—');
        h.snapshot = { code: '2330', close: 98 };
        await rerender();
        expect(priceInput().props.value).toBe('98');
        expect(text(one('ticket-price-source'))).toContain('快照收盤');
        // 之後不再跟價
        h.quote = { tick: { close: '97' } };
        await rerender();
        expect(priceInput().props.value).toBe('98');
        // 使用者動過價格：不再標示自動帶入的來源
        await typePrice('99');
        expect(byTestId('ticket-price-source')).toHaveLength(0);
    });

    it('does not upgrade the reference price after the user changed the price', async () => {
        h.quote = undefined;
        await open({ code: '2330', action: 'Buy' });
        await typePrice('101');
        h.snapshot = { code: '2330', close: 98 };
        await rerender();
        expect(priceInput().props.value).toBe('101');
    });

    it('ignores a simtrade tick for the default price, live price and the 成交 quick price', async () => {
        h.quote = { tick: { close: '105', simtrade: true } };
        h.snapshot = { code: '2330', close: 98 };
        await open({ code: '2330', action: 'Buy' });
        expect(priceInput().props.value).toBe('98');
        expect(text(one('ticket-live-price'))).not.toContain('105');
        expect(btn('成交').props['aria-label']).toMatch(/^成交 98(\.0+)?$/);
        await click('成交');
        expect(priceInput().props.value).toBe('98');
    });

    it('keeps the previous real trade when a simtrade tick arrives', async () => {
        h.quote = { tick: { close: '100' } };
        await open({ code: '2330', action: 'Buy' });
        h.quote = { tick: { close: '108', simtrade: true } };
        await rerender();
        expect(text(one('ticket-live-price'))).toContain('成交');
        expect(text(one('ticket-live-price'))).toContain('100');
        expect(text(one('ticket-live-price'))).not.toContain('108');
        expect(btn('成交').props['aria-label']).toMatch(/^成交 100(\.0+)?$/);
    });

    it('a simtrade-only quote without snapshot falls back to the reference price', async () => {
        h.quote = { tick: { close: '105', simtrade: true } };
        await open({ code: '2330', action: 'Buy' });
        expect(priceInput().props.value).toBe('100');
        expect(text(one('ticket-price-source'))).toContain('參考價');
        expect(btn('成交').props.disabled).toBe(true);
    });
});

describe('OrderTicketSheet — 期貨／選擇權', () => {
    it('shows notional value and sends a futures input', async () => {
        h.contract = futures;
        h.quote = { tick: { close: '22800' } };
        m.submit.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'f1', seqno: '9' } });
        await open({ code: 'TXFL6', action: 'Sell' });
        expect(buttons().some(b => text(b) === '零股')).toBe(false);
        expect(buttons().some(b => text(b) === '融資')).toBe(false);
        expect(byTestId('ticket-limit')).toHaveLength(0);
        expect(byTestId('ticket-cost')).toHaveLength(0);
        expect(h.limitsAccount).toBeNull();
        expect(qtyInput().props['aria-label']).toBe('數量（口）');
        await typeQty('2');
        expect(text(one('ticket-estimate'))).toContain('名目價值');
        expect(text(one('ticket-estimate'))).toContain((22800 * 200 * 2).toLocaleString('en-US'));
        await click('平倉');
        await choosePriceType('MKP');
        expect(btn('IOC').props['aria-pressed']).toBe(true);
        expect(text(preview())).toBe('預覽賣出委託 · TXFL6 · 2 口 · 範圍市價');
        expect(panel().props['data-tone']).toBe('sell');
        await pressPreview();
        const input = m.submit.mock.calls[0]![0];
        expect(input.isFutures).toBe(true);
        expect(input.futuresOrder).toEqual({ action: 'Sell', price: 0, quantity: 2, price_type: 'MKP', order_type: 'IOC', octype: 'Cover' });
        expect(m.risk).toHaveBeenCalledWith(2, undefined);
    });

    it('rejects an E.SUN account for futures', async () => {
        h.contract = futures;
        const esun = { ...h.futuresAccount, broker_id: 'ESUN' };
        h.esunBrokers.add('ESUN');
        h.captured.F = esun;
        h.selected.F = esun;
        await open({ code: 'TXFL6', action: 'Buy' });
        expect(problemText()).toContain(TICKET_TEXT.esunFutures);
        expect(preview().props.disabled).toBe(true);
    });

    it('explains a missing futures account', async () => {
        h.contract = futures;
        h.captured.F = undefined;
        await open({ code: 'TXFL6', action: 'Buy' });
        expect(problemText()).toContain('玉山證券不支援期貨交易');
        expect(preview().props.disabled).toBe(true);
    });
});

describe('OrderTicketSheet — 連線與 ResumeGate', () => {
    it('disables preview when trading is not live or resyncing', async () => {
        h.live = false;
        await open({ code: '2330', action: 'Buy' });
        expect(problemText()).toContain(TICKET_TEXT.notLive);
        h.live = true;
        await act(async () => { setResumeGateForTest({ state: 'resyncing', resumeSeq: 0 }); });
        expect(problemText()).toContain(TICKET_TEXT.resyncing);
        expect(preview().props.disabled).toBe(true);
    });

    it('stale-data requires the acknowledgement checkbox and passes allowStale to the guard', async () => {
        m.submit.mockImplementation(async (_input: unknown, guards: { assertResumeReady(): void }) => {
            guards.assertResumeReady();
            return { status: { status: 'Submitted' }, order: { id: 'o2', seqno: '5' } };
        });
        await act(async () => { setResumeGateForTest({ state: 'stale-data', resumeSeq: 0, message: '讀取失敗' }); });
        await open({ code: '2330', action: 'Buy' });
        // stale-data 時帶入的價格（快照可能沒更新）也要使用者確認；stale-data 下可以確認
        expect(problemText()).toContain(TICKET_TEXT.priceStale);
        await click('使用此價格');
        expect(problemText()).toContain(TICKET_TEXT.staleData);
        expect(preview().props.disabled).toBe(true);
        await act(async () => { one('ticket-stale-ack').props.onChange(); });
        expect(getResumeGate().staleAcknowledged).toBe(true);
        expect(problemText()).toBeNull();
        await pressPreview();
        expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok', title: '委託已送出' }));
    });

    it('marks the price stale when resumeSeq changes; quick price or manual confirm re-enables preview', async () => {
        await open({ code: '2330', action: 'Buy' });
        expect(byTestId('ticket-price-stale')).toHaveLength(0);
        await act(async () => { setResumeGateForTest({ state: 'ready', resumeSeq: 1 }); });
        expect(byTestId('ticket-price-stale')).toHaveLength(1);
        expect(problemText()).toContain(TICKET_TEXT.priceStale);
        expect(preview().props.disabled).toBe(true);
        await click('使用此價格');
        expect(byTestId('ticket-price-stale')).toHaveLength(0);
        expect(preview().props.disabled).toBe(false);
        await act(async () => { setResumeGateForTest({ state: 'ready', resumeSeq: 2 }); });
        expect(preview().props.disabled).toBe(true);
        await click('成交');
        expect(preview().props.disabled).toBe(false);
    });
});

describe('OrderTicketSheet — ResumeGate 未就緒時帶入的價格（A-2）', () => {
    it('a price seeded while resyncing stays unconfirmed after ready until the user confirms it', async () => {
        await act(async () => { setResumeGateForTest({ state: 'resyncing', resumeSeq: 1 }); });
        await open({ code: '2330', action: 'Buy' });
        expect(priceInput().props.value).toBe('100');
        expect(preview().props.disabled).toBe(true);
        // 同步中按「使用此價格」不算確認（按鈕停用）
        expect(btn('使用此價格').props.disabled).toBe(true);
        await act(async () => { setResumeGateForTest({ state: 'ready', resumeSeq: 1 }); });
        expect(byTestId('ticket-price-stale')).toHaveLength(1);
        expect(problemText()).toContain(TICKET_TEXT.priceStale);
        expect(preview().props.disabled).toBe(true);
        await click('使用此價格');
        expect(byTestId('ticket-price-stale')).toHaveLength(0);
        expect(preview().props.disabled).toBe(false);
    });

    it('the first-trade backfill during resyncing is also unconfirmed after ready', async () => {
        h.quote = undefined;
        h.contract = { ...stock, reference: 0 };
        await act(async () => { setResumeGateForTest({ state: 'resyncing', resumeSeq: 3 }); });
        await open({ code: '2330', action: 'Buy' });
        expect(priceInput().props.value).toBe('');
        h.quote = { tick: { close: '101' } };
        await rerender();
        expect(priceInput().props.value).toBe('101');
        await act(async () => { setResumeGateForTest({ state: 'ready', resumeSeq: 3 }); });
        expect(problemText()).toContain(TICKET_TEXT.priceStale);
        expect(preview().props.disabled).toBe(true);
        await click('成交');
        expect(preview().props.disabled).toBe(false);
    });

    it('a price typed while resyncing must be confirmed again after ready', async () => {
        await act(async () => { setResumeGateForTest({ state: 'resyncing', resumeSeq: 2 }); });
        await open({ code: '2330', action: 'Buy' });
        await typePrice('101');
        await act(async () => { setResumeGateForTest({ state: 'ready', resumeSeq: 2 }); });
        expect(problemText()).toContain(TICKET_TEXT.priceStale);
        await typePrice('101.5');
        expect(problemText()).toBeNull();
        expect(preview().props.disabled).toBe(false);
    });

    it('opened while ready: no stale mark (regression guard)', async () => {
        await act(async () => { setResumeGateForTest({ state: 'ready', resumeSeq: 4 }); });
        await open({ code: '2330', action: 'Buy' });
        expect(byTestId('ticket-price-stale')).toHaveLength(0);
        expect(preview().props.disabled).toBe(false);
    });
});

describe('OrderTicketSheet — 結果處理（§7.2）', () => {
    it('accepted: notifies with status and order number, then closes', async () => {
        let contextDuringSend: boolean | null = null;
        m.submit.mockImplementation(async (_input: unknown, guards: { isContextCurrent(): boolean }) => {
            contextDuringSend = guards.isContextCurrent();
            return { status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1234' } };
        });
        await open({ code: '2330', action: 'Buy' });
        await pressPreview();
        expect(contextDuringSend).toBe(true);
        expect(m.notify).toHaveBeenCalledTimes(1);
        const n = m.notify.mock.calls[0]![0];
        expect(n.kind).toBe('ok');
        expect(n.title).toBe('委託已送出');
        expect(n.body).toContain('#1234');
        expect(getMobileUi().ticket).toBeNull();
        // 面板關閉（元件卸載）後，同一個擷取結果失效：確認中被關閉的舊流程不會再送
        expect(m.submit.mock.calls[0]![1].isContextCurrent()).toBe(false);
    });

    it('cancelled: shows 已取消 and keeps the ticket open', async () => {
        m.submit.mockRejectedValue(new OrderConfirmCancelled());
        await open({ code: '2330', action: 'Buy' });
        await pressPreview();
        expect(text(one('ticket-feedback'))).toBe('已取消');
        expect(getMobileUi().ticket).not.toBeNull();
        expect(m.notify).not.toHaveBeenCalled();
        expect(preview().props.disabled).toBe(false);
    });

    it('not started: shows 未送出：原因 and keeps the ticket open for retry', async () => {
        m.submit.mockRejectedValue(notStarted('風控鎖單中'));
        await open({ code: '2330', action: 'Buy' });
        await pressPreview();
        expect(text(one('ticket-feedback'))).toBe('未送出：風控鎖單中');
        expect(getMobileUi().ticket).not.toBeNull();
        expect(m.reconcile).not.toHaveBeenCalled();
    });

    it('unknown outcome: amber guidance, closes the ticket, no resend button', async () => {
        m.submit.mockRejectedValue(Object.assign(new Error('timeout'), { mutationOutcomeUnknown: true }));
        await open({ code: '2330', action: 'Buy' });
        await pressPreview();
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: OUTCOME_UNKNOWN_TITLE, body: 'timeout' });
        expect(OUTCOME_UNKNOWN_TITLE).toContain('勿重送');
        expect(m.reconcile).toHaveBeenCalledTimes(1);
        expect(getMobileUi().ticket).toBeNull();
        expect(byTestId('order-ticket-sheet')).toHaveLength(0);
        expect(buttons().some(b => /重送|再送/.test(text(b)))).toBe(false);
        expect(m.submit).toHaveBeenCalledTimes(1);
    });

    it('while sending: preview disabled, no duplicate submit, sheet not dismissible', async () => {
        let resolve!: (v: unknown) => void;
        m.submit.mockImplementation(() => new Promise(r => { resolve = r; }));
        await open({ code: '2330', action: 'Buy' });
        await act(async () => { void preview().props.onClick(); });
        expect(preview().props.disabled).toBe(true);
        expect(text(preview())).toBe('送出中…');
        expect(buttons().some(b => b.props['aria-label'] === '關閉')).toBe(false);
        await act(async () => { void preview().props.onClick(); });
        expect(m.submit).toHaveBeenCalledTimes(1);
        await act(async () => { resolve({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } }); });
        expect(getMobileUi().ticket).toBeNull();
    });
});

describe('OrderTicketSheet — 依買賣著色與方向文字', () => {
    it('買進：整個面板 tone＝buy、頂端大字「買進」、預覽鍵寫完整內容', async () => {
        await open({ code: '2330', action: 'Buy' });
        expect(panel().props['data-tone']).toBe('buy');
        expect(text(one('ticket-direction'))).toBe('買進');
        expect(text(preview())).toBe('預覽買進委託 · 2330 · 1 張 · 限價 100');
    });

    it('賣出：tone＝sell；未選方向時中性且提示先選', async () => {
        await open({ code: '2330', action: null, price: 100, source: 'depth' });
        expect(panel().props['data-tone']).toBeUndefined();
        expect(text(one('ticket-direction'))).toBe('請選擇買進或賣出');
        expect(text(preview())).toBe('請先選擇買進或賣出');
        expect(preview().props.disabled).toBe(true);
        await click('賣出');
        expect(panel().props['data-tone']).toBe('sell');
        expect(text(one('ticket-direction'))).toBe('賣出');
        expect(text(preview())).toContain('預覽賣出委託');
        await click('買進');
        expect(panel().props['data-tone']).toBe('buy');
    });

    it('精簡報價列：成交價相對參考價著色符號、漲跌與漲跌%、單量與總量；可當沖標籤', async () => {
        h.quote = { tick: { close: '101', price_chg: '1', volume: 46, total_volume: 36368 }, bidask: { bid_price: ['100.5'], ask_price: ['101'] } };
        await open({ code: '2330', action: 'Buy' });
        expect(text(one('ticket-quote-price'))).toBe('▲101.0');
        expect(text(one('ticket-quote-change'))).toContain('+1.00%');
        expect(text(one('ticket-quote-volume'))).toBe('單:46　總:36,368 張');
        expect(text(one('ticket-daytrade-tag'))).toContain('可當沖');
        h.contract = { ...stock, day_trade: 'No' };
        await act(async () => { closeTicket(); });
        await open({ code: '2330', action: 'Buy' });
        expect(byTestId('ticket-daytrade-tag')).toHaveLength(0);
    });
});

describe('OrderTicketSheet — 信用交易（整股）', () => {
    it('買進時融券標示「融券（回補）」；切換買賣不改信用條件', async () => {
        m.submit.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } });
        await open({ code: '2330', action: 'Buy' });
        await expand();
        await click('融資');
        expect(text(one('ticket-direction'))).toBe('融資買進');
        expect(text(one('ticket-cond-summary'))).toContain('融資 / 盤中 / ROD');
        await click('賣出');
        expect(btn('融資').props['aria-pressed']).toBe(true);
        expect(text(one('ticket-direction'))).toBe('融資賣出');
        await click('融券');
        await click('買進');
        expect(btn('融券（回補）').props['aria-pressed']).toBe(true);
        expect(text(one('ticket-direction'))).toBe('融券買進（回補）');
        await pressPreview();
        const input = m.submit.mock.calls[0]![0];
        expect(input.stockOrder).toEqual({ action: 'Buy', price: 100, quantity: 1, price_type: 'LMT', order_type: 'ROD', order_lot: 'Common', order_cond: 'ShortSelling' });
    });

    it('融資買進送出 order_cond，現股不送；剩餘額度依條件切換', async () => {
        h.limits = { data: stockLimits(), error: null, loading: false, updatedAt: 1 };
        m.submit.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } });
        await open({ code: '2330', action: 'Buy' });
        expect(h.limitsAccount).toBe(h.stockAccount);
        expect(text(one('ticket-limit'))).toContain('剩餘交易額度');
        expect(text(one('ticket-limit'))).toContain('300,000 元');
        await expand();
        await click('融資');
        expect(text(one('ticket-limit'))).toContain('融資剩餘額度');
        expect(text(one('ticket-limit'))).toContain('400,000 元');
        expect(text(one('ticket-cost'))).toContain('融資金額');
        await pressPreview();
        expect(m.submit.mock.calls[0]![0].stockOrder).toMatchObject({ order_cond: 'MarginTrading' });
        expect('daytrade_short' in m.submit.mock.calls[0]![0].stockOrder).toBe(false);
    });

    it('剩餘額度：模擬或非交易時段（全 0）顯示「—」與說明；讀取中；失敗', async () => {
        h.limits = { data: stockLimits({ trading_limit: 0, trading_used: 0, trading_available: 0, margin_limit: 0, margin_available: 0, short_limit: 0, short_available: 0 }), error: null, loading: false, updatedAt: 1 };
        await open({ code: '2330', action: 'Buy' });
        expect(text(one('ticket-limit'))).toContain('—');
        expect(text(one('ticket-limit'))).toContain('08:30–15:00');
        expect(text(one('ticket-limit'))).not.toContain('0 元');
        h.limits = { data: null, error: null, loading: true, updatedAt: null };
        await rerender();
        expect(text(one('ticket-limit'))).toContain('讀取中');
        h.limits = { data: null, error: 'boom', loading: false, updatedAt: null };
        await rerender();
        expect(text(one('ticket-limit'))).toContain('無法取得');
    });

    it('交易成本列（估）：依方向與信用條件組字；市價不估', async () => {
        await open({ code: '2330', action: 'Sell' });
        const cost = text(one('ticket-cost'));
        expect(cost).toContain('交易成本（估）');
        expect(cost).toContain('金額 100,000');
        expect(cost).toContain('證交稅');
        await choosePriceType('MKT');
        expect(byTestId('ticket-cost')).toHaveLength(0);
    });
});

describe('OrderTicketSheet — 現股當沖先賣', () => {
    it('只在 賣出＋整股＋現股＋可當沖 時可勾選；送出 daytrade_short', async () => {
        m.submit.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } });
        await open({ code: '2330', action: 'Buy' });
        await expand();
        expect(byTestId('ticket-daytrade')).toHaveLength(0); // 買進不顯示
        await click('賣出');
        expect(one('ticket-daytrade').props.disabled).toBe(false);
        await act(async () => { one('ticket-daytrade').props.onClick(); });
        expect(one('ticket-daytrade').props['aria-pressed']).toBe(true);
        expect(text(one('ticket-direction'))).toBe('現股當沖賣出');
        expect(text(one('ticket-cond-summary'))).toContain('現沖先賣');
        expect(text(one('ticket-cost'))).toContain('證交稅');
        await pressPreview();
        expect(m.submit.mock.calls[0]![0].stockOrder).toEqual({ action: 'Sell', price: 100, quantity: 1, price_type: 'LMT', order_type: 'ROD', order_lot: 'Common', daytrade_short: true });
    });

    it('選融資會取消勾選；不可當沖的股票無法勾選', async () => {
        await open({ code: '2330', action: 'Sell' });
        await expand();
        await act(async () => { one('ticket-daytrade').props.onClick(); });
        await click('融資');
        expect(byTestId('ticket-daytrade')).toHaveLength(0);
        await click('現股');
        expect(one('ticket-daytrade').props['aria-pressed']).toBe(false);
        h.contract = { ...stock, day_trade: 'OnlyBuy' };
        await act(async () => { closeTicket(); });
        await open({ code: '2330', action: 'Sell' });
        await expand();
        expect(one('ticket-daytrade').props.disabled).toBe(true);
    });

    it('切到零股會改回現股、取消當沖（使用者操作，比照桌面）', async () => {
        await open({ code: '2330', action: 'Sell' });
        await expand();
        await act(async () => { one('ticket-daytrade').props.onClick(); });
        await click('零股');
        expect(btn('現股').props['aria-pressed']).toBe(true);
        expect(byTestId('ticket-daytrade')).toHaveLength(0);
        expect(text(one('ticket-direction'))).toBe('賣出');
    });
});

describe('OrderTicketSheet — 盤後零股', () => {
    it('零股的盤後＝Odd：送出 order_lot Odd、LMT、ROD、無 order_cond；隱藏五檔並說明時段', async () => {
        m.submit.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } });
        await open({ code: '2330', action: 'Buy' });
        await click('零股');
        await expand();
        await click('盤後');
        expect(btn('盤後').props['aria-pressed']).toBe(true);
        expect(text(one('ticket-cond-summary'))).toContain('現股 / 盤後 / ROD');
        expect(text(one('ticket-odd-note'))).toContain('13:40–14:30 收單');
        expect(text(one('ticket-odd-note'))).toContain('14:30');
        expect(byTestId('depth-ladder-stub')).toHaveLength(0);
        expect(byTestId('ticket-no-depth')).toHaveLength(1);
        // 盤後零股沒有即時五檔：買一／賣一無資料
        expect(btn('買一').props.disabled).toBe(true);
        await click('盤中');
        expect(btn('盤中').props['aria-pressed']).toBe(true);
        expect(h.ladder).toMatchObject({ oddLot: true });
        await click('盤後');
        await typeQty('250');
        await pressPreview();
        const input = m.submit.mock.calls[0]![0];
        expect(input.orderLot).toBe('Odd');
        expect(input.stockOrder).toEqual({ action: 'Buy', price: 100, quantity: 250, price_type: 'LMT', order_type: 'ROD', order_lot: 'Odd' });
        expect('order_cond' in input.stockOrder).toBe(false);
        expect(m.risk).toHaveBeenLastCalledWith(250, 'Odd');
    });
});

describe('OrderTicketSheet — openTicket 帶入 lot／cond／daytradeShort', () => {
    it('帶入合規則的值：條件列預設展開並照用', async () => {
        m.submit.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } });
        await open({ code: '2330', action: 'Sell', cond: 'ShortSelling' });
        expect(byTestId('ticket-cond-panel')).toHaveLength(1);
        expect(btn('融券').props['aria-pressed']).toBe(true);
        expect(text(one('ticket-direction'))).toBe('融券賣出');
        await pressPreview();
        expect(m.submit.mock.calls[0]![0].stockOrder).toMatchObject({ order_cond: 'ShortSelling' });
    });

    it('帶入盤後零股', async () => {
        await open({ code: '2330', action: 'Buy', lot: 'Odd' });
        expect(btn('零股').props['aria-pressed']).toBe(true);
        expect(btn('盤後').props['aria-pressed']).toBe(true);
        expect(qtyInput().props['aria-label']).toBe('數量（股）');
    });

    it('不合規則（零股＋融資、買進＋當沖以外的組合）保留帶入值並顯示原因、停用預覽，不自動換條件', async () => {
        await open({ code: '2330', action: 'Sell', lot: 'IntradayOdd', cond: 'MarginTrading' });
        expect(btn('融資').props['aria-pressed']).toBe(true);
        expect(problemText()).toContain('零股只能以現股買賣');
        expect(preview().props.disabled).toBe(true);
        await act(async () => { closeTicket(); });
        h.contract = { ...stock, day_trade: 'No' };
        await open({ code: '2330', action: 'Sell', daytradeShort: true });
        expect(one('ticket-daytrade').props['aria-pressed']).toBe(true);
        expect(one('ticket-daytrade').props.disabled).toBe(false); // 可以取消
        expect(problemText()).toContain('不能現股當沖先賣');
        expect(preview().props.disabled).toBe(true);
        await act(async () => { one('ticket-daytrade').props.onClick(); });
        expect(problemText()).toBeNull();
    });
});

describe('OrderTicketSheet — 內嵌五檔與信用提醒', () => {
    it('五檔點價位：帶入價格並改成限價、視為已確認（不決定買賣）', async () => {
        await open({ code: '2330', action: 'Buy' });
        expect(h.ladder).toMatchObject({ variant: 'ticket', oddLot: false, code: '2330' });
        await choosePriceType('MKT');
        await act(async () => { setResumeGateForTest({ state: 'ready', resumeSeq: 1 }); });
        await act(async () => { (h.ladder!.onPick as (p: number, s: 'bid' | 'ask') => void)(99, 'bid'); });
        expect(priceType().props.value).toBe('LMT');
        expect(priceInput().props.value).toBe('99');
        expect(byTestId('ticket-price-stale')).toHaveLength(0);
        expect(preview().props.disabled).toBe(false);
        expect(text(one('ticket-direction'))).toBe('買進');
    });

    it('持倉衝突的信用提醒：只提示，按了才改條件，並附在送單備註', async () => {
        m.submit.mockRejectedValue(new OrderConfirmCancelled());
        h.positions = [{ code: '2330', direction: 'Sell', cond: 'ShortSelling', quantity: 1, account: h.stockAccount }];
        await open({ code: '2330', action: 'Buy' });
        expect(text(one('ticket-credit-hint'))).toContain('現股買進不會回補融券');
        await pressPreview();
        expect(m.submit.mock.calls[0]![0].creditHint).toContain('現股買進不會回補融券');
        expect(m.submit.mock.calls[0]![0].stockOrder).not.toHaveProperty('order_cond');
        await act(async () => { btn('改用融券（回補）').props.onClick(); });
        expect(text(one('ticket-direction'))).toBe('融券買進（回補）');
        expect(byTestId('ticket-credit-hint')).toHaveLength(0);
    });
});
