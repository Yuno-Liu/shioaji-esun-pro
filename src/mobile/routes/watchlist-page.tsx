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
// - 搜尋：search-sheet.tsx（searchProducts(query, 10)）。
// - 試撮（tick.simtrade）：比照桌面，代碼旁加「試撮」徽章，不當成真實成交顯示。
// - 分段「自選｜排行」（§13 Phase 3）：排行見 components/ranking-list.tsx（延遲載入），只在「排行」分段掛載時讀取；
//   「排行」分段不掛載自選列，自選列的行情訂閱隨之釋放。分段選擇在模組層保留（切換分頁再回來不變）。
// - 版面（設計規格 §7.2）：PageHeader＋IconButton；Segmented tabs；表頭「商品｜指標切換鍵」（watch-metric-toggle，
//   在表頭不在列按鈕內，避免巢狀互動）；列 56px、價格 PriceFlash、漲跌膠囊（實心 up／down＋inkStrong）；
//   載入 Skeleton、空清單 EmptyState、錯誤 InlineNote。不顯示迷你走勢（不新增任何 K 線請求）。

import { ChevronsUpDown, MoreHorizontal, Pencil, Search, Star } from 'lucide-react';
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useQuote, type PriceQuoteState } from '../../hooks/use-stream';
import type { WatchItem } from '../../hooks/use-watchlist';
import { neighborCode } from '../../lib/list-move';
import type { ProductSuggestion } from '../../lib/product-search';
import type { ContractInfo } from '../../lib/types/contract';
import type { Snapshot } from '../../lib/types/market';
import { fmtCompactInt, fmtPct, fmtPrice } from '../../lib/utils/format';
import { BottomSheet } from '../components/bottom-sheet';
import { ModuleErrorBoundary, ModuleLoadError, retryableLazy } from '../components/route-error-boundary';
import { SearchSheet } from '../components/search-sheet';
import { loadRankingList } from '../lib/deferred-modules';
import { navigate } from '../lib/hash-router';
import { openTicket } from '../lib/mobile-store';
import { useMobileWatchlist } from '../lib/watchlist-context';
import { haptic } from '../motion/haptics';
import { fill, focusRing, pressable, pressableRow } from '../styles/primitives.css';
import * as styles from '../styles/watchlist.css';
import { EmptyState } from '../ui/empty-state';
import { GroupedSection, ListRow } from '../ui/grouped';
import { IconButton } from '../ui/icon-button';
import { InlineNote } from '../ui/inline-note';
import { PageHeader } from '../ui/page-header';
import { PopUpButton } from '../ui/pop-up-button';
import { usePriceFlash } from '../ui/price-flash';
import * as flashStyles from '../ui/price-flash.css';
import { Segmented } from '../ui/segmented';
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

export type WatchMetric = 'pct' | 'chg' | 'vol';

export const WATCH_METRICS: readonly WatchMetric[] = ['pct', 'chg', 'vol'];
export const WATCH_METRIC_LABEL: Readonly<Record<WatchMetric, string>> = { pct: '漲跌幅', chg: '漲跌', vol: '總量' };
/** localStorage 鍵（per-device 偏好；讀寫失敗只在本次有效） */
export const WATCH_METRIC_KEY = 'sj-mobile-watch-metric';

function readMetric(): WatchMetric {
    try {
        const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(WATCH_METRIC_KEY);
        return v === 'pct' || v === 'chg' || v === 'vol' ? v : 'pct';
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

/** 下一個指標（漲跌幅 → 漲跌 → 總量 → 漲跌幅） */
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
    onOpen: (code: string) => void;
    onActions: (code: string) => void;
}

const WatchRow = memo(function WatchRow({ item, index, tracker, editing, metric, onOpen, onActions }: WatchRowProps) {
    const code = item.contract.code;
    const name = item.contract.name ?? '';
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
    const pillText = metric === 'pct' ? (pctText || '—') : metric === 'chg' ? chgText : (volText || '—');
    // 總量沒有方向；數值缺少時也不著色
    const pillTone: RowQuoteView['dir'] = metric === 'vol' || pillText === '—' ? 'flat' : view.dir;
    const pillClass = pillTone === 'flat' ? styles.pill.flat : `${styles.pill[pillTone]} ${fill[pillTone].strong}`;
    const ariaLabel = `${code} ${name}，${view.simtrade ? `${SIM_LABEL} ` : ''}${priceText}，${DIR_TEXT[view.dir]} ${chgText} ${pctText}`.trim()
        + (volText ? `，總量 ${volText}` : '');

    return (
        <li ref={ref} className={styles.rowItem} data-code={code} data-testid='watch-row' data-visible={visible ? 'true' : 'false'}>
            <button
                type='button'
                className={`${styles.row} ${pressableRow}${editing ? ` ${styles.rowEditing}` : ''}`}
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
                    <span className={styles.rowTitleLine}>
                        <span className={styles.rowCode}>{code}</span>
                        {view.simtrade && <span className={styles.simBadge} data-testid='watch-simtrade'>{SIM_LABEL}</span>}
                    </span>
                    <span className={styles.rowSub}>{name}</span>
                </span>
                <span className={`${styles.rowPrice} ${flashStyles.host} ${styles.tone[view.dir]}`}>
                    <span ref={flashRef} className={flashStyles.overlay} aria-hidden='true' />
                    <span data-testid='watch-price'>{priceText}</span>
                </span>
                <span className={pillClass} data-testid='watch-pill' data-metric={metric}>{pillText}</span>
            </button>
            {visible && <WatchQuoteProbe code={code} onQuote={pushQuote} />}
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

/** 指數與組合商品不能下單：操作面板不提供「買進…／賣出…」 */
function tradableContract(c: Pick<ContractInfo, 'security_type' | 'combo'>): boolean {
    return c.security_type !== 'IND' && !c.combo;
}

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
    const openSearch = useCallback(() => setSearchOpen(true), []);

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

    return (
        <section className={styles.page} data-testid='page-watchlist'>
            <PageHeader
                title='自選'
                actions={(
                    <>
                        <IconButton ariaLabel='搜尋商品' icon={Search} iconSize={22} onClick={openSearch} testId='watch-search' />
                        {!ranking && (
                            <IconButton ariaLabel='編輯自選' icon={Pencil} pressed={editing} onClick={() => setEditing(v => !v)} testId='watch-edit' />
                        )}
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
                {ranking ? null : wl.serverLists.length > 1 ? (
                    <PopUpButton
                        className={styles.listPicker}
                        ariaLabel='切換自選清單'
                        value={wl.activeListId}
                        options={wl.serverLists.map(l => ({ value: l.id, label: l.name }))}
                        disabled={wl.structureBusy}
                        onChange={id => wl.setActiveList(id)}
                        testId='watch-list-picker'
                    />
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
                        <span aria-hidden='true'>商品</span>
                        <button
                            type='button'
                            className={`${styles.metricToggle} ${pressable} ${focusRing}`}
                            aria-label={`右側欄顯示${metricLabel}，點按切換（漲跌幅、漲跌、總量）`}
                            onClick={cycleMetric}
                            data-testid='watch-metric-toggle'
                            data-metric={metric}
                        >
                            {metricLabel}
                            <ChevronsUpDown className={styles.metricIcon} aria-hidden='true' focusable='false' />
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
                                onOpen={openTrade}
                                onActions={openActions}
                            />
                        ))}
                    </ul>
                </>
            )}

            <SearchSheet
                open={searchOpen}
                onClose={() => setSearchOpen(false)}
                watchedCodes={watchedCodes}
                canAdd={canAdd}
                onAdd={onAdd}
                onOpenTrade={code => {
                    setSearchOpen(false);
                    openTrade(code);
                }}
            />
            <RowActionsSheet
                code={actionCode}
                items={wl.items}
                onClose={() => setActionCode(null)}
                onOpen={openTrade}
                onRemove={onRemove}
                onMove={reorderSymbol}
            />
        </section>
    );
}
