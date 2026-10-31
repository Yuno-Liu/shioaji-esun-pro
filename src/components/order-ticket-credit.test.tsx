// fork：下單面板切回買進時不再把融券靜默改成現股 — 融券買進＝回補，送出
// order_cond 'ShortSelling'，確認視窗寫「融券買進」；借券類買進明確擋下並說明。
// 資料全為合成。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const m = vi.hoisted(() => ({ confirm: vi.fn(), stock: vi.fn(), risk: vi.fn() }));
const h = vi.hoisted(() => {
    const account = { account_type: 'S', broker_id: 'BR', account_id: 'S0001', signed: true, person_id: '', username: '' };
    return { account, accounts: [account] as unknown[], positions: [] as unknown[], loaded: true };
});
// 持倉（信用提醒用）：下單票以動態載入讀取交易狀態
vi.mock('../lib/trading-state', () => ({
    getTradingState: () => ({ positions: h.positions, queries: { positions: { updatedAt: h.loaded ? 1 : null } } }),
    subscribeTradingState: () => () => undefined,
}));
vi.mock('../lib/account-store', () => {
    const state = () => ({ accounts: h.accounts, selectedStock: h.account, selectedFutures: null, loaded: true });
    return { useAccounts: state, getAccountState: state, selectAccount: vi.fn() };
});
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: Account) => `${a.broker_id}-${a.account_id}` }));
vi.mock('../lib/risk', () => ({ checkOrderAllowed: m.risk, getRiskSettings: () => ({ confirmManualOrders: true }) }));
vi.mock('../lib/shioaji', () => ({ fetchInfo: () => new Promise(() => undefined), placeFuturesOrder: vi.fn(), placeStockOrder: m.stock }));
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));
vi.mock('../lib/bracket', () => ({ ensureBracketHost: vi.fn(), registerBracket: vi.fn(), registrationFailureText: String, validateBracketRequest: () => null }));
vi.mock('./bracket-status', () => ({ BracketStatusList: () => null }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'sim' }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => ({ tick: { close: '100' } }), useTradingLive: () => true }));
vi.mock('../lib/price-sync', () => ({ usePickedPrice: () => null }));
vi.mock('../lib/allocation', () => ({ allocateByRatio: (t: number, w: number[]) => w.map(() => t), loadAllocPresets: () => [], saveAllocPreset: () => [], deleteAllocPreset: () => [] }));
import { OrderTicket } from './order-ticket';
import { CREDIT_TEXT } from '../lib/odd-lot';
import { NO_SHORT_TO_COVER_NOTE } from '../lib/stock-exit-cond';

const contract = { code: '9999', name: '測試股', security_type: 'STK', exchange: 'TSE', reference: 100, day_trade: 'Yes' } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const btn = (label: string) => view.root.findAllByType('button').find(b => text(b) === label);
const exec = () => view.root.findAllByType('button').find(b => /(買進|賣出)下單|確認(買進|賣出)/.test(text(b)))!;
const qtyInput = () => view.root.findAll(n => n.type === 'input' && String(n.props['aria-label'] ?? '').startsWith('數量'))[0]!;
const buyBtn = () => view.root.findAllByType('button').find(b => /^買進/.test(text(b)) && !/下單/.test(text(b)))!;

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    h.accounts = [h.account];
    h.positions = [];
    h.loaded = true;
    m.confirm.mockResolvedValue(true);
    m.risk.mockReturnValue(null);
    m.stock.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('賣出＋融券 then 買進: the condition stays 融券 and goes out as a 融券買進 (回補)', async () => {
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await act(async () => { btn('賣出 Sell')!.props.onClick(); });
    await act(async () => { btn('融券')!.props.onClick(); });
    await act(async () => { qtyInput().props.onChange({ target: { value: '2' } }); });
    await act(async () => { buyBtn().props.onClick(); });
    // not silently switched to 現股
    expect(btn('融券（回補）')).toBeDefined();
    expect(btn('融券（回補）')!.props.className).toMatch(/seg_on/);
    expect(btn('現股')!.props.className).toMatch(/seg_off/);
    await act(async () => { await exec().props.onClick(); }); // arm
    await act(async () => { await exec().props.onClick(); });
    expect(m.confirm).toHaveBeenCalledOnce();
    expect(m.confirm.mock.calls[0]![0]).toMatchObject({ action: 'Buy', credit: '融券', quantity: 2 });
    expect(m.confirm.mock.calls[0]![0].note).toContain('・融券');
    expect(m.stock).toHaveBeenCalledOnce();
    expect(m.stock.mock.calls[0]![1]).toMatchObject({ action: 'Buy', quantity: 2, order_lot: 'Common', order_cond: 'ShortSelling' });
});

it('賣出＋借券 then 買進: explicitly refused with the reason, never sent as 現股', async () => {
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await act(async () => { btn('賣出 Sell')!.props.onClick(); });
    await act(async () => { btn('借券')!.props.onClick(); });
    await act(async () => { buyBtn().props.onClick(); });
    // the selected 借券 stays visible on the buy side, with the explanation
    expect(btn('借券')).toBeDefined();
    expect(text(view.root)).toContain(CREDIT_TEXT.shortBuy);
    expect(btn('借券')!.props.className).toMatch(/seg_on/);
    await act(async () => { await exec().props.onClick(); });
    await act(async () => { await exec().props.onClick(); });
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.stock).not.toHaveBeenCalled();
    // picking 現股 is the user's choice and works
    await act(async () => { btn('現股')!.props.onClick(); });
    expect(btn('借券')).toBeUndefined();
    await act(async () => { await exec().props.onClick(); });
    await act(async () => { await exec().props.onClick(); });
    expect(m.stock).toHaveBeenCalledOnce();
    expect(m.stock.mock.calls[0]![1].order_cond).toBeUndefined();
});

const flushImport = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const hint = () => view.root.findAll(n => n.props['data-testid'] === 'ticket-credit-hint' && typeof n.type === 'string');
const shortRow = () => ({ account: h.account, id: 1, code: '9999', direction: 'Sell', quantity: 2000, price: 100, last_price: 100, pnl: 0, cond: 'ShortSelling' });
const marginRow = () => ({ account: h.account, id: 2, code: '9999', direction: 'Buy', quantity: 1000, price: 100, last_price: 100, pnl: 0, cond: 'MarginTrading' });

it('現股買進 with a 融券 short held: warns, writes it into the confirmation, and still sends 現股 (no silent switch)', async () => {
    h.positions = [shortRow()];
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await flushImport();
    expect(hint()).toHaveLength(1);
    expect(text(hint()[0]!)).toContain('現股買進不會回補融券');
    expect(btn('現股')!.props.className).toMatch(/seg_on/);
    await act(async () => { await exec().props.onClick(); });
    await act(async () => { await exec().props.onClick(); });
    expect(m.confirm.mock.calls[0]![0].credit).toBeUndefined();
    expect(m.confirm.mock.calls[0]![0].note).toContain('現股買進不會回補融券');
    expect(m.stock.mock.calls[0]![1]).toMatchObject({ action: 'Buy', order_cond: undefined });
});

it('the one-click 改用融券（回補） switches only when pressed, then sends a 融券買進', async () => {
    h.positions = [shortRow()];
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await flushImport();
    await act(async () => { btn('改用融券（回補）')!.props.onClick(); });
    expect(btn('融券（回補）')!.props.className).toMatch(/seg_on/);
    expect(hint()).toHaveLength(0); // a short is held: no 查無 hint either
    await act(async () => { await exec().props.onClick(); });
    await act(async () => { await exec().props.onClick(); });
    expect(m.confirm.mock.calls[0]![0]).toMatchObject({ action: 'Buy', credit: '融券' });
    expect(m.stock.mock.calls[0]![1]).toMatchObject({ action: 'Buy', order_cond: 'ShortSelling' });
});

it('現股賣出 with a 融資 long held: warns 現股賣出不會了結融資 and offers 改用融資（賣出）', async () => {
    h.positions = [marginRow()];
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await flushImport();
    expect(hint()).toHaveLength(0); // buy side: nothing to warn about
    await act(async () => { btn('賣出 Sell')!.props.onClick(); });
    expect(text(hint()[0]!)).toContain('現股賣出不會了結融資');
    await act(async () => { await exec().props.onClick(); });
    await act(async () => { await exec().props.onClick(); });
    expect(m.confirm.mock.calls[0]![0].note).toContain('現股賣出不會了結融資');
    expect(m.stock.mock.calls[0]![1]).toMatchObject({ action: 'Sell', order_cond: undefined });
    await act(async () => { btn('改用融資（賣出）')!.props.onClick(); });
    expect(btn('融資')!.props.className).toMatch(/seg_on/);
    expect(hint()).toHaveLength(0);
});

it('融券買進 without a short of this stock: hint only (still sent); no hint before positions are loaded', async () => {
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await flushImport();
    await act(async () => { btn('賣出 Sell')!.props.onClick(); });
    await act(async () => { btn('融券')!.props.onClick(); });
    await act(async () => { buyBtn().props.onClick(); });
    expect(text(hint()[0]!)).toBe(NO_SHORT_TO_COVER_NOTE);
    expect(btn('改用融券（回補）')).toBeUndefined();
    await act(async () => { await exec().props.onClick(); });
    await act(async () => { await exec().props.onClick(); });
    expect(m.confirm.mock.calls[0]![0].note).toContain(NO_SHORT_TO_COVER_NOTE);
    expect(m.stock.mock.calls[0]![1]).toMatchObject({ action: 'Buy', order_cond: 'ShortSelling' });
    await act(async () => view.unmount());
    h.loaded = false;
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await flushImport();
    await act(async () => { btn('賣出 Sell')!.props.onClick(); });
    await act(async () => { btn('融券')!.props.onClick(); });
    await act(async () => { buyBtn().props.onClick(); });
    expect(hint()).toHaveLength(0);
});

it('split 融券買進: the batch confirmation carries the credit condition', async () => {
    const second = { ...h.account, account_id: 'S0002' };
    h.accounts = [h.account, second];
    h.positions = [shortRow(), { ...shortRow(), id: 9, account: second }];
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await flushImport();
    await act(async () => { btn('賣出 Sell')!.props.onClick(); });
    await act(async () => { btn('融券')!.props.onClick(); });
    await act(async () => { buyBtn().props.onClick(); });
    const has = (label: string) => view.root.findAllByType('button').find(b => text(b).includes(label))!;
    await act(async () => { has('多帳戶分倉').props.onClick(); });
    await act(async () => { await has('分倉買進').props.onClick(); });
    await act(async () => { await has('確認分倉').props.onClick(); });
    expect(m.confirm).toHaveBeenCalledOnce();
    expect(m.confirm.mock.calls[0]![0]).toMatchObject({ action: 'Buy', credit: '融券' });
    expect(m.confirm.mock.calls[0]![0].note).toContain('・融券');
    expect(m.confirm.mock.calls[0]![0].note).not.toContain(NO_SHORT_TO_COVER_NOTE);
    expect(m.stock).toHaveBeenCalledTimes(2);
    expect(m.stock.mock.calls.every(c => c[1].order_cond === 'ShortSelling')).toBe(true);
});
