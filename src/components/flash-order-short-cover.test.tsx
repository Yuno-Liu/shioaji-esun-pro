import '../test/mock-order-reconciliation';
import { operationNotice } from '../test/operation-notice';
// fork：融券空單與現股多單是兩筆獨立部位。閃電股票面板的持有量只算和面板
// 信用條件相同的列：現股面板有融券空單時，現股買進是進場（照規則附保護）、
// 不是減倉；持倉依條件分開顯示，不因淨額 0 隱藏；融券面板的買邊是融券買進
// （回補）。資料全為合成。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
import type { FlashCredit, FlashOrderOpts } from '../lib/flash-account';
import { CASH_BUY_NO_COVER_TEXT } from '../lib/flash-trigger';
import { CASH_SELL_NO_CLOSE_TEXT, NO_SHORT_TO_COVER_NOTE } from '../lib/stock-exit-cond';

const m = vi.hoisted(() => ({ place: vi.fn(), exit: vi.fn(), notify: vi.fn(), bracket: vi.fn(), post: vi.fn() }));
const accounts: Account[] = [
    { account_type: 'S', broker_id: 'BR', account_id: 'S0001', signed: true, person_id: '', username: '' },
    { account_type: 'F', broker_id: 'BR', account_id: 'F0001', signed: true, person_id: '', username: '' },
];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: accounts[1] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: { tick: { close: '100', volume: 1 } }, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../hooks/use-flash-ladder', () => ({ useFlashLadder: () => ({ marks: new Map(), protectedQty: 0, background: false }) }));
vi.mock('../lib/flash-conditional', () => ({ flashPlaceBracket: m.bracket, flashStopProtections: async () => ({ stopped: 0, blocked: [], failed: [], restore: [] }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: m.notify, placeQuickOrder: m.place, placeStockExitByShares: m.exit }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/api', () => ({ apiPost: m.post }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => 'fixture' }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';
import { resetCreditEnquireCache } from '../lib/credit-eligibility';

const stk = { code: '9999', name: '測試股', security_type: 'STK', exchange: 'TSE', day_trade: 'Yes', reference: 100, limit_up: 110, limit_down: 90 } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
const roots: ReactTestRenderer[] = [];
const button = (r: ReactTestRenderer, label: string) => r.root.findAllByType('button').find(b => text(b) === label);
const byTestId = (r: ReactTestRenderer, id: string) => r.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const arm = async (r: ReactTestRenderer) => { await act(async () => { button(r, '啟用閃電下單')!.props.onClick(); }); };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const setQty = async (r: ReactTestRenderer, q: number) => {
    await act(async () => { r.root.findAll(n => n.type === 'input' && String(n.props['aria-label'] ?? '').startsWith('數量'))[0]!.props.onChange({ target: { value: String(q) } }); });
};

const shortRow = { account: accounts[0], id: 1, code: '9999', direction: 'Sell' as const, quantity: 2000, price: 100, last_price: 100, pnl: 0, cond: 'ShortSelling' };
const cashRow = { account: accounts[0], id: 2, code: '9999', direction: 'Buy' as const, quantity: 2000, price: 100, last_price: 100, pnl: 0, cond: 'Cash' };
const PROTECT: FlashOrderOpts = { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT', protect: { on: true, stopTicks: 8, takeTicks: 16, trail: null } };

const mount = async (positions: unknown[], extra: { credit?: FlashCredit; order?: FlashOrderOpts } = {}) => {
    let r!: ReactTestRenderer;
    const el = createElement(FlashOrder, { contract: stk, trades: [], positions: positions as never, credit: extra.credit, onCreditChange: vi.fn(),
        orderOpts: extra.order, onOrderOptsChange: vi.fn() });
    await act(async () => {
        r = create(el, { createNodeMock: () => ({ getBoundingClientRect: () => ({ top: 0 }), clientHeight: 21 * 22, addEventListener() {}, removeEventListener() {} }) });
    });
    roots.push(r);
    await flush();
    return r;
};

beforeEach(() => {
    vi.clearAllMocks();
    resetCreditEnquireCache();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    m.place.mockResolvedValue({ order: { id: 'o1' }, status: { status: 'Submitted' } });
    m.bracket.mockResolvedValue('placed');
    m.post.mockResolvedValue([{ stock_id: '9999', system: 'ALL', update_time: '', margin_unit: 100, short_unit: 50, margin_loan_ratio: 60, short_margin_ratio: 90 }]);
});
afterEach(async () => { for (const r of roots.splice(0)) await act(async () => r.unmount()); vi.unstubAllGlobals(); });

it('cash panel holding only a 融券 short: a market buy is an entry with protection, never 減倉', async () => {
    const r = await mount([shortRow], { order: PROTECT });
    expect(text(byTestId(r, 'flash-cover-warning')[0]!)).toContain('現股買進不會回補融券');
    expect(button(r, '市價買')!.props.title).toBe(CASH_BUY_NO_COVER_TEXT);
    await arm(r);
    await setQty(r, 2);
    if (button(r, '啟用閃電下單')) await arm(r);
    await act(async () => { await button(r, '市價買')!.props.onClick(); });
    await flush();
    // judged as an entry (held 0 on the cash panel): it goes through the bracket, not a plain reduce
    expect(m.bracket).toHaveBeenCalledOnce();
    expect(m.bracket.mock.calls[0]![0]).toMatchObject({ action: 'Buy', entry: { type: 'MKT' } });
    expect(m.place).not.toHaveBeenCalled();
    const bodies = m.notify.mock.calls.map(c => String(c[0].body ?? ''));
    expect(bodies.some(b => b.includes('減倉'))).toBe(false);
});

it('a cash long and a 融券 short of the same stock are shown apart, even though they net to zero', async () => {
    const r = await mount([shortRow, cashRow]);
    const bar = byTestId(r, 'flash-pos-groups')[0]!;
    expect(text(bar)).toContain('融券空 2');
    expect(text(bar)).toContain('現股多 2');
    // the cash panel still warns: the cash buy does not cover the short
    expect(byTestId(r, 'flash-cover-warning')).toHaveLength(1);
    // 平倉 stays with the positions panel while credit rows exist (net 0). Since upstream #376 the slot is always
    // rendered, so it must be present but disabled and point to the positions panel — never a flatten action
    const flat = button(r, '平倉')!;
    expect(flat.props.disabled).toBe(true);
    expect(flat.props.title).toContain('持倉面板');
});

it('the 融券 panel buys back as 融券買進（回補）, even when 可否融券 is 0', async () => {
    // 可否融券為 0：融券賣出會被擋，但回補（融券買進）不受限，照樣送出
    m.post.mockResolvedValue([{ stock_id: '9999', system: 'ALL', update_time: '', margin_unit: 100, short_unit: 0, margin_loan_ratio: 60, short_margin_ratio: 90 }]);
    const r = await mount([shortRow, cashRow], { credit: { cond: 'ShortSelling', daytradeShort: false } });
    expect(byTestId(r, 'flash-cover-warning')).toHaveLength(0);
    expect(text(byTestId(r, 'flash-credit-banner')[0]!)).toContain('融券買進（回補）照常');
    expect(button(r, '市價融券買（回補）')!.props.disabled).toBe(false);
    await arm(r);
    await setQty(r, 2);
    if (button(r, '啟用閃電下單')) await arm(r);
    await act(async () => { await button(r, '市價融券買（回補）')!.props.onClick(); });
    await flush();
    expect(m.place).toHaveBeenCalledOnce();
    expect(m.place.mock.calls[0]!.slice(1, 4)).toEqual(['Buy', null, 2]);
    expect(m.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'ShortSelling' });
    // a short is held: no 查無融券空單 hint in the confirmation
    expect(String(m.place.mock.calls[0]![4].confirmNote ?? '')).not.toContain(NO_SHORT_TO_COVER_NOTE);
    expect(operationNotice(m.notify, '⚡ 融券買進已送出').title).toBe('⚡ 融券買進已送出');
});

it('融券 panel with protection on, holding [short, cash]: held counts only the short, so a buy of 2 is a reduce and is sent', async () => {
    // held 若誤用全部列淨額（-2＋2＝0）會判為進場，被「自動停損停利只支援現股」擋下
    const r = await mount([shortRow, cashRow], { credit: { cond: 'ShortSelling', daytradeShort: false }, order: PROTECT });
    await arm(r);
    await setQty(r, 2);
    if (button(r, '啟用閃電下單')) await arm(r);
    await act(async () => { await button(r, '市價融券買（回補）')!.props.onClick(); });
    await flush();
    expect(m.bracket).not.toHaveBeenCalled();
    expect(m.place).toHaveBeenCalledOnce();
    expect(m.place.mock.calls[0]!.slice(1, 4)).toEqual(['Buy', null, 2]);
    expect(m.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'ShortSelling' });
    expect(m.notify.mock.calls.some(c => String(c[0].body ?? '').includes('只支援現股'))).toBe(false);
});

it('融券 panel without a short of this stock: the buy still goes out, with a 查無融券空單 hint in the confirmation', async () => {
    const r = await mount([cashRow], { credit: { cond: 'ShortSelling', daytradeShort: false } });
    await arm(r);
    if (button(r, '啟用閃電下單')) await arm(r);
    await act(async () => { await button(r, '市價融券買（回補）')!.props.onClick(); });
    await flush();
    expect(m.place).toHaveBeenCalledOnce();
    expect(m.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'ShortSelling' });
    expect(m.place.mock.calls[0]![4].confirmNote).toContain(NO_SHORT_TO_COVER_NOTE);
});

it('cash panel holding a 融資 long: the sell side warns that a 現股 sell does not close it', async () => {
    const marginRow = { ...cashRow, id: 3, cond: 'MarginTrading' };
    const r = await mount([marginRow]);
    expect(text(byTestId(r, 'flash-margin-warning')[0]!)).toContain('現股賣出不會了結融資');
    expect(button(r, '市價賣')!.props.title).toBe(CASH_SELL_NO_CLOSE_TEXT);
    expect(byTestId(r, 'flash-cover-warning')).toHaveLength(0);
    // only a cash long: no margin warning
    const r2 = await mount([cashRow]);
    expect(byTestId(r2, 'flash-margin-warning')).toHaveLength(0);
    // 上游讓按鈕提示顯示完整動作名稱；沒有融資多單時只是一般的「市價賣」，不是警告
    expect(button(r2, '市價賣')!.props.title).toBe('市價賣');
    expect(button(r2, '市價賣')!.props.title).not.toBe(CASH_SELL_NO_CLOSE_TEXT);
});
