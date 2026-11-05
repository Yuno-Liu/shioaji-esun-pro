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
    privMoney: false,
}));
const m = vi.hoisted(() => ({
    refresh: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    notify: vi.fn(),
    assertLive: vi.fn(),
    cancelAll: vi.fn(),
    cancelOrder: vi.fn(),
    cancelOrders: vi.fn(),
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
vi.mock('../../lib/shioaji', () => ({ cancelOrder: m.cancelOrder, cancelOrders: m.cancelOrders, updateOrderPrice: m.updatePrice, updateOrderQty: m.updateQty }));
vi.mock('../../lib/trade-mutations', () => ({
    cancellationSummary: (results?: PromiseSettledResult<unknown>[]) => {
        if (!results || results.length <= 1) return { kind: 'ok', body: '已確認取消 1 筆。' };
        const ok = results.filter(r => r.status === 'fulfilled').length;
        return { kind: ok === results.length ? 'ok' : 'err', body: `已確認取消 ${ok} 筆；其他 ${results.length - ok} 筆。` };
    },
    cancellationOutcome: (t: { status: { status: string } }) => (t.status.status === 'Cancelled' ? 'confirmed' : t.status.status === 'Filled' ? 'filled' : 'pending'),
    maskIdentifiers: (s: string) => s.replace(/\b[A-Z][A-Z0-9]\d{8}\b/g, '***'),
}));
vi.mock('../../hooks/use-stream', () => ({ useTradingLive: () => h.live }));
vi.mock('../../lib/contracts-cache', () => ({
    useContract: (code: string | null) => (code ? h.contracts[code] : undefined),
    ensureContract: () => Promise.resolve(undefined),
}));
vi.mock('../../lib/esun/account-details', () => ({
    useEsunOrderMeta: (t: { order: { id: string } } | null) => (t ? h.meta.get(t.order.id) ?? null : null),
}));
vi.mock('../../lib/privacy', () => ({
    usePrivacyMode: () => false,
    usePrivacyMoney: () => h.privMoney,
    maskMoney: (text: string, priv: boolean) => (priv ? '•••••' : text),
}));
vi.mock('../../lib/tick-bands', () => ({ bandTickFor: () => undefined, prefetchTickBands: () => undefined }));
vi.mock('../components/route-badge', () => ({
    useOrderRoute: (a: { broker_id: string } | null) => (a ? { esun: a.broker_id.startsWith('884'), broker: a.broker_id.startsWith('884') ? '玉山' : '永豐', simulation: true } : null),
    routeBadgeText: (r: { broker: string } | null) => (r ? `送往 ${r.broker} 模擬` : '未選擇下單帳戶'),
}));
vi.mock('../components/account-switch-sheet', () => ({
    mobileAccountLabel: (a: { broker_id: string; account_id: string }) => `${a.broker_id}-***${a.account_id.slice(-2)}`,
}));

import type { AccountedTrade } from '../../lib/types/order';
import { BottomSheet } from '../components/bottom-sheet';
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
    h.privMoney = false;
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
        expect(r1.findAll(n => n.props?.['data-badge'] !== undefined && typeof n.type === 'string').map(text)).toEqual(['整股', '限價', 'ROD']);
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

// ---- W6：委託列欄位、明細、成交分頁、勾選批次刪單 ----

const deal = (seq: string, price: number, quantity: number, ts: number) => ({ seq, price, quantity, ts });
const testIdIn = (node: ReactTestInstance, id: string) => node.findAll(n => n.props?.['data-testid'] === id && typeof n.type === 'string');
function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

describe('OrdersPage — 委託列新欄位', () => {
    it('shows average fill price, fill progress, cancelled / original quantity, broker message and badges', async () => {
        setState([
            trade('o1', {
                order: { quantity: 10, order_cond: 'MarginTrading' },
                status: {
                    status: 'PartFilled', deal_quantity: 3, cancel_quantity: 2, msg: '部分成交 A123456789',
                    deals: [deal('d1', 1080, 1, 1_700_000_100), deal('d2', 1085, 2, 1_700_000_200)],
                },
            }),
            trade('o2', { order: { action: 'Sell', daytrade_short: true } }),
            trade('f1', { contract: { code: 'TXFL6', name: '台指期', security_type: 'FUT', exchange: 'TAIFEX' }, order: { octype: 'DayTrade', price: 22800, quantity: 2, order_type: 'IOC' } }),
        ]);
        await render();
        const r1 = row('o1')!;
        // 均價＝(1080×1 + 1085×2)/3 = 1083.33
        expect(text(testIdIn(r1, 'order-avg')[0]!)).toBe('均價 1,083.33');
        const bar = testIdIn(r1, 'order-progress')[0]!;
        expect(bar.props.role).toBe('progressbar');
        expect(bar.props['aria-valuenow']).toBe(38); // 3 ÷ (10 − 2)
        expect(bar.props['aria-label']).toBe('成交進度 3／8 張');
        expect(text(testIdIn(r1, 'order-cancelled')[0]!)).toBe('已取消 2 · 原始委託 10 張（減量後 8）');
        // 券商訊息遮蔽身分證號
        expect(text(testIdIn(r1, 'order-msg')[0]!)).toBe('訊息：部分成交 ***');
        expect(r1.findAll(n => n.props?.['data-badge'] === 'credit' && typeof n.type === 'string').map(text)).toEqual(['融資']);

        const r2 = row('o2')!;
        expect(testIdIn(r2, 'order-avg')).toHaveLength(0);
        expect(testIdIn(r2, 'order-progress')).toHaveLength(0);
        expect(testIdIn(r2, 'order-cancelled')).toHaveLength(0);
        expect(testIdIn(r2, 'order-msg')).toHaveLength(0);
        expect(r2.findAll(n => n.props?.['data-badge'] === 'daytrade' && typeof n.type === 'string').map(text)).toEqual(['當沖先賣']);

        const f1 = row('f1')!;
        expect(f1.findAll(n => n.props?.['data-badge'] !== undefined && typeof n.type === 'string').map(text)).toEqual(['當沖', '限價', 'IOC']);
        expect(text(testIdIn(f1, 'order-price')[0]!)).toBe('22,800 × 2 口');
    });
});

describe('OrdersPage — 委託明細', () => {
    it('tapping a row opens the detail sheet with the deal timeline; its actions open the existing action sheet', async () => {
        setState([trade('o1', {
            status: { status: 'PartFilled', deal_quantity: 3, deals: [deal('d2', 1085, 2, 1_700_000_200), deal('d1', 1080, 1, 1_700_000_100)] },
        })]);
        await render();
        expect(byTestId('order-detail-sheet')).toHaveLength(0);
        await press(testIdIn(row('o1')!, 'order-row-main')[0]!);
        expect(byTestId('order-detail-sheet')).toHaveLength(1);
        const deals = byTestId('detail-deal').map(text);
        // 由舊到新
        expect(deals[0]).toContain('成交 1,080 × 1 張');
        expect(deals[1]).toContain('成交 1,085 × 2 張');
        expect(text(byTestId('detail-ordno')[0]!)).toBe('Ao1');
        expect(text(byTestId('detail-seqno')[0]!)).toBe('So1');
        // 明細不呼叫任何交易函式；改價經由委託操作面板
        await press(byTestId('detail-price-button')[0]!);
        expect(byTestId('order-detail-sheet')).toHaveLength(0);
        expect(getMobileUi().orderAction).toMatchObject({ tradeId: 'o1', kind: 'price' });
        expect(m.updatePrice).not.toHaveBeenCalled();
        expect(m.cancelOrder).not.toHaveBeenCalled();
    });
});

describe('OrdersPage — 成交分頁', () => {
    it('lists every deal newest first with time, symbol, side, price, quantity and account, plus totals', async () => {
        setState([
            trade('o1', { status: { status: 'Filled', deal_quantity: 2, deals: [deal('d1', 1080, 1, 1_700_000_100), deal('d2', 1085, 1, 1_700_000_300)] } }),
            trade('o2', { account: esun, order: { action: 'Sell', order_lot: 'IntradayOdd', price: 500, quantity: 300 }, status: { status: 'PartFilled', order_quantity: 300, deal_quantity: 100, deals: [deal('d3', 500, 100, 1_700_000_200)] } }),
            trade('o3'), // 沒有成交
        ]);
        await render();
        await press(byTestId('orders-tab-deals')[0]!);
        const dealRows = byTestId('deal-row');
        expect(dealRows.map(r => r.props['data-trade-id'])).toEqual(['o1', 'o2', 'o1']);
        expect(text(testIdIn(dealRows[1]!, 'deal-side')[0]!)).toBe('賣');
        expect(text(testIdIn(dealRows[1]!, 'deal-price')[0]!)).toBe('500 × 100 股');
        expect(text(testIdIn(dealRows[1]!, 'deal-account')[0]!)).toBe('8840-***87');
        expect(text(testIdIn(dealRows[0]!, 'deal-time')[0]!)).toMatch(/\d\d:\d\d:\d\d$/);

        expect(text(byTestId('deals-total-count')[0]!)).toBe('合計 3 筆');
        // 張與股分開計；股票金額＝價 × 股數
        expect(text(byTestId('deals-total-buy')[0]!)).toBe('買進 2 筆 · 2 張 · 股票 2,165,000 元');
        expect(text(byTestId('deals-total-sell')[0]!)).toBe('賣出 1 筆 · 100 股 · 股票 50,000 元');
        // 成交分頁沒有全部刪單
        expect(byTestId('orders-cancel-all')).toHaveLength(0);

        // 點成交列開啟委託明細
        await press(dealRows[1]!.findAllByType('button')[0]!);
        expect(byTestId('order-detail-sheet')).toHaveLength(1);
    });

    // X3 F2:F1：玉山重新讀取後的逐筆成交 ts 等於委託時間，不當成交時間顯示與排序
    it('E.SUN deals carrying only the order time show 券商未提供成交時間 and sort after timed deals', async () => {
        setState([
            trade('s1', { status: { status: 'Filled', deal_quantity: 1, deals: [deal('d1', 1080, 1, 1_700_000_100)] } }),
            trade('e1', {
                account: esun,
                order: { quantity: 2 },
                status: { status: 'Filled', order_quantity: 2, deal_quantity: 2, order_ts: 1_700_000_200, deals: [deal('000417', 1080, 1, 1_700_000_200), deal('000418', 1081, 1, 1_700_000_200)] },
            }),
        ]);
        await render();
        await press(byTestId('orders-tab-deals')[0]!);
        const dealRows = byTestId('deal-row');
        expect(dealRows.map(r => r.props['data-trade-id'])).toEqual(['s1', 'e1', 'e1']);
        expect(text(testIdIn(dealRows[0]!, 'deal-time')[0]!)).toMatch(/\d\d:\d\d:\d\d$/);
        expect(testIdIn(dealRows[0]!, 'deal-untimed')).toHaveLength(0);
        for (const r of dealRows.slice(1)) {
            expect(text(testIdIn(r, 'deal-time')[0]!)).toBe('—');
            expect(text(testIdIn(r, 'deal-untimed')[0]!)).toBe('（券商未提供成交時間）');
        }
        expect(text(byTestId('deals-sort-note')[0]!)).toContain('排在後面，依委託時間排列');
    });

    it('masks money totals when money privacy is on', async () => {
        h.privMoney = true;
        setState([trade('o1', { status: { status: 'Filled', deal_quantity: 1, deals: [deal('d1', 1080, 1, 1_700_000_100)] } })]);
        await render();
        await press(byTestId('orders-tab-deals')[0]!);
        expect(text(byTestId('deals-total-buy')[0]!)).toBe('買進 1 筆 · 1 張 · 股票 ••••• 元');
    });

    it('shows 目前沒有成交 when there are orders but no deals', async () => {
        setState([trade('o1')]);
        await render();
        await press(byTestId('orders-tab-deals')[0]!);
        expect(text(byTestId('orders-empty')[0]!)).toBe('目前沒有成交');
    });
});

describe('OrdersPage — 勾選批次刪單', () => {
    async function selectRows(...ids: string[]) {
        await press(byTestId('orders-select')[0]!);
        for (const id of ids) {
            await act(async () => { testIdIn(row(id)!, 'order-select')[0]!.props.onChange(); });
        }
    }
    const cancelled = (id: string, account = sinopac) => trade(id, { account, status: { status: 'Cancelled', cancel_quantity: 5 } });

    it('requires selection and a slide confirmation listing count and accounts, then calls cancelOrders once in display order', async () => {
        m.cancelOrders.mockImplementation(async (ids: string[], onSettled?: () => void) => {
            ids.forEach(() => onSettled?.());
            return [{ status: 'fulfilled', value: cancelled('o3', esun) }, { status: 'fulfilled', value: cancelled('o1') }];
        });
        setState([trade('o1'), trade('o2'), trade('o3', { account: esun })]); // 畫面：o3, o2, o1
        await render();
        // 未選取時沒有勾選框
        expect(byTestId('order-select')).toHaveLength(0);
        await selectRows('o1', 'o3');
        expect(text(byTestId('orders-selected-count')[0]!)).toBe('已選 2 筆');
        // 選取模式不顯示單筆操作鍵與全部刪單
        expect(byTestId('order-cancel-button')).toHaveLength(0);
        expect(byTestId('orders-cancel-all')).toHaveLength(0);
        const button = byTestId('orders-cancel-selected')[0]!;
        expect(text(button)).toBe('刪除已選（2 筆）');
        await press(button);
        expect(text(byTestId('batch-cancel-count')[0]!)).toContain('2 筆未成交委託，涉及 2 個帳戶');
        const accounts = text(byTestId('batch-cancel-accounts')[0]!);
        expect(accounts).toContain('9A95-***56（送往 永豐 模擬）：1 筆');
        expect(accounts).toContain('8840-***87（送往 玉山 模擬）：1 筆');
        // 滑動前不呼叫
        expect(m.cancelOrders).not.toHaveBeenCalled();
        expect(m.cancelOrder).not.toHaveBeenCalled();

        await confirmSlide('batch-cancel-slide');
        expect(m.cancelOrders).toHaveBeenCalledTimes(1);
        expect(m.cancelOrders.mock.calls[0]![0]).toEqual(['o3', 'o1']);
        expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '批次刪單結果', kind: 'ok' }));
        const results = byTestId('batch-cancel-result');
        expect(results.map(r => r.props['data-tone'])).toEqual(['ok', 'ok']);
        expect(text(results[0]!)).toContain('已確認取消');
        // 完成後清除選取並離開選取模式
        expect(byTestId('order-select')).toHaveLength(0);
        await press(byTestId('batch-cancel-close')[0]!);
        expect(byTestId('batch-cancel-sheet')).toHaveLength(0);
    });

    it('summarizes partial failures with mutationErrorNotice wording and never resends', async () => {
        m.cancelOrders.mockResolvedValue([
            { status: 'fulfilled', value: cancelled('o3') },
            { status: 'rejected', reason: Object.assign(new Error('委託已變更'), { mutationNotStarted: true }) },
            { status: 'rejected', reason: Object.assign(new Error('刪單已送出但未確認取消'), { code: 'CANCEL_UNCONFIRMED', mutationOutcomeUnknown: true }) },
        ]);
        setState([trade('o1'), trade('o2'), trade('o3')]);
        await render();
        await selectRows('o1', 'o2', 'o3');
        await press(byTestId('orders-cancel-selected')[0]!);
        await confirmSlide('batch-cancel-slide');
        expect(m.cancelOrders).toHaveBeenCalledTimes(1);
        expect(m.cancelOrders.mock.calls[0]![0]).toEqual(['o3', 'o2', 'o1']);
        const notice = m.notify.mock.calls.at(-1)![0];
        expect(notice).toMatchObject({ title: '批次刪單結果', kind: 'err' });
        const results = byTestId('batch-cancel-result');
        expect(results.map(r => r.props['data-trade-id'])).toEqual(['o3', 'o2', 'o1']);
        expect(results.map(r => r.props['data-tone'])).toEqual(['ok', 'warn', 'err']);
        expect(text(results[1]!)).toContain('刪單未送出');
        expect(text(results[1]!)).toContain('委託已變更');
        expect(text(results[2]!)).toContain('刪單失敗或結果未知');
        expect(text(results[2]!)).toContain('勿自動重送');
        // 不提供重送鍵、不自動重送
        expect(buttonsWithText('重送')).toHaveLength(0);
        expect(buttonsWithText('重試')).toHaveLength(0);
        await act(async () => { await Promise.resolve(); });
        expect(m.cancelOrders).toHaveBeenCalledTimes(1);
        expect(m.cancelOrder).not.toHaveBeenCalled();
    });

    it('disables the slide and locks the sheet while sending; not gated by ResumeGate or LIVE', async () => {
        const pending = deferred<PromiseSettledResult<unknown>[]>();
        m.cancelOrders.mockReturnValue(pending.promise);
        setResumeGateForTest({ state: 'resyncing' });
        h.live = false;
        setState([trade('o1'), trade('o2')]);
        await render();
        await selectRows('o1');
        await press(byTestId('orders-cancel-selected')[0]!);
        expect(slide('batch-cancel-slide')!.props.disabled).toBe(false);
        await confirmSlide('batch-cancel-slide');
        expect(m.cancelOrders).toHaveBeenCalledTimes(1);
        expect(m.assertLive).not.toHaveBeenCalled();
        expect(slide('batch-cancel-slide')!.props.disabled).toBe(true);
        expect(slide('batch-cancel-slide')!.props.disabledReason).toBe('處理中…');
        const sheet = root().findAll(n => n.type === BottomSheet && n.props.testId === 'batch-cancel-sheet')[0]!;
        expect(sheet.props.dismissible).toBe(false);
        expect(byTestId('orders-tab-filled')[0]!.props.disabled).toBe(true);
        // 再滑一次也不會重複送出
        await confirmSlide('batch-cancel-slide');
        expect(m.cancelOrders).toHaveBeenCalledTimes(1);
        await act(async () => { pending.resolve([{ status: 'fulfilled', value: cancelled('o1') }]); });
        expect(byTestId('batch-cancel-result')).toHaveLength(1);
    });

    it('a not-started batch failure keeps the sheet open; an unknown one closes it without resend', async () => {
        m.cancelOrders.mockRejectedValueOnce(Object.assign(new Error('帳戶未簽署'), { mutationNotStarted: true }));
        setState([trade('o1')]);
        await render();
        await selectRows('o1');
        await press(byTestId('orders-cancel-selected')[0]!);
        await confirmSlide('batch-cancel-slide');
        expect(text(byTestId('batch-cancel-feedback')[0]!)).toBe('未送出：帳戶未簽署');
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '批次刪單未送出', body: '帳戶未簽署' });
        expect(byTestId('batch-cancel-sheet')).toHaveLength(1);

        m.cancelOrders.mockRejectedValueOnce(new Error('timeout'));
        await confirmSlide('batch-cancel-slide');
        expect(m.notify).toHaveBeenLastCalledWith({ kind: 'err', title: '批次刪單失敗或結果未知', body: 'timeout；請手動更新委託確認，勿自動重送' });
        expect(byTestId('batch-cancel-sheet')).toHaveLength(0);
        expect(m.cancelOrders).toHaveBeenCalledTimes(2);
    });

    // X3 F2:F4：選取中目前範圍的未成交清單變空 → 自動離開選取模式，「全部刪單」恢復
    it('leaves selection mode when the scoped working list empties', async () => {
        setState([trade('o1'), trade('o2', { account: esun })]);
        await render();
        await act(async () => { byTestId('orders-account')[0]!.props.onChange({ target: { value: '9A95-0123456' } }); });
        await selectRows('o1');
        expect(text(byTestId('orders-selected-count')[0]!)).toBe('已選 1 筆');
        setState([trade('o1', { status: { status: 'Filled', deal_quantity: 5 } }), trade('o2', { account: esun })]);
        await rerender();
        expect(byTestId('orders-cancel-selected')).toHaveLength(0);
        expect(text(byTestId('orders-cancel-all')[0]!)).toBe('全部刪單（1 筆）');
        // 再有新的未成交時是一般模式（選取鍵，沒有勾選框）
        setState([trade('o1', { status: { status: 'Filled', deal_quantity: 5 } }), trade('o2', { account: esun }), trade('o3')]);
        await rerender();
        expect(byTestId('orders-select')).toHaveLength(1);
        expect(byTestId('order-select')).toHaveLength(0);
    });

    it('clears the selection when switching tabs and offers 選取 only in 未成交', async () => {
        setState([trade('o1'), trade('o2', { status: { status: 'Filled', deal_quantity: 5 } })]);
        await render();
        await selectRows('o1');
        expect(text(byTestId('orders-selected-count')[0]!)).toBe('已選 1 筆');
        await press(byTestId('orders-tab-all')[0]!);
        expect(byTestId('orders-select-toolbar')).toHaveLength(0);
        expect(byTestId('order-select')).toHaveLength(0);
        await press(byTestId('orders-tab-working')[0]!);
        expect(byTestId('order-select')).toHaveLength(0);
        await press(byTestId('orders-select')[0]!);
        expect(text(byTestId('orders-selected-count')[0]!)).toBe('已選 0 筆');
        expect(byTestId('orders-cancel-selected')[0]!.props.disabled).toBe(true);
        // 全選／全不選
        await press(byTestId('orders-select-all')[0]!);
        expect(text(byTestId('orders-selected-count')[0]!)).toBe('已選 1 筆');
        // 選取模式點列主體＝切換勾選，不開明細
        await press(testIdIn(row('o1')!, 'order-row-main')[0]!);
        expect(text(byTestId('orders-selected-count')[0]!)).toBe('已選 0 筆');
        expect(byTestId('order-detail-sheet')).toHaveLength(0);
    });
});
