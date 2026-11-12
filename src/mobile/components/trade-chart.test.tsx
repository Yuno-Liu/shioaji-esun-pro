// 交易圖表互動（規格 §6.2）：長按→放開只浮出「以 X 買進／賣出」並以 roundToTick 取整，點選後才開下單面板（不送單）；
// 輕點不觸發；委託線標籤開啟委託操作面板；歷史載入失敗可重新載入。lightweight-charts 以假物件替代。
// 歷史新鮮度（B3）：60 秒內沿用快取、過期或回前景先顯示快取再背景重抓、失敗不重放；缺口偵測看累計量。
// 重抓不重建（B6）：補抓沿用同一個圖表、保留選價列與可見範圍。試撮揭示不入圖。
// W2：依指標設定建立／移除 series（主圖、副圖 pane＋levels）、參數變更、指標節流、圖例、走勢均價線與最高最低、
// 全螢幕（手動／橫向自動）與 data-allow-pinch。
// 長按選價下單是本裝置設定（預設關）：以下既有長按選價的測試在 beforeEach 先開啟；關閉時的行為見檔尾「圖表長按選價下單設定」。
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
        // x ↔ logical：每根 20px；主圖寬 300（右側之外是價格軸）
        coordinateToLogical: vi.fn((x: number) => x / 20),
        logicalToCoordinate: vi.fn((l: number) => l * 20),
        width: vi.fn(() => 300),
    };
    const paneObjs = [0, 1, 2, 3].map(i => ({ setHeight: vi.fn(), getHeight: vi.fn((): number => (i === 0 ? 200 : 96)), setStretchFactor: vi.fn(), getHTMLElement: () => null }));
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
        setCrosshairPosition: vi.fn(),
        clearCrosshairPosition: vi.fn(),
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
        /** 走勢買賣力的當日逐筆（fetchHistoryTicks） */
        fetchTicks: vi.fn(),
        openTicket: vi.fn(),
        openOrderAction: vi.fn(),
        rev: 100,
        tickListeners: new Set<(tk: unknown) => void>(),
        gate: { resumeSeq: 0 } as { resumeSeq: number; state?: string },
        /** useStreamStatus()（全螢幕狀態膠囊） */
        stream: 'live' as string,
        haptic: vi.fn(),
        // S1：lib 的送單／改單／刪單函式（圖表任何入口都不得呼叫）
        send: { placeStockOrder: vi.fn(), placeFuturesOrder: vi.fn(), cancelOrder: vi.fn(), updateOrderPrice: vi.fn(), updateOrderQty: vi.fn() },
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
vi.mock('../../lib/chart-history', () => ({ nextChartHistoryRevision: () => ++m.rev }));
// 手機不經過 src/lib 的 revision 快取（F4:F9）；快取行為另見 chart-history-cache.test.ts
vi.mock('../lib/chart-history-cache', () => ({ fetchMobileChartHistory: m.fetchChartHistory }));
vi.mock('../../lib/stream', () => ({
    onAnyTick: (fn: (tk: unknown) => void) => { m.tickListeners.add(fn); return () => { m.tickListeners.delete(fn); }; },
}));
vi.mock('../hooks/use-resume-gate', () => ({ useResumeGate: () => m.gate }));
vi.mock('../../hooks/use-stream', () => ({ useQuote: () => undefined, useStreamStatus: () => m.stream }));
vi.mock('../../lib/theme-store', () => ({
    useThemeSettings: () => ({}),
    themeKey: () => 'dark-tw',
    getChartColors: () => ({ up: '#f00', upVol: '#f008', down: '#0f0', downVol: '#0f08', text: '#888', grid: '#111', crosshair: '#36f', border: '#222', labelBg: '#000' }),
}));
vi.mock('../lib/mobile-store', () => ({ openTicket: m.openTicket, openOrderAction: m.openOrderAction }));
vi.mock('../motion/haptics', () => ({ haptic: m.haptic }));
vi.mock('../../lib/shioaji', async importOriginal => ({ ...(await importOriginal<typeof import('../../lib/shioaji')>()), ...m.send, fetchHistoryTicks: m.fetchTicks }));

import { HISTORY_STALE_MS, resetHistoryEntriesForTest } from '../lib/chart-history-freshness';
import {
    getIndicatorSettings,
    MOBILE_INDICATORS_KEY,
    resetIndicatorSettingsForTest,
    setIndicatorSettings,
    updateIndicatorParams,
    type MobileIndicatorSettings,
} from '../lib/mobile-indicators';
import { getLimitRange, resetLimitRangeForTest } from '../lib/chart-limit-range';
import { resetLineFlowForTest } from '../lib/line-flow';
import { resetLineIndicatorSettingsForTest, setLineIndicatorSettings } from '../lib/line-indicators';
import { getMobileDeviceSettings, MOBILE_DEVICE_SETTINGS_KEY, resetMobileDeviceSettingsForTest, setMobileDeviceSettings } from '../lib/mobile-device-settings';
import * as cs from '../styles/chart.css';
import * as tradeStyles from '../styles/trade.css';
import * as segmentedStyles from '../ui/segmented.css';
import { chartToolNote, GAP_RELOAD_MIN_MS, INDICATOR_FLUSH_MS, LONG_PRESS_MS, TAP_SAME_SPOT_PX, TradeChart } from './trade-chart';

const contract = {
    exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 1070, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as ContractInfo;

const KBARS = { datetime: ['2026-11-05 09:01:00', '2026-11-05 09:02:00'], Open: [1070, 1075], High: [1076, 1080], Low: [1069, 1074], Close: [1075, 1078], Volume: [10, 20], Amount: [0, 0] };
/** 走勢買賣力的假逐筆：09:01 外 6（645 萬，大單）內 4（430 萬，小單）；09:02 外 20（大單）；09:03 內 30（大單） */
const FLOW_TICKS = {
    datetime: ['2026-11-05 09:00:30.100000', '2026-11-05 09:00:40.000000', '2026-11-05 09:01:30.000000', '2026-11-05 09:02:10.000000', '2026-11-05 09:02:20.000000'],
    close: [1075, 1075, 1080, 1065, 1065],
    volume: [6, 4, 20, 30, 9],
    tick_type: [1, 2, 1, 2, 0],
    bid_price: [], bid_volume: [], ask_price: [], ask_volume: [],
};
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
    m.paneObjs.forEach(p => { p.setHeight.mockClear(); p.setStretchFactor.mockClear(); });
    m.state.paneMax = 0;
    storage.clear();
    vi.stubGlobal('localStorage', fakeStorage);
    resetIndicatorSettingsForTest();
    resetLineIndicatorSettingsForTest();
    resetLineFlowForTest();
    resetLimitRangeForTest();
    // 既有長按選價的測試：先開啟「圖表長按選價下單」（預設關；關閉時的行為見檔尾）
    resetMobileDeviceSettingsForTest();
    setMobileDeviceSettings({ chartPricePick: true });
    m.fetchTicks.mockReset().mockResolvedValue(FLOW_TICKS);
    m.timeScale.setVisibleLogicalRange.mockClear();
    m.timeScale.fitContent.mockClear();
    m.allSeries.length = 0;
    m.rev = 100;
    m.tickListeners.clear();
    m.gate = { resumeSeq: 0 };
    m.stream = 'live';
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

    it('卸載時不在 chart.remove() 之後呼叫 removePriceLine（否則會排一次重繪，畫到已銷毀的畫布而丟出 Object is disposed）', async () => {
        await render();
        const main = m.allSeries[0] as unknown as { removePriceLine: ReturnType<typeof vi.fn> };
        const order: string[] = [];
        m.chart.remove.mockImplementation(() => { order.push('remove'); });
        main.removePriceLine.mockImplementation(() => { order.push('removePriceLine'); });
        await unmount();
        expect(order).toEqual(['remove']);
    });

    it('委託線改變（圖表仍在）時照常移除舊的價格線', async () => {
        await render();
        const main = m.allSeries[0] as unknown as { removePriceLine: ReturnType<typeof vi.fn> };
        main.removePriceLine.mockClear();
        await act(async () => {
            view!.update(createElement(TradeChart, { code: '2330', contract, period: '5m', lines: [{ ...ORDER_LINE, key: 'order:o2', price: 1075, tradeId: 'o2' }] }));
        });
        await tick(50);
        expect(main.removePriceLine).toHaveBeenCalledTimes(1);
        expect(m.chart.remove).not.toHaveBeenCalled();
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

    it('走勢模式使用 BaselineSeries（參考價基準線）＋均價線＋成交量副圖，不畫 MA 等指標', async () => {
        await render([], 'line');
        // 成交量在有量的歷史載入後才建立（pane 1），所以排在均價線之後
        // 均價線之後是 X 軸用的空白點 series（整個時段），成交量有量才建立（pane 1）
        expect(m.chart.addSeries.mock.calls.map(c => c[0])).toEqual(['Baseline', 'Line', 'Line', 'Histogram']);
        expect(m.chart.addSeries.mock.calls[3]![2]).toBe(1);
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

    it('根數不足以計算指標時，圖例說明「資料不足（需 N 根，目前 M 根）」（期權日 K 約 17 根時的 MA(20)）', async () => {
        m.fetchChartHistory.mockReset().mockResolvedValue(minuteKbars());
        await render();
        // 60 根 1 分 K → 12 根 5 分 K：MA(5) 有值、MA(20) 永遠沒值
        const notes = byTestId('chart-legend-note').map(n => textOf(n));
        expect(notes).toEqual([' 資料不足（需 20 根，目前 12 根）']);
        expect(legendText()).toMatch(/MA\(20\).*資料不足（需 20 根，目前 12 根）/);
        // 換成需要較少根數的參數 → 說明消失
        await act(async () => { setIndicatorSettings(updateIndicatorParams(getIndicatorSettings(), 'sma-default-20', { period: 10 })); });
        await tick(20);
        expect(byTestId('chart-legend-note')).toHaveLength(0);
    });

    it('指標即時增量更新會送出空白點：SuperTrend 盤中翻轉時清掉該根的舊線段', async () => {
        setIndicatorSettings({ version: 1, volume: true, items: [{ id: 'st', type: 'supertrend', params: { period: 3, mult: 1 }, color: 0 }] });
        m.fetchChartHistory.mockReset().mockResolvedValue(minuteKbars());
        await render();
        const [up, down] = [m.allSeries[2]!, m.allSeries[3]!];
        const lastUp = () => up.update.mock.calls.at(-1)?.[0] as { time: number; value?: number } | undefined;
        // 新的一根先維持多頭：up 有值
        await emit({ time: '10:05:00', close: '1062', total_volume: 601 });
        await tick(INDICATOR_FLUSH_MS);
        expect(typeof lastUp()?.value).toBe('number');
        const flipTime = lastUp()!.time;
        // 同一根盤中急跌翻空：up 這一根必須以空白點更新（刪掉舊值），down 畫出新值
        await emit({ time: '10:06:00', close: '900', total_volume: 602 });
        await tick(INDICATOR_FLUSH_MS);
        expect(lastUp()).toEqual({ time: flipTime });
        expect(down.update).toHaveBeenLastCalledWith({ time: flipTime, value: expect.any(Number) });
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
        const avg = m.allSeries[1]!; // Baseline、均價線，之後才是有量時建立的成交量
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
        const avg = m.allSeries[1]!; // Baseline、均價線，之後才是有量時建立的成交量
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

    it('全螢幕頂列狀態膠囊（role=status）：LIVE＋已同步不顯示；連線中／中斷／同步中／資料過期／未恢復時顯示，ResumeGate 優先', async () => {
        const el = () => createElement(TradeChart, { code: '2330', contract, period: '5m', lines: [] });
        await act(async () => { view = create(el(), { createNodeMock: nodeMock }); });
        await tick(50);
        m.stream = 'connecting';
        await act(async () => { view!.update(el()); });
        expect(byTestId('chart-fs-status')).toHaveLength(0); // 非全螢幕：狀態列看得到，不重複顯示
        await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
        const pill = () => byTestId('chart-fs-bar')[0]!.findAll(n => n.props['data-testid'] === 'chart-fs-status' && typeof n.type === 'string');
        const cases: [string, string | undefined, string | null][] = [
            ['connecting', 'ready', '連線中'],
            ['down', 'ready', '中斷'],
            ['stale', undefined, '中斷'],
            ['connecting', 'resyncing', '同步中'],
            ['live', 'stale-data', '資料過期'],
            ['live', 'failed', '未恢復'],
            ['live', 'ready', null],
        ];
        for (const [stream, state, want] of cases) {
            m.stream = stream;
            m.gate = { resumeSeq: 0, state };
            await act(async () => { view!.update(el()); });
            const p = pill();
            if (want === null) {
                expect(p).toHaveLength(0);
            } else {
                expect(p).toHaveLength(1);
                expect(p[0]!.props.role).toBe('status');
                expect(textOf(p[0]!)).toBe(want);
            }
        }
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

// ---- B3b 交易頁現代化：工具列、選價列、全螢幕列、圖表字型、長按觸覺（設計規格 §7.3、§10 S1） ----

describe('TradeChart B3b', () => {
    beforeEach(() => {
        m.haptic.mockReset();
        Object.values(m.send).forEach(f => f.mockReset());
    });

    const longPressPick = async (y = 217) => {
        await act(async () => { wrap().props.onPointerDown(ptr(100, y)); });
        await tick(LONG_PRESS_MS + 10);
        await act(async () => { wrap().props.onPointerUp(ptr(100, y)); });
    };

    it('圖表字型改為系統字族（不再用等寬字族）', async () => {
        await render();
        const opts = (m.createChart.mock.calls[0] as unknown[])[1] as { layout: { fontFamily: string } };
        expect(opts.layout.fontFamily).toBe(cs.CHART_FONT_FAMILY);
        expect(opts.layout.fontFamily).toContain('system-ui');
        expect(opts.layout.fontFamily).not.toMatch(/mono/i);
    });

    it('長按成立時 haptic(longPress)；輕點不觸發', async () => {
        await render();
        await act(async () => { wrap().props.onPointerDown(ptr(100, 200)); });
        await tick(100);
        await act(async () => { wrap().props.onPointerUp(ptr(100, 200)); });
        expect(m.haptic).not.toHaveBeenCalled();
        await longPressPick();
        expect(m.haptic.mock.calls).toEqual([['longPress']]);
    });

    it('選價列：選了之後沿原路收回（殘影 aria-hidden＋inert、沒有按鈕），收回時間到即移除', async () => {
        await render();
        await longPressPick();
        await act(async () => { byTestId('chart-pick')[0]!.findAllByType('button')[1]!.props.onClick(); });
        expect(m.openTicket).toHaveBeenCalledWith({ code: '2330', action: 'Sell', price: 1085, source: 'chart' });
        expect(byTestId('chart-pick')).toHaveLength(0);
        const closing = byTestId('chart-pick-closing');
        expect(closing).toHaveLength(1);
        expect(closing[0]!.props['aria-hidden']).toBe('true');
        expect(closing[0]!.props.inert).toBe(true);
        expect(closing[0]!.findAllByType('button')).toHaveLength(0);
        expect(textOf(closing[0]!)).toContain('以 1,085 賣出');
        await tick(300);
        expect(byTestId('chart-pick-closing')).toHaveLength(0);
    });

    it('選價列：取消也沿原路收回，不開下單面板', async () => {
        await render();
        await longPressPick();
        const cancel = byTestId('chart-pick')[0]!.findAll(n => n.type === 'button' && n.props['aria-label'] === '取消')[0]!;
        await act(async () => { cancel.props.onClick(); });
        expect(byTestId('chart-pick')).toHaveLength(0);
        expect(byTestId('chart-pick-closing')).toHaveLength(1);
        expect(m.openTicket).not.toHaveBeenCalled();
    });

    it('工具列「指標」「全螢幕」為 Chip（動作型，不帶 aria-pressed；testid 不變）', async () => {
        await render();
        for (const id of ['chart-indicators', 'chart-fs-enter']) {
            const b = byTestId(id)[0]!;
            expect(b.type).toBe('button');
            expect(b.props['aria-pressed']).toBeUndefined();
        }
        expect(textOf(byTestId('chart-indicators')[0]!)).toBe('指標');
        expect(textOf(byTestId('chart-fs-enter')[0]!)).toBe('全螢幕');
    });

    it('全螢幕週期改為 Segmented toggle（role=group「圖表週期」）', async () => {
        const onPeriodChange = vi.fn();
        await act(async () => {
            view = create(createElement(TradeChart, { code: '2330', contract, period: '5m', lines: [], onPeriodChange }), { createNodeMock: nodeMock });
        });
        await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
        const group = byTestId('chart-fs-bar')[0]!.findAll(n => n.type === 'div' && n.props.role === 'group');
        expect(group).toHaveLength(1);
        expect(group[0]!.props['aria-label']).toBe('圖表週期');
        const pressed = group[0]!.findAll(n => n.type === 'button' && n.props['aria-pressed'] === true);
        expect(pressed.map(b => textOf(b))).toEqual(['5分']);
        // 全螢幕上列窄（直向手動全螢幕）：用可橫向捲動的膠囊（scroller），不用等寬 thumb 軌道（會擠成文字重疊）
        expect(String(group[0]!.props.className)).toContain(segmentedStyles.scroller);
    });

    it('S1：選價列買賣、取消、全螢幕買賣、工具鍵、委託線標籤只呼叫 openTicket／openOrderAction，lib 送出函式 0 次', async () => {
        await render();
        await longPressPick();
        await act(async () => { byTestId('chart-pick')[0]!.findAllByType('button')[0]!.props.onClick(); });
        await tick(300);
        await longPressPick();
        await act(async () => { byTestId('chart-pick')[0]!.findAllByType('button')[1]!.props.onClick(); });
        await tick(300);
        await longPressPick();
        await act(async () => { byTestId('chart-pick')[0]!.findAllByType('button')[2]!.props.onClick(); });
        await act(async () => { byTestId('chart-order-label')[0]!.props.onClick(); });
        await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
        await act(async () => { byTestId('chart-fs-buy')[0]!.props.onClick(); });
        await act(async () => { byTestId('chart-fs-sell')[0]!.props.onClick(); });
        await act(async () => { byTestId('chart-indicators')[0]!.props.onClick(); });
        expect(m.openTicket.mock.calls).toEqual([
            [{ code: '2330', action: 'Buy', price: 1085, source: 'chart' }],
            [{ code: '2330', action: 'Sell', price: 1085, source: 'chart' }],
            [{ code: '2330', action: 'Buy', source: 'button' }],
            [{ code: '2330', action: 'Sell', source: 'button' }],
        ]);
        expect(m.openOrderAction.mock.calls).toEqual([['o1', 'menu']]);
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });
});

// ---- 選價列捲到可見範圍：一般模式下圖表框下緣常在底部 chrome（交易鍵列＋分頁列）之下 ----

describe('TradeChart 選價列捲到可見範圍', () => {
    let scrollIntoView: ReturnType<typeof vi.fn>;
    /** 選價列外層（pickAnchor，沒有 transform）帶 scrollIntoView；其他節點同 nodeMock */
    const scrollMock = (el: { props: unknown }) =>
        ((el.props as { className?: unknown }).className === tradeStyles.pickAnchor ? { scrollIntoView } : nodeMock());

    beforeEach(() => {
        scrollIntoView = vi.fn();
    });

    async function renderWithScroll() {
        await act(async () => {
            view = create(createElement(TradeChart, { code: '2330', contract, period: '5m', lines: [], onPeriodChange: vi.fn() }), { createNodeMock: scrollMock });
        });
        await tick(50);
    }
    const longPressPick = async (y = 217) => {
        await act(async () => { wrap().props.onPointerDown(ptr(100, y)); });
        await tick(LONG_PRESS_MS + 10);
        await act(async () => { wrap().props.onPointerUp(ptr(100, y)); });
    };

    it('一般模式開啟選價列：對沒有 transform 的外層 scrollIntoView 一次（nearest、smooth）；收回殘影不再捲動', async () => {
        await renderWithScroll();
        expect(scrollIntoView).not.toHaveBeenCalled();
        await longPressPick();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        // 捲動目標是選價列的外層：動畫（translateY）在內層 chart-pick 上
        const pick = byTestId('chart-pick')[0]!;
        expect(pick.parent!.props.className).toBe(tradeStyles.pickAnchor);
        expect(pick.props.className).toBe(tradeStyles.pickBar);

        // 取消 → 收回殘影（chart-pick-closing）：不觸發捲動
        const cancel = pick.findAll(n => n.type === 'button' && n.props['aria-label'] === '取消')[0]!;
        await act(async () => { cancel.props.onClick(); });
        expect(byTestId('chart-pick-closing')).toHaveLength(1);
        await tick(300);
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(m.openTicket).not.toHaveBeenCalled();

        // 再次開啟：再捲一次
        await longPressPick();
        expect(scrollIntoView).toHaveBeenCalledTimes(2);
    });

    it('全螢幕開啟選價列：不捲動', async () => {
        await renderWithScroll();
        await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
        expect(rootNode().props['data-fullscreen']).toBe('true');
        await longPressPick();
        expect(byTestId('chart-pick')).toHaveLength(1);
        expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('減少動態：behavior auto', async () => {
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduced-motion'), addEventListener: () => undefined, removeEventListener: () => undefined }));
        await renderWithScroll();
        await longPressPick();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    });

    it('沒有 scrollIntoView（jsdom 等）時不丟錯，選價列照常出現', async () => {
        await render([]);
        await longPressPick();
        expect(byTestId('chart-pick')).toHaveLength(1);
    });
});

// ---- 點選圖表顯示價格資訊（使用者需求：「交易走勢圖點選圖表要顯示當前價格、漲跌%數、漲跌價差」） ----

/** 走勢：09:01 1,075、09:02 1,080、09:03 1,065（參考價 1,070） */
const LINE_KBARS = {
    datetime: ['2026-11-05 09:01:00', '2026-11-05 09:02:00', '2026-11-05 09:03:00'],
    Open: [1070, 1075, 1080], High: [1075, 1080, 1080], Low: [1070, 1075, 1065], Close: [1075, 1080, 1065], Volume: [10, 20, 30], Amount: [0, 0, 0],
};
/** 日 K：11/03 1,050、11/04 1,080、11/05 1,080 */
const DAY_KBARS = {
    datetime: ['2026-11-03 13:30:00', '2026-11-04 13:30:00', '2026-11-05 13:30:00'],
    Open: [1040, 1050, 1080], High: [1055, 1085, 1085], Low: [1035, 1045, 1075], Close: [1050, 1080, 1080], Volume: [10, 20, 30], Amount: [0, 0, 0],
};

describe('TradeChart 點選價格資訊', () => {
    beforeEach(() => {
        m.fetchChartHistory.mockReset().mockResolvedValue(LINE_KBARS);
        m.chart.setCrosshairPosition.mockClear();
        m.chart.clearCrosshairPosition.mockClear();
        m.timeScale.coordinateToLogical.mockClear();
        Object.values(m.send).forEach(f => f.mockReset());
    });

    const readoutNodes = () => byTestId('chart-readout');
    const readoutText = () => readoutNodes().map(n => textOf(n)).join('');
    const crosshairHandler = () => m.chart.subscribeCrosshairMove.mock.calls.at(-1)![0] as (p: unknown) => void;
    const tap = async (x: number, y: number, extra: Record<string, unknown> = {}) => {
        await act(async () => { wrap().props.onPointerDown({ ...ptr(x, y), ...extra }); });
        await tick(100);
        await act(async () => { wrap().props.onPointerUp({ ...ptr(x, y), ...extra }); });
    };
    async function renderPeriod(period: '1D' | 'line' | '5m', lines: PriceLineSpec[] = []) {
        await act(async () => {
            view = create(createElement(TradeChart, { code: '2330', contract, period, lines, onPeriodChange: vi.fn() }), { createNodeMock: nodeMock });
        });
        await tick(50);
    }

    it('走勢：輕點吸附到最近一根，顯示十字線與時間、價格、漲跌、漲跌%（基準＝參考價 1,070）；不開選價列與下單面板', async () => {
        await renderPeriod('line');
        expect(readoutNodes()).toHaveLength(0);
        await tap(12, 100); // logical 0.6 → 第 2 根（09:02）
        expect(m.chart.setCrosshairPosition).toHaveBeenCalledTimes(1);
        const [price, time, series] = m.chart.setCrosshairPosition.mock.calls[0]!;
        expect(price).toBe(1080);
        expect(typeof time).toBe('number');
        expect(series).toBe(mainSeries());
        expect(readoutNodes()[0]!.props['data-source']).toBe('tap');
        expect(readoutText()).toContain('09:02');
        expect(textOf(byTestId('chart-readout-price')[0]!)).toBe('1,080');
        expect(textOf(byTestId('chart-readout-change')[0]!)).toBe('▲10 (+0.93%)');
        // 文字標示方向（▲＋正負號），顏色只輔助；無障礙名稱寫出「上漲」
        expect(byTestId('chart-readout-change')[0]!.props.className).toContain(tradeStyles.dirText.up);
        const group = readoutNodes()[0]!.findAll(n => n.props.role === 'group')[0]!;
        expect(group.props['aria-label']).toBe('09:02，價格 1,080，漲跌 上漲 10，漲跌幅 +0.93%，成交量 20');
        expect(textOf(byTestId('chart-readout-volume')[0]!)).toBe('量 20');
        // 順序：價格 → 漲跌 → 量 → ✕（量不夾在價格與漲跌之間）；［漲跌］與［量 ✕］各自成組換行，✕ 跟著量
        const order = group.findAll(n => typeof n.type === 'string' && /^chart-readout-(price|change|volume|close)$/.test(String(n.props['data-testid'] ?? '')))
            .map(n => String(n.props['data-testid']).slice('chart-readout-'.length));
        expect(order).toEqual(['price', 'change', 'volume', 'close']);
        const volumeGroup = byTestId('chart-readout-volume')[0]!.parent!;
        expect(volumeGroup.findAll(n => n.props['data-testid'] === 'chart-readout-close' && typeof n.type === 'string')).toHaveLength(1);
        // 資訊列在圖例第一列（同一個容器，往下排，不另疊一層）
        expect(byTestId('chart-legend')[0]!.findAll(n => n.props['data-testid'] === 'chart-readout')).toHaveLength(1);
        expect(byTestId('chart-pick')).toHaveLength(0);
        expect(m.openTicket).not.toHaveBeenCalled();
    });

    it('走勢：低於參考價顯示 ▼ 與負號；點在最後一根右側吸附到最後一根', async () => {
        await renderPeriod('line');
        await tap(250, 100);
        expect(readoutText()).toContain('09:03');
        expect(textOf(byTestId('chart-readout-price')[0]!)).toBe('1,065');
        expect(textOf(byTestId('chart-readout-change')[0]!)).toBe('▼5 (-0.47%)');
        expect(byTestId('chart-readout-change')[0]!.props.className).toContain(tradeStyles.dirText.down);
    });

    it('再點同一根收起並清掉十字線；按 ✕ 也收起', async () => {
        await renderPeriod('line');
        await tap(10, 100);
        expect(readoutNodes()).toHaveLength(1);
        await tap(14, 120); // 仍吸附到同一根
        expect(readoutNodes()).toHaveLength(0);
        expect(m.chart.clearCrosshairPosition).toHaveBeenCalledTimes(1);

        await tap(10, 100);
        await tap(0, 100); // 換到另一根：移動，不收起
        expect(readoutText()).toContain('09:01');
        expect(textOf(byTestId('chart-readout-change')[0]!)).toBe('▲5 (+0.47%)');
        const close = byTestId('chart-readout-close')[0]!;
        expect(close.props['aria-label']).toBe('關閉價格資訊');
        await act(async () => { close.props.onClick(); });
        expect(readoutNodes()).toHaveLength(0);
        expect(m.chart.clearCrosshairPosition).toHaveBeenCalledTimes(2);

        // 走勢一分鐘很窄：再點偏了幾 px 吸附到隔壁一根，但離釘住那一根的 x（20）在 TAP_SAME_SPOT_PX 內 → 仍算同一點
        await tap(20, 100);
        expect(readoutText()).toContain('09:02');
        await tap(20 + TAP_SAME_SPOT_PX, 100); // logical 1.6 → 第 3 根
        expect(readoutNodes()).toHaveLength(0);
        expect(m.chart.clearCrosshairPosition).toHaveBeenCalledTimes(3);
    });

    it('平移（拖超過容許位移）或雙指開始時收起；雙指放開不算輕點', async () => {
        await renderPeriod('line');
        await tap(10, 100);
        await act(async () => { wrap().props.onPointerDown(ptr(10, 100)); });
        await act(async () => { wrap().props.onPointerMove(ptr(40, 100)); });
        expect(readoutNodes()).toHaveLength(0);
        await act(async () => { wrap().props.onPointerUp(ptr(40, 100)); });
        expect(readoutNodes()).toHaveLength(0);

        await tap(10, 100);
        expect(readoutNodes()).toHaveLength(1);
        await act(async () => { wrap().props.onPointerDown({ ...ptr(10, 100), pointerId: 1, isPrimary: true }); });
        await act(async () => { wrap().props.onPointerDown({ ...ptr(60, 100), pointerId: 2, isPrimary: false }); });
        expect(readoutNodes()).toHaveLength(0);
        await act(async () => { wrap().props.onPointerUp({ ...ptr(60, 100), pointerId: 2 }); });
        await act(async () => { wrap().props.onPointerUp({ ...ptr(10, 100), pointerId: 1 }); });
        expect(readoutNodes()).toHaveLength(0);
        expect(m.chart.setCrosshairPosition).toHaveBeenCalledTimes(2);
    });

    it('點在價格軸、時間軸或按鈕上不算輕點', async () => {
        await renderPeriod('line');
        await tap(310, 100); // 主圖寬 300
        await tap(10, 290); // 時間軸（高 300 − 24）
        await tap(10, 100, { target: { closest: (sel: string) => (sel === 'button' ? {} : null) } });
        expect(readoutNodes()).toHaveLength(0);
        expect(m.chart.setCrosshairPosition).not.toHaveBeenCalled();
    });

    it('程式庫清掉或以像素重算十字線（觸控放開、資料更新）時放回釘住的那一根', async () => {
        await renderPeriod('line');
        await tap(10, 100);
        const first = m.chart.setCrosshairPosition.mock.calls[0]!;
        await act(async () => { crosshairHandler()({ time: undefined, point: undefined, seriesData: new Map() }); });
        await act(async () => { crosshairHandler()({ time: 1, point: { x: 30, y: 10 }, seriesData: new Map() }); });
        expect(m.chart.setCrosshairPosition.mock.calls).toEqual([first, first, first]);
        expect(readoutNodes()[0]!.props['data-source']).toBe('tap');
        expect(textOf(byTestId('chart-readout-price')[0]!)).toBe('1,080');
    });

    it('換週期、進入全螢幕時收起', async () => {
        await renderPeriod('line');
        await tap(10, 100);
        await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
        expect(readoutNodes()).toHaveLength(0);
        expect(m.chart.clearCrosshairPosition).toHaveBeenCalledTimes(1);
        await tap(10, 100);
        expect(readoutNodes()).toHaveLength(1);
        await act(async () => {
            view!.update(createElement(TradeChart, { code: '2330', contract, period: '5m', lines: [], onPeriodChange: vi.fn() }));
        });
        await tick(50);
        expect(readoutNodes()).toHaveLength(0);
    });

    it('長按仍進入追蹤並在放開後浮出選價列；追蹤時資訊列跟著十字線顯示價格與漲跌', async () => {
        await renderPeriod('line');
        await tap(10, 100);
        const barTime = m.chart.setCrosshairPosition.mock.calls[0]![1] as number;
        await act(async () => { wrap().props.onPointerDown(ptr(100, 217)); });
        await tick(LONG_PRESS_MS + 10);
        // 進入追蹤：輕點的資訊收起，十字線交給程式庫（不清除）
        expect(readoutNodes()).toHaveLength(0);
        expect(m.chart.clearCrosshairPosition).not.toHaveBeenCalled();
        await act(async () => { crosshairHandler()({ time: barTime, point: { x: 10, y: 217 }, seriesData: new Map([[mainSeries(), { value: 1080 }]]) }); });
        expect(readoutNodes()[0]!.props['data-source']).toBe('track');
        expect(textOf(byTestId('chart-readout-change')[0]!)).toBe('▲10 (+0.93%)');
        expect(byTestId('chart-readout-close')).toHaveLength(0);
        await act(async () => { wrap().props.onPointerUp(ptr(100, 217)); });
        // 程式庫在放開時清掉十字線
        await act(async () => { crosshairHandler()({ time: undefined, point: undefined, seriesData: new Map() }); });
        expect(readoutNodes()).toHaveLength(0);
        const pick = byTestId('chart-pick');
        expect(pick).toHaveLength(1);
        expect(textOf(pick[0]!.findAllByType('button')[0]!)).toBe('以 1,085 買進');
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.chart.setCrosshairPosition).toHaveBeenCalledTimes(1);
    });

    it('K 線（日）：輕點顯示收盤與「較前一根」；第一根只顯示收盤', async () => {
        m.fetchChartHistory.mockReset().mockResolvedValue(DAY_KBARS);
        await renderPeriod('1D');
        await tap(10, 100);
        expect(readoutText()).toContain('11/04');
        expect(textOf(byTestId('chart-readout-price')[0]!)).toBe('收 1,080');
        // K 線也附該根的量（量仍疊在主圖，不另建副圖）
        expect(textOf(byTestId('chart-readout-volume')[0]!)).toBe('量 20');
        expect(textOf(byTestId('chart-readout-change')[0]!)).toBe('較前一根 ▲30 (+2.86%)');
        await tap(40, 100);
        expect(textOf(byTestId('chart-readout-change')[0]!)).toBe('較前一根 0 (0.00%)');
        expect(byTestId('chart-readout-change')[0]!.props.className).toContain(tradeStyles.dirText.flat);
        await tap(0, 100);
        expect(readoutText()).toContain('11/03');
        expect(byTestId('chart-readout-change')).toHaveLength(0);
    });

    it('S1：輕點、再點、移動、✕、平移、雙指、程式庫清除十字線都不呼叫 openTicket／openOrderAction，lib 送出函式 0 次', async () => {
        await renderPeriod('line', [ORDER_LINE]);
        await tap(10, 100);
        await tap(10, 100);
        await tap(0, 100);
        await tap(20, 100);
        await act(async () => { byTestId('chart-readout-close')[0]!.props.onClick(); });
        await tap(10, 100);
        await act(async () => { wrap().props.onPointerDown(ptr(10, 100)); });
        await act(async () => { wrap().props.onPointerMove(ptr(60, 100)); });
        await act(async () => { wrap().props.onPointerUp(ptr(60, 100)); });
        await act(async () => { wrap().props.onPointerDown({ ...ptr(10, 100), pointerId: 1, isPrimary: true }); });
        await act(async () => { wrap().props.onPointerDown({ ...ptr(60, 100), pointerId: 2, isPrimary: false }); });
        await act(async () => { wrap().props.onPointerUp({ ...ptr(60, 100), pointerId: 2 }); });
        await act(async () => { wrap().props.onPointerUp({ ...ptr(10, 100), pointerId: 1 }); });
        await act(async () => { crosshairHandler()({ time: undefined, point: undefined, seriesData: new Map() }); });
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        expect(byTestId('chart-pick')).toHaveLength(0);
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });
});

describe('TradeChart 走勢成交量副圖', () => {
    const volIndex = () => m.chart.addSeries.mock.calls.findIndex(c => c[0] === 'Histogram');
    const volCall = () => m.chart.addSeries.mock.calls[volIndex()];
    const volSeries = () => m.allSeries[volIndex()]!;
    const press = async (x: number, y: number, ms: number) => {
        await act(async () => { wrap().props.onPointerDown(ptr(x, y)); });
        await tick(ms);
    };
    const release = async (x: number, y: number) => { await act(async () => { wrap().props.onPointerUp(ptr(x, y)); }); };
    const crosshairHandler = () => m.chart.subscribeCrosshairMove.mock.calls.at(-1)![0] as (p: unknown) => void;

    beforeEach(() => {
        m.fetchChartHistory.mockReset().mockResolvedValue(LINE_KBARS);
    });

    it('走勢：成交量在 pane 1（量的座標、副圖高度、外框加高）；量柱以本分鐘對前一分鐘（第一根對參考價）漲紅跌綠；副圖圖例「成交量」', async () => {
        await render([], 'line');
        await tick(20);
        const [, opts, pane] = volCall()!;
        expect(pane).toBe(1);
        expect(opts).toMatchObject({ priceFormat: { type: 'volume' }, lastValueVisible: false });
        expect((opts as Record<string, unknown>).priceScaleId).toBeUndefined(); // 副圖自己的右側座標，不是主圖的疊加座標
        expect(m.paneObjs[1]!.setHeight).toHaveBeenCalledWith(cs.PANE_HEIGHT_PX);
        expect(wrap().props.className).toBe(cs.frame[1]);
        const data = volSeries().setData.mock.calls.at(-1)![0] as Array<{ value: number; color: string }>;
        // 1075 > 參考價 1070 → 漲；1080 > 1075 → 漲；1065 < 1080 → 跌（測試配色：upVol #f008、downVol #0f08）
        expect(data.map(p => [p.value, p.color])).toEqual([[10, '#f008'], [20, '#f008'], [30, '#0f08']]);
        // 圖例：在 pane 1 的頂端（主圖高 200＋分隔線 1），顯示最新一分鐘的量
        const volLegend = byTestId('chart-legend').find(n => textOf(n).includes('成交量'))!;
        expect(volLegend.props.style).toEqual({ top: '205px' });
        expect(textOf(volLegend)).toContain('30');
        // 主圖圖例不含成交量
        expect(textOf(byTestId('chart-legend')[0]!)).not.toContain('成交量');
    });

    it('K 線：成交量維持疊加在主圖（priceScaleId vol、沒有 pane），外框不加高', async () => {
        await render([], '5m');
        const [, opts, pane] = volCall()!;
        expect(pane).toBeUndefined();
        expect(opts).toMatchObject({ priceScaleId: 'vol' });
        expect(wrap().props.className).toBe(cs.frame[0]);
        expect(legendText()).not.toContain('成交量');
    });

    it('指數走勢不建成交量副圖、外框維持 0 副圖；資訊列不附量', async () => {
        await act(async () => {
            view = create(createElement(TradeChart, { code: '001', contract: { ...contract, code: '001', security_type: 'IND' } as ContractInfo, period: 'line', lines: [] }), { createNodeMock: nodeMock });
        });
        await tick(50);
        // 指數沒有均價線；只多 X 軸用的空白點 series
        expect(seriesTypes()).toEqual(['Baseline', 'Line']);
        expect(wrap().props.className).toBe(cs.frame[0]);
        await press(12, 100, 100);
        await release(12, 100);
        expect(byTestId('chart-readout')).toHaveLength(1);
        expect(byTestId('chart-readout-volume')).toHaveLength(0);
    });

    it('量全為 0 時不建副圖（外框 0 副圖）；之後有量的成交才建立並整段 setData，同一分鐘的成交 update 最後一根', async () => {
        m.fetchChartHistory.mockReset().mockResolvedValue({ ...LINE_KBARS, Volume: [0, 0, 0] });
        await render([], 'line');
        expect(seriesTypes()).toEqual(['Baseline', 'Line', 'Line']); // 主圖、均價線、X 軸空白點；沒有量副圖
        expect(wrap().props.className).toBe(cs.frame[0]);
        expect(legendText()).not.toContain('成交量');

        await emit({ time: '09:03:30', close: '1065', volume: 5, total_volume: 5 });
        expect(volCall()![2]).toBe(1);
        expect(wrap().props.className).toBe(cs.frame[1]);
        const vol = volSeries();
        const set = vol.setData.mock.calls.at(-1)![0] as Array<{ value: number; color: string }>;
        // 09:04 這一分鐘 1065 與前一分鐘收盤 1065 相同 → 平盤中性色
        expect(set.map(p => p.value)).toEqual([0, 0, 0, 5]);
        expect(set.at(-1)!.color).toBe('#888');

        await emit({ time: '09:03:40', close: '1070', volume: 7, total_volume: 12 });
        expect(vol.update).toHaveBeenLastCalledWith({ time: expect.any(Number), value: 12, color: '#f008' });
    });

    it('有量的走勢：即時成交更新最後一根的量柱（不重建副圖）', async () => {
        await render([], 'line');
        const vol = volSeries();
        await emit({ time: '09:02:30', close: '1060', volume: 4, total_volume: 64 });
        // 09:03 這一分鐘：30 + 4，收 1060 < 前一分鐘 1080 → 跌
        expect(vol.update).toHaveBeenLastCalledWith({ time: expect.any(Number), value: 34, color: '#0f08' });
        expect(m.chart.addSeries.mock.calls.filter(c => c[0] === 'Histogram')).toHaveLength(1);
    });

    it('在成交量副圖內長按不選價、輕點不顯示資訊列；主圖內長按仍可選價', async () => {
        await render([], 'line');
        await tick(20); // 版面定位：主圖高 200
        await press(100, 250, LONG_PRESS_MS + 10);
        await act(async () => { crosshairHandler()({ time: 1, point: { x: 100, y: 250 }, paneIndex: 1, seriesData: new Map() }); });
        await release(100, 250);
        expect(byTestId('chart-pick')).toHaveLength(0);

        await press(12, 250, 100);
        await release(12, 250);
        expect(byTestId('chart-readout')).toHaveLength(0);

        await press(100, 150, LONG_PRESS_MS + 10);
        await release(100, 150);
        expect(byTestId('chart-pick')).toHaveLength(1);
        expect(m.openTicket).not.toHaveBeenCalled();
    });

    it('退出全螢幕後程式庫依比例放大了副圖：一般模式把副圖拉回 PANE_HEIGHT_PX（價格區不縮小）；全螢幕不校正', async () => {
        await render([], 'line');
        await tick(20);
        m.paneObjs.forEach(p => p.setStretchFactor.mockClear());
        m.paneObjs[1]!.getHeight.mockImplementation(() => 127);
        try {
            await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
            await tick(20);
            expect(m.paneObjs[1]!.setStretchFactor).not.toHaveBeenCalled();
            await act(async () => { byTestId('chart-fs-exit')[0]!.props.onClick(); });
            await tick(20);
            // 以 stretch factor 一次設定：主圖＝總高 327 − 96，副圖＝96
            expect(m.paneObjs[0]!.setStretchFactor).toHaveBeenCalledWith(200 + 127 - cs.PANE_HEIGHT_PX);
            expect(m.paneObjs[1]!.setStretchFactor).toHaveBeenCalledTimes(1);
            expect(m.paneObjs[1]!.setStretchFactor).toHaveBeenCalledWith(cs.PANE_HEIGHT_PX);
            // 同一外框高度不反覆校正
            await emit({ time: '09:02:30', close: '1060', volume: 4, total_volume: 64 });
            await tick(20);
            expect(m.paneObjs[1]!.setStretchFactor).toHaveBeenCalledTimes(1);
        } finally {
            m.paneObjs[1]!.getHeight.mockImplementation(() => 96);
        }
    });

    it('輕點資訊列附該分鐘的量（無障礙名稱一併）', async () => {
        await render([], 'line');
        await press(250, 100, 100);
        await release(250, 100);
        expect(textOf(byTestId('chart-readout-volume')[0]!)).toBe('量 30');
        const group = byTestId('chart-readout')[0]!.findAll(n => n.props.role === 'group')[0]!;
        expect(group.props['aria-label']).toContain('成交量 30');
    });
});

describe('TradeChart 走勢副圖：分時買賣力、大單／小單買賣力', () => {
    const flowCalls = () => m.chart.addSeries.mock.calls.map((c, i) => ({ type: c[0], pane: c[2], series: m.allSeries[i]! })).filter(c => (c.pane ?? 0) >= 2);
    const paneLegend = (needle: string) => byTestId('chart-legend').find(n => textOf(n).includes(needle));
    const press = async (x: number, y: number, ms: number) => {
        await act(async () => { wrap().props.onPointerDown(ptr(x, y)); });
        await tick(ms);
    };
    const release = async (x: number, y: number) => { await act(async () => { wrap().props.onPointerUp(ptr(x, y)); }); };
    beforeEach(() => {
        m.fetchChartHistory.mockReset().mockResolvedValue(LINE_KBARS);
        Object.values(m.send).forEach(f => f.mockReset());
    });

    it('預設關閉：0 個逐筆請求、只有量副圖（外框 1 副圖）', async () => {
        await render([], 'line');
        expect(m.fetchTicks).not.toHaveBeenCalled();
        expect(flowCalls()).toHaveLength(0);
        expect(wrap().props.className).toBe(cs.frame[1]);
    });

    it('開啟兩個：下載一次當日逐筆；量在 pane 1、分時買賣力 pane 2（外盤正柱、內盤負柱、累積淨買線）、大單／小單 pane 3，外框 3 副圖', async () => {
        setLineIndicatorSettings({ flow: true, bigSmall: true });
        await render([], 'line');
        await tick(INDICATOR_FLUSH_MS + 20);
        expect(m.fetchTicks).toHaveBeenCalledTimes(1);
        expect(m.fetchTicks.mock.calls[0]![1]).toBe('2026-11-05');
        expect(m.chart.addSeries.mock.calls.find(c => c[0] === 'Histogram')![2]).toBe(1);
        const calls = flowCalls();
        expect(calls.map(c => `${c.type}@${c.pane}`)).toEqual(['Histogram@2', 'Histogram@2', 'Line@2', 'Line@3', 'Line@3']);
        expect((m.chart.addSeries.mock.calls.find(c => c[2] === 2 && c[0] === 'Line')![1] as { priceScaleId?: string }).priceScaleId).toBe('flow-net');
        expect(wrap().props.className).toBe(cs.frame[3]);
        const [buy, sell, net, big, small] = calls.map(c => c.series.setData.mock.calls.at(-1)![0] as Array<{ value: number }>);
        expect(buy!.map(p => p.value)).toEqual([6, 20, 0]);
        expect(sell!.map(p => p.value)).toEqual([-4, -0, -30]);
        expect(net!.map(p => p.value)).toEqual([2, 22, -8]);
        expect(big!.map(p => p.value)).toEqual([6, 26, -4]);
        expect(small!.map(p => p.value)).toEqual([-4, -4, -4]);
        // 圖例：當日累計（tick_type 0 不計）
        const flow = textOf(paneLegend('分時買賣力')!);
        expect(flow).toContain('外 26');
        expect(flow).toContain('內 34');
        expect(flow).toContain('外盤比 43.3%');
        expect(flow).toContain('累積淨 -8');
        const bs = textOf(paneLegend('大單≥500萬')!);
        expect(bs).toContain('淨 -4');
        expect(bs).toContain('小單');
        expect(paneLegend('分時買賣力')!.props.style).toEqual({ top: `${(200 + 1) + (96 + 1) + 4}px` });
    });

    it('輕點某一分鐘：分時買賣力顯示該分鐘、累積線為到該分鐘為止', async () => {
        setLineIndicatorSettings({ flow: true, bigSmall: true });
        await render([], 'line');
        await tick(INDICATOR_FLUSH_MS + 20);
        await press(20, 100, 100); // logical 1 → 09:02
        await release(20, 100);
        const flow = textOf(paneLegend('分時買賣力')!);
        expect(flow).toContain('外 20');
        expect(flow).toContain('內 0');
        expect(flow).toContain('外盤比 100.0%');
        expect(flow).toContain('累積淨 +22');
        expect(textOf(paneLegend('大單≥500萬')!)).toContain('淨 +26');
    });

    it('改門檻只重算（不重抓）；關閉移除副圖、外框收回，0 個新請求；再開沿用快取；換週期再回走勢也沿用', async () => {
        setLineIndicatorSettings({ bigSmall: true });
        await render([], 'line');
        await tick(INDICATOR_FLUSH_MS + 20);
        expect(flowCalls().map(c => `${c.type}@${c.pane}`)).toEqual(['Line@2', 'Line@2']);
        expect(wrap().props.className).toBe(cs.frame[2]);
        await act(async () => { setLineIndicatorSettings({ threshold: 2000 }); });
        const big = flowCalls()[0]!.series;
        // 2 千萬：09:01 的 645 萬改算小單；09:02（2,160 萬）、09:03（3,195 萬）仍是大單
        expect((big.setData.mock.calls.at(-1)![0] as Array<{ value: number }>).map(p => p.value)).toEqual([0, 20, -10]);
        expect(textOf(paneLegend('大單≥2千萬')!)).toContain('淨 -10');
        await act(async () => { setLineIndicatorSettings({ bigSmall: false }); });
        await tick(20);
        expect(m.chart.removeSeries).toHaveBeenCalledWith(big);
        expect(wrap().props.className).toBe(cs.frame[1]);
        await act(async () => { setLineIndicatorSettings({ bigSmall: true }); });
        await act(async () => {
            view!.update(createElement(TradeChart, { code: '2330', contract, period: '5m', lines: [] }));
        });
        await tick(50);
        await act(async () => {
            view!.update(createElement(TradeChart, { code: '2330', contract, period: 'line', lines: [] }));
        });
        await tick(INDICATOR_FLUSH_MS + 50);
        expect(m.fetchTicks).toHaveBeenCalledTimes(1);
    });

    it('K 線、指數、權證、期貨不建買賣力副圖也不下載', async () => {
        setLineIndicatorSettings({ flow: true, bigSmall: true });
        await render([], '5m');
        expect(m.fetchTicks).not.toHaveBeenCalled();
        await unmount();
        for (const security_type of ['IND', 'WRT', 'FUT']) {
            m.chart.addSeries.mockClear();
            await act(async () => {
                view = create(createElement(TradeChart, { code: '2330', contract: { ...contract, security_type } as ContractInfo, period: 'line', lines: [] }), { createNodeMock: nodeMock });
            });
            await tick(INDICATOR_FLUSH_MS + 20);
            expect(flowCalls(), security_type).toHaveLength(0);
            await unmount();
        }
        expect(m.fetchTicks).not.toHaveBeenCalled();
    });

    it('讀取中、失敗就地寫在圖例；失敗不自動重試', async () => {
        let reject!: (e: Error) => void;
        m.fetchTicks.mockReset().mockReturnValue(new Promise((_, r) => { reject = r; }));
        setLineIndicatorSettings({ flow: true });
        await render([], 'line');
        expect(textOf(paneLegend('分時買賣力')!)).toContain('讀取逐筆中…');
        await act(async () => { reject(new Error('timeout')); });
        await tick(INDICATOR_FLUSH_MS + 20);
        expect(textOf(paneLegend('分時買賣力')!)).toContain('讀取失敗（重開指標重試）');
        await tick(60_000);
        expect(m.fetchTicks).toHaveBeenCalledTimes(1);
    });

    it('即時成交累加到最後一分鐘（不重複計入歷史已有的那筆）', async () => {
        setLineIndicatorSettings({ flow: true });
        await render([], 'line');
        await tick(INDICATOR_FLUSH_MS + 20);
        await emit({ time: '09:02:40.000000', close: '1066', volume: 5, total_volume: 74, tick_type: 1 });
        await tick(INDICATOR_FLUSH_MS + 20);
        const flow = textOf(paneLegend('分時買賣力')!);
        expect(flow).toContain('外 31');
        expect(flow).toContain('內 34');
    });

    it('在買賣力副圖內長按不選價、輕點不顯示資訊列', async () => {
        setLineIndicatorSettings({ flow: true, bigSmall: true });
        await render([], 'line');
        await tick(INDICATOR_FLUSH_MS + 20);
        await press(100, 350, LONG_PRESS_MS + 10);
        await act(async () => { (m.chart.subscribeCrosshairMove.mock.calls.at(-1)![0] as (p: unknown) => void)({ time: 1, point: { x: 100, y: 350 }, paneIndex: 2, seriesData: new Map() }); });
        await release(100, 350);
        expect(byTestId('chart-pick')).toHaveLength(0);
        await press(12, 400, 100);
        await release(12, 400);
        expect(byTestId('chart-readout')).toHaveLength(0);
    });

    it('S1：開關、門檻、副圖互動都不開下單面板，lib 送出函式 0 次', async () => {
        await render([], 'line');
        await act(async () => { setLineIndicatorSettings({ flow: true, bigSmall: true }); });
        await act(async () => { setLineIndicatorSettings({ threshold: 100 }); });
        await tick(INDICATOR_FLUSH_MS + 20);
        await press(12, 350, 100);
        await release(12, 350);
        await act(async () => { setLineIndicatorSettings({ flow: false, bigSmall: false }); });
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });
});

describe('TradeChart 走勢 X 軸固定與漲跌停範圍', () => {
    const chartOptions = () => (m.createChart.mock.calls.at(-1) as unknown as [unknown, Record<string, unknown>])[1];
    const axisIndex = () => m.chart.addSeries.mock.calls.findIndex(c => (c[1] as { lineVisible?: boolean } | undefined)?.lineVisible === false);
    const axisPoints = () => m.allSeries[axisIndex()]!.setData.mock.calls.at(-1)![0] as Array<{ time: number; value?: number }>;
    const hm = (tm: number) => new Date(tm * 1000).toISOString().slice(5, 16).replace('T', ' ');
    const press = async (x: number, y: number, ms: number) => {
        await act(async () => { wrap().props.onPointerDown(ptr(x, y)); });
        await tick(ms);
    };
    const release = async (x: number, y: number) => { await act(async () => { wrap().props.onPointerUp(ptr(x, y)); }); };
    const tapAt = async (x: number, y: number) => { await press(x, y, 100); await release(x, y); };
    const mainProvider = () => (m.chart.addSeries.mock.calls[0]![1] as { autoscaleInfoProvider: (o: () => unknown) => unknown }).autoscaleInfoProvider;
    const avgProvider = () => (m.chart.addSeries.mock.calls[1]![1] as { autoscaleInfoProvider: (o: () => unknown) => unknown }).autoscaleInfoProvider;
    const titles = () => mainSeries().priceLines.map(pl => `${pl.opts.title}@${pl.opts.price}`);
    const renderWith = async (c: ContractInfo, period: 'line' | '5m' = 'line', code = '2330') => {
        // 每次掛載重新記錄 series（mainProvider、titles 看這一次的圖表）
        m.chart.addSeries.mockClear();
        m.allSeries.length = 0;
        await act(async () => {
            view = create(createElement(TradeChart, { code, contract: c, period, lines: [] }), { createNodeMock: nodeMock });
        });
        await tick(50);
    };
    beforeEach(() => {
        m.fetchChartHistory.mockReset().mockResolvedValue(LINE_KBARS);
        m.timeScale.fitContent.mockClear();
        m.chart.setCrosshairPosition.mockClear();
        Object.values(m.send).forEach(f => f.mockReset());
    });

    it('走勢關閉拖移、縮放、滾輪、軸拖曳、雙擊重設與慣性；X 軸兩端固定；K 線仍可拖移、縮放', async () => {
        await render([], 'line');
        const o = chartOptions();
        expect(o.handleScroll).toBe(false);
        expect(o.handleScale).toBe(false);
        // 走勢不縮放：不放行雙指給圖表（平台手勢防護照常擋）
        expect(wrap().props['data-allow-pinch']).toBeUndefined();
        expect(o.kineticScroll).toEqual({ touch: false, mouse: false });
        expect(o.timeScale).toMatchObject({ rightOffset: 0, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true });
        // fixRightEdge 會把右端鎖在最後一根有資料的點（右側未到的時段被切掉）
        expect((o.timeScale as { fixRightEdge?: boolean }).fixRightEdge).toBeUndefined();
        await unmount();
        m.chart.addSeries.mockClear();
        await render([], '5m');
        const k = chartOptions();
        expect(k.handleScroll).toMatchObject({ horzTouchDrag: true, pressedMouseMove: true, mouseWheel: true, vertTouchDrag: false });
        expect(k.handleScale).toMatchObject({ pinch: true, mouseWheel: true, axisDoubleClickReset: true });
        expect(k.kineticScroll).toBeUndefined();
        expect(axisIndex()).toBe(-1);
    });

    it('X 軸涵蓋整個時段：09:01～13:30 每分鐘一個空白點（只有開盤三分鐘的資料，右側留白），並 fitContent', async () => {
        await render([], 'line');
        const pts = axisPoints();
        expect(pts).toHaveLength(270);
        expect(pts.every(p => p.value === undefined)).toBe(true);
        expect(hm(pts[0]!.time)).toBe('11-05 09:01');
        expect(hm(pts.at(-1)!.time)).toBe('11-05 13:30');
        expect(m.timeScale.fitContent).toHaveBeenCalled();
        // 尺寸改變（全螢幕、外框加高）後仍是整個時段
        m.timeScale.fitContent.mockClear();
        for (const [fn] of m.timeScale.subscribeSizeChange.mock.calls.slice(-2)) (fn as () => void)();
        expect(m.timeScale.fitContent).toHaveBeenCalled();
    });

    it('換時段（回前景重抓到新的一天）：X 軸換成新時段', async () => {
        await render([], 'line');
        m.fetchChartHistory.mockReset().mockResolvedValue({ ...LINE_KBARS, datetime: LINE_KBARS.datetime.map(d => d.replace('11-05', '11-06')) });
        m.gate = { resumeSeq: 1 };
        await act(async () => { view!.update(createElement(TradeChart, { code: '2330', contract, period: 'line', lines: [] })); });
        await tick(50);
        expect(hm(axisPoints()[0]!.time)).toBe('11-06 09:01');
        expect(axisPoints()).toHaveLength(270);
        expect(m.createChart).toHaveBeenCalledTimes(1);
    });

    it('期貨夜盤：15:01～隔日 05:00 共 840 分鐘', async () => {
        m.fetchChartHistory.mockReset().mockResolvedValue({ ...LINE_KBARS, datetime: ['2026-11-05 15:01:00', '2026-11-05 15:02:00', '2026-11-05 15:03:00'] });
        await renderWith({ ...contract, security_type: 'FUT', code: 'TXFL6' } as ContractInfo, 'line', 'TXFL6');
        const pts = axisPoints();
        expect(pts).toHaveLength(840);
        expect(hm(pts[0]!.time)).toBe('11-05 15:01');
        expect(hm(pts.at(-1)!.time)).toBe('11-06 05:00');
    });

    it('沒有成交的分鐘也占位置：輕點依時間吸附到最近的一根，「同一點」以那一根的時間位置判斷', async () => {
        m.fetchChartHistory.mockReset().mockResolvedValue({ ...LINE_KBARS, datetime: ['2026-11-05 09:01:00', '2026-11-05 09:05:00', '2026-11-05 09:06:00'] });
        await render([], 'line');
        await tapAt(72, 100); // 邏輯 3.6 → 第 4 分鐘 09:05
        expect(textOf(byTestId('chart-readout')[0]!)).toContain('09:05');
        await tapAt(24, 100); // 邏輯 1.2 → 09:02 → 最近的是 09:01
        expect(textOf(byTestId('chart-readout')[0]!)).toContain('09:01');
        await tapAt(8, 100); // 離 09:01（x 0）8px：同一點 → 收起
        expect(byTestId('chart-readout')).toHaveLength(0);
        await tapAt(290, 100); // 右側未到的時段 → 最後一根
        expect(textOf(byTestId('chart-readout')[0]!)).toContain('09:06');
    });

    it('點主圖價格軸：切換漲跌停範圍（Y 軸固定為跌停～漲停、均價線不參與、畫漲停跌停線、顯示標示）；不出資訊列、不選價；再點還原', async () => {
        await render([], 'line');
        expect(mainProvider()(() => 'auto')).toBe('auto');
        await tapAt(310, 100);
        expect(getLimitRange()).toBe(true);
        expect(mainProvider()(() => 'auto')).toEqual({ priceRange: { minValue: 963, maxValue: 1175 } });
        expect(avgProvider()(() => 'auto')).toBeNull();
        expect(titles()).toEqual(expect.arrayContaining(['漲停@1175', '跌停@963']));
        expect(mainSeries().priceLines.find(pl => pl.opts.title === '漲停')!.opts.color).toBe('#f00');
        const badge = byTestId('chart-range-badge');
        expect(badge).toHaveLength(1);
        expect(badge[0]!.props['aria-pressed']).toBe('true');
        expect(textOf(badge[0]!)).toBe('漲跌停範圍');
        expect(byTestId('chart-readout')).toHaveLength(0);
        expect(byTestId('chart-pick')).toHaveLength(0);
        expect(m.chart.setCrosshairPosition).not.toHaveBeenCalled();

        await tapAt(310, 100);
        expect(getLimitRange()).toBe(false);
        expect(mainProvider()(() => 'auto')).toBe('auto');
        expect(byTestId('chart-range-badge')).toHaveLength(0);
        expect((mainSeries() as unknown as { removePriceLine: ReturnType<typeof vi.fn> }).removePriceLine).toHaveBeenCalled();
    });

    it('點標示也能回到自動範圍；量副圖的價格軸不觸發', async () => {
        await render([], 'line');
        await tick(20); // 版面定位：主圖高 200
        await tapAt(310, 250); // 量副圖的價格軸
        expect(getLimitRange()).toBe(false);
        await tapAt(310, 100);
        expect(getLimitRange()).toBe(true);
        await act(async () => { byTestId('chart-range-badge')[0]!.props.onClick(); });
        expect(getLimitRange()).toBe(false);
        expect(byTestId('chart-range-badge')).toHaveLength(0);
    });

    it('指數、沒有正數漲跌停、K 線：點價格軸不切換也不顯示標示；提示文字只在可切換時提到價格軸', async () => {
        await renderWith({ ...contract, security_type: 'IND' } as ContractInfo);
        await tapAt(310, 100);
        expect(getLimitRange()).toBe(false);
        expect(textOf(view!.root.findAll(n => n.type === 'p')[0]!)).not.toContain('價格軸');
        await unmount();
        await renderWith({ ...contract, limit_up: 0 } as ContractInfo);
        await tapAt(310, 100);
        expect(getLimitRange()).toBe(false);
        await unmount();
        await renderWith(contract, '5m');
        await tapAt(310, 100);
        expect(getLimitRange()).toBe(false);
        await unmount();
        await renderWith(contract);
        expect(textOf(view!.root.findAll(n => n.type === 'p')[0]!)).toBe('點圖看價格，長按選價；點價格軸看漲跌停');
    });

    it('狀態在本次使用期間沿用（換檔、換週期再回走勢）；沒有漲跌停的商品不套用；全螢幕仍顯示標示；期權補畫漲跌停線', async () => {
        await render([], 'line');
        await tapAt(310, 100);
        await unmount();
        await renderWith({ ...contract, code: '2317', limit_up: 220, limit_down: 180 } as ContractInfo, 'line', '2317');
        expect(byTestId('chart-range-badge')).toHaveLength(1);
        expect(mainProvider()(() => 'auto')).toEqual({ priceRange: { minValue: 180, maxValue: 220 } });
        await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
        expect(byTestId('chart-range-badge')).toHaveLength(1);
        await unmount();
        await renderWith({ ...contract, security_type: 'IND', limit_up: 0, limit_down: 0 } as ContractInfo, 'line', '001');
        expect(byTestId('chart-range-badge')).toHaveLength(0);
        expect(mainProvider()(() => 'auto')).toBe('auto');
        await unmount();
        await renderWith({ ...contract, security_type: 'FUT', code: 'TXFL6', limit_up: 30000, limit_down: 25000 } as ContractInfo, 'line', 'TXFL6');
        expect(titles()).toEqual(expect.arrayContaining(['漲停@30000', '跌停@25000']));
        expect(getLimitRange()).toBe(true);
    });

    it('S1：點價格軸、點標示都不開下單面板，lib 送出函式 0 次', async () => {
        await render([], 'line');
        await tapAt(310, 100);
        await act(async () => { byTestId('chart-range-badge')[0]!.props.onClick(); });
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });
});

// ---- 圖表長按選價下單設定（本裝置，預設關）：關閉時長按只看價格，0 次 openTicket；開啟時同既有行為；切換即時套用 ----

describe('TradeChart 圖表長按選價下單設定', () => {
    beforeEach(() => {
        // 回到預設（關）：清掉檔頭 beforeEach 寫入的開啟值、記憶體重設
        storage.delete(MOBILE_DEVICE_SETTINGS_KEY);
        resetMobileDeviceSettingsForTest();
        m.fetchChartHistory.mockReset().mockResolvedValue(LINE_KBARS);
        m.chart.setCrosshairPosition.mockClear();
        m.chart.clearCrosshairPosition.mockClear();
        m.haptic.mockReset();
        Object.values(m.send).forEach(f => f.mockReset());
    });

    async function renderAs(period: 'line' | '5m', c: ContractInfo = contract, lines: PriceLineSpec[] = []) {
        await act(async () => {
            view = create(createElement(TradeChart, { code: c.code, contract: c, period, lines, onPeriodChange: vi.fn() }), { createNodeMock: nodeMock });
        });
        await tick(50);
    }
    const longPress = async (x: number, y: number, upX = x, upY = y) => {
        await act(async () => { wrap().props.onPointerDown(ptr(x, y)); });
        await tick(LONG_PRESS_MS + 10);
        if (upX !== x || upY !== y) await act(async () => { wrap().props.onPointerMove(ptr(upX, upY)); });
        await act(async () => { wrap().props.onPointerUp(ptr(upX, upY)); });
    };
    const tapAt = async (x: number, y: number) => {
        await act(async () => { wrap().props.onPointerDown(ptr(x, y)); });
        await tick(100);
        await act(async () => { wrap().props.onPointerUp(ptr(x, y)); });
    };
    const note = () => textOf(view!.root.findAll(n => n.type === 'p')[0]!);
    const readout = () => byTestId('chart-readout');

    it('預設關閉', async () => {
        expect(getMobileDeviceSettings().chartPricePick).toBe(false);
    });

    it('關閉（走勢）：長按不浮出選價列、不觸發 haptic；放開時釘在放開的那一根（同輕點）；0 次 openTicket', async () => {
        await renderAs('line');
        await longPress(12, 100); // logical 0.6 → 09:02
        expect(byTestId('chart-pick')).toHaveLength(0);
        expect(byTestId('chart-pick-closing')).toHaveLength(0);
        expect(m.haptic).not.toHaveBeenCalled();
        expect(readout()).toHaveLength(1);
        expect(readout()[0]!.props['data-source']).toBe('tap');
        expect(textOf(byTestId('chart-readout-price')[0]!)).toBe('1,080');
        // 長按後拖到別根再放開：釘在放開的那一根
        await longPress(12, 100, 52, 100); // logical 2.6 → 09:03
        expect(textOf(byTestId('chart-readout-price')[0]!)).toBe('1,065');
        // 再長按同一根：只釘住、不收起（長按不是切換）
        await longPress(52, 100);
        expect(readout()).toHaveLength(1);
        // 長按價格軸：不切換漲跌停、不選價
        await longPress(310, 100);
        expect(getLimitRange()).toBe(false);
        expect(byTestId('chart-pick')).toHaveLength(0);
        expect(m.haptic).not.toHaveBeenCalled();
        expect(m.openTicket).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });

    it('關閉（K 線、全螢幕）：長按都不浮出選價列；全螢幕買賣鍵照常只開下單面板', async () => {
        m.fetchChartHistory.mockReset().mockResolvedValue(minuteKbars());
        await renderAs('5m');
        await longPress(100, 217);
        expect(byTestId('chart-pick')).toHaveLength(0);
        expect(readout()).toHaveLength(1);
        await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
        expect(rootNode().props['data-fullscreen']).toBe('true');
        await longPress(100, 217);
        expect(byTestId('chart-pick')).toHaveLength(0);
        expect(m.openTicket).not.toHaveBeenCalled();
        await unmount();
        m.fetchChartHistory.mockReset().mockResolvedValue(LINE_KBARS);
        await renderAs('line');
        await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
        await longPress(12, 100);
        expect(byTestId('chart-pick')).toHaveLength(0);
        expect(m.haptic).not.toHaveBeenCalled();
        expect(m.openTicket).not.toHaveBeenCalled();
        await act(async () => { byTestId('chart-fs-buy')[0]!.props.onClick(); });
        expect(m.openTicket.mock.calls).toEqual([[{ code: '2330', action: 'Buy', source: 'button' }]]);
    });

    it('關閉時點價格軸切換漲跌停、點委託線標籤開委託操作面板照常', async () => {
        await renderAs('line');
        await tapAt(310, 100);
        expect(getLimitRange()).toBe(true);
        await unmount();
        m.fetchChartHistory.mockReset().mockResolvedValue(KBARS);
        await renderAs('5m', contract, [ORDER_LINE]);
        await act(async () => { byTestId('chart-order-label')[0]!.props.onClick(); });
        expect(m.openOrderAction.mock.calls).toEqual([['o1', 'menu']]);
        expect(m.openTicket).not.toHaveBeenCalled();
    });

    it('開啟：同既有行為（長按 haptic、放開浮出選價列、點「賣出」才開下單面板）', async () => {
        setMobileDeviceSettings({ chartPricePick: true });
        await renderAs('line');
        await longPress(12, 100); // 假圖表 coordinateToPrice(100) = 1200 → 取整 1,200
        expect(m.haptic.mock.calls).toEqual([['longPress']]);
        expect(byTestId('chart-pick')).toHaveLength(1);
        expect(readout()).toHaveLength(0);
        expect(m.openTicket).not.toHaveBeenCalled();
        await act(async () => { byTestId('chart-pick')[0]!.findAllByType('button')[1]!.props.onClick(); });
        expect(m.openTicket.mock.calls).toEqual([[{ code: '2330', action: 'Sell', price: 1200, source: 'chart' }]]);
    });

    it('切換即時套用：開啟後長按選價、關閉時收起已浮出的選價列，提示文字跟著變', async () => {
        await renderAs('line');
        expect(note()).toBe('點圖看價格；點價格軸看漲跌停');
        await longPress(12, 100);
        expect(byTestId('chart-pick')).toHaveLength(0);
        await act(async () => { setMobileDeviceSettings({ chartPricePick: true }); });
        expect(note()).toBe('點圖看價格，長按選價；點價格軸看漲跌停');
        await longPress(12, 100);
        expect(byTestId('chart-pick')).toHaveLength(1);
        await act(async () => { setMobileDeviceSettings({ chartPricePick: false }); });
        expect(byTestId('chart-pick')).toHaveLength(0);
        expect(note()).toBe('點圖看價格；點價格軸看漲跌停');
        await longPress(12, 100);
        expect(byTestId('chart-pick')).toHaveLength(0);
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.createChart).toHaveBeenCalledTimes(1); // 切換不重建圖表
    });

    it('長按途中關閉：放開不浮出選價列', async () => {
        setMobileDeviceSettings({ chartPricePick: true });
        await renderAs('line');
        await act(async () => { wrap().props.onPointerDown(ptr(12, 100)); });
        await tick(LONG_PRESS_MS + 10);
        await act(async () => { setMobileDeviceSettings({ chartPricePick: false }); });
        await act(async () => { wrap().props.onPointerUp(ptr(12, 100)); });
        expect(byTestId('chart-pick')).toHaveLength(0);
        expect(m.openTicket).not.toHaveBeenCalled();
    });

    it('提示文字：關閉時不提長按選價', async () => {
        expect(chartToolNote(true, true, false, false)).toBe('點圖看價格；點價格軸看漲跌停');
        expect(chartToolNote(true, false, false, false)).toBe('點圖看價格');
        expect(chartToolNote(false, false, false, false)).toBe('點一下看收盤與漲跌');
        expect(chartToolNote(false, false, true, false)).toBe('日 K 由 1 分 K 聚合，未含除權息調整');
        expect(chartToolNote(true, true, false, true)).toBe('點圖看價格，長按選價；點價格軸看漲跌停');
        expect(chartToolNote(true, false, false, true)).toBe('點一下看價格與漲跌；長按選價位，放開開啟下單面板');
        expect(chartToolNote(false, false, false, true)).toBe('點一下看收盤與漲跌；長按選價位');
        for (const on of [true, false]) {
            for (const [line, limit, daily] of [[true, true, false], [true, false, false], [false, false, false], [false, false, true]] as const) {
                expect(chartToolNote(line, limit, daily, on).includes('長按')).toBe(on && !daily);
            }
        }
        await renderAs('line', { ...contract, security_type: 'IND' } as ContractInfo);
        expect(note()).toBe('點圖看價格');
        await unmount();
        m.fetchChartHistory.mockReset().mockResolvedValue(KBARS);
        await renderAs('5m');
        expect(note()).toBe('點一下看收盤與漲跌');
    });

    it('S1（關閉）：走勢／K 線、直向／全螢幕長按放開，lib 送出函式 0 次、openTicket 0 次', async () => {
        for (const period of ['line', '5m'] as const) {
            m.fetchChartHistory.mockReset().mockResolvedValue(period === 'line' ? LINE_KBARS : KBARS);
            await renderAs(period, contract, [ORDER_LINE]);
            await longPress(12, 100);
            await longPress(100, 217);
            await act(async () => { byTestId('chart-fs-enter')[0]!.props.onClick(); });
            await longPress(12, 100);
            await longPress(100, 217);
            expect(byTestId('chart-pick')).toHaveLength(0);
            await unmount();
        }
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.haptic).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });
});
