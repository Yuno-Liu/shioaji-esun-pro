// src/mobile/components/trade-chart.tsx — 手機交易圖表（lightweight-charts v5；規格 §6.2、§9.3、Phase 2／3）
//
// - 週期：走勢（BaselineSeries，以參考價為基準線＋均價線＋當日最高最低＋成交量副圖）或
//   K 線（1／5／15／60 分、日）＋成交量（疊在主圖底部 20%）＋使用者自訂的技術指標（lib/mobile-indicators.ts；預設 MA5／MA20）。
// - 走勢成交量：價格下方獨立的副圖（pane 1，高 PANE_HEIGHT_PX，外框同 K 線副圖加高，價格區不縮小），右側為量的座標，
//   左上小標「成交量」＋該分鐘的量。量柱顏色：本分鐘收盤對前一分鐘收盤（第一根對參考價）漲紅跌綠、平盤中性灰，
//   跟著使用者的漲跌配色（ChartColors upVol／downVol，比價格線淡）。指數、量全為 0 或沒有資料時不建副圖（外框維持 0 副圖）；
//   之後有量（例如開盤第一筆成交）才建立。一般模式下外框改變（退出全螢幕、副圖晚建）後把副圖拉回 PANE_HEIGHT_PX
//   （K 線指標副圖同樣適用）；全螢幕依比例分配。
// - 走勢 X 軸固定為整個交易時段（win：股票 09:00–13:30、期貨日盤／夜盤）：隱藏的 axisSeries 在時段每一分鐘放一個
//   空白點（whitespace），時間軸因此是線性的整個時段，線從左往右隨時間長出、右側未到的時段留白；走勢關閉拖移、
//   縮放、滾輪、軸拖曳與雙擊重設（沒有拖移就沒有慣性捲動），fixLeftEdge＋lockVisibleTimeRangeOnResize（不用 fixRightEdge：
//   它把右端鎖在最後一根有資料的點，會切掉右側留白），
//   套用歷史、換時段、尺寸改變時 fitContent。量與買賣力副圖共用同一條時間軸。邏輯位置＝時段內第幾分鐘
//   （logicalOfBar／barAtLogical），沒有成交的分鐘也占位置；輕點吸附到最近的一根。K 線維持可拖移、可縮放。
// - 走勢「漲跌停範圍」（lib/chart-limit-range.ts，模組層狀態，預設自動）：輕點主圖右側價格軸切換，主圖 Y 軸固定為
//   [跌停, 漲停]（主 series 的 autoscaleInfoProvider；均價線不參與），並畫出漲停／跌停線（股票本來就有，期權補畫）；
//   主圖圖例前有「漲跌停範圍」按鈕（aria-pressed），點它回到自動。指數或沒有正數漲跌停時不切換。
// - 走勢副圖指標（股票＋ETF，指標面板「走勢副圖」開啟；lib/line-indicators.ts 設定、lib/line-flow.ts 逐筆彙總）：
//   排在量副圖之後（量固定在 pane 1）。分時買賣力＝每分鐘外盤（正柱，漲色）／內盤（負柱，跌色）＋累積淨買力線
//   （另一個不顯示座標的疊加刻度，否則每分鐘的柱會被壓扁）；大單／小單買賣力＝依單筆成交金額門檻分類的兩條累積淨買線。
//   單位皆為張。圖例平時顯示當日累計，輕點／追蹤時顯示該分鐘（累積線為到該分鐘為止）。開啟時才下載當日逐筆，
//   讀取中、失敗、尚無成交就地寫在圖例。沒有量副圖（沒有成交）時不建這兩個副圖，狀態寫在主圖圖例。
// - 指標：定義與計算重用 src/lib/indicator-defs.ts；主圖疊加用 LineSeries，副圖各自一個 pane，
//   副圖畫參考線（levels）。左上角圖例顯示指標名稱與最新值；長按追蹤時顯示該根的值。
//   即時更新：K 棒每 CHART_FLUSH_MS 合併重畫，指標另以 INDICATOR_FLUSH_MS 節流、只 update 變動的尾端點
//   （不會每筆成交全部重算）；歷史重抓、裁切才整段 setData。
// - 資料：fetchMobileChartHistory()（chart-history-cache.ts；每組只留最新一份，記憶體有上限）→ kbarsToCandles() → aggregate()（走勢改挑當日時段）；最多 5,000 根；
//   最後一根由即時成交（onAnyTick；指數用 quote_idx）更新。試撮（simtrade）揭示價不入圖（與桌面相同），只用來偵測換時段。
// - 歷史新鮮度：chart-history-freshness.ts 依 (code, period) 決定沿用快取、先顯示快取再背景重抓、或換新 revision；
//   ResumeGate 的 resumeSeq 改變（回前景）時背景重抓；走勢與 K 線都有缺口偵測（累計量顯示真的漏量才重抓）。
// - 圖表實例只在商品、週期、配色改變時重建；重抓歷史、改指標設定都沿用既有 chart（不重建），
//   保留可見範圍（以距離最新一根的位置）與長按選價列。
// - 水平線：由 chart-model.ts 的 PriceLineSpec 畫出（委託、成本、漲跌停、參考價）。
// - 互動：單指拖曳平移、雙指縮放；長按進入追蹤模式（trackingMode），十字線價以 roundToTick 取整，
//   放開後浮出「以 X 買進／賣出」→ openTicket({ source: 'chart' })。**只開下單面板，絕不直接送單**。
//   長按成立時 haptic('longPress')（只在 Android 且使用者開啟介面觸覺時）；選價列由圖表底部升起、選完或取消沿原路收回。
//   一般模式下選價列出現時捲到可見範圍（main 的 scroll-padding-bottom 讓出底部 chrome），以免落在交易鍵列／分頁列後面；
//   量測用沒有 transform 的外層（pickAnchor），進場動畫的 translateY 不影響捲動量。全螢幕與收回殘影不捲動。
//   副圖上的十字線不拿來選價（座標不是價格）。點委託線標籤 → openOrderAction(tradeId, 'menu')。
// - 長按選價下單是本裝置設定（lib/mobile-device-settings 的 chartPricePick，帳戶 › 本裝置「圖表長按選價下單」，**預設關**）；
//   以 useSyncExternalStore 讀取，切換後已開著的交易頁立即套用（關閉時順便收起選價列）。走勢／K 線、直向／全螢幕同一規則。
//   關閉時長按只看價格：十字線照樣由程式庫的追蹤模式跟著手指、資訊列顯示該根，放開時釘在放開的那一根（同輕點，不切換、
//   不收起；落在價格軸不切換漲跌停）；不浮出選價列、不呼叫 openTicket、不觸發 haptic('longPress')；工具列提示不提長按選價。
//   點價格軸切換漲跌停範圍、點委託線標籤開委託操作面板不受此設定影響。
// - 輕點（沒拖超過 LONG_PRESS_SLOP_PX、未達 LONG_PRESS_MS、單指、不在按鈕上、落在主圖）：十字線吸附到最近一根並釘住，
//   圖例第一列顯示價格資訊（lib/chart-readout.ts：走勢＝時間、價格、漲跌、漲跌%，基準同走勢基準線的參考價；
//   K 線＝收盤與「較前一根」；兩者都附該根的量「量 1,234」，單位同量的座標，指數不顯示）。再點同一根、按 ✕、開始平移或雙指、換週期／商品／全螢幕時收起。
//   長按追蹤時同一列跟著十字線。**輕點只顯示資訊，不開選價列、不開下單面板**。
//   程式庫在觸控放開、資料更新、滑鼠移動時會自己移動或清除十字線：釘住期間在 crosshairMove 裡放回那一根。
//   資訊列以小 store（useSyncExternalStore）只重繪該列，不重繪整個圖表元件。
//   不支援拖曳委託線改價（規格 R7）。K 線的可互動區加 data-allow-pinch="true"（平台手勢防護略過這一區）；走勢不縮放，不加。
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
    type AutoscaleInfo,
    type IChartApi,
    type IPriceLine,
    type Logical,
    type ISeriesApi,
    type SeriesType,
    type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { useQuote, useStreamStatus } from '../../hooks/use-stream';
import { useResumeGate } from '../hooks/use-resume-gate';
import { nextChartHistoryRevision } from '../../lib/chart-history';
import { DEF_BY_TYPE, type IndicatorDef, type OutputDef } from '../../lib/indicator-defs';
import type { IndicatorPoint } from '../../lib/indicators';
import { CLOSE_GRACE, pickIntradayWindow, sessionWindowFor, tickBucket, type SessionWindow } from '../../lib/intraday-session';
import { onAnyTick } from '../../lib/stream';
import { getChartColors, themeKey, useThemeSettings, type ChartColors } from '../../lib/theme-store';
import type { ContractInfo } from '../../lib/types/contract';
import type { Candle } from '../../lib/types/market';
import { aggregate, kbarsToCandles, nowWallClockUtc, wallClockToUtc } from '../../lib/utils/kbars';
import { roundToTick, tickDecimals, tickSizeFor } from '../../lib/utils/ticksize';
import { formatToTick } from '../lib/num-format';
import { chartReadout, createReadoutStore, type ReadoutStore } from '../lib/chart-readout';
import { currentOrientationEnv, shouldAutoFullscreen } from '../lib/chart-fullscreen';
import { hasLimitRange, setLimitRange, toggleLimitRange, useLimitRange } from '../lib/chart-limit-range';
import { fetchMobileChartHistory } from '../lib/chart-history-cache';
import { getHistoryEntry, planHistory, setHistoryEntry } from '../lib/chart-history-freshness';
import { dayHighLow, formatIndicatorValue, intradayAverage, intradayBars, liveBarTime, priceLinesKey, type PriceLineSpec } from '../lib/chart-model';
import { capBars, CHART_PERIODS, chartQueryRange, MAX_CHART_BARS, periodDef, type ChartPeriod } from '../lib/chart-ranges';
import {
    indicatorLabel,
    indicatorSettingsKey,
    indicatorWarmupBars,
    insufficientDataNote,
    INDICATOR_PALETTE,
    paletteColor,
    useMobileIndicators,
    usesPaletteColor,
    type MobileIndicator,
    type MobileIndicatorSettings,
} from '../lib/mobile-indicators';
import { buyRatio, dateOfWallClock, flowView, lineFlowSupported, retainLineFlow, type FlowStatus, type FlowView, type LineFlowSnapshot } from '../lib/line-flow';
import { thresholdIndex, thresholdLabel, useLineIndicatorSettings, type LineIndicatorSettings } from '../lib/line-indicators';
import { useMobileDeviceSettings } from '../lib/mobile-device-settings';
import { openOrderAction, openTicket } from '../lib/mobile-store';
import { haptic } from '../motion/haptics';
import { prefersReducedMotion } from '../motion/prefs';
import * as cs from '../styles/chart.css';
import * as styles from '../styles/trade.css';
import { Chip } from '../ui/chip';
import { Segmented } from '../ui/segmented';
import { IndicatorSheet } from './indicator-sheet';

/** 即時成交合併重畫的間隔（行情 store 的 QUOTE_FLUSH_MS 未匯出，自行節流） */
export const CHART_FLUSH_MS = 100;
/** 指標的即時重算間隔（≥ 250 ms；只 update 變動的尾端點） */
export const INDICATOR_FLUSH_MS = 500;
/** 長按進入追蹤模式的時間與容許位移 */
export const LONG_PRESS_MS = 450;
/** 全螢幕週期 Segmented 的選項 */
const PERIOD_ITEMS = CHART_PERIODS.map(p => ({ value: p.key, label: p.label }));
export const LONG_PRESS_SLOP_PX = 10;
/** 輕點釘住價格資訊後，再點離那一根 x 在這個距離內＝「再點同一點」（收起） */
export const TAP_SAME_SPOT_PX = 12;
/** 歷史與即時之間出現斷層時補抓歷史的最短間隔 */
export const GAP_RELOAD_MIN_MS = 120_000;
/** 走勢：即時成交與最後一根相隔超過這個秒數，且累計量顯示漏量時補抓（與桌面 intraday-chart 相同） */
export const LINE_GAP_SECONDS = 180;
/** K 線模式初次顯示的根數（手機寬度） */
const INITIAL_VISIBLE_BARS = 80;
/** 走勢均價線顏色 */
const AVG_COLOR = INDICATOR_PALETTE[0]!;
/** 大單、小單累積淨買線顏色（避開漲跌色） */
const BIG_COLOR = INDICATOR_PALETTE[1]!;
const SMALL_COLOR = INDICATOR_PALETTE[2]!;
/** 買賣力的價格格式：整數張 */
const LOTS_FORMAT = { type: 'price' as const, precision: 0, minMove: 1 };

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
    /** 根數不足以計算時的說明（例如期權日 K：「資料不足（需 20 根，目前 17 根）」） */
    note?: string;
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

/** #rrggbb → 半透明 rgba（量柱的平盤色）；其他格式原樣回傳 */
function fadeColor(color: string, alpha: number): string {
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    const n = parseInt(m[1]!, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

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
    /** 各輸出第一個有值所需根數（indicatorWarmupBars） */
    warmup: Record<string, number>;
}

export interface TradeChartProps {
    code: string;
    contract: ContractInfo;
    period: ChartPeriod;
    lines: readonly PriceLineSpec[];
    /** 全螢幕上方的週期列切換；未提供時全螢幕只顯示目前週期 */
    onPeriodChange?: (p: ChartPeriod) => void;
}

/** 圖表下方的操作提示；長按選價下單關閉時不提長按選價 */
export function chartToolNote(isLine: boolean, limitToggle: boolean, dailyK: boolean, pricePick: boolean): string {
    if (isLine) {
        if (limitToggle) return pricePick ? '點圖看價格，長按選價；點價格軸看漲跌停' : '點圖看價格；點價格軸看漲跌停';
        return pricePick ? '點一下看價格與漲跌；長按選價位，放開開啟下單面板' : '點圖看價格';
    }
    if (dailyK) return '日 K 由 1 分 K 聚合，未含除權息調整';
    return pricePick ? '點一下看收盤與漲跌；長按選價位' : '點一下看收盤與漲跌';
}

/** 按在按鈕上（選價列、委託線標籤、資訊列 ✕）：不算圖表上的輕點 */
function isControl(target: EventTarget | null): boolean {
    const el = target as { closest?: (sel: string) => unknown } | null;
    return typeof el?.closest === 'function' && el.closest('button') !== null;
}

/**
 * 價格資訊列（圖例第一列）：輕點釘住時有 ✕；長按追蹤時跟著十字線。
 * 自己訂閱小 store，十字線移動只重繪這一列。
 */
function ReadoutLine({ store, onClose }: { store: ReadoutStore; onClose: () => void }) {
    const r = useSyncExternalStore(store.subscribe, store.get, store.get);
    if (!r) return null;
    const tone = styles.dirText[r.dir];
    const closeButton = r.source === 'tap' ? (
        <button
            type='button'
            className={cs.readoutClose}
            onPointerDown={e => e.stopPropagation()}
            onClick={onClose}
            aria-label='關閉價格資訊'
            data-testid='chart-readout-close'
        >
            ✕
        </button>
    ) : null;
    return (
        <div className={cs.readout} data-testid='chart-readout' data-source={r.source}>
            <span className={cs.readoutPill} role='group' aria-label={r.ariaLabel}>
                <span className={cs.readoutTime} aria-hidden='true'>{r.time}</span>
                <span className={`${cs.readoutPrice} ${tone}`} aria-hidden='true' data-testid='chart-readout-price'>
                    {r.priceLabel ? `${r.priceLabel} ${r.price}` : r.price}
                </span>
                {/* 量放在漲跌之後（不夾在價格與漲跌之間，免得「量 25 ▲5」被讀成量的漲跌），與無障礙名稱的順序相同。
                    以組為單位換行：［漲跌］［量 ✕］；沒有量時 ✕ 跟著漲跌，✕ 不會單獨落到下一行 */}
                {r.change && (
                    <span className={cs.readoutTail}>
                        <span className={tone} aria-hidden='true' data-testid='chart-readout-change'>
                            {`${r.change.label ? `${r.change.label} ` : ''}${r.change.text} (${r.change.pct})`}
                        </span>
                        {r.volume === null && closeButton}
                    </span>
                )}
                {(r.volume !== null || (!r.change && closeButton)) && (
                    <span className={cs.readoutTail}>
                        {r.volume !== null && (
                            <span className={cs.readoutTime} aria-hidden='true' data-testid='chart-readout-volume'>{`量 ${r.volume}`}</span>
                        )}
                        {(r.volume !== null || !r.change) && closeButton}
                    </span>
                )}
            </span>
        </div>
    );
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
    const lineSettings = useLineIndicatorSettings();
    const lineSettingsRef = useRef<LineIndicatorSettings>(lineSettings);
    lineSettingsRef.current = lineSettings;
    const lineSettingsKey = `${lineSettings.flow}|${lineSettings.bigSmall}|${lineSettings.threshold}`;
    /** 走勢副圖設定改變：在既有圖表上增減副圖、換門檻（不重建圖表） */
    const flowRebuildRef = useRef<() => void>(() => undefined);
    /** 圖表長按選價下單（本裝置設定，預設關）：關閉時長按只看價格，不浮出選價列 */
    const pricePick = useMobileDeviceSettings().chartPricePick;
    const pricePickRef = useRef(pricePick);
    pricePickRef.current = pricePick;

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
    /**
     * 目前這次按壓（第一指）；tap＝仍可能是輕點（沒拖超過容許位移、不是多指、不在按鈕上、未進入追蹤）；
     * held＝長按選價下單關閉時的長按（看價格）：放開時釘在放開的那一根
     */
    const gestureRef = useRef<{ x: number; y: number; tap: boolean; held?: boolean } | null>(null);
    /** 按著的指標（pointerId）：第二指＝雙指縮放 */
    const pointersRef = useRef(new Set<number>());
    /** 輕點（相對圖表的座標）：釘住或收起價格資訊（由圖表 effect 提供）；toggle=false＝只釘住（長按看價格放開） */
    const tapRef = useRef<(x: number, y: number, toggle?: boolean) => void>(() => undefined);
    /** 漲跌停範圍模式改變：主圖重新自動縮放（由圖表 effect 提供） */
    const rescaleRef = useRef<() => void>(() => undefined);
    /** 收起輕點的價格資訊；clearChart＝一併清掉十字線（長按進入追蹤時不清，十字線交給程式庫） */
    const hideTapRef = useRef<(clearChart: boolean) => void>(() => undefined);
    const [readout] = useState<ReadoutStore>(createReadoutStore);

    const [status, setStatus] = useState<Status>('loading');
    const [chartGen, setChartGen] = useState(0);
    const [orderLabels, setOrderLabels] = useState<OrderLabel[]>([]);
    const [pick, setPick] = useState<number | null>(null);
    // 選價列沿原路收回時的殘影（只剩文字的 span、aria-hidden＋inert，不可點）
    const [pickClosing, setPickClosing] = useState<string | null>(null);
    // 選價列的外層（沒有 transform）：捲動到可見範圍時量它
    const pickAnchorRef = useRef<HTMLDivElement | null>(null);
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
    /** 圖表 effect 讀取（副圖高度只在一般模式校正） */
    const fullscreenRef = useRef(fullscreen);
    fullscreenRef.current = fullscreen;

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
        const isIndex = ct.security_type === 'IND';
        // 指數沒有跳動單位：價格軸固定兩位、minMove 0.01（tickSizeFor 對 IND 會套股票級距，23,456.78 會變成整數）
        const precision = isIndex ? 2 : tickDecimals(tickSizeFor(ct, ct.reference > 0 ? ct.reference : 1));
        const priceFormat = { type: 'price' as const, precision, minMove: Number((10 ** -precision).toFixed(precision)) };
        /** 走勢且開啟漲跌停範圍、商品有正數漲跌停 */
        const limitActive = () => isLine && limitOnRef.current && hasLimitRange(contractRef.current);

        const chart = createChart(host, {
            autoSize: true,
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: c.text,
                fontFamily: cs.CHART_FONT_FAMILY,
                fontSize: 11,
                attributionLogo: false,
                // 副圖分隔線用主題框線色（程式庫預設是淺色 #E0E3EB，深色主題下太亮）；
                // 不給拖曳改高度（手機上容易誤觸，副圖高度由外框與 PANE_HEIGHT_PX 決定）
                panes: { separatorColor: c.border, separatorHoverColor: c.grid, enableResize: false },
            },
            grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
            crosshair: {
                mode: CrosshairMode.Normal,
                vertLine: { color: c.crosshair, labelBackgroundColor: c.labelBg },
                horzLine: { color: c.crosshair, labelBackgroundColor: c.labelBg },
            },
            rightPriceScale: { borderColor: c.border },
            timeScale: isLine
                // 走勢：X 軸固定為整個時段（axisSeries 的空白點）；左端貼齊、尺寸改變時保留同一段時間；
                // 不用 fixRightEdge：它把右端鎖在最後一根「有資料」的點，右側未到的時段（尾端空白點）會被切掉。
                // 夜盤 840 分鐘要放進手機寬度，最小間距放寬
                ? { borderColor: c.border, timeVisible: true, secondsVisible: false, rightOffset: 0, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true, minBarSpacing: 0.01 }
                : { borderColor: c.border, timeVisible: minutes < 1440, secondsVisible: false, rightOffset: 2 },
            // K 線：單指水平拖曳平移（垂直滑動留給頁面捲動）。走勢：不拖移、不縮放（水平與垂直滑動都交給頁面）
            handleScroll: isLine ? false : { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
            // K 線：雙指縮放；價格軸不給拖（維持自動縮放，委託線標籤位置才準）。走勢：全部關閉
            handleScale: isLine ? false : { pinch: true, mouseWheel: true, axisPressedMouseMove: { time: true, price: false }, axisDoubleClickReset: true },
            // 走勢沒有拖移，也就沒有慣性捲動；明確關閉
            ...(isLine ? { kineticScroll: { touch: false, mouse: false } } : {}),
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
                // 漲跌停範圍：Y 軸固定為 [跌停, 漲停]；否則自動
                autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
                    const k = contractRef.current;
                    return limitActive() ? { priceRange: { minValue: k.limit_down, maxValue: k.limit_up } } : original();
                },
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
        // K 線：成交量疊在主圖底部 20%（指標面板可隱藏）。走勢：成交量放在價格下方的副圖，有量才建立（syncLineVolume）
        let vol: ISeriesApi<SeriesType> | null = null;
        if (!isLine) {
            vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
            chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        }
        const lineVolAllowed = isLine && !isIndex;
        // 走勢：均價線（指數沒有成交量，不畫）
        const avgSeries = isLine && !isIndex
            ? chart.addSeries(LineSeries, {
                color: AVG_COLOR,
                lineWidth: 1,
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
                priceFormat,
                // 漲跌停範圍時不參與縮放（不把範圍撐大）
                autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => (limitActive() ? null : original()),
            })
            : null;
        // 走勢：整個時段每一分鐘一個空白點，X 軸因此固定為整個時段（applySessionAxis）
        const axisSeries = isLine
            ? chart.addSeries(LineSeries, { lineVisible: false, pointMarkersVisible: false, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false })
            : null;
        /** axisSeries 目前對應的時段起點 */
        let axisStart: number | null = null;
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
        /** 上次校正副圖高度時的外框高度（-1＝下次一般模式要校正） */
        let paneFixHeight = -1;
        let indDirtyTime = Infinity;
        let indTimer: ReturnType<typeof setTimeout> | null = null;
        /** 目前追蹤中的十字線資料（null＝顯示最新值） */
        let crossData: Map<unknown, unknown> | null = null;
        /** 追蹤或輕點的那一分鐘（買賣力圖例以時間對照）；null＝顯示當日累計 */
        let crossTime: number | null = null;
        // 走勢副圖：分時買賣力（flowS）、大單／小單買賣力（bsS）
        const flowAllowed = isLine && lineFlowSupported(ct);
        let flowS: { buy: ISeriesApi<SeriesType>; sell: ISeriesApi<SeriesType>; net: ISeriesApi<SeriesType> } | null = null;
        let bsS: { big: ISeriesApi<SeriesType>; small: ISeriesApi<SeriesType> } | null = null;
        let flowHandle: { get: () => LineFlowSnapshot; release: () => void } | null = null;
        let flowDate: string | null = null;
        let flowTimer: ReturnType<typeof setTimeout> | null = null;
        let flowStatus: FlowStatus | null = null;
        let flowV: FlowView | null = null;
        /** 輕點釘住的那一根（時間）；null＝沒有 */
        let tapTime: number | null = null;
        readout.set(null);

        const flatVol = fadeColor(c.text, 0.45);
        /** 量柱顏色：K 線＝收對開；走勢＝本分鐘收盤對前一分鐘收盤（第一根對參考價），平盤中性 */
        const volColor = (i: number): string => {
            const b = bars[i]!;
            if (!isLine) return b.close >= b.open ? c.upVol : c.downVol;
            const prev = i > 0 ? bars[i - 1]!.close : contractRef.current.reference;
            if (!(prev > 0) || b.close === prev) return flatVol;
            return b.close > prev ? c.upVol : c.downVol;
        };
        const volPoint = (b: Candle, i: number) => ({ time: t(b.time), value: b.volume, color: volColor(i) });
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
                if (vol) {
                    // 副圖小標：成交量＋最新一分鐘（追蹤、輕點時為該分鐘）的量
                    next.push({ id: 'vol', name: '成交量', color: c.text, pane: 1, values: [{ label: '', color: c.text, text: formatIndicatorValue(seriesValue(vol, bars[bars.length - 1]?.volume), 0) }] });
                }
                if (flowAllowed) next.push(...flowLegend());
            } else {
                for (const r of inds) {
                    const single = r.outputs.length === 1;
                    const empty: Record<string, boolean> = {};
                    for (const o of r.outputs) empty[o.key] = o.last === undefined;
                    const note = bars.length > 0 ? insufficientDataNote(r.warmup, empty, bars.length) : null;
                    next.push({
                        id: r.item.id,
                        name: indicatorLabel(r.item),
                        color: r.outputs[0]?.color ?? c.text,
                        pane: r.pane,
                        values: r.outputs.map(o => ({ label: single ? '' : o.label, color: o.color, text: formatIndicatorValue(seriesValue(o.series, o.last), r.decimals) })),
                        ...(note ? { note } : {}),
                    });
                }
            }
            setLegend(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        };

        // ---- 走勢副圖的圖例 ----
        const lots = (v: number | undefined) => formatIndicatorValue(v, 0);
        const signedLots = (v: number | undefined) => (v !== undefined && v > 0 ? `+${lots(v)}` : lots(v));
        /** 到 time 為止最後一個有資料的分鐘（累積線用）；沒有回傳 -1 */
        const flowIndexAtOrBefore = (v: FlowView, time: number): number => {
            let lo = 0;
            let hi = v.times.length - 1;
            let ans = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (v.times[mid]! <= time) {
                    ans = mid;
                    lo = mid + 1;
                } else hi = mid - 1;
            }
            return ans;
        };
        const flowLegend = (): LegendEntry[] => {
            const s = lineSettingsRef.current;
            if (!s.flow && !s.bigSmall) return [];
            const out: LegendEntry[] = [];
            const empty = flowV !== null && flowV.times.length === 0;
            const note = flowStatus === 'loading' || flowStatus === null
                ? '讀取逐筆中…'
                : flowStatus === 'error'
                    ? '讀取失敗（重開指標重試）'
                    : empty
                        ? (flowDate === dateOfWallClock(nowWallClockUtc()) ? '今日尚無成交' : '此時段尚無成交')
                        : null;
            const v = note === null ? flowV : null;
            // 輕點／追蹤：該分鐘的外盤、內盤（沒有那一分鐘＝0）；累積線取到該分鐘為止
            const at = v && crossTime !== null ? v.index.get(crossTime) : undefined;
            const upto = v ? (crossTime !== null ? flowIndexAtOrBefore(v, crossTime) : v.times.length - 1) : -1;
            const flowPane = flowS ? 2 : 0;
            const bsPane = bsS ? (flowS ? 3 : 2) : 0;
            if (s.flow) {
                if (!v) out.push({ id: 'flow', name: '分時買賣力', color: c.text, pane: flowPane, values: [], note: note ?? '' });
                else {
                    const buy = crossTime !== null ? (at !== undefined ? v.buy[at]! : 0) : v.totalBuy;
                    const sell = crossTime !== null ? (at !== undefined ? v.sell[at]! : 0) : v.totalSell;
                    const ratio = buyRatio(buy, sell);
                    out.push({ id: 'flow', name: '分時買賣力', color: c.text, pane: flowPane, values: [{ label: '外', color: c.up, text: lots(buy) }, { label: '內', color: c.down, text: lots(sell) }] });
                    out.push({ id: 'flow-ratio', name: '外盤比', color: c.text, pane: flowPane, values: [{ label: '', color: c.text, text: ratio === null ? '—' : `${ratio.toFixed(1)}%` }] });
                    out.push({ id: 'flow-net', name: '累積淨', color: c.text, pane: flowPane, values: [{ label: '', color: c.text, text: upto < 0 ? '0' : signedLots(v.cumNet[upto]) }] });
                }
            }
            if (s.bigSmall) {
                const bigName = `大單≥${thresholdLabel(s.threshold)}`;
                if (!v) out.push({ id: 'bs-big', name: bigName, color: BIG_COLOR, pane: bsPane, values: [], ...(s.flow && flowPane === bsPane ? {} : { note: note ?? '' }) });
                else {
                    out.push({ id: 'bs-big', name: bigName, color: BIG_COLOR, pane: bsPane, values: [{ label: '淨', color: c.text, text: upto < 0 ? '0' : signedLots(v.bigNet[upto]) }] });
                    out.push({ id: 'bs-small', name: '小單', color: SMALL_COLOR, pane: bsPane, values: [{ label: '淨', color: c.text, text: upto < 0 ? '0' : signedLots(v.smallNet[upto]) }] });
                }
            }
            return out;
        };

        // 委託線標籤（HTML 按鈕）跟著價格座標走；副圖圖例跟著自己的 pane：資料或可見範圍變動後的下一個畫面重新定位
        const layoutLabels = () => {
            raf1 = raf2 = null;
            if (cancelled) return;
            const height = host.clientHeight;
            let mainH = height - 24; // 底部留給時間軸
            const tops: number[] = [];
            if (fullscreenRef.current) paneFixHeight = -1;
            if (subPanes > 0) {
                try {
                    const panes = chart.panes();
                    // 一般模式的外框＝0 副圖高度＋每個副圖 PANE_HEIGHT_PX；外框改變（退出全螢幕、副圖晚建或增減）時
                    // 程式庫依比例重分配各 pane → 把副圖拉回 PANE_HEIGHT_PX，價格區才不縮小。
                    // 以 stretch factor 一次設定全部 pane（逐一 setHeight 會互相把差額攤到別的副圖上）。
                    // 每個外框高度（或副圖組成）只校正一次，避免放不下時反覆重排；全螢幕沿用比例分配（橫向高度不夠固定高度）。
                    if (!fullscreenRef.current && height !== paneFixHeight) {
                        paneFixHeight = height;
                        const hs = panes.map(p => p.getHeight() || 0);
                        const total = hs.reduce((a, b) => a + b, 0);
                        const n = panes.length - 1;
                        if (total > 0 && hs.slice(1).some(h => Math.abs(h - cs.PANE_HEIGHT_PX) > 1)) {
                            panes[0]!.setStretchFactor(Math.max(total - cs.PANE_HEIGHT_PX * n, 60));
                            for (let i = 1; i < panes.length; i++) panes[i]!.setStretchFactor(cs.PANE_HEIGHT_PX);
                            scheduleLayout(); // 新高度下一個畫面才生效：重新定位標籤
                        }
                    }
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
                                // 空白點也要送（SuperTrend 翻轉、指標斷線）：同一時間的 whitespace 會刪掉該根的舊值，
                                // 否則翻轉那一根會同時留著翻轉前的線段（lightweight-charts v5 的 update 接受 WhitespaceData）
                                o.series.update(p.value !== undefined && Number.isFinite(p.value) ? indPoint(o, p) : { time: t(p.time) });
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
            if (isLine) {
                // 走勢沒有指標；成交量副圖由 syncLineVolume 管理（不可移除 pane 1）
                publishLegend();
                scheduleLayout();
                return;
            }
            const s = settingsRef.current;
            try { vol?.applyOptions({ visible: s.volume }); } catch { /* 舊版選項 */ }
            removeIndicators();
            subPanes = 0;
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
                    warmup: indicatorWarmupBars(def, params),
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
            paneFixHeight = -1;
            try {
                const panes = chart.panes();
                for (let i = 1; i < panes.length; i++) panes[i]!.setHeight(cs.PANE_HEIGHT_PX);
            } catch {
                // pane API 差異不能讓圖表掛掉
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

        /**
         * 走勢：有量才建成交量副圖（pane 1），沒有量（指數、全為 0、沒有資料）就移除。
         * 回傳 true＝剛建立（呼叫端要整段 setData）。
         */
        const syncLineVolume = (hasVolume: boolean): boolean => {
            if (!lineVolAllowed) return false;
            if (hasVolume === (vol !== null)) {
                if (!hasVolume) setPaneCount(0); // 收回建立圖表時預留的高度
                return false;
            }
            if (hasVolume) {
                vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1);
                try { vol.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0 } }); } catch { /* 舊版選項 */ }
                try { chart.panes()[1]?.setHeight(cs.PANE_HEIGHT_PX); } catch { /* pane API 差異不能讓圖表掛掉 */ }
                subPanes = 1;
                paneFixHeight = -1;
            } else {
                // 買賣力副圖排在量之後：先移除，否則量的 pane 移除後它們會往上遞補
                removeFlowSeries();
                // 移除最後一個 series 時程式庫會一併移除空的 pane
                try { chart.removeSeries(vol!); } catch { /* 已隨圖表移除 */ }
                vol = null;
                subPanes = 0;
                paneFixHeight = -1;
            }
            setPaneCount(subPanes);
            syncFlowPanes();
            return hasVolume;
        };

        // ---- 走勢副圖：分時買賣力、大單／小單買賣力 ----
        const removeFlowSeries = () => {
            const all = [...(flowS ? [flowS.buy, flowS.sell, flowS.net] : []), ...(bsS ? [bsS.big, bsS.small] : [])];
            for (const sr of all) {
                try { chart.removeSeries(sr); } catch { /* 已隨圖表移除 */ }
            }
            flowS = null;
            bsS = null;
        };
        /** 依設定增減副圖（量副圖存在才建：量固定在 pane 1，買賣力依序在其後） */
        const syncFlowPanes = () => {
            if (!flowAllowed) return;
            const s = lineSettingsRef.current;
            const needFlow = s.flow && vol !== null;
            const needBs = s.bigSmall && vol !== null;
            if (needFlow === (flowS !== null) && needBs === (bsS !== null)) return;
            removeFlowSeries();
            const common = { priceLineVisible: false, lastValueVisible: false, priceFormat: LOTS_FORMAT };
            let pane = 2;
            if (needFlow) {
                flowS = {
                    buy: chart.addSeries(HistogramSeries, { ...common, color: c.upVol }, pane),
                    sell: chart.addSeries(HistogramSeries, { ...common, color: c.downVol }, pane),
                    // 累積淨買力：另一個疊加刻度（不顯示座標）；與每分鐘的柱共用右側刻度會把柱壓扁
                    net: chart.addSeries(LineSeries, { ...common, color: c.text, lineWidth: 1, crosshairMarkerVisible: false, priceScaleId: 'flow-net' }, pane),
                };
                try {
                    // 上方留給圖例（字級大時外內／外盤比／累積淨會排成兩列）
                    flowS.buy.priceScale().applyOptions({ scaleMargins: { top: 0.45, bottom: 0.05 } });
                    flowS.net.priceScale().applyOptions({ scaleMargins: { top: 0.45, bottom: 0.05 } });
                } catch { /* 舊版選項 */ }
                pane++;
            }
            if (needBs) {
                bsS = {
                    big: chart.addSeries(LineSeries, { ...common, color: BIG_COLOR, lineWidth: 2, crosshairMarkerVisible: false }, pane),
                    small: chart.addSeries(LineSeries, { ...common, color: SMALL_COLOR, lineWidth: 2, crosshairMarkerVisible: false }, pane),
                };
                try { bsS.big.priceScale().applyOptions({ scaleMargins: { top: 0.3, bottom: 0.05 } }); } catch { /* 舊版選項 */ }
                bsS.big.createPriceLine({ price: 0, color: c.grid, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
                pane++;
            }
            try {
                const panes = chart.panes();
                for (let i = 2; i < panes.length; i++) panes[i]!.setHeight(cs.PANE_HEIGHT_PX);
            } catch {
                // pane API 差異不能讓圖表掛掉
            }
            subPanes = pane - 1;
            paneFixHeight = -1;
            setPaneCount(subPanes);
            applyFlowData();
            scheduleLayout();
        };
        /** 依彙總畫副圖並更新圖例（每筆成交以 INDICATOR_FLUSH_MS 節流；整段 setData，一天最多 271 點） */
        const applyFlowData = () => {
            if (flowTimer !== null) {
                clearTimeout(flowTimer);
                flowTimer = null;
            }
            if (cancelled) return;
            const snap = flowHandle?.get() ?? null;
            flowStatus = snap?.status ?? null;
            flowV = snap && snap.status === 'ready' ? flowView(snap.agg, thresholdIndex(lineSettingsRef.current.threshold)) : null;
            const v = flowV;
            const pts = (vals: readonly number[] | undefined, sign = 1) => (v && vals ? v.times.map((tm, i) => ({ time: t(tm), value: sign * vals[i]! })) : []);
            try {
                if (flowS) {
                    flowS.buy.setData(pts(v?.buy));
                    flowS.sell.setData(pts(v?.sell, -1));
                    flowS.net.setData(pts(v?.cumNet));
                }
                if (bsS) {
                    bsS.big.setData(pts(v?.bigNet));
                    bsS.small.setData(pts(v?.smallNet));
                }
            } catch {
                // 資料格式問題不能讓圖表掛掉
            }
            publishLegend();
        };
        const scheduleFlow = () => {
            if (flowTimer === null && !cancelled) flowTimer = setTimeout(applyFlowData, INDICATOR_FLUSH_MS);
        };
        /** 開啟任一買賣力指標且知道走勢的時段時，取用該檔該日的彙總（開啟才下載；關閉時釋放） */
        const syncFlowHandle = () => {
            if (!flowAllowed) return;
            const s = lineSettingsRef.current;
            const date = (s.flow || s.bigSmall) && win ? dateOfWallClock(win.start) : null;
            if (date === flowDate) return;
            flowHandle?.release();
            flowHandle = null;
            flowDate = date;
            if (date) flowHandle = retainLineFlow(ct, date, scheduleFlow);
            applyFlowData();
        };
        flowRebuildRef.current = () => {
            if (cancelled) return;
            syncFlowPanes();
            syncFlowHandle();
            applyFlowData();
        };

        const applyAll = () => {
            main.setData(bars.map(mainPoint));
            syncLineVolume(bars.some(b => b.volume > 0));
            vol?.setData(bars.map(volPoint));
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
            // 走勢：開盤第一筆有量的成交才建立成交量副圖
            const volCreated = vol === null && syncLineVolume(bars.some((b, i) => i >= from && b.volume > 0));
            if (volCreated) vol?.setData(bars.map(volPoint));
            try {
                for (let i = from; i < bars.length; i++) {
                    const b = bars[i]!;
                    main.update(mainPoint(b));
                    if (!volCreated) vol?.update(volPoint(b, i));
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
        /** 走勢：axisSeries 放滿目前時段每一分鐘的空白點（換時段才重設） */
        const applySessionAxis = () => {
            if (!axisSeries || !win || axisStart === win.start) return;
            const pts: { time: UTCTimestamp }[] = [];
            for (let tm = win.start + 60; tm <= win.end; tm += 60) pts.push({ time: t(tm) });
            axisSeries.setData(pts);
            axisStart = win.start;
        };
        /** 走勢：可見範圍＝整個時段（含右側未到的空白） */
        const fitSession = () => {
            if (axisStart === null) return;
            try { chart.timeScale().fitContent(); } catch { /* 圖表已移除 */ }
        };

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
            applySessionAxis();
            applyAll();
            syncFlowHandle();
            if (isLine) fitSession();
            else if (range && live.length > 0) {
                const shift = bars.length - prevLen;
                ts.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
            } else if (bars.length > INITIAL_VISIBLE_BARS) ts.setVisibleLogicalRange({ from: bars.length - INITIAL_VISIBLE_BARS, to: bars.length + 2 });
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
            return fetchMobileChartHistory(ct, start, end, { timeoutMs: 30_000, revision })
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
                        applySessionAxis();
                        fitSession();
                        syncFlowHandle();
                        // 收回預留的成交量副圖高度（之後有量的成交才建立）
                        if (lineVolAllowed && vol === null) setPaneCount(0);
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
        // 走勢：尺寸改變（全螢幕、橫向、外框加高）後仍是整個時段
        if (isLine) chart.timeScale().subscribeSizeChange(fitSession);
        rescaleRef.current = () => {
            if (cancelled) return;
            // 換了 autoscaleInfoProvider 的結果：要求價格軸重新自動縮放；委託線標籤跟著重新定位
            try { main.priceScale().applyOptions({ autoScale: true }); } catch { /* 舊版選項 */ }
            scheduleLayout();
        };

        // ---- 價格資訊列：輕點釘住、長按追蹤 ----
        const indexOfTime = (time: number): number => {
            let lo = 0;
            let hi = bars.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const v = bars[mid]!.time;
                if (v === time) return mid;
                if (v < time) lo = mid + 1;
                else hi = mid - 1;
            }
            return -1;
        };
        const readoutAt = (i: number, source: 'tap' | 'track') => chartReadout(bars, i, {
            mode: isLine ? 'line' : 'kbar',
            daily: minutes >= 1440,
            contract: contractRef.current,
            reference: contractRef.current.reference,
            source,
            // 指數不附量（走勢不建量副圖；指數 K 棒的量不是成交張數或口數）
            volume: !isIndex,
        });
        /** 第 i 根各 series 的值：圖例顯示該根（同長按追蹤） */
        /** 走勢（X 軸＝整個時段）：第 i 根的邏輯位置＝時段內第幾分鐘；K 線＝索引 */
        const logicalOfBar = (i: number): number => (isLine && axisStart !== null ? (bars[i]!.time - (axisStart + 60)) / 60 : i);
        /** 邏輯位置 → 最近一根（走勢依時間找最近的有成交那一分鐘；超出兩端取第一根或最後一根） */
        const barAtLogical = (logical: number): number => {
            if (!(isLine && axisStart !== null)) return Math.min(bars.length - 1, Math.max(0, Math.round(logical)));
            const time = axisStart + 60 + Math.round(logical) * 60;
            let lo = 0;
            let hi = bars.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (bars[mid]!.time < time) lo = mid + 1;
                else hi = mid;
            }
            if (lo >= bars.length) return bars.length - 1;
            if (lo > 0 && time - bars[lo - 1]!.time <= bars[lo]!.time - time) return lo - 1;
            return lo;
        };
        const crossDataAt = (i: number): Map<unknown, unknown> => {
            const map = new Map<unknown, unknown>();
            const all: ISeriesApi<SeriesType>[] = [main, ...(avgSeries ? [avgSeries] : []), ...(isLine && vol ? [vol] : []), ...inds.flatMap(r => r.outputs.map(o => o.series))];
            for (const s of all) {
                try {
                    const d = s.dataByIndex(logicalOfBar(i));
                    if (d) map.set(s, d);
                } catch {
                    // API 差異：該值顯示 —
                }
            }
            return map;
        };
        const showTap = (i: number) => {
            const bar = bars[i];
            if (!bar) return;
            tapTime = bar.time;
            crossTime = bar.time;
            try {
                // 程式設定的十字線不觸發 crosshairMove（skipEvent）
                chart.setCrosshairPosition(bar.close, t(bar.time), main);
            } catch {
                // 十字線 API 差異不能讓圖表掛掉
            }
            crossData = crossDataAt(i);
            publishLegend();
            readout.set(readoutAt(i, 'tap'));
        };
        const hideTap = (clearChart: boolean) => {
            if (tapTime === null) return;
            tapTime = null;
            readout.set(null);
            if (!clearChart) return;
            try { chart.clearCrosshairPosition(); } catch { /* 十字線 API 差異 */ }
            if (crossData !== null || crossTime !== null) {
                crossData = null;
                crossTime = null;
                publishLegend();
            }
        };
        hideTapRef.current = hideTap;
        tapRef.current = (x, y, toggle = true) => {
            if (cancelled || bars.length === 0) return;
            const ts = chart.timeScale();
            const width = ts.width();
            const mainH = mainPaneHeightRef.current ?? host.clientHeight - 24;
            if (width > 0 && x > width) {
                // 主圖的價格軸：走勢切換漲跌停範圍（不出資訊列、不選價）；副圖的價格軸不觸發
                if (toggle && isLine && y >= 0 && y <= mainH && hasLimitRange(contractRef.current)) toggleLimitRange();
                return;
            }
            if (y < 0 || y > mainH) return; // 時間軸、副圖
            const logical = ts.coordinateToLogical(x);
            if (logical === null || !Number.isFinite(logical)) return;
            // 吸附到最近一根有資料的（走勢：有成交的那一分鐘）；超出兩端取第一根或最後一根
            const i = barAtLogical(logical);
            // 再點同一點：收起。走勢一分鐘常只有 1px 寬，手指再點難免偏幾 px →
            // 落在同一根，或離釘住那一根的 x 在 TAP_SAME_SPOT_PX 內，都算同一點
            const pinned = tapTime === null ? -1 : indexOfTime(tapTime);
            const pinnedX = pinned < 0 ? null : ts.logicalToCoordinate(logicalOfBar(pinned) as Logical);
            if (toggle && (pinned === i || (pinnedX !== null && Math.abs(x - pinnedX) <= TAP_SAME_SPOT_PX))) hideTap(true);
            else showTap(i);
        };

        // 十字線：長按追蹤時記錄價格（只在主圖）；圖例顯示該根的值；價格資訊列跟著十字線
        chart.subscribeCrosshairMove(param => {
            if (trackingRef.current && param.point) {
                if (param.paneIndex !== undefined && param.paneIndex > 0) crossPriceRef.current = null;
                else {
                    const p = main.coordinateToPrice(param.point.y);
                    if (p !== null && Number.isFinite(p)) crossPriceRef.current = p;
                }
            }
            // 輕點釘住期間：程式庫在觸控放開、資料更新（以像素位置重算）、滑鼠移動／移出時會移動或清除十字線 → 放回那一根。
            // 手指按著時交給程式庫（長按追蹤、平移）；放開時由指標事件決定輕點、收起或追蹤。
            if (tapTime !== null && !gestureRef.current) {
                const i = indexOfTime(tapTime);
                if (i < 0) hideTap(true); // 那一根已不在資料中（裁切、換時段）
                else showTap(i);
                return;
            }
            const next = param.time !== undefined && param.seriesData ? (param.seriesData as Map<unknown, unknown>) : null;
            const at = next !== null && param.point ? indexOfTime(Number(param.time)) : -1;
            if (at >= 0) readout.set(readoutAt(at, 'track'));
            else if (tapTime === null) readout.set(null);
            if (next === null && crossData === null) return;
            crossData = next;
            crossTime = next !== null && param.time !== undefined ? Number(param.time) : null;
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
        // 走勢（非指數）先預留成交量副圖的高度，載入後沒有量才收回（避免載入完成時版面往下跳）
        {
            const ls = lineSettingsRef.current;
            setPaneCount(lineVolAllowed ? 1 + (flowAllowed ? Number(ls.flow) + Number(ls.bigSmall) : 0) : 0);
        }
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
            tapRef.current = () => undefined;
            rescaleRef.current = () => undefined;
            hideTapRef.current = () => undefined;
            readout.set(null);
            layoutRef.current = () => undefined;
            rebuildRef.current = () => undefined;
            retryRef.current = () => undefined;
            resumeRefreshRef.current = () => undefined;
            if (flushTimer !== null) clearTimeout(flushTimer);
            if (indTimer !== null) clearTimeout(indTimer);
            if (flowTimer !== null) clearTimeout(flowTimer);
            flowHandle?.release();
            flowRebuildRef.current = () => undefined;
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
    // 走勢副圖設定改變（或圖表重建後）：增減副圖、換門檻、開始或停止取用逐筆彙總
    useEffect(() => { flowRebuildRef.current(); }, [lineSettingsKey, chartGen]);

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

    // ---- 漲跌停範圍（走勢） ----
    const limitOn = useLimitRange();
    const limitOnRef = useRef(limitOn);
    limitOnRef.current = limitOn;
    const limitActive = isLine && limitOn && hasLimitRange(contract);
    // 漲停／跌停線：股票本來就在 lines 裡；期權等沒有的在漲跌停範圍時補畫
    const effLines = useMemo(() => {
        if (!limitActive) return lines;
        const extra: PriceLineSpec[] = [];
        if (!lines.some(l => l.kind === 'limit-up')) extra.push({ key: 'limit-up', price: contract.limit_up, kind: 'limit-up', label: '漲停' });
        if (!lines.some(l => l.kind === 'limit-down')) extra.push({ key: 'limit-down', price: contract.limit_down, kind: 'limit-down', label: '跌停' });
        return extra.length ? [...lines, ...extra] : lines;
    }, [lines, limitActive, contract.limit_up, contract.limit_down]);
    linesRef.current = effLines;
    useEffect(() => { rescaleRef.current(); }, [limitActive, contract.limit_up, contract.limit_down, chartGen]);

    // ---- 水平線 ----
    const linesKey = priceLinesKey(effLines);
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
            // 主 series 已換掉（圖表在主 effect 的清理中移除：卸載、換週期／配色重建）：價格線隨舊圖表一起銷毀，
            // 不可再呼叫 removePriceLine。對已移除的圖表呼叫它不會丟錯（try/catch 接不到），卻會排一次重繪，
            // 下一個影格畫到已銷毀的畫布而在 rAF 中丟出「Object is disposed」（未捕捉的例外）。
            if (mainRef.current !== series) return;
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
    // 關閉長按選價下單：已浮出的選價列一併收起
    useEffect(() => { if (!pricePick) setPick(null); }, [pricePick]);
    // 進出全螢幕：收起輕點的價格資訊（換週期、商品時圖表重建，也會收起）
    useEffect(() => { hideTapRef.current(true); }, [fullscreen]);

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const pointers = pointersRef.current;
        if (e.isPrimary !== false) pointers.clear(); // 新的第一指：清掉沒收到放開的舊紀錄
        pointers.add(e.pointerId ?? 0);
        if (pointers.size > 1) {
            // 第二指：雙指縮放開始，不是輕點
            if (gestureRef.current) gestureRef.current.tap = false;
            hideTapRef.current(true);
        } else {
            gestureRef.current = { x: e.clientX, y: e.clientY, tap: !isControl(e.target) };
        }
        clearPress();
        trackingRef.current = false;
        const x = e.clientX;
        const y = e.clientY;
        const timer = setTimeout(() => {
            const host = hostRef.current;
            const series = mainRef.current;
            if (!host || !series) return;
            if (!pricePickRef.current) {
                // 長按選價下單關閉：長按＝看價格（十字線交給程式庫的追蹤模式），不選價、不震動
                const g = gestureRef.current;
                if (g?.tap) {
                    g.tap = false;
                    g.held = true;
                    hideTapRef.current(false);
                }
                return;
            }
            trackingRef.current = true;
            // 長按成立：不是輕點；十字線已由程式庫的追蹤模式接手（不清除）
            if (gestureRef.current) gestureRef.current.tap = false;
            hideTapRef.current(false);
            const rect = host.getBoundingClientRect();
            const mainH = mainPaneHeightRef.current;
            // 落在副圖：座標不是價格，不選價
            const p = mainH !== null && y - rect.top > mainH ? null : series.coordinateToPrice(y - rect.top);
            crossPriceRef.current = p !== null && Number.isFinite(p) ? p : null;
            setPick(null);
            haptic('longPress');
        }, LONG_PRESS_MS);
        pressRef.current = { x, y, timer };
    };
    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const g = gestureRef.current;
        if (g?.tap && Math.hypot(e.clientX - g.x, e.clientY - g.y) > LONG_PRESS_SLOP_PX) {
            // 拖曳超過容許位移：平移（或捲動）開始，收起輕點的價格資訊
            g.tap = false;
            hideTapRef.current(true);
        }
        const press = pressRef.current;
        if (!press || trackingRef.current) return;
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP_PX) clearPress();
    };
    /** released＝pointerup（pointercancel 不算輕點） */
    const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>, released: boolean) => {
        pointersRef.current.delete(e.pointerId ?? 0);
        const g = gestureRef.current;
        gestureRef.current = null;
        if (released && g && (g.tap || g.held) && !trackingRef.current) {
            // 輕點：只釘住十字線與價格資訊，不開選價列、不開下單面板；
            // 長按看價格（長按選價下單關閉）：釘在放開的那一根（不切換、不收起）
            try {
                const rect = hostRef.current?.getBoundingClientRect();
                if (rect && g.held) tapRef.current(e.clientX - rect.left, e.clientY - rect.top, false);
                else if (rect) tapRef.current(g.x - rect.left, g.y - rect.top);
            } catch {
                // 圖表 API 差異不能讓頁面掛掉
            }
        }
        clearPress();
        if (!trackingRef.current) return;
        trackingRef.current = false;
        const raw = crossPriceRef.current;
        crossPriceRef.current = null;
        if (raw === null) return;
        const price = roundToTick(contractRef.current, raw);
        if (Number.isFinite(price) && price > 0 && pricePickRef.current) setPick(price);
    };

    const pickText = pick !== null ? formatToTick(contract, pick) : '';
    /** 使用者關閉選價列（選了買賣或取消）：沿原路收回；換商品、週期、重新長按則直接移除 */
    const dismissPick = () => {
        if (pick !== null) setPickClosing(pickText);
        setPick(null);
    };
    useEffect(() => {
        if (pickClosing === null) return undefined;
        const t = setTimeout(() => setPickClosing(null), styles.PICK_EXIT_MS);
        return () => clearTimeout(t);
    }, [pickClosing]);
    // 選價列出現（一般模式）：捲到 main 的可見範圍內，停在底部 chrome 之上（scroll-padding-bottom）。
    // 量沒有 transform 的外層，進場的 translateY(100%) 不會讓它多捲；減少動態時不平滑。jsdom 等沒有 scrollIntoView 時不做事。
    const pickOpen = pick !== null;
    useEffect(() => {
        if (!pickOpen || fullscreen) return;
        const anchor = pickAnchorRef.current;
        if (!anchor || typeof anchor.scrollIntoView !== 'function') return;
        anchor.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }, [pickOpen, fullscreen]);
    const choose = (action: 'Buy' | 'Sell') => {
        if (pick === null || !pricePickRef.current) return;
        openTicket({ code, action, price: pick, source: 'chart' });
        dismissPick();
    };

    const tradable = secType !== 'IND' && !contract.combo;
    const mainLegend = legend.filter(l => l.pane === 0 || paneTops[l.pane] === undefined);
    // 同一個副圖可能有好幾組（買賣力：外內、外盤比、累積淨）：同一個副圖放在同一個圖例容器裡換行
    const paneLegends = new Map<number, LegendEntry[]>();
    for (const l of legend) {
        if (l.pane > 0 && paneTops[l.pane] !== undefined) paneLegends.set(l.pane, [...(paneLegends.get(l.pane) ?? []), l]);
    }
    const frameClass = fullscreen ? cs.frameFullscreen : cs.frame[(Math.min(paneCount, 3)) as 0 | 1 | 2 | 3];
    const periodLabel = CHART_PERIODS.find(p => p.key === period)?.label ?? '';

    const renderLegend = (entries: LegendEntry[], top?: number, withReadout = false) => (
        <div className={cs.legend} style={top !== undefined ? { top: `${top + 4}px` } : undefined} data-testid='chart-legend' aria-live='off'>
            {withReadout && <ReadoutLine store={readout} onClose={() => hideTapRef.current(true)} />}
            {withReadout && limitActive && (
                <button
                    type='button'
                    className={cs.rangeBadge}
                    aria-pressed='true'
                    aria-label='漲跌停範圍（點一下回到自動範圍）'
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => setLimitRange(false)}
                    data-testid='chart-range-badge'
                >
                    漲跌停範圍
                </button>
            )}
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
                    {l.note && <span data-testid='chart-legend-note'> {l.note}</span>}
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
                    <FullscreenStatusPill />
                    <div className={cs.fsPeriods}>
                        {/* 全螢幕上列空間窄（直向手動全螢幕只剩約一半寬）：用可橫向捲動的膠囊，不用等寬 thumb（會擠成文字重疊） */}
                        {onPeriodChange
                            ? <Segmented items={PERIOD_ITEMS} value={period} onChange={onPeriodChange} semantics='toggle' ariaLabel='圖表週期' size='compact' variant='scroll' />
                            : <span className={cs.fsTitle}>{periodLabel}</span>}
                    </div>
                    <Chip label='指標' className={cs.toolButton} onClick={() => setSheetOpen(true)} testId='chart-indicators' />
                    <button type='button' className={cs.exitButton} onClick={exitFullscreen} data-testid='chart-fs-exit'>退出全螢幕</button>
                </div>
            )}
            <div
                className={frameClass}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={e => onPointerEnd(e, true)}
                onPointerCancel={e => onPointerEnd(e, false)}
                onContextMenu={e => e.preventDefault()}
                // 走勢不縮放：不放行雙指（平台手勢防護照常擋下，頁面也不會被捏合縮放）
                data-allow-pinch={isLine ? undefined : 'true'}
                data-testid='trade-chart'
            >
                <div ref={hostRef} className={styles.chartHost} />
                {renderLegend(mainLegend, undefined, true)}
                {[...paneLegends].map(([p, ls]) => <div key={p}>{renderLegend(ls, paneTops[p])}</div>)}
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
                    <div ref={pickAnchorRef} className={styles.pickAnchor}>
                        <div className={styles.pickBar} role='dialog' aria-label={`以 ${pickText} 下單`} data-testid='chart-pick'>
                            <button type='button' className={styles.pickButton.buy} onClick={() => choose('Buy')}>以 {pickText} 買進</button>
                            <button type='button' className={styles.pickButton.sell} onClick={() => choose('Sell')}>以 {pickText} 賣出</button>
                            <button type='button' className={styles.pickButton.cancel} onClick={dismissPick} aria-label='取消'>取消</button>
                        </div>
                    </div>
                )}
                {pick === null && pickClosing !== null && (
                    <div className={styles.pickAnchor}>
                        <div className={styles.pickBarClosing} aria-hidden='true' inert data-testid='chart-pick-closing'>
                            <span className={styles.pickButton.buy}>以 {pickClosing} 買進</span>
                            <span className={styles.pickButton.sell}>以 {pickClosing} 賣出</span>
                            <span className={styles.pickButton.cancel}>取消</span>
                        </div>
                    </div>
                )}
            </div>
            {!fullscreen && (
                <div className={cs.toolRow}>
                    <p className={cs.toolNote}>
                        {chartToolNote(isLine, hasLimitRange(contract), period === '1D', pricePick)}
                    </p>
                    <Chip label='指標' className={cs.toolButton} onClick={() => setSheetOpen(true)} testId='chart-indicators' />
                    <Chip label='全螢幕' className={cs.toolButton} onClick={enterFullscreen} testId='chart-fs-enter' />
                </div>
            )}
            {fullscreen && tradable && (
                <div className={cs.fsTradeRow}>
                    <button type='button' className={cs.fsTradeButton.buy} onClick={() => openTicket({ code, action: 'Buy', source: 'button' })} data-testid='chart-fs-buy'>買 進</button>
                    <button type='button' className={cs.fsTradeButton.sell} onClick={() => openTicket({ code, action: 'Sell', source: 'button' })} data-testid='chart-fs-sell'>賣 出</button>
                </div>
            )}
            <IndicatorSheet open={sheetOpen} onClose={() => setSheetOpen(false)} lineMode={isLine} lineFlowSupported={lineFlowSupported(contract)} />
        </div>
    );
}

/**
 * 全螢幕（z-index 高於狀態列）會蓋住連線燈號：串流不是 LIVE、或 ResumeGate 不是 ready 時，在頂列顯示狀態膠囊。
 * 文字比照狀態列的連線燈號（ResumeGate 優先，其次串流）；在這裡自寫對應，不從 status-bar 匯入（不同 chunk）。
 * 只在全螢幕時掛載，訂閱跟著元件；連線狀態變化只重繪這顆膠囊，不重繪整張圖。
 */
function FullscreenStatusPill() {
    const stream = useStreamStatus();
    const resume = useResumeGate().state;
    const label = resume === 'resyncing' ? '同步中'
        : resume === 'stale-data' ? '資料過期'
            : resume === 'failed' ? '未恢復'
                : stream === 'live' ? null
                    : stream === 'connecting' ? '連線中'
                        : '中斷';
    if (!label) return null;
    return <span className={`${styles.badge} ${cs.toolButton}`} role='status' data-testid='chart-fs-status'>{label}</span>;
}
