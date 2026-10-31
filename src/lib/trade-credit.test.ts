// 閃電下單信用條件（現股／融資／融券／現股當沖先賣）：placeQuickOrder 帶
// orderCond／daytradeShort 到送單、確認視窗寫出信用條件，並在送出前照下單
// 面板現行規則再檢查一次（融券不能買、當沖先賣只限現股＋可當沖、零股只能現股）。
import { beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { ContractBase } from './types/contract';
const m = vi.hoisted(() => ({ confirm: vi.fn(), stock: vi.fn(), future: vi.fn(), accounts: [] as Account[], confirmOn: true, onRisk: undefined as undefined | (() => void) }));
vi.mock('./runtime', () => ({ getApiBase: () => 'fixture' }));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts, selectedStock: m.accounts[0], selectedFutures: undefined }) }));
vi.mock('./activity', () => ({ trackActivity: vi.fn() }));
vi.mock('./order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: Account) => a.account_id }));
vi.mock('./risk', () => ({ checkOrderAllowed: () => null, getRiskSettings: () => { m.onRisk?.(); return { confirmManualOrders: m.confirmOn }; } }));
vi.mock('./stream', () => ({ getStreamStatus: () => 'live' }));
vi.mock('./trading-mirror-lease', () => ({ getTradingMirrorFresh: () => true }));
vi.mock('./shioaji', () => ({ placeStockOrder: m.stock, placeFuturesOrder: m.future, fetchTrades: vi.fn(), cancelOrders: vi.fn() }));
import { placeQuickOrder } from './trade';
import { CREDIT_TEXT, ODD_LOT_TEXT } from './odd-lot';

const account = { account_type: 'S', account_id: 'a', broker_id: 'b', signed: true, person_id: '', username: '' } as Account;
const stock = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null, day_trade: 'Yes' } as ContractBase;
const onlyBuy = { ...stock, day_trade: 'OnlyBuy' } as ContractBase;

beforeEach(() => {
    vi.clearAllMocks();
    m.accounts = [account];
    m.confirmOn = true;
    m.onRisk = undefined;
    m.confirm.mockResolvedValue(true);
    m.stock.mockResolvedValue({ status: { status: 'PendingSubmit' } });
});

it('sends 融資 and 融券 on both sides (融券買進＝回補), with the condition on the stock order', async () => {
    await placeQuickOrder(stock, 'Buy', 100, 2, { account, orderCond: 'MarginTrading' });
    await placeQuickOrder(stock, 'Sell', 100, 2, { account, orderCond: 'MarginTrading' });
    await placeQuickOrder(stock, 'Sell', 100, 1, { account, orderCond: 'ShortSelling' });
    await placeQuickOrder(stock, 'Buy', null, 2, { account, orderCond: 'ShortSelling' });
    expect(m.stock.mock.calls.map(c => c[1].order_cond)).toEqual(['MarginTrading', 'MarginTrading', 'ShortSelling', 'ShortSelling']);
    expect(m.stock.mock.calls[3]![1]).toMatchObject({ action: 'Buy', quantity: 2, price_type: 'MKT', order_type: 'IOC', order_lot: 'Common', order_cond: 'ShortSelling' });
    // 確認視窗的動作名稱是「融券買進」
    expect(m.confirm.mock.calls[3]![0]).toMatchObject({ action: 'Buy', credit: '融券' });
    expect(m.stock.mock.calls.every(c => c[1].daytrade_short === undefined)).toBe(true);
});

it('cash orders stay exactly as before (no order_cond, no daytrade_short)', async () => {
    await placeQuickOrder(stock, 'Buy', 100, 1, { account });
    await placeQuickOrder(stock, 'Sell', 100, 1, { account, orderCond: 'Cash' });
    for (const c of m.stock.mock.calls) {
        expect(c[1]).not.toHaveProperty('order_cond');
        expect(c[1]).not.toHaveProperty('daytrade_short');
    }
});

it('sends 現股當沖先賣 only on the sell side of a day-trade stock', async () => {
    await placeQuickOrder(stock, 'Sell', 100, 1, { account, daytradeShort: true });
    expect(m.stock.mock.calls[0]![1]).toMatchObject({ daytrade_short: true });
    expect(m.stock.mock.calls[0]![1]).not.toHaveProperty('order_cond');
    // the buy side of a 現沖 panel is a plain cash buy (回補)
    await placeQuickOrder(stock, 'Buy', 100, 1, { account, daytradeShort: true });
    expect(m.stock.mock.calls[1]![1]).not.toHaveProperty('daytrade_short');
});

it.each([
    ['借券買進', stock, 'Buy', { orderCond: 'SBLShort' }, CREDIT_TEXT.shortBuy],
    ['借券豁免買進', stock, 'Buy', { orderCond: 'SBLShortPriceExempt' }, CREDIT_TEXT.shortBuy],
    ['零股融券買進', stock, 'Buy', { orderCond: 'ShortSelling', orderLot: 'IntradayOdd' }, ODD_LOT_TEXT.cond],
    ['不可當沖的當沖先賣', onlyBuy, 'Sell', { daytradeShort: true }, CREDIT_TEXT.daytradeStock],
    ['融資＋當沖先賣', stock, 'Sell', { orderCond: 'MarginTrading', daytradeShort: true }, CREDIT_TEXT.daytradeCond],
    ['零股融資', stock, 'Buy', { orderCond: 'MarginTrading', orderLot: 'IntradayOdd' }, ODD_LOT_TEXT.cond],
    ['零股當沖先賣', stock, 'Sell', { daytradeShort: true, orderLot: 'IntradayOdd' }, ODD_LOT_TEXT.daytrade],
] as const)('refuses %s before the confirmation dialog, nothing sent', async (_name, contract, action, opts, message) => {
    await expect(placeQuickOrder(contract, action, 100, 1, { account, ...opts })).rejects.toMatchObject({ mutationNotStarted: true, message });
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.stock).not.toHaveBeenCalled();
});

it('credit conditions are stock-only: futures orders refuse them', async () => {
    const fut = { code: 'TXFR1', security_type: 'FUT', exchange: 'TAIFEX' } as ContractBase;
    m.accounts = [{ ...account, account_type: 'F' }];
    await expect(placeQuickOrder(fut, 'Buy', 100, 1, { account: m.accounts[0], orderCond: 'MarginTrading' })).rejects.toMatchObject({ mutationNotStarted: true });
    expect(m.future).not.toHaveBeenCalled();
});

it('the confirmation names the credit condition in the action and the note', async () => {
    await placeQuickOrder(stock, 'Sell', 1090, 2, { account, orderCond: 'ShortSelling' });
    expect(m.confirm.mock.calls[0]![0]).toMatchObject({ action: 'Sell', credit: '融券', note: '限價 ROD・融券' });
    await placeQuickOrder(stock, 'Buy', null, 1, { account, orderCond: 'MarginTrading' });
    expect(m.confirm.mock.calls[1]![0]).toMatchObject({ credit: '融資', note: '市價 IOC・融資' });
    await placeQuickOrder(stock, 'Sell', 1090, 1, { account, daytradeShort: true });
    expect(m.confirm.mock.calls[2]![0]).toMatchObject({ credit: '現沖', note: '限價 ROD・現股當沖' });
    await placeQuickOrder(stock, 'Sell', 1090, 1, { account, orderCond: 'SBLShort' });
    expect(m.confirm.mock.calls.at(-1)![0]).toMatchObject({ credit: '借券', note: '限價 ROD・借券' });
    await placeQuickOrder(stock, 'Sell', 1090, 1, { account, orderCond: 'SBLShortPriceExempt' });
    expect(m.confirm.mock.calls.at(-1)![0]).toMatchObject({ credit: '借券豁免', note: '限價 ROD・借券豁免' });
    expect(m.stock.mock.calls.at(-1)![1]).toMatchObject({ order_cond: 'SBLShortPriceExempt' });
    // cash keeps today's note
    await placeQuickOrder(stock, 'Buy', 1090, 1, { account });
    expect(m.confirm.mock.calls.at(-1)![0].credit).toBeUndefined();
    expect(m.confirm.mock.calls.at(-1)![0].note).toBeUndefined();
});

it('a server mode change during the confirmation refuses the order (same API address)', async () => {
    const store = await import('./server-info-store');
    store.observeServerInfo(store.beginServerInfoRequest(), { simulation: true } as never);
    m.confirm.mockImplementation(async () => {
        store.observeServerInfo(store.beginServerInfoRequest(), { simulation: false } as never);
        return true;
    });
    await expect(placeQuickOrder(stock, 'Buy', 100, 1, { account, orderCond: 'MarginTrading' })).rejects.toMatchObject({ mutationNotStarted: true });
    expect(m.stock).not.toHaveBeenCalled();
});

it('runs afterConfirm after the confirmation and before dispatch; a throw refuses the order', async () => {
    const order: string[] = [];
    m.confirm.mockImplementation(async () => { order.push('confirm'); return true; });
    const afterConfirm = vi.fn(async () => { order.push('after'); throw new Error('目前不能融資'); });
    await expect(placeQuickOrder(stock, 'Buy', 100, 1, { account, orderCond: 'MarginTrading', afterConfirm })).rejects.toMatchObject({ mutationNotStarted: true, message: '目前不能融資' });
    expect(order).toEqual(['confirm', 'after']);
    expect(m.stock).not.toHaveBeenCalled();
});

it('without a confirmation, a mode learned during the order is not adopted (unknown → production refuses)', async () => {
    m.confirmOn = false;
    const store = await import('./server-info-store');
    store.forgetServerInfo('fixture');
    // the mode becomes known as production right where a confirmation would have been
    m.onRisk = () => { store.observeServerInfo(store.beginServerInfoRequest(), { simulation: false } as never); };
    await expect(placeQuickOrder(stock, 'Buy', 100, 1, { account })).rejects.toMatchObject({ mutationNotStarted: true });
    expect(m.stock).not.toHaveBeenCalled();
});

it('a cancelled confirmation is a definite "not sent" (mutationNotStarted)', async () => {
    m.confirm.mockResolvedValue(false);
    await expect(placeQuickOrder(stock, 'Buy', 100, 1, { account })).rejects.toMatchObject({ mutationNotStarted: true, message: '已取消下單' });
});
