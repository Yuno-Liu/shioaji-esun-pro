// 自選頁「持倉」分段（components/holdings-list.tsx）：
// - 合併：依「商品類別（股票／期權帳戶）＋代碼」合併；多帳戶、多條件（現股＋融資）只一列；期貨、選擇權各自一列。
// - 標記：第一筆的「條件 方向」「數量」（遮蔽金額時遮蔽）＋「等 N 筆」；期權依合約別顯示期貨／選擇權。
// - 排序：第一次出現的順序；持倉增減時動態更新；只有現價變動時不重算。
// - 狀態：讀取中 Skeleton、沒有持倉 EmptyState、第一次就失敗與待對帳 InlineNote＋「前往持倉頁」（只 navigate）。
// - 互動：點列開交易頁；長按面板只有開啟交易頁、買進…、賣出…；快速下單鍵只呼叫 openTicket；沒有任何編輯入口。
// - 請求：不觸發持倉讀取（refreshTradingState 0 次）、不解析合約、不讀處置名單、不發任何 lib 請求（走勢關閉時）。
// - S1：送單、改單、刪單函式與 openOrderAction 0 次。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountedPosition } from '../../lib/types/portfolio';

const m = vi.hoisted(() => ({
    state: {} as Record<string, unknown>,
    listeners: new Set<() => void>(),
    contracts: new Map<string, Record<string, unknown>>(),
    priv: false,
    navigate: vi.fn(),
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    refreshTradingState: vi.fn(),
    ensureContract: vi.fn(),
    apiGet: vi.fn(),
    useQuote: vi.fn(() => undefined),
    shioaji: {
        fetchKbars: vi.fn(),
        fetchSnapshots: vi.fn(),
        fetchPositions: vi.fn(),
        resolveContract: vi.fn(),
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelOrders: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
    },
    trade: { placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn(), cancelAllOrders: vi.fn() },
}));

vi.mock('../../lib/trading-state', async () => {
    const { useSyncExternalStore } = await import('react');
    return {
        useTradingState: () => useSyncExternalStore(l => { m.listeners.add(l); return () => { m.listeners.delete(l); }; }, () => m.state),
        refreshTradingState: m.refreshTradingState,
        RECONCILE_REASON_LABELS: { 'query-failed': '查詢失敗', 'unknown-fill': '無法辨識的成交' },
    };
});
vi.mock('../../lib/contracts-cache', () => ({
    useContract: (code: string | null) => (code ? m.contracts.get(code) : undefined),
    ensureContract: m.ensureContract,
    getCachedContract: (code: string) => m.contracts.get(code),
}));
vi.mock('../../lib/privacy', () => ({ usePrivacyMoney: () => m.priv, maskMoney: (t: string, p: boolean) => (p ? '•••••' : t) }));
vi.mock('../../hooks/use-stream', () => ({ useQuote: m.useQuote }));
vi.mock('../../lib/shioaji', () => m.shioaji);
vi.mock('../../lib/trade', () => ({ ...m.trade, notify: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiGet: m.apiGet }));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));
vi.mock('../lib/mobile-store', () => ({ openTicket: m.openTicket, openOrderAction: m.openOrderAction }));
vi.mock('../motion/haptics', () => ({ haptic: vi.fn(() => false) }));

import { resetWatchPrefsForTest, setWatchSparklineEnabled } from '../lib/watch-prefs';
import { BottomSheet } from './bottom-sheet';
import { holdingTagParts, HoldingsList, mergeHoldings } from './holdings-list';

class FakeIO {
    observe() { /* 不需要可見度 */ }
    unobserve() { /* 不需要可見度 */ }
    disconnect() { /* 不需要可見度 */ }
}

const S1 = { account_type: 'S', broker_id: '9A95', account_id: '0001', person_id: 'A1', username: 'u', signed: true };
const S2 = { account_type: 'S', broker_id: '9A95', account_id: '0002', person_id: 'A1', username: 'u', signed: true };
const F1 = { account_type: 'F', broker_id: 'F002', account_id: '0009', person_id: 'A1', username: 'u', signed: true };
const stock = (code: string, quantity: number, cond = 'Cash', account: object = S1, direction: 'Buy' | 'Sell' = 'Buy') =>
    ({ id: 1, code, direction, quantity, price: 100, last_price: 101, pnl: 1000, yd_quantity: quantity, cond, account }) as unknown as AccountedPosition;
const deriv = (code: string, quantity: number, direction: 'Buy' | 'Sell' = 'Buy') =>
    ({ id: 2, code, direction, quantity, price: 20000, last_price: 20010, pnl: 2000, account: F1 }) as unknown as AccountedPosition;
const contract = (code: string, name: string, security_type: string, exchange = 'TSE') => ({ code, name, security_type, exchange, reference: 100, target_code: null });

const query = (over: Record<string, unknown> = {}) => ({ updatedAt: 1, loading: false, needsReconcile: false, error: null, reasons: [], ...over });
const setTrading = (positions: AccountedPosition[], q: Record<string, unknown> = query()) => {
    m.state = { positions, trades: [], queries: { positions: q, orders: query(), account: query() } };
    m.listeners.forEach(l => l());
};

let view: ReactTestRenderer | undefined;
const onOpen = vi.fn();
const render = () => act(async () => { view = create(createElement(HoldingsList, { metric: 'pct', onOpen })); });
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const rowCodes = () => all('holding-row').map(r => r.props['data-code'] as string);
const rowOf = (code: string) => all('holding-row').find(r => r.props['data-code'] === code)!;
const tagsOf = (code: string) => rowOf(code).findAll(n => n.props['data-testid'] === 'holding-tag' && typeof n.type === 'string').map(textOf);
const inRow = (code: string, id: string) => rowOf(code).findAll(n => n.props['data-testid'] === id && typeof n.type === 'string')[0]!;
const sheet = () => view!.root.findAll(n => n.type === BottomSheet && n.props.testId === 'holding-actions')[0]!;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', FakeIO);
    resetWatchPrefsForTest();
    setWatchSparklineEnabled(false);
    m.priv = false;
    m.contracts.clear();
    m.contracts.set('2330', contract('2330', '台積電', 'STK'));
    m.contracts.set('2317', contract('2317', '鴻海', 'STK'));
    m.contracts.set('TXFL6', contract('TXFL6', '臺股期貨', 'FUT', 'TAIFEX'));
    m.contracts.set('TXO20000L6', contract('TXO20000L6', '臺指選擇權', 'OPT', 'TAIFEX'));
    for (const f of [m.navigate, m.openTicket, m.openOrderAction, m.refreshTradingState, m.ensureContract, m.apiGet, m.useQuote, onOpen]) f.mockClear();
    for (const f of [...Object.values(m.shioaji), ...Object.values(m.trade)]) f.mockClear();
    setTrading([]);
});
afterEach(async () => {
    // 請求：不觸發持倉讀取、不解析合約、不讀處置名單、不發 lib 請求
    expect(m.refreshTradingState).not.toHaveBeenCalled();
    expect(m.ensureContract).not.toHaveBeenCalled();
    expect(m.apiGet).not.toHaveBeenCalled();
    for (const [k, f] of Object.entries(m.shioaji)) expect(f, k).not.toHaveBeenCalled();
    // S1
    for (const [k, f] of Object.entries(m.trade)) expect(f, k).not.toHaveBeenCalled();
    expect(m.openOrderAction).not.toHaveBeenCalled();
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('mergeHoldings／holdingTagParts', () => {
    it('多帳戶、多條件只一列（第一次出現的順序）；期貨、選擇權各自一列', () => {
        const rows = mergeHoldings([
            stock('2330', 2000), deriv('TXFL6', 1), stock('2317', 500), stock('2330', 1000, 'MarginTrading'),
            stock('2330', 3000, 'Cash', S2), deriv('TXO20000L6', 2, 'Sell'), deriv('TXFL6', 3),
        ]);
        expect(rows.map(h => [h.key, h.positions.length])).toEqual([
            ['S:2330', 3], ['F:TXFL6', 2], ['S:2317', 1], ['F:TXO20000L6', 1],
        ]);
    });

    it('標記：條件 方向／數量／等 N 筆；期權依合約別；遮蔽金額時遮蔽數量', () => {
        const [tsmc, tx, hon, opt] = mergeHoldings([
            stock('2330', 2000), stock('2330', 1000, 'MarginTrading'), deriv('TXFL6', 1), stock('2317', 1500, 'ShortSelling', S1, 'Sell'), deriv('TXO20000L6', 2, 'Sell'),
        ]);
        expect(holdingTagParts(tsmc!, { security_type: 'STK' }, false)).toEqual(['現股 多', '2張', '等 2 筆']);
        expect(holdingTagParts(tx!, { security_type: 'FUT' }, false)).toEqual(['期貨 多', '1 口']);
        expect(holdingTagParts(hon!, { security_type: 'STK' }, false)).toEqual(['融券 空', '1張+500股']);
        expect(holdingTagParts(opt!, { security_type: 'OPT' }, false)).toEqual(['選擇權 空', '2 口']);
        expect(holdingTagParts(opt!, undefined, false)).toEqual(['期權 空', '2 口']);
        expect(holdingTagParts(tsmc!, { security_type: 'STK' }, true)).toEqual(['現股 多', '•••••', '等 2 筆']);
    });
});

describe('HoldingsList', () => {
    it('讀取中 Skeleton；沒有持倉 EmptyState；持倉出現、增減時動態更新（順序＝第一次出現）', async () => {
        setTrading([], query({ updatedAt: null }));
        await render();
        expect(all('holdings-loading')).toHaveLength(1);
        await act(async () => { setTrading([]); });
        expect(textOf(all('holdings-empty')[0]!)).toContain('目前沒有持倉');
        await act(async () => { setTrading([stock('2317', 1000), stock('2330', 2000)]); });
        expect(rowCodes()).toEqual(['2317', '2330']);
        await act(async () => { setTrading([stock('2317', 1000), stock('2330', 2000), deriv('TXFL6', 1)]); });
        expect(rowCodes()).toEqual(['2317', '2330', 'TXFL6']);
        await act(async () => { setTrading([stock('2330', 2000), deriv('TXFL6', 1)]); });
        expect(rowCodes()).toEqual(['2330', 'TXFL6']);
        await act(async () => { setTrading([]); });
        expect(all('holdings-list')).toHaveLength(0);
        expect(all('holdings-empty')).toHaveLength(1);
    });

    it('列：名稱、市場標記、持倉標記（含遮蔽），無障礙名稱附持倉；列尾快速下單鍵；沒有任何編輯入口', async () => {
        setTrading([stock('2330', 2000), stock('2330', 1000, 'MarginTrading', S2), deriv('TXO20000L6', 2, 'Sell')]);
        await render();
        expect(textOf(inRow('2330', 'holding-name'))).toBe('台積電');
        expect(textOf(inRow('2330', 'holding-market'))).toBe('市');
        expect(tagsOf('2330')).toEqual(['現股 多', '2張', '等 2 筆']);
        expect(tagsOf('TXO20000L6')).toEqual(['選擇權 空', '2 口']);
        expect(String(inRow('2330', 'holding-row-button').props['aria-label'])).toContain('，持倉 現股 多 2張 等 2 筆');
        expect(all('holding-row-ticket')).toHaveLength(2);
        for (const id of ['watch-row-remove', 'watch-row-grip', 'watch-more', 'watch-edit', 'watch-multi', 'watch-list-add']) expect(all(id), id).toHaveLength(0);
        await act(async () => view!.unmount());
        m.priv = true;
        await render();
        expect(tagsOf('2330')).toEqual(['現股 多', '•••••', '等 2 筆']);
        expect(String(inRow('2330', 'holding-row-button').props['aria-label'])).toContain('，持倉 現股 多 ••••• 等 2 筆');
    });

    it('只有現價變動（tick）時不重算列；合約未載入時不顯示快速下單鍵', async () => {
        m.contracts.delete('2317');
        const a = stock('2330', 2000);
        setTrading([a, stock('2317', 1000)]);
        await render();
        const before = rowOf('2330');
        await act(async () => { setTrading([{ ...a, last_price: 999 } as AccountedPosition, stock('2317', 1000)]); });
        expect(rowOf('2330')).toBe(before);
        expect(inRow('2317', 'holding-row-ticket-spacer')).toBeTruthy();
        expect(textOf(inRow('2317', 'holding-name'))).toBe('2317');
    });

    it('第一次讀取就失敗：InlineNote（不說沒有持倉）＋「前往持倉頁」只 navigate；有資料但待對帳：警示＋列', async () => {
        setTrading([], query({ updatedAt: null, error: 'boom' }));
        await render();
        expect(all('holdings-empty')).toHaveLength(0);
        expect(all('holdings-loading')).toHaveLength(0);
        expect(textOf(all('holdings-reconcile')[0]!)).toContain('持倉查詢失敗');
        await act(async () => { all('holdings-to-positions')[0]!.props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'positions' });
        await act(async () => { setTrading([stock('2330', 1000)], query({ needsReconcile: true, reasons: ['unknown-fill'] })); });
        expect(textOf(all('holdings-reconcile')[0]!)).toContain('待對帳：無法辨識的成交');
        expect(rowCodes()).toEqual(['2330']);
    });

    it('點列開交易頁；長按面板只有開啟交易頁、買進…、賣出…；買賣與快速下單只呼叫 openTicket', async () => {
        setTrading([stock('2330', 2000)]);
        await render();
        await act(async () => { inRow('2330', 'holding-row-button').props.onClick(); });
        expect(onOpen).toHaveBeenCalledWith('2330');
        await act(async () => { inRow('2330', 'holding-row-ticket').props.onClick(); });
        expect(m.openTicket).toHaveBeenLastCalledWith({ code: '2330', source: 'other' });
        // 長按（contextmenu）→ 操作面板；長按後的那次 click 被列吞掉（不開交易頁）
        const longPress = async (code: string) => {
            await act(async () => { inRow(code, 'holding-row-button').props.onContextMenu({ preventDefault: vi.fn() }); });
            await act(async () => { inRow(code, 'holding-row-button').props.onClick(); });
        };
        await longPress('2330');
        expect(sheet().props.open).toBe(true);
        expect(sheet().props.title).toBe('2330 台積電');
        const rows = sheet().findAll(n => typeof n.type === 'string' && String(n.props['data-testid'] ?? '').startsWith('holding-action-'));
        expect(rows.map(r => r.props['data-testid'])).toEqual(['holding-action-open', 'holding-action-buy', 'holding-action-sell']);
        expect(textOf(sheet())).not.toMatch(/移除|上移|下移|移到最上/);
        const btnIn = (id: string) => all(id)[0]!.findAll(n => n.type === 'button')[0]!;
        await act(async () => { btnIn('holding-action-buy').props.onClick(); });
        expect(m.openTicket).toHaveBeenLastCalledWith({ code: '2330', action: 'Buy', source: 'other' });
        expect(sheet().props.open).toBe(false);
        await longPress('2330');
        await act(async () => { btnIn('holding-action-sell').props.onClick(); });
        expect(m.openTicket).toHaveBeenLastCalledWith({ code: '2330', action: 'Sell', source: 'other' });
        await longPress('2330');
        await act(async () => { btnIn('holding-action-open').props.onClick(); });
        expect(onOpen).toHaveBeenLastCalledWith('2330');
        expect(sheet().props.open).toBe(false);
    });
});
