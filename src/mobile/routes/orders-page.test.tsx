// 委託頁（規格 §6.5、§7.3、§14.1）：分頁分類（部分成交仍有剩餘留在未成交）、按鈕顯示規則（零股與玉山預約單不顯示改價）、
// 減量把「新的剩餘數量」換成減少量、刪單結果未確認顯示「勿自動重送」、全部刪單需滑動確認、更新鍵 6 秒冷卻、
// 改價在 ResumeGate 不允許時不呼叫 lib、刪單在 resyncing 時仍可執行。
// 以 vi.mock 隔離 src/lib，不打任何真實 API。
import { createElement, Fragment } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    state: null as unknown,
    live: true,
    meta: new Map<string, unknown>(),
    contracts: {} as Record<string, unknown>,
}));
const m = vi.hoisted(() => ({
    refresh: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    notify: vi.fn(),
    assertLive: vi.fn(),
    cancelAll: vi.fn(),
    cancelOrder: vi.fn(),
    updatePrice: vi.fn(),
    updateQty: vi.fn(),
}));

vi.mock('../../lib/trading-state', () => ({
    useTradingState: () => h.state,
    refreshTradingState: m.refresh,
    reconcileOrdersOnce: m.reconcile,
    RECONCILE_REASON_LABELS: { disconnect: '串流中斷', 'mutation-outcome': '改刪待確認', 'query-failed': '查詢失敗' },
}));
vi.mock('../../lib/trade', () => ({ notify: m.notify, assertTradingLive: m.assertLive, cancelAllOrders: m.cancelAll }));
vi.mock('../../lib/shioaji', () => ({ cancelOrder: m.cancelOrder, updateOrderPrice: m.updatePrice, updateOrderQty: m.updateQty }));
vi.mock('../../lib/trade-mutations', () => ({
    cancellationSummary: () => ({ kind: 'ok', body: '已確認取消 1 筆。' }),
}));
vi.mock('../../hooks/use-stream', () => ({ useTradingLive: () => h.live }));
vi.mock('../../lib/contracts-cache', () => ({
    useContract: (code: string | null) => (code ? h.contracts[code] : undefined),
    ensureContract: () => Promise.resolve(undefined),
}));
vi.mock('../../lib/esun/account-details', () => ({
    useEsunOrderMeta: (t: { order: { id: string } } | null) => (t ? h.meta.get(t.order.id) ?? null : null),
}));
vi.mock('../../lib/privacy', () => ({ usePrivacyMode: () => false }));
vi.mock('../../lib/tick-bands', () => ({ bandTickFor: () => undefined, prefetchTickBands: () => undefined }));
vi.mock('../components/route-badge', () => ({
    useOrderRoute: (a: { broker_id: string } | null) => (a ? { esun: a.broker_id.startsWith('884'), broker: a.broker_id.startsWith('884') ? '玉山' : '永豐', simulation: true } : null),
    routeBadgeText: (r: { broker: string } | null) => (r ? `送往 ${r.broker} 模擬` : '未選擇下單帳戶'),
}));
vi.mock('../components/account-switch-sheet', () => ({
    mobileAccountLabel: (a: { broker_id: string; account_id: string }) => `${a.broker_id}-***${a.account_id.slice(-2)}`,
}));

import type { AccountedTrade } from '../../lib/types/order';
import { OrderActionSheet } from '../components/order-action-sheet';
import { SlideToConfirm } from '../components/slide-to-confirm';
import { getMobileUi, resetMobileUiForTest } from '../lib/mobile-store';
import { setResumeGateForTest } from '../lib/resume-gate-runtime';
import { ORDERS_REFRESH_COOLDOWN_MS, OrdersPage, resetOrdersRefreshCooldownForTest } from './orders-page';

const sinopac = { account_type: 'S', broker_id: '9A95', account_id: '0123456', signed: true, person_id: '', username: '' };
const esun = { account_type: 'S', broker_id: '8840', account_id: '0099887', signed: true, person_id: '', username: '' };

type Over = { order?: Record<string, unknown>; status?: Record<string, unknown>; contract?: Record<string, unknown>; account?: typeof sinopac };
function trade(id: string, over: Over = {}): AccountedTrade {
    const account = over.account ?? sinopac;
    return {
        account,
        contract: { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null, ...over.contract },
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

function setState(trades: AccountedTrade[], orders: Partial<{ needsReconcile: boolean; reasons: string[]; updatedAt: number | null; error: string | null }> = {}) {
    h.state = {
        trades,
        positions: [],
        loading: false,
        updatedAt: 1,
        needsReconcile: !!orders.needsReconcile,
        error: null,
        queries: {
            orders: { updatedAt: 1, needsReconcile: false, error: null, reasons: [], ...orders },
            positions: { updatedAt: 1, needsReconcile: false, error: null, reasons: [] },
            account: { updatedAt: 1, needsReconcile: false, error: null, reasons: [] },
        },
    };
}

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const root = () => view!.root;
const byTestId = (id: string) => root().findAll(n => n.props?.['data-testid'] === id && typeof n.type === 'string');
const rows = () => byTestId('order-row');
const row = (id: string) => rows().find(r => r.props['data-trade-id'] === id);
const rowButton = (id: string, testId: string) => row(id)!.findAll(n => n.props?.['data-testid'] === testId && n.type === 'button')[0];
const slide = (testId: string) => root().findAll(n => n.type === SlideToConfirm && n.props?.testId === testId)[0];
const buttonsWithText = (label: string) => root().findAllByType('button').filter(b => text(b).includes(label));

async function render() {
    await act(async () => {
        view = create(createElement(Fragment, null, createElement(OrdersPage), createElement(OrderActionSheet)));
    });
}
async function rerender() {
    await act(async () => { view!.update(createElement(Fragment, null, createElement(OrdersPage), createElement(OrderActionSheet))); });
}
async function press(node: ReactTestInstance) {
    await act(async () => { node.props.onClick(); });
}
async function confirmSlide(testId: string) {
    await act(async () => { slide(testId)!.props.onConfirm(); });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    h.live = true;
    h.meta.clear();
    h.contracts = {};
    m.assertLive.mockImplementation(() => undefined);
    resetMobileUiForTest();
    resetOrdersRefreshCooldownForTest();
    setResumeGateForTest(null);
    setState([]);
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('OrdersPage — 分類與顯示', () => {
    it('keeps a partially filled order with remaining quantity in 未成交', async () => {
        setState([
            trade('o1', { status: { status: 'PartFilled', deal_quantity: 2 } }),
            trade('o2', { status: { status: 'Filled', deal_quantity: 5 } }),
            trade('o3', { status: { status: 'Cancelled', cancel_quantity: 5 } }),
            // ACTIVE 狀態但剩餘量 0（減量／成交累計已涵蓋）不算未成交
            trade('o4', { status: { status: 'PartFilled', deal_quantity: 3, cancel_quantity: 2 } }),
        ]);
        await render();
        expect(text(byTestId('orders-tab-working')[0]!)).toBe('未成交 1');
        expect(rows().map(r => r.props['data-trade-id'])).toEqual(['o1']);
        expect(text(row('o1')!.findAll(n => n.props?.['data-testid'] === 'order-fill')[0]!)).toContain('成交 2 · 剩餘 3');

        await press(byTestId('orders-tab-filled')[0]!);
        expect(rows().map(r => r.props['data-trade-id'])).toEqual(['o2']);
        expect(rowButton('o2', 'order-cancel-button')).toBeUndefined();

        await press(byTestId('orders-tab-all')[0]!);
        // 未成交置頂，其餘最新在前
        expect(rows().map(r => r.props['data-trade-id'])).toEqual(['o1', 'o4', 'o3', 'o2']);
    });

    it('shows side as text, price × qty with unit, route and order number; market orders show 市價', async () => {
        setState([
            trade('o1', { order: { action: 'Sell' }, status: { modified_price: 1085 } }),
            trade('o2', { order: { price_type: 'MKT', order_type: 'IOC', price: 0 } }),
        ]);
        await render();
        const r1 = row('o1')!;
        expect(text(r1.findAll(n => n.props?.['data-testid'] === 'order-side')[0]!)).toBe('賣');
        expect(text(r1.findAll(n => n.props?.['data-testid'] === 'order-price')[0]!)).toBe('1,085 × 5 張');
        expect(text(r1)).toContain('整股 · 限價 ROD');
        expect(text(r1.findAll(n => n.props?.['data-testid'] === 'order-route')[0]!)).toContain('送往 永豐 模擬');
        expect(text(r1)).toContain('書號 Ao1');
        expect(text(row('o2')!.findAll(n => n.props?.['data-testid'] === 'order-price')[0]!)).toBe('市價 × 5 張');
    });

    it('filters by a single account', async () => {
        setState([trade('o1'), trade('o2', { account: esun })]);
        await render();
        expect(rows()).toHaveLength(2);
        await act(async () => { byTestId('orders-account')[0]!.props.onChange({ target: { value: '8840-0099887' } }); });
        expect(rows().map(r => r.props['data-trade-id'])).toEqual(['o2']);
        expect(text(byTestId('orders-tab-working')[0]!)).toBe('未成交 1');
    });

    it('does not offer 改價 for odd lots or E.SUN reservations (reservation also hides 減量); 刪單 always shown', async () => {
        h.meta.set('o3', { reservation: true, pendingReservation: true, workDate: '2026-11-06', orderDate: '', orderTime: '', cancellable: false });
        setState([
            trade('o1'),
            trade('o2', { order: { order_lot: 'IntradayOdd', quantity: 300 }, status: { order_quantity: 300 } }),
            trade('o3', { account: esun }),
            trade('o4', { account: esun, status: { status: 'PreSubmitted' } }), // 沒有中繼資料：PreSubmitted 視為預約單
        ]);
        await render();
        expect(rowButton('o1', 'order-price-button')).toBeDefined();
        expect(rowButton('o1', 'order-qty-button')).toBeDefined();

        expect(rowButton('o2', 'order-price-button')).toBeUndefined();
        expect(rowButton('o2', 'order-qty-button')).toBeDefined();
        expect(text(row('o2')!.findAll(n => n.props?.['data-testid'] === 'order-price')[0]!)).toContain('× 300 股');

        for (const id of ['o3', 'o4']) {
            expect(rowButton(id, 'order-price-button')).toBeUndefined();
            expect(rowButton(id, 'order-qty-button')).toBeUndefined();
            expect(rowButton(id, 'order-cancel-button')).toBeDefined();
        }
        expect(text(row('o3')!.findAll(n => n.props?.['data-testid'] === 'order-reservation')[0]!)).toBe('預約 11/06');
    });

    it('hides 減量 when the remaining quantity is below 2', async () => {
        setState([trade('o1', { status: { status: 'PartFilled', deal_quantity: 4 } })]);
        await render();
        expect(rowButton('o1', 'order-qty-button')).toBeUndefined();
        expect(rowButton('o1', 'order-price-button')).toBeDefined();
    });
});

describe('OrdersPage — 委託操作', () => {
    it('減量 converts the entered new remaining quantity into a reduction amount', async () => {
        m.updateQty.mockResolvedValue({});
        setState([trade('o1', { status: { status: 'PartFilled', deal_quantity: 1 } })]); // 剩餘 4
        await render();
        await press(rowButton('o1', 'order-qty-button')!);
        expect(getMobileUi().orderAction).toMatchObject({ tradeId: 'o1', kind: 'qty' });
        expect(slide('order-action-slide')).toBeDefined();
        // 滑動前不呼叫 lib
        expect(m.updateQty).not.toHaveBeenCalled();

        await act(async () => { byTestId('order-action-qty')[0]!.props.onChange({ target: { value: '4' } }); });
        expect(slide('order-action-slide')!.props.disabled).toBe(true); // n 必須 < 剩餘
        await act(async () => { byTestId('order-action-qty')[0]!.props.onChange({ target: { value: '1' } }); });
        expect(slide('order-action-slide')!.props.disabled).toBe(false);
        expect(slide('order-action-slide')!.props.label).toContain('減量 3 張');

        await confirmSlide('order-action-slide');
        expect(m.updateQty).toHaveBeenCalledTimes(1);
        expect(m.updateQty).toHaveBeenCalledWith('o1', 3);
        expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok' }));
        expect(getMobileUi().orderAction).toBeNull();
    });

    it('刪單 whose result is unconfirmed shows 勿自動重送, closes the sheet and offers no resend', async () => {
        m.cancelOrder.mockRejectedValue(Object.assign(
            new Error('刪單已送出但未確認取消（無法回讀委託）；請手動更新委託核對，勿重送'),
            { code: 'CANCEL_UNCONFIRMED', mutationOutcomeUnknown: true },
        ));
        setState([trade('o1')]);
        await render();
        await press(rowButton('o1', 'order-cancel-button')!);
        expect(m.cancelOrder).not.toHaveBeenCalled();
        await confirmSlide('order-action-slide');
        expect(m.cancelOrder).toHaveBeenCalledTimes(1);
        expect(m.cancelOrder).toHaveBeenCalledWith('o1');
        const notice = m.notify.mock.calls.at(-1)![0];
        expect(notice.kind).toBe('err');
        expect(notice.title).toBe('刪單失敗或結果未知');
        expect(notice.body).toContain('勿自動重送');
        expect(getMobileUi().orderAction).toBeNull();
        expect(buttonsWithText('重送')).toHaveLength(0);
        // 不自動重送
        await act(async () => { await Promise.resolve(); });
        expect(m.cancelOrder).toHaveBeenCalledTimes(1);
    });

    it('改價 does not call updateOrderPrice while ResumeGate does not allow it', async () => {
        setState([trade('o1')]);
        setResumeGateForTest({ state: 'resyncing' });
        await render();
        await press(rowButton('o1', 'order-price-button')!);
        await act(async () => { byTestId('order-action-price')[0]!.props.onChange({ target: { value: '1085' } }); });
        expect(slide('order-action-slide')!.props.disabled).toBe(true);
        expect(slide('order-action-slide')!.props.disabledReason).toContain('重新同步');
        // 即使繞過停用（例如滑動途中狀態改變），送出前的同步檢查仍擋下
        await confirmSlide('order-action-slide');
        expect(m.updatePrice).not.toHaveBeenCalled();
        expect(text(byTestId('order-action-feedback')[0]!)).toMatch(/^未送出：/);
        expect(getMobileUi().orderAction).not.toBeNull();
    });

    it('刪單 still works while resyncing and not LIVE', async () => {
        m.cancelOrder.mockResolvedValue(trade('o1', { status: { status: 'Cancelled', cancel_quantity: 5 } }));
        setState([trade('o1')]);
        setResumeGateForTest({ state: 'resyncing' });
        h.live = false;
        await render();
        await press(rowButton('o1', 'order-cancel-button')!);
        expect(slide('order-action-slide')!.props.disabled).toBe(false);
        await confirmSlide('order-action-slide');
        expect(m.cancelOrder).toHaveBeenCalledWith('o1');
        expect(m.assertLive).not.toHaveBeenCalled();
        expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '刪單結果', kind: 'ok' }));
        expect(getMobileUi().orderAction).toBeNull();
    });
});

describe('OrdersPage — 全部刪單', () => {
    it('requires a slide confirmation listing the count and accounts before calling cancelAllOrders', async () => {
        m.cancelAll.mockResolvedValue(3);
        setState([trade('o1'), trade('o2'), trade('o3', { account: esun }), trade('o4', { status: { status: 'Filled', deal_quantity: 5 } })]);
        await render();
        // 篩選單一帳戶時仍列出全部帳戶（cancelAllOrders 不受篩選限制）
        await act(async () => { byTestId('orders-account')[0]!.props.onChange({ target: { value: '9A95-0123456' } }); });
        const button = byTestId('orders-cancel-all')[0]!;
        expect(text(button)).toBe('全部刪單（3 筆）');
        await press(button);
        expect(byTestId('cancel-all-sheet')).toHaveLength(1);
        expect(text(byTestId('cancel-all-count')[0]!)).toContain('3 筆未成交委託，涉及 2 個帳戶');
        const accounts = text(byTestId('cancel-all-accounts')[0]!);
        expect(accounts).toContain('9A95-***56（送往 永豐 模擬）：2 筆');
        expect(accounts).toContain('8840-***87（送往 玉山 模擬）：1 筆');
        expect(m.cancelAll).not.toHaveBeenCalled();

        // 取消不呼叫
        await press(root().findAllByType('button').find(b => text(b) === '取消')!);
        expect(byTestId('cancel-all-sheet')).toHaveLength(0);
        expect(m.cancelAll).not.toHaveBeenCalled();

        await press(byTestId('orders-cancel-all')[0]!);
        await confirmSlide('cancel-all-slide');
        expect(m.cancelAll).toHaveBeenCalledTimes(1);
        expect(byTestId('cancel-all-sheet')).toHaveLength(0);
    });

    it('hides 全部刪單 when nothing is working', async () => {
        setState([trade('o1', { status: { status: 'Filled', deal_quantity: 5 } })]);
        await render();
        expect(byTestId('orders-cancel-all')).toHaveLength(0);
    });

    it('cancel-all failure uses the desktop wording and is not retried automatically', async () => {
        m.cancelAll.mockRejectedValue(new Error('timeout'));
        setState([trade('o1')]);
        await render();
        await press(byTestId('orders-cancel-all')[0]!);
        await confirmSlide('cancel-all-slide');
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '全部刪單失敗或結果未知', body: 'timeout；請手動更新委託確認，勿自動重送' });
        expect(m.cancelAll).toHaveBeenCalledTimes(1);
        expect(byTestId('cancel-all-sheet')).toHaveLength(0);
    });
});

describe('OrdersPage — 更新與對帳', () => {
    it('更新 has a 6-second cooldown', async () => {
        vi.useFakeTimers();
        setState([trade('o1')]);
        await render();
        const refreshButton = () => byTestId('orders-refresh')[0]!;
        await press(refreshButton());
        // A-4：用 reconcileOrdersOnce（等進行中讀取與冷卻後真的讀一次委託），不直接呼叫 refreshTradingState('orders')
        expect(m.reconcile).toHaveBeenCalledTimes(1);
        expect(m.reconcile).toHaveBeenCalledWith();
        expect(m.refresh).not.toHaveBeenCalled();
        expect(refreshButton().props.disabled).toBe(true);
        expect(text(refreshButton())).toBe('⟳ 更新（6）');

        await press(refreshButton()); // 冷卻中：不呼叫
        expect(m.reconcile).toHaveBeenCalledTimes(1);

        await act(async () => { vi.advanceTimersByTime(3_000); });
        expect(text(refreshButton())).toBe('⟳ 更新（3）');
        expect(refreshButton().props.disabled).toBe(true);

        await act(async () => { vi.advanceTimersByTime(ORDERS_REFRESH_COOLDOWN_MS - 3_000); });
        expect(refreshButton().props.disabled).toBe(false);
        expect(text(refreshButton())).toBe('⟳ 更新');
        await press(refreshButton());
        expect(m.reconcile).toHaveBeenCalledTimes(2);
    });

    it('shows the reconcile banner with reason labels and 對帳 refreshes orders (sharing the cooldown)', async () => {
        setState([trade('o1')], { needsReconcile: true, reasons: ['disconnect', 'mutation-outcome'] });
        await render();
        const banner = byTestId('orders-reconcile')[0]!;
        expect(text(banner)).toContain('串流中斷、改刪待確認');
        const reconcile = banner.findAllByType('button')[0]!;
        expect(text(reconcile)).toBe('對帳');
        await press(reconcile);
        expect(m.reconcile).toHaveBeenCalledTimes(1);
        expect(m.refresh).not.toHaveBeenCalled();
        expect(byTestId('orders-refresh')[0]!.props.disabled).toBe(true);
    });

    it('re-renders when trades update (filled orders leave 未成交)', async () => {
        setState([trade('o1')]);
        await render();
        expect(rows()).toHaveLength(1);
        setState([trade('o1', { status: { status: 'Filled', deal_quantity: 5 } })]);
        await rerender();
        expect(rows()).toHaveLength(0);
        expect(text(byTestId('orders-empty')[0]!)).toBe('此分頁沒有委託');
    });
});

describe('OrdersPage — Q1：委託尚未讀到', () => {
    it('updatedAt 為 null 且沒有委託：顯示「委託載入中…」而不是「沒有委託」（不論 lib 的 loading 旗標）', async () => {
        setState([], { updatedAt: null });
        await render();
        expect(text(byTestId('orders-empty')[0]!)).toBe('委託載入中…');
        await press(byTestId('orders-tab-all')[0]!);
        expect(text(byTestId('orders-empty')[0]!)).toBe('委託載入中…');
    });

    it('讀到後才顯示「沒有委託」', async () => {
        setState([], { updatedAt: null });
        await render();
        setState([], { updatedAt: 2 });
        await rerender();
        expect(text(byTestId('orders-empty')[0]!)).toBe('沒有委託');
    });

    it('首次讀取失敗（有錯誤、未讀到）：提示尚未讀取成功', async () => {
        setState([], { updatedAt: null, error: '委託查詢失敗' });
        await render();
        expect(text(byTestId('orders-empty')[0]!)).toContain('尚未讀取成功');
    });
});
