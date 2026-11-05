// src/mobile/components/trade-chart.tsx — 手機交易圖表（lightweight-charts v5；規格 §6.2、§9.3、Phase 2／3）
//
// - 週期：走勢（BaselineSeries，以參考價為基準線＋均價線＋當日最高最低＋成交量）或
//   K 線（1／5／15／60 分、日）＋成交量＋使用者自訂的技術指標（lib/mobile-indicators.ts；預設 MA5／MA20）。
// - 指標：定義與計算重用 src/lib/indicator-defs.ts；主圖疊加用 LineSeries，副圖各自一個 pane，
//   副圖畫參考線（levels）。左上角圖例顯示指標名稱與最新值；長按追蹤時顯示該根的值。
//   即時更新：K 棒每 CHART_FLUSH_MS 合併重畫，指標另以 INDICATOR_FLUSH_MS 節流、只 update 變動的尾端點
//   （不會每筆成交全部重算）；歷史重抓、裁切才整段 setData。
// - 資料：fetchChartHistory() → kbarsToCandles() → aggregate()（走勢改挑當日時段）；最多 5,000 根；
//   最後一根由即時成交（onAnyTick；指數用 quote_idx）更新。試撮（simtrade）揭示價不入圖（與桌面相同），只用來偵測換時段。
// - 歷史新鮮度：chart-history-freshness.ts 依 (code, period) 決定沿用快取、先顯示快取再背景重抓、或換新 revision；
//   ResumeGate 的 resumeSeq 改變（回前景）時背景重抓；走勢與 K 線都有缺口偵測（累計量顯示真的漏量才重抓）。
// - 圖表實例只在商品、週期、配色改變時重建；重抓歷史、改指標設定都沿用既有 chart（不重建），
//   保留可見範圍（以距離最新一根的位置）與長按選價列。
// - 水平線：由 chart-model.ts 的 PriceLineSpec 畫出（委託、成本、漲跌停、參考價）。
// - 互動：單指拖曳平移、雙指縮放；長按進入追蹤模式（trackingMode），十字線價以 roundToTick 取整，
//   放開後浮出「以 X 買進／賣出」→ openTicket({ source: 'chart' })。**只開下單面板，絕不直接送單**。
//   副圖上的十字線不拿來選價（座標不是價格）。點委託線標籤 → openOrderAction(tradeId, 'menu')。
//   不支援拖曳委託線改價（規格 R7）。可互動區加 data-allow-pinch="true"（平台手勢防護略過這一區）。
// - 橫向全螢幕：手機轉橫向（lib/chart-fullscreen.ts）或按「全螢幕」→ CSS 固定定位覆蓋全畫面（留安全區），
//   上方週期＋指標＋「退出」，下方買進／賣出（只開下單面板）。iPhone Safari 沒有元素 Fullscreen API，
//   手動進入時若支援才另對 <html> 呼叫 requestFullscreen（底部面板才仍看得到），不依賴它。

import {
    BaselineSeries,
    CandlestickSeries,
    ColorType,
    createChart,
    CrosshairMode,
    HistogramSeries,
    LineSeries,
    LineStyle,
    TrackingModeExitMode,
    type IChartApi,
    type IPriceLine,
    type ISeriesApi,
    type SeriesType,
    type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useQuote } from '../../hooks/use-stream';
import { useResumeGate } from '../hooks/use-resume-gate';
import { fetchChartHistory, nextChartHistoryRevision } from '../../lib/chart-history';
import { DEF_BY_TYPE, type IndicatorDef, type OutputDef } from '../../lib/indicator-defs';
import type { IndicatorPoint } from '../../lib/indicators';
import { CLOSE_GRACE, pickIntradayWindow, sessionWindowFor, tickBucket, type SessionWindow } from '../../lib/intraday-session';
import { onAnyTick } from '../../lib/stream';
import { getChartColors, themeKey, useThemeSettings, type ChartColors } from '../../lib/theme-store';
import type { ContractInfo } from '../../lib/types/contract';
import type { Candle } from '../../lib/types/market';
import { aggregate, kbarsToCandles, nowWallClockUtc, wallClockToUtc } from '../../lib/utils/kbars';
import { formatToTick, roundToTick, tickDecimals, tickSizeFor } from '../../lib/utils/ticksize';
import { currentOrientationEnv, shouldAutoFullscreen } from '../lib/chart-fullscreen';
import { getHistoryEntry, planHistory, setHistoryEntry } from '../lib/chart-history-freshness';
import { dayHighLow, formatIndicatorValue, intradayAverage, intradayBars, liveBarTime, priceLinesKey, type PriceLineSpec } from '../lib/chart-model';
import { capBars, CHART_PERIODS, chartQueryRange, MAX_CHART_BARS, periodDef, type ChartPeriod } from '../lib/chart-ranges';
import {
    indicatorLabel,
    indicatorSettingsKey,
    INDICATOR_PALETTE,
    paletteColor,
    useMobileIndicators,
    usesPaletteColor,
    type MobileIndicator,
    type MobileIndicatorSettings,
} from '../lib/mobile-indicators';
import { openOrderAction, openTicket } from '../lib/mobile-store';
import * as cs from '../styles/chart.css';
import * as styles from '../styles/trade.css';
import { IndicatorSheet } from './indicator-sheet';

/** 即時成交合併重畫的間隔（行情 store 的 QUOTE_FLUSH_MS 未匯出，自行節流） */
export const CHART_FLUSH_MS = 100;
/** 指標的即時重算間隔（≥ 250 ms；只 update 變動的尾端點） */
export const INDICATOR_FLUSH_MS = 500;
/** 長按進入追蹤模式的時間與容許位移 */
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP_PX = 10;
/** 歷史與即時之間出現斷層時補抓歷史的最短間隔 */
export const GAP_RELOAD_MIN_MS = 120_000;
/** 走勢：即時成交與最後一根相隔超過這個秒數，且累計量顯示漏量時補抓（與桌面 intraday-chart 相同） */
export const LINE_GAP_SECONDS = 180;
/** K 線模式初次顯示的根數（手機寬度） */
const INITIAL_VISIBLE_BARS = 80;
/** 走勢均價線顏色 */
const AVG_COLOR = INDICATOR_PALETTE[0]!;

type Status = 'loading' | 'ready' | 'empty' | 'error';

interface OrderLabel {
    key: string;
    tradeId: string;
    label: string;
    buy: boolean;
    y: number;
}

/** 圖例的一組（一個指標，或走勢的均價／最高／最低） */
export interface LegendEntry {
    id: string;
    name: string;
    color: string;
    /** 0＝主圖；≥1＝副圖 */
    pane: number;
    values: { label: string; color: string; text: string }[];
}

const LINE_STYLE: Record<PriceLineSpec['kind'], { lineStyle: LineStyle; lineWidth: 1 | 2 }> = {
    'order-buy': { lineStyle: LineStyle.Solid, lineWidth: 2 },
    'order-sell': { lineStyle: LineStyle.Solid, lineWidth: 2 },
    cost: { lineStyle: LineStyle.Dotted, lineWidth: 2 },
    'limit-up': { lineStyle: LineStyle.Dashed, lineWidth: 1 },
    'limit-down': { lineStyle: LineStyle.Dashed, lineWidth: 1 },
    reference: { lineStyle: LineStyle.Solid, lineWidth: 1 },
};

function lineColor(kind: PriceLineSpec['kind'], c: ChartColors): string {
    switch (kind) {
        case 'order-buy':
        case 'limit-up':
            return c.up;
        case 'order-sell':
        case 'limit-down':
            return c.down;
        case 'cost':
            return c.crosshair;
        case 'reference':
            return c.text;
    }
}

/**
 * 指標輸出的顏色：多空方向的輸出（SuperTrend 多頭／空頭、DMI +DI／-DI）跟著使用者的漲跌配色；
 * 單一輸出的指標用調色盤；近白色（VWAP、ADX 預設）改用圖表文字色，淺色主題才看得見。
 */
export function indicatorOutputColor(item: Pick<MobileIndicator, 'color'>, def: IndicatorDef, o: OutputDef, c: ChartColors): string {
    if (def.type === 'supertrend' || def.type === 'dmi') {
        if (o.key === 'up' || o.key === 'plus') return c.up;
        if (o.key === 'down' || o.key === 'minus') return c.down;
    }
    if (usesPaletteColor(def)) return paletteColor(item.color);
    if (o.color.toLowerCase() === '#f5f7fa') return c.text;
    return o.color;
}

const t = (time: number) => time as UTCTimestamp;

interface IndOutput {
    key: string;
    label: string;
    series: ISeriesApi<SeriesType>;
    color: string;
    histogram: boolean;
    signed: boolean;
    last: number | undefined;
}

interface IndRuntime {
    item: MobileIndicator;
    def: IndicatorDef;
    params: Record<string, number>;
    pane: number;
    decimals: number;
    outputs: IndOutput[];
}

export interface TradeChartProps {
    code: string;
    contract: ContractInfo;
    period: ChartPeriod;
    lines: readonly PriceLineSpec[];
    /** 全螢幕上方的週期列切換；未提供時全螢幕只顯示目前週期 */
    onPeriodChange?: (p: ChartPeriod) => void;
}

export function TradeChart({ code, contract, period, lines, onPeriodChange }: TradeChartProps) {
    const theme = useThemeSettings();
    const themeK = themeKey(theme);
    const colors = useMemo(() => getChartColors(theme), [themeK]); // eslint-disable-line react-hooks/exhaustive-deps
    const colorsRef = useRef(colors);
    colorsRef.current = colors;
    const contractRef = useRef(contract);
    contractRef.current = contract;
    const linesRef = useRef(lines);
    linesRef.current = lines;
    const indicators = useMobileIndicators();
    const settings = indicators.settings;
    const settingsRef = useRef<MobileIndicatorSettings>(settings);
    settingsRef.current = settings;
    const settingsKey = indicatorSettingsKey(settings);

    const hostRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
    const ingestRef = useRef<((price: number, tickTime: number, volume: number, total: number | null, sim: boolean, avg?: number) => void) | null>(null);
    const lastReloadAt = useRef(0);
    const layoutRef = useRef<() => void>(() => undefined);
    /** 指標設定改變：在既有圖表上重建指標 series（不重建圖表） */
    const rebuildRef = useRef<(key: string) => void>(() => undefined);
    /** 載入失敗後「重新載入」：以新 revision 重抓（不重建圖表） */
    const retryRef = useRef<() => void>(() => undefined);
    /** ResumeGate 的 resumeSeq 改變時背景重抓 */
    const resumeRefreshRef = useRef<(seq: number) => void>(() => undefined);
    const resumeSeq = useResumeGate().resumeSeq;
    const resumeSeqRef = useRef(resumeSeq);
    resumeSeqRef.current = resumeSeq;
    /** 主圖（pane 0）的高度：長按落在副圖時不選價 */
    const mainPaneHeightRef = useRef<number | null>(null);
    // 長按追蹤狀態
    const trackingRef = useRef(false);
    const crossPriceRef = useRef<number | null>(null);
    const pressRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);

    const [status, setStatus] = useState<Status>('loading');
    const [chartGen, setChartGen] = useState(0);
    const [orderLabels, setOrderLabels] = useState<OrderLabel[]>([]);
    const [pick, setPick] = useState<number | null>(null);
    const [legend, setLegend] = useState<LegendEntry[]>([]);
    const [paneCount, setPaneCount] = useState(0);
    const [paneTops, setPaneTops] = useState<number[]>([]);
    const [sheetOpen, setSheetOpen] = useState(false);

    // ---- 全螢幕 ----
    const [manualFs, setManualFs] = useState(false);
    const [autoFs, setAutoFs] = useState(() => shouldAutoFullscreen(currentOrientationEnv()));
    const [autoDismissed, setAutoDismissed] = useState(false);
    const apiFsRef = useRef(false);
    const fullscreen = manualFs || (autoFs && !autoDismissed);

    const isLine = period === 'line';
    const secType = contract.security_type;
    const reference = contract.reference;

    // ---- 圖表生命週期＋歷史載入＋即時更新（只在商品、週期、配色改變時重建；重抓歷史沿用同一個圖表） ----
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const c = colorsRef.current;
        const ct = contractRef.current;
        const minutes = periodDef(period).minutes;
        const tick = tickSizeFor(ct, ct.reference > 0 ? ct.reference : 1);
        const precision = tickDecimals(tick);
        const priceFormat = { type: 'price' as const, precision, minMove: Number((10 ** -precision).toFixed(precision)) };
        const isIndex = ct.security_type === 'IND';

        const chart = createChart(host, {
            autoSize: true,
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: c.text,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 11,
                attributionLogo: false,
            },
            grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
            crosshair: {
                mode: CrosshairMode.Normal,
                vertLine: { color: c.crosshair, labelBackgroundColor: c.labelBg },
                horzLine: { color: c.crosshair, labelBackgroundColor: c.labelBg },
            },
            rightPriceScale: { borderColor: c.border },
            timeScale: { borderColor: c.border, timeVisible: minutes < 1440, secondsVisible: false, rightOffset: 2 },
            // 單指水平拖曳平移；垂直滑動留給頁面捲動
            handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
            // 雙指縮放；價格軸不給拖（維持自動縮放，委託線標籤位置才準）
            handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: { time: true, price: false }, axisDoubleClickReset: true },
            // 觸控長按進入追蹤模式，手指放開即離開
            trackingMode: { exitMode: TrackingModeExitMode.OnTouchEnd },
        });
        const main: ISeriesApi<SeriesType> = isLine
            ? chart.addSeries(BaselineSeries, {
                baseValue: { type: 'price', price: ct.reference > 0 ? ct.reference : 0 },
                topLineColor: c.up,
                topFillColor1: c.upVol,
                topFillColor2: 'transparent',
                bottomLineColor: c.down,
                bottomFillColor1: 'transparent',
                bottomFillColor2: c.downVol,
                lineWidth: 2,
                priceFormat,
            })
            : chart.addSeries(CandlestickSeries, {
                upColor: c.up,
                downColor: c.down,
                borderUpColor: c.up,
                borderDownColor: c.down,
                wickUpColor: c.up,
                wickDownColor: c.down,
                priceFormat,
            });
        const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        // 走勢：均價線（指數沒有成交量，不畫）
        const avgSeries = isLine && !isIndex
            ? chart.addSeries(LineSeries, {
                color: AVG_COLOR,
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
                priceFormat,
            })
            : null;
        chartRef.current = chart;
        mainRef.current = main;
        mainPaneHeightRef.current = null;

        let cancelled = false;
        let loaded = false;
        let bars: Candle[] = [];
        let win: SessionWindow | null = null;
        let dirtyFrom = -1;
        let shownReady = false;
        /** 已套用過歷史（之後的重抓保留可見範圍） */
        let shownHistory = false;
        /** 走勢：目前時段的累計量（缺口偵測） */
        let cumV = 0;
        /** K 線：上一筆成交的累計量（缺口偵測） */
        let lastTotal: number | null = null;
        /** 有歷史查詢進行中；pendingRefresh＝進行中時又被要求重抓（回前景） */
        let busy = false;
        let pendingRefresh = false;
        let builtSeq = resumeSeqRef.current;
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        let raf1: number | null = null;
        let raf2: number | null = null;
        // 走勢：均價（與 bars 同索引；NaN＝沒有）、估算用的累計值、當日最高最低
        let avgs: number[] = [];
        let avgCumV = 0;
        let avgCumPV = 0;
        let hiLo: { high: number; low: number } | null = null;
        let hiLine: IPriceLine | null = null;
        let loLine: IPriceLine | null = null;
        // K 線：指標
        let inds: IndRuntime[] = [];
        let builtKey: string | null = null;
        let subPanes = 0;
        let indDirtyTime = Infinity;
        let indTimer: ReturnType<typeof setTimeout> | null = null;
        /** 目前追蹤中的十字線資料（null＝顯示最新值） */
        let crossData: Map<unknown, unknown> | null = null;

        const volPoint = (b: Candle) => ({ time: t(b.time), value: b.volume, color: b.close >= b.open ? c.upVol : c.downVol });
        const mainPoint = (b: Candle) => (isLine ? { time: t(b.time), value: b.close } : { time: t(b.time), open: b.open, high: b.high, low: b.low, close: b.close });

        // ---- 圖例 ----
        const seriesValue = (s: ISeriesApi<SeriesType>, fallback: number | undefined): number | undefined => {
            if (!crossData) return fallback;
            const d = crossData.get(s) as { value?: unknown } | undefined;
            return typeof d?.value === 'number' ? d.value : undefined;
        };
        const publishLegend = () => {
            if (cancelled) return;
            const next: LegendEntry[] = [];
            if (isLine) {
                if (avgSeries) {
                    const lastAvg = [...avgs].reverse().find(v => Number.isFinite(v));
                    next.push({ id: 'avg', name: '均價', color: AVG_COLOR, pane: 0, values: [{ label: '', color: AVG_COLOR, text: formatIndicatorValue(seriesValue(avgSeries, lastAvg), precision) }] });
                }
                if (hiLo) {
                    next.push({ id: 'high', name: '最高', color: c.text, pane: 0, values: [{ label: '', color: c.text, text: formatIndicatorValue(hiLo.high, precision) }] });
                    next.push({ id: 'low', name: '最低', color: c.text, pane: 0, values: [{ label: '', color: c.text, text: formatIndicatorValue(hiLo.low, precision) }] });
                }
            } else {
                for (const r of inds) {
                    const single = r.outputs.length === 1;
                    next.push({
                        id: r.item.id,
                        name: indicatorLabel(r.item),
                        color: r.outputs[0]?.color ?? c.text,
                        pane: r.pane,
                        values: r.outputs.map(o => ({ label: single ? '' : o.label, color: o.color, text: formatIndicatorValue(seriesValue(o.series, o.last), r.decimals) })),
                    });
                }
            }
            setLegend(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        };

        // 委託線標籤（HTML 按鈕）跟著價格座標走；副圖圖例跟著自己的 pane：資料或可見範圍變動後的下一個畫面重新定位
        const layoutLabels = () => {
            raf1 = raf2 = null;
            if (cancelled) return;
            const height = host.clientHeight;
            let mainH = height - 24; // 底部留給時間軸
            const tops: number[] = [];
            if (subPanes > 0) {
                try {
                    const panes = chart.panes();
                    let acc = 0;
                    for (let i = 0; i < panes.length; i++) {
                        tops.push(acc);
                        acc += (panes[i]!.getHeight() || 0) + 1; // pane 分隔線 1px
                    }
                    const h0 = panes[0]?.getHeight();
                    if (h0 && h0 > 0) mainH = h0;
                } catch {
                    // pane API 差異不能讓圖表掛掉
                }
            }
            mainPaneHeightRef.current = subPanes > 0 ? mainH : null;
            const next: OrderLabel[] = [];
            for (const l of linesRef.current) {
                if (!l.tradeId) continue;
                const y = main.priceToCoordinate(l.price);
                if (y === null || y < 0 || y > mainH) continue;
                next.push({ key: l.key, tradeId: l.tradeId, label: l.label, buy: l.kind === 'order-buy', y: Math.round(y) });
            }
            setOrderLabels(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
            setPaneTops(prev => (JSON.stringify(prev) === JSON.stringify(tops) ? prev : tops));
        };
        const scheduleLayout = () => {
            if (raf1 !== null || raf2 !== null || typeof requestAnimationFrame !== 'function') return;
            raf1 = requestAnimationFrame(() => {
                raf1 = null;
                raf2 = requestAnimationFrame(layoutLabels);
            });
        };
        layoutRef.current = scheduleLayout;

        // ---- 指標（K 線） ----
        const indPoint = (o: IndOutput, p: IndicatorPoint) => (o.histogram
            ? { time: t(p.time), value: p.value!, color: o.signed ? (p.value! >= 0 ? c.upVol : c.downVol) : o.color }
            : { time: t(p.time), value: p.value! });
        const lastDefined = (pts: IndicatorPoint[]) => {
            for (let i = pts.length - 1; i >= 0; i--) if (pts[i]!.value !== undefined && Number.isFinite(pts[i]!.value)) return pts[i]!.value;
            return undefined;
        };
        /** full：整段 setData；否則只 update 時間 ≥ indDirtyTime 的點 */
        const computeIndicators = (full: boolean) => {
            if (indTimer !== null && full) {
                clearTimeout(indTimer);
                indTimer = null;
            }
            const from = indDirtyTime;
            indDirtyTime = Infinity;
            for (const r of inds) {
                let out: Record<string, IndicatorPoint[]>;
                try {
                    out = r.def.compute(bars, r.params);
                } catch {
                    continue; // 參數組合有問題不能讓圖表掛掉
                }
                for (const o of r.outputs) {
                    const pts = out[o.key] ?? [];
                    o.last = lastDefined(pts);
                    try {
                        if (full) {
                            o.series.setData(pts.map(p => (p.value === undefined || !Number.isFinite(p.value) ? { time: t(p.time) } : indPoint(o, p))));
                        } else {
                            let i = pts.length;
                            while (i > 0 && pts[i - 1]!.time >= from) i--;
                            for (; i < pts.length; i++) {
                                const p = pts[i]!;
                                if (p.value !== undefined && Number.isFinite(p.value)) o.series.update(indPoint(o, p));
                            }
                        }
                    } catch {
                        // 早於序列尾端的更新會被拒絕：下次重新載入時重建
                    }
                }
            }
            publishLegend();
        };
        const flushIndicators = () => {
            indTimer = null;
            if (cancelled || indDirtyTime === Infinity) return;
            computeIndicators(false);
        };
        const removeIndicators = () => {
            for (const r of inds) {
                for (const o of r.outputs) {
                    try { chart.removeSeries(o.series); } catch { /* 已隨圖表移除 */ }
                }
            }
            inds = [];
            try {
                for (let i = chart.panes().length - 1; i >= 1; i--) chart.removePane(i);
            } catch {
                // pane API 差異不能讓圖表掛掉
            }
        };
        const buildIndicators = (key: string) => {
            if (cancelled || builtKey === key) return;
            builtKey = key;
            const s = settingsRef.current;
            try { vol.applyOptions({ visible: isLine || s.volume }); } catch { /* 舊版選項 */ }
            removeIndicators();
            subPanes = 0;
            if (!isLine) {
                let paneIdx = 1;
                for (const item of s.items) {
                    const def = DEF_BY_TYPE.get(item.type);
                    if (!def) continue;
                    const pane = def.category === 'pane' ? paneIdx++ : 0;
                    const params: Record<string, number> = {};
                    for (const p of def.params) params[p.key] = item.params[p.key] ?? p.def;
                    const r: IndRuntime = {
                        item,
                        def,
                        params,
                        pane,
                        decimals: pane === 0 ? precision : def.type === 'obv' ? 0 : 2,
                        outputs: [],
                    };
                    const fmt = pane === 0 ? priceFormat : def.type === 'obv' ? { type: 'volume' as const } : { type: 'price' as const, precision: 2, minMove: 0.01 };
                    for (const o of def.outputs) {
                        const color = indicatorOutputColor(item, def, o, c);
                        const common = { priceLineVisible: false, lastValueVisible: false, priceFormat: fmt };
                        let series: ISeriesApi<SeriesType>;
                        if (o.kind === 'histogram') {
                            series = chart.addSeries(HistogramSeries, { ...common, color }, pane);
                        } else {
                            series = chart.addSeries(LineSeries, {
                                ...common,
                                color,
                                lineWidth: o.width ?? 1,
                                lineStyle: o.kind === 'dashed' ? LineStyle.Dashed : LineStyle.Solid,
                                crosshairMarkerVisible: false,
                                ...(o.kind === 'points' ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 } : {}),
                            }, pane);
                        }
                        r.outputs.push({ key: o.key, label: o.label, series, color, histogram: o.kind === 'histogram', signed: !!o.signed, last: undefined });
                    }
                    // 副圖參考線（RSI 30／70、KD 20／80…）
                    const first = r.outputs[0]?.series;
                    if (pane > 0 && first && def.levels) {
                        for (const lv of def.levels) {
                            first.createPriceLine({ price: lv, color: c.grid, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
                        }
                    }
                    inds.push(r);
                }
                subPanes = paneIdx - 1;
                try {
                    const panes = chart.panes();
                    for (let i = 1; i < panes.length; i++) panes[i]!.setHeight(cs.PANE_HEIGHT_PX);
                } catch {
                    // pane API 差異不能讓圖表掛掉
                }
            }
            setPaneCount(subPanes);
            computeIndicators(true);
            scheduleLayout();
        };
        rebuildRef.current = buildIndicators;

        // ---- 走勢：均價、最高最低 ----
        const recomputeLineExtras = () => {
            if (!isLine) return;
            const pts = intradayAverage(bars);
            const byTime = new Map(pts.map(p => [p.time, p.value]));
            avgs = bars.map(b => byTime.get(b.time) ?? NaN);
            avgCumV = 0;
            avgCumPV = 0;
            for (const b of bars) {
                if (b.volume > 0) {
                    avgCumV += b.volume;
                    avgCumPV += ((b.high + b.low + b.close) / 3) * b.volume;
                }
            }
            hiLo = dayHighLow(bars);
        };
        const applyHiLoLines = () => {
            if (!isLine) return;
            if (!hiLo) {
                for (const pl of [hiLine, loLine]) if (pl) try { main.removePriceLine(pl); } catch { /* 已移除 */ }
                hiLine = loLine = null;
                return;
            }
            const opts = (price: number, title: string) => ({ price, color: c.text, lineWidth: 1 as const, lineStyle: LineStyle.Dotted, lineVisible: false, axisLabelVisible: true, title });
            if (hiLine) hiLine.applyOptions({ price: hiLo.high });
            else hiLine = main.createPriceLine(opts(hiLo.high, '最高'));
            if (loLine) loLine.applyOptions({ price: hiLo.low });
            else loLine = main.createPriceLine(opts(hiLo.low, '最低'));
        };

        const applyAll = () => {
            main.setData(bars.map(mainPoint));
            vol.setData(bars.map(volPoint));
            if (isLine) {
                recomputeLineExtras();
                avgSeries?.setData(bars.map((b, i) => (Number.isFinite(avgs[i]) ? { time: t(b.time), value: avgs[i]! } : { time: t(b.time) })));
                applyHiLoLines();
                publishLegend();
            } else {
                indDirtyTime = Infinity;
                computeIndicators(true);
            }
            scheduleLayout();
        };

        const flush = () => {
            flushTimer = null;
            if (cancelled || dirtyFrom < 0) return;
            if (bars.length > MAX_CHART_BARS + 200) {
                bars = capBars(bars);
                dirtyFrom = -1;
                applyAll();
                return;
            }
            const from = dirtyFrom;
            try {
                for (let i = from; i < bars.length; i++) {
                    const b = bars[i]!;
                    main.update(mainPoint(b));
                    vol.update(volPoint(b));
                    if (avgSeries && Number.isFinite(avgs[i])) avgSeries.update({ time: t(b.time), value: avgs[i]! });
                }
            } catch {
                // 早於序列尾端的更新會被拒絕：不讓畫面掛掉，下次重新載入時重建
            }
            dirtyFrom = -1;
            if (isLine) {
                const prev = hiLo ? `${hiLo.high}|${hiLo.low}` : '';
                for (let i = from; i < bars.length; i++) {
                    const b = bars[i]!;
                    hiLo = hiLo ? { high: Math.max(hiLo.high, b.high), low: Math.min(hiLo.low, b.low) } : { high: b.high, low: b.low };
                }
                if ((hiLo ? `${hiLo.high}|${hiLo.low}` : '') !== prev) applyHiLoLines();
                publishLegend();
            } else if (inds.length > 0) {
                // 指標節流：不每筆成交全部重算
                indDirtyTime = Math.min(indDirtyTime, bars[from]?.time ?? Infinity);
                if (indTimer === null) indTimer = setTimeout(flushIndicators, INDICATOR_FLUSH_MS);
            }
            scheduleLayout();
        };

        const sumVolume = () => bars.reduce((sum, b) => sum + b.volume, 0);

        /** 套用一份歷史：保留比歷史尾端新的即時 K 棒；已顯示過時保留可見範圍（以距離最新一根的位置） */
        const applyHistory = (raw: Candle[]) => {
            const ts = chart.timeScale();
            const prevLen = bars.length;
            const range = shownHistory && prevLen > 0 ? ts.getVisibleLogicalRange() : null;
            let live = bars;
            let next: Candle[];
            if (isLine) {
                const nextWin = pickIntradayWindow(ct.security_type, raw.map(b => b.time), 'auto', nowWallClockUtc());
                if (!win || win.start !== nextWin.start) live = []; // 換時段：舊時段的即時點不帶過去
                win = nextWin;
                next = intradayBars(raw, nextWin, CLOSE_GRACE);
            } else {
                next = aggregate(raw, minutes);
            }
            const tail = next.length ? next[next.length - 1]!.time : -Infinity;
            for (const b of live) if (b.time > tail) next.push({ ...b });
            bars = isLine ? next : capBars(next);
            cumV = sumVolume();
            dirtyFrom = -1;
            loaded = true;
            applyAll();
            if (range && live.length > 0) {
                const shift = bars.length - prevLen;
                ts.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
            } else if (isLine) ts.fitContent();
            else if (bars.length > INITIAL_VISIBLE_BARS) ts.setVisibleLogicalRange({ from: bars.length - INITIAL_VISIBLE_BARS, to: bars.length + 2 });
            else ts.fitContent();
            shownHistory = true;
            shownReady = bars.length > 0;
            setStatus(shownReady ? 'ready' : 'empty');
        };

        /**
         * 取歷史。mode：
         * - cache：沿用既有 revision（不改新鮮度紀錄）
         * - initial：新 revision，失敗顯示「載入失敗」
         * - refresh：新 revision 背景重抓，失敗保留目前畫面與上次成功的紀錄
         */
        const load = (revision: number, mode: 'cache' | 'initial' | 'refresh'): Promise<boolean> => {
            busy = true;
            const prev = getHistoryEntry(code, period);
            if (mode !== 'cache') setHistoryEntry(code, period, { revision, at: Date.now(), resumeSeq: resumeSeqRef.current, failed: false });
            if (mode === 'initial') setStatus('loading');
            const { start, end } = chartQueryRange(period, ct.security_type);
            return fetchChartHistory(ct, start, end, { timeoutMs: 30_000, revision })
                .then(
                    k => {
                        if (cancelled) return false;
                        applyHistory(kbarsToCandles(k));
                        return true;
                    },
                    () => {
                        // 新鮮度紀錄不論元件是否還在都要更新：失敗的 revision 不再被沿用
                        const cur = getHistoryEntry(code, period);
                        if (cur && cur.revision === revision) {
                            if (mode === 'refresh' && prev && !prev.failed) setHistoryEntry(code, period, prev);
                            else setHistoryEntry(code, period, { ...cur, failed: true });
                        }
                        if (cancelled || mode === 'refresh') return false;
                        // 走勢載入失敗時仍以目前時段接即時成交
                        if (isLine && !win) win = sessionWindowFor(ct.security_type, nowWallClockUtc());
                        loaded = true;
                        setStatus('error');
                        return false;
                    },
                )
                .finally(() => {
                    busy = false;
                    if (pendingRefresh && !cancelled) {
                        pendingRefresh = false;
                        void load(nextChartHistoryRevision(), 'refresh');
                    }
                });
        };

        /** 缺口或換時段：節流後背景重抓（不重建圖表） */
        const requestReload = () => {
            if (busy || Date.now() - lastReloadAt.current < GAP_RELOAD_MIN_MS) return;
            lastReloadAt.current = Date.now();
            void load(nextChartHistoryRevision(), 'refresh');
        };
        retryRef.current = () => {
            if (!busy) void load(nextChartHistoryRevision(), 'initial');
        };
        resumeRefreshRef.current = seq => {
            if (cancelled || seq === builtSeq) return;
            builtSeq = seq;
            if (busy) pendingRefresh = true;
            else void load(nextChartHistoryRevision(), 'refresh');
        };

        const ingest = (price: number, tickTime: number, volume: number, total: number | null, sim: boolean, tickAvg?: number) => {
            if (!loaded || cancelled || !Number.isFinite(tickTime)) return;
            let time: number;
            if (isLine) {
                if (!win) return;
                if (tickTime > win.end + CLOSE_GRACE) {
                    // 已進入下一個時段（例如日盤收盤後夜盤開盤；試撮也算）：重新挑時段
                    if (sessionWindowFor(ct.security_type, tickTime).start !== win.start) requestReload();
                    return;
                }
                if (sim || !Number.isFinite(price) || price <= 0) return;
                time = tickBucket(win, tickTime);
                const last = bars[bars.length - 1];
                // 斷圖超過 3 分鐘：累計量顯示真的漏量（回前景、斷線）才補抓；冷門商品幾分鐘一筆是常態
                if (last && time > last.time + LINE_GAP_SECONDS && (total === null || total > cumV + volume)) requestReload();
            } else {
                if (sim || !Number.isFinite(price) || price <= 0) return;
                time = liveBarTime(minutes, tickTime);
                const last = bars[bars.length - 1];
                // 歷史尾端與即時之間斷層超過 3 根，且累計量顯示漏量（或還不知道）→ 補抓
                if (last && minutes < 1440 && time - last.time > minutes * 60 * 3
                    && (total === null || lastTotal === null || total > lastTotal + volume)) requestReload();
                if (total !== null) lastTotal = total;
            }
            const last = bars[bars.length - 1];
            if (!last || time > last.time) {
                bars.push({ time, open: price, high: price, low: price, close: price, volume });
                if (dirtyFrom < 0) dirtyFrom = bars.length - 1;
            } else if (time === last.time) {
                last.high = Math.max(last.high, price);
                last.low = Math.min(last.low, price);
                last.close = price;
                last.volume += volume;
                if (dirtyFrom < 0) dirtyFrom = bars.length - 1;
            } else {
                return; // 比最後一根還舊的成交不回頭改
            }
            cumV += volume;
            if (isLine && avgSeries) {
                // 均價：成交帶交易所均價就用它，否則以累計成交金額／量估算
                if (volume > 0) {
                    avgCumV += volume;
                    avgCumPV += price * volume;
                }
                const v = tickAvg !== undefined && Number.isFinite(tickAvg) && tickAvg > 0 ? tickAvg : avgCumV > 0 ? avgCumPV / avgCumV : NaN;
                avgs[bars.length - 1] = v;
            }
            if (!shownReady) {
                shownReady = true;
                setStatus('ready');
            }
            if (flushTimer === null) flushTimer = setTimeout(flush, CHART_FLUSH_MS);
        };
        ingestRef.current = ingest;

        chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleLayout);
        chart.timeScale().subscribeSizeChange(scheduleLayout);

        // 十字線：長按追蹤時記錄價格（只在主圖）；圖例顯示該根的值
        chart.subscribeCrosshairMove(param => {
            if (trackingRef.current && param.point) {
                if (param.paneIndex !== undefined && param.paneIndex > 0) crossPriceRef.current = null;
                else {
                    const p = main.coordinateToPrice(param.point.y);
                    if (p !== null && Number.isFinite(p)) crossPriceRef.current = p;
                }
            }
            const next = param.time !== undefined && param.seriesData ? (param.seriesData as Map<unknown, unknown>) : null;
            if (next === null && crossData === null) return;
            crossData = next;
            publishLegend();
        });

        // 即時成交（只取目前商品；連續月別名由 stream 以別名代碼再送一次）
        const offTick = isIndex ? () => undefined : onAnyTick(tk => {
            if (tk.code !== code || tk.intraday_odd) return;
            const total = Number(tk.total_volume);
            const avg = tk.avg_price === undefined ? undefined : Number(tk.avg_price);
            ingest(Number(tk.close), wallClockToUtc(`${tk.date}T${tk.time}`), tk.volume, Number.isFinite(total) ? total : null, tk.simtrade === true, avg);
        });

        setStatus('loading');
        setPick(null);
        setOrderLabels([]);
        setLegend([]);
        setPaneCount(0);
        setChartGen(g => g + 1);
        const plan = planHistory(getHistoryEntry(code, period), Date.now(), resumeSeqRef.current);
        if (plan.kind === 'fetch') void load(nextChartHistoryRevision(), 'initial');
        else {
            // 先顯示快取；過期（逾 60 秒或回前景過）再背景重抓
            void load(plan.revision, 'cache').then(ok => {
                if (ok && plan.refresh && !cancelled && !busy) void load(nextChartHistoryRevision(), 'refresh');
            });
        }

        return () => {
            cancelled = true;
            offTick();
            ingestRef.current = null;
            layoutRef.current = () => undefined;
            rebuildRef.current = () => undefined;
            retryRef.current = () => undefined;
            resumeRefreshRef.current = () => undefined;
            if (flushTimer !== null) clearTimeout(flushTimer);
            if (indTimer !== null) clearTimeout(indTimer);
            if (typeof cancelAnimationFrame === 'function') {
                if (raf1 !== null) cancelAnimationFrame(raf1);
                if (raf2 !== null) cancelAnimationFrame(raf2);
            }
            chartRef.current = null;
            mainRef.current = null;
            mainPaneHeightRef.current = null;
            chart.remove();
        };
        // 合約、配色、resumeSeq、指標設定以 ref 讀取；只有商品、週期、配色鍵才重建
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [code, secType, period, themeK, isLine]);

    // 指標設定改變（或圖表重建後）：在既有圖表上重建指標 series
    useEffect(() => { rebuildRef.current(settingsKey); }, [settingsKey, chartGen]);

    // 回前景（resumeSeq 改變）：背景重抓歷史，補上背景期間缺的一段
    useEffect(() => { resumeRefreshRef.current(resumeSeq); }, [resumeSeq]);

    // 走勢的參考價基準線：合約資訊晚到或更新時套用，不必重建圖表
    useEffect(() => {
        if (!isLine || !mainRef.current || !(reference > 0)) return;
        mainRef.current.applyOptions({ baseValue: { type: 'price', price: reference } });
    }, [isLine, reference, chartGen]);

    // 指數沒有 tick 串流：用 quote_idx 更新最後一根
    const index = useQuote(secType === 'IND' ? code : null, { narrow: true })?.index;
    useEffect(() => {
        if (!index) return;
        ingestRef.current?.(Number(index.close), wallClockToUtc(`${index.date}T${index.time}`), 0, null, false);
    }, [index]);

    // ---- 水平線 ----
    const linesKey = priceLinesKey(lines);
    useEffect(() => {
        const series = mainRef.current;
        if (!series) return;
        const created: IPriceLine[] = [];
        for (const l of linesRef.current) {
            const st = LINE_STYLE[l.kind];
            created.push(series.createPriceLine({
                price: l.price,
                color: lineColor(l.kind, colorsRef.current),
                lineWidth: st.lineWidth,
                lineStyle: st.lineStyle,
                axisLabelVisible: true,
                title: l.label,
            }));
        }
        layoutRef.current();
        return () => {
            for (const pl of created) {
                try { series.removePriceLine(pl); } catch { /* 圖表已移除 */ }
            }
        };
    }, [linesKey, chartGen]);

    // ---- 全螢幕 ----

    // 手機轉橫向自動進入；轉回直向時清掉「這次橫向已退出」
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
        const onChange = () => {
            const a = shouldAutoFullscreen(currentOrientationEnv());
            setAutoFs(a);
            if (!a) setAutoDismissed(false);
        };
        window.addEventListener('resize', onChange);
        window.addEventListener('orientationchange', onChange);
        const so = typeof screen !== 'undefined' ? (screen as { orientation?: EventTarget }).orientation : undefined;
        try { so?.addEventListener?.('change', onChange); } catch { /* 舊瀏覽器 */ }
        return () => {
            window.removeEventListener('resize', onChange);
            window.removeEventListener('orientationchange', onChange);
            try { so?.removeEventListener?.('change', onChange); } catch { /* 舊瀏覽器 */ }
        };
    }, []);

    // 使用者從系統（返回鍵）離開 Fullscreen API 時，一併離開 CSS 全螢幕
    useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
        const onFsChange = () => {
            if (apiFsRef.current && !document.fullscreenElement) {
                apiFsRef.current = false;
                setManualFs(false);
            }
        };
        document.addEventListener('fullscreenchange', onFsChange);
        return () => {
            document.removeEventListener('fullscreenchange', onFsChange);
            if (apiFsRef.current && document.fullscreenElement) {
                apiFsRef.current = false;
                void document.exitFullscreen?.().catch(() => undefined);
            }
        };
    }, []);

    // 尺寸改變：autoSize 會跟著容器 resize；委託線標籤與副圖圖例重新定位
    useEffect(() => { layoutRef.current(); }, [fullscreen, paneCount]);

    const enterFullscreen = () => {
        setManualFs(true);
        setAutoDismissed(false);
        // 對 <html> 而不是圖表元素：下單、指標等底部面板在圖表之外，仍要看得到
        try {
            const root = typeof document !== 'undefined' ? document.documentElement : null;
            if (root && document.fullscreenEnabled && !document.fullscreenElement && typeof root.requestFullscreen === 'function') {
                apiFsRef.current = true;
                void root.requestFullscreen().catch(() => { apiFsRef.current = false; });
            }
        } catch {
            apiFsRef.current = false;
        }
    };
    const exitFullscreen = () => {
        setManualFs(false);
        if (autoFs) setAutoDismissed(true);
        if (apiFsRef.current) {
            apiFsRef.current = false;
            try {
                if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
            } catch { /* 不支援 */ }
        }
    };

    // ---- 長按 → 追蹤模式 → 放開後浮出「以 X 買進／賣出」 ----

    const clearPress = () => {
        if (pressRef.current) clearTimeout(pressRef.current.timer);
        pressRef.current = null;
    };
    useEffect(() => clearPress, []);
    useEffect(() => { setPick(null); }, [code, period]);

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        clearPress();
        trackingRef.current = false;
        const x = e.clientX;
        const y = e.clientY;
        const timer = setTimeout(() => {
            const host = hostRef.current;
            const series = mainRef.current;
            if (!host || !series) return;
            trackingRef.current = true;
            const rect = host.getBoundingClientRect();
            const mainH = mainPaneHeightRef.current;
            // 落在副圖：座標不是價格，不選價
            const p = mainH !== null && y - rect.top > mainH ? null : series.coordinateToPrice(y - rect.top);
            crossPriceRef.current = p !== null && Number.isFinite(p) ? p : null;
            setPick(null);
            try { navigator.vibrate?.(10); } catch { /* iOS 不支援 */ }
        }, LONG_PRESS_MS);
        pressRef.current = { x, y, timer };
    };
    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const press = pressRef.current;
        if (!press || trackingRef.current) return;
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP_PX) clearPress();
    };
    const onPointerEnd = () => {
        clearPress();
        if (!trackingRef.current) return;
        trackingRef.current = false;
        const raw = crossPriceRef.current;
        crossPriceRef.current = null;
        if (raw === null) return;
        const price = roundToTick(contractRef.current, raw);
        if (Number.isFinite(price) && price > 0) setPick(price);
    };

    const pickText = pick !== null ? formatToTick(contract, pick) : '';
    const choose = (action: 'Buy' | 'Sell') => {
        if (pick === null) return;
        openTicket({ code, action, price: pick, source: 'chart' });
        setPick(null);
    };

    const tradable = secType !== 'IND' && !contract.combo;
    const mainLegend = legend.filter(l => l.pane === 0 || paneTops[l.pane] === undefined);
    const paneLegends = legend.filter(l => l.pane > 0 && paneTops[l.pane] !== undefined);
    const frameClass = fullscreen ? cs.frameFullscreen : cs.frame[(Math.min(paneCount, 2)) as 0 | 1 | 2];
    const periodLabel = CHART_PERIODS.find(p => p.key === period)?.label ?? '';

    const renderLegend = (entries: LegendEntry[], top?: number) => (
        <div className={cs.legend} style={top !== undefined ? { top: `${top + 4}px` } : undefined} data-testid='chart-legend' aria-live='off'>
            {entries.map(l => (
                <span key={l.id} className={cs.legendItem}>
                    <span className={cs.legendName} style={{ color: l.color }}>{l.name}</span>
                    {l.values.map((v, i) => (
                        <span key={i}>
                            {' '}
                            {v.label && <span style={{ color: v.color }}>{v.label} </span>}
                            <span className={cs.legendValue}>{v.text}</span>
                        </span>
                    ))}
                </span>
            ))}
        </div>
    );

    return (
        <div
            className={fullscreen ? cs.rootFullscreen : cs.root}
            data-testid='trade-chart-root'
            data-fullscreen={fullscreen ? 'true' : 'false'}
            role={fullscreen ? 'dialog' : undefined}
            aria-label={fullscreen ? `${contract.name || code} 全螢幕圖表` : undefined}
        >
            {fullscreen && (
                <div className={cs.fsBar} data-testid='chart-fs-bar'>
                    <span className={cs.fsTitle}>{contract.name || code}</span>
                    <div className={cs.fsPeriods} role='group' aria-label='圖表週期'>
                        {onPeriodChange
                            ? CHART_PERIODS.map(p => (
                                <button key={p.key} type='button' className={cs.fsPeriod} aria-pressed={period === p.key} onClick={() => onPeriodChange(p.key)}>
                                    {p.label}
                                </button>
                            ))
                            : <span className={cs.fsTitle}>{periodLabel}</span>}
                    </div>
                    <button type='button' className={cs.toolButton} onClick={() => setSheetOpen(true)} data-testid='chart-indicators'>指標</button>
                    <button type='button' className={cs.exitButton} onClick={exitFullscreen} data-testid='chart-fs-exit'>退出全螢幕</button>
                </div>
            )}
            <div
                className={frameClass}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
                onContextMenu={e => e.preventDefault()}
                data-allow-pinch='true'
                data-testid='trade-chart'
            >
                <div ref={hostRef} className={styles.chartHost} />
                {mainLegend.length > 0 && renderLegend(mainLegend)}
                {paneLegends.map(l => <div key={l.id}>{renderLegend([l], paneTops[l.pane])}</div>)}
                {orderLabels.map(l => (
                    <button
                        key={l.key}
                        type='button'
                        className={styles.orderLabel}
                        style={{ top: `${l.y}px` }}
                        onPointerDown={e => e.stopPropagation()}
                        onClick={() => openOrderAction(l.tradeId, 'menu')}
                        aria-label={`我的委託 ${l.label}，開啟改價／減量／刪單`}
                        data-testid='chart-order-label'
                    >
                        <span className={styles.orderPill[l.buy ? 'buy' : 'sell']}>{l.label}</span>
                    </button>
                ))}
                {status !== 'ready' && (
                    <div className={styles.chartOverlay}>
                        {status === 'loading' && <span>載入中…</span>}
                        {status === 'empty' && <span>{isLine ? '此時段尚無成交' : '此區間沒有 K 線資料'}</span>}
                        {status === 'error' && (
                            <>
                                <span>歷史資料載入失敗</span>
                                <button
                                    type='button'
                                    className={`${styles.toggle} ${styles.chartOverlayAction}`}
                                    onClick={() => retryRef.current()}
                                >
                                    重新載入
                                </button>
                            </>
                        )}
                    </div>
                )}
                {pick !== null && (
                    <div className={styles.pickBar} role='dialog' aria-label={`以 ${pickText} 下單`} data-testid='chart-pick'>
                        <button type='button' className={styles.pickButton.buy} onClick={() => choose('Buy')}>以 {pickText} 買進</button>
                        <button type='button' className={styles.pickButton.sell} onClick={() => choose('Sell')}>以 {pickText} 賣出</button>
                        <button type='button' className={styles.pickButton.cancel} onClick={() => setPick(null)} aria-label='取消'>取消</button>
                    </div>
                )}
            </div>
            {!fullscreen && (
                <div className={cs.toolRow}>
                    <p className={cs.toolNote}>
                        {isLine ? '長按圖表選價位，放開後可帶價開啟下單面板' : period === '1D' ? '日 K 由 1 分 K 聚合，未含除權息調整' : '長按圖表選價位'}
                    </p>
                    <button type='button' className={cs.toolButton} onClick={() => setSheetOpen(true)} data-testid='chart-indicators'>指標</button>
                    <button type='button' className={cs.toolButton} onClick={enterFullscreen} data-testid='chart-fs-enter'>全螢幕</button>
                </div>
            )}
            {fullscreen && tradable && (
                <div className={cs.fsTradeRow}>
                    <button type='button' className={cs.fsTradeButton.buy} onClick={() => openTicket({ code, action: 'Buy', source: 'button' })} data-testid='chart-fs-buy'>買 進</button>
                    <button type='button' className={cs.fsTradeButton.sell} onClick={() => openTicket({ code, action: 'Sell', source: 'button' })} data-testid='chart-fs-sell'>賣 出</button>
                </div>
            )}
            <IndicatorSheet open={sheetOpen} onClose={() => setSheetOpen(false)} lineMode={isLine} />
        </div>
    );
}
