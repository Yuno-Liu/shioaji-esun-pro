// 委託頁的商品名稱（名稱為主、代碼為次）：委託列、成交分頁、委託明細面板（標題與標頭）、委託操作面板摘要（OrderLines）、
// 批次刪單清單；名稱來源三種情況（資料帶名稱、需查合約快取、查詢失敗只顯示代碼）、合約查詢次數＝不重複代碼數、
// aria-label 含名稱與代碼；S1：列上 Chip 只呼叫 openOrderAction，lib 送單／改單／刪單 0 次。以 vi.mock 隔離 src/lib，不打任何 API。
import { createElement, Fragment, useSyncExternalStore } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    state: null as unknown,
    cache: new Map<string, { code: string; name: string }>(),
    listeners: new Set<() => void>(),
    names: {} as Record<string, string>,
}));
const m = vi.hoisted(() => ({
    ensure: vi.fn(),
    reconcile: vi.fn(async () => undefined),
    notify: vi.fn(),
    assertLive: vi.fn(),
    cancelAll: vi.fn(),
    cancelOrder: vi.fn(),
    cancelOrders: vi.fn(),
    updatePrice: vi.fn(),
    updateQty: vi.fn(),
    placeOrder: vi.fn(),
}));

vi.mock('../../lib/trading-state', () => ({
    useTradingState: () => h.state,
    reconcileOrdersOnce: m.reconcile,
    RECONCILE_REASON_LABELS: {},
}));
vi.mock('../../lib/trade', () => ({ notify: m.notify, assertTradingLive: m.assertLive, cancelAllOrders: m.cancelAll, placeOrder: m.placeOrder }));
vi.mock('../../lib/shioaji', () => ({ cancelOrder: m.cancelOrder, cancelOrders: m.cancelOrders, updateOrderPrice: m.updatePrice, updateOrderQty: m.updateQty }));
vi.mock('../../lib/trade-mutations', () => ({
    cancellationSummary: () => ({ kind: 'ok', body: 'ok' }),
    cancellationOutcome: () => 'confirmed',
    maskIdentifiers: (s: string) => s,
}));
vi.mock('../../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../../lib/contracts-cache', () => ({
    useContract: (code: string | null) => useSyncExternalStore(
        (l: () => void) => { h.listeners.add(l); return () => { h.listeners.delete(l); }; },
        () => (code ? h.cache.get(code) : undefined),
    ),
    ensureContract: (code: string, type?: string) => m.ensure(code, type),
}));
vi.mock('../../lib/esun/account-details', () => ({ useEsunOrderMeta: () => null }));
vi.mock('../../lib/privacy', () => ({
    usePrivacyMode: () => false,
    usePrivacyMoney: () => false,
    maskMoney: (text: string) => text,
}));
vi.mock('../../lib/tick-bands', () => ({ bandTickFor: () => undefined, prefetchTickBands: () => undefined }));
vi.mock('../components/route-badge', () => ({
    useOrderRoute: () => ({ esun: false, broker: '永豐', simulation: true }),
    routeBadgeText: () => '送往 永豐 模擬',
}));
vi.mock('../components/account-switch-sheet', () => ({ mobileAccountLabel: (a: { broker_id: string }) => `${a.broker_id}-***` }));

import type { AccountedTrade } from '../../lib/types/order';
import { OrderActionSheet } from '../components/order-action-sheet';
import { resetContractNamesForTest } from '../lib/contract-names';
import { getMobileUi, resetMobileUiForTest } from '../lib/mobile-store';
import { setResumeGateForTest } from '../lib/resume-gate-runtime';
import { OrdersPage, resetOrdersRefreshCooldownForTest } from './orders-page';

const account = { account_type: 'S', broker_id: '9A95', account_id: '0123456', signed: true, person_id: '', username: '' };

type Over = { order?: Record<string, unknown>; status?: Record<string, unknown>; contract?: Record<string, unknown> };
function trade(id: string, over: Over = {}): AccountedTrade {
    return {
        account,
        contract: { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null, ...over.contract },
        order: {
            id, seqno: `S${id}`, ordno: `A${id}`, action: 'Buy', price: 1080, quantity: 5,
            price_type: 'LMT', order_type: 'ROD', order_lot: 'Common', account, ...over.order,
        },
        status: {
            id, status: 'Submitted', status_code: '', order_quantity: 5, deal_quantity: 0, cancel_quantity: 0,
            modified_price: 0, msg: '', deals: [], order_ts: 1_700_000_000, ...over.status,
        },
    } as unknown as AccountedTrade;
}

function setTrades(trades: AccountedTrade[]) {
    h.state = {
        trades,
        queries: { orders: { updatedAt: 1, needsReconcile: false, error: null, reasons: [] } },
    };
}

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const byTestId = (id: string, within?: ReactTestInstance) => (within ?? view!.root).findAll(n => n.props?.['data-testid'] === id && typeof n.type === 'string');
const row = (id: string) => byTestId('order-row').find(r => r.props['data-trade-id'] === id)!;
const instrumentOf = (node: ReactTestInstance) => text(byTestId('order-instrument', node)[0]!);

async function render() {
    await act(async () => {
        view = create(createElement(Fragment, null, createElement(OrdersPage), createElement(OrderActionSheet)));
    });
}
async function press(node: ReactTestInstance) {
    await act(async () => { node.props.onClick(); });
}
/** 讓 ensureContract 的結果進入快取並重繪 */
async function flush() {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    resetContractNamesForTest();
    resetMobileUiForTest();
    resetOrdersRefreshCooldownForTest();
    setResumeGateForTest(null);
    h.cache.clear();
    h.listeners.clear();
    h.names = { '2317': '鴻海', TXFL6: '臺股期貨12' };
    m.ensure.mockImplementation(async (code: string) => {
        const name = h.names[code];
        if (!name) throw new Error('not found');
        const info = { code, name };
        h.cache.set(code, info);
        h.listeners.forEach(l => l());
        return info;
    });
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

function expectNoLibMutations() {
    for (const fn of [m.cancelAll, m.cancelOrder, m.cancelOrders, m.updatePrice, m.updateQty, m.placeOrder]) expect(fn).not.toHaveBeenCalled();
}

describe('委託頁 商品名稱', () => {
    it('shows the name first and the code second from the trade, the contract cache, or the code alone on failure', async () => {
        setTrades([
            trade('o1', { contract: { name: '台積電' } }), // 資料本身帶名稱
            trade('o2', { contract: { code: '2317' } }), // 需查合約快取
            trade('o3', { contract: { code: '9999' } }), // 查詢失敗
            trade('o4', { contract: { code: 'TXFL6', security_type: 'FUT', exchange: 'TAIFEX' }, order: { price: 22800, quantity: 2 }, status: { order_quantity: 2 } }),
        ]);
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const impl = m.ensure.getMockImplementation()!;
        m.ensure.mockImplementation(async (code: string, type?: string) => { await gate; return impl(code, type); });
        await render();
        // 名稱載入前只顯示代碼
        expect(instrumentOf(row('o2'))).toBe('2317');
        expect(byTestId('order-instrument', row('o2'))[0]!.findAllByType('span')).toHaveLength(2); // 外層＋代碼（沒有第二個代碼欄）
        await act(async () => { release(); await gate; });
        await flush();
        expect(instrumentOf(row('o1'))).toBe('台積電2330');
        expect(instrumentOf(row('o2'))).toBe('鴻海2317');
        expect(instrumentOf(row('o3'))).toBe('9999');
        expect(instrumentOf(row('o4'))).toBe('臺股期貨12TXFL6');
        // 名稱為主（第一個 span）、代碼為次
        const parts = byTestId('order-instrument', row('o2'))[0]!.findAllByType('span').slice(1).map(text);
        expect(parts).toEqual(['鴻海', '2317']);
        // 期貨查詢帶合約類別；每個不重複代碼一次
        expect(m.ensure).toHaveBeenCalledWith('TXFL6', 'FUT');
        expect(m.ensure).toHaveBeenCalledTimes(3);
    });

    it('queries the contract cache once per distinct code across rows, deals and sheets', async () => {
        setTrades([
            trade('o1', { contract: { code: '2317' } }),
            trade('o2', { contract: { code: '2317' } }),
            trade('o3', { contract: { code: '2317' }, status: { status: 'Filled', deal_quantity: 5, deals: [{ seq: '1', price: 100, quantity: 5, ts: 1_700_000_100 }] } }),
            trade('o4', { contract: { code: '1101' } }),
            trade('o5', { contract: { code: '1101' } }),
        ]);
        await render();
        await flush();
        await press(byTestId('orders-tab-deals')[0]!);
        await flush();
        await press(byTestId('orders-tab-all')[0]!);
        await flush();
        expect(m.ensure).toHaveBeenCalledTimes(2);
        expect(m.ensure.mock.calls.map(c => c[0]).sort()).toEqual(['1101', '2317']);
    });

    it('deal rows, the detail sheet title and header use name + code', async () => {
        setTrades([trade('o1', { contract: { code: '2317' }, status: { status: 'Filled', deal_quantity: 5, deals: [{ seq: '1', price: 100, quantity: 5, ts: 1_700_000_100 }] } })]);
        await render();
        await press(byTestId('orders-tab-deals')[0]!);
        await flush();
        const deal = byTestId('deal-row')[0]!;
        expect(text(byTestId('deal-instrument', deal)[0]!)).toBe('鴻海2317');
        await press(deal.findAllByType('button')[0]!);
        expect(text(byTestId('detail-instrument')[0]!)).toBe('鴻海2317');
        const sheet = view!.root.findAll(n => n.props?.testId === 'order-detail-sheet')[0]!;
        expect(sheet.props.title).toBe('委託明細 鴻海 2317');
    });

    it('row aria-labels carry the name and the code; the action sheet summary shows the name; chips only open the sheet (S1)', async () => {
        setTrades([trade('o1', { contract: { code: '2317' } })]);
        await render();
        await flush();
        const actions = row('o1').findAll(n => n.props?.role === 'group')[0]!;
        expect(actions.props['aria-label']).toBe('鴻海 2317 買 委託操作');
        await press(byTestId('order-cancel-button', row('o1')).find(n => n.type === 'button')!);
        expect(getMobileUi().orderAction).toMatchObject({ tradeId: 'o1', kind: 'cancel' });
        const summary = byTestId('order-action-summary')[0]!;
        expect(instrumentOf(summary)).toBe('鴻海2317');
        // 委託操作面板的標題（對話框名稱）同委託明細：名稱＋代碼
        const actionSheet = view!.root.findAll(n => n.props?.testId === 'order-action-sheet')[0]!;
        expect(actionSheet.props.title).toBe('委託操作 鴻海 2317');
        expectNoLibMutations();

        await press(byTestId('orders-select')[0]!);
        const box = byTestId('order-select')[0]!;
        expect(box.props['aria-label']).toBe('選取 鴻海 2317 買');
        expectNoLibMutations();
    });

    it('the action sheet title falls back to the code alone until (or unless) the name is known', async () => {
        setTrades([trade('o1', { contract: { code: '9999' } })]);
        await render();
        await flush();
        await press(byTestId('order-cancel-button', row('o1')).find(n => n.type === 'button')!);
        const actionSheet = view!.root.findAll(n => n.props?.testId === 'order-action-sheet')[0]!;
        expect(actionSheet.props.title).toBe('委託操作 9999');
        expectNoLibMutations();
    });

    it('the batch-cancel list shows name + code before confirming and sends nothing', async () => {
        setTrades([trade('o1', { contract: { code: '2317' } }), trade('o2', { contract: { code: '9999' } })]);
        await render();
        await flush();
        await press(byTestId('orders-select')[0]!);
        await press(byTestId('orders-select-all')[0]!);
        await press(byTestId('orders-cancel-selected')[0]!);
        const names = byTestId('trade-name', byTestId('batch-cancel-targets')[0]!).map(text).sort();
        expect(names).toEqual(['9999', '鴻海 2317']);
        expectNoLibMutations();
    });
});
