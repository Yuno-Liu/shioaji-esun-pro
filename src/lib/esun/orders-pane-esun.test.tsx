// 委託分頁的玉山部分成交（RC1）：fromEsunOrderResult 轉出的 PartFilled 3/2 留在「有效」並提供改價、改量與
// CANCEL；Filled 3/3 在「已成交」且沒有刪改單。測試資料全為合成值。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types/order';
import type { Account } from '../types/portfolio';
vi.mock('../shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn(), updateOrderPrice: vi.fn(), updateOrderQty: vi.fn() }));
vi.mock('../trade', () => ({ notify: vi.fn() }));
vi.mock('../../components/bottom-dock-shared', async original => ({ ...await original<object>(), useMeasuredWidth: () => ({ ref: () => undefined, width: 1400 }) }));
import { OrdersPane } from '../../components/bottom-dock-orders';
import { fromEsunOrderResult } from './order-mapping';
import type { EsunOrderResult } from './types';

const ESUN: Account = { account_type: 'S', broker_id: '8840', account_id: 'SYNTH001', signed: true, username: '', person_id: '' };

/** bridge 委託列：整股 3 張 */
function esunRow(ordNo: string, code: string, matLots: number, over: Record<string, unknown> = {}): Trade {
    return fromEsunOrderResult({
        ord_no: ordNo, pre_ord_no: '', stock_no: code, buy_sell: 'B', ap_code: '1', price_flag: '0', bs_flag: 'R', trade: '0',
        od_price: 25.5, org_qty: 3, org_qty_share: 3000, mat_qty: matLots, mat_qty_share: matLots * 1000, cel_qty: 0, cel_qty_share: 0,
        avg_price: matLots ? 25.5 : 0, ord_date: '20261027', ord_time: '090512000', ...over,
    } as EsunOrderResult, ESUN)!;
}

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
let view: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

async function mountPane(trades: Trade[]) {
    await act(async () => {
        view = create(createElement(OrdersPane, {
            trades, initialStatus: 'ready', mode: 'merged', market: 'all', scopeKey: '',
            fallback: { stock: null, futures: null }, onChanged: vi.fn(), onSelectCode: vi.fn(),
        }));
    });
}
const rows = () => view!.root.findAll(n => n.type === 'tr' && n.props.onClick !== undefined);
const rowOf = (code: string) => rows().find(r => text(r).includes(code));
const buttonsOf = (row: ReactTestInstance) => row.findAllByType('button').map(b => text(b));
const chip = (label: string) => view!.root.findAllByType('button').find(b => text(b).startsWith(`${label} `))!;

describe('委託分頁的玉山部分成交（RC1）', () => {
    it('PartFilled 3/2 留在「有效」並有改價、改量與 CANCEL；Filled 3/3 在「已成交」', async () => {
        const part = esunRow('C0001', 'PART1', 2);
        const filled = esunRow('C0002', 'FULL1', 3);
        expect(part.status).toMatchObject({ status: 'PartFilled', deal_quantity: 2 });
        expect(filled.status).toMatchObject({ status: 'Filled', deal_quantity: 3 });
        await mountPane([part, filled]);
        // 預設篩選「有效」
        expect(text(chip('有效'))).toBe('有效 1');
        expect(text(chip('已成交'))).toBe('已成交 1');
        expect(rowOf('PART1')).toBeDefined();
        expect(rowOf('FULL1')).toBeUndefined();
        expect(text(rowOf('PART1')!)).toContain('未成交 1');
        expect(buttonsOf(rowOf('PART1')!)).toEqual(['改價', '改量', 'CANCEL']);
        // 已成交
        await act(async () => { chip('已成交').props.onClick(); });
        expect(rowOf('PART1')).toBeUndefined();
        expect(rowOf('FULL1')).toBeDefined();
        expect(buttonsOf(rowOf('FULL1')!)).toEqual([]);
    });

    it('數量矛盾（bridge 截到委託量、附原始股數）的列以原始成交量顯示，留在「有效」並保留 CANCEL', async () => {
        const held = esunRow('C0003', 'HOLD1', 3, {
            esun_quantity_conflict: { mat: { reason: 'exceeds_order', report_shares: 4000, org_shares: 3000, raw_shares: 2000 } } });
        expect(held.status).toMatchObject({ status: 'PartFilled', deal_quantity: 2 });
        await mountPane([held]);
        expect(text(chip('有效'))).toBe('有效 1');
        expect(text(rowOf('HOLD1')!)).toContain('未成交 1');
        expect(buttonsOf(rowOf('HOLD1')!)).toContain('CANCEL');
    });
});
