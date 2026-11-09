// useEsunLimitEstimate：跨台北午夜後，下一次重繪就以新的「今日」重算（不沿用前一日的估算）。
// 只讀共用交易狀態與額度快取，不打任何 API。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TradingLimits } from '../../lib/shioaji';
import type { AccountedTrade } from '../../lib/types/order';
import type { Account } from '../../lib/types/portfolio';
import type { EsunLimitEstimate } from '../lib/esun-limit-estimate';

const m = vi.hoisted(() => ({ trades: [] as unknown[] }));

vi.mock('../../lib/trading-state', () => ({
    useTradingState: () => ({ trades: m.trades, queries: { orders: { updatedAt: 1, needsReconcile: false } } }),
}));
vi.mock('../../lib/contracts-cache', () => ({ getCachedContract: () => undefined }));

import { useEsunLimitEstimate } from './use-esun-limit-estimate';

const esun = { account_type: 'S', broker_id: '8840', account_id: '0099887', person_id: 'A', signed: true, username: '' } as Account;
const limits = { trading_limit: 1_000_000, trading_used: 0, trading_available: 1_000_000, margin_limit: 0, margin_used: 0, margin_available: 0, short_limit: 0, short_used: 0, short_available: 0 } as TradingLimits;
// 2026-11-09 23:59 台北下的 1 張 @30 買單（未成交）
const ORDER_TS = Date.UTC(2026, 10, 9, 15, 59, 0) / 1000;

const buy: AccountedTrade = {
    account: esun,
    contract: { code: '2884', security_type: 'STK', exchange: 'TSE', target_code: null },
    order: { id: 'B1', seqno: 'B1', ordno: 'B1', action: 'Buy', price: 30, quantity: 1, price_type: 'LMT', order_lot: 'Common', account: { broker_id: '8840', account_id: '0099887', account_type: 'S' } },
    status: { id: 'B1', status: 'Submitted', status_code: '', order_ts: ORDER_TS, order_quantity: 1, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, msg: '', deals: [] },
} as unknown as AccountedTrade;

let view: ReactTestRenderer | undefined;
let latest: EsunLimitEstimate | null = null;
function Probe() {
    latest = useEsunLimitEstimate(esun, limits);
    return null;
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date'] });
    m.trades = [buy];
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('recomputes "today" on the next render after Taipei midnight (yesterday\'s orders no longer count)', async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 9, 15, 59, 30)); // 2026-11-09 23:59:30 台北
    await act(async () => { view = create(createElement(Probe)); });
    expect(latest).toMatchObject({ pending: 30_000, remaining: 970_000 });

    vi.setSystemTime(Date.UTC(2026, 10, 9, 16, 0, 5)); // 2026-11-10 00:00:05 台北；委託與額度都沒變
    await act(async () => { view!.update(createElement(Probe)); });
    expect(latest).toMatchObject({ pending: 0, remaining: 1_000_000, buyOrders: 0 });
});
