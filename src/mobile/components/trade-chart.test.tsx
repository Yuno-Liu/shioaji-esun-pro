// 交易圖表互動（規格 §6.2）：長按→放開只浮出「以 X 買進／賣出」並以 roundToTick 取整，點選後才開下單面板（不送單）；
// 輕點不觸發；委託線標籤開啟委託操作面板；歷史載入失敗可重新載入。lightweight-charts 以假物件替代。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { PriceLineSpec } from '../lib/chart-model';

const m = vi.hoisted(() => {
    const series = () => ({
        setData: vi.fn(),
        update: vi.fn(),
        applyOptions: vi.fn(),
        createPriceLine: vi.fn(() => ({})),
        removePriceLine: vi.fn(),
        // 價格 ↔ 座標：y = 2000 - price（高度 300 → 可見 1700–2000）
        priceToCoordinate: vi.fn((p: number) => 2000 - p - 700),
        coordinateToPrice: vi.fn((y: number) => 2000 - y - 700),
    });
    const chart = {
        addSeries: vi.fn((_type: unknown, _options?: unknown) => series()),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        timeScale: vi.fn(() => ({
            subscribeVisibleLogicalRangeChange: vi.fn(),
            subscribeSizeChange: vi.fn(),
            fitContent: vi.fn(),
            setVisibleLogicalRange: vi.fn(),
        })),
        subscribeCrosshairMove: vi.fn(),
        remove: vi.fn(),
    };
    return {
        chart,
        createChart: vi.fn(() => chart),
        fetchChartHistory: vi.fn(),
        openTicket: vi.fn(),
        openOrderAction: vi.fn(),
    };
});

vi.mock('lightweight-charts', () => ({
    BaselineSeries: 'Baseline',
    CandlestickSeries: 'Candlestick',
    HistogramSeries: 'Histogram',
    LineSeries: 'Line',
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    TrackingModeExitMode: { OnTouchEnd: 0 },
    createChart: m.createChart,
}));
vi.mock('../../lib/chart-history', () => ({ fetchChartHistory: m.fetchChartHistory, nextChartHistoryRevision: () => 7 }));
vi.mock('../../lib/stream', () => ({ onAnyTick: () => () => undefined }));
vi.mock('../../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../../lib/theme-store', () => ({
    useThemeSettings: () => ({}),
    themeKey: () => 'dark-tw',
    getChartColors: () => ({ up: '#f00', upVol: '#f008', down: '#0f0', downVol: '#0f08', text: '#888', grid: '#111', crosshair: '#36f', border: '#222', labelBg: '#000' }),
}));
vi.mock('../lib/mobile-store', () => ({ openTicket: m.openTicket, openOrderAction: m.openOrderAction }));

import { LONG_PRESS_MS, TradeChart } from './trade-chart';

const contract = {
    exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 1070, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as ContractInfo;

const KBARS = { datetime: ['2026-11-05 09:01:00', '2026-11-05 09:02:00'], Open: [1070, 1075], High: [1076, 1080], Low: [1069, 1074], Close: [1075, 1078], Volume: [10, 20], Amount: [0, 0] };
const ORDER_LINE: PriceLineSpec = { key: 'order:o1', price: 1080, kind: 'order-buy', label: '買 2 @1,080', tradeId: 'o1' };

let view: ReactTestRenderer | undefined;
const nodeMock = () => ({ clientHeight: 300, getBoundingClientRect: () => ({ top: 0, left: 0 }) });
const wrap = (): ReactTestInstance => view!.root.findByProps({ 'data-testid': 'trade-chart' });
const ptr = (x: number, y: number) => ({ pointerType: 'touch', button: 0, clientX: x, clientY: y });
const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    m.fetchChartHistory.mockReset().mockResolvedValue(KBARS);
    m.createChart.mockClear();
    m.chart.addSeries.mockClear();
    m.openTicket.mockReset();
    m.openOrderAction.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function render(lines: PriceLineSpec[] = [ORDER_LINE], period: '5m' | 'line' = '5m') {
    await act(async () => {
        view = create(createElement(TradeChart, { code: '2330', contract, period, lines }), { createNodeMock: nodeMock });
    });
    await tick(50);
}

describe('TradeChart', () => {
    it('以手機區間查詢歷史；週期為 5 分 K 時建立 K 線＋量＋MA5／MA20', async () => {
        await render();
        expect(m.fetchChartHistory).toHaveBeenCalledTimes(1);
        const [, start, end, opts] = m.fetchChartHistory.mock.calls[0]!;
        expect(typeof start).toBe('string');
        expect(typeof end).toBe('string');
        expect(opts).toMatchObject({ revision: 0 });
        expect(m.chart.addSeries.mock.calls.map(c => c[0])).toEqual(['Candlestick', 'Histogram', 'Line', 'Line']);
    });

    it('長按放開後只浮出選單（價格以升降單位取整），點「買進」才開下單面板', async () => {
        await render();
        // 假圖表 coordinateToPrice(y) = 1300 - y：y=217 → 1083 → 取整到 1,085（≥1000 每檔 5 元）
        await act(async () => { wrap().props.onPointerDown(ptr(100, 217)); });
        await tick(LONG_PRESS_MS + 10);
        await act(async () => { wrap().props.onPointerUp(ptr(100, 217)); });
        expect(m.openTicket).not.toHaveBeenCalled();
        const pick = view!.root.findByProps({ 'data-testid': 'chart-pick' });
        const [buy, sell] = pick.findAllByType('button');
        expect(buy!.children.join('')).toBe('以 1,085 買進');
        expect(sell!.children.join('')).toBe('以 1,085 賣出');
        await act(async () => { buy!.props.onClick(); });
        expect(m.openTicket).toHaveBeenCalledWith({ code: '2330', action: 'Buy', price: 1085, source: 'chart' });
        expect(view!.root.findAllByProps({ 'data-testid': 'chart-pick' })).toHaveLength(0);
    });

    it('輕點或拖曳（未達長按）不浮出選單', async () => {
        await render();
        await act(async () => { wrap().props.onPointerDown(ptr(100, 200)); });
        await tick(100);
        await act(async () => { wrap().props.onPointerUp(ptr(100, 200)); });
        await act(async () => { wrap().props.onPointerDown(ptr(100, 200)); });
        await act(async () => { wrap().props.onPointerMove(ptr(160, 200)); });
        await tick(LONG_PRESS_MS + 10);
        await act(async () => { wrap().props.onPointerUp(ptr(160, 200)); });
        expect(view!.root.findAllByProps({ 'data-testid': 'chart-pick' })).toHaveLength(0);
        expect(m.openTicket).not.toHaveBeenCalled();
    });

    it('委託線畫成價格線，標籤點擊開啟委託操作面板', async () => {
        await render();
        await tick(50);
        const label = view!.root.findByProps({ 'data-testid': 'chart-order-label' });
        expect(label.props.style).toEqual({ top: '220px' }); // 1300 - 1080
        await act(async () => { label.props.onClick(); });
        expect(m.openOrderAction).toHaveBeenCalledWith('o1', 'menu');
        expect(m.openTicket).not.toHaveBeenCalled();
    });

    it('歷史載入失敗顯示重新載入', async () => {
        m.fetchChartHistory.mockReset().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(KBARS);
        await render();
        const retry = view!.root.findAll(n => n.type === 'button' && n.children.includes('重新載入'));
        expect(retry).toHaveLength(1);
        await act(async () => { retry[0]!.props.onClick(); });
        await tick(50);
        expect(m.fetchChartHistory).toHaveBeenCalledTimes(2);
        expect(m.fetchChartHistory.mock.calls[1]![3]).toMatchObject({ revision: 7 });
    });

    it('走勢模式使用 BaselineSeries（參考價基準線），不畫 MA', async () => {
        await render([], 'line');
        expect(m.chart.addSeries.mock.calls.map(c => c[0])).toEqual(['Baseline', 'Histogram']);
    });
});
