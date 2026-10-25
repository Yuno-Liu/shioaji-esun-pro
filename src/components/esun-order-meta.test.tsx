// 委託分頁的玉山掛鉤：預約標示與委託時間、預約單不提供改價改量（CANCEL 保留）、
// 永豐列不變、未送出錯誤的通知文字、玉山委託最新在上。測試資料全為合成值。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trade } from '../lib/types/order';
const mocks = vi.hoisted(() => ({ notify: vi.fn(), cancel: vi.fn(), price: vi.fn(), qty: vi.fn(), width: 1400 }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: mocks.cancel, cancelOrders: vi.fn(), updateOrderPrice: mocks.price, updateOrderQty: mocks.qty }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify }));
vi.mock('./bottom-dock-shared', async original => ({ ...await original<object>(), useMeasuredWidth: () => ({ ref: () => undefined, width: mocks.width }) }));
import { clearEsunOrderMeta, setEsunOrderMetaSnapshot, type EsunOrderMeta } from '../lib/esun/account-details';
import { OrderEditor, OrdersPane } from './bottom-dock-orders';
import { esunOrderMetaTitle, esunOrderTimeLabel, mutationErrorNotice } from './esun-order-meta';
import * as metaStyles from './esun-order-meta.css';

const ESUN = { broker_id: '8840', account_id: 'SYNTH001', account_type: 'S' };
const OTHER = { broker_id: 'BR', account_id: 'SYNTH002', account_type: 'S' };

function trade(id: string, code: string, account: typeof ESUN, status: Trade['status']['status'] = 'Submitted'): Trade {
    return {
        contract: { code },
        order: { id, action: 'Buy', price: 50, quantity: 2, price_type: 'LMT', order_type: 'ROD', order_lot: 'Common', account },
        status: { status, deal_quantity: 0, cancel_quantity: 0, msg: '', deals: [] },
    } as unknown as Trade;
}

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
let view: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T02:00:00Z')); // 台北 2026-10-27 10:00
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    mocks.width = 1400;
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    clearEsunOrderMeta();
    vi.useRealTimers();
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
/** 依代碼找出該列（寬版 tr、窄版卡片） */
function rowOf(code: string): ReactTestInstance {
    const rows = view!.root.findAll(n => (n.type === 'tr' || (n.type === 'div' && n.props.title === '點擊連動圖表與下單面板')) && n.props.onClick !== undefined);
    return rows.find(r => text(r).includes(code))!;
}
const buttonsOf = (row: ReactTestInstance) => row.findAllByType('button').map(b => text(b));

const meta = (over: Partial<EsunOrderMeta>): EsunOrderMeta => ({ reservation: false, pendingReservation: false, workDate: '', orderDate: '', orderTime: '', cancellable: null, ...over });

describe('時間與 tooltip 格式', () => {
    it('委託日不是台北今天時帶 MM/DD，今天只顯示時間', () => {
        expect(esunOrderTimeLabel(meta({ orderDate: '2026-10-26', orderTime: '20:15:30' }), '2026-10-27')).toBe('10/26 20:15:30');
        expect(esunOrderTimeLabel(meta({ orderDate: '2026-10-27', orderTime: '09:05:12' }), '2026-10-27')).toBe('09:05:12');
        expect(esunOrderTimeLabel(meta({}), '2026-10-27')).toBe('');
    });
    it('tooltip 列出委託日期時間、有效交易日、預約／盤中、券商可否取消', () => {
        const title = esunOrderMetaTitle(meta({ reservation: true, pendingReservation: true, workDate: '2026-10-28', orderDate: '2026-10-27', orderTime: '20:15:30', cancellable: false }));
        expect(title).toContain('委託日期時間 2026-10-27 20:15:30');
        expect(title).toContain('有效交易日 2026-10-28');
        expect(title).toContain('預約單（尚未進入盤中撮合');
        // 預約來源但已有委託書號：不再寫「尚未進入盤中撮合」
        const opened = esunOrderMetaTitle(meta({ reservation: true, pendingReservation: false }));
        expect(opened).toContain('預約單（已進入盤中撮合）');
        expect(opened).not.toContain('尚未進入盤中撮合');
        expect(title).toContain('券商可否取消 不可取消');
        expect(esunOrderMetaTitle(meta({ cancellable: null }))).toContain('券商可否取消 未提供');
        expect(esunOrderMetaTitle(meta({ cancellable: true }))).toContain('盤中單');
    });
});

describe('委託分頁的玉山列', () => {
    const rows = () => {
        setEsunOrderMetaSnapshot(ESUN, [
            { pre_ord_no: 'R0001', ord_no: '', ord_status: '1', work_date: '20261028', ord_date: '20261026', ord_time: '201530000', celable: '2' },
            { pre_ord_no: '', ord_no: 'N0002', ord_status: '2', work_date: '20261027', ord_date: '20261027', ord_time: '090512', celable: '1' },
        ]);
        return [
            trade('R0001', 'RSV1', ESUN, 'PreSubmitted'),
            trade('N0002', 'DAY1', ESUN),
            trade('P0003', 'PRE1', ESUN, 'PreSubmitted'), // 沒有中繼資料的玉山 PreSubmitted
            trade('S0004', 'SNP1', OTHER),
        ];
    };

    it.each([1400, 300])('寬度 %s：預約標示、委託時間與 tooltip', async width => {
        mocks.width = width;
        await mountPane(rows());
        const rsv = rowOf('RSV1');
        expect(text(rsv)).toContain('預約 10/28');
        expect(text(rsv)).toContain('10/26 20:15:30');
        const badge = rsv.find(n => typeof n.props.title === 'string' && n.props.title.includes('有效交易日'));
        expect(badge.props.title).toContain('券商可否取消 不可取消');
        expect(text(rowOf('DAY1'))).toContain('09:05:12');
        expect(text(rowOf('DAY1'))).not.toContain('預約');
        expect(text(rowOf('DAY1'))).not.toContain('10/27 09:05:12');
    });

    it('預約單不顯示改價、改量但保留 CANCEL（即使券商標示不可取消）；盤中單照常', async () => {
        await mountPane(rows());
        expect(buttonsOf(rowOf('RSV1'))).toEqual(['CANCEL']);
        expect(buttonsOf(rowOf('PRE1'))).toEqual(['CANCEL']);
        expect(buttonsOf(rowOf('DAY1'))).toEqual(['改價', '改量', 'CANCEL']);
        const cancel = rowOf('RSV1').findAllByType('button').find(b => text(b) === 'CANCEL')!;
        expect(cancel.props.disabled).toBe(false);
        mocks.cancel.mockResolvedValue(trade('R0001', 'RSV1', ESUN, 'Cancelled'));
        await act(async () => { await cancel.props.onClick({ stopPropagation: vi.fn() }); });
        expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('R0001');
    });

    it('預約來源但已取得委託書號：保留預約徽章，提供改價、改量與 CANCEL', async () => {
        setEsunOrderMetaSnapshot(ESUN, [
            { pre_ord_no: 'R0006', ord_no: 'N0006', ord_status: '1', work_date: '20261027', ord_date: '20261026', ord_time: '201530000', celable: '1' },
        ]);
        await mountPane([trade('R0006', 'OPN1', ESUN)]);
        const row = rowOf('OPN1');
        expect(text(row)).toContain('預約 10/27');
        expect(buttonsOf(row)).toEqual(['改價', '改量', 'CANCEL']);
        const badge = row.find(n => typeof n.props.title === 'string' && n.props.title.includes('有效交易日'));
        expect(badge.props.title).not.toContain('尚未進入盤中撮合');
    });

    it.each([1000, 1400])('寬度 %s（寬版委託表）：徽章限寬（可換行／省略），CANCEL 仍在同一列', async width => {
        mocks.width = width;
        await mountPane(rows());
        const rsv = rowOf('RSV1');
        expect(rsv.type).toBe('tr');
        const badge = rsv.find(n => typeof n.props.title === 'string' && n.props.title.includes('有效交易日'));
        expect(badge.props.className).toBe(metaStyles.meta);
        expect(text(rsv)).toContain('10/26 20:15:30');
        // CANCEL 與徽章在同一列、位於最後一欄
        const cells = rsv.findAllByType('td');
        expect(cells.at(-1)!.findAllByType('button').map(b => text(b))).toEqual(['CANCEL']);
        expect(buttonsOf(rowOf('DAY1')).at(-1)).toBe('CANCEL');
    });

    it('中等寬度：委託時間只放 tooltip，徽章仍顯示預約，CANCEL 仍在', async () => {
        mocks.width = 600;
        await mountPane(rows());
        const rsv = rowOf('RSV1');
        expect(rsv.type).toBe('tr');
        expect(text(rsv)).toContain('預約 10/28');
        expect(text(rsv)).not.toContain('20:15:30');
        const badge = rsv.find(n => typeof n.props.title === 'string' && n.props.title.includes('有效交易日'));
        expect(badge.props.title).toContain('委託日期時間 2026-10-26 20:15:30');
        expect(buttonsOf(rsv)).toEqual(['CANCEL']);
        expect(text(rowOf('DAY1'))).not.toContain('09:05:12');
        expect(buttonsOf(rowOf('DAY1'))).toEqual(['改價', '改量', 'CANCEL']);
    });

    it('永豐列不變：沒有玉山標示，PreSubmitted 也照常提供改價改量', async () => {
        const sinopacPre = trade('S0005', 'SNP2', OTHER, 'PreSubmitted');
        await mountPane([...rows(), sinopacPre]);
        const snp = rowOf('SNP1');
        expect(buttonsOf(snp)).toEqual(['改價', '改量', 'CANCEL']);
        expect(buttonsOf(rowOf('SNP2'))).toEqual(['改價', '改量', 'CANCEL']);
        expect(snp.findAll(n => typeof n.props.title === 'string' && n.props.title.includes('有效交易日'))).toHaveLength(0);
        expect(text(snp)).not.toContain('預約');
    });

    it('玉山委託（service 由舊到新）在委託分頁最新的在最上面', async () => {
        await mountPane([trade('A1', 'OLD1', ESUN), trade('A2', 'MID1', ESUN), trade('A3', 'NEW1', ESUN)]);
        const order = view!.root.findAllByType('tr').slice(1).map(r => ['OLD1', 'MID1', 'NEW1'].find(c => text(r).includes(c)));
        expect(order).toEqual(['NEW1', 'MID1', 'OLD1']);
    });

    it('刪單確定未送出時通知「刪單未送出」並顯示錯誤訊息', async () => {
        await mountPane(rows());
        mocks.cancel.mockRejectedValue(Object.assign(new Error('合成：未連線，這筆沒有送出'), { mutationNotStarted: true }));
        const cancel = rowOf('DAY1').findAllByType('button').find(b => text(b) === 'CANCEL')!;
        await act(async () => { await cancel.props.onClick({ stopPropagation: vi.fn() }); });
        expect(mocks.notify).toHaveBeenCalledWith({ kind: 'err', title: '刪單未送出', body: '合成：未連線，這筆沒有送出' });
    });
});

describe('改價／改量錯誤通知', () => {
    async function submitEditor(field: 'qty' | 'price', value: string) {
        await act(async () => { view = create(createElement(OrderEditor, { trade: trade('E1', 'EDIT', OTHER), field, onChanged: vi.fn() })); });
        await act(async () => view!.root.findByType('button').props.onClick());
        await act(async () => view!.root.findByType('input').props.onChange({ target: { value } }));
        await act(async () => view!.root.findByType('input').props.onKeyDown({ key: 'Enter' }));
    }

    it.each([['price', '51', '改價未送出'], ['qty', '1', '改量未送出']] as const)('%s：mutationNotStarted 時標題為未送出、內文為錯誤訊息', async (field, value, title) => {
        (field === 'price' ? mocks.price : mocks.qty).mockRejectedValue(Object.assign(new Error('合成：主視窗才能送出'), { mutationNotStarted: true }));
        await submitEditor(field, value);
        expect(mocks.notify).toHaveBeenCalledWith({ kind: 'err', title, body: '合成：主視窗才能送出' });
    });

    it('其他錯誤維持「失敗或結果未知、勿自動重送」', async () => {
        mocks.price.mockRejectedValue(new Error('合成：逾時'));
        await submitEditor('price', '51');
        expect(mocks.notify).toHaveBeenCalledWith({ kind: 'err', title: '改價失敗或結果未知', body: '合成：逾時；請手動更新委託確認，勿自動重送' });
    });

    it('mutationErrorNotice 只在 mutationNotStarted === true 時改用未送出', () => {
        expect(mutationErrorNotice(Object.assign(new Error('x'), { mutationNotStarted: 'yes' }), '刪單').title).toBe('刪單失敗或結果未知');
        expect(mutationErrorNotice('boom', '改量')).toEqual({ title: '改量失敗或結果未知', body: 'boom；請手動更新委託確認，勿自動重送' });
    });
});
