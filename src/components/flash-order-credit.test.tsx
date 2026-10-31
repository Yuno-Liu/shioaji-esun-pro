import '../test/mock-order-reconciliation';
import { operationNotice } from '../test/operation-notice';
// 閃電下單整股面板的信用條件：現股／融資／融券＋現股當沖先賣。記在面板上
// （跟單位一樣），換股票保留；零股停用並說明、期貨不顯示；融券只能賣、
// 當沖先賣只限可當沖股票；credit_enquire 確定不可（成數或單位 0）才擋兩邊，
// 查詢失敗只提示不擋；絕不自動改成現股送出。換信用條件立即解除點價下單。
import { createElement, useLayoutEffect } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../hooks/use-flash-ladder', () => ({ useFlashLadder: () => ({ marks: new Map(), protectedQty: 0, background: false }) }));
vi.mock('../lib/flash-conditional', () => ({ flashStopProtections: async () => ({ stopped: 0, blocked: [], failed: [], restore: [] }) }));
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ place: vi.fn(), exit: vi.fn(), notify: vi.fn(), post: vi.fn(), base: 'fixture', store: new Map<string, string>() }));
const accounts: Account[] = [
    { account_type: 'S', broker_id: 'BR', account_id: 'A1234', signed: true, person_id: '', username: '' },
    { account_type: 'F', broker_id: 'BR', account_id: 'F5678', signed: true, person_id: '', username: '' },
];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: accounts[1] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: { tick: { close: '100', volume: 1 } }, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place, placeStockExitByShares: mocks.exit }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/api', () => ({ apiPost: mocks.post }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => mocks.base }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';
import { resetCreditEnquireCache } from '../lib/credit-eligibility';
import type { FlashCredit } from '../lib/flash-account';

const stk = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', day_trade: 'Yes', reference: 100, limit_up: 110, limit_down: 90 } as unknown as ContractInfo;
const hon = { ...stk, code: '2317', name: '鴻海' } as ContractInfo;
const onlyBuy = { ...stk, code: '1101', name: '台泥', day_trade: 'OnlyBuy' } as ContractInfo;
const fut = { code: 'TXFR1', name: '臺股期貨', security_type: 'FUT', exchange: 'TAIFEX', reference: 100 } as unknown as ContractInfo;
const enquire = (code: string, patch: Record<string, number> = {}) => [{ stock_id: code, system: 'ALL', update_time: '', margin_unit: 100, short_unit: 50, margin_loan_ratio: 60, short_margin_ratio: 90, ...patch }];

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
const roots: ReactTestRenderer[] = [];
const button = (r: ReactTestRenderer, label: string) => r.root.findAllByType('button').find(b => text(b) === label);
const creditBtn = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '單位與委託條件')[0];
const menu = (r: ReactTestRenderer) => r.root.findAll(n => n.props.role === 'menu')[0];
const item = (r: ReactTestRenderer, label: string) => menu(r)!.findAll(n => n.type === 'button' && String(n.props.role).startsWith('menuitem') && text(n).startsWith(label))[0]!;
const tag = (r: ReactTestRenderer) => r.root.findAll(n => n.props['data-testid'] === 'flash-credit-tag')[0];
const banner = (r: ReactTestRenderer) => r.root.findAll(n => n.props['data-testid'] === 'flash-credit-banner')[0];
const cell = (r: ReactTestRenderer, side: 'buy' | 'sell') => r.root.findAll(n => n.type === 'div' && n.props['data-side'] === side)[0]!;
const arm = async (r: ReactTestRenderer) => { await act(async () => { button(r, '啟用閃電下單')!.props.onClick(); }); };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

const keyListeners = new Set<(e: unknown) => void>();
const pressEscape = async () => {
    await act(async () => {
        const e = { key: 'Escape', defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
        // capture listeners (the menu's) run first, like the browser
        for (const fn of [...keyListeners]) { if (e.stopped) break; fn(e); }
    });
};
const owned = (credit?: FlashCredit, lot?: 'Common' | 'IntradayOdd') => {
    const state = { credit, lot, changes: [] as FlashCredit[] };
    const extra = () => ({
        credit: state.credit, onCreditChange: (c: FlashCredit) => { state.credit = c; state.changes.push(c); },
        lot: state.lot, onLotChange: (l: 'Common' | 'IntradayOdd') => { state.lot = l; },
    });
    return { state, extra };
};
const props = (contract: ContractInfo, extra: Record<string, unknown> = {}) => ({ contract, trades: [], positions: [], ...extra });
const mount = async (contract: ContractInfo, extra: Record<string, unknown> = {}) => {
    let r!: ReactTestRenderer;
    await act(async () => { r = create(createElement(FlashOrder, props(contract, extra))); });
    roots.push(r);
    await flush();
    return r;
};
const show = async (r: ReactTestRenderer, contract: ContractInfo, extra: Record<string, unknown> = {}) => {
    await act(async () => { r.update(createElement(FlashOrder, props(contract, extra))); });
    await flush();
};
const pick = async (r: ReactTestRenderer, label: string, rerender?: () => Promise<void>) => {
    await act(async () => { creditBtn(r)!.props.onClick(); });
    await act(async () => { item(r, label).props.onClick(); });
    if (rerender) await rerender();
    await flush();
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.base = 'fixture';
    mocks.store.clear();
    resetCreditEnquireCache();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mocks.store.get(k) ?? null, setItem: (k: string, v: string) => { mocks.store.set(k, v); } });
    keyListeners.clear();
    vi.stubGlobal('window', {
        addEventListener: (t: string, fn: (e: unknown) => void) => { if (t === 'keydown') keyListeners.add(fn); },
        removeEventListener: (t: string, fn: (e: unknown) => void) => { if (t === 'keydown') keyListeners.delete(fn); },
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.place.mockResolvedValue({ status: { status: 'PendingSubmit' } });
    mocks.post.mockImplementation(async (_p: string, body: { contracts: { code: string }[] }) => enquire(body.contracts[0]!.code));
});
afterEach(async () => {
    for (const r of roots.splice(0)) await act(async () => r.unmount());
    vi.unstubAllGlobals();
});

it('現股 (default) looks exactly like today: no tag, 張, 市價買／市價賣, cash orders', async () => {
    const r = await mount(stk);
    expect(tag(r)).toBeUndefined();
    expect(banner(r)).toBeUndefined();
    expect(creditBtn(r)!.props['data-unit']).toBe('張');
    expect(button(r, '市價買')).toBeDefined();
    expect(button(r, '市價賣')).toBeDefined();
    await arm(r);
    await act(async () => { cell(r, 'buy').props.onClick(); });
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'Cash', daytradeShort: false });
    expect(mocks.post).not.toHaveBeenCalled();
});

it('融資: the panel saves it, shows the tag, the 張·融資 button and 市價融資買／賣, and sends 融資 both ways', async () => {
    const owner = owned();
    const r = await mount(stk, owner.extra());
    await pick(r, '融資', () => show(r, stk, owner.extra()));
    expect(owner.state.credit).toEqual({ cond: 'MarginTrading', daytradeShort: false });
    expect(text(tag(r)!)).toBe('融資');
    expect(creditBtn(r)!.props['data-unit']).toBe('張·融資');
    expect(text(banner(r)!)).toContain('點買＝融資買進，點賣＝融資賣出');
    expect(button(r, '市價融資買')).toBeDefined();
    expect(button(r, '市價融資賣')).toBeDefined();
    await arm(r);
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    await act(async () => { cell(r, 'sell').props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls.map(c => [c[1], c[4].orderCond])).toEqual([['Buy', 'MarginTrading'], ['Sell', 'MarginTrading']]);
    expect(mocks.notify.mock.calls.map(c => c[0].title)).toEqual(['⚡ 融資買進已送出', '⚡ 融資賣出已送出']);
});

it('融券 buys back (融券買進＝回補, fork fix) and sells, both with the 融券 condition', async () => {
    const owner = owned({ cond: 'ShortSelling', daytradeShort: false });
    const r = await mount(stk, owner.extra());
    expect(text(tag(r)!)).toBe('融券');
    expect(button(r, '市價融券賣')).toBeDefined();
    expect(button(r, '市價融券買（回補）')!.props.disabled).toBe(false);
    expect(button(r, '市價買')).toBeUndefined();
    await arm(r);
    expect(cell(r, 'buy').props['data-blocked']).toBeUndefined();
    await act(async () => { cell(r, 'sell').props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls[0]![1]).toBe('Sell');
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'ShortSelling' });
    expect(operationNotice(mocks.notify, '⚡ 融券賣出已送出').title).toBe('⚡ 融券賣出已送出');
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls[1]![1]).toBe('Buy');
    expect(mocks.place.mock.calls[1]![4]).toMatchObject({ orderCond: 'ShortSelling' });
    expect(operationNotice(mocks.notify, '⚡ 融券買進已送出').title).toBe('⚡ 融券買進已送出');
});

it('現股當沖先賣: sell is a 現沖 sell, buy stays a cash buy; 市價現沖賣', async () => {
    const owner = owned();
    const r = await mount(stk, owner.extra());
    await pick(r, '現股當沖先賣', () => show(r, stk, owner.extra()));
    expect(owner.state.credit).toEqual({ cond: 'Cash', daytradeShort: true });
    expect(text(tag(r)!)).toBe('現沖');
    expect(button(r, '市價現沖賣')).toBeDefined();
    expect(button(r, '市價買')).toBeDefined();
    await arm(r);
    await act(async () => { cell(r, 'sell').props.onClick(); });
    await flush();
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'Cash', daytradeShort: true });
    expect(mocks.place.mock.calls[1]![1]).toBe('Buy');
    expect(mocks.notify.mock.calls.map(c => c[0].title)).toEqual(['⚡ 現沖賣出已送出', '⚡ 買進已送出']);
    // credit_enquire is not needed for 現沖
    expect(mocks.post).not.toHaveBeenCalled();
});

it('現沖 on a stock that cannot day-trade blocks only the sell side, never sends it as cash', async () => {
    const r = await mount(onlyBuy, owned({ cond: 'Cash', daytradeShort: true }).extra());
    expect(tag(r)!.props['data-bad']).toBe(true);
    expect(text(banner(r)!)).toContain('不能現沖先賣');
    await arm(r);
    expect(cell(r, 'sell').props['data-blocked']).toBe(true);
    await act(async () => { cell(r, 'sell').props.onClick(); });
    await act(async () => { button(r, '市價現沖賣')!.props.onClick(); });
    await flush();
    expect(mocks.place).not.toHaveBeenCalled();
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(mocks.place).toHaveBeenCalledOnce();
    expect(mocks.place.mock.calls[0]![1]).toBe('Buy');
});

it('a stock that definitely cannot 融券 (unit 0) stops 融券賣出 and says why; 融券買進（回補）still goes out', async () => {
    mocks.post.mockImplementation(async () => enquire('2330', { short_unit: 0 }));
    const r = await mount(stk, owned({ cond: 'ShortSelling', daytradeShort: false }).extra());
    expect(tag(r)!.props['data-bad']).toBe(true);
    expect(text(banner(r)!)).toContain('2330 目前不能融券');
    expect(button(r, '市價融券賣')!.props['data-blocked']).toBe(true);
    await arm(r);
    expect(cell(r, 'sell').props['data-blocked']).toBe(true);
    await act(async () => { cell(r, 'sell').props.onClick(); });
    await flush();
    expect(mocks.place).not.toHaveBeenCalled();
    // 信用了結不受暫停限制
    expect(cell(r, 'buy').props['data-blocked']).toBeUndefined();
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(mocks.place).toHaveBeenCalledOnce();
    expect(mocks.place.mock.calls[0]![1]).toBe('Buy');
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'ShortSelling' });
});

it('融資 on a stock whose margin ratio is 0 stops only 融資買進; 融資賣出 (repaying) still goes out', async () => {
    mocks.post.mockImplementation(async () => enquire('2330', { margin_loan_ratio: 0 }));
    const r = await mount(stk, owned({ cond: 'MarginTrading', daytradeShort: false }).extra());
    expect(text(banner(r)!)).toContain('目前不能融資買進');
    expect(text(banner(r)!)).toContain('融資賣出');
    // shown faded (clickable to re-check); the click itself is refused while the answer is 0
    expect(button(r, '市價融資買')!.props['data-blocked']).toBe(true);
    expect(button(r, '市價融資賣')!.props['data-blocked']).toBeUndefined();
    await arm(r);
    expect(cell(r, 'buy').props['data-blocked']).toBe(true);
    expect(cell(r, 'sell').props['data-blocked']).toBeUndefined();
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(mocks.place).not.toHaveBeenCalled();
    await act(async () => { cell(r, 'sell').props.onClick(); });
    await flush();
    expect(mocks.place).toHaveBeenCalledOnce();
    expect(mocks.place.mock.calls[0]![1]).toBe('Sell');
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'MarginTrading' });
});

it('a failed credit enquiry only warns — the order still goes out as 融資 (the broker decides)', async () => {
    mocks.post.mockRejectedValue(new Error('down'));
    const r = await mount(stk, owned({ cond: 'MarginTrading', daytradeShort: false }).extra());
    expect(text(banner(r)!)).toContain('無法確認可否融資券');
    expect(tag(r)!.props['data-bad']).toBeFalsy();
    await arm(r);
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'MarginTrading' });
});

it('changing the credit condition disarms in the same render — even when the owner changes it', async () => {
    let r!: ReactTestRenderer;
    // the click fires in the same commit as the new condition, before FlashOrder's passive effects
    const Wrapped = ({ credit, click }: { credit: FlashCredit; click: boolean }) => {
        useLayoutEffect(() => {
            if (!click) return;
            cell(r, 'sell').props.onClick();
        }, [click]);
        return createElement(FlashOrder, props(stk, { credit, onCreditChange: () => undefined }));
    };
    await act(async () => { r = create(createElement(Wrapped, { credit: { cond: 'MarginTrading', daytradeShort: false }, click: false })); });
    roots.push(r);
    await flush();
    await arm(r);
    expect(text(r.root)).toContain('點價即下單');
    await act(async () => { r.update(createElement(Wrapped, { credit: { cond: 'ShortSelling', daytradeShort: false }, click: true })); });
    await flush();
    expect(mocks.place).not.toHaveBeenCalled();
    expect(text(r.root)).toContain('啟用閃電下單');
});

it('picking a condition from the menu disarms', async () => {
    const owner = owned({ cond: 'MarginTrading', daytradeShort: false });
    const r = await mount(stk, owner.extra());
    await arm(r);
    await pick(r, '現股', () => show(r, stk, owner.extra()));
    expect(owner.state.credit).toEqual({ cond: 'Cash', daytradeShort: false });
    expect(text(r.root)).toContain('啟用閃電下單');
    expect(tag(r)).toBeUndefined();
});

it('keeps the condition when the panel moves to another stock (and re-checks that stock)', async () => {
    const owner = owned({ cond: 'MarginTrading', daytradeShort: false });
    const r = await mount(stk, owner.extra());
    await show(r, hon, owner.extra());
    expect(text(tag(r)!)).toBe('融資');
    expect(owner.state.changes).toEqual([]);
    expect(mocks.post.mock.calls.map(c => c[1].contracts[0].code)).toEqual(['2330', '2317']);
    // a fresh mount (reload) restores it from the owner
    const again = await mount(hon, owned({ cond: 'ShortSelling', daytradeShort: false }).extra());
    expect(text(tag(again)!)).toBe('融券');
});

it('odd lots: credit options are disabled with an explanation; orders are cash; back to 張 restores 融資', async () => {
    const owner = owned({ cond: 'MarginTrading', daytradeShort: false }, 'IntradayOdd');
    const r = await mount(stk, owner.extra());
    expect(tag(r)).toBeUndefined();
    expect(creditBtn(r)!.props['data-unit']).toBe('股');
    await act(async () => { creditBtn(r)!.props.onClick(); });
    expect(item(r, '融資').props.disabled).toBe(true);
    expect(item(r, '融券').props.disabled).toBe(true);
    expect(item(r, '現股當沖先賣').props.disabled).toBe(true);
    expect(text(menu(r)!)).toContain('零股只能以現股買賣');
    await act(async () => { item(r, '融資').props.onClick(); });
    expect(owner.state.changes).toEqual([]);
    // back to 整股 from the same menu restores the panel's 融資
    await act(async () => { item(r, '張（整股）').props.onClick(); });
    await show(r, stk, owner.extra());
    expect(owner.state.lot).toBe('Common');
    expect(text(tag(r)!)).toBe('融資');
    // and in odd lots nothing credit-related is sent
    owner.state.lot = 'IntradayOdd';
    await show(r, stk, owner.extra());
    await arm(r);
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderLot: 'IntradayOdd' });
    expect(mocks.place.mock.calls[0]![4]).not.toHaveProperty('orderCond');
    expect(mocks.place.mock.calls[0]![4]).not.toHaveProperty('daytradeShort');
});

it('futures panels show no credit control and never send one', async () => {
    const r = await mount(fut, owned({ cond: 'ShortSelling', daytradeShort: false }).extra());
    // the futures unit menu has no credit items
    expect(creditBtn(r)!.props['data-unit']).toBe('口');
    await act(async () => { creditBtn(r)!.props.onClick(); });
    expect(menu(r)!.findAll(n => n.type === 'button' && /^(現股|融資|融券|借券)/.test(text(n)))).toHaveLength(0);
    await act(async () => { creditBtn(r)!.props.onClick(); });
    expect(tag(r)).toBeUndefined();
    expect(banner(r)).toBeUndefined();
    expect(button(r, '市價買')).toBeDefined();
    await arm(r);
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls[0]![4]).not.toHaveProperty('orderCond');
    expect(mocks.post).not.toHaveBeenCalled();
});

it('stock panels fold the settings gear into the unit menu (更多設定…)', async () => {
    const gear = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '閃電下單設定')[0]!;
    const r = await mount(stk);
    expect(gear(r).props.hidden).toBe(true);
    expect(gear(r).props.style).toMatchObject({ display: 'none' });
    await act(async () => { creditBtn(r)!.props.onClick(); });
    await act(async () => { item(r, '更多設定').props.onClick(); });
    expect(menu(r)).toBeUndefined();
    expect(r.root.findAll(n => n.props.role === 'dialog' && n.props['aria-label'] === '閃電下單設定')).toHaveLength(1);
    // futures fold it into the 口 menu as well (flash-order-ordertype.test.tsx)
    const f = await mount(fut);
    expect(gear(f).props.hidden).toBe(true);
});

it('a server switch while the credit check is pending refuses the order (never sent to the new server)', async () => {
    const r = await mount(stk, owned({ cond: 'MarginTrading', daytradeShort: false }).extra());
    await arm(r);
    resetCreditEnquireCache();
    let release!: (v: unknown) => void;
    mocks.post.mockImplementationOnce(() => new Promise(res => { release = res; }));
    await act(async () => { cell(r, 'buy').props.onClick(); });
    mocks.base = 'other-server';
    await act(async () => { release(enquire('2330')); });
    await flush();
    expect(mocks.place).not.toHaveBeenCalled();
    expect(operationNotice(mocks.notify, '⚡ 閃電下單失敗').kind).toBe('err');
});

it('the dispatch guard refuses a pending (confirming) order once the credit condition changes, even back again', async () => {
    let guard!: () => void;
    mocks.place.mockImplementation((_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { beforeSend: () => void }) => {
        guard = opts.beforeSend;
        return new Promise(() => undefined);
    });
    const owner = owned({ cond: 'MarginTrading', daytradeShort: false });
    const r = await mount(stk, owner.extra());
    await arm(r);
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(mocks.place).toHaveBeenCalledOnce();
    expect(() => guard()).not.toThrow();
    owner.state.credit = { cond: 'Cash', daytradeShort: false };
    await show(r, stk, owner.extra());
    owner.state.credit = { cond: 'MarginTrading', daytradeShort: false };
    await show(r, stk, owner.extra());
    expect(() => guard()).toThrow();
});

it('a blocked answer only lasts the day: a long-open panel re-checks after the Taipei day changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-08T15:00:00+08:00'));
    mocks.post.mockImplementation(async () => enquire('2330', { short_unit: 0 }));
    const r = await mount(stk, owned({ cond: 'ShortSelling', daytradeShort: false }).extra());
    expect(text(banner(r)!)).toContain('目前不能融券');
    mocks.post.mockImplementation(async () => enquire('2330'));
    await act(async () => {
        vi.setSystemTime(new Date('2026-10-09T08:30:00+08:00'));
        vi.advanceTimersByTime(18 * 3600_000);
    });
    await flush();
    await flush();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(text(banner(r)!)).not.toContain('目前不能融券');
});

it('a server switch re-checks eligibility instead of keeping the old server answer', async () => {
    mocks.post.mockImplementation(async () => enquire('2330', { short_unit: 0 }));
    const owner = owned({ cond: 'ShortSelling', daytradeShort: false });
    const r = await mount(stk, owner.extra());
    expect(text(banner(r)!)).toContain('目前不能融券');
    mocks.post.mockImplementation(async () => enquire('2330'));
    mocks.base = 'other-server';
    await show(r, stk, owner.extra());
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(text(banner(r)!)).not.toContain('目前不能融券');
});

it('借券／借券豁免 can only sell: buy faded, sell sends the SBL condition, no credit enquiry', async () => {
    for (const [label, cond, tagText] of [['借券', 'SBLShort', '借券'], ['借券豁免', 'SBLShortPriceExempt', '借券豁免']] as const) {
        vi.clearAllMocks();
        mocks.place.mockResolvedValue({ status: { status: 'PendingSubmit' } });
        const owner = owned();
        const r = await mount(stk, owner.extra());
        await pick(r, label, () => show(r, stk, owner.extra()));
        expect(owner.state.credit).toEqual({ cond, daytradeShort: false });
        expect(text(tag(r)!)).toBe(tagText);
        // the unit button stays short on narrow panels
        expect(creditBtn(r)!.props['data-unit']).toBe(cond === 'SBLShort' ? '張·借券' : '張·借豁');
        expect(button(r, '市價買')!.props.disabled).toBe(true);
        expect(button(r, `市價${tagText}賣`)).toBeDefined();
        await arm(r);
        await act(async () => { cell(r, 'buy').props.onClick(); });
        await flush();
        expect(mocks.place).not.toHaveBeenCalled();
        await act(async () => { cell(r, 'sell').props.onClick(); });
        await flush();
        expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderCond: cond });
        expect(operationNotice(mocks.notify, `⚡ ${tagText}賣出已送出`).title).toBe(`⚡ ${tagText}賣出已送出`);
        expect(mocks.post).not.toHaveBeenCalled();
    }
});

it('a confirmation left open past Taipei midnight is refused at dispatch (the new day must be re-checked)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T23:59:00+08:00'));
    let guard!: () => void;
    mocks.place.mockImplementation((_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { beforeSend: () => void }) => {
        guard = opts.beforeSend;
        return new Promise(() => undefined);
    });
    const r = await mount(stk, owned({ cond: 'ShortSelling', daytradeShort: false }).extra());
    await arm(r);
    await act(async () => { cell(r, 'sell').props.onClick(); });
    await flush();
    expect(() => guard()).not.toThrow();
    vi.setSystemTime(new Date('2026-10-09T00:00:30+08:00'));
    expect(() => guard()).toThrow();
});

it('a stock menu left open when the panel switches to futures does not swallow Esc (Esc still disarms)', async () => {
    const r = await mount(stk);
    await act(async () => { creditBtn(r)!.props.onClick(); });
    expect(menu(r)).toBeDefined();
    await show(r, fut);
    expect(menu(r)).toBeUndefined();
    await arm(r);
    expect(text(r.root)).toContain('點價即下單');
    await pressEscape();
    expect(text(r.root)).toContain('啟用閃電下單');
    // back on a stock the menu is closed
    await show(r, stk);
    expect(menu(r)).toBeUndefined();
});

it('a pending 現沖 sell is refused at dispatch if the stock stops being day-tradable meanwhile', async () => {
    let guard!: () => void;
    mocks.place.mockImplementation((_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { beforeSend: () => void }) => {
        guard = opts.beforeSend;
        return new Promise(() => undefined);
    });
    const owner = owned({ cond: 'Cash', daytradeShort: true });
    const r = await mount(stk, owner.extra());
    await arm(r);
    await act(async () => { cell(r, 'sell').props.onClick(); });
    await flush();
    expect(() => guard()).not.toThrow();
    // same symbol, refreshed contract: no longer day-tradable
    await show(r, { ...stk, day_trade: 'OnlyBuy' } as ContractInfo, owner.extra());
    expect(() => guard()).toThrow();
});

it('after the confirmation, a fresh credit check runs before dispatch; a new 0 blocks the order', async () => {
    let captured!: { afterConfirm?: () => Promise<void> };
    mocks.place.mockImplementation(async (_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { afterConfirm?: () => Promise<void> }) => {
        captured = opts;
        await opts.afterConfirm?.();
        return { status: { status: 'PendingSubmit' } };
    });
    const r = await mount(stk, owned({ cond: 'MarginTrading', daytradeShort: false }).extra());
    await arm(r);
    // the cached (positive) answer lets the click through; the re-check after confirmation finds 0
    mocks.post.mockImplementation(async () => enquire('2330', { margin_unit: 0 }));
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(captured.afterConfirm).toBeTypeOf('function');
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(operationNotice(mocks.notify, '⚡ 閃電下單失敗')).toMatchObject({ kind: 'err' });
    expect(operationNotice(mocks.notify, '⚡ 閃電下單失敗').body).toContain('目前不能融資');
});

it('a 現沖 sell confirmation left open past Taipei midnight is refused at dispatch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T23:59:00+08:00'));
    let guard!: () => void;
    mocks.place.mockImplementation((_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { beforeSend: () => void }) => {
        guard = opts.beforeSend;
        return new Promise(() => undefined);
    });
    const r = await mount(stk, owned({ cond: 'Cash', daytradeShort: true }).extra());
    await arm(r);
    await act(async () => { cell(r, 'sell').props.onClick(); });
    await flush();
    expect(() => guard()).not.toThrow();
    vi.setSystemTime(new Date('2026-10-09T00:00:30+08:00'));
    expect(() => guard()).toThrow();
});

it('a flatten refused before anything went out says 未送出, not "maybe partly sent"', async () => {
    const position = { code: '2330', direction: 'Buy', quantity: 2000, price: 100, pnl: 0, last_price: 100, cond: 'Cash', account: accounts[0] };
    mocks.exit.mockRejectedValue(Object.assign(new Error('確認期間伺服器或模式已變更，這筆沒有送出，請重新下單'), { mutationNotStarted: true }));
    const r = await mount(stk, { positions: [position] });
    await arm(r);
    await act(async () => { button(r, '平倉')!.props.onClick(); });
    await flush();
    expect(operationNotice(mocks.notify, '⚡ 平倉未成立（未送出或被券商拒絕）')).toMatchObject({ kind: 'err', title: '⚡ 平倉未成立（未送出或被券商拒絕）' });
});

it('the post-confirmation re-check never blocks a 融資賣出 (repayment)', async () => {
    mocks.place.mockImplementation(async (_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { afterConfirm?: () => Promise<void> }) => {
        await opts.afterConfirm?.();
        return { status: { status: 'PendingSubmit' } };
    });
    const r = await mount(stk, owned({ cond: 'MarginTrading', daytradeShort: false }).extra());
    await arm(r);
    mocks.post.mockImplementation(async () => enquire('2330', { margin_unit: 0 }));
    await act(async () => { cell(r, 'sell').props.onClick(); });
    await flush();
    expect(operationNotice(mocks.notify, '⚡ 融資賣出已送出')).toMatchObject({ kind: 'ok', title: '⚡ 融資賣出已送出' });
});

it('the server mode is captured at the click, before the credit check: a mode change meanwhile refuses', async () => {
    const store = await import('../lib/server-info-store');
    store.observeServerInfo(store.beginServerInfoRequest(), { simulation: true } as never);
    const r = await mount(stk, owned({ cond: 'MarginTrading', daytradeShort: false }).extra());
    await arm(r);
    resetCreditEnquireCache();
    let release!: (v: unknown) => void;
    mocks.post.mockImplementationOnce(() => new Promise(res => { release = res; }));
    let guardSeen: (() => boolean) | undefined;
    mocks.place.mockImplementation(async (_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { serverMode?: () => boolean }) => {
        guardSeen = opts.serverMode;
        return { status: { status: 'PendingSubmit' } };
    });
    await act(async () => { cell(r, 'buy').props.onClick(); });
    store.observeServerInfo(store.beginServerInfoRequest(), { simulation: false } as never);
    await act(async () => { release(enquire('2330')); });
    await flush();
    // the click-time guard goes to placeQuickOrder (which checks it after the confirmation): it is now invalid
    expect(mocks.place).toHaveBeenCalledOnce();
    expect(guardSeen?.()).toBe(false);
});

it('a cached 0 does not block all day: the click re-queries a blocked answer and goes out if it recovered', async () => {
    mocks.post.mockImplementation(async () => enquire('2330', { margin_unit: 0 }));
    const r = await mount(stk, owned({ cond: 'MarginTrading', daytradeShort: false }).extra());
    expect(text(banner(r)!)).toContain('目前不能融資買進');
    mocks.post.mockImplementation(async () => enquire('2330'));
    await arm(r);
    // the market button stays clickable so a click can re-check (it is only shown faded)
    expect(button(r, '市價融資買')!.props.disabled).toBe(false);
    await act(async () => { button(r, '市價融資買')!.props.onClick(); });
    await flush();
    expect(mocks.place).toHaveBeenCalledOnce();
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'MarginTrading' });
    // the fresh answer reaches the panel: no longer shown as blocked
    expect(text(banner(r)!)).not.toContain('目前不能融資買進');
});
