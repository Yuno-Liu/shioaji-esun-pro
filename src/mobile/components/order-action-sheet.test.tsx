// 委託操作面板（規格 §6.5、§7.2、§7.3）：選單依規則顯示動作、改價檢查（升降單位、漲跌停、玉山 ROD 限價）、
// 改價／減量的 LIVE 與 ResumeGate 閘門（滑動後同步再檢查）、結果分「未送出」與「結果未知」（不重送）、
// 進行中鎖住面板、委託已不在未成交時停用。以 vi.mock 隔離 src/lib，不打任何真實 API。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    trades: [] as unknown[],
    live: true,
    meta: new Map<string, unknown>(),
    contracts: {} as Record<string, unknown>,
}));
const m = vi.hoisted(() => ({
    notify: vi.fn(),
    assertLive: vi.fn(),
    cancelOrder: vi.fn(),
    updatePrice: vi.fn(),
    updateQty: vi.fn(),
}));

vi.mock('../../lib/trading-state', () => ({ useTradingState: () => ({ trades: h.trades }) }));
vi.mock('../../lib/trade', () => ({ notify: m.notify, assertTradingLive: m.assertLive }));
vi.mock('../../lib/shioaji', () => ({ cancelOrder: m.cancelOrder, updateOrderPrice: m.updatePrice, updateOrderQty: m.updateQty }));
vi.mock('../../lib/trade-mutations', () => ({
    cancellationSummary: () => ({ kind: 'ok', body: '已確認取消 1 筆。' }),
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
vi.mock('../../lib/privacy', () => ({ usePrivacyMode: () => false }));
vi.mock('../../lib/tick-bands', () => ({ bandTickFor: () => undefined, prefetchTickBands: () => undefined }));
vi.mock('./route-badge', () => ({
    useOrderRoute: (a: { broker_id: string } | null) => (a ? { esun: false, broker: '永豐', simulation: false } : null),
    useRowRoute: (a: { broker_id: string } | null) => (a ? { esun: false, broker: '永豐', simulation: false } : null),
    routeBadgeText: (r: { broker: string } | null) => (r ? `送往 ${r.broker} 正式` : '未選擇下單帳戶'),
}));
vi.mock('./account-switch-sheet', () => ({ mobileAccountLabel: (a: { broker_id: string }) => `${a.broker_id}-***56` }));

import type { AccountedTrade } from '../../lib/types/order';
import { notStarted } from '../lib/errors';
import { closeOrderAction, getMobileUi, openOrderAction, resetMobileUiForTest } from '../lib/mobile-store';
import { getResumeGate, setResumeGateForTest } from '../lib/resume-gate-runtime';
import { resetTradingActivityForTest, setEnvSwitch } from '../lib/trading-activity';
import { ListRow } from '../ui/grouped';
import { BottomSheet, SheetFooter } from './bottom-sheet';
import {
    newRemainingProblem,
    ORDER_ACTION_SLOW_MS,
    ORDER_ACTION_TEXT,
    OrderActionSheet,
    orderTimeText,
    priceProblem,
    qtyReduction,
} from './order-action-sheet';
import { SlideToConfirm } from './slide-to-confirm';

const sinopac = { account_type: 'S', broker_id: '9A95', account_id: '0123456' };
const esun = { account_type: 'S', broker_id: '8840', account_id: '0099887' };

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
            modified_price: 0, msg: '', deals: [], ...over.status,
        },
    } as unknown as AccountedTrade;
}

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const root = () => view!.root;
const byTestId = (id: string) => root().findAll(n => n.props?.['data-testid'] === id && typeof n.type === 'string');
const slide = () => root().findAll(n => n.type === SlideToConfirm)[0];
const sheet = () => root().findAll(n => n.type === BottomSheet)[0]!;
const button = (label: string) => root().findAllByType('button').find(b => text(b).trim() === label);

async function open(tradeId: string, kind: Parameters<typeof openOrderAction>[1]) {
    await act(async () => { openOrderAction(tradeId, kind); });
    if (!view) await act(async () => { view = create(createElement(OrderActionSheet)); });
}
async function rerender() {
    await act(async () => { view!.update(createElement(OrderActionSheet)); });
}
async function press(label: string) {
    await act(async () => { button(label)!.props.onClick(); });
}
async function typeInto(testId: string, value: string) {
    await act(async () => { byTestId(testId)[0]!.props.onChange({ target: { value } }); });
}
async function confirm() {
    await act(async () => { slide()!.props.onConfirm(); });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    h.trades = [trade('o1')];
    h.live = true;
    h.meta.clear();
    h.contracts = {};
    m.assertLive.mockImplementation(() => undefined);
    resetMobileUiForTest();
    setResumeGateForTest(null);
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('純函式', () => {
    it('converts the new remaining quantity into a reduction and validates 1 ≤ n < remaining', () => {
        expect(qtyReduction(5, 2)).toBe(3);
        expect(newRemainingProblem(2, 5)).toBeNull();
        expect(newRemainingProblem(5, 5)).toContain('全部取消請使用刪單');
        expect(newRemainingProblem(0, 5)).not.toBeNull();
        expect(newRemainingProblem(1.5, 5)).not.toBeNull();
    });

    it('checks price tick, stock limits, unchanged price and E.SUN ROD-limit rule', () => {
        const t = trade('o1');
        const contract = { ...t.contract, limit_up: 1185, limit_down: 975 };
        expect(priceProblem(t, contract, 1085)).toBeNull();
        expect(priceProblem(t, contract, 1082)).toBe(ORDER_ACTION_TEXT.priceTick);
        expect(priceProblem(t, contract, 1190)).toContain('超出漲跌停');
        expect(priceProblem(t, contract, 1080)).toBe(ORDER_ACTION_TEXT.priceSame);
        expect(priceProblem(t, contract, 0)).toBe(ORDER_ACTION_TEXT.priceInvalid);
        const e = trade('e1', { account: esun, order: { order_type: 'IOC' } });
        expect(priceProblem(e, contract, 1085)).toContain('玉山證券僅支援 ROD 限價單改價');
        // 期貨不檢查股票漲跌停
        const f = trade('f1', { contract: { code: 'TXFL6', security_type: 'FUT', exchange: 'TAIFEX', tick: 1 }, order: { price: 22800 } });
        expect(priceProblem(f, { ...f.contract, limit_up: 100, limit_down: 1 } as never, 22801)).toBeNull();
    });

    it('formats order time in Taipei (seconds or milliseconds)', () => {
        const now = Date.UTC(2026, 10, 5, 3, 0, 0); // 台北 11:00
        expect(orderTimeText(Date.UTC(2026, 10, 5, 1, 12, 3) / 1000, now)).toBe('09:12:03');
        expect(orderTimeText(Date.UTC(2026, 10, 4, 1, 12, 3), now)).toBe('11/04 09:12:03');
        expect(orderTimeText(undefined, now)).toBe('');
    });
});

describe('OrderActionSheet — 選單', () => {
    it('opens the menu (from a chart order line) with the summary and available actions', async () => {
        await open('o1', 'menu');
        expect(text(sheet())).toContain('2330');
        expect(button('改價')).toBeDefined();
        expect(button('減量')).toBeDefined();
        expect(button('刪單')).toBeDefined();
        await press('改價');
        expect(byTestId('order-action-body')[0]!.props['data-view']).toBe('price');
        expect(byTestId('order-action-price')[0]!.props.value).toBe('1080');
        await press('返回');
        expect(byTestId('order-action-body')[0]!.props['data-view']).toBe('menu');
    });

    it('omits 改價 for odd lots and both edits for E.SUN reservations', async () => {
        h.trades = [
            trade('odd', { order: { order_lot: 'IntradayOdd', quantity: 300 }, status: { order_quantity: 300 } }),
            trade('rsv', { account: esun, status: { status: 'PreSubmitted' } }),
        ];
        await open('odd', 'menu');
        expect(button('改價')).toBeUndefined();
        expect(button('減量')).toBeDefined();
        await act(async () => { closeOrderAction(); });
        await open('rsv', 'menu');
        expect(button('改價')).toBeUndefined();
        expect(button('減量')).toBeUndefined();
        expect(button('刪單')).toBeDefined();
        // 直接以 'price' 開啟也不提供改價
        await act(async () => { closeOrderAction(); });
        await open('rsv', 'price');
        expect(slide()).toBeUndefined();
        expect(text(sheet())).toContain(ORDER_ACTION_TEXT.noPrice);
    });

    it('disables 改價／減量 (not 刪單) and explains when not LIVE', async () => {
        h.live = false;
        await open('o1', 'menu');
        expect(button('改價')!.props.disabled).toBe(true);
        expect(button('減量')!.props.disabled).toBe(true);
        expect(button('刪單')!.props.disabled).toBe(false);
        expect(text(byTestId('order-action-gate')[0]!)).toContain(ORDER_ACTION_TEXT.notLive);
    });

    it('reports a trade that is not found', async () => {
        await open('missing', 'cancel');
        expect(text(sheet())).toContain(ORDER_ACTION_TEXT.notFound);
        expect(slide()).toBeUndefined();
    });
});

describe('OrderActionSheet — 改價', () => {
    it('steps by tick and sends updateOrderPrice only after the slide, after the live gates', async () => {
        m.updatePrice.mockResolvedValue({});
        await open('o1', 'price');
        await act(async () => { root().findAll(n => n.type === 'button' && n.props['aria-label'] === '價格加一檔')[0]!.props.onClick(); });
        expect(byTestId('order-action-price')[0]!.props.value).toBe('1085');
        expect(slide()!.props.label).toBe('滑動確認 改價 → 1,085');
        expect(m.updatePrice).not.toHaveBeenCalled();
        await confirm();
        expect(m.assertLive).toHaveBeenCalledTimes(1);
        expect(m.updatePrice).toHaveBeenCalledWith('o1', 1085);
        expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok', title: '改價已送出' }));
        expect(getMobileUi().orderAction).toBeNull();
    });

    it('disables the slide for invalid prices (tick, limits)', async () => {
        h.contracts = { '2330': { ...trade('o1').contract, limit_up: 1185, limit_down: 975 } };
        await open('o1', 'price');
        await typeInto('order-action-price', '1082');
        expect(slide()!.props.disabled).toBe(true);
        expect(slide()!.props.disabledReason).toBe(ORDER_ACTION_TEXT.priceTick);
        await typeInto('order-action-price', '1190');
        expect(slide()!.props.disabledReason).toContain('超出漲跌停');
        await typeInto('order-action-price', '1085');
        expect(slide()!.props.disabled).toBe(false);
    });

    it('does not call the lib when assertTradingLive refuses after the slide', async () => {
        m.assertLive.mockImplementation(() => { throw notStarted('行情非 LIVE'); });
        await open('o1', 'price');
        await typeInto('order-action-price', '1085');
        await confirm();
        expect(m.updatePrice).not.toHaveBeenCalled();
        expect(text(byTestId('order-action-feedback')[0]!)).toBe('未送出：行情非 LIVE');
        expect(getMobileUi().orderAction).not.toBeNull();
    });

    it('stale-data blocks until acknowledged, then passes assertResumeReady with allowStale', async () => {
        m.updatePrice.mockResolvedValue({});
        setResumeGateForTest({ state: 'stale-data', staleAcknowledged: false });
        await open('o1', 'price');
        await typeInto('order-action-price', '1085');
        expect(slide()!.props.disabledReason).toBe(ORDER_ACTION_TEXT.stale);
        const ack = root().findAll(n => n.type === 'input' && n.props.type === 'checkbox')[0]!;
        await act(async () => { ack.props.onChange(); });
        expect(getResumeGate().staleAcknowledged).toBe(true);
        await rerender();
        expect(slide()!.props.disabled).toBe(false);
        await confirm();
        expect(m.updatePrice).toHaveBeenCalledWith('o1', 1085);
    });

    it('keeps the sheet open with 未送出 when the lib reports mutationNotStarted', async () => {
        m.updatePrice.mockRejectedValue(notStarted('伺服器已切換，未送出改刪單'));
        await open('o1', 'price');
        await typeInto('order-action-price', '1085');
        const key = slide()!.props.resetKey;
        await confirm();
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '改價未送出', body: '伺服器已切換，未送出改刪單' });
        expect(text(byTestId('order-action-feedback')[0]!)).toBe('未送出：伺服器已切換，未送出改刪單');
        expect(getMobileUi().orderAction).not.toBeNull();
        expect(slide()!.props.resetKey).not.toBe(key); // 可修改後再滑動
        expect(m.updatePrice).toHaveBeenCalledTimes(1);
    });

    it('locks the sheet while in flight and ignores a second confirmation', async () => {
        let resolve!: (v: unknown) => void;
        m.updatePrice.mockReturnValue(new Promise(r => { resolve = r; }));
        await open('o1', 'price');
        await typeInto('order-action-price', '1085');
        await confirm();
        expect(sheet().props.dismissible).toBe(false);
        expect(slide()!.props.disabled).toBe(true);
        await confirm();
        expect(m.updatePrice).toHaveBeenCalledTimes(1);
        await act(async () => { resolve({}); });
        expect(getMobileUi().orderAction).toBeNull();
    });
});

describe('OrderActionSheet — 處理超過 20 秒（lib 改價／減量沒有逾時）', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('改價卡住：20 秒前鎖住；之後可關閉面板並提示結果未確認、勿重送；不重送', async () => {
        vi.useFakeTimers();
        let resolve!: (v: unknown) => void;
        m.updatePrice.mockReturnValue(new Promise(r => { resolve = r; }));
        try {
            await open('o1', 'price');
            await typeInto('order-action-price', '1085');
            await confirm();
            expect(sheet().props.dismissible).toBe(false);
            await act(async () => { vi.advanceTimersByTime(ORDER_ACTION_SLOW_MS - 1); });
            expect(sheet().props.dismissible).toBe(false);
            expect(byTestId('order-action-slow')).toHaveLength(0);
            await act(async () => { vi.advanceTimersByTime(1); });
            expect(sheet().props.dismissible).toBe(true);
            expect(text(byTestId('order-action-slow')[0]!)).toBe(ORDER_ACTION_TEXT.slow);
            expect(ORDER_ACTION_TEXT.slow).toContain('結果未確認，請到委託頁核對，勿重送');
            // 送出仍在進行：滑塊與「返回」停用，再滑一次也不重送
            expect(slide()!.props.disabled).toBe(true);
            expect(button('返回')!.props.disabled).toBe(true);
            await confirm();
            expect(m.updatePrice).toHaveBeenCalledTimes(1);
            await act(async () => { resolve({}); });
            expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok', title: '改價已送出' }));
            expect(getMobileUi().orderAction).toBeNull();
        } finally {
            await act(async () => { resolve({}); }); // 斷言失敗時也結束送出，不讓未結束的操作留到下一個測試
        }
    });

    it('逾時後關閉面板：重新開啟同一筆委託時所有動作停用；結果到達時只通知，不關閉之後開啟的面板、不更新已卸載的面板', async () => {
        vi.useFakeTimers();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        h.trades = [trade('o1'), trade('o2')];
        let resolve!: (v: unknown) => void;
        m.updateQty.mockReturnValue(new Promise(r => { resolve = r; }));
        try {
            await open('o1', 'qty');
            await typeInto('order-action-qty', '2');
            await confirm();
            expect(m.updateQty).toHaveBeenCalledTimes(1);
            await act(async () => { vi.advanceTimersByTime(ORDER_ACTION_SLOW_MS); });
            // 關閉面板（暗化幕／下拉／X 都是 onClose）
            await act(async () => { sheet().props.onClose(); });
            expect(getMobileUi().orderAction).toBeNull();
            expect(byTestId('order-action-body')).toHaveLength(0);
            // 重新開啟同一筆：改價、減量、刪單一律停用並說明；面板本身可關閉
            await open('o1', 'menu');
            expect(text(byTestId('order-action-unsettled')[0]!)).toBe(ORDER_ACTION_TEXT.unsettled);
            expect(root().findAll(n => n.type === ListRow).every(r => r.props.disabled === true)).toBe(true);
            expect(sheet().props.dismissible).toBe(true);
            await open('o1', 'qty');
            await typeInto('order-action-qty', '3');
            expect(slide()!.props.disabled).toBe(true);
            await confirm();
            await open('o1', 'cancel');
            expect(slide()!.props.disabled).toBe(true);
            await confirm();
            expect(m.updateQty).toHaveBeenCalledTimes(1);
            expect(m.cancelOrder).not.toHaveBeenCalled();
            // 另一筆委託的面板開著時，前一筆的結果到達（結果未知）：通知，但不關閉這個面板
            await open('o2', 'menu');
            expect(byTestId('order-action-unsettled')).toHaveLength(0);
            const seq = getMobileUi().orderAction!.seq;
            await act(async () => { resolve(Promise.reject(new Error('timeout'))); });
            expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '改量失敗或結果未知', body: 'timeout；請手動更新委託確認，勿自動重送' });
            expect(getMobileUi().orderAction?.seq).toBe(seq);
            // 結束後同一筆委託恢復可操作
            await open('o1', 'menu');
            expect(byTestId('order-action-unsettled')).toHaveLength(0);
            expect(root().findAll(n => n.type === ListRow).some(r => r.props.disabled === false)).toBe(true);
            expect(errors.mock.calls.filter(c => !String(c[0]).includes('react-test-renderer is deprecated'))).toEqual([]);
        } finally {
            errors.mockRestore();
            await act(async () => { resolve(undefined); }); // 已結束時無作用
        }
    });
});

describe('OrderActionSheet — 減量', () => {
    it('reports an unknown outcome with 改量 wording, closes and does not resend', async () => {
        m.updateQty.mockRejectedValue(new Error('timeout'));
        await open('o1', 'qty');
        expect(byTestId('order-action-qty')[0]!.props.value).toBe('4');
        await typeInto('order-action-qty', '2');
        await confirm();
        expect(m.updateQty).toHaveBeenCalledWith('o1', 3);
        expect(m.notify).toHaveBeenCalledWith({ kind: 'err', title: '改量失敗或結果未知', body: 'timeout；請手動更新委託確認，勿自動重送' });
        expect(getMobileUi().orderAction).toBeNull();
        expect(m.updateQty).toHaveBeenCalledTimes(1);
    });

    it('uses the remaining quantity at send time (partial fill while the sheet is open)', async () => {
        m.updateQty.mockResolvedValue({});
        await open('o1', 'qty');
        await typeInto('order-action-qty', '2');
        h.trades = [trade('o1', { status: { status: 'PartFilled', deal_quantity: 1 } })]; // 剩餘 5 → 4
        await rerender();
        await confirm();
        expect(m.updateQty).toHaveBeenCalledWith('o1', 2);
    });

    it('blocks 減量 while resyncing', async () => {
        setResumeGateForTest({ state: 'resyncing' });
        await open('o1', 'qty');
        await typeInto('order-action-qty', '2');
        expect(slide()!.props.disabled).toBe(true);
        await confirm();
        expect(m.updateQty).not.toHaveBeenCalled();
    });
});

describe('OrderActionSheet — 刪單', () => {
    it('is not gated by ResumeGate or LIVE', async () => {
        m.cancelOrder.mockResolvedValue(trade('o1', { status: { status: 'Cancelled', cancel_quantity: 5 } }));
        setResumeGateForTest({ state: 'failed' });
        h.live = false;
        await open('o1', 'cancel');
        expect(slide()!.props.disabled).toBe(false);
        expect(slide()!.props.tone).toBe('danger');
        await confirm();
        expect(m.cancelOrder).toHaveBeenCalledWith('o1', { beforeSend: expect.any(Function) });
        expect(m.assertLive).not.toHaveBeenCalled();
    });

    it('玉山環境切換中：玉山委託的刪單不送（未送出），lib 送出前的 beforeSend 也擋；永豐委託照常（round 3 2a）', async () => {
        h.trades = [trade('e1', { account: esun }), trade('o1')];
        await open('e1', 'cancel');
        setEnvSwitch({ target: 'PRODUCTION', phase: 'switching' });
        await confirm();
        expect(m.cancelOrder).not.toHaveBeenCalled();
        expect(text(byTestId('order-action-feedback')[0]!)).toContain('玉山環境切換中，這筆玉山委託沒有送出');
        // 滑動時還沒切換、lib 送出前才開始切換：beforeSend 丟出未送出
        resetTradingActivityForTest();
        m.cancelOrder.mockImplementation(async (_id: string, opts?: { beforeSend?: () => void }) => {
            setEnvSwitch({ target: 'PRODUCTION', phase: 'checking' });
            opts?.beforeSend?.();
            return trade('e1', { account: esun });
        });
        await confirm();
        expect(m.cancelOrder).toHaveBeenCalledTimes(1);
        expect(text(byTestId('order-action-feedback')[0]!)).toContain('玉山環境切換中');
        // 永豐委託：切換中照常刪單
        m.cancelOrder.mockReset();
        m.cancelOrder.mockImplementation(async (_id: string, opts?: { beforeSend?: () => void }) => {
            opts?.beforeSend?.();
            return trade('o1', { status: { status: 'Cancelled', cancel_quantity: 5 } });
        });
        await act(async () => { closeOrderAction(); });
        await open('o1', 'cancel');
        await confirm();
        expect(m.cancelOrder).toHaveBeenCalledTimes(1);
        expect(m.cancelOrder.mock.calls[0]![0]).toBe('o1');
        expect(byTestId('order-action-feedback')).toHaveLength(0);
        resetTradingActivityForTest();
    });

    it('shows 此委託已不在未成交 and disables actions when the order fills while open', async () => {
        await open('o1', 'cancel');
        expect(slide()!.props.disabled).toBe(false);
        h.trades = [trade('o1', { status: { status: 'Filled', deal_quantity: 5 } })];
        await rerender();
        expect(text(byTestId('order-action-gone')[0]!)).toBe(ORDER_ACTION_TEXT.gone);
        expect(slide()!.props.disabled).toBe(true);
        // 從清單消失時仍以最後內容顯示並停用
        h.trades = [];
        await rerender();
        expect(byTestId('order-action-gone')).toHaveLength(1);
        await press('返回');
        expect(button('刪單')!.props.disabled).toBe(true);
    });
});

// ---- B3a 委託操作面板 v2（設計規格 §7.5、§10 S1）----

describe('OrderActionSheet — v2 版面與 S1', () => {
    const byLabel = (aria: string) => root().findAll(n => n.type === 'button' && n.props['aria-label'] === aria)[0];

    it('頂部摘要＋選單 ListRow；瀏覽各子畫面與步進都不呼叫 lib 改刪單函式（只有滑動確認會）', async () => {
        await open('o1', 'menu');
        expect(byTestId('order-action-summary')).toHaveLength(1);
        expect(text(byTestId('order-action-summary')[0]!)).toContain('2330');
        expect(root().findAll(n => n.type === ListRow).map(n => n.props.title)).toEqual(['改價', '減量', '刪單']);
        for (const label of ['改價', '減量', '刪單']) {
            await press(label);
            for (const aria of ['價格加一檔', '價格減一檔', '數量加一', '數量減一']) {
                const key = byLabel(aria);
                if (key) await act(async () => { key.props.onClick(); });
            }
            expect(slide()).toBeDefined();
            await press('返回');
            expect(byTestId('order-action-body')[0]!.props['data-view']).toBe('menu');
        }
        expect(m.updatePrice).not.toHaveBeenCalled();
        expect(m.updateQty).not.toHaveBeenCalled();
        expect(m.cancelOrder).not.toHaveBeenCalled();
        expect(m.assertLive).not.toHaveBeenCalled();
        expect(getMobileUi().orderAction).not.toBeNull();
    });

    it('滑塊與「返回」在 SheetFooter；改價、減量 neutral，刪單 danger', async () => {
        await open('o1', 'price');
        const footerHas = () => {
            const footer = root().findAll(n => n.type === SheetFooter)[0]!;
            return {
                slide: footer.findAll(n => n.type === SlideToConfirm).length,
                back: footer.findAll(n => n.type === 'button' && text(n) === '返回').length,
            };
        };
        expect(footerHas()).toEqual({ slide: 1, back: 1 });
        expect(slide()!.props.tone ?? 'neutral').toBe('neutral');
        await press('返回');
        await press('減量');
        expect(footerHas()).toEqual({ slide: 1, back: 1 });
        expect(slide()!.props.tone ?? 'neutral').toBe('neutral');
        await press('返回');
        await press('刪單');
        expect(footerHas()).toEqual({ slide: 1, back: 1 });
        expect(slide()!.props.tone).toBe('danger');
    });

    it('減量 Stepper 界限：新的剩餘數量已是剩餘−1 時按＋不再增加並說明', async () => {
        await open('o1', 'qty');
        expect(byTestId('order-action-qty')[0]!.props.value).toBe('4');
        await act(async () => { byLabel('數量加一')!.props.onClick(); });
        expect(byTestId('order-action-qty')[0]!.props.value).toBe('4');
        expect(text(byTestId('order-action-qty-bound')[0]!)).toContain('須小於目前剩餘');
        await act(async () => { byLabel('數量減一')!.props.onClick(); });
        expect(byTestId('order-action-qty')[0]!.props.value).toBe('3');
        expect(text(byTestId('order-action-remaining')[0]!)).toBe('5 張');
        expect(m.updateQty).not.toHaveBeenCalled();
    });

    it('成交進度改以 ProgressBar 的 scaleX 呈現（沒有 width），progressbar 語意不變', async () => {
        h.trades = [trade('o1', { status: { status: 'PartFilled', deal_quantity: 2 } })];
        await open('o1', 'menu');
        const bar = byTestId('order-progress')[0]!;
        expect(bar.props.role).toBe('progressbar');
        expect(bar.props['aria-valuenow']).toBe(40);
        expect(bar.props['aria-label']).toBe('成交進度 2／5 張');
        const styled = bar.findAll(n => typeof n.type === 'string' && n.props.style);
        expect(styled.map(n => n.props.style.transform)).toEqual(['scaleX(0.4)']);
        expect(styled.some(n => 'width' in n.props.style)).toBe(false);
    });
});
