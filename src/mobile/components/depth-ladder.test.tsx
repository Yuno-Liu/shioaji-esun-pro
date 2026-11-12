// 五檔（買賣同列；規格 §6.2）：第 i 列＝買 i＋賣 i、五檔總量、買賣比例條、內外盤比、
// 買價／賣價各自點擊（onPick 帶 side；缺省只帶價開下單面板）、「我 買2」標記、盤中零股（受控 oddLot＋DepthOddToggle）、ticket 變體、
// 字級「大」表頭縮寫的 DOM 結構
import { createElement, Fragment, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { AccountedTrade } from '../../lib/types/order';

const quoteMock = vi.hoisted(() => ({ useQuote: vi.fn() }));
vi.mock('../../hooks/use-stream', () => quoteMock);

const storeMock = vi.hoisted(() => ({ openTicket: vi.fn() }));
vi.mock('../lib/mobile-store', () => storeMock);

import * as tradeStyles from '../styles/trade.css';
import { DepthLadder, depthBook, depthMaxVolume, depthOddCapable, DepthOddToggle, type DepthLadderProps } from './depth-ladder';

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
/** 輔助技術讀得到的文字（略過 aria-hidden 子樹；表頭縮寫 span 為 aria-hidden） */
const fullText = (n: { children?: unknown }): string => {
    const kids = (n.children ?? []) as unknown[];
    return kids.map(k => {
        if (typeof k === 'string') return k;
        const node = k as { props?: Record<string, unknown>; children?: unknown };
        return node.props?.['aria-hidden'] === 'true' ? '' : fullText(node);
    }).join('');
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

/** 交易頁的用法：狀態在外層、DepthOddToggle（股票才顯示）＋受控 DepthLadder（oddLot） */
function Controlled(props: Omit<DepthLadderProps, 'oddLot'>) {
    const [odd, setOdd] = useState(false);
    return createElement(Fragment, null,
        depthOddCapable(props.contract) ? createElement(DepthOddToggle, { oddLot: odd, onChange: setOdd }) : null,
        createElement(DepthLadder, { ...props, oddLot: odd }));
}

async function renderControlled(trades: AccountedTrade[] = [], extra: Partial<Omit<DepthLadderProps, 'oddLot'>> = {}) {
    await act(async () => {
        view = create(createElement(Controlled, { code: '2330', contract, trades, ...extra }));
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

    it('沒有資料或全為空檔時 empty（價格 0 且量 0 才是空檔）', () => {
        expect(depthBook(undefined)).toMatchObject({ empty: true, bidTotal: 0, askTotal: 0 });
        expect(depthBook(undefined).rows).toHaveLength(5);
        expect(depthBook({ bid_price: ['0'], bid_volume: [0], ask_price: [], ask_volume: [] }).empty).toBe(true);
    });

    it('價格 0 且量 > 0 是排隊中的市價單：保留這一檔（market）、計入總量與最大量', () => {
        // 1785 光洋科鎖漲停的實際五檔：委買第 1 檔市價 3,350 張，委賣全空
        const book = depthBook({
            bid_price: ['0', '86.9', '86.8', '86.7', '86.6'], bid_volume: [3350, 1386, 9, 58, 25],
            ask_price: ['0', '0', '0', '0', '0'], ask_volume: [0, 0, 0, 0, 0],
        });
        expect(book.rows[0]?.bid).toEqual({ price: 0, volume: 3350, market: true });
        expect(book.rows[1]?.bid).toEqual({ price: 86.9, volume: 1386 });
        expect(book.rows.every(r => r.ask === null)).toBe(true);
        expect(book.bidTotal).toBe(4828);
        expect(book.askTotal).toBe(0);
        expect(book.empty).toBe(false);
        expect(depthMaxVolume(book)).toBe(3350);
        // 只有市價單也不是空的
        expect(depthBook({ bid_price: ['0'], bid_volume: [5], ask_price: [], ask_volume: [] }).empty).toBe(false);
    });
});

describe('DepthLadder 市價單', () => {
    it('市價那一檔顯示「市價」與量並計入五檔總量；不是按鈕、不可點，報讀完整說明', async () => {
        quoteMock.useQuote.mockImplementation(() => ({
            bidask: { ...BIDASK, bid_price: ['0', '984', '983', '982', '981'], bid_volume: [3350, 120, 76, 50, 40] },
            tick: TICK, lastDir: 0, seq: 1, flashSeq: 0,
        }));
        await render();
        const cell = byId('depth-bid-1');
        expect(cell.type).toBe('div');
        expect(cell.props['data-market']).toBe('true');
        expect(cell.props.onClick).toBeUndefined();
        expect(text(byId('depth-bid-1-market'))).toBe('市價');
        expect(fullText(cell)).toBe('委買第1檔 市價單，量 3,350 張');
        // 其餘有價格的檔位照常可點
        expect(byId('depth-bid-2').type).toBe('button');
        expect(text(byId('depth-total-bid'))).toBe('3,636');
        expect(storeMock.openTicket).not.toHaveBeenCalled();
    });

    it('委賣側的市價單同樣顯示「市價」（例如鎖跌停）', async () => {
        quoteMock.useQuote.mockImplementation(() => ({
            bidask: { ...BIDASK, bid_price: ['0', '0', '0', '0', '0'], bid_volume: [0, 0, 0, 0, 0], ask_price: ['0', '963', '964', '0', '0'], ask_volume: [1200, 800, 5, 0, 0] },
            tick: TICK, lastDir: 0, seq: 1, flashSeq: 0,
        }));
        await render();
        expect(byId('depth-ask-1').props['data-market']).toBe('true');
        expect(fullText(byId('depth-ask-1'))).toBe('委賣第1檔 市價單，量 1,200 張');
        expect(byId('depth-ask-2').type).toBe('button');
        expect(text(byId('depth-total-ask'))).toBe('2,005');
    });
});

describe('DepthLadder（page）', () => {
    it('表頭「委買量｜買價｜賣價｜委賣量」；5 列各含買與賣', async () => {
        await render();
        const head = view!.root.findAll(n => n.props['aria-hidden'] === 'true' && typeof n.type === 'string' && n.type === 'div')[0]!;
        expect(head.children.map(c => fullText(c as never))).toEqual(['委買量', '買價', '賣價', '委賣量']);
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

    it('內外盤比：有 bid_side／ask_side_total_vol 時顯示並以文字標示（內盤＝ask_side、外盤＝bid_side）', async () => {
        await render();
        expect(text(byId('depth-inner'))).toBe('42%（內盤）');
        expect(text(byId('depth-outer'))).toBe('58%（外盤）');
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
        await renderControlled();
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
        await renderControlled([trade('a', 984, 2), trade('odd', 983, 300, 'IntradayOdd')]);
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('2330', { oddLot: false });
        await act(async () => { byId('depth-odd-toggle').props.onClick(); });
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('2330', { oddLot: true });
        expect(allById('depth-mine').map(m => text(m))).toEqual(['我 買300']);
        expect(text(byId('depth-total'))).toContain('五檔總量（股）');
    });

    it('期貨不提供零股切換，量以口計', async () => {
        await act(async () => {
            view = create(createElement(Controlled, { code: 'TXFF6', contract: { ...contract, code: 'TXFF6', security_type: 'FUT' }, trades: [] }));
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
    // 設計規格 §7.3：ticket 變體也顯示內外盤比（原本「不顯示內外盤比」的斷言依規格移除，改由下方專門案例驗證）
    it('不顯示整股／零股切換，依 oddLot prop 訂閱', async () => {
        await render([], { variant: 'ticket', oddLot: true });
        expect(allById('depth-odd-toggle')).toHaveLength(0);
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

    it('B3b：ticket 變體也顯示內外盤比（文字標示內盤／外盤，比例條為 scaleX）', async () => {
        await render([], { variant: 'ticket', onPick: vi.fn() });
        expect(allById('depth-inner-outer')).toHaveLength(1);
        expect(text(byId('depth-inner'))).toBe('42%（內盤）');
        expect(text(byId('depth-outer'))).toBe('58%（外盤）');
        expect(byId('depth-inner-outer').props['aria-label']).toBe('內外盤比：內盤 42%，外盤 58%');
        const fills = byId('depth-inner-outer-bar').findAll(n => typeof n.type === 'string' && n.props.style !== undefined);
        expect(fills.map(f => f.props.style)).toEqual([{ transform: 'scaleX(0.42)' }, { transform: 'scaleX(0.58)' }]);
    });

    it('B3b：ticket 變體沒有內外盤量（或試撮）時仍隱藏內外盤比', async () => {
        quoteMock.useQuote.mockImplementation(() => ({ bidask: BIDASK, tick: { ...TICK, simtrade: true }, lastDir: 0, seq: 1, flashSeq: 0 }));
        await render([], { variant: 'ticket' });
        expect(allById('depth-inner-outer')).toHaveLength(0);
    });
});

describe('DepthLadder B3b 視覺（設計規格 §7.3）', () => {
    /** 格內帶 inline style 的量條 span（VolumeBar 是唯一帶 style 的節點） */
    const barOf = (id: string) => byId(id).findAll(n => n.type === 'span' && n.props.style !== undefined);

    it('depthMaxVolume：兩側最大單檔量', () => {
        expect(depthMaxVolume(depthBook(BIDASK))).toBe(120);
        expect(depthMaxVolume(depthBook(undefined))).toBe(0);
    });

    it('每格量條 scaleX(量 ÷ 五檔最大量)，aria-hidden；文字內容不變', async () => {
        await render();
        const [bid1] = barOf('depth-bid-1');
        expect(bid1!.props.style).toEqual({ transform: 'scaleX(1)' });
        expect(bid1!.props['aria-hidden']).toBe('true');
        expect(barOf('depth-ask-1')[0]!.props.style).toEqual({ transform: 'scaleX(0.7333)' });
        expect(barOf('depth-bid-5')[0]!.props.style).toEqual({ transform: 'scaleX(0.25)' });
        // 空檔沒有量條
        expect(barOf('depth-ask-5')).toHaveLength(0);
    });

    it('五檔買賣比例條改 scaleX（不再用 width）', async () => {
        await render();
        const styled = byId('depth-ratio').findAll(n => typeof n.type === 'string' && n.props.style !== undefined).map(n => n.props.style as Record<string, unknown>);
        expect(styled).toEqual([{ transform: 'scaleX(0.65)' }, { transform: 'scaleX(0.35)' }]);
        expect(styled.some(s => 'width' in s)).toBe(false);
    });

    it('整股／盤中零股改為 Segmented toggle（role=group、aria-pressed）', async () => {
        await renderControlled();
        const toggle = byId('depth-odd-toggle');
        const group = view!.root.findAll(n => n.type === 'div' && n.props.role === 'group')[0]!;
        expect(group.props['aria-label']).toContain('盤中零股');
        expect(toggle.props['aria-pressed']).toBe(false);
        await act(async () => { toggle.props.onClick(); });
        expect(byId('depth-odd-toggle').props['aria-pressed']).toBe(true);
    });

    it('S1：五檔每一格點價都只呼叫 openTicket（只帶價、不帶方向），不送單', async () => {
        await render();
        const cells = view!.root.findAll(n => n.type === 'button' && /^depth-(bid|ask)-\d$/.test(String(n.props['data-testid'] ?? '')));
        expect(cells).toHaveLength(9);
        for (const c of cells) await act(async () => { c.props.onClick(); });
        expect(storeMock.openTicket).toHaveBeenCalledTimes(9);
        for (const [arg] of storeMock.openTicket.mock.calls) {
            expect(arg).not.toHaveProperty('action');
            expect(arg).toMatchObject({ code: '2330', source: 'depth' });
        }
    });
});

describe('DepthLadder 受控整股／盤中零股（設計規格 §7.3：切換鍵移到交易頁「五檔｜明細」同列）', () => {
    it('page 變體本身不渲染切換鍵（ticket 亦同），整股／零股只看 oddLot prop', async () => {
        await render();
        expect(allById('depth-odd-toggle')).toHaveLength(0);
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('2330', { oddLot: false });
        await act(async () => { view!.update(createElement(DepthLadder, { code: '2330', contract, trades: [], oddLot: true })); });
        expect(allById('depth-odd-toggle')).toHaveLength(0);
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('2330', { oddLot: true });
        expect(text(byId('depth-total'))).toContain('五檔總量（股）');
        expect(byId('depth-ladder').props['data-variant']).toBe('page');
    });

    it('page 變體 oddLot=true：點零股五檔價格以盤中零股開下單面板（不帶方向）', async () => {
        await render([], { oddLot: true });
        await act(async () => { byId('depth-bid-2').props.onClick(); });
        expect(storeMock.openTicket.mock.calls).toEqual([[{ code: '2330', price: 983, source: 'depth', lot: 'IntradayOdd' }]]);
    });

    it('page 變體：期貨即使 oddLot=true 也是整股五檔（不帶 lot）', async () => {
        const fut = { ...contract, code: 'TXFF6', security_type: 'FUT' } as ContractInfo;
        await act(async () => { view = create(createElement(DepthLadder, { code: 'TXFF6', contract: fut, trades: [], oddLot: true })); });
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('TXFF6', { oddLot: false });
        await act(async () => { byId('depth-bid-1').props.onClick(); });
        expect(storeMock.openTicket.mock.calls[0]![0]).not.toHaveProperty('lot');
    });

    it('depthOddCapable：只有股票可切換（合約未載入為 false）', () => {
        expect(depthOddCapable(contract)).toBe(true);
        expect(depthOddCapable({ ...contract, security_type: 'FUT' } as ContractInfo)).toBe(false);
        expect(depthOddCapable({ ...contract, security_type: 'IND' } as ContractInfo)).toBe(false);
        expect(depthOddCapable(undefined)).toBe(false);
    });

    it('DepthOddToggle：Segmented toggle，testid 在「盤中零股」段，onChange 回報布林', async () => {
        const onChange = vi.fn();
        await act(async () => { view = create(createElement(DepthOddToggle, { oddLot: true, onChange })); });
        const group = view!.root.findAll(n => n.type === 'div' && n.props.role === 'group')[0]!;
        expect(group.props['aria-label']).toBe('五檔：整股或盤中零股');
        expect(text(byId('depth-odd-toggle'))).toBe('盤中零股');
        expect(byId('depth-odd-toggle').props['aria-pressed']).toBe(true);
        const whole = view!.root.findAll(n => n.type === 'button' && n.children.includes('整股'))[0]!;
        expect(whole.props['aria-pressed']).toBe(false);
        await act(async () => { whole.props.onClick(); });
        await act(async () => { byId('depth-odd-toggle').props.onClick(); });
        expect(onChange.mock.calls).toEqual([[false], [true]]);
    });
});

describe('DepthLadder 表頭縮寫（設計規格 §4.7：字級「大」以 html[data-sj-font-scale] 切換）', () => {
    const head = () => view!.root.findAll(n => n.props['aria-hidden'] === 'true' && typeof n.type === 'string' && n.type === 'div')[0]!;
    type Node = { type: unknown; props: Record<string, unknown>; children: (Node | string)[] };

    it('量欄同時渲染完整（depthHeadFull）與縮寫（depthHeadShort，aria-hidden）兩個 span；價欄不變', async () => {
        await render();
        const cells = head().children as unknown as Node[];
        expect(cells).toHaveLength(4);
        for (const [i, full, short] of [[0, '委買量', '買量'], [3, '委賣量', '賣量']] as const) {
            const cell = cells[i]! as unknown as { findAll(p: (n: Node) => boolean): Node[] };
            const [f, s] = cell.findAll(n => n.type === 'span' && n !== (cell as unknown));
            expect(f!.type).toBe('span');
            expect(f!.props.className).toBe(tradeStyles.depthHeadFull);
            expect(f!.props['aria-hidden']).toBeUndefined();
            expect(text(f!)).toBe(full);
            expect(s!.type).toBe('span');
            expect(s!.props.className).toBe(tradeStyles.depthHeadShort);
            expect(s!.props['aria-hidden']).toBe('true');
            expect(text(s!)).toBe(short);
            // 量欄 span 自己＋完整＋縮寫，沒有其他節點
            expect(cell.findAll(n => n.type === 'span')).toHaveLength(3);
        }
        expect(cells[1]!.children).toEqual(['買價']);
        expect(cells[2]!.children).toEqual(['賣價']);
    });

    it('輔助技術：表頭維持 aria-hidden，縮寫不進無障礙樹；每格 aria-label 仍是完整「委買／委賣…量」', async () => {
        await render();
        expect(head().props.className).toBe(tradeStyles.depthHead);
        expect(fullText(head())).toBe('委買量買價賣價委賣量');
        expect(byId('depth-bid-1').props['aria-label']).toMatch(/^委買第1檔 984，量 120 張/);
        expect(byId('depth-ask-1').props['aria-label']).toMatch(/^委賣第1檔 985，量 88 張/);
    });

    it('ticket 變體表頭結構相同（同一組 CSS 切換）', async () => {
        await render([], { variant: 'ticket', oddLot: false });
        expect(fullText(head())).toBe('委買量買價賣價委賣量');
        expect(view!.root.findAll(n => n.props.className === tradeStyles.depthHeadShort).map(n => text(n))).toEqual(['買量', '賣量']);
    });
});
