// 五檔（買賣同列；規格 §6.2）：第 i 列＝買 i＋賣 i、五檔總量、買賣比例條、內外盤比、
// 買價／賣價各自點擊（onPick 帶 side；缺省只帶價開下單面板）、「我 買2」標記、盤中零股切換、ticket 變體
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { AccountedTrade } from '../../lib/types/order';

const quoteMock = vi.hoisted(() => ({ useQuote: vi.fn() }));
vi.mock('../../hooks/use-stream', () => quoteMock);

const storeMock = vi.hoisted(() => ({ openTicket: vi.fn() }));
vi.mock('../lib/mobile-store', () => storeMock);

import { DepthLadder, depthBook, type DepthLadderProps } from './depth-ladder';

const BIDASK = {
    code: '2330',
    date: '2026/11/05',
    time: '10:00:00',
    bid_price: ['984', '983', '982', '981', '980'],
    bid_volume: [120, 76, 50, 40, 30],
    ask_price: ['985', '986', '987', '988', '0'],
    ask_volume: [88, 30, 45, 10, 0],
};

const TICK = { code: '2330', close: '985', volume: 3, total_volume: 1000, tick_type: 1, bid_side_total_vol: 580, ask_side_total_vol: 420 };

const contract = {
    exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 984, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as ContractInfo;

function trade(id: string, price: number, qty: number, lot?: string, action = 'Buy'): AccountedTrade {
    return {
        contract: { exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null },
        order: { id, seqno: '', ordno: '', action, price, quantity: qty, price_type: 'LMT', ...(lot ? { order_lot: lot } : {}) },
        status: { id, status: 'Submitted', status_code: '', order_quantity: qty, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, msg: '', deals: [] },
    } as AccountedTrade;
}

let view: ReactTestRenderer | undefined;
const text = (n: { children?: unknown }): string => {
    const kids = (n.children ?? []) as unknown[];
    return kids.map(k => (typeof k === 'string' ? k : text(k as { children?: unknown }))).join('');
};
const byId = (id: string) => view!.root.findByProps({ 'data-testid': id });
const allById = (id: string) => view!.root.findAllByProps({ 'data-testid': id });
const classOf = (id: string) => String(byId(id).findAll(n => typeof n.props.className === 'string' && n.props.className.includes('dirText'))[0]?.props.className ?? '');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    quoteMock.useQuote.mockReset();
    quoteMock.useQuote.mockImplementation(() => ({ bidask: BIDASK, tick: TICK, lastDir: 0, seq: 1, flashSeq: 0 }));
    storeMock.openTicket.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

async function render(trades: AccountedTrade[] = [], extra: Partial<DepthLadderProps> = {}) {
    await act(async () => {
        view = create(createElement(DepthLadder, { code: '2330', contract, trades, ...extra }));
    });
}

describe('depthBook', () => {
    it('固定 5 列，第 i 列＝買 i 與賣 i；價格 0 的空檔為 null；兩側總量', () => {
        const book = depthBook(BIDASK);
        expect(book.rows.map(r => `${r.level}:${r.bid?.price ?? '-'}/${r.ask?.price ?? '-'}`)).toEqual([
            '1:984/985', '2:983/986', '3:982/987', '4:981/988', '5:980/-',
        ]);
        expect(book.bidTotal).toBe(316);
        expect(book.askTotal).toBe(173);
        expect(book.empty).toBe(false);
    });

    it('沒有資料或全為空檔時 empty', () => {
        expect(depthBook(undefined)).toMatchObject({ empty: true, bidTotal: 0, askTotal: 0 });
        expect(depthBook(undefined).rows).toHaveLength(5);
        expect(depthBook({ bid_price: ['0'], bid_volume: [5], ask_price: [], ask_volume: [] }).empty).toBe(true);
    });
});

describe('DepthLadder（page）', () => {
    it('表頭「委買量｜買價｜賣價｜委賣量」；5 列各含買與賣', async () => {
        await render();
        const head = view!.root.findAll(n => n.props['aria-hidden'] === 'true' && typeof n.type === 'string' && n.type === 'div')[0]!;
        expect(head.children.map(c => text(c as never))).toEqual(['委買量', '買價', '賣價', '委賣量']);
        for (let i = 1; i <= 5; i++) {
            const row = byId(`depth-row-${i}`);
            expect(row.findAllByProps({ 'data-testid': `depth-bid-${i}` })).toHaveLength(1);
            expect(row.findAllByProps({ 'data-testid': `depth-ask-${i}` })).toHaveLength(1);
        }
        // 第 1 列：委買量 120、買價 984、賣價 985、委賣量 88（同一列）
        expect(text(byId('depth-row-1'))).toBe('12098498588');
        // 賣五為空檔：不是按鈕
        expect(byId('depth-ask-5').type).toBe('div');
        expect(byId('depth-bid-5').type).toBe('button');
    });

    it('價格相對參考價著色（參考 984：買一平、賣一漲、買二跌）', async () => {
        await render();
        expect(classOf('depth-bid-1')).toContain('flat');
        expect(classOf('depth-ask-1')).toContain('up');
        expect(classOf('depth-bid-2')).toContain('down');
    });

    it('第 6 列為五檔買賣總量，下方買賣比例條', async () => {
        await render();
        expect(text(byId('depth-total-bid'))).toBe('316');
        expect(text(byId('depth-total-ask'))).toBe('173');
        expect(text(byId('depth-total'))).toContain('五檔總量（張）');
        // 316 / 489 = 64.6% → 65 / 35
        expect(text(byId('depth-ratio-left'))).toBe('買 65%');
        expect(text(byId('depth-ratio-right'))).toBe('35% 賣');
    });

    it('內外盤比：有 bid_side／ask_side_total_vol 時顯示並以文字標示', async () => {
        await render();
        expect(text(byId('depth-inner'))).toBe('58%（內盤）');
        expect(text(byId('depth-outer'))).toBe('42%（外盤）');
    });

    it('內外盤比：沒有資料或全為 0 時隱藏', async () => {
        quoteMock.useQuote.mockImplementation(() => ({ bidask: BIDASK, tick: { ...TICK, bid_side_total_vol: undefined, ask_side_total_vol: undefined }, lastDir: 0, seq: 1, flashSeq: 0 }));
        await render();
        expect(allById('depth-inner-outer')).toHaveLength(0);
        await act(async () => { view!.unmount(); });
        quoteMock.useQuote.mockImplementation(() => ({ bidask: BIDASK, tick: { ...TICK, bid_side_total_vol: 0, ask_side_total_vol: 0 }, lastDir: 0, seq: 1, flashSeq: 0 }));
        await render();
        expect(allById('depth-inner-outer')).toHaveLength(0);
    });

    it('試撮 tick 不更新內外盤比（沿用上一筆真實成交；從未有真實成交則隱藏）', async () => {
        quoteMock.useQuote.mockImplementation(() => ({ bidask: BIDASK, tick: { ...TICK, simtrade: true }, lastDir: 0, seq: 1, flashSeq: 0 }));
        await render();
        expect(allById('depth-inner-outer')).toHaveLength(0);
    });

    it('點買價／賣價：缺省只帶價開下單面板（不帶買賣）', async () => {
        await render();
        await act(async () => { byId('depth-ask-1').props.onClick(); });
        await act(async () => { byId('depth-bid-2').props.onClick(); });
        expect(storeMock.openTicket.mock.calls).toEqual([
            [{ code: '2330', price: 985, source: 'depth' }],
            [{ code: '2330', price: 983, source: 'depth' }],
        ]);
        expect(storeMock.openTicket.mock.calls[0]![0]).not.toHaveProperty('action');
    });

    it('盤中零股模式點價：以盤中零股開下單面板（lot: IntradayOdd）；切回整股不帶 lot', async () => {
        await render();
        await act(async () => { byId('depth-odd-toggle').props.onClick(); });
        await act(async () => { byId('depth-ask-1').props.onClick(); });
        const whole = view!.root.findAll(n => n.type === 'button' && n.children.includes('整股'))[0]!;
        await act(async () => { whole.props.onClick(); });
        await act(async () => { byId('depth-bid-1').props.onClick(); });
        expect(storeMock.openTicket.mock.calls).toEqual([
            [{ code: '2330', price: 985, source: 'depth', lot: 'IntradayOdd' }],
            [{ code: '2330', price: 984, source: 'depth' }],
        ]);
    });

    it('有 onPick 時呼叫 onPick(price, side)，不開下單面板', async () => {
        const onPick = vi.fn();
        await render([], { onPick });
        await act(async () => { byId('depth-bid-1').props.onClick(); });
        await act(async () => { byId('depth-ask-3').props.onClick(); });
        expect(onPick.mock.calls).toEqual([[984, 'bid'], [987, 'ask']]);
        expect(storeMock.openTicket).not.toHaveBeenCalled();
    });

    it('自己的未成交委託標在價位所在的那一側（零股委託不標在整股五檔）', async () => {
        await render([trade('a', 984, 2), trade('s', 986, 1, undefined, 'Sell'), trade('odd', 983, 300, 'IntradayOdd')]);
        expect(allById('depth-mine').map(m => text(m))).toEqual(['我 買2', '我 賣1']);
        expect(text(byId('depth-bid-1'))).toContain('我 買2');
        expect(text(byId('depth-ask-1'))).not.toContain('我');
        expect(text(byId('depth-ask-2'))).toContain('我 賣1');
    });

    it('股票可切換盤中零股：改用 useQuote(code, { oddLot: true })，只標零股委託、量以股計', async () => {
        await render([trade('a', 984, 2), trade('odd', 983, 300, 'IntradayOdd')]);
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('2330', { oddLot: false });
        await act(async () => { byId('depth-odd-toggle').props.onClick(); });
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('2330', { oddLot: true });
        expect(allById('depth-mine').map(m => text(m))).toEqual(['我 買300']);
        expect(text(byId('depth-total'))).toContain('五檔總量（股）');
    });

    it('期貨不提供零股切換，量以口計', async () => {
        await act(async () => {
            view = create(createElement(DepthLadder, { code: 'TXFF6', contract: { ...contract, code: 'TXFF6', security_type: 'FUT' }, trades: [] }));
        });
        expect(allById('depth-odd-toggle')).toHaveLength(0);
        expect(text(byId('depth-total'))).toContain('五檔總量（口）');
    });

    it('沒有五檔：顯示提示，不顯示總量列與比例條', async () => {
        quoteMock.useQuote.mockImplementation(() => undefined);
        await render();
        expect(text(byId('depth-ladder'))).toContain('尚無五檔報價');
        expect(allById('depth-total')).toHaveLength(0);
        expect(allById('depth-ratio')).toHaveLength(0);
    });
});

describe('DepthLadder（ticket）', () => {
    it('不顯示整股／零股切換與內外盤比，依 oddLot prop 訂閱', async () => {
        await render([], { variant: 'ticket', oddLot: true });
        expect(allById('depth-odd-toggle')).toHaveLength(0);
        expect(allById('depth-inner-outer')).toHaveLength(0);
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('2330', { oddLot: true });
        expect(byId('depth-ladder').props['data-variant']).toBe('ticket');

        await act(async () => { view!.update(createElement(DepthLadder, { code: '2330', contract, trades: [], variant: 'ticket', oddLot: false })); });
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('2330', { oddLot: false });
    });

    it('期貨即使 oddLot=true 也不訂閱零股', async () => {
        await act(async () => {
            view = create(createElement(DepthLadder, { code: 'TXFF6', contract: { ...contract, code: 'TXFF6', security_type: 'FUT' }, trades: [], variant: 'ticket', oddLot: true }));
        });
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('TXFF6', { oddLot: false });
    });

    it('點價位呼叫 onPick(price, side)', async () => {
        const onPick = vi.fn();
        await render([], { variant: 'ticket', onPick });
        await act(async () => { byId('depth-ask-1').props.onClick(); });
        expect(onPick).toHaveBeenCalledWith(985, 'ask');
        expect(byId('depth-ask-1').props['aria-label']).toContain('帶入價格');
    });
});
