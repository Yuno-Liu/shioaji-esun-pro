// src/mobile/routes/watchlist-page.tsx — 自選（規格 §6.1、§9.1、§9.4；設計規格 §7.2）
//
// - 清單：useWatchlist()（伺服器端清單，與桌面共用）由 MobileShell 的 WatchlistProvider 常駐掛載，
//   這裡以 useMobileWatchlist() 取用；切換分頁再回來不會重新讀取清單（lib/watchlist-context.tsx）。
//   清單切換 serverLists／setActiveList。
// - 行情：**只有可見列**訂閱（IntersectionObserver）。不可見的列不掛載 WatchQuoteProbe，
//   也就不呼叫 useQuote；離開畫面時 probe 卸載，由 src/lib/quote-ownership 在 RELEASE_GRACE_MS（1.5 秒）
//   後才真正退訂，快速捲動來回不會反覆訂閱／退訂。永豐行情訂閱 50 次／5 秒（§9.1）。
// - 重繪：行情 store 已以 50 ms 合併通知；每列再以 WATCH_REPAINT_MS（100 ms）節流重繪（§9.4）。
// - 點一列 → #/trade/:code；長按（或編輯模式的「⋯」鍵）→ 操作面板：開啟交易頁、買進…、賣出…、移到最上、上移、下移、移除。
//   「買進…／賣出…」**只呼叫 openTicket()**（只開下單面板；之後仍需預覽與滑動確認才會送出，設計規格 §10 S1）。
// - 搜尋：search-sheet.tsx（searchProducts(query, 10)）。延遲載入（lib/deferred-modules.ts loadSearchSheet，閒置預載），
//   第一次要求開啟時才掛載；載入失敗以底部面板「載入失敗」＋［重試］顯示。
// - 試撮（tick.simtrade）：比照桌面，代碼旁加「試撮」徽章，不當成真實成交顯示。
// - 分段「自選｜排行」（§13 Phase 3）：排行見 components/ranking-list.tsx（延遲載入），只在「排行」分段掛載時讀取；
//   「排行」分段不掛載自選列，自選列的行情訂閱隨之釋放。分段選擇在模組層保留（切換分頁再回來不變）。
// - 版面（設計規格 §7.2，依使用者參考圖改版）：PageHeader（搜尋）；Segmented tabs（自選｜排行）；
//   多個清單時清單分頁（Segmented scroll 變體，選中的自動捲進可見範圍）；
//   表頭「名稱｜指標切換鍵（watch-metric-toggle）｜編輯（watch-edit）」，都在表頭、不在列按鈕內（避免巢狀互動）；
//   列 64px：名稱／代碼＋市場標記＋徽章（試撮、處置）｜成交價／「漲跌 漲跌幅」或總量（純文字、漲跌色）｜迷你走勢｜快速下單鍵。
//   載入 Skeleton、空清單 EmptyState、錯誤 InlineNote。
// - 迷你走勢（使用者明確要求，有限制地做）：只為可見列讀取目前（或最近一段）交易時段的 1 分 K，模組層快取每檔每段一次
//   （盤中讀過的收盤後補讀一次）、佇列同時 2 個，即時成交以分鐘為桶接在尾段（lib/watch-sparkline-data.ts）；
//   帳戶頁「顯示」可關閉，關閉時不掛載走勢欄、不發 K 線請求。指數、組合商品顯示空白佔位。
//   窄螢幕（視窗寬 ≤400px，matchMedia）且字級「大」（1.3）時也不顯示，與關閉相同：不掛載、不請求、不排 rAF、
//   不留空白佔位（各列一致改為「名稱｜數字」），讓出寬度給名稱欄，第二行代碼與市場標記不截斷（sparkFitsRow）。
//   延遲載入（lib/deferred-modules.ts loadWatchSparkline，閒置預載）；只有可見列掛載 canvas（不可見列沒有點陣、不排 rAF），
//   不可見、載入中、載入失敗都是同尺寸空白佔位；載入失敗後列下次變為可見時重新 import。
// - 處置徽章：lib/regulatory-punish.ts（自選頁顯示清單且含股票時才讀，最多每 30 分鐘一次，失敗靜默）。
// - 快速下單鍵（watch-row-ticket）：列尾的兄弟節點（不在列按鈕內，不觸發開交易頁或長按），只呼叫
//   openTicket({ code, source: 'other' })（不帶方向；之後仍需預覽與滑動確認，設計規格 §10 S1）。指數、組合商品不顯示，
//   改放同寬的 aria-hidden 空白佔位（watch-row-ticket-spacer），各列的價格欄與走勢欄對齊；編輯模式改顯示「⋯」。
// - 表頭編輯鍵的無障礙名稱包含可見文字（WCAG 2.5.3）：「編輯」→「編輯自選」、「完成」→「完成編輯」。
// - 底部指數列（components/watch-index-strip.tsx）：ShellSlot bottom，加權／櫃買，點按只 navigate；
//   沒有即時指數時以快照（自選頁掛載時讀，最多每 INDEX_SNAPSHOT_TTL_MS 一次）顯示收盤值。
//   以 ContractBase 直接訂閱 Quote（retainContractQuotes），不經 useQuote → ensureContract，沒有合約解析 GET。
// - 進入本頁的請求（清單本身由 WatchlistProvider 常駐讀取，不在此列）：
//   處置清單 GET ≤1（含股票時，30 分鐘最多 1 次）；指數快照 POST ≤1（10 分鐘最多 1 次）；合約解析 0
//   （列的合約由 useWatchlist 預先放進快取，指數不經解析）；Quote 訂閱＝指數 2 筆＋每個可見列 Tick、BidAsk 各 1 筆；
//   K 線 POST 每個可見可交易列 ≤1（假日補找時 2，同時 2 個，每檔每段讀過即快取）；走勢 chunk 1 個（通常已閒置預載）。

import { ArrowLeftRight, ChevronsUpDown, MoreHorizontal, Pencil, Search, Star } from 'lucide-react';
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useQuote, type PriceQuoteState } from '../../hooks/use-stream';
import type { WatchItem } from '../../hooks/use-watchlist';
import { neighborCode } from '../../lib/list-move';
import type { ProductSuggestion } from '../../lib/product-search';
import { useThemeSettings } from '../../lib/theme-store';
import type { ContractInfo } from '../../lib/types/contract';
import type { Snapshot } from '../../lib/types/market';
import { fmtCompactInt, fmtPct, fmtPrice } from '../../lib/utils/format';
import { BottomSheet } from '../components/bottom-sheet';
import { ModuleErrorBoundary, ModuleLoadError, retryableLazy, SheetLoadError } from '../components/route-error-boundary';
import { WatchIndexStrip } from '../components/watch-index-strip';
import { useMediaQuery } from '../hooks/use-media-query';
import { loadRankingList, loadSearchSheet, loadWatchSparkline } from '../lib/deferred-modules';
import { navigate } from '../lib/hash-router';
import { openTicket } from '../lib/mobile-store';
import { usePunishedCodes } from '../lib/regulatory-punish';
import { useWatchSparklineEnabled } from '../lib/watch-prefs';
import { useMobileWatchlist } from '../lib/watchlist-context';
import { haptic } from '../motion/haptics';
import { fill, focusRing, pressable, pressableRow } from '../styles/primitives.css';
import * as styles from '../styles/watchlist.css';
import { EmptyState } from '../ui/empty-state';
import { GroupedSection, ListRow } from '../ui/grouped';
import { IconButton } from '../ui/icon-button';
import { InlineNote } from '../ui/inline-note';
import { PageHeader } from '../ui/page-header';
import { usePriceFlash } from '../ui/price-flash';
import * as flashStyles from '../ui/price-flash.css';
import { Segmented } from '../ui/segmented';
import { ShellSlot } from '../ui/shell-slots';
import { Skeleton } from '../ui/skeleton';

/** 每列重繪節流（ms）：≤ 10 fps */
export const WATCH_REPAINT_MS = 100;
/** 長按門檻（ms） */
export const LONG_PRESS_MS = 500;
/** 長按期間手指移動超過這個距離（px）視為捲動，取消長按 */
export const LONG_PRESS_MOVE_PX = 10;
/** 可見範圍上下各預先多算的距離：捲動時提早訂閱，避免空白價格 */
export const VISIBILITY_ROOT_MARGIN = '160px 0px';
/** 瀏覽器沒有 IntersectionObserver 時，只讓前幾列訂閱（避免整份清單全部訂閱） */
export const FALLBACK_VISIBLE_ROWS = 20;

// ---------------------------------------------------------------------------
// 價格與漲跌（與桌面 src/components/watchlist.tsx 相同規則）

export interface RowQuoteView {
    close?: number;
    chg?: number;
    pct?: number;
    dir: 'up' | 'down' | 'flat';
    /** 試撮揭示價（不是真實成交）：列上顯示「試撮」徽章 */
    simtrade: boolean;
    /** 總量（股票、期權為張／口；指數不顯示） */
    vol?: number;
}

/**
 * 即時 tick／指數優先，沒有時退回快照收盤。
 * 不使用 tick.pct_chg（股票與期權串流的單位不同），一律由漲跌與參考價推算。
 */
export function rowQuoteView(contract: Pick<ContractInfo, 'reference'> & Partial<Pick<ContractInfo, 'security_type'>>, snapshot: Snapshot | undefined, quote: PriceQuoteState | undefined): RowQuoteView {
    const tick = quote?.tick;
    const index = quote?.index;
    const close = tick ? Number(tick.close) : index ? Number(index.close) : snapshot?.close;
    const ref = index ? Number(index.reference) : contract.reference;
    const chg = tick?.price_chg
        ? Number(tick.price_chg)
        : index
            ? Number(index.close) - Number(index.reference)
            : close !== undefined && ref
                ? close - ref
                : undefined;
    const pct = chg !== undefined && ref ? (chg / ref) * 100 : snapshot?.change_rate;
    const dir = chg === undefined || !Number.isFinite(chg) || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down';
    const vol = index || contract.security_type === 'IND' ? undefined : tick ? Number(tick.total_volume) : snapshot?.total_volume;
    return {
        close: close !== undefined && Number.isFinite(close) ? close : undefined,
        chg: chg !== undefined && Number.isFinite(chg) ? chg : undefined,
        pct: pct !== undefined && Number.isFinite(pct) ? pct : undefined,
        dir,
        simtrade: tick?.simtrade === true,
        vol: vol !== undefined && Number.isFinite(vol) && vol >= 0 ? vol : undefined,
    };
}

const ARROW: Record<RowQuoteView['dir'], string> = { up: '▲', down: '▼', flat: '' };
const DIR_TEXT: Record<RowQuoteView['dir'], string> = { up: '漲', down: '跌', flat: '平盤' };
/** 試撮徽章文字 */
export const SIM_LABEL = '試撮';
/** 處置徽章文字 */
export const PUNISH_LABEL = '處置';

// ---------------------------------------------------------------------------
// 市場標記（列第二行代碼後）

export type MarketTag = '市' | '櫃' | '興' | '期' | '權' | '指';

const MARKET_FULL: Readonly<Record<MarketTag, string>> = { 市: '上市', 櫃: '上櫃', 興: '興櫃', 期: '期貨', 權: '選擇權', 指: '指數' };

/** 上市→市、上櫃→櫃、興櫃→興、期貨→期、選擇權→權、指數→指（依 security_type，股票與權證依 exchange）；無法判斷時 null */
export function marketTag(c: Pick<ContractInfo, 'security_type' | 'exchange'>): MarketTag | null {
    switch (c.security_type) {
        case 'IND': return '指';
        case 'FUT': return '期';
        case 'OPT': return '權';
        default:
            return c.exchange === 'TSE' ? '市' : c.exchange === 'OTC' ? '櫃' : c.exchange === 'OES' ? '興' : null;
    }
}

/** 指數與組合商品不能下單（操作面板「買進…／賣出…」、快速下單鍵都不提供；迷你走勢顯示空白佔位） */
export function tradableContract(c: Pick<ContractInfo, 'security_type'> & { combo?: unknown }): boolean {
    return c.security_type !== 'IND' && !c.combo;
}

/** 窄螢幕：字級「大」時列寬放不下走勢（名稱約 120＋數字約 140＋走勢 40＋下單鍵 44＋內距約 32 ≈ 376px） */
export const NARROW_WATCH_QUERY = '(max-width: 400px)';
/** 字級「大」（theme-store FontScale；殼層寫入 html[data-sj-font-scale]） */
export const LARGE_FONT_SCALE = 1.3;

/** 迷你走勢是否放得下：窄螢幕且字級「大」時不放（讓出寬度，代碼不截斷） */
export function sparkFitsRow(fontScale: number, narrow: boolean): boolean {
    return !(narrow && fontScale === LARGE_FONT_SCALE);
}

/** 讓 item 完整露出時捲動容器 scrollLeft 需要的位移（px；已完整可見時 0）。純函式，供清單分頁自動捲動與測試 */
export function revealDelta(container: { left: number; right: number }, item: { left: number; right: number }, pad = 8): number {
    if (item.left < container.left) return item.left - container.left - pad;
    if (item.right > container.right) return item.right - container.right + pad;
    return 0;
}

// ---------------------------------------------------------------------------
// 可見列追蹤（整頁共用一個 IntersectionObserver）

export interface VisibilityTracker {
    /** false：瀏覽器沒有 IntersectionObserver */
    readonly supported: boolean;
    /** 開始追蹤一個元素；回傳停止追蹤 */
    observe(el: Element, onChange: (visible: boolean) => void): () => void;
    disconnect(): void;
}

type IoCtor = new (cb: (entries: { target: Element; isIntersecting: boolean }[]) => void, opts?: { root?: Element | null; rootMargin?: string }) => {
    observe(el: Element): void;
    unobserve(el: Element): void;
    disconnect(): void;
};

export function createVisibilityTracker(): VisibilityTracker {
    const IO = (globalThis as { IntersectionObserver?: IoCtor }).IntersectionObserver;
    if (typeof IO !== 'function') {
        return { supported: false, observe: () => () => undefined, disconnect: () => undefined };
    }
    const callbacks = new Map<Element, (visible: boolean) => void>();
    const io = new IO(entries => {
        for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
    }, { root: null, rootMargin: VISIBILITY_ROOT_MARGIN });
    return {
        supported: true,
        observe(el, onChange) {
            callbacks.set(el, onChange);
            io.observe(el);
            return () => {
                callbacks.delete(el);
                io.unobserve(el);
            };
        },
        disconnect() {
            callbacks.clear();
            io.disconnect();
        },
    };
}

function useRowVisible(ref: { current: Element | null }, tracker: VisibilityTracker | null, fallbackVisible: boolean): boolean {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        if (!tracker) return;
        if (!tracker.supported) {
            setVisible(fallbackVisible);
            return;
        }
        const el = ref.current;
        if (!el) return;
        return tracker.observe(el, setVisible);
    }, [ref, tracker, fallbackVisible]);
    return visible;
}

// ---------------------------------------------------------------------------
// 節流

/** 值可以隨時 push；畫面最多每 ms 毫秒更新一次（取最後一個值） */
function useThrottledValue<T>(initial: T, ms: number): [T, (next: T) => void] {
    const [value, setValue] = useState(initial);
    const pending = useRef<{ value: T } | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const last = useRef(0);
    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
    }, []);
    const push = useCallback((next: T) => {
        pending.current = { value: next };
        if (timer.current) return;
        const wait = Math.max(0, last.current + ms - Date.now());
        timer.current = setTimeout(() => {
            timer.current = null;
            last.current = Date.now();
            const p = pending.current;
            pending.current = null;
            if (p) setValue(() => p.value);
        }, wait);
    }, [ms]);
    return [value, push];
}

/**
 * 只在列可見時掛載：呼叫 useQuote(code, { narrow: true })，把行情交給列（列自行節流重繪）。
 * 本身不渲染任何東西，行情每次更新只喚醒這個空元件。
 */
export function WatchQuoteProbe({ code, onQuote }: { code: string; onQuote: (q: PriceQuoteState | undefined) => void }) {
    const quote = useQuote(code, { narrow: true });
    useEffect(() => { onQuote(quote); }, [quote, onQuote]);
    return null;
}

// ---------------------------------------------------------------------------
// 列右側指標（表頭切換鍵循環；存 localStorage）

/** pct：第二行顯示「漲跌 漲跌幅」；vol：第二行顯示總量 */
export type WatchMetric = 'pct' | 'vol';

export const WATCH_METRICS: readonly WatchMetric[] = ['pct', 'vol'];
export const WATCH_METRIC_LABEL: Readonly<Record<WatchMetric, string>> = { pct: '漲跌幅', vol: '總量' };
/** localStorage 鍵（per-device 偏好；讀寫失敗只在本次有效） */
export const WATCH_METRIC_KEY = 'sj-mobile-watch-metric';

function readMetric(): WatchMetric {
    try {
        const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(WATCH_METRIC_KEY);
        // 舊版的 'chg'（只顯示漲跌）併入 'pct'：第二行已同時顯示漲跌與漲跌幅
        return v === 'vol' ? 'vol' : 'pct';
    } catch {
        return 'pct';
    }
}

function writeMetric(m: WatchMetric): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(WATCH_METRIC_KEY, m);
    } catch {
        // 無法寫入時只在本次有效
    }
}

/** 下一個指標（漲跌幅 → 總量 → 漲跌幅） */
export function nextWatchMetric(m: WatchMetric): WatchMetric {
    return WATCH_METRICS[(WATCH_METRICS.indexOf(m) + 1) % WATCH_METRICS.length]!;
}

// ---------------------------------------------------------------------------
// 列

interface WatchRowProps {
    item: WatchItem;
    index: number;
    tracker: VisibilityTracker | null;
    editing: boolean;
    metric: WatchMetric;
    /** 顯示迷你走勢：設定開啟且放得下（否則不掛載走勢欄、不請求、不留佔位） */
    spark: boolean;
    punished: boolean;
    onOpen: (code: string) => void;
    onActions: (code: string) => void;
    onTicket: (code: string) => void;
}

// 迷你走勢延遲載入（首屏體積）：components/watch-sparkline.tsx 與 lib/watch-sparkline-data.ts 不進首屏 chunk，
// 閒置時由 app.tsx 預載。走勢欄只在列可見時掛載 WatchSparkCell（canvas、點陣、rAF、K 線 retain 都只屬於可見列）；
// 不可見、載入中、載入失敗都是同尺寸的空白佔位（aria-hidden，不顯示錯誤字樣，不影響列與頁面）。
const WatchSparkCell = retryableLazy(() => loadWatchSparkline().then(m => m.WatchSparkCell), 'WatchSparkCell');

export type SparkSlotState = 'na' | 'hidden' | 'loading' | 'failed';

function SparkPlaceholder({ state }: { state: SparkSlotState }) {
    return <span className={styles.spark} aria-hidden='true' data-testid='watch-spark-blank' data-spark={state} />;
}

const sparkLoadFailed = () => <SparkPlaceholder state='failed' />;

/**
 * 可見列的走勢欄：列每次變為可見都重新掛載。上次載入失敗時，掛載當下（子樹渲染前）換新的 lazy，
 * 這次就會重新 import（retryableLazy.reset 只在失敗後才換新；多列同時可見時只有第一列換新、其餘共用同一次載入）。
 */
function VisibleSpark({ item, tick }: { item: WatchItem; tick: PriceQuoteState['tick'] }) {
    useState(() => WatchSparkCell.reset());
    return (
        <ModuleErrorBoundary fallback={sparkLoadFailed}>
            <Suspense fallback={<SparkPlaceholder state='loading' />}>
                <WatchSparkCell contract={item.contract} reference={item.contract.reference || undefined} tick={tick} />
            </Suspense>
        </ModuleErrorBoundary>
    );
}

const WatchRow = memo(function WatchRow({ item, index, tracker, editing, metric, spark, punished, onOpen, onActions, onTicket }: WatchRowProps) {
    const code = item.contract.code;
    const name = item.contract.name ?? '';
    const tag = marketTag(item.contract);
    const tradable = tradableContract(item.contract);
    const ref = useRef<HTMLLIElement | null>(null);
    const flashRef = useRef<HTMLSpanElement | null>(null);
    const visible = useRowVisible(ref, tracker, index < FALLBACK_VISIBLE_ROWS);
    const [quote, pushQuote] = useThrottledValue<PriceQuoteState | undefined>(undefined, WATCH_REPAINT_MS);
    const view = rowQuoteView(item.contract, item.snapshot, quote);
    // 跳價閃爍：快照 → 即時的那一筆不閃（來源切換）；只閃可見格（price-flash 內共用 IntersectionObserver）
    usePriceFlash(flashRef, view.close, { source: quote ? 'live' : 'snapshot', enabled: visible });

    // 長按：LONG_PRESS_MS 不放開且未移動 → 操作面板；長按後的 click 不開交易頁
    const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
    const longPressed = useRef(false);
    const clearPress = () => {
        if (press.current) clearTimeout(press.current.timer);
        press.current = null;
    };
    useEffect(() => clearPress, []);
    const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
        clearPress();
        longPressed.current = false;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        press.current = {
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            timer: setTimeout(() => {
                press.current = null;
                longPressed.current = true;
                haptic('longPress');
                onActions(code);
            }, LONG_PRESS_MS),
        };
    };
    const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
        const p = press.current;
        if (!p || p.id !== e.pointerId) return;
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_MOVE_PX) clearPress();
    };

    const priceText = view.close !== undefined ? fmtPrice(view.close) : '—';
    const chgText = view.chg !== undefined ? `${ARROW[view.dir]}${fmtPrice(Math.abs(view.chg))}` : '—';
    const pctText = view.pct !== undefined ? fmtPct(view.pct) : '';
    const volText = view.vol !== undefined ? fmtCompactInt(view.vol) : '';
    // 第二行：漲跌（帶正負號）＋漲跌幅，或總量；純文字
    const signedChg = view.chg !== undefined ? `${view.chg > 0 ? '+' : ''}${fmtPrice(view.chg)}` : '';
    const changeText = metric === 'vol'
        ? (volText || '—')
        : ([signedChg, pctText].filter(Boolean).join(' ') || '—');
    // 總量沒有方向；數值缺少時也不著色
    const changeTone: RowQuoteView['dir'] = metric === 'vol' || changeText === '—' ? 'flat' : view.dir;
    const ariaLabel = `${code} ${name}${tag ? ` ${MARKET_FULL[tag]}` : ''}，${view.simtrade ? `${SIM_LABEL} ` : ''}${priceText}，${DIR_TEXT[view.dir]} ${chgText} ${pctText}`.trim()
        + (volText ? `，總量 ${volText}` : '')
        + (punished ? `，${PUNISH_LABEL}股` : '');
    const showTicket = tradable && !editing;
    // 指數、組合商品沒有快速下單鍵：放同寬的空白佔位，價格欄與走勢欄才和其他列對齊
    const ticketSpacer = !tradable && !editing;

    return (
        <li ref={ref} className={styles.rowItem} data-code={code} data-testid='watch-row' data-visible={visible ? 'true' : 'false'}>
            <button
                type='button'
                className={`${styles.row} ${spark ? styles.rowWithSpark : styles.rowNoSpark} ${pressableRow} ${styles.rowHasTrailing}`}
                aria-label={ariaLabel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={clearPress}
                onPointerCancel={clearPress}
                onPointerLeave={clearPress}
                onContextMenu={e => {
                    // Android 長按與滑鼠右鍵都會觸發 contextmenu：不開系統選單，改開操作面板（只開一次）
                    e.preventDefault();
                    const already = longPressed.current;
                    clearPress();
                    longPressed.current = true;
                    if (!already) {
                        haptic('longPress');
                        onActions(code);
                    }
                }}
                onClick={() => {
                    if (longPressed.current) {
                        longPressed.current = false;
                        return;
                    }
                    onOpen(code);
                }}
                data-testid='watch-row-button'
            >
                <span className={styles.rowName}>
                    <span className={styles.rowTitle} data-testid='watch-name'>{name || code}</span>
                    <span className={styles.rowMeta}>
                        {/* 代碼＋市場標記同一組、不縮不換行；放不下時只有後面的徽章換行 */}
                        <span className={styles.rowMetaKey}>
                            <span className={styles.rowMetaCode} data-testid='watch-code'>{code}</span>
                            {tag && <span className={styles.marketTag} data-testid='watch-market'>{tag}</span>}
                        </span>
                        {view.simtrade && <span className={styles.simBadge} data-testid='watch-simtrade'>{SIM_LABEL}</span>}
                        {punished && <span className={styles.punishBadge} data-testid='watch-punish'>{PUNISH_LABEL}</span>}
                    </span>
                </span>
                <span className={styles.priceCell}>
                    <span className={`${styles.rowPrice} ${styles.rowPriceLarge} ${flashStyles.host} ${styles.tone[view.dir]}`}>
                        <span ref={flashRef} className={flashStyles.overlay} aria-hidden='true' />
                        <span data-testid='watch-price'>{priceText}</span>
                    </span>
                    <span className={`${styles.rowChange} ${styles.tone[changeTone]}`} data-testid='watch-change' data-metric={metric}>{changeText}</span>
                </span>
                {spark && (!tradable
                    ? <SparkPlaceholder state='na' />
                    : visible
                        ? <VisibleSpark item={item} tick={quote?.tick} />
                        : <SparkPlaceholder state='hidden' />)}
            </button>
            {visible && <WatchQuoteProbe code={code} onQuote={pushQuote} />}
            {showTicket && (
                <span className={styles.rowTrailing}>
                    <IconButton ariaLabel={`下單 ${code} ${name}`.trim()} icon={ArrowLeftRight} onClick={() => onTicket(code)} testId='watch-row-ticket' />
                </span>
            )}
            {ticketSpacer && (
                <span className={styles.rowTrailing} aria-hidden='true'>
                    <span className={styles.ticketSpacer} data-testid='watch-row-ticket-spacer' />
                </span>
            )}
            {editing && (
                <span className={styles.rowTrailing}>
                    <IconButton ariaLabel={`${code} 更多操作`} icon={MoreHorizontal} onClick={() => onActions(code)} testId='watch-more' />
                </span>
            )}
        </li>
    );
});

// ---------------------------------------------------------------------------
// 長按操作面板

function RowActionsSheet({ code, items, onClose, onOpen, onRemove, onMove }: {
    code: string | null;
    items: WatchItem[];
    onClose: () => void;
    onOpen: (code: string) => void;
    onRemove: (code: string) => Promise<void>;
    onMove: (from: string, to: string) => void;
}) {
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        setConfirmRemove(false);
        setError(null);
        setBusy(false);
    }, [code]);
    const item = code ? items.find(i => i.contract.code === code) : undefined;
    const codes = items.map(i => i.contract.code);
    const up = code ? neighborCode(codes, code, -1) : null;
    const down = code ? neighborCode(codes, code, 1) : null;
    const top = codes[0] && codes[0] !== code ? codes[0] : null;
    const tradable = item ? tradableContract(item.contract) : false;

    const remove = async () => {
        if (!code) return;
        if (!confirmRemove) {
            setConfirmRemove(true);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onRemove(code);
            onClose();
        } catch (e) {
            setError(e instanceof Error && e.message ? e.message : '移除失敗，請稍後再試');
            setBusy(false);
        }
    };

    /** 只開下單面板（不送單）：面板內仍需預覽 → 確認面板滑動確認 */
    const ticket = (action: 'Buy' | 'Sell') => {
        if (!code) return;
        onClose();
        openTicket({ code, action, source: 'other' });
    };

    return (
        <BottomSheet open={code !== null && item !== undefined} onClose={onClose} title={item ? `${item.contract.code} ${item.contract.name ?? ''}` : ''} testId='watch-actions'>
            {code && (
                <div className={styles.actionSheet}>
                    <GroupedSection>
                        <ListRow title='開啟交易頁' chevron onClick={() => { onOpen(code); onClose(); }} testId='watch-action-open' />
                        {tradable && (
                            <ListRow
                                title='買進…'
                                leading={<span className={`${styles.sideBadge} ${fill.up.strong}`}>買</span>}
                                disabled={busy}
                                onClick={() => ticket('Buy')}
                                testId='watch-action-buy'
                            />
                        )}
                        {tradable && (
                            <ListRow
                                title='賣出…'
                                leading={<span className={`${styles.sideBadge} ${fill.down.strong}`}>賣</span>}
                                disabled={busy}
                                onClick={() => ticket('Sell')}
                                testId='watch-action-sell'
                            />
                        )}
                    </GroupedSection>
                    <GroupedSection>
                        <ListRow title='移到最上' disabled={!top || busy} onClick={() => top && onMove(code, top)} />
                        <ListRow title='上移' disabled={!up || busy} onClick={() => up && onMove(code, up)} />
                        <ListRow title='下移' disabled={!down || busy} onClick={() => down && onMove(code, down)} />
                    </GroupedSection>
                    <GroupedSection footer={confirmRemove && !busy ? '自選清單與桌面共用，移除後桌面也會看不到。' : undefined}>
                        <button
                            type='button'
                            className={`${styles.dangerRow} ${pressableRow} ${focusRing}`}
                            disabled={busy}
                            onClick={() => void remove()}
                            data-testid='watch-remove'
                        >
                            {busy ? '移除中…' : confirmRemove ? `確定從自選移除 ${code}` : '從自選移除'}
                        </button>
                    </GroupedSection>
                    {error && <InlineNote tone='danger' role='alert'>{error}</InlineNote>}
                </div>
            )}
        </BottomSheet>
    );
}

// ---------------------------------------------------------------------------
// 頁面

export type WatchSegment = 'watchlist' | 'ranking';

// 排行只在「排行」分段才用到：延遲載入（規格 §13 首次載入體積），閒置時由 app.tsx 預載。
// 載入失敗只在分段內容區顯示「載入失敗」＋［重試］（retryableLazy 換新的 lazy 重新 import）。
const RankingList = retryableLazy(() => loadRankingList().then(m => m.RankingList), 'RankingList');
const resetRankingList = () => { RankingList.reset(); };

// 搜尋面板只在按「搜尋」（或空清單的「搜尋並加入」）後才用到：延遲載入（連同 lib/product-search 約 4 KiB gzip），
// 閒置時由 app.tsx 預載。第一次要求開啟時才掛載、之後保持掛載（面板開關動畫正常；同 app.tsx 的下單面板）。
// 載入失敗以底部面板顯示「載入失敗」＋［重試］（SheetLoadError），可關閉，不影響頁面。
const SearchSheet = retryableLazy(() => loadSearchSheet().then(m => m.SearchSheet), 'SearchSheet');
const resetSearchSheet = () => { SearchSheet.reset(); };

const SEGMENTS = [
    { value: 'watchlist', label: '自選', testId: 'watch-segment-watchlist' },
    { value: 'ranking', label: '排行', testId: 'watch-segment-ranking' },
] as const satisfies readonly { value: WatchSegment; label: string; testId: string }[];

/** 上次選的分段（切換分頁再回來保留） */
let lastSegment: WatchSegment = 'watchlist';

/** 測試用：分段回到「自選」 */
export function resetWatchlistSegmentForTest(): void {
    lastSegment = 'watchlist';
}

export function WatchlistPage() {
    const wl = useMobileWatchlist();
    const [tracker, setTracker] = useState<VisibilityTracker | null>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    /** 搜尋面板第一次要求開啟後保持掛載 */
    const [searchMounted, setSearchMounted] = useState(false);
    const [editing, setEditing] = useState(false);
    const [actionCode, setActionCode] = useState<string | null>(null);
    const [segment, setSegmentState] = useState<WatchSegment>(lastSegment);
    const [metric, setMetricState] = useState<WatchMetric>(readMetric);
    const setSegment = useCallback((next: WatchSegment) => {
        lastSegment = next;
        setSegmentState(next);
        if (next === 'ranking') setEditing(false);
    }, []);
    const cycleMetric = useCallback(() => {
        setMetricState(m => {
            const next = nextWatchMetric(m);
            writeMetric(next);
            return next;
        });
    }, []);

    useEffect(() => {
        const t = createVisibilityTracker();
        setTracker(t);
        return () => t.disconnect();
    }, []);

    const openTrade = useCallback((code: string) => {
        navigate({ name: 'trade', code });
    }, []);
    const openActions = useCallback((code: string) => setActionCode(code), []);
    const openSearch = useCallback(() => {
        setSearchMounted(true);
        setSearchOpen(true);
    }, []);
    const closeSearch = useCallback(() => setSearchOpen(false), []);
    /** 列尾快速下單鍵：只開下單面板、不帶方向（S1：之後仍需預覽與滑動確認） */
    const quickTicket = useCallback((code: string) => { openTicket({ code, source: 'other' }); }, []);

    const watchedCodes = useMemo(() => new Set(wl.items.map(i => i.contract.code)), [wl.items]);
    const { addSymbol, removeSymbol, reorderSymbol } = wl;
    const onAdd = useCallback(async (s: ProductSuggestion) => {
        await addSymbol(s.code, s.security_type, s.contract);
    }, [addSymbol]);
    const onRemove = useCallback(async (code: string) => { await removeSymbol(code); }, [removeSymbol]);
    // 排行都是上市櫃股票：以 STK 解析合約後加入目前清單
    const onAddRanked = useCallback(async (code: string) => { await addSymbol(code, 'STK'); }, [addSymbol]);
    const canAdd = !wl.loading && !wl.structureBusy && !wl.loadError;

    const activeList = wl.serverLists.find(l => l.id === wl.activeListId);
    const ranking = segment === 'ranking';
    const showList = !ranking && wl.items.length > 0;
    const metricLabel = WATCH_METRIC_LABEL[metric];
    // 走勢欄：設定開啟且放得下才掛載（窄螢幕＋字級「大」時與設定關閉相同：不掛載、不請求、不留佔位）
    const sparkEnabled = useWatchSparklineEnabled();
    const { fontScale } = useThemeSettings();
    const narrow = useMediaQuery(NARROW_WATCH_QUERY);
    const spark = sparkEnabled && sparkFitsRow(fontScale, narrow);
    // 處置清單：只在顯示自選列且清單含股票時讀取（受 30 分鐘間隔限制）
    const hasStocks = useMemo(() => wl.items.some(i => i.contract.security_type === 'STK'), [wl.items]);
    const punished = usePunishedCodes(showList && hasStocks);
    const showListTabs = !ranking && wl.serverLists.length > 1;

    // 清單分頁：選中的那個自動捲進可見範圍（只動水平 scrollLeft，不捲動頁面）
    const listTabsRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const root = listTabsRef.current;
        if (!showListTabs || !root || typeof root.querySelector !== 'function') return;
        const scroller = root.querySelector<HTMLElement>('[role="tablist"]');
        const selected = root.querySelector<HTMLElement>('[aria-selected="true"]');
        if (!scroller || !selected) return;
        const delta = revealDelta(scroller.getBoundingClientRect(), selected.getBoundingClientRect());
        if (delta !== 0) scroller.scrollLeft += delta;
    }, [showListTabs, wl.activeListId, wl.serverLists.length]);

    return (
        <section className={styles.page} data-testid='page-watchlist'>
            <PageHeader
                title='自選'
                actions={(
                    <>
                        <IconButton ariaLabel='搜尋商品' icon={Search} iconSize={22} onClick={openSearch} testId='watch-search' />
                    </>
                )}
            />

            <div className={styles.controls}>
                <Segmented<WatchSegment>
                    items={SEGMENTS}
                    value={segment}
                    onChange={setSegment}
                    semantics='tabs'
                    ariaLabel='自選或排行'
                />
                {ranking ? null : showListTabs ? (
                    <div ref={listTabsRef} className={styles.listTabs}>
                        <Segmented<string>
                            items={wl.serverLists.map(l => ({ value: l.id, label: l.name, testId: `watch-list-tab-${l.id}` }))}
                            value={wl.activeListId}
                            onChange={id => { if (id !== wl.activeListId) wl.setActiveList(id); }}
                            semantics='tabs'
                            variant='scroll'
                            ariaLabel='自選清單'
                            disabled={wl.structureBusy}
                            testId='watch-list-tabs'
                        />
                    </div>
                ) : activeList ? (
                    <p className={styles.listName}>{activeList.name}</p>
                ) : null}
                {!ranking && editing && <p className={styles.listName}>按「⋯」或長按一列可調整順序或移除。</p>}
            </div>

            {ranking && (
                <ModuleErrorBoundary onRetry={resetRankingList} fallback={props => <ModuleLoadError {...props} testId='ranking-load-error' />}>
                    <Suspense fallback={<Skeleton label='排行讀取中…' rows={6} testId='ranking-module-loading' />}>
                        <RankingList watchedCodes={watchedCodes} canAdd={canAdd} onAdd={onAddRanked} onOpen={openTrade} />
                    </Suspense>
                </ModuleErrorBoundary>
            )}

            {!ranking && wl.loadError && (
                <div className={styles.stateBlock}>
                    <InlineNote tone='danger' role='alert' action={{ label: '重試', onClick: () => wl.retryLoad(), testId: 'watch-retry' }}>
                        自選清單載入失敗。
                    </InlineNote>
                </div>
            )}
            {!ranking && !showList && wl.loading && !wl.loadError && <Skeleton label='自選清單載入中…' rows={6} testId='watch-loading' />}
            {!ranking && !showList && !wl.loading && !wl.loadError && (
                <EmptyState
                    icon={Star}
                    title='這份清單還沒有商品。'
                    description='搜尋代碼或名稱加入；自選清單與桌面共用。'
                    action={{ label: '搜尋並加入', onClick: openSearch, testId: 'watch-empty-search' }}
                    testId='watch-empty'
                />
            )}

            {showList && (
                <>
                    <div className={styles.listHeader} data-testid='watch-list-header'>
                        <span className={styles.headerName} aria-hidden='true'>名稱</span>
                        <button
                            type='button'
                            className={`${styles.metricToggle} ${pressable} ${focusRing}`}
                            aria-label={`第二行顯示${metric === 'pct' ? '漲跌與漲跌幅' : metricLabel}，點按切換（漲跌與漲跌幅、總量）`}
                            onClick={cycleMetric}
                            data-testid='watch-metric-toggle'
                            data-metric={metric}
                        >
                            {metricLabel}
                            <ChevronsUpDown className={styles.metricIcon} aria-hidden='true' focusable='false' />
                        </button>
                        <button
                            type='button'
                            className={`${styles.editButton} ${pressable} ${focusRing}`}
                            aria-label={editing ? '完成編輯' : '編輯自選'}
                            aria-pressed={editing}
                            onClick={() => setEditing(v => !v)}
                            data-testid='watch-edit'
                        >
                            <Pencil className={styles.metricIcon} aria-hidden='true' focusable='false' />
                            {editing ? '完成' : '編輯'}
                        </button>
                    </div>
                    <ul className={styles.list} aria-label='自選商品' data-testid='watch-list'>
                        {wl.items.map((item, index) => (
                            <WatchRow
                                key={item.contract.code}
                                item={item}
                                index={index}
                                tracker={tracker}
                                editing={editing}
                                metric={metric}
                                spark={spark}
                                punished={punished.has(item.contract.code)}
                                onOpen={openTrade}
                                onActions={openActions}
                                onTicket={quickTicket}
                            />
                        ))}
                    </ul>
                </>
            )}

            <ModuleErrorBoundary
                onRetry={resetSearchSheet}
                fallback={props => <SheetLoadError {...props} open={searchOpen} onClose={closeSearch} testId='search-load-error' />}
            >
                <Suspense fallback={null}>
                    {searchMounted && (
                        <SearchSheet
                            open={searchOpen}
                            onClose={closeSearch}
                            watchedCodes={watchedCodes}
                            canAdd={canAdd}
                            onAdd={onAdd}
                            onOpenTrade={code => {
                                setSearchOpen(false);
                                openTrade(code);
                            }}
                        />
                    )}
                </Suspense>
            </ModuleErrorBoundary>
            <RowActionsSheet
                code={actionCode}
                items={wl.items}
                onClose={() => setActionCode(null)}
                onOpen={openTrade}
                onRemove={onRemove}
                onMove={reorderSymbol}
            />
            {/* 底部指數列：殼層配件槽（分頁列之上）；只在自選頁掛載時訂閱加權／櫃買 */}
            <ShellSlot slot='bottom'>
                <WatchIndexStrip />
            </ShellSlot>
        </section>
    );
}
