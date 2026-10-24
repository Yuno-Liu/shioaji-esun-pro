// fork（D2-02／D2-03）：閃電下單的帳號選單只在主視窗「跟隨頂欄」時鎖定；已固定帳號的面板
// 可改回跟隨、popout 保留選單；面板標出實際路由；玉山環境在送出前改變就不送。
import '../test/mock-order-reconciliation';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../hooks/use-flash-ladder', () => ({ useFlashLadder: () => ({ marks: new Map(), protectedQty: 0, background: false }) }));
vi.mock('../lib/flash-conditional', () => ({ flashStopProtections: async () => ({ stopped: 0, blocked: [], failed: [], restore: [] }) }));
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ place: vi.fn(), notify: vi.fn() }));
const accounts: Account[] = [
    { account_type: 'S', broker_id: '8840', account_id: '0000001', signed: true, person_id: '', username: '' },
    { account_type: 'S', broker_id: '9A95', account_id: '1234567', signed: true, person_id: '', username: '' },
] as Account[];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: null, selectedAccount: accounts[0] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place, placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';
import { esunTradeService } from '../lib/esun';
import { HEADER_LOCK_TITLE } from '../lib/order-route';

const contract = { code: '2330', security_type: 'STK', exchange: 'TSE', reference: 100 } as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const select = () => view.root.findAllByType('select').find(s => s.props['aria-label'] === '閃電下單帳戶')!;
const button = (label: string) => view.root.findAllByType('button').find(b => text(b).includes(label))!;
const stubWindow = (search: string) => vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { search } });

let env: 'SIMULATION' | 'PRODUCTION' = 'SIMULATION';
beforeEach(() => {
    vi.clearAllMocks();
    env = 'SIMULATION';
    // useSyncExternalStore needs a stable snapshot per environment
    const snaps = { SIMULATION: { ...esunTradeService.getSnapshot(), environment: 'SIMULATION', isSimulation: true }, PRODUCTION: { ...esunTradeService.getSnapshot(), environment: 'PRODUCTION', isSimulation: false } };
    vi.spyOn(esunTradeService, 'getSnapshot').mockImplementation(() => snaps[env] as never);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    stubWindow('');
    mocks.place.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('main window: a following panel is locked to the header and shows the actual route', async () => {
    await act(async () => { view = create(createElement(FlashOrder, { contract, trades: [], positions: [] })); });
    expect(select().props.disabled).toBe(true);
    expect(select().props.title).toContain(HEADER_LOCK_TITLE);
    const route = view.root.find(n => n.props['data-testid'] === 'order-route');
    expect(text(route)).toBe('玉山·模擬');
});

it('a pinned (legacy / imported) panel keeps the picker and can go back to following', async () => {
    const onAccountKeysChange = vi.fn();
    await act(async () => { view = create(createElement(FlashOrder, { contract, trades: [], positions: [], accountKeys: { S: 'S:9A95:1234567' }, onAccountKeysChange })); });
    expect(select().props.disabled).toBe(false);
    // the pinned SinoPac account differs from the header (E.SUN): flagged on the badge
    expect(text(view.root.find(n => n.props['data-testid'] === 'order-route'))).toContain('≠頂欄');
    const follow = view.root.findAllByType('option').find(o => text(o).startsWith('跟隨主畫面'))!;
    await act(async () => { select().props.onChange({ target: { value: follow.props.value } }); });
    expect(onAccountKeysChange).toHaveBeenLastCalledWith({});
});

it('popout: the picker stays available (no header to follow)', async () => {
    stubWindow('?popout=flash&win=w1');
    await act(async () => { view = create(createElement(FlashOrder, { contract, trades: [], positions: [], followMain: false, accountKeys: { S: 'S:8840:0000001' }, onAccountKeysChange: vi.fn() })); });
    expect(select().props.disabled).toBe(false);
    expect(select().props.title).not.toContain(HEADER_LOCK_TITLE);
});

it('an E.SUN environment switch after the click fails the account guard and adds the route to the confirmation', async () => {
    await act(async () => { view = create(createElement(FlashOrder, { contract, trades: [], positions: [] })); });
    await act(async () => { button('啟用閃電下單').props.onClick(); });
    await act(async () => { await button('市價買').props.onClick(); });
    const opts = mocks.place.mock.calls[0]![4];
    expect(opts).toMatchObject({ account: accounts[0], confirmNote: '送往 玉山 模擬環境' });
    expect(opts.isAccountCurrent()).toBe(true);
    env = 'PRODUCTION';
    expect(opts.isAccountCurrent()).toBe(false);
});
