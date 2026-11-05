// 交易圖表互動（規格 §6.2）：長按→放開只浮出「以 X 買進／賣出」並以 roundToTick 取整，點選後才開下單面板（不送單）；
// 輕點不觸發；委託線標籤開啟委託操作面板；歷史載入失敗可重新載入。lightweight-charts 以假物件替代。
// 歷史新鮮度（B3）：60 秒內沿用快取、過期或回前景先顯示快取再背景重抓、失敗不重放；缺口偵測看累計量。
// 重抓不重建（B6）：補抓沿用同一個圖表、保留選價列與可見範圍。試撮揭示不入圖。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { PriceLineSpec } from '../lib/chart-model';

const m = vi.hoisted(() => {
    const allSeries: Array<{ setData: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }> = [];
    const series = () => {
        const s = {
            setData: vi.fn(),
            update: vi.fn(),
            applyOptions: vi.fn(),
            createPriceLine: vi.fn(() => ({})),
            removePriceLine: vi.fn(),
            // 價格 ↔ 座標：y = 2000 - price（高度 300 → 可見 1700–2000）
            priceToCoordinate: vi.fn((p: number) => 2000 - p - 700),
            coordinateToPrice: vi.fn((y: number) => 2000 - y - 700),
        };
        allSeries.push(s);
        return s;
    };
    const timeScale = {
        subscribeVisibleLogicalRangeChange: vi.fn(),
        subscribeSizeChange: vi.fn(),
        fitContent: vi.fn(),
        setVisibleLogicalRange: vi.fn(),
        getVisibleLogicalRange: vi.fn(() => ({ from: 10, to: 50 })),
    };
    const chart = {
        addSeries: vi.fn((_type: unknown, _options?: unknown) => series()),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        timeScale: vi.fn(() => timeScale),
        subscribeCrosshairMove: vi.fn(),
        remove: vi.fn(),
    };
    return {
        chart,
        timeScale,
        allSeries,
        createChart: vi.fn(() => chart),
        fetchChartHistory: vi.fn(),
        openTicket: vi.fn(),
        openOrderAction: vi.fn(),
        rev: 100,
        tickListeners: new Set<(tk: unknown) => void>(),
        gate: { resumeSeq: 0 },
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
vi.mock('../../lib/chart-history', () => ({ fetchChartHistory: m.fetchChartHistory, nextChartHistoryRevision: () => ++m.rev }));
vi.mock('../../lib/stream', () => ({
    onAnyTick: (fn: (tk: unknown) => void) => { m.tickListeners.add(fn); return () => { m.tickListeners.delete(fn); }; },
}));
vi.mock('../hooks/use-resume-gate', () => ({ useResumeGate: () => m.gate }));
vi.mock('../../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../../lib/theme-store', () => ({
    useThemeSettings: () => ({}),
    themeKey: () => 'dark-tw',
    getChartColors: () => ({ up: '#f00', upVol: '#f008', down: '#0f0', downVol: '#0f08', text: '#888', grid: '#111', crosshair: '#36f', border: '#222', labelBg: '#000' }),
}));
vi.mock('../lib/mobile-store', () => ({ openTicket: m.openTicket, openOrderAction: m.openOrderAction }));

import { HISTORY_STALE_MS, resetHistoryEntriesForTest } from '../lib/chart-history-freshness';
import { GAP_RELOAD_MIN_MS, LONG_PRESS_MS, TradeChart } from './trade-chart';

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
const hasText = (s: string) => view!.root.findAll(n => n.type === 'span' && n.children.includes(s)).length > 0;
const revisions = () => m.fetchChartHistory.mock.calls.map(c => (c[3] as { revision: number }).revision);
const mainSeries = () => m.allSeries[0]!;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    m.fetchChartHistory.mockReset().mockResolvedValue(KBARS);
    m.createChart.mockClear();
    m.chart.addSeries.mockClear();
    m.chart.remove.mockClear();
    m.timeScale.setVisibleLogicalRange.mockClear();
    m.timeScale.fitContent.mockClear();
    m.allSeries.length = 0;
    m.rev = 100;
    m.tickListeners.clear();
    m.gate = { resumeSeq: 0 };
    m.openTicket.mockReset();
    m.openOrderAction.mockReset();
    resetHistoryEntriesForTest();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function render(lines: PriceLineSpec[] = [ORDER_LINE], period: '5m' | 'line' = '5m') {
    await act(async () => {
        view = create(createElement(TradeChart, { code: '2330', contract, period, lines }), { createNodeMock: nodeMock });
    });
    await tick(50);
}
async function unmount() {
    await act(async () => view?.unmount());
    view = undefined;
}
/** 送一筆即時成交給圖表的 onAnyTick 監聽者，並等合併重畫 */
async function emit(over: Record<string, unknown>) {
    await act(async () => {
        for (const fn of [...m.tickListeners]) fn({ code: '2330', date: '2026-11-05', time: '12:00:00', close: '1080', volume: 1, total_volume: 1000, tick_type: 1, ...over });
    });
    await tick(150);
}

describe('TradeChart', () => {
    it('以手機區間查詢歷史；週期為 5 分 K 時建立 K 線＋量＋MA5／MA20', async () => {
        await render();
        expect(m.fetchChartHistory).toHaveBeenCalledTimes(1);
        const [, start, end, opts] = m.fetchChartHistory.mock.calls[0]!;
        expect(typeof start).toBe('string');
        expect(typeof end).toBe('string');
        // 沒有紀錄：以新 revision 查詢（不撿未知的舊快取）
        expect(opts).toMatchObject({ revision: 101 });
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

    it('歷史載入失敗顯示重新載入；重新載入以新 revision 重抓且不重建圖表', async () => {
        m.fetchChartHistory.mockReset().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(KBARS);
        await render();
        const retry = view!.root.findAll(n => n.type === 'button' && n.children.includes('重新載入'));
        expect(retry).toHaveLength(1);
        await act(async () => { retry[0]!.props.onClick(); });
        await tick(50);
        expect(revisions()).toEqual([101, 102]);
        expect(m.createChart).toHaveBeenCalledTimes(1);
        expect(hasText('歷史資料載入失敗')).toBe(false);
    });

    it('走勢模式使用 BaselineSeries（參考價基準線），不畫 MA', async () => {
        await render([], 'line');
        expect(m.chart.addSeries.mock.calls.map(c => c[0])).toEqual(['Baseline', 'Histogram']);
    });
});

describe('TradeChart 歷史新鮮度（B3）', () => {
    it('60 秒內重新掛載沿用同一份快取，不重抓', async () => {
        await render();
        await unmount();
        await render();
        expect(revisions()).toEqual([101, 101]);
    });

    it('超過 60 秒後重新掛載：先顯示快取，再以新 revision 背景重抓', async () => {
        const now = Date.now();
        await render();
        await unmount();
        vi.spyOn(Date, 'now').mockReturnValue(now + HISTORY_STALE_MS + 1_000);
        await render();
        expect(revisions()).toEqual([101, 101, 102]);
        expect(hasText('載入中…')).toBe(false);
    });

    it('上次載入失敗：重新掛載以新 revision 重抓，不重放失敗', async () => {
        m.fetchChartHistory.mockReset().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(KBARS);
        await render();
        expect(hasText('歷史資料載入失敗')).toBe(true);
        await unmount();
        await render();
        expect(revisions()).toEqual([101, 102]);
        expect(hasText('歷史資料載入失敗')).toBe(false);
    });

    it('resumeSeq 改變（回前景）：背景重抓並以 setData 更新，不重建圖表', async () => {
        await render();
        const setDataBefore = mainSeries().setData.mock.calls.length;
        m.gate = { resumeSeq: 1 };
        await act(async () => { view!.update(createElement(TradeChart, { code: '2330', contract, period: '5m', lines: [ORDER_LINE] })); });
        await tick(50);
        expect(revisions()).toEqual([101, 102]);
        expect(m.createChart).toHaveBeenCalledTimes(1);
        expect(mainSeries().setData.mock.calls.length).toBe(setDataBefore + 1);
    });

    it('resumeSeq 改變後重新掛載（60 秒內）也會背景重抓', async () => {
        await render();
        await unmount();
        m.gate = { resumeSeq: 3 };
        await render();
        expect(revisions()).toEqual([101, 101, 102]);
    });

    it('走勢：成交與最後一根相隔超過 180 秒且累計量顯示漏量才補抓', async () => {
        await render([], 'line');
        // 歷史 09:01、09:02 累計 30；12:00 這筆累計 31 → 沒有漏量（冷門商品）
        await emit({ time: '12:00:00', volume: 1, total_volume: 31 });
        expect(revisions()).toEqual([101]);
        // 12:10 累計 500 → 漏量 → 補抓
        await emit({ time: '12:10:00', volume: 1, total_volume: 500 });
        await tick(50);
        expect(revisions()).toEqual([101, 102]);
        expect(m.createChart).toHaveBeenCalledTimes(1);
    });
});

describe('TradeChart 重抓不重建（B6）與試撮', () => {
    it('K 線缺口補抓沿用同一個圖表：保留選價列與可見範圍', async () => {
        await render();
        await act(async () => { wrap().props.onPointerDown(ptr(100, 217)); });
        await tick(LONG_PRESS_MS + 10);
        await act(async () => { wrap().props.onPointerUp(ptr(100, 217)); });
        expect(view!.root.findAllByProps({ 'data-testid': 'chart-pick' })).toHaveLength(1);
        m.timeScale.setVisibleLogicalRange.mockClear();

        await emit({ time: '12:00:00' }); // 與歷史尾端相隔遠超過 3 根 → 補抓
        await tick(50);
        expect(revisions()).toEqual([101, 102]);
        expect(m.createChart).toHaveBeenCalledTimes(1);
        expect(m.chart.remove).not.toHaveBeenCalled();
        expect(view!.root.findAllByProps({ 'data-testid': 'chart-pick' })).toHaveLength(1);
        // 重抓前後根數相同（歷史＋保留的即時一根）→ 可見範圍原樣保留
        expect(m.timeScale.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 10, to: 50 });
    });

    it('K 線：累計量沒有漏量的冷門商品不反覆補抓', async () => {
        const now = Date.now();
        await render();
        await emit({ time: '12:00:00', volume: 1, total_volume: 1000 }); // 還不知道累計量 → 補抓一次
        await tick(50);
        expect(revisions()).toEqual([101, 102]);
        vi.spyOn(Date, 'now').mockReturnValue(now + GAP_RELOAD_MIN_MS + 1_000);
        await emit({ time: '12:40:00', volume: 1, total_volume: 1001 });
        await tick(50);
        expect(revisions()).toEqual([101, 102]);
    });

    it('試撮揭示不入圖，真實成交才更新', async () => {
        await render();
        const updates = () => mainSeries().update.mock.calls.length;
        await emit({ time: '09:03:00', close: '1175', simtrade: true });
        expect(updates()).toBe(0);
        await emit({ time: '09:03:00', close: '1079' });
        expect(updates()).toBe(1);
    });
});
