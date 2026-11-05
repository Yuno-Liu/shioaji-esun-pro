// 委託明細面板：完整欄位、成交時間軸（由舊到新、玉山彙總成交）、未提供逐筆明細的差額、玉山中繼資料（預約、可否刪）、
// 改價／減量／刪單只開既有的委託操作面板（不呼叫 lib 交易函式）、非未成交時不提供動作、委託從清單消失時保留內容。
// 以 vi.mock 隔離 src/lib，不打任何真實 API。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    trades: [] as unknown[],
    meta: new Map<string, unknown>(),
}));
const m = vi.hoisted(() => ({ cancelOrder: vi.fn(), updatePrice: vi.fn(), updateQty: vi.fn(), notify: vi.fn(), assertLive: vi.fn() }));

vi.mock('../../lib/trading-state', () => ({ useTradingState: () => ({ trades: h.trades }) }));
vi.mock('../../lib/trade', () => ({ notify: m.notify, assertTradingLive: m.assertLive }));
vi.mock('../../lib/shioaji', () => ({ cancelOrder: m.cancelOrder, updateOrderPrice: m.updatePrice, updateOrderQty: m.updateQty }));
vi.mock('../../lib/trade-mutations', () => ({
    cancellationSummary: () => ({ kind: 'ok', body: '' }),
    maskIdentifiers: (s: string) => s.replace(/\b[A-Z][A-Z0-9]\d{8}\b/g, '***'),
}));
vi.mock('../../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../../lib/contracts-cache', () => ({ useContract: () => undefined, ensureContract: () => Promise.resolve(undefined) }));
vi.mock('../../lib/esun/account-details', () => ({
    useEsunOrderMeta: (t: { order: { id: string } } | null) => (t ? h.meta.get(t.order.id) ?? null : null),
}));
vi.mock('../../lib/privacy', () => ({ usePrivacyMode: () => false }));
vi.mock('../../lib/tick-bands', () => ({ bandTickFor: () => undefined, prefetchTickBands: () => undefined }));
vi.mock('./route-badge', () => ({
    useOrderRoute: (a: { broker_id: string } | null) => (a ? { broker: a.broker_id.startsWith('884') ? '玉山' : '永豐' } : null),
    routeBadgeText: (r: { broker: string } | null) => (r ? `送往 ${r.broker} 模擬` : '未選擇下單帳戶'),
}));
vi.mock('./account-switch-sheet', () => ({ mobileAccountLabel: (a: { broker_id: string }) => `${a.broker_id}-***56` }));

import { esunAggregateDealSeq } from '../../lib/esun/order-mapping';
import type { AccountedTrade } from '../../lib/types/order';
import { getMobileUi, resetMobileUiForTest } from '../lib/mobile-store';
import { setResumeGateForTest } from '../lib/resume-gate-runtime';
import { lastDealTs, ORDER_DETAIL_TEXT, OrderDetailSheet } from './order-detail-sheet';

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
            modified_price: 0, msg: '', deals: [], order_ts: 1_700_000_000, ...over.status,
        },
    } as unknown as AccountedTrade;
}
const deal = (seq: string, price: number, quantity: number, ts: number) => ({ seq, price, quantity, ts });

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const onClose = vi.fn();
const byTestId = (id: string) => view!.root.findAll(n => n.props?.['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => text(byTestId(id)[0]!);

async function render(tradeId: string | null) {
    const el = createElement(OrderDetailSheet, { tradeId, onClose });
    if (view) await act(async () => { view!.update(el); });
    else await act(async () => { view = create(el); });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    h.trades = [];
    h.meta.clear();
    resetMobileUiForTest();
    setResumeGateForTest(null);
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('OrderDetailSheet', () => {
    it('renders nothing when closed', async () => {
        h.trades = [trade('o1')];
        await render(null);
        expect(byTestId('order-detail-sheet')).toHaveLength(0);
    });

    it('shows full fields and a deal timeline ordered oldest first', async () => {
        h.trades = [trade('o1', {
            order: { quantity: 10 },
            status: {
                status: 'PartFilled', deal_quantity: 3, cancel_quantity: 2, modified_price: 1075, msg: '委託成功 A123456789',
                deals: [deal('d2', 1075, 2, 1_700_000_300), deal('d1', 1080, 1, 1_700_000_100)],
            },
        })];
        await render('o1');
        expect(one('detail-price')).toBe('1,075（原 1,080）');
        expect(one('detail-original')).toBe('10 張');
        expect(one('detail-filled')).toBe('3 張');
        expect(one('detail-cancelled')).toBe('2 張');
        expect(one('detail-remaining')).toBe('5 張');
        expect(one('detail-avg')).toBe('1,076.67');
        expect(one('detail-account')).toBe('送往 永豐 模擬 · 9A95-***56');
        expect(one('detail-ordno')).toBe('Ao1');
        expect(one('detail-seqno')).toBe('So1');
        expect(one('detail-msg')).toBe('委託成功 ***');
        expect(one('detail-order-time')).toMatch(/\d\d:\d\d:\d\d$/);
        expect(one('detail-last-deal')).toMatch(/\d\d:\d\d:\d\d$/);
        const deals = byTestId('detail-deal').map(text);
        expect(deals).toHaveLength(2);
        expect(deals[0]).toContain('成交 1,080 × 1 張');
        expect(deals[1]).toContain('成交 1,075 × 2 張');
        expect(byTestId('detail-no-deals')).toHaveLength(0);
        expect(byTestId('detail-esun')).toHaveLength(0);
    });

    it('marks E.SUN aggregate deals, shows missing per-deal quantity and E.SUN metadata', async () => {
        h.meta.set('e1', { reservation: true, pendingReservation: false, workDate: '2026-11-06', orderDate: '2026-11-05', orderTime: '20:15:00', cancellable: false });
        h.trades = [trade('e1', {
            account: esun,
            order: { quantity: 6 },
            status: { status: 'PartFilled', deal_quantity: 4, deals: [deal(esunAggregateDealSeq('e1'), 1080, 2, 1_700_000_000), deal('m1', 1085, 1, 1_700_000_500)] },
        })];
        await render('e1');
        const deals = byTestId('detail-deal').map(text);
        expect(deals).toHaveLength(2);
        expect(deals.some(d => d.includes('彙總'))).toBe(true);
        expect(one('detail-missing')).toBe('另有 1 張 成交，券商未提供逐筆明細');
        expect(one('detail-esun-reservation')).toBe('預約 11/06');
        expect(one('detail-esun-cancellable')).toContain('券商標示不可刪');
        // 刪單一律提供（不因 celable 隱藏）
        expect(byTestId('detail-cancel-button')).toHaveLength(1);
    });

    it('shows 尚無成交 without deals', async () => {
        h.trades = [trade('o1')];
        await render('o1');
        expect(one('detail-no-deals')).toBe(ORDER_DETAIL_TEXT.noDeals);
        expect(one('detail-last-deal')).toBe('—');
    });

    it('actions only close the sheet and open the existing order action sheet', async () => {
        h.trades = [trade('o1')];
        await render('o1');
        expect(byTestId('detail-price-button')).toHaveLength(1);
        expect(byTestId('detail-qty-button')).toHaveLength(1);
        await act(async () => { byTestId('detail-cancel-button')[0]!.props.onClick(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(getMobileUi().orderAction).toMatchObject({ tradeId: 'o1', kind: 'cancel' });
        expect(m.cancelOrder).not.toHaveBeenCalled();
        expect(m.updatePrice).not.toHaveBeenCalled();
        expect(m.updateQty).not.toHaveBeenCalled();
    });

    it('follows the action rules: odd lots have no 改價; non-working orders have no actions', async () => {
        h.trades = [
            trade('o2', { order: { order_lot: 'IntradayOdd', quantity: 300 }, status: { order_quantity: 300 } }),
            trade('o3', { status: { status: 'Filled', deal_quantity: 5, deals: [deal('d1', 1080, 5, 1_700_000_100)] } }),
        ];
        await render('o2');
        expect(byTestId('detail-price-button')).toHaveLength(0);
        expect(byTestId('detail-qty-button')).toHaveLength(1);
        await render('o3');
        expect(byTestId('detail-cancel-button')).toHaveLength(0);
        expect(one('detail-gone')).toBe(ORDER_DETAIL_TEXT.gone);
    });

    it('keeps the last seen content when the order leaves the list, without actions', async () => {
        h.trades = [trade('o1')];
        await render('o1');
        h.trades = [];
        await render('o1');
        expect(one('detail-ordno')).toBe('Ao1');
        expect(byTestId('detail-cancel-button')).toHaveLength(0);
    });

    it('shows not found for an unknown order', async () => {
        await render('zz');
        expect(text(byTestId('order-detail-sheet')[0]!)).toContain(ORDER_DETAIL_TEXT.notFound);
    });

    it('lastDealTs returns the latest deal time', () => {
        expect(lastDealTs(trade('o1', { status: { deals: [deal('a', 1, 1, 5), deal('b', 1, 1, 9), deal('c', 1, 1, 7)] } }))).toBe(9);
        expect(lastDealTs(trade('o1'))).toBe(0);
    });
});
