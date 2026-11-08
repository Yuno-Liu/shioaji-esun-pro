// 交易頁（規格 §6.2）：標頭文字、持倉摘要（遮金額）、未成交筆數、買進／賣出只開下單面板
import { readFileSync } from 'node:fs';
import { StrictMode, createElement, useSyncExternalStore, type ReactElement } from 'react';
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
    openOrderAction: vi.fn(),
    setCurrentCode: vi.fn(),
    searchProducts: vi.fn(),
    navigate: vi.fn(),
    fetchSnapshots: vi.fn(),
    snapshot: undefined as unknown,
    snapshotListeners: new Set<() => void>(),
    chartProps: [] as unknown[],
    // 當沖資訊列：處置名單（usePunishedCodes 的 active 參數）與「籌碼與當沖」面板替身收到的 props
    punished: new Set<string>() as ReadonlySet<string>,
    punishActive: [] as boolean[],
    punishLoaded: true,
    chipsSheetProps: [] as { open: boolean; contract: { code: string }; punished: boolean | null }[],
    // 自選 ☆：殼層 WatchlistProvider 的替身（null＝不在 Provider 內）與通知
    wl: null as unknown,
    notify: vi.fn(),
    // S1：lib 的送單／改單／刪單函式（交易頁任何入口都不得呼叫）
    send: {
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelOrders: vi.fn(),
        cancelVerifiedOrder: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
        submitMobileOrder: vi.fn(),
        placeQuickOrder: vi.fn(),
        cancelAllOrders: vi.fn(),
    },
}));
vi.mock('../../hooks/use-stream', () => ({ useQuote: m.useQuote }));
vi.mock('../../lib/contracts-cache', () => ({ useContract: m.useContract, ensureContract: m.ensureContract }));
vi.mock('../../lib/trading-state', () => ({ useTradingState: m.useTradingState }));
vi.mock('../../lib/privacy', () => ({ usePrivacyMoney: m.usePrivacyMoney, maskMoney: (t: string, p: boolean) => (p ? '•••••' : t) }));
vi.mock('../lib/mobile-store', () => ({ openTicket: m.openTicket, openOrderAction: m.openOrderAction, setCurrentCode: m.setCurrentCode }));
vi.mock('../../lib/product-search', () => ({ searchProducts: m.searchProducts }));
vi.mock('../components/trade-chart', () => ({ TradeChart: (props: unknown) => { m.chartProps.push(props); return null; } }));
vi.mock('../components/tick-list', () => ({ TickList: () => null }));
// 「公司」分頁（延遲載入）：以替身取代，不讀 shioaji-data（內容與 S1 另見 components/company/company-tab.test.tsx）
vi.mock('../components/company/load-company-tab', async () => {
    const { createElement: h } = await import('react');
    return { loadCompanyTab: async () => ({ CompanyTab: (props: { contract?: { code: string } }) => h('div', { 'data-testid': 'company-stub' }, props.contract?.code ?? '') }) };
});
// 處置名單（交易頁只在股票、前景時讀）：以替身取代，不發請求
vi.mock('../lib/regulatory-punish', () => ({
    usePunishedCodes: (active: boolean) => { m.punishActive.push(active); return m.punished; },
    usePunishedListLoaded: () => m.punishLoaded,
}));
// 「籌碼與當沖」面板（延遲載入）：以替身取代，不讀融資融券與券源（內容、請求與 S1 另見 components/trade-info/trade-chips-sheet.test.tsx）
vi.mock('../components/trade-info/load-trade-chips-sheet', async () => {
    const { createElement: h } = await import('react');
    return {
        loadTradeChipsSheet: async () => ({
            TradeChipsSheet: (props: { open: boolean; contract: { code: string }; punished: boolean | null }) => {
                m.chipsSheetProps.push(props);
                return props.open ? h('div', { 'data-testid': 'chips-sheet-stub' }, props.contract.code) : null;
            },
        }),
    };
});
vi.mock('../../lib/shioaji', () => ({
    fetchSnapshots: m.fetchSnapshots,
    placeStockOrder: m.send.placeStockOrder,
    placeFuturesOrder: m.send.placeFuturesOrder,
    placeComboOrder: m.send.placeComboOrder,
    cancelOrder: m.send.cancelOrder,
    cancelOrders: m.send.cancelOrders,
    cancelVerifiedOrder: m.send.cancelVerifiedOrder,
    updateOrderPrice: m.send.updateOrderPrice,
    updateOrderQty: m.send.updateOrderQty,
}));
vi.mock('../lib/mobile-order', () => ({ submitMobileOrder: m.send.submitMobileOrder }));
vi.mock('../../lib/trade', () => ({ placeQuickOrder: m.send.placeQuickOrder, cancelAllOrders: m.send.cancelAllOrders, notify: m.notify }));
vi.mock('../lib/watchlist-context', () => ({ useOptionalMobileWatchlist: () => m.wl }));
vi.mock('../../lib/market-snapshot-store', () => ({
    getMarketSnapshot: () => m.snapshot,
    subscribeMarketSnapshots: (l: () => void) => { m.snapshotListeners.add(l); return () => { m.snapshotListeners.delete(l); }; },
}));
vi.mock('../lib/hash-router', async importOriginal => ({ ...(await importOriginal<typeof import('../lib/hash-router')>()), navigate: m.navigate }));

import { SEARCH_DEBOUNCE_MS } from '../hooks/use-product-search';
import { setMotionClockForTest } from '../motion/spring';
import { pressable, pressableRow } from '../styles/primitives.css';
import { SIZE } from '../styles/tokens';
import * as tradeStyles from '../styles/trade.css';
import * as tradeInfoStyles from '../styles/trade-info.css';
import { card as groupedCard } from '../ui/grouped.css';
import { ShellSlot, ShellSlotsContext } from '../ui/shell-slots';
import { dayTradeText, deliveryMonthText, positionSummaries, watchStarBlocked, scrolledPast, sessionText, statKeys, summaryUsesStockUnits, TradePage, workingOrderCount } from './trade-page';

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
    m.openOrderAction.mockReset();
    m.searchProducts.mockReset().mockResolvedValue([]);
    m.setCurrentCode.mockReset();
    m.navigate.mockReset();
    m.fetchSnapshots.mockReset().mockResolvedValue([]);
    m.snapshot = undefined;
    m.snapshotListeners.clear();
    m.chartProps.length = 0;
    m.punished = new Set();
    m.punishActive.length = 0;
    m.punishLoaded = true;
    m.chipsSheetProps.length = 0;
    m.wl = null;
    m.notify.mockReset();
    Object.values(m.send).forEach(f => f.mockReset());
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

describe('權證（2026-11 上游同步後與股票同一條下單路徑）', () => {
    it('持倉摘要以股票單位顯示（證券市場商品：股票、權證）', () => {
        expect(summaryUsesStockUnits('STK')).toBe(true);
        expect(summaryUsesStockUnits('WRT')).toBe(true);
        expect(summaryUsesStockUnits('FUT')).toBe(false);
        expect(summaryUsesStockUnits('OPT')).toBe(false);
        expect(summaryUsesStockUnits('IND')).toBe(false);
        expect(summaryUsesStockUnits(undefined)).toBe(false);
        const rows = positionSummaries('030392', '030392', [pos('030392', 2000, 1.5, 100, { cond: 'Cash' })], summaryUsesStockUnits('WRT'));
        expect(rows[0]!.quantity).toBe('2張');
        expect(rows[0]!.quantity).not.toContain('口');
    });

    it('統計格與股票相同（有均價、總量、單量、金額）', () => {
        expect(statKeys('WRT')).toEqual(statKeys('STK'));
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

    it('未成交連結：卡片髮絲線落在外層、按壓層（pressableRow ::after）在連結上，兩者不共用同一節點', async () => {
        await render();
        const classes = (n: { props: { className?: unknown } }) => String(n.props.className ?? '').split(' ').filter(Boolean);
        const link = byId('trade-working-link');
        // 連結帶按壓層
        expect(pressableRow.split(' ').every(c => classes(link).includes(c))).toBe(true);
        // 連結的父節點是外層列：它才是卡片的直接子節點（card > * + *::after 髮絲線畫在它身上），且不帶 pressableRow
        const row = link.parent!;
        expect(row.type).toBe('div');
        expect(classes(row)).toEqual(tradeStyles.workingLinkRow.split(' '));
        expect(pressableRow.split(' ').some(c => classes(row).includes(c))).toBe(false);
        const cardNode = row.parent!;
        expect(classes(cardNode)).toEqual(groupedCard.split(' '));
        // 不是卡片第一列（前面有持倉摘要列）→ 髮絲線選擇器 card > * + * 命中外層列，不命中連結
        const kids = cardNode.children.filter(k => typeof k !== 'string');
        expect(kids.indexOf(row)).toBeGreaterThan(0);
        expect(kids).not.toContain(link);
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

// ---- B3b 交易頁現代化（設計規格 §7.3、§10 S1） ----

describe('TradePage B3b', () => {
    const buttons = () => view!.root.findAll(n => n.type === 'button');
    const btn = (label: string) => buttons().find(b => text(b) === label)!;

    it('S1：交易頁每個按鈕（買賣鍵、週期、五檔／明細／公司、整股／零股、五檔點價）只呼叫 openTicket，lib 送出函式 0 次', async () => {
        m.useQuote.mockReturnValue({
            tick: { code: '2330', close: '1085', price_chg: '15', total_volume: 23456 },
            bidask: { bid_price: ['1080', '1075'], bid_volume: [5, 3], ask_price: ['1085', '1090'], ask_volume: [4, 2] },
        });
        await render();
        // 先點「五檔」相關按鈕，再切到明細（明細列表已 mock）、再切到公司（公司分頁以替身取代），各自再點一輪（含買賣鍵）
        const clickAll = async () => {
            for (const b of buttons().filter(n => !n.props.disabled)) {
                if (text(b) === '明細' || text(b) === '公司') continue;
                await act(async () => { b.props.onClick?.(); });
            }
        };
        await clickAll();
        await act(async () => { btn('明細').props.onClick(); });
        await clickAll();
        await act(async () => { btn('公司').props.onClick(); });
        expect(view!.root.findAllByProps({ 'data-testid': 'company-stub' })).toHaveLength(1);
        await clickAll();
        expect(m.openTicket.mock.calls.length).toBeGreaterThanOrEqual(6);
        for (const [arg] of m.openTicket.mock.calls) {
            expect(arg).toMatchObject({ code: '2330' });
            expect(['button', 'depth']).toContain((arg as { source: string }).source);
        }
        for (const [name, fn] of Object.entries(m.send)) {
            expect(fn, name).not.toHaveBeenCalled();
        }
    });

    it('週期改為 Segmented toggle（role=group、aria-pressed），點選後傳給圖表並記住', async () => {
        await render();
        const group = view!.root.findAll(n => n.type === 'div' && n.props.role === 'group' && n.props['aria-label'] === '圖表週期');
        expect(group).toHaveLength(1);
        const labels = group[0]!.findAllByType('button').map(b => text(b));
        expect(labels).toEqual(['走勢', '1分', '5分', '15分', '60分', '日']);
        await act(async () => { btn('5分').props.onClick(); });
        expect(btn('5分').props['aria-pressed']).toBe(true);
        expect(btn('走勢').props['aria-pressed']).toBe(false);
        expect((m.chartProps.at(-1) as { period: string }).period).toBe('5m');
    });

    it('五檔／明細／公司為 Segmented tabs（role=tablist／tab＋aria-selected）', async () => {
        await render();
        const list = view!.root.findAll(n => n.type === 'div' && n.props.role === 'tablist');
        expect(list).toHaveLength(1);
        expect(list[0]!.props['aria-label']).toBe('五檔、明細與公司');
        expect(list[0]!.findAllByType('button').map(b => text(b))).toEqual(['五檔', '明細', '公司']);
        expect(btn('五檔').props.role).toBe('tab');
        expect(btn('五檔').props['aria-selected']).toBe(true);
        await act(async () => { btn('明細').props.onClick(); });
        expect(btn('明細').props['aria-selected']).toBe(true);
        expect(view!.root.findAllByProps({ 'data-testid': 'depth-ladder' })).toHaveLength(0);
    });

    it('交易鍵列經 ShellSlot bottom：inline 時原地渲染（文字與 testid 不變）；殼層目標未掛上時不落回捲動內容', async () => {
        // portal 行為本身由 shell-slots.test 驗證；這裡驗證交易鍵確實走 ShellSlot
        await act(async () => {
            view = create(createElement(ShellSlotsContext.Provider, { value: 'inline' }, createElement(TradePage, { code: '2330' })));
        });
        expect(text(byId('trade-buy'))).toBe('買 進');
        expect(text(byId('trade-sell'))).toBe('賣 出');
        await act(async () => { view!.unmount(); });
        await act(async () => {
            view = create(createElement(ShellSlotsContext.Provider, { value: { top: null, bottom: null } }, createElement(TradePage, { code: '2330' })));
        });
        expect(view!.root.findAllByProps({ 'data-testid': 'trade-buy' })).toHaveLength(0);
        expect(view!.root.findAllByProps({ 'data-testid': 'page-trade' })).toHaveLength(1);
    });

    it('組合商品：交易鍵停用並以 InlineNote 說明（文字不變）', async () => {
        m.useContract.mockReturnValue({ ...stock, combo: true });
        await render();
        expect(byId('trade-buy').props.disabled).toBe(true);
        expect(byId('trade-sell').props.disabled).toBe(true);
        const note = view!.root.findAll(n => n.props['data-tone-note'] === 'warn');
        expect(note).toHaveLength(1);
        expect(text(note[0]!)).toContain('組合商品不支援手機下單');
    });

    it('scrolledPast：只有在根範圍之上且不相交才算捲出', () => {
        expect(scrolledPast({ isIntersecting: false, boundingClientRect: { top: 40 }, rootBounds: { top: 91 } })).toBe(true);
        expect(scrolledPast({ isIntersecting: true, boundingClientRect: { top: 120 }, rootBounds: { top: 91 } })).toBe(false);
        // 在根範圍下方（看不到但還沒捲過）不算
        expect(scrolledPast({ isIntersecting: false, boundingClientRect: { top: 900 }, rootBounds: { top: 91 } })).toBe(false);
        expect(scrolledPast({ isIntersecting: false, boundingClientRect: { top: -5 }, rootBounds: null })).toBe(true);
    });

    it('精簡標頭：沒有 IntersectionObserver 時不渲染', async () => {
        await render();
        expect(view!.root.findAllByProps({ 'data-testid': 'trade-compact' })).toHaveLength(0);
    });

    it('精簡標頭：主價列哨兵捲出 main 頂端時顯示（以 main 為根；aria-hidden；不重用其他 testid）', async () => {
        const observers: { cb: IntersectionObserverCallback; opts: IntersectionObserverInit | undefined; disconnect: ReturnType<typeof vi.fn> }[] = [];
        class FakeIO {
            disconnect = vi.fn();
            constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) { observers.push({ cb, opts, disconnect: this.disconnect }); }
            observe() {}
            unobserve() {}
        }
        vi.stubGlobal('IntersectionObserver', FakeIO);
        const main = { tagName: 'MAIN' };
        await act(async () => {
            view = create(createElement(TradePage, { code: '2330' }), {
                createNodeMock: el => ((el.props as { className?: string }).className === undefined ? null : { closest: (sel: string) => (sel === 'main' ? main : null), nodeType: 1 }),
            });
        });
        const header = observers.find(o => o.opts?.root === main);
        expect(header).toBeDefined();
        const bar = () => byId('trade-compact');
        expect(bar().props['data-visible']).toBe('false');
        expect(bar().props['aria-hidden']).toBe('true');
        expect(text(bar())).toContain('2330 台積電');
        expect(text(bar())).toContain('1,085');
        await act(async () => {
            header!.cb([{ isIntersecting: false, boundingClientRect: { top: -2 }, rootBounds: { top: 0 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
        });
        expect(bar().props['data-visible']).toBe('true');
        await act(async () => {
            header!.cb([{ isIntersecting: true, boundingClientRect: { top: 10 }, rootBounds: { top: 0 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
        });
        expect(bar().props['data-visible']).toBe('false');
        await act(async () => { view!.unmount(); });
        view = undefined;
        expect(header!.disconnect).toHaveBeenCalled();
    });

    it('精簡標頭顯示期間 main 的 scroll-padding-top 讓出標頭高度（scrollIntoView／焦點不停在標頭後面），隱藏或卸載時移除', async () => {
        const observers: { cb: IntersectionObserverCallback; opts: IntersectionObserverInit | undefined }[] = [];
        class FakeIO {
            constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) { observers.push({ cb, opts }); }
            observe() {}
            unobserve() {}
            disconnect() {}
        }
        vi.stubGlobal('IntersectionObserver', FakeIO);
        const main = { tagName: 'MAIN', style: { setProperty: vi.fn(), removeProperty: vi.fn() } };
        await act(async () => {
            view = create(createElement(TradePage, { code: '2330' }), {
                createNodeMock: el => ((el.props as { className?: string }).className === undefined ? null : { closest: (sel: string) => (sel === 'main' ? main : null), nodeType: 1 }),
            });
        });
        const header = observers.find(o => (o.opts?.root as unknown) === main)!;
        expect(main.style.setProperty).not.toHaveBeenCalled();
        await act(async () => {
            header.cb([{ isIntersecting: false, boundingClientRect: { top: -2 }, rootBounds: { top: 0 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
        });
        expect(main.style.setProperty).toHaveBeenCalledTimes(1);
        expect(main.style.setProperty).toHaveBeenCalledWith('scroll-padding-top', SIZE.compactBarH);
        await act(async () => {
            header.cb([{ isIntersecting: true, boundingClientRect: { top: 10 }, rootBounds: { top: 0 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
        });
        expect(main.style.removeProperty).toHaveBeenCalledWith('scroll-padding-top');
        await act(async () => {
            header.cb([{ isIntersecting: false, boundingClientRect: { top: -2 }, rootBounds: { top: 0 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
        });
        expect(main.style.setProperty).toHaveBeenCalledTimes(2);
        await act(async () => { view!.unmount(); });
        view = undefined;
        expect(main.style.removeProperty).toHaveBeenCalledTimes(2);
    });

    it('主價改用 numHero 樣式與系統字（不再用等寬字族）；價格旁有跳價閃爍覆蓋層（aria-hidden）', async () => {
        await render();
        const price = byId('trade-price');
        const hero = price.findAll(n => n.type === 'span' && String(n.props.className ?? '').includes('lastPrice'))[0]!;
        expect(text(hero)).toBe('1,085');
        const overlay = hero.findAll(n => n.type === 'span' && n.props['aria-hidden'] === 'true');
        expect(overlay).toHaveLength(1);
    });
});

// ---- 五檔整股／盤中零股切換與「五檔｜明細」同列（設計規格 §7.3 版面圖） ----

describe('TradePage 五檔整股／盤中零股切換', () => {
    const BIDASK = { bid_price: ['1080', '1075'], bid_volume: [5, 3], ask_price: ['1085', '1090'], ask_volume: [4, 2] };
    const buttons = () => view!.root.findAll(n => n.type === 'button');
    const btn = (label: string) => buttons().find(b => text(b) === label)!;
    const all = (id: string) => view!.root.findAllByProps({ 'data-testid': id });
    /** 五檔訂閱（Header 的 useQuote 帶 narrow，五檔帶 oddLot） */
    const depthQuoteCalls = () => m.useQuote.mock.calls.filter(c => c[1] && 'oddLot' in (c[1] as object)).map(c => (c[1] as { oddLot: boolean }).oddLot);

    beforeEach(() => {
        m.useQuote.mockReturnValue({ tick: { code: '2330', close: '1085', price_chg: '15', total_volume: 23456 }, bidask: BIDASK });
    });

    it('切換鍵在「五檔｜明細」同一列右側（分頁在前），不在五檔區塊內；testid 不變', async () => {
        await render();
        const row = byId('trade-panel-row');
        expect(row.props.className).toBe(tradeStyles.panelRow);
        const [tabsSlot, toggleSlot] = row.children as unknown as { props: { className: string }; findAll: typeof row.findAll }[];
        expect(row.children).toHaveLength(2);
        expect(tabsSlot!.props.className).toBe(tradeStyles.panelTabs);
        expect(tabsSlot!.findAll(n => n.props.role === 'tablist')).toHaveLength(1);
        expect(toggleSlot!.props.className).toBe(tradeStyles.oddToggleSlot);
        expect(toggleSlot!.findAll(n => n.props['data-testid'] === 'depth-odd-toggle')).toHaveLength(1);
        expect(text(byId('depth-odd-toggle'))).toBe('盤中零股');
        expect(byId('depth-ladder').findAll(n => n.props['data-testid'] === 'depth-odd-toggle')).toHaveLength(0);
        // Segmented toggle：role=group、aria-pressed、compact
        const group = view!.root.findAll(n => n.type === 'div' && n.props.role === 'group' && n.props['aria-label'] === '五檔：整股或盤中零股');
        expect(group).toHaveLength(1);
        expect(byId('depth-odd-toggle').props['aria-pressed']).toBe(false);
    });

    it('受控：切換鍵改變五檔訂閱（整股 → 盤中零股 → 整股）', async () => {
        await render();
        expect(depthQuoteCalls().at(-1)).toBe(false);
        await act(async () => { byId('depth-odd-toggle').props.onClick(); });
        expect(byId('depth-odd-toggle').props['aria-pressed']).toBe(true);
        expect(depthQuoteCalls().at(-1)).toBe(true);
        expect(text(byId('depth-total'))).toContain('五檔總量（股）');
        await act(async () => { btn('整股').props.onClick(); });
        expect(depthQuoteCalls().at(-1)).toBe(false);
        expect(text(byId('depth-total'))).toContain('五檔總量（張）');
    });

    it('零股五檔點價開零股下單面板（lot: IntradayOdd、不帶方向）；整股不帶 lot；lib 送出函式 0 次', async () => {
        await render();
        await act(async () => { byId('depth-bid-1').props.onClick(); });
        await act(async () => { byId('depth-odd-toggle').props.onClick(); });
        await act(async () => { byId('depth-ask-2').props.onClick(); });
        expect(m.openTicket.mock.calls).toEqual([
            [{ code: '2330', price: 1080, source: 'depth' }],
            [{ code: '2330', price: 1090, source: 'depth', lot: 'IntradayOdd' }],
        ]);
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });

    it('明細分頁時隱藏切換鍵但保留位置與狀態；切回五檔仍是盤中零股', async () => {
        await render();
        await act(async () => { byId('depth-odd-toggle').props.onClick(); });
        await act(async () => { btn('明細').props.onClick(); });
        expect(all('depth-odd-toggle')).toHaveLength(0);
        expect(all('depth-ladder')).toHaveLength(0);
        // 空位仍在（分頁寬度不跳動），且不含任何按鈕
        const slot = byId('trade-panel-row').findAll(n => n.props.className === tradeStyles.oddToggleSlot);
        expect(slot).toHaveLength(1);
        expect(slot[0]!.findAll(n => n.type === 'button')).toHaveLength(0);
        await act(async () => { btn('五檔').props.onClick(); });
        expect(byId('depth-odd-toggle').props['aria-pressed']).toBe(true);
        expect(depthQuoteCalls().at(-1)).toBe(true);
        await act(async () => { byId('depth-bid-1').props.onClick(); });
        expect(m.openTicket.mock.calls.at(-1)).toEqual([{ code: '2330', price: 1080, source: 'depth', lot: 'IntradayOdd' }]);
    });

    it('非股票（期貨、指數）與合約未載入時不顯示切換鍵、不留空位，分頁佔滿整列', async () => {
        for (const c of [{ ...stock, code: 'TXFF6', security_type: 'FUT' }, { ...stock, code: 'TSE001', security_type: 'IND' }, undefined]) {
            m.useContract.mockReturnValue(c);
            await render(c?.code ?? '2330');
            expect(all('depth-odd-toggle')).toHaveLength(0);
            expect(byId('trade-panel-row').children).toHaveLength(1);
            expect(depthQuoteCalls().at(-1)).toBe(false);
            await act(async () => { view!.unmount(); });
            view = undefined;
        }
    });

    it('換商品時整頁重建：回到整股', async () => {
        await render('2330');
        await act(async () => { byId('depth-odd-toggle').props.onClick(); });
        expect(byId('depth-odd-toggle').props['aria-pressed']).toBe(true);
        m.useContract.mockReturnValue({ ...stock, code: '2317', name: '鴻海' });
        await act(async () => { view!.update(createElement(TradePage, { code: '2317' })); });
        expect(byId('depth-odd-toggle').props['aria-pressed']).toBe(false);
        expect(depthQuoteCalls().at(-1)).toBe(false);
    });
});

// ---- 切換商品（點標頭代碼／名稱開搜尋；設計規格 §7.2、§7.3）----

describe('TradePage 切換商品', () => {
    const tradeHon = { code: '2317', name: '鴻海', security_type: 'STK', exchange: 'TSE', detail: '上市' };
    const sheetOpen = () => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === 'trade-switch-sheet').length > 0;
    const switchBtn = () => byId('trade-switch');
    const typeQuery = async (q: string) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            await act(async () => { byId('trade-switch-input').props.onChange({ target: { value: q } }); });
            await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        } finally {
            vi.useRealTimers();
        }
    };
    const ancestors = (n: { parent: unknown }) => {
        const out: { props: Record<string, unknown> }[] = [];
        let p = n.parent as { props: Record<string, unknown>; parent: unknown } | null;
        while (p) { out.push(p); p = p.parent as typeof p; }
        return out;
    };
    let store: Map<string, string>;
    beforeEach(() => {
        store = new Map();
        vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    });

    it('入口：h1 內的按鈕（type=button、aria-haspopup=dialog、aria-expanded、aria-label 含代碼名稱）；文字維持「代碼 名稱」', async () => {
        await render();
        const btn = switchBtn();
        expect(btn.type).toBe('button');
        expect(btn.props.type).toBe('button');
        expect(btn.parent!.type).toBe('h1');
        expect(btn.parent!.props.className).toBe(tradeStyles.title);
        expect(btn.props['aria-haspopup']).toBe('dialog');
        expect(btn.props['aria-expanded']).toBe(false);
        expect(btn.props['aria-label']).toBe('切換商品，目前 2330 台積電');
        expect(text(btn)).toBe('2330 台積電');
        expect(btn.props.className).toContain(tradeStyles.titleButton);
        expect(btn.props.className).toContain(pressable);
        expect(sheetOpen()).toBe(false);
    });

    it('點擊開面板；搜尋後點結果以 replace 導覽到該商品並關閉面板；S1：openTicket／openOrderAction 與 lib 送出函式 0 次', async () => {
        m.searchProducts.mockResolvedValue([tradeHon]);
        await render();
        await act(async () => { switchBtn().props.onClick(); });
        expect(sheetOpen()).toBe(true);
        expect(switchBtn().props['aria-expanded']).toBe(true);
        await typeQuery('鴻');
        expect(m.searchProducts.mock.calls[0]![0]).toBe('鴻');
        const pick = view!.root.find(n => n.props['data-testid'] === 'trade-switch-pick' && n.props['data-code'] === '2317');
        await act(async () => { pick.props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2317' }, { replace: true });
        expect(sheetOpen()).toBe(false);
        expect(switchBtn().props['aria-expanded']).toBe(false);
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });

    it('路由換成新代碼後整頁重建並設定目前商品（ui.currentCode 由正規代碼 effect 更新）', async () => {
        await render();
        m.setCurrentCode.mockClear();
        m.useContract.mockReturnValue({ ...stock, code: '2317', name: '鴻海' });
        await act(async () => { view!.update(createElement(TradePage, { code: '2317' })); });
        expect(m.setCurrentCode).toHaveBeenCalledWith('2317');
        expect(switchBtn().props['aria-label']).toBe('切換商品，目前 2317 鴻海');
    });

    it('點目前商品只關閉面板，不導覽', async () => {
        store.set('sj-mobile-recent-codes', JSON.stringify([{ code: '2330', name: '台積電', securityType: 'STK' }]));
        await render();
        await act(async () => { switchBtn().props.onClick(); });
        const current = view!.root.find(n => n.props['data-testid'] === 'trade-switch-pick' && n.props['data-code'] === '2330');
        expect(current.props['aria-current']).toBe('true');
        await act(async () => { current.props.onClick(); });
        expect(sheetOpen()).toBe(false);
        expect(m.navigate).not.toHaveBeenCalled();
    });

    it('合約載入後記入最近查看（正規代碼；非正規代碼的頁面不記錄）', async () => {
        await render();
        expect(JSON.parse(store.get('sj-mobile-recent-codes')!)).toEqual([{ code: '2330', name: '台積電', securityType: 'STK' }]);
        await act(async () => { view!.unmount(); });
        store.clear();
        await render('tsmc'); // 路由代碼與正規代碼（2330）不同：改寫路由，由重新掛載的正規頁記錄
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2330' }, { replace: true });
        expect(store.get('sj-mobile-recent-codes')).toBeUndefined();
    });

    it('精簡標頭：顯示時才有切換鍵（在 aria-hidden 的精簡標頭之外）；隱藏時不渲染；點擊開面板', async () => {
        const observers: { cb: IntersectionObserverCallback; opts: IntersectionObserverInit | undefined }[] = [];
        class FakeIO {
            constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) { observers.push({ cb, opts }); }
            observe() {}
            unobserve() {}
            disconnect() {}
        }
        vi.stubGlobal('IntersectionObserver', FakeIO);
        const main = { tagName: 'MAIN' };
        await act(async () => {
            view = create(createElement(TradePage, { code: '2330' }), {
                createNodeMock: el => ((el.props as { className?: string }).className === undefined ? null : { closest: (sel: string) => (sel === 'main' ? main : null), nodeType: 1 }),
            });
        });
        const compactSwitch = () => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === 'trade-compact-switch');
        expect(compactSwitch()).toHaveLength(0);
        const header = observers.find(o => o.opts?.root === main)!;
        await act(async () => {
            header.cb([{ isIntersecting: false, boundingClientRect: { top: -2 }, rootBounds: { top: 0 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
        });
        expect(compactSwitch()).toHaveLength(1);
        const btn = compactSwitch()[0]!;
        expect(btn.props.type).toBe('button');
        expect(btn.props['aria-label']).toBe('切換商品，目前 2330 台積電');
        expect(btn.props['aria-haspopup']).toBe('dialog');
        expect(ancestors(btn).some(a => a.props?.['aria-hidden'] === 'true')).toBe(false);
        expect(byId('trade-compact').props['aria-hidden']).toBe('true');
        await act(async () => { btn.props.onClick(); });
        expect(sheetOpen()).toBe(true);
        await act(async () => {
            header.cb([{ isIntersecting: true, boundingClientRect: { top: 10 }, rootBounds: { top: 0 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
        });
        expect(compactSwitch()).toHaveLength(0);
    });

    describe('代理輸入框', () => {
        interface FakeEl {
            tag: string; style: Record<string, string>; tabIndex: number; type: string; isConnected: boolean;
            setAttribute: (k: string, v: string) => void;
            focus: ReturnType<typeof vi.fn>; blur: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>;
        }
        let body: FakeEl[];
        let doc: {
            activeElement: unknown; body: unknown; visibilityState: string;
            createElement: (t: string) => FakeEl; addEventListener: () => void; removeEventListener: () => void;
        };
        const inputNode = { focus: vi.fn(() => { doc.activeElement = inputNode; }) };
        beforeEach(() => {
            body = [];
            inputNode.focus.mockClear();
            doc = {
                activeElement: null,
                visibilityState: 'visible',
                body: { appendChild: (el: FakeEl) => { body.push(el); el.isConnected = true; return el; } },
                createElement: (tag: string) => {
                    const el: FakeEl = {
                        tag, style: {}, tabIndex: 0, type: '', isConnected: false,
                        setAttribute: () => undefined,
                        focus: vi.fn(() => { doc.activeElement = el; }),
                        blur: vi.fn(() => { if (doc.activeElement === el) doc.activeElement = null; }),
                        remove: vi.fn(() => { body.splice(body.indexOf(el), 1); el.isConnected = false; }),
                    };
                    return el;
                },
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
            };
            vi.stubGlobal('document', doc);
            // 假時鐘不前進：可動畫的面板停在進場中
            setMotionClockForTest({ now: () => 0, frame: () => 1, cancel: () => undefined });
        });
        afterEach(() => { setMotionClockForTest(null); });

        /** 面板可動畫（進場中）；搜尋框是可聚焦的假節點 */
        const animMock = (el: ReactElement) => {
            const p = el.props as Record<string, unknown>;
            if (p['data-testid'] === 'trade-switch-input') return inputNode;
            if (p.role === 'dialog') return { style: {}, isConnected: true, getBoundingClientRect: () => ({ height: 600, width: 390 }), focus: vi.fn(), contains: () => false };
            return null;
        };
        const renderWith = async (createNodeMock: (el: ReactElement) => unknown) => {
            await act(async () => { view = create(createElement(TradePage, { code: '2330' }), { createNodeMock }); });
        };

        it('同步模式：點擊建立並聚焦暫時 input，面板就緒後焦點移到搜尋框、暫時 input 移除', async () => {
            await renderWith(el => ((el.props as Record<string, unknown>)['data-testid'] === 'trade-switch-input' ? inputNode : null));
            await act(async () => { switchBtn().props.onClick(); });
            expect(inputNode.focus).toHaveBeenCalledTimes(1);
            expect(doc.activeElement).toBe(inputNode);
            expect(body).toHaveLength(0);
        });

        it('進場中暫時 input 持有焦點；進場前關閉：暫時 input 失焦並移除，搜尋框不被聚焦', async () => {
            await renderWith(animMock);
            await act(async () => { switchBtn().props.onClick(); });
            expect(body).toHaveLength(1);
            const proxy = body[0]!;
            expect(proxy.tag).toBe('input');
            expect(proxy.style).toMatchObject({ position: 'fixed', top: '0', opacity: '0', fontSize: '16px' });
            expect(doc.activeElement).toBe(proxy);
            const close = view!.root.find(n => n.type === 'button' && n.props['aria-label'] === '關閉');
            await act(async () => { close.props.onClick(); });
            expect(proxy.blur).toHaveBeenCalled();
            expect(body).toHaveLength(0);
            expect(inputNode.focus).not.toHaveBeenCalled();
        });

        it('進場中卸載交易頁：暫時 input 失焦並移除', async () => {
            await renderWith(animMock);
            await act(async () => { switchBtn().props.onClick(); });
            expect(body).toHaveLength(1);
            await act(async () => { view!.unmount(); });
            view = undefined;
            expect(body).toHaveLength(0);
            expect(doc.activeElement).toBeNull();
        });
    });

    describe('選了其他商品後的焦點', () => {
        interface KeyNode { focus: ReturnType<typeof vi.fn>; isConnected: boolean; closest: (s: string) => unknown }
        let keys: KeyNode[];
        let inertKeys: boolean;
        let now = 0;
        let frames = new Map<number, (t: number) => void>();
        let nextId = 1;
        const step = async (ms = 16) => {
            await act(async () => {
                now += ms;
                const fs = Array.from(frames.values());
                frames = new Map();
                fs.forEach(f => f(now));
            });
        };
        const keyMock = (el: ReactElement) => {
            if ((el.props as Record<string, unknown>)['data-testid'] !== 'trade-switch') return null;
            const node: KeyNode = { focus: vi.fn(), isConnected: true, closest: () => (inertKeys ? {} : null) };
            keys.push(node);
            return node;
        };
        /** 面板可動畫（退場有動畫）；切換鍵是可聚焦的假節點 */
        const animMock = (el: ReactElement) => {
            const p = el.props as Record<string, unknown>;
            if (p.role === 'dialog') return { style: {}, isConnected: true, getBoundingClientRect: () => ({ height: 600, width: 390 }), focus: vi.fn(), contains: () => false };
            if (p['data-testid'] === 'trade-switch-input') return { focus: vi.fn() };
            return keyMock(el);
        };
        const renderWith = async (createNodeMock: (el: ReactElement) => unknown) => {
            await act(async () => { view = create(createElement(TradePage, { code: '2330' }), { createNodeMock }); });
        };
        const settle = async () => { for (let t = 0; t < 1500 && frames.size > 0; t += 16) await step(); };
        const pickHon = async () => {
            await act(async () => { switchBtn().props.onClick(); });
            await settle(); // 進場跑完（否則面板還在起點，退場彈簧立即到位）
            await typeQuery('鴻');
            const pick = view!.root.find(n => n.props['data-testid'] === 'trade-switch-pick' && n.props['data-code'] === '2317');
            await act(async () => { pick.props.onClick(); });
            expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2317' }, { replace: true });
        };
        /** 模擬 hash 路由換成新代碼（navigate 是 mock） */
        const routeTo = async (code: string) => {
            m.useContract.mockReturnValue({ ...stock, code, name: '鴻海' });
            await act(async () => { view!.update(createElement(TradePage, { code })); });
        };
        const closing = () => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === 'trade-switch-sheet-closing');
        beforeEach(() => {
            keys = [];
            inertKeys = false;
            now = 1000;
            frames = new Map();
            nextId = 1;
            m.searchProducts.mockResolvedValue([tradeHon]);
            setMotionClockForTest({
                now: () => now,
                frame: cb => { const id = nextId++; frames.set(id, cb); return id; },
                cancel: id => { frames.delete(id); },
            });
        });
        afterEach(() => { setMotionClockForTest(null); });

        it('可動畫：路由先換、退場還沒結束不移焦點；退場結束後焦點移到新頁的切換鍵（preventScroll）', async () => {
            await renderWith(animMock);
            await pickHon();
            expect(closing()).toHaveLength(1);
            await routeTo('2317');
            expect(keys.length).toBeGreaterThanOrEqual(2);
            const fresh = keys[keys.length - 1]!;
            expect(fresh.focus).not.toHaveBeenCalled(); // 面板仍在退場（殼層可能仍 inert）
            for (let t = 0; t < 3000 && closing().length > 0; t += 16) await step();
            expect(closing()).toHaveLength(0);
            expect(fresh.focus).toHaveBeenCalledTimes(1);
            expect(fresh.focus).toHaveBeenCalledWith({ preventScroll: true });
            keys.slice(0, -1).forEach(k => expect(k.focus).not.toHaveBeenCalled());
        });

        it('同步模式：退場先結束、路由後換；新頁切換鍵掛上後才聚焦', async () => {
            await renderWith(keyMock);
            await pickHon();
            keys.forEach(k => expect(k.focus).not.toHaveBeenCalled()); // 舊頁的鍵不聚焦（即將卸載）
            await routeTo('2317');
            const fresh = keys[keys.length - 1]!;
            expect(fresh.focus).toHaveBeenCalledWith({ preventScroll: true });
            keys.slice(0, -1).forEach(k => expect(k.focus).not.toHaveBeenCalled());
        });

        it('目標在 inert／aria-hidden 內：不聚焦', async () => {
            await renderWith(keyMock);
            await pickHon();
            inertKeys = true;
            await routeTo('2317');
            keys.forEach(k => expect(k.focus).not.toHaveBeenCalled());
        });

        it('一般關閉（關閉鈕）、點目前商品：不由這裡移焦點；之後換路由也不聚焦', async () => {
            store.set('sj-mobile-recent-codes', JSON.stringify([{ code: '2330', name: '台積電', securityType: 'STK' }]));
            await renderWith(animMock);
            await act(async () => { switchBtn().props.onClick(); });
            await settle();
            const close = view!.root.find(n => n.type === 'button' && n.props['aria-label'] === '關閉');
            await act(async () => { close.props.onClick(); });
            expect(closing()).toHaveLength(1);
            for (let t = 0; t < 3000 && closing().length > 0; t += 16) await step();
            await act(async () => { switchBtn().props.onClick(); });
            await settle();
            const current = view!.root.find(n => n.props['data-testid'] === 'trade-switch-pick' && n.props['data-code'] === '2330');
            await act(async () => { current.props.onClick(); });
            for (let t = 0; t < 3000 && closing().length > 0; t += 16) await step();
            expect(closing()).toHaveLength(0);
            expect(m.navigate).not.toHaveBeenCalled();
            await routeTo('2317');
            keys.forEach(k => expect(k.focus).not.toHaveBeenCalled());
        });
    });
});

describe('交易狀態只重繪需要它的葉節點（稽核 P2）', () => {
    /** 可發布的交易狀態 store（取代 mock 的 useTradingState，行為同 lib：useSyncExternalStore 訂閱） */
    function tradingStore(initial: { trades: AccountedTrade[]; positions: AccountedPosition[] }) {
        let state = initial;
        const listeners = new Set<() => void>();
        const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
        m.useTradingState.mockImplementation(() => useSyncExternalStore(subscribe, () => state));
        return {
            get: () => state,
            publish: (next: typeof state) => act(async () => { state = next; listeners.forEach(l => l()); }),
        };
    }
    const headerRenders = () => m.useQuote.mock.calls.filter(c => (c[1] as { narrow?: boolean } | undefined)?.narrow === true).length;
    const depthRenders = () => m.useQuote.mock.calls.filter(c => c[1] !== undefined && 'oddLot' in (c[1] as object)).length;
    const chartRenders = () => m.chartProps.length;

    it('持倉市價重估（只換 positions）：標頭、五檔、圖表不重繪；持倉摘要數值更新', async () => {
        const trades = [trade('a', '2330'), trade('c', '2317')];
        const store = tradingStore({ trades, positions: [pos('2330', 3000, 1052.5, 97500, { cond: 'Cash' }), pos('2317', 1000, 100, 0, { cond: 'Cash' })] });
        await render();
        const h0 = headerRenders();
        const d0 = depthRenders();
        const c0 = chartRenders();
        expect(h0).toBeGreaterThan(0);
        expect(d0).toBeGreaterThan(0);
        expect(c0).toBeGreaterThan(0);
        expect(text(byId('trade-summary'))).toContain('+97,500');

        // 市價重估：同一批委託（trades 參考不變），持倉換新物件、損益改變
        for (const pnl of [98_000, 99_500, -1_200]) {
            const prev = store.get();
            await store.publish({ trades: prev.trades, positions: [pos('2330', 3000, 1052.5, pnl, { last_price: 1052.5 + pnl / 3000, cond: 'Cash' }), prev.positions[1]!] });
        }
        expect(headerRenders()).toBe(h0);
        expect(depthRenders()).toBe(d0);
        expect(chartRenders()).toBe(c0);
        expect(text(byId('trade-summary'))).toContain('-1,200');
        expect(text(byId('trade-summary'))).toContain('現股 3張 · 均價 1,052.5');
        // 圖表拿到的線不變（成本線、委託線）
        const lines = (m.chartProps.at(-1) as { lines: { key: string; price: number }[] }).lines;
        expect(lines.map(l => l.key)).toContain('order:a');
        expect(lines.find(l => l.key.startsWith('cost'))?.price).toBe(1052.5);
    });

    it('委託改變：五檔（委託標記）與圖表（委託線）重繪；標頭仍不重繪', async () => {
        const store = tradingStore({ trades: [trade('a', '2330')], positions: [pos('2330', 3000, 1052.5, 97500, { cond: 'Cash' })] });
        await render();
        const h0 = headerRenders();
        const d0 = depthRenders();
        const c0 = chartRenders();
        await store.publish({ trades: [...store.get().trades, trade('e', '2330')], positions: store.get().positions });
        expect(headerRenders()).toBe(h0);
        expect(depthRenders()).toBeGreaterThan(d0);
        expect(chartRenders()).toBeGreaterThan(c0);
        expect((m.chartProps.at(-1) as { lines: { key: string }[] }).lines.map(l => l.key)).toEqual(expect.arrayContaining(['order:a', 'order:e']));
        expect(text(byId('trade-working-link'))).toContain('未成交：2 筆');
    });

    it('持倉成本改變（加碼成交、均價改變）：圖表成本線更新', async () => {
        const store = tradingStore({ trades: [], positions: [pos('2330', 3000, 1052.5, 97500, { cond: 'Cash' })] });
        await render();
        const c0 = chartRenders();
        await store.publish({ trades: [], positions: [pos('2330', 4000, 1060, 90000, { cond: 'Cash' })] });
        expect(chartRenders()).toBeGreaterThan(c0);
        expect((m.chartProps.at(-1) as { lines: { key: string; price: number }[] }).lines.find(l => l.key.startsWith('cost'))?.price).toBe(1060);
        expect(text(byId('trade-summary'))).toContain('現股 4張 · 均價 1,060');
    });
});

// ---- 當沖資訊列與「籌碼與當沖」面板（設計規格 §7.3、§10 S1、§13） ----

describe('TradePage 當沖資訊列：報價與合約不是同一交易日', () => {
    const chipIds = () => view!.root.findAll(n => typeof n.type === 'string' && /^trade-info-(daytrade|limit|range|ratio|punish)$/.test(String(n.props['data-testid'] ?? '')))
        .map(n => String(n.props['data-testid']));

    it('盤前快照仍是分割前的價格（快照推出的參考價與合約差很多）：不顯示停板膠囊，小條改畫最低到最高', async () => {
        // 合約已換成今天的參考價 1,070 與漲跌停；快照是昨天的 188.65（漲 2.00 → 快照的參考 186.65）
        m.useQuote.mockReturnValue(undefined); // 還沒有成交：主價用快照
        m.snapshot = { code: '2330', datetime: '2026-11-05 13:30:00', close: 188.65, change_price: 2, change_rate: 1.07, total_volume: 23456, open: 187, high: 190, low: 186.5 };
        await render();
        // 沒有同一天檢查時 188.65 ≤ 跌停 963 會被當成「跌停」
        expect(chipIds()).not.toContain('trade-info-limit');
        expect(chipIds()).toContain('trade-info-range');
        expect(byId('trade-info-bar').props['data-mode']).toBe('span');
        // 振幅以快照自身的參考價（186.65）計：(190 − 186.5) ÷ 186.65
        expect(text(byId('trade-info-range'))).toContain(`振幅 ${((3.5 / 186.65) * 100).toFixed(2)}%`);
    });

    it('同一交易日（快照推出的參考價＝合約參考價）：照常判停板', async () => {
        m.useQuote.mockReturnValue(undefined);
        m.snapshot = { code: '2330', datetime: '2026-11-06 10:00:00', close: 1175, change_price: 105, change_rate: 9.81, total_volume: 23456, open: 1080, high: 1175, low: 1075 };
        await render();
        expect(chipIds()).toContain('trade-info-limit');
        expect(text(byId('trade-info-limit'))).toBe('漲停');
        expect(byId('trade-info-bar').props['data-mode']).toBe('rail');
    });
});

describe('TradePage 當沖資訊列', () => {
    const CHIP_ID = /^trade-info-(daytrade|limit|range|ratio|punish)$/;
    const chipKeys = () => byId('trade-info-strip')
        .findAll(n => typeof n.type === 'string' && CHIP_ID.test(String(n.props['data-testid'] ?? '')))
        .map(n => String(n.props['data-testid']).slice('trade-info-'.length));
    const strips = () => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === 'trade-info-strip');
    const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
    const fut = { ...stock, code: 'TXFL6', security_type: 'FUT', exchange: 'TAIFEX', name: '臺股期貨', underlying_kind: 'I', delivery_month: '202612', limit_up: 24640, limit_down: 20160, reference: 22400, day_trade: '' } as ContractInfo;
    const opt = { ...stock, code: 'TXO22400L6', security_type: 'OPT', exchange: 'TAIFEX', name: '臺指選擇權', limit_up: 2500, limit_down: 0.1, reference: 260, day_trade: '' } as ContractInfo;
    const ind = { ...stock, code: '001', security_type: 'IND', exchange: 'TSE', name: '加權指數', limit_up: 0, limit_down: 0, reference: 22000, day_trade: '' } as ContractInfo;
    const use = (c: ContractInfo) => { m.useContract.mockReturnValue(c); m.ensureContract.mockResolvedValue(c); };

    it('股票：依序顯示可當沖／先賣、接近漲停、振幅小條、量比、處置；處置名單只在股票時讀', async () => {
        m.punished = new Set(['2330']);
        m.snapshot = { code: '2330', datetime: '2026-11-06 09:30:00', close: 1085, change_price: 15, change_rate: 1.4, total_volume: 20000, yesterday_volume: 20000 };
        m.useQuote.mockReturnValue({ tick: { code: '2330', date: '2026/11/06', time: '10:00:00', close: '1165', price_chg: '95', open: '1080', high: '1170', low: '1075', total_volume: 23456 } });
        await render();
        expect(chipKeys()).toEqual(['daytrade', 'limit', 'range', 'ratio', 'punish']);
        expect(text(byId('trade-info-daytrade'))).toBe('可當沖・可先賣');
        expect(text(byId('trade-info-limit'))).toBe('接近漲停');
        expect(text(byId('trade-info-range'))).toContain('振幅 8.88%');
        expect(text(byId('trade-info-range'))).toContain('現價位於今日最低到最高的'); // 小條的文字等價（視覺隱藏）
        expect(byId('trade-info-bar').props['aria-hidden']).toBe('true');
        expect(byId('trade-info-bar').props['data-mode']).toBe('rail');
        expect(text(byId('trade-info-ratio'))).toBe('量比 1.17');
        expect(text(byId('trade-info-punish'))).toBe('處置股');
        expect(m.punishActive.at(-1)).toBe(true);
        // 既有標頭不變：「可當沖」徽章與漲跌停列照舊
        expect(text(byId('trade-daytrade'))).toBe('可當沖');
        expect(text(byId('trade-info'))).toContain('漲停 1,175');
    });

    it('當沖狀態：僅先買後賣、不可當沖（文字，不只靠顏色）', async () => {
        use({ ...stock, day_trade: 'OnlyBuy' });
        await render();
        expect(text(byId('trade-info-daytrade'))).toBe('僅先買後賣');
        await act(async () => view?.unmount());
        use({ ...stock, day_trade: 'No' });
        await render();
        expect(text(byId('trade-info-daytrade'))).toBe('不可當沖');
    });

    it('漲跌停狀態：鎖漲停（委賣已空）、漲停未鎖、鎖跌停、跌停（沒有五檔）；只有參考價時不判斷', async () => {
        m.useQuote.mockReturnValue({ tick: { code: '2330', close: '1175', price_chg: '105', total_volume: 1 }, bidask: { bid_price: ['1175', '1170'], bid_volume: [900, 3], ask_price: [], ask_volume: [] } });
        await render();
        expect(text(byId('trade-info-limit'))).toBe('鎖漲停');
        await act(async () => view?.unmount());

        m.useQuote.mockReturnValue({ tick: { code: '2330', close: '1175', price_chg: '105', total_volume: 1 }, bidask: { bid_price: ['1170'], bid_volume: [3], ask_price: ['1175'], ask_volume: [5] } });
        await render();
        expect(text(byId('trade-info-limit'))).toBe('漲停未鎖');
        await act(async () => view?.unmount());

        m.useQuote.mockReturnValue({ tick: { code: '2330', close: '963', price_chg: '-107', total_volume: 1 }, bidask: { bid_price: [], bid_volume: [], ask_price: ['963'], ask_volume: [800] } });
        await render();
        expect(text(byId('trade-info-limit'))).toBe('鎖跌停');
        await act(async () => view?.unmount());

        m.useQuote.mockReturnValue({ tick: { code: '2330', close: '963', price_chg: '-107', total_volume: 1 } });
        await render();
        expect(text(byId('trade-info-limit'))).toBe('跌停');
        await act(async () => view?.unmount());

        m.useQuote.mockReturnValue(undefined);
        use({ ...stock, reference: 1175 });
        await render();
        expect(view!.root.findAllByProps({ 'data-testid': 'trade-info-limit' })).toHaveLength(0);
        expect(chipKeys()).toEqual(['daytrade']);
    });

    it('期貨：只顯示漲跌停狀態與振幅；不顯示當沖、量比、處置，也不讀處置名單', async () => {
        use(fut);
        m.punished = new Set(['TXFL6']);
        m.snapshot = { code: 'TXFL6', datetime: '2026-11-06 09:30:00', close: 22450, change_price: 50, change_rate: 0.2, total_volume: 1000, yesterday_volume: 1000 };
        m.useQuote.mockReturnValue({ tick: { code: 'TXFL6', date: '2026/11/06', time: '10:00:00', close: '24500', price_chg: '2100', open: '22400', high: '24550', low: '22380', total_volume: 80000 } });
        await render('TXFL6');
        expect(chipKeys()).toEqual(['limit', 'range']);
        expect(text(byId('trade-info-limit'))).toBe('接近漲停');
        expect(m.punishActive.length).toBeGreaterThan(0);
        expect(m.punishActive.every(a => a === false)).toBe(true);
    });

    it('選擇權：只顯示振幅（整條是最低到最高）', async () => {
        use(opt);
        m.useQuote.mockReturnValue({ tick: { code: 'TXO22400L6', close: '270', price_chg: '10', open: '250', high: '300', low: '240', total_volume: 10 } });
        await render('TXO22400L6');
        expect(chipKeys()).toEqual(['range']);
        expect(byId('trade-info-bar').props['data-mode']).toBe('span');
        expect(m.punishActive.every(a => a === false)).toBe(true);
    });

    it('指數：只顯示振幅；沒有高低資料時整列不佔版面', async () => {
        use(ind);
        m.useQuote.mockReturnValue({ index: { close: '22100', reference: '22000', open: '22010', high: '22200', low: '21900' } });
        await render('001');
        expect(chipKeys()).toEqual(['range']);
        expect(text(byId('trade-info-range'))).toContain('振幅 1.36%');
        await act(async () => view?.unmount());
        m.useQuote.mockReturnValue(undefined);
        await render('001');
        expect(strips()).toHaveLength(0);
    });

    it('點資訊列只開唯讀「籌碼與當沖」面板（點了才載入）；S1：openTicket／openOrderAction 與 lib 送出函式 0 次', async () => {
        m.punished = new Set(['2330']);
        await render();
        expect(m.chipsSheetProps).toHaveLength(0);
        const strip = byId('trade-info-strip');
        expect(strip.type).toBe('button');
        expect(strip.props['aria-haspopup']).toBe('dialog');
        expect(strip.props['aria-expanded']).toBe(false);
        expect(text(strip)).toContain('開啟籌碼與當沖說明');
        await act(async () => { strip.props.onClick(); });
        await settle();
        expect(view!.root.findAllByProps({ 'data-testid': 'chips-sheet-stub' })).toHaveLength(1);
        expect(m.chipsSheetProps.at(-1)).toMatchObject({ open: true, punished: true, contract: { code: '2330' } });
        expect(byId('trade-info-strip').props['aria-expanded']).toBe(true);
        await act(async () => { (m.chipsSheetProps.at(-1) as unknown as { onClose: () => void }).onClose(); });
        expect(m.chipsSheetProps.at(-1)).toMatchObject({ open: false });
        expect(byId('trade-info-strip').props['aria-expanded']).toBe(false);
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });

    it('處置名單還沒成功取得過：面板拿到 null（寫「處置名單尚未取得」，不當成未處置），資訊列沒有處置膠囊', async () => {
        m.punishLoaded = false;
        await render();
        expect(chipKeys()).not.toContain('punish');
        await act(async () => { byId('trade-info-strip').props.onClick(); });
        await settle();
        expect(m.chipsSheetProps.at(-1)).toMatchObject({ open: true, punished: null, contract: { code: '2330' } });
        // 名單取得後（不在名單）：false
        m.punishLoaded = true;
        await render();
        await act(async () => { byId('trade-info-strip').props.onClick(); });
        await settle();
        expect(m.chipsSheetProps.at(-1)).toMatchObject({ open: true, punished: false });
    });

    it('遮擋：資訊列在標頭內、一般文件流，排在圖表、分頁列與五檔之前；不在殼層槽，樣式不用 fixed／sticky／absolute、z-index 或負邊界', async () => {
        m.useQuote.mockReturnValue({
            tick: { code: '2330', close: '1085', price_chg: '15', open: '1065', high: '1090', low: '1060', total_volume: 23456 },
            bidask: { bid_price: ['1080'], bid_volume: [5], ask_price: ['1085'], ask_volume: [4] },
        });
        await render();
        const strip = byId('trade-info-strip');
        const ancestors: unknown[] = [];
        for (let p = strip.parent; p; p = p.parent) ancestors.push(p.type);
        expect(ancestors).toContain('header');
        expect(ancestors).not.toContain(ShellSlot);
        // 文件順序：資訊列 → 分頁列（五檔｜明細｜公司）
        const order = byId('page-trade')
            .findAll(n => typeof n.type === 'string' && ['trade-info-strip', 'trade-panel-row'].includes(String(n.props['data-testid'])))
            .map(n => n.props['data-testid']);
        expect(order).toEqual(['trade-info-strip', 'trade-panel-row']);
        expect(String(strip.props.className)).toBe(tradeInfoStyles.strip);
        const src = readFileSync(new URL('../styles/trade-info.css.ts', import.meta.url), 'utf8');
        const start = src.indexOf('export const strip = style(');
        const block = src.slice(start, src.indexOf('\nexport ', start + 1));
        expect(block).not.toMatch(/position:\s*'(fixed|sticky|absolute)'/);
        expect(block).not.toMatch(/zIndex|transform|translate/);
        expect(block).not.toMatch(/margin\w*:\s*[`'"]-/);
        expect(block).toContain('minHeight: TOUCH_MIN');
        expect(block).toContain("flexWrap: 'wrap'");
        // 五檔與分頁列的樣式不受影響（trade.css.ts 沒有引用資訊列樣式）
        expect(readFileSync(new URL('../styles/trade.css.ts', import.meta.url), 'utf8')).not.toContain('trade-info');
    });
});

// ---- P1：標頭 ☆ 加入／移出目前的自選清單（殼層 WatchlistProvider；§10 S1） ----

describe('TradePage 自選 ☆', () => {
    type Wl = {
        items: { contract: { code: string } }[];
        loading: boolean;
        structureBusy: boolean;
        loadError: boolean;
        serverLists: { id: string; name: string }[];
        activeListId: string | null;
        addSymbol: ReturnType<typeof vi.fn>;
        removeSymbol: ReturnType<typeof vi.fn>;
    };
    const makeWl = (over: Partial<Wl> = {}): Wl => ({
        items: [],
        loading: false,
        structureBusy: false,
        loadError: false,
        serverLists: [{ id: 'L1', name: '我的自選' }, { id: 'L2', name: '短線' }],
        activeListId: 'L2',
        addSymbol: vi.fn(async () => stock),
        removeSymbol: vi.fn(async () => undefined),
        ...over,
    });
    const star = () => byId('trade-watch-star');
    const settleClick = async () => {
        await act(async () => { star().props.onClick(); });
        await act(async () => { await Promise.resolve(); });
    };

    it('不在 WatchlistProvider 內時不顯示', async () => {
        await render();
        expect(view!.root.findAllByProps({ 'data-testid': 'trade-watch-star' })).toHaveLength(0);
    });

    it('在標頭上半的右欄（不在名稱列、主價列內）；44px IconButton、aria-pressed＝是否已在目前清單', async () => {
        m.wl = makeWl();
        await render();
        const b = star();
        expect(b.type).toBe('button');
        expect(b.props['aria-pressed']).toBe(false);
        expect(b.props['aria-label']).toBe('自選（短線）');
        // 版面：☆ 外框（watchStar）是 headTop 的直接子節點，與 headMain（名稱列＋主價列）並列
        let cell = b.parent!;
        while (typeof cell.type !== 'string') cell = cell.parent!;
        expect(cell.props.className).toBe(tradeStyles.watchStar);
        let top = cell.parent!;
        while (typeof top.type !== 'string') top = top.parent!;
        expect(top.props.className).toBe(tradeStyles.headTop);
        const main = top.findAll(n => n.props.className === tradeStyles.headMain);
        expect(main).toHaveLength(1);
        expect(main[0]!.findAll(n => n.props['data-testid'] === 'trade-watch-star')).toHaveLength(0);
        expect(main[0]!.findAll(n => n.props['data-testid'] === 'trade-switch' && n.type === 'button')).toHaveLength(1);
        expect(main[0]!.findAll(n => n.props['data-testid'] === 'trade-price')).toHaveLength(1);
        // 當沖資訊列在標頭下方另一個區塊，不在 headTop 內
        expect(byId('trade-info-strip')).toBeTruthy();
        expect(top.findAll(n => n.props['data-testid'] === 'trade-info-strip')).toHaveLength(0);

        m.wl = makeWl({ items: [{ contract: { code: '2330' } }] });
        await render();
        expect(star().props['aria-pressed']).toBe(true);
    });

    it('加入：以已載入的合約呼叫 addSymbol（不重新解析）並以通知回報；完成前不能再按（aria-disabled，焦點不掉）', async () => {
        let release!: () => void;
        const wl = makeWl({ addSymbol: vi.fn(() => new Promise(r => { release = () => r(stock); })) });
        m.wl = wl;
        await render();
        await act(async () => { star().props.onClick(); });
        expect(wl.addSymbol).toHaveBeenCalledWith('2330', 'STK', stock);
        // 處理中：只標 aria-disabled（disabled 會讓聚焦中的按鈕失去焦點），再按一次被忽略
        expect(star().props.disabled).toBe(false);
        expect(star().props['aria-disabled']).toBe(true);
        expect(star().props['aria-label']).toBe('自選（短線），自選清單更新中');
        await act(async () => { star().props.onClick(); });
        expect(wl.addSymbol).toHaveBeenCalledTimes(1);
        await act(async () => { release(); });
        expect(m.notify).toHaveBeenCalledWith({ kind: 'ok', title: '已加入自選', body: '2330 台積電 已加入「短線」' });
        expect(star().props.disabled).toBe(false);
        expect(star().props['aria-disabled']).toBeUndefined();
        expect(wl.removeSymbol).not.toHaveBeenCalled();
    });

    it('StrictMode（開發版）：模擬卸載再掛載後，加入完成仍會恢復可按（mounted 旗標掛載時設回 true）', async () => {
        let release!: () => void;
        const wl = makeWl({ addSymbol: vi.fn(() => new Promise(r => { release = () => r(stock); })) });
        m.wl = wl;
        await act(async () => { view = create(createElement(StrictMode, null, createElement(TradePage, { code: '2330' }))); });
        await act(async () => { star().props.onClick(); });
        expect(star().props['aria-disabled']).toBe(true);
        await act(async () => { release(); });
        expect(star().props['aria-disabled']).toBeUndefined();
        expect(star().props.disabled).toBe(false);
    });

    it('移出：已在清單時呼叫 removeSymbol 並通知；失敗時以錯誤通知顯示原因', async () => {
        const wl = makeWl({ items: [{ contract: { code: '2330' } }] });
        m.wl = wl;
        await render();
        await settleClick();
        expect(wl.removeSymbol).toHaveBeenCalledWith('2330');
        expect(m.notify).toHaveBeenLastCalledWith({ kind: 'ok', title: '已移出自選', body: '2330 台積電 已從「短線」移除' });

        m.wl = makeWl({ addSymbol: vi.fn(async () => { throw new Error('自選清單已切換，請重新新增商品'); }) });
        await render();
        await settleClick();
        expect(m.notify).toHaveBeenLastCalledWith({ kind: 'err', title: '加入自選失敗', body: '自選清單已切換，請重新新增商品' });
        expect(star().props.disabled).toBe(false);
    });

    it('清單載入中、更新中、載入失敗、合約未載入、組合商品：停用並在無障礙名稱說明原因', async () => {
        const wl = { loading: false, structureBusy: false, loadError: false };
        expect(watchStarBlocked(wl, stock, false)).toBeNull();
        expect(watchStarBlocked(wl, undefined, false)).toBe('商品載入中');
        expect(watchStarBlocked(wl, { combo: {} } as never, false)).toBe('組合商品不能加入自選');
        expect(watchStarBlocked({ ...wl, loadError: true }, stock, false)).toBe('自選清單載入失敗');
        expect(watchStarBlocked({ ...wl, loading: true }, stock, false)).toBe('自選清單更新中');
        expect(watchStarBlocked({ ...wl, structureBusy: true }, stock, false)).toBe('自選清單更新中');
        expect(watchStarBlocked(wl, stock, true)).toBe('自選清單更新中');

        for (const over of [{ loading: true }, { structureBusy: true }, { loadError: true }]) {
            const w = makeWl(over);
            m.wl = w;
            await render();
            expect(star().props.disabled, JSON.stringify(over)).toBe(true);
            await act(async () => { star().props.onClick(); });
            expect(w.addSymbol).not.toHaveBeenCalled();
        }
        m.useContract.mockReturnValue(undefined);
        m.wl = makeWl();
        await render();
        expect(star().props.disabled).toBe(true);
        expect(star().props['aria-label']).toBe('自選（短線），商品載入中');
    });

    it('S1：☆ 加入與移出都不開下單或委託面板，lib 送單／改單／刪單 0 次', async () => {
        m.wl = makeWl();
        await render();
        await settleClick();
        m.wl = makeWl({ items: [{ contract: { code: '2330' } }] });
        await render();
        await settleClick();
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });
});
