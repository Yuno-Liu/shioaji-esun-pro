// fork（D2-02／D2-03／D2-08／D2-12）：下單票的帳號選單只在主視窗鎖定；畫面顯示的
// 路由與送單當下的實際路由不同就不送；分倉的玉山那一腿送出前先用玉山規則驗證。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';

const m = vi.hoisted(() => ({ stockSel: 'E', confirm: vi.fn(), stock: vi.fn(), select: vi.fn() }));
const h = vi.hoisted(() => ({
    accounts: [
        { account_type: 'S', broker_id: '8840', account_id: '0000001', signed: true, person_id: '', username: '' },
        { account_type: 'S', broker_id: '9A95', account_id: '1234567', signed: true, person_id: '', username: '' },
    ],
}));
vi.mock('../lib/account-store', () => {
    const state = () => ({
        accounts: h.accounts,
        selectedStock: h.accounts[m.stockSel === 'E' ? 0 : 1],
        selectedFutures: null,
        selectedAccount: h.accounts[m.stockSel === 'E' ? 0 : 1],
        loaded: true,
    });
    return { useAccounts: state, getAccountState: state, selectAccount: m.select };
});
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: Account) => `${a.broker_id}-${a.account_id}` }));
vi.mock('../lib/risk', () => ({ checkOrderAllowed: () => null, getRiskSettings: () => ({ confirmManualOrders: true }) }));
vi.mock('../lib/shioaji', () => ({ fetchInfo: () => new Promise(() => undefined), placeFuturesOrder: vi.fn(), placeStockOrder: m.stock }));
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));
vi.mock('../lib/bracket', () => ({ ensureBracketHost: vi.fn(), registerBracket: vi.fn(), registrationFailureText: String, validateBracketRequest: () => null }));
vi.mock('./bracket-status', () => ({ BracketStatusList: () => null }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'sim' }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => ({ tick: { close: '100' } }), useTradingLive: () => true }));
vi.mock('../lib/price-sync', () => ({ usePickedPrice: () => null }));
vi.mock('../lib/allocation', () => ({ allocateByRatio: (t: number, w: number[]) => w.map(() => t), loadAllocPresets: () => [], saveAllocPreset: () => [], deleteAllocPreset: () => [] }));
import { OrderTicket } from './order-ticket';
import { HEADER_LOCK_TITLE, ROUTE_CHANGED_MESSAGE } from '../lib/order-route';
import { forgetServerInfo } from '../lib/server-info-store';

const contract = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', reference: 100, day_trade: 'Yes' } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const buttons = () => view.root.findAllByType('button');
const button = (label: string | RegExp) => buttons().find(b => typeof label === 'string' ? text(b).includes(label) : label.test(text(b)))!;
const chip = () => buttons().find(b => /\[證\]/.test(text(b)))!;
const feedback = () => view.root.findAll(n => n.type === 'span').map(text).join('|');

const stubWindow = (search: string) => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { search } });
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubWindow('');
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    m.stockSel = 'E';
    forgetServerInfo('');
    m.confirm.mockResolvedValue(true);
    m.stock.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

const mount = async () => { await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); }); };

it('main window: the chip shows the routed broker/environment and does not open an account menu', async () => {
    await mount();
    expect(chip().props.onClick).toBeUndefined();
    expect(chip().props.title).toContain(HEADER_LOCK_TITLE);
    const route = view.root.find(n => n.props['data-testid'] === 'order-route');
    expect(text(route)).toBe('玉山·模擬');
});

it('popout (no header): the upstream chip menu is back and switches the selection', async () => {
    stubWindow('?popout=ticket&code=2330');
    await mount();
    expect(chip().props.title).not.toContain(HEADER_LOCK_TITLE);
    await act(async () => { chip().props.onClick(); });
    const item = buttons().find(b => text(b).includes('9A95-'))!;
    await act(async () => { item.props.onClick(); });
    expect(m.select).toHaveBeenCalledWith(h.accounts[1]);
});

it('shows the route in the confirmation and sends to the displayed account', async () => {
    await mount();
    await act(async () => { await button('買進下單').props.onClick(); });
    await act(async () => { await button('確認買進').props.onClick(); });
    expect(m.confirm.mock.calls[0]![0].note).toContain('送往 玉山 模擬環境');
    expect(m.stock).toHaveBeenCalledTimes(1);
    expect(m.stock.mock.calls[0]![2]).toBe(h.accounts[0]);
});

it('does not send when the routed account differs from the one on screen (stale render)', async () => {
    await mount();
    await act(async () => { await button('買進下單').props.onClick(); });
    // the slot moves (e.g. header switched) but this ticket has not re-rendered yet
    m.stockSel = 'S';
    await act(async () => { await button('確認買進').props.onClick(); });
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.stock).not.toHaveBeenCalled();
    expect(feedback()).toContain(ROUTE_CHANGED_MESSAGE);
});

it('split: an E.SUN-unsupported leg (借券) is rejected before confirmation, so no leg is sent', async () => {
    await mount();
    await act(async () => { button('賣出 Sell').props.onClick(); });
    await act(async () => { button(/^借券$/).props.onClick(); });
    await act(async () => { button('多帳戶分倉').props.onClick(); });
    await act(async () => { await button('分倉賣出').props.onClick(); });
    await act(async () => { await button('確認分倉').props.onClick(); });
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.stock).not.toHaveBeenCalled();
    expect(feedback()).toContain('玉山證券 API 不支援借券賣出委託');
});
