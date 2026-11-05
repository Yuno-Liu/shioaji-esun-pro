// 五檔價格梯（規格 §6.2）：賣五…賣一、買一…買五；點價位只帶價、不決定買賣；「我 買2」標記；盤中零股切換
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { AccountedTrade } from '../../lib/types/order';

const quoteMock = vi.hoisted(() => ({ useQuote: vi.fn() }));
vi.mock('../../hooks/use-stream', () => quoteMock);

const storeMock = vi.hoisted(() => ({ openTicket: vi.fn() }));
vi.mock('../lib/mobile-store', () => storeMock);

import { DepthLadder, depthLevels } from './depth-ladder';

const BIDASK = {
    code: '2330',
    date: '2026/11/05',
    time: '10:00:00',
    bid_price: ['1084', '1083', '1082', '1081', '1080'],
    bid_volume: [120, 76, 50, 40, 30],
    ask_price: ['1085', '1086', '1087', '1088', '0'],
    ask_volume: [88, 30, 45, 10, 0],
};

const contract = {
    exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 1070, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as ContractInfo;

function trade(id: string, price: number, qty: number, lot?: string): AccountedTrade {
    return {
        contract: { exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null },
        order: { id, seqno: '', ordno: '', action: 'Buy', price, quantity: qty, price_type: 'LMT', ...(lot ? { order_lot: lot } : {}) },
        status: { id, status: 'Submitted', status_code: '', order_quantity: qty, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, msg: '', deals: [] },
    };
}

let view: ReactTestRenderer | undefined;
const text = (n: { children?: unknown }): string => {
    const kids = (n.children ?? []) as unknown[];
    return kids.map(k => (typeof k === 'string' ? k : text(k as { children?: unknown }))).join('');
};

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    quoteMock.useQuote.mockReset();
    quoteMock.useQuote.mockImplementation(() => ({ bidask: BIDASK, lastDir: 0, seq: 1, flashSeq: 0 }));
    storeMock.openTicket.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

async function render(trades: AccountedTrade[] = []) {
    await act(async () => {
        view = create(createElement(DepthLadder, { code: '2330', contract, trades }));
    });
}

describe('depthLevels', () => {
    it('賣方由高到低在上、買方由高到低在下；價格 0 的空檔不列', () => {
        const levels = depthLevels(BIDASK);
        expect(levels.map(l => `${l.side}${l.level}:${l.price}`)).toEqual([
            'ask4:1088', 'ask3:1087', 'ask2:1086', 'ask1:1085',
            'bid1:1084', 'bid2:1083', 'bid3:1082', 'bid4:1081', 'bid5:1080',
        ]);
        expect(depthLevels(undefined)).toEqual([]);
    });
});

describe('DepthLadder', () => {
    it('點價位只帶價、不帶買賣方向', async () => {
        await render();
        const row = view!.root.findByProps({ 'data-testid': 'depth-ask-1' });
        await act(async () => { row.props.onClick(); });
        expect(storeMock.openTicket).toHaveBeenCalledWith({ code: '2330', price: 1085, source: 'depth' });
        expect(storeMock.openTicket.mock.calls[0]![0]).not.toHaveProperty('action');
    });

    it('自己的未成交委託標示「我 買2」（零股委託不標在整股五檔）', async () => {
        await render([trade('a', 1084, 2), trade('odd', 1083, 300, 'IntradayOdd')]);
        const marks = view!.root.findAllByProps({ 'data-testid': 'depth-mine' });
        expect(marks.map(m => text(m))).toEqual(['我 買2']);
        expect(text(view!.root.findByProps({ 'data-testid': 'depth-bid-1' }))).toContain('我 買2');
    });

    it('股票可切換盤中零股：改用 useQuote(code, { oddLot: true })，只標零股委託', async () => {
        await render([trade('a', 1084, 2), trade('odd', 1083, 300, 'IntradayOdd')]);
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('2330', { oddLot: false });
        await act(async () => { view!.root.findByProps({ 'data-testid': 'depth-odd-toggle' }).props.onClick(); });
        expect(quoteMock.useQuote).toHaveBeenLastCalledWith('2330', { oddLot: true });
        const marks = view!.root.findAllByProps({ 'data-testid': 'depth-mine' });
        expect(marks.map(m => text(m))).toEqual(['我 買300']);
    });

    it('期貨不提供零股切換', async () => {
        await act(async () => {
            view = create(createElement(DepthLadder, { code: 'TXFF6', contract: { ...contract, code: 'TXFF6', security_type: 'FUT' }, trades: [] }));
        });
        expect(view!.root.findAllByProps({ 'data-testid': 'depth-odd-toggle' })).toHaveLength(0);
    });
});
