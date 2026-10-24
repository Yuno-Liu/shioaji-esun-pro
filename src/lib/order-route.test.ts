// fork：多券商面板的路由閘門（D2-02／D2-03／D2-08／D2-13）
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { ContractBase } from './types/contract';

const m = vi.hoisted(() => ({ state: { accounts: [] as unknown[], selectedStock: null as unknown, selectedFutures: null as unknown } }));
vi.mock('./account-store', () => ({ getAccountState: () => m.state }));

import { esunTradeService } from './esun';
import {
    captureDisplayedRoute, captureRouteEnv, esunEnvKey, esunStockLegProblem, headerAccountLocked, headerAccountOf,
    orderRouteOf, ROUTE_CHANGED_MESSAGE, routeConfirmNote,
} from './order-route';
import { beginServerInfoRequest, forgetServerInfo, observeServerInfo } from './server-info-store';

const acct = (broker_id: string, account_id: string, account_type: 'S' | 'F' = 'S'): Account =>
    ({ broker_id, account_id, account_type, signed: true, person_id: '', username: '' }) as Account;
const esun = acct('8840', '0000001');
const sino = acct('9A95', '1234567');
const fut = acct('F002000', '7654321', 'F');
const stock = { code: '2330', security_type: 'STK', exchange: 'TSE' } as unknown as ContractBase;

let env: 'SIMULATION' | 'PRODUCTION' = 'SIMULATION';
beforeEach(() => {
    env = 'SIMULATION';
    vi.spyOn(esunTradeService, 'getSnapshot').mockImplementation(() => ({ environment: env }) as never);
    m.state = { accounts: [esun, sino, fut], selectedStock: esun, selectedFutures: fut };
    forgetServerInfo('');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('locks the account picker only for following panels in the main window (popouts keep it)', () => {
    vi.stubGlobal('window', { location: { search: '' } });
    expect(headerAccountLocked()).toBe(true);
    expect(headerAccountLocked(true)).toBe(true);
    // a pinned panel can change back to following
    expect(headerAccountLocked(false)).toBe(false);
    vi.stubGlobal('window', { location: { search: '?popout=ticket&code=2330' } });
    expect(headerAccountLocked()).toBe(false);
});

it('resolves the header account with the same priority as the header', () => {
    expect(headerAccountOf({ selectedAccount: sino, selectedStock: esun, selectedFutures: fut })).toBe(sino);
    expect(headerAccountOf({ selectedStock: esun, selectedFutures: fut })).toBe(esun);
    expect(headerAccountOf({ selectedFutures: fut })).toBe(fut);
});

it('routes E.SUN by its own environment and SinoPac by /info (unknown is not shown as simulation)', () => {
    expect(orderRouteOf(esun)).toEqual({ esun: true, broker: '玉山', simulation: true });
    env = 'PRODUCTION';
    expect(orderRouteOf(esun).simulation).toBe(false);
    expect(orderRouteOf(sino)).toEqual({ esun: false, broker: '永豐', simulation: undefined });
    expect(routeConfirmNote(sino)).toBe('送往 永豐 （環境未確認）');
    observeServerInfo(beginServerInfoRequest(), { simulation: false } as never);
    expect(routeConfirmNote(sino)).toBe('送往 永豐 正式環境');
    expect(routeConfirmNote(esun)).toBe('送往 玉山 正式環境');
});

it('an E.SUN environment switch between click and send stops the order', () => {
    const same = captureRouteEnv(esun);
    expect(same()).toBe(true);
    env = 'PRODUCTION';
    expect(same()).toBe(false);
    // SinoPac mode is guarded by captureServerMode upstream
    expect(captureRouteEnv(sino)()).toBe(true);
});

it('the ticket aborts when the displayed account is no longer the routed market slot', () => {
    expect(() => captureDisplayedRoute(esun, 'S')()).not.toThrow();
    // stale closure: the ticket still shows E.SUN, the slot already moved to SinoPac
    m.state = { ...m.state, selectedStock: sino };
    let err: unknown;
    try { captureDisplayedRoute(esun, 'S')(); } catch (e) { err = e; }
    expect((err as Error).message).toBe(ROUTE_CHANGED_MESSAGE);
    expect((err as { tradingGateRejected?: boolean }).tradingGateRejected).toBe(true);
    // nothing displayed / wrong market never passes
    expect(() => captureDisplayedRoute(null, 'S')()).toThrow(ROUTE_CHANGED_MESSAGE);
    expect(() => captureDisplayedRoute(fut, 'S')()).toThrow(ROUTE_CHANGED_MESSAGE);
});

it('the ticket aborts when the E.SUN environment changes after the click', () => {
    const check = captureDisplayedRoute(esun, 'S');
    env = 'PRODUCTION';
    expect(check).toThrow(ROUTE_CHANGED_MESSAGE);
});

it('validates only the E.SUN leg with the E.SUN rules', () => {
    const sbl = { action: 'Sell' as const, price: 100, quantity: 10, price_type: 'LMT', order_type: 'ROD' as const, order_lot: 'Common' as const, order_cond: 'SBLShort' as const };
    expect(esunStockLegProblem(esun, stock, sbl)).toBe('玉山：玉山證券 API 不支援借券賣出委託');
    expect(esunStockLegProblem(sino, stock, sbl)).toBeNull();
    expect(esunStockLegProblem(esun, stock, { ...sbl, order_cond: 'Cash', quantity: 600 })).toBe('玉山：整股委託數量必須在 1 至 499 張之間');
    expect(esunStockLegProblem(esun, stock, { ...sbl, order_cond: 'Cash' })).toBeNull();
    expect(esunStockLegProblem(null, stock, sbl)).toBeNull();
});

it('adds the E.SUN environment to query keys only when an E.SUN account is queried', () => {
    expect(esunEnvKey([sino, fut], 'PRODUCTION')).toBe('');
    expect(esunEnvKey([sino, esun], 'PRODUCTION')).toBe(':PRODUCTION');
    expect(esunEnvKey([], 'SIMULATION')).toBe('');
});
