// src/mobile/components/trade-chart.tsx — 手機交易圖表（lightweight-charts v5；規格 §6.2、§9.3）
//
// - 週期：走勢（BaselineSeries，以參考價為基準線）或 K 線（1／5／15／60 分、日）＋成交量＋MA(5／20)。
// - 資料：fetchChartHistory() → kbarsToCandles() → aggregate()（走勢改挑當日時段）；最多 5,000 根；
//   最後一根由即時成交（onAnyTick；指數用 quote_idx）更新，每 CHART_FLUSH_MS 合併重畫一次。
// - 水平線：由 chart-model.ts 的 PriceLineSpec 畫出（委託、成本、漲跌停、參考價）。
// - 互動：單指拖曳平移、雙指縮放；長按進入追蹤模式（trackingMode），十字線價以 roundToTick 取整，
//   放開後浮出「以 X 買進／賣出」→ openTicket({ source: 'chart' })。**只開下單面板，絕不直接送單**。
//   點委託線標籤 → openOrderAction(tradeId, 'menu')。不支援拖曳委託線改價（規格 R7）。

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
import { fetchChartHistory, nextChartHistoryRevision } from '../../lib/chart-history';
import { CLOSE_GRACE, pickIntradayWindow, sessionWindowFor, tickBucket, type SessionWindow } from '../../lib/intraday-session';
import { onAnyTick } from '../../lib/stream';
import { getChartColors, themeKey, useThemeSettings, type ChartColors } from '../../lib/theme-store';
import type { ContractInfo } from '../../lib/types/contract';
import type { Candle } from '../../lib/types/market';
import { aggregate, kbarsToCandles, nowWallClockUtc, wallClockToUtc } from '../../lib/utils/kbars';
import { formatToTick, roundToTick, tickDecimals, tickSizeFor } from '../../lib/utils/ticksize';
import { intradayBars, lastMovingAverage, liveBarTime, movingAverage, priceLinesKey, type PriceLineSpec } from '../lib/chart-model';
import { capBars, chartQueryRange, MAX_CHART_BARS, periodDef, type ChartPeriod } from '../lib/chart-ranges';
import { openOrderAction, openTicket } from '../lib/mobile-store';
import * as styles from '../styles/trade.css';

/** 即時成交合併重畫的間隔（行情 store 的 QUOTE_FLUSH_MS 未匯出，自行節流） */
export const CHART_FLUSH_MS = 100;
/** 長按進入追蹤模式的時間與容許位移 */
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP_PX = 10;
/** 歷史與即時之間出現斷層時補抓歷史的最短間隔 */
const GAP_RELOAD_MIN_MS = 120_000;
/** K 線模式初次顯示的根數（手機寬度） */
const INITIAL_VISIBLE_BARS = 80;
const MA_PERIODS = [5, 20] as const;
const MA_COLORS = ['#e0a43c', '#8e7cf0'] as const;

type Status = 'loading' | 'ready' | 'empty' | 'error';

interface OrderLabel {
    key: string;
    tradeId: string;
    label: string;
    buy: boolean;
    y: number;
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

const t = (time: number) => time as UTCTimestamp;

export function TradeChart({ code, contract, period, lines }: { code: string; contract: ContractInfo; period: ChartPeriod; lines: readonly PriceLineSpec[] }) {
    const theme = useThemeSettings();
    const themeK = themeKey(theme);
    const colors = useMemo(() => getChartColors(theme), [themeK]); // eslint-disable-line react-hooks/exhaustive-deps
    const colorsRef = useRef(colors);
    colorsRef.current = colors;
    const contractRef = useRef(contract);
    contractRef.current = contract;
    const linesRef = useRef(lines);
    linesRef.current = lines;

    const hostRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
    const ingestRef = useRef<((price: number, tickTime: number, volume: number) => void) | null>(null);
    const lastReloadAt = useRef(0);
    const layoutRef = useRef<() => void>(() => undefined);
    // 長按追蹤狀態
    const trackingRef = useRef(false);
    const crossPriceRef = useRef<number | null>(null);
    const pressRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);

    const [status, setStatus] = useState<Status>('loading');
    const [reloadRev, setReloadRev] = useState(0);
    const [chartGen, setChartGen] = useState(0);
    const [orderLabels, setOrderLabels] = useState<OrderLabel[]>([]);
    const [pick, setPick] = useState<number | null>(null);

    const isLine = period === 'line';
    const secType = contract.security_type;
    const reference = contract.reference;

    // ---- 圖表生命週期＋歷史載入＋即時更新（商品、週期、配色、重新載入時整個重建） ----
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const c = colorsRef.current;
        const ct = contractRef.current;
        const minutes = periodDef(period).minutes;
        const tick = tickSizeFor(ct, ct.reference > 0 ? ct.reference : 1);
        const precision = tickDecimals(tick);
        const priceFormat = { type: 'price' as const, precision, minMove: Number((10 ** -precision).toFixed(precision)) };

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
        const maSeries = isLine
            ? []
            : MA_PERIODS.map((_, i) => chart.addSeries(LineSeries, {
                color: MA_COLORS[i],
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
                priceFormat,
            }));
        chartRef.current = chart;
        mainRef.current = main;

        let cancelled = false;
        let loaded = false;
        let bars: Candle[] = [];
        let win: SessionWindow | null = null;
        let dirtyFrom = -1;
        let shownReady = false;
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        let raf1: number | null = null;
        let raf2: number | null = null;

        const volPoint = (b: Candle) => ({ time: t(b.time), value: b.volume, color: b.close >= b.open ? c.upVol : c.downVol });
        const mainPoint = (b: Candle) => (isLine ? { time: t(b.time), value: b.close } : { time: t(b.time), open: b.open, high: b.high, low: b.low, close: b.close });

        // 委託線標籤（HTML 按鈕）跟著價格座標走：資料或可見範圍變動後的下一個畫面重新定位
        const layoutLabels = () => {
            raf1 = raf2 = null;
            if (cancelled) return;
            const height = host.clientHeight;
            const next: OrderLabel[] = [];
            for (const l of linesRef.current) {
                if (!l.tradeId) continue;
                const y = main.priceToCoordinate(l.price);
                // 底部留給時間軸
                if (y === null || y < 0 || y > height - 24) continue;
                next.push({ key: l.key, tradeId: l.tradeId, label: l.label, buy: l.kind === 'order-buy', y: Math.round(y) });
            }
            setOrderLabels(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        };
        const scheduleLayout = () => {
            if (raf1 !== null || raf2 !== null || typeof requestAnimationFrame !== 'function') return;
            raf1 = requestAnimationFrame(() => {
                raf1 = null;
                raf2 = requestAnimationFrame(layoutLabels);
            });
        };
        layoutRef.current = scheduleLayout;

        const applyAll = () => {
            main.setData(bars.map(mainPoint));
            vol.setData(bars.map(volPoint));
            maSeries.forEach((s, i) => s.setData(movingAverage(bars, MA_PERIODS[i]!).map(p => ({ time: t(p.time), value: p.value }))));
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
            try {
                for (let i = dirtyFrom; i < bars.length; i++) {
                    const b = bars[i]!;
                    main.update(mainPoint(b));
                    vol.update(volPoint(b));
                    maSeries.forEach((s, k) => {
                        const n = MA_PERIODS[k]!;
                        const ma = lastMovingAverage(bars.slice(Math.max(0, i + 1 - n), i + 1), n);
                        if (ma) s.update({ time: t(ma.time), value: ma.value });
                    });
                }
            } catch {
                // 早於序列尾端的更新會被拒絕：不讓畫面掛掉，下次重新載入時重建
            }
            dirtyFrom = -1;
            scheduleLayout();
        };

        const requestReload = () => {
            if (Date.now() - lastReloadAt.current < GAP_RELOAD_MIN_MS) return;
            lastReloadAt.current = Date.now();
            setReloadRev(nextChartHistoryRevision());
        };

        const ingest = (price: number, tickTime: number, volume: number) => {
            if (!loaded || cancelled || !Number.isFinite(price) || price <= 0 || !Number.isFinite(tickTime)) return;
            let time: number;
            if (isLine) {
                if (!win) return;
                if (tickTime > win.end + CLOSE_GRACE) {
                    // 已進入下一個時段（例如日盤收盤後夜盤開盤）：重新挑時段
                    if (sessionWindowFor(ct.security_type, tickTime).start !== win.start) requestReload();
                    return;
                }
                time = tickBucket(win, tickTime);
            } else {
                time = liveBarTime(minutes, tickTime);
                const last = bars[bars.length - 1];
                // 歷史尾端與即時之間斷層超過 3 根（快取的舊歷史、上游晚發布）→ 補抓一次
                if (last && minutes < 1440 && time - last.time > minutes * 60 * 3) requestReload();
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
            if (!shownReady) {
                shownReady = true;
                setStatus('ready');
            }
            if (flushTimer === null) flushTimer = setTimeout(flush, CHART_FLUSH_MS);
        };
        ingestRef.current = ingest;

        chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleLayout);
        chart.timeScale().subscribeSizeChange(scheduleLayout);

        // 長按追蹤：只在追蹤中記錄十字線價格
        chart.subscribeCrosshairMove(param => {
            if (!trackingRef.current || !param.point) return;
            const p = main.coordinateToPrice(param.point.y);
            if (p !== null && Number.isFinite(p)) crossPriceRef.current = p;
        });

        // 即時成交（只取目前商品；連續月別名由 stream 以別名代碼再送一次）
        const offTick = ct.security_type === 'IND' ? () => undefined : onAnyTick(tk => {
            if (tk.code !== code || tk.intraday_odd) return;
            ingest(Number(tk.close), wallClockToUtc(`${tk.date}T${tk.time}`), tk.volume);
        });

        setStatus('loading');
        setPick(null);
        setOrderLabels([]);
        setChartGen(g => g + 1);
        const { start, end } = chartQueryRange(period, ct.security_type);
        fetchChartHistory(ct, start, end, { timeoutMs: 30_000, revision: reloadRev })
            .then(k => {
                if (cancelled) return;
                const raw = kbarsToCandles(k);
                if (isLine) {
                    win = pickIntradayWindow(ct.security_type, raw.map(b => b.time), 'auto', nowWallClockUtc());
                    bars = intradayBars(raw, win, CLOSE_GRACE);
                } else {
                    bars = capBars(aggregate(raw, minutes));
                }
                loaded = true;
                applyAll();
                if (isLine) chart.timeScale().fitContent();
                else if (bars.length > INITIAL_VISIBLE_BARS) chart.timeScale().setVisibleLogicalRange({ from: bars.length - INITIAL_VISIBLE_BARS, to: bars.length + 2 });
                else chart.timeScale().fitContent();
                shownReady = bars.length > 0;
                setStatus(shownReady ? 'ready' : 'empty');
            })
            .catch(() => {
                if (cancelled) return;
                // 走勢載入失敗時仍以目前時段接即時成交
                if (isLine) win = sessionWindowFor(ct.security_type, nowWallClockUtc());
                loaded = true;
                setStatus('error');
            });

        return () => {
            cancelled = true;
            offTick();
            ingestRef.current = null;
            layoutRef.current = () => undefined;
            if (flushTimer !== null) clearTimeout(flushTimer);
            if (typeof cancelAnimationFrame === 'function') {
                if (raf1 !== null) cancelAnimationFrame(raf1);
                if (raf2 !== null) cancelAnimationFrame(raf2);
            }
            chartRef.current = null;
            mainRef.current = null;
            chart.remove();
        };
        // 合約、配色以 ref 讀取；只有商品、週期、配色鍵、重新載入才重建
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [code, secType, period, themeK, reloadRev, isLine]);

    // 走勢的參考價基準線：合約資訊晚到或更新時套用，不必重建圖表
    useEffect(() => {
        if (!isLine || !mainRef.current || !(reference > 0)) return;
        mainRef.current.applyOptions({ baseValue: { type: 'price', price: reference } });
    }, [isLine, reference, chartGen]);

    // 指數沒有 tick 串流：用 quote_idx 更新最後一根
    const index = useQuote(secType === 'IND' ? code : null, { narrow: true })?.index;
    useEffect(() => {
        if (!index) return;
        ingestRef.current?.(Number(index.close), wallClockToUtc(`${index.date}T${index.time}`), 0);
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
            const p = series.coordinateToPrice(y - rect.top);
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

    return (
        <div>
            <div
                className={styles.chartWrap}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
                onContextMenu={e => e.preventDefault()}
                data-testid='trade-chart'
            >
                <div ref={hostRef} className={styles.chartHost} />
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
                                    onClick={() => setReloadRev(nextChartHistoryRevision())}
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
            {!isLine && (
                <p className={styles.chartNote}>
                    <span style={{ color: MA_COLORS[0] }}>MA5</span>　<span style={{ color: MA_COLORS[1] }}>MA20</span>
                    {period === '1D' && '　日 K 由 1 分 K 聚合，未含除權息調整'}
                </p>
            )}
            {isLine && <p className={styles.chartNote}>長按圖表選價位，放開後可帶價開啟下單面板</p>}
        </div>
    );
}
