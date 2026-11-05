// 交易圖表互動（規格 §6.2）：長按→放開只浮出「以 X 買進／賣出」並以 roundToTick 取整，點選後才開下單面板（不送單）；
// 輕點不觸發；委託線標籤開啟委託操作面板；歷史載入失敗可重新載入。lightweight-charts 以假物件替代。
// 歷史新鮮度（B3）：60 秒內沿用快取、過期或回前景先顯示快取再背景重抓、失敗不重放；缺口偵測看累計量。
// 重抓不重建（B6）：補抓沿用同一個圖表、保留選價列與可見範圍。試撮揭示不入圖。
// W2：依指標設定建立／移除 series（主圖、副圖 pane＋levels）、參數變更、指標節流、圖例、走勢均價線與最高最低、
// 全螢幕（手動／橫向自動）與 data-allow-pinch。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { PriceLineSpec } from '../lib/chart-model';

const m = vi.hoisted(() => {
    const allSeries: Array<{
        setData: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
        createPriceLine: ReturnType<typeof vi.fn>;
        priceLines: Array<{ opts: Record<string, unknown>; applyOptions: ReturnType<typeof vi.fn> }>;
    }> = [];
    const state = { paneMax: 0 };
    const series = () => {
        const s = {
            setData: vi.fn(),
            update: vi.fn(),
            applyOptions: vi.fn(),
            priceLines: [] as Array<{ opts: Record<string, unknown>; applyOptions: ReturnType<typeof vi.fn> }>,
            createPriceLine: vi.fn((opts: Record<string, unknown>) => {
                const pl = { opts, applyOptions: vi.fn() };
                s.priceLines.push(pl);
                return pl;
            }),
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
    const paneObjs = [0, 1, 2, 3].map(i => ({ setHeight: vi.fn(), getHeight: vi.fn(() => (i === 0 ? 200 : 96)), getHTMLElement: () => null }));
    const chart = {
        addSeries: vi.fn((_type: unknown, _options?: unknown, pane?: number) => {
            if (pane && pane > state.paneMax) state.paneMax = pane;
            return series();
        }),
        removeSeries: vi.fn(),
        panes: vi.fn(() => paneObjs.slice(0, state.paneMax + 1)),
        removePane: vi.fn((i: number) => { state.paneMax = Math.min(state.paneMax, i - 1); }),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        timeScale: vi.fn(() => timeScale),
        subscribeCrosshairMove: vi.fn(),
        remove: vi.fn(),
    };
    return {
        chart,
        state,
        paneObjs,
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
import {
    getIndicatorSettings,
    MOBILE_INDICATORS_KEY,
    resetIndicatorSettingsForTest,
    setIndicatorSettings,
    updateIndicatorParams,
    type MobileIndicatorSettings,
} from '../lib/mobile-indicators';
import * as cs from '../styles/chart.css';
import { GAP_RELOAD_MIN_MS, INDICATOR_FLUSH_MS, LONG_PRESS_MS, TradeChart } from './trade-chart';

const contract = {
    exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 1070, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as ContractInfo;

const KBARS = { datetime: ['2026-11-05 09:01:00', '2026-11-05 09:02:00'], Open: [1070, 1075], High: [1076, 1080], Low: [1069, 1074], Close: [1075, 1078], Volume: [10, 20], Amount: [0, 0] };
const ORDER_LINE: PriceLineSpec = { key: 'order:o1', price: 1080, kind: 'order-buy', label: '買 2 @1,080', tradeId: 'o1' };

const storage = new Map<string, string>();
const fakeStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
};

/** 09:01–10:00 共 60 根 1 分 K（5 分 K 聚合成 12 根），收盤 1000＋i */
function minuteKbars(n = 60) {
    const datetime: string[] = [];
    const nums: number[] = [];
    for (let i = 0; i < n; i++) {
        const mins = 9 * 60 + 1 + i;
        datetime.push(`2026-11-05 ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`);
        nums.push(1000 + i);
    }
    return { datetime, Open: nums, High: nums.map(v => v + 1), Low: nums.map(v => v - 1), Close: nums, Volume: nums.map(() => 10), Amount: nums.map(() => 0) };
}

/** 節點底下全部文字 */
function textOf(node: ReactTestInstance | string): string {
    if (typeof node === 'string') return node;
    return node.children.map(ch => textOf(ch as ReactTestInstance | string)).join('');
}
const legendText = () => view!.root.findAllByProps({ 'data-testid': 'chart-legend' }).filter(n => typeof n.type === 'string').map(n => textOf(n)).join(' | ');
const seriesTypes = () => m.chart.addSeries.mock.calls.map(c => c[0]);
const rootNode = () => view!.root.findByProps({ 'data-testid': 'trade-chart-root' });
const byTestId = (id: string) => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === id);

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
    m.chart.removeSeries.mockClear();
    m.chart.subscribeCrosshairMove.mockClear();
    m.paneObjs.forEach(p => p.setHeight.mockClear());
    m.state.paneMax = 0;
    storage.clear();
    vi.stubGlobal('localStorage', fakeStorage);
    resetIndicatorSettingsForTest();
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

    it('走勢模式使用 BaselineSeries（參考價基準線）＋量＋均價線，不畫 MA 等指標', async () => {
        await render([], 'line');
        expect(m.chart.addSeries.mock.calls.map(c => c[0])).toEqual(['Baseline', 'Histogram', 'Line']);
    });

    it('可互動的圖表容器帶 data-allow-pinch="true"（平台手勢防護略過這一區）', async () => {
        await render();
        expect(wrap().props['data-allow-pinch']).toBe('true');
        expect(typeof wrap().props.onPointerDown).toBe('function');
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

const RSI_BOLL: MobileIndicatorSettings = {
    version: 1,
    volume: true,
    items: [
        { id: 'r1', type: 'rsi', params: { period: 14 }, color: 2 },
        { id: 'b1', type: 'boll', params: { period: 20, mult: 2 }, color: 0 },
    ],
};

describe('TradeChart 技術指標（W2）', () => {
    it('依設定建立 series：主圖疊加在 pane 0、副圖在 pane 1 並畫 levels 參考線、設定副圖高度', async () => {
        setIndicatorSettings(RSI_BOLL);
        await render();
        const calls = m.chart.addSeries.mock.calls;
        expect(calls.map(c => c[0])).toEqual(['Candlestick', 'Histogram', 'Line', 'Line', 'Line', 'Line']);
        expect(calls[2]![2]).toBe(1); // RSI → 副圖
        expect(calls.slice(3).map(c => c[2])).toEqual([0, 0, 0]); // BOLL 中軌／上軌／下軌 → 主圖
        const rsi = m.allSeries[2]!;
        expect(rsi.createPriceLine.mock.calls.map(c => (c[0] as { price: number }).price)).toEqual([30, 70]);
        expect(m.paneObjs[1]!.setHeight).toHaveBeenCalledWith(cs.PANE_HEIGHT_PX);
        // 有副圖時外框加高
        expect(wrap().props.className).toBe(cs.frame[1]);
    });

    it('改設定時在既有圖表上移除舊 series、建立新 series（不重建圖表）', async () => {
        await render();
        expect(seriesTypes()).toEqual(['Candlestick', 'Histogram', 'Line', 'Line']); // 預設 MA5、MA20
        const [ma5, ma20] = [m.allSeries[2], m.allSeries[3]];
        await act(async () => { setIndicatorSettings(RSI_BOLL); });
        await tick(20);
        expect(m.createChart).toHaveBeenCalledTimes(1);
        expect(m.chart.removeSeries).toHaveBeenCalledWith(ma5);
        expect(m.chart.removeSeries).toHaveBeenCalledWith(ma20);
        expect(seriesTypes()).toHaveLength(8);
        // 移除全部指標 → 副圖 pane 一併移除
        await act(async () => { setIndicatorSettings({ version: 1, volume: true, items: [] }); });
        expect(m.chart.removePane).toHaveBeenCalledWith(1);
        expect(wrap().props.className).toBe(cs.frame[0]);
    });

    it('參數變更：以新參數重算並 setData（MA5 → MA3），圖例顯示新名稱', async () => {
        m.fetchChartHistory.mockReset().mockResolvedValue(minuteKbars());
        await render();
        expect(legendText()).toContain('MA(5)');
        await act(async () => { setIndicatorSettings(updateIndicatorParams(getIndicatorSettings(), 'sma-default-5', { period: 3 })); });
        await tick(20);
        const newest = m.allSeries[m.allSeries.length - 2]!; // 重建後依序 MA3、MA20
        const data = newest.setData.mock.calls.at(-1)![0] as Array<{ value?: number }>;
        // 60 根 1 分 K → 12 根 5 分 K；MA3 從第 3 根開始才有值
        expect(data).toHaveLength(10);
        expect(data.every(d => typeof d.value === 'number')).toBe(true);
        expect(legendText()).toContain('MA(3)');
        expect(legendText()).not.toContain('MA(5)');
        // 設定已寫入 localStorage
        expect(storage.get(MOBILE_INDICATORS_KEY)).toContain('"period":3');
    });

    it('成交量可隱藏（只改 visible，不重建圖表）', async () => {
        const vol = () => m.allSeries[1] as unknown as { applyOptions: ReturnType<typeof vi.fn> };
        await render();
        await act(async () => { setIndicatorSettings({ ...getIndicatorSettings(), volume: false }); });
        expect(vol().applyOptions).toHaveBeenLastCalledWith({ visible: false });
        expect(m.createChart).toHaveBeenCalledTimes(1);
    });

    it('即時成交：K 棒每次合併重畫，指標以 INDICATOR_FLUSH_MS 節流且只 update 尾端點', async () => {
        m.fetchChartHistory.mockReset().mockResolvedValue(minuteKbars());
        await render();
        const main = mainSeries();
        const ma5 = m.allSeries[2]!;
        const ma5SetData = ma5.setData.mock.calls.length;
        await emit({ time: '10:02:00', close: '1070', total_volume: 601 });
        await emit({ time: '10:03:00', close: '1071', total_volume: 602 });
        await emit({ time: '10:04:00', close: '1072', total_volume: 603 });
        expect(main.update.mock.calls.length).toBe(3);
        expect(ma5.update).not.toHaveBeenCalled(); // 還在節流內
        await tick(INDICATOR_FLUSH_MS);
        expect(ma5.update).toHaveBeenCalledTimes(1); // 只更新變動的最後一根
        expect(ma5.setData.mock.calls.length).toBe(ma5SetData); // 沒有整段重設
    });

    it('長按追蹤時圖例顯示該根的值，放開後回到最新值', async () => {
        m.fetchChartHistory.mockReset().mockResolvedValue(minuteKbars());
        await render();
        const handler = m.chart.subscribeCrosshairMove.mock.calls[0]![0] as (p: unknown) => void;
        const ma5 = m.allSeries[2]!;
        await act(async () => { handler({ time: 123, point: { x: 1, y: 1 }, seriesData: new Map([[ma5, { value: 1234 }]]) }); });
        expect(legendText()).toContain('1,234');
        await act(async () => { handler({ time: undefined, point: undefined, seriesData: new Map() }); });
        expect(legendText()).not.toContain('1,234');
        expect(legendText()).toContain('MA(5)');
    });

    it('長按落在副圖不選價（座標不是價格）', async () => {
        setIndicatorSettings(RSI_BOLL);
        await render();
        await tick(20); // 版面定位：主圖高 200
        await act(async () => { wrap().props.onPointerDown(ptr(100, 250)); });
        await tick(LONG_PRESS_MS + 10);
        await act(async () => { wrap().props.onPointerUp(ptr(100, 250)); });
        expect(byTestId('chart-pick')).toHaveLength(0);
    });

    it('「指標」鍵開啟指標面板', async () => {
        await render();
        expect(byTestId('indicator-sheet')).toHaveLength(0);
        await act(async () => { byTestId('chart-indicators')[0]!.props.onClick(); });
        expect(byTestId('indicator-sheet')).toHaveLength(1);
    });
});

describe('TradeChart 走勢均價線與最高最低（W2）', () => {
    it('歷史畫均價線；即時成交帶 avg_price 時以交易所均價更新；最高最低以價格軸標示並跟著更新', async () => {
        await render([], 'line');
        const avg = m.allSeries[2]!;
        const hist = avg.setData.mock.calls.at(-1)![0] as Array<{ value?: number }>;
        expect(hist).toHaveLength(2);
        expect(hist.every(p => typeof p.value === 'number' && Number.isFinite(p.value))).toBe(true);
        const titles = () => mainSeries().priceLines.map(p => `${p.opts.title}@${p.opts.price}`);
        expect(titles()).toEqual(expect.arrayContaining(['最高@1080', '最低@1069']));
        expect(legendText()).toContain('均價');
        expect(legendText()).toContain('最高');

        await emit({ time: '09:03:00', close: '1085', avg_price: '1077.5', volume: 1, total_volume: 31 });
        expect(avg.update).toHaveBeenLastCalledWith({ time: expect.any(Number), value: 1077.5 });
        const hi = mainSeries().priceLines.find(p => p.opts.title === '最高')!;
        expect(hi.applyOptions).toHaveBeenLastCalledWith({ price: 1085 });
    });

    it('沒有 avg_price 時以累計成交金額／量估算', async () => {
        await render([], 'line');
        const avg = m.allSeries[2]!;
        await emit({ time: '09:03:00', close: '1100', volume: 30, total_volume: 60 });
        const v = (avg.update.mock.calls.at(-1)![0] as { value: number }).value;
        // 歷史估算：(1073.33×10 + 1077.33×20)／30 ≈ 1076；加上 1100×30 → 介於兩者之間
        expect(v).toBeGreaterThan(1076);
        expect(v).toBeLessThan(1100);
    });
});

describe('TradeChart 全螢幕（W2）', () => {
    it('按「全螢幕」改成覆蓋全畫面；有退出鍵、週期列與買賣鍵（只開下單面板）；退出後回復', async () => {
        const onPeriodChange = vi.fn();
        await act(async () => {
            view = create(createElement(TradeChart, { code: '2330', contract, period: '5m', lines: [], onPeriodChange }), { createNodeMock: nodeMock });
        });
        await tick(50);
        expect(rootNode().props['data-fullscreen']).toBe('false');
        expect(rootNode().props.className).toBe(cs.root);
        await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
        expect(rootNode().props['data-fullscreen']).toBe('true');
        expect(rootNode().props.className).toBe(cs.rootFullscreen);
        expect(wrap().props.className).toBe(cs.frameFullscreen);
        expect(wrap().props['data-allow-pinch']).toBe('true');
        expect(m.createChart).toHaveBeenCalledTimes(1); // 不重建圖表

        const periods = byTestId('chart-fs-bar')[0]!.findAll(n => n.type === 'button' && n.props['aria-pressed'] !== undefined);
        expect(periods.map(b => textOf(b))).toEqual(['走勢', '1分', '5分', '15分', '60分', '日']);
        await act(async () => { periods[0]!.props.onClick(); });
        expect(onPeriodChange).toHaveBeenCalledWith('line');

        await act(async () => { byTestId('chart-fs-buy')[0]!.props.onClick(); });
        expect(m.openTicket).toHaveBeenCalledWith({ code: '2330', action: 'Buy', source: 'button' });

        await act(async () => { byTestId('chart-fs-exit')[0]!.props.onClick(); });
        expect(rootNode().props['data-fullscreen']).toBe('false');
        expect(byTestId('chart-fs-exit')).toHaveLength(0);
    });

    it('指數不顯示全螢幕買賣鍵', async () => {
        await act(async () => {
            view = create(createElement(TradeChart, { code: '001', contract: { ...contract, code: '001', security_type: 'IND' } as ContractInfo, period: '5m', lines: [] }), { createNodeMock: nodeMock });
        });
        await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
        expect(byTestId('chart-fs-buy')).toHaveLength(0);
    });

    it('手機轉橫向自動全螢幕；退出後這次橫向不再自動進入，轉回直向再轉橫向才會', async () => {
        const listeners = new Map<string, () => void>();
        const win = {
            screen: { width: 390, height: 844, orientation: { type: 'landscape-primary' } },
            addEventListener: (type: string, fn: () => void) => { listeners.set(type, fn); },
            removeEventListener: vi.fn(),
        };
        vi.stubGlobal('window', win);
        await render();
        expect(rootNode().props['data-fullscreen']).toBe('true');
        await act(async () => { byTestId('chart-fs-exit')[0]!.props.onClick(); });
        expect(rootNode().props['data-fullscreen']).toBe('false');
        await act(async () => { listeners.get('resize')!(); });
        expect(rootNode().props['data-fullscreen']).toBe('false');
        win.screen.orientation.type = 'portrait-primary';
        await act(async () => { listeners.get('orientationchange')!(); });
        expect(rootNode().props['data-fullscreen']).toBe('false');
        win.screen.orientation.type = 'landscape-secondary';
        await act(async () => { listeners.get('orientationchange')!(); });
        expect(rootNode().props['data-fullscreen']).toBe('true');
    });

    it('平板（短邊 ≥ 600）橫向不自動全螢幕', async () => {
        vi.stubGlobal('window', {
            screen: { width: 1180, height: 820, orientation: { type: 'landscape-primary' } },
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });
        await render();
        expect(rootNode().props['data-fullscreen']).toBe('false');
    });
});
