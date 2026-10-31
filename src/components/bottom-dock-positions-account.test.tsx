import { reconcileOrdersOnce } from '../test/mock-order-reconciliation';
import { operationNotice } from '../test/operation-notice';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
const mocks = vi.hoisted(() => ({ place: vi.fn(), stock: vi.fn(), notify: vi.fn(), simulation: undefined as boolean | undefined }));
vi.mock('../lib/trade', () => ({ placeQuickOrder: mocks.place, placeStockExitByShares: mocks.stock, notify: mocks.notify }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../lib/contracts-cache', () => ({ ensureContract: async (code: string) => {
    if (code === '9999') throw new Error('contract fetch failed');
    return { code, name: code, security_type: code === '2330' ? 'STK' : 'FUT' };
} }));
vi.mock('../lib/server-info-store', () => ({ useServerInfo: () => null, yesterdayQuantityNotice: () => null, knownServerInfo: () => ({ simulation: mocks.simulation }) }));
vi.mock('./bottom-dock-shared', async original => ({ ...await original<object>(), useMeasuredWidth: () => ({ ref: { current: null }, width: 1400 }) }));
import { PositionsPane } from './bottom-dock-positions';
import { ArmLockButton, ConfirmButton } from './bottom-dock-shared';
const selected: Account = { account_type: 'F', broker_id: 'BR', account_id: 'SELECTED', signed: true, person_id: '', username: '' };
const owner = { ...selected, account_id: 'OWNER' };
const position: AccountedPosition = { account: owner, code: 'TMF', id: 1, direction: 'Buy', quantity: 3, price: 100, last_price: 100, pnl: 0 };
let view: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.simulation = undefined; });
async function mount(row: AccountedPosition) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    await act(async () => { view = create(createElement(PositionsPane, { positions: [row], initialStatus: 'ready', mode: 'merged', market: 'all', scopeKey: '', fallback: { stock: null, futures: selected }, onChanged: vi.fn(), onSelectCode: vi.fn() })); });
    await act(async () => { view!.root.findAllByType(ArmLockButton)[0]!.props.onToggle(); });
}
it('shows loading before the first positions result and empty only after a successful read', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    const props = { positions: [], mode: 'merged' as const, market: 'all' as const,
        scopeKey: '', fallback: { stock: null, futures: selected },
        onChanged: vi.fn(), onSelectCode: vi.fn() };
    await act(async () => { view = create(createElement(PositionsPane, { ...props, initialStatus: 'loading' })); });
    expect(JSON.stringify(view!.toJSON())).toContain('載入持倉');
    expect(JSON.stringify(view!.toJSON())).not.toContain('NO OPEN POSITIONS');
    await act(async () => { view!.update(createElement(PositionsPane, { ...props, initialStatus: 'ready' })); });
    expect(JSON.stringify(view!.toJSON())).toContain('NO OPEN POSITIONS');
    await act(async () => { view!.update(createElement(PositionsPane, { ...props, initialStatus: 'failed' })); });
    expect(JSON.stringify(view!.toJSON())).toContain('持倉尚未確認');
    expect(JSON.stringify(view!.toJSON())).not.toContain('NO OPEN POSITIONS');
});
async function click(label: string) {
    const button = view!.root.findAllByType('button').find(b => b.children.filter(c => typeof c === 'string').join('').trim() === label)!;
    await act(async () => { await button.props.onClick({ stopPropagation: vi.fn() }); });
}
it('closes the row owner with Cover even when another account is selected', async () => {
    mocks.place.mockResolvedValue({ status: { status: 'Submitted', deal_quantity: 0 } });
    await mount(position); await click('平');
    expect(mocks.place.mock.calls[0]!.slice(1)).toEqual(['Sell', null, 3, { account: owner, ocType: 'Cover' }]);
});
it.each([true, false, undefined])('allows unsigned position exits only when simulation=%s (#228)', async simulation => {
    mocks.simulation = simulation;
    const unsigned = { ...owner, signed: false };
    mocks.place.mockResolvedValue({ status: { status: 'Submitted', deal_quantity: 0 } });
    await mount({ ...position, account: unsigned }); await click('平');
    if (simulation === true) {
        expect(mocks.place.mock.calls[0]![4]).toEqual({ account: unsigned, ocType: 'Cover' });
        expect(unsigned.signed).toBe(false);
    } else expect(mocks.place).not.toHaveBeenCalled();
});
it('does not infer an unknown owner from the selected account', async () => {
    await mount({ ...position, account: undefined }); await click('平');
    expect(mocks.place).not.toHaveBeenCalled();
    // 送出前就拒絕：照實說未送出，不觸發結果未知的對帳
    expect(operationNotice(mocks.notify, '平倉未成立（未送出）').body).toContain('帳戶歸屬不明');
    await vi.dynamicImportSettled();
    expect(reconcileOrdersOnce).not.toHaveBeenCalled();
});
it.each(['Submitted', 'PartFilled', 'timeout'])('submits exactly one owner-scoped Auto reverse order for %s', async status => {
    if (status === 'timeout') mocks.place.mockRejectedValueOnce(new Error('timeout'));
    else mocks.place.mockResolvedValueOnce({ status: { status, deal_quantity: 1 } });
    await mount(position); await click('反');
    expect(mocks.place).toHaveBeenCalledTimes(1);
    expect(mocks.place.mock.calls[0]!.slice(1)).toEqual(['Sell', null, 6, { account: owner, ocType: 'Auto' }]);
    if (status === 'timeout') expect(operationNotice(mocks.notify, '反手未完整確認').title).toBe('反手未完整確認');
});
it('does not send a second reverse order even when the HTTP response is Filled', async () => {
    mocks.place.mockResolvedValueOnce({ status: { status: 'Filled', deal_quantity: 6 } });
    await mount(position); await click('反');
    expect(mocks.place.mock.calls.map(call => call.slice(1))).toEqual([
        ['Sell', null, 6, { account: owner, ocType: 'Auto' }],
    ]);
});
it('keeps stock shares and explicit owner in the split-exit helper', async () => {
    const stock = { ...owner, account_type: 'S' };
    mocks.stock.mockResolvedValue([]);
    await mount({ ...position, code: '2330', account: stock, quantity: 1500, yd_quantity: 1500, cond: 'Cash' }); await click('平');
    expect(mocks.stock.mock.calls[0]!.slice(1)).toEqual(['Sell', 1500, stock]);
    await click('反');
    expect(mocks.stock).toHaveBeenCalledTimes(1);
    expect(mocks.place).not.toHaveBeenCalled();
});
// 融券平倉（實盤 bug 3）：合成資料，與真實委託無關
const stockOwner: Account = { ...owner, account_type: 'S' };
const shortRow: AccountedPosition = { account: stockOwner, code: '2330', id: 7, direction: 'Sell', quantity: 2000, price: 380.5, last_price: 392, pnl: -23000, yd_quantity: 2000, cond: 'ShortSelling' };
it('covers a 2,000-share short as ONE whole-lot Buy with ShortSelling (no odd leg, never 現股)', async () => {
    mocks.stock.mockResolvedValue([]);
    await mount(shortRow); await click('平');
    expect(mocks.stock).toHaveBeenCalledTimes(1);
    expect(mocks.stock.mock.calls[0]!.slice(1)).toEqual(['Buy', 2000, stockOwner, { orderCond: 'ShortSelling' }]);
    expect(mocks.place).not.toHaveBeenCalled();
    expect(operationNotice(mocks.notify, '⏹ 平倉單已送出').body).toContain('融券市價買');
});
it('closes a margin long with Sell + MarginTrading', async () => {
    mocks.stock.mockResolvedValue([]);
    await mount({ ...shortRow, direction: 'Buy', quantity: 3000, yd_quantity: 3000, cond: 'MarginTrading', pnl: 0 }); await click('平');
    expect(mocks.stock.mock.calls[0]!.slice(1)).toEqual(['Sell', 3000, stockOwner, { orderCond: 'MarginTrading' }]);
    expect(operationNotice(mocks.notify, '⏹ 平倉單已送出').body).toContain('融資市價賣');
});
it.each([
    ['reverse of a credit row', shortRow, '反', '反手未成立（未送出）', '不支援一鍵反手'],
    ['odd shares of a short', { ...shortRow, quantity: 1500, yd_quantity: 1500 }, '平', '平倉未成立（未送出）', '整張'],
    ['short row marked Buy', { ...shortRow, direction: 'Buy' as const }, '平', '平倉未成立（未送出）', '方向與條件不符'],
    ['SBL short', { ...shortRow, cond: 'SBLShort' }, '平', '平倉未成立（未送出）', '借券'],
])('refuses %s before sending: not sent, no reconcile', async (_name, row, label, title, why) => {
    await mount(row); await click(label);
    expect(mocks.stock).not.toHaveBeenCalled();
    expect(mocks.place).not.toHaveBeenCalled();
    expect(operationNotice(mocks.notify, title).body).toContain(why);
    await vi.dynamicImportSettled();
    expect(reconcileOrdersOnce).not.toHaveBeenCalled();
});
it.each([
    ['a credit short', { ...shortRow, code: '9999' }],
    ['a cash long', { ...shortRow, code: '9999', direction: 'Buy' as const, quantity: 1000, yd_quantity: 1000, cond: 'Cash' }],
])('a contract read failure before sending %s is not sent and does not reconcile (review)', async (_name, row) => {
    await mount(row); await click('平');
    expect(mocks.stock).not.toHaveBeenCalled();
    expect(mocks.place).not.toHaveBeenCalled();
    expect(operationNotice(mocks.notify, '平倉未成立（未送出）').body).toBe('商品資料讀取失敗，未送出委託：contract fetch failed');
    await vi.dynamicImportSettled();
    expect(reconcileOrdersOnce).not.toHaveBeenCalled();
});
it('batch close counts pre-send refusals as not sent and does not reconcile for them', async () => {
    mocks.stock.mockResolvedValue([]);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    const cash: AccountedPosition = { ...shortRow, id: 8, direction: 'Buy', quantity: 1000, yd_quantity: 1000, cond: 'Cash' };
    const odd: AccountedPosition = { ...shortRow, id: 9, quantity: 1500, yd_quantity: 1500 };
    await act(async () => { view = create(createElement(PositionsPane, { positions: [cash, odd], initialStatus: 'ready', mode: 'merged', market: 'all', scopeKey: '', fallback: { stock: null, futures: selected }, onChanged: vi.fn(), onSelectCode: vi.fn() })); });
    await act(async () => { view!.root.findAllByType(ArmLockButton)[0]!.props.onToggle(); });
    await act(async () => { view!.root.findAll(n => n.type === 'input' && n.props.title === '全選（批次平倉）')[0]!.props.onChange(); });
    await act(async () => { view!.root.findByType(ConfirmButton).props.onConfirm(); });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(mocks.stock.mock.calls.map(c => c.slice(1))).toEqual([['Sell', 1000, stockOwner]]);
    const body = operationNotice(mocks.notify, '批次平倉請核對委託').body;
    expect(body).toContain('已送出 1 筆 / 未成立 1 筆 / 未完整確認 0 筆');
    expect(body).not.toContain('勿直接重送');
    expect(reconcileOrdersOnce).not.toHaveBeenCalled();
});
it('group subtotal market value is Σ|shares × price| (short counts positive) and skips rows without a price', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    const cash: AccountedPosition = { ...shortRow, id: 8, code: '2603', direction: 'Buy', quantity: 2000, yd_quantity: 2000, cond: 'Cash', price: 200, last_price: 210, pnl: 20000 };
    const props = { initialStatus: 'ready' as const, mode: 'grouped' as const, market: 'all' as const, scopeKey: '', fallback: { stock: null, futures: selected }, onChanged: vi.fn(), onSelectCode: vi.fn() };
    await act(async () => { view = create(createElement(PositionsPane, { ...props, positions: [cash, shortRow] })); });
    // 420,000 + 784,000（融券不取負）
    expect(JSON.stringify(view!.toJSON())).toContain('1,204,000');
    await act(async () => { view!.update(createElement(PositionsPane, { ...props, positions: [shortRow] })); });
    expect(JSON.stringify(view!.toJSON())).toContain('784,000');
    expect(JSON.stringify(view!.toJSON())).not.toContain('-784,000');
    await act(async () => { view!.update(createElement(PositionsPane, { ...props, positions: [shortRow, { ...cash, last_price: NaN }] })); });
    const text = JSON.stringify(view!.toJSON());
    expect(text).toContain('784,000');
    expect(text).toContain('部分缺價未計');
    expect(text).not.toContain('NaN');
});
