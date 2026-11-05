// 交易頁（規格 §6.2）：標頭文字、持倉摘要（遮金額）、未成交筆數、買進／賣出只開下單面板
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { AccountedTrade } from '../../lib/types/order';
import type { AccountedPosition } from '../../lib/types/portfolio';

const m = vi.hoisted(() => ({
    useQuote: vi.fn(),
    useContract: vi.fn(),
    ensureContract: vi.fn(),
    useTradingState: vi.fn(),
    usePrivacyMoney: vi.fn(() => false),
    openTicket: vi.fn(),
    setCurrentCode: vi.fn(),
    navigate: vi.fn(),
    fetchSnapshots: vi.fn(),
    snapshot: undefined as unknown,
    snapshotListeners: new Set<() => void>(),
    chartProps: [] as unknown[],
}));
vi.mock('../../hooks/use-stream', () => ({ useQuote: m.useQuote }));
vi.mock('../../lib/contracts-cache', () => ({ useContract: m.useContract, ensureContract: m.ensureContract }));
vi.mock('../../lib/trading-state', () => ({ useTradingState: m.useTradingState }));
vi.mock('../../lib/privacy', () => ({ usePrivacyMoney: m.usePrivacyMoney, maskMoney: (t: string, p: boolean) => (p ? '•••••' : t) }));
vi.mock('../lib/mobile-store', () => ({ openTicket: m.openTicket, setCurrentCode: m.setCurrentCode }));
vi.mock('../components/trade-chart', () => ({ TradeChart: (props: unknown) => { m.chartProps.push(props); return null; } }));
vi.mock('../components/tick-list', () => ({ TickList: () => null }));
vi.mock('../../lib/shioaji', () => ({ fetchSnapshots: m.fetchSnapshots }));
vi.mock('../../lib/market-snapshot-store', () => ({
    getMarketSnapshot: () => m.snapshot,
    subscribeMarketSnapshots: (l: () => void) => { m.snapshotListeners.add(l); return () => { m.snapshotListeners.delete(l); }; },
}));
vi.mock('../lib/hash-router', async importOriginal => ({ ...(await importOriginal<typeof import('../lib/hash-router')>()), navigate: m.navigate }));

import { dayTradeText, deliveryMonthText, positionSummaries, sessionText, TradePage, workingOrderCount } from './trade-page';

const stock = {
    exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 1070, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as ContractInfo;

function trade(id: string, code: string, over: Partial<{ target: string; deal: number; priceType: string }> = {}): AccountedTrade {
    return {
        contract: { exchange: 'TSE', code, security_type: 'STK', target_code: over.target ?? null },
        order: { id, seqno: '', ordno: '', action: 'Buy', price: 1080, quantity: 2, price_type: over.priceType ?? 'LMT' },
        status: { id, status: 'Submitted', status_code: '', order_quantity: 2, deal_quantity: over.deal ?? 0, cancel_quantity: 0, modified_price: 0, msg: '', deals: [] },
    };
}
const pos = (code: string, quantity: number, price: number, pnl: number, extra: Record<string, unknown> = {}) =>
    ({ id: 1, code, direction: 'Buy', quantity, price, last_price: price, pnl, yd_quantity: 0, ...extra }) as AccountedPosition;

let view: ReactTestRenderer | undefined;
const text = (n: { children?: unknown }): string =>
    ((n.children ?? []) as unknown[]).map(k => (typeof k === 'string' ? k : text(k as { children?: unknown }))).join('');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.useQuote.mockReset().mockReturnValue({ tick: { code: '2330', close: '1085', price_chg: '15', pct_chg: '1.4', total_volume: 23456 } });
    m.useContract.mockReset().mockReturnValue(stock);
    m.ensureContract.mockReset().mockResolvedValue(stock);
    m.useTradingState.mockReset().mockReturnValue({
        trades: [trade('a', '2330'), trade('b', '2330', { priceType: 'MKT' }), trade('c', '2317'), trade('d', '2330', { deal: 2 })],
        positions: [pos('2330', 3000, 1052.5, 97500, { cond: 'Cash' })],
    });
    m.usePrivacyMoney.mockReset().mockReturnValue(false);
    m.openTicket.mockReset();
    m.setCurrentCode.mockReset();
    m.navigate.mockReset();
    m.fetchSnapshots.mockReset().mockResolvedValue([]);
    m.snapshot = undefined;
    m.snapshotListeners.clear();
    m.chartProps.length = 0;
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

async function render(code: string | null = '2330') {
    await act(async () => { view = create(createElement(TradePage, { code })); });
}
const byId = (id: string) => view!.root.findByProps({ 'data-testid': id });

describe('header helpers', () => {
    it('當沖、到期月份、時段文字', () => {
        expect(dayTradeText('Yes')).toBe('可當沖');
        expect(dayTradeText('No')).toBe('不可當沖');
        expect(dayTradeText('')).toBeNull();
        expect(deliveryMonthText('202612')).toBe('2026/12');
        expect(deliveryMonthText(undefined)).toBeNull();
        expect(sessionText('FUT', 10 * 3600)).toBe('日盤 08:45–13:45');
        expect(sessionText('FUT', 20 * 3600)).toBe('夜盤 15:00–05:00');
        expect(sessionText('STK', 10 * 3600)).toBe('日盤 09:00–13:30');
    });

});

describe('positionSummaries／workingOrderCount', () => {
    it('依信用條件分列並加權均價；期貨以實際月份比對', () => {
        const rows = positionSummaries('2330', '2330', [pos('2330', 2000, 1050, 100, { cond: 'Cash' }), pos('2330', 1000, 1057.5, 50, { cond: 'Cash' }), pos('2330', 1000, 1000, 9, { cond: 'MarginTrading' })], true);
        expect(rows).toEqual([
            { label: '現股', quantity: '3張', avg: 1052.5, pnl: 150 },
            { label: '融資', quantity: '1張', avg: 1000, pnl: 9 },
        ]);
        expect(positionSummaries('TXFF6', 'TXFR1', [pos('TXFF6', 2, 22400, 0)], false)).toEqual([{ label: '多單', quantity: '2 口', avg: 22400, pnl: 0 }]);
    });

    it('現股當沖先賣（Cash＋Sell）標「現股空（當沖）」，與現股多單分列不合併', () => {
        expect(positionSummaries('2330', '2330', [pos('2330', 1000, 1085, 500, { cond: 'Cash', direction: 'Sell' })], true))
            .toEqual([{ label: '現股空（當沖）', quantity: '1張', avg: 1085, pnl: 500 }]);
        const rows = positionSummaries('2330', '2330', [
            pos('2330', 1000, 1050, 100, { cond: 'Cash' }),
            pos('2330', 1000, 1085, -20, { cond: 'Cash', direction: 'Sell' }),
            pos('2330', 1000, 1060, 0, { direction: 'Sell' }),
        ], true);
        expect(rows).toEqual([
            { label: '現股', quantity: '1張', avg: 1050, pnl: 100 },
            { label: '現股空（當沖）', quantity: '2張', avg: 1072.5, pnl: -20 },
        ]);
    });

    it('未成交筆數：目前商品、剩餘量 > 0（含市價），以 target_code 比對別名', () => {
        expect(workingOrderCount('2330', [trade('a', '2330'), trade('b', '2330', { priceType: 'MKT' }), trade('c', '2317'), trade('d', '2330', { deal: 2 })])).toBe(2);
        expect(workingOrderCount('TXFF6', [trade('x', 'TXFR1', { target: 'TXFF6' })])).toBe(1);
    });
});

describe('TradePage', () => {
    it('沒有商品時顯示提示，不載入合約', async () => {
        await render(null);
        expect(text(byId('page-trade'))).toContain('尚未選擇商品');
        expect(m.ensureContract).not.toHaveBeenCalled();
    });

    it('進入頁面設定目前商品並載入合約；標頭顯示漲跌停、參考、可當沖', async () => {
        await render();
        expect(m.setCurrentCode).toHaveBeenCalledWith('2330');
        expect(m.ensureContract).toHaveBeenCalledWith('2330');
        const info = text(byId('trade-info'));
        expect(info).toContain('漲停 1,175');
        expect(info).toContain('跌停 963');
        expect(text(byId('trade-stat-reference'))).toBe('參1,070');
        expect(text(byId('trade-daytrade'))).toBe('可當沖');
        expect(info).not.toContain('可當沖');
        expect(text(byId('trade-price'))).toContain('▲15');
    });

    it('統計格（股票）：開 高 均 總／參 低 單 額，取自 tick；價格相對參考價著色', async () => {
        m.useQuote.mockReturnValue({ tick: {
            code: '2330', close: '1085', price_chg: '15', open: '1065', high: '1090', low: '1060', avg_price: '1077.456',
            volume: 12, total_volume: 23456, total_amount: '25300000000',
        } });
        await render();
        const stats = byId('trade-stats');
        const cells = stats.findAll(n => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('trade-stat-'));
        expect(cells.map(c => text(c))).toEqual(['開1,065', '高1,090', '均1,077.46', '總2.3萬張', '參1,070', '低1,060', '單12張', '額253.0億']);
        const tone = (id: string) => String(byId(id).findByType('dd').props.className);
        expect(tone('trade-stat-open')).toContain('down');
        expect(tone('trade-stat-high')).toContain('up');
        expect(tone('trade-stat-avg')).toContain('up');
        expect(tone('trade-stat-reference')).toContain('flat');
    });

    it('統計格：沒有 tick 時用快照；期貨無「額」、量以口計，資訊列顯示到期與時段', async () => {
        m.useQuote.mockReturnValue(undefined);
        m.snapshot = {
            code: '2330', datetime: '2026-11-05 13:30:00', open: 1075, high: 1095, low: 1065, close: 1085, average_price: 1080.5,
            volume: 7, total_volume: 23456, total_amount: 25300000000, change_price: 15, change_rate: 1.4,
        };
        await render();
        expect(text(byId('trade-stat-open'))).toBe('開1,075');
        expect(text(byId('trade-stat-avg'))).toBe('均1,080.50');
        expect(text(byId('trade-stat-last'))).toBe('單7張');

        await act(async () => view?.unmount());
        const fut = { ...stock, code: 'TXFF6', security_type: 'FUT', exchange: 'TAIFEX', name: '臺股期貨', delivery_month: '202606', limit_up: 0, limit_down: 0, reference: 22400 } as ContractInfo;
        m.useContract.mockReturnValue(fut);
        m.ensureContract.mockResolvedValue(fut);
        m.snapshot = undefined;
        m.useQuote.mockReturnValue({ tick: { code: 'TXFF6', close: '22450', price_chg: '50', open: '22400', high: '22500', low: '22380', avg_price: '22441.2', volume: 2, total_volume: 80123 } });
        await render('TXFF6');
        const keys = byId('trade-stats').findAll(n => typeof n.props['data-testid'] === 'string' && n.props['data-testid'].startsWith('trade-stat-')).map(c => c.props['data-testid']);
        expect(keys).not.toContain('trade-stat-amount');
        expect(text(byId('trade-stat-total'))).toBe('總8.0萬口');
        expect(text(byId('trade-info'))).toContain('到期 2026/06');
        expect(view!.root.findAllByProps({ 'data-testid': 'trade-daytrade' })).toHaveLength(0);
    });

    it('成交價等於漲停／跌停價時顯示標籤；參考價不判斷', async () => {
        m.useQuote.mockReturnValue({ tick: { code: '2330', close: '1175', price_chg: '105', total_volume: 1 } });
        await render();
        expect(text(byId('trade-limit'))).toBe('漲停');
        await act(async () => view?.unmount());

        m.useQuote.mockReturnValue({ tick: { code: '2330', close: '963', price_chg: '-107', total_volume: 1 } });
        await render();
        expect(text(byId('trade-limit'))).toBe('跌停');
        await act(async () => view?.unmount());

        m.useQuote.mockReturnValue(undefined);
        m.useContract.mockReturnValue({ ...stock, reference: 1175 });
        await render();
        expect(view!.root.findAllByProps({ 'data-testid': 'trade-limit' })).toHaveLength(0);
    });

    it('非「可當沖」的當沖狀態以文字放資訊列，不顯示徽章', async () => {
        m.useContract.mockReturnValue({ ...stock, day_trade: 'OnlyBuy' });
        await render();
        expect(view!.root.findAllByProps({ 'data-testid': 'trade-daytrade' })).toHaveLength(0);
        expect(text(byId('trade-info'))).toContain('僅可先買後賣當沖');
    });

    it('圖表收到參考價、漲跌停、成本與委託線', async () => {
        await render();
        const props = m.chartProps.at(-1) as { lines: { kind: string }[]; period: string };
        expect(props.lines.map(l => l.kind)).toEqual(['reference', 'limit-up', 'limit-down', 'cost', 'order-buy']);
    });

    it('買進／賣出只開下單面板（帶方向、不帶價）', async () => {
        await render();
        await act(async () => { byId('trade-buy').props.onClick(); });
        await act(async () => { byId('trade-sell').props.onClick(); });
        expect(m.openTicket.mock.calls).toEqual([
            [{ code: '2330', action: 'Buy', source: 'button' }],
            [{ code: '2330', action: 'Sell', source: 'button' }],
        ]);
    });

    it('持倉摘要與未成交筆數；遮金額時隱藏數量與損益', async () => {
        await render();
        expect(text(byId('trade-summary'))).toContain('現股 3張 · 均價 1,052.5');
        expect(text(byId('trade-summary'))).toContain('+97,500');
        const link = byId('trade-working-link');
        expect(link.props.href).toBe('#/orders');
        expect(text(link)).toContain('未成交：2 筆');

        m.usePrivacyMoney.mockReturnValue(true);
        await act(async () => { view!.update(createElement(TradePage, { code: '2330' })); });
        const masked = text(byId('trade-summary'));
        expect(masked).not.toContain('97,500');
        expect(masked).not.toContain('3張');
        expect(masked).toContain('•••••');
    });

    it('漲跌幅以 price_chg 與參考價計算，不用串流的 pct_chg（B8）', async () => {
        // 股票串流 pct_chg 單位是 ％×100（140＝1.40%）；直接使用會顯示 140.00%
        m.useQuote.mockReturnValue({ tick: { code: '2330', close: '1085', price_chg: '15', pct_chg: '140', total_volume: 23456 } });
        await render();
        const price = text(byId('trade-price'));
        expect(price).toContain('▲15 (+1.40%)');
        expect(price).not.toContain('140.00%');
    });

    it('沒有 tick：掛載時取一次快照，以快照收盤與漲跌顯示（B1）', async () => {
        m.useQuote.mockReturnValue(undefined);
        await render();
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(1);
        expect(m.fetchSnapshots).toHaveBeenCalledWith([stock]);
        // 尚無快照：參考價並明確標示
        expect(text(byId('trade-price'))).toContain('1,070');
        expect(view!.root.findAllByProps({ 'data-testid': 'trade-price-reference' })).toHaveLength(1);
        expect(text(byId('trade-price'))).not.toContain('%');

        // 快照回來（store 通知）→ 改顯示快照的收盤、漲跌、漲跌幅、總量
        m.snapshot = { code: '2330', datetime: '2026-11-05 13:30:00', close: 1085, change_price: 15, change_rate: 1.4, total_volume: 23456 };
        await act(async () => { m.snapshotListeners.forEach(l => l()); });
        const price = text(byId('trade-price'));
        expect(price).toContain('1,085');
        expect(price).toContain('▲15 (+1.40%)');
        expect(text(byId('trade-stat-total'))).toBe('總2.3萬張');
        expect(view!.root.findAllByProps({ 'data-testid': 'trade-price-reference' })).toHaveLength(0);
    });

    it('試撮揭示：顯示「試撮」徽章，最新價不採用揭示價（B2）', async () => {
        m.snapshot = { code: '2330', datetime: '2026-11-05 13:30:00', close: 1085, change_price: 15, change_rate: 1.4, total_volume: 23456 };
        m.useQuote.mockReturnValue({ tick: { code: '2330', date: '2026-11-06', time: '08:45:00', close: '1175', price_chg: '105', total_volume: 0, simtrade: true } });
        await render();
        const price = text(byId('trade-price'));
        expect(text(byId('trade-simtrade'))).toBe('試撮 1,175');
        expect(price).toContain('1,085');
        expect(price).toContain('▲15 (+1.40%)');
        expect(price).not.toContain('▲105');
    });

    it('非正規代碼：合約解析後改寫路由，只以正規代碼設定目前商品與比對報價（B9）', async () => {
        m.useContract.mockReturnValue(stock); // 路由 '02330' 解析成 2330
        await render('02330');
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2330' }, { replace: true });
        expect(m.setCurrentCode.mock.calls).toEqual([['2330']]);
        expect(m.useQuote.mock.calls.every(c => c[0] === '2330')).toBe(true);
        expect((m.chartProps.at(-1) as { code: string }).code).toBe('2330');
        await act(async () => { byId('trade-buy').props.onClick(); });
        expect(m.openTicket).toHaveBeenCalledWith({ code: '2330', action: 'Buy', source: 'button' });
    });

    it('正規代碼不改寫路由', async () => {
        await render();
        expect(m.navigate).not.toHaveBeenCalled();
    });
});

