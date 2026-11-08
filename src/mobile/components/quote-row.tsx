// src/mobile/components/quote-row.tsx — 自選與排行共用的商品列（設計規格 §7.2，依使用者參考圖改版）
//
// - 列 64px：第一行名稱（排行在名稱前加名次），第二行代碼＋市場標記＋徽章（試撮、處置）＋附加資訊（排行的量／值／價差）；
//   右側成交價（漲跌色＋PriceFlash）與第二行「漲跌 漲跌幅」或總量（純文字、漲跌色）；迷你走勢；列尾快速下單鍵。
// - 日內區間小條：價格欄正下方的細軌（今日最低→最高）標記現價位置；只用列已有的 tick／指數／快照（排行：scanner）的高低，
//   不發請求；缺資料、最高＝最低、試撮時不顯示。位置與高低寫進列按鈕的無障礙名稱（小條本身 aria-hidden）。
// - 可見列追蹤：整頁共用一個 IntersectionObserver（createVisibilityTracker）；只有可見列掛載行情探針（自選）與走勢 canvas。
// - 迷你走勢延遲載入（lib/deferred-modules.ts loadWatchSparkline）；不可見、載入中、載入失敗、無合約都是同尺寸空白佔位。
// - 快速下單鍵（<prefix>-row-ticket）是列按鈕的兄弟節點，只呼叫 onTicket（呼叫端只開下單面板，設計規格 §10 S1）。
// - testid 以 testPrefix 開頭（自選 'watch'、排行 'ranking'、持倉 'holding'），自選列的 testid 與改版前相同。
// - 本檔不 import 行情 hook：自選以 probe 傳入行情探針（WatchQuoteProbe），排行是快照資料、不訂閱。

import { ArrowLeftRight } from 'lucide-react';
import { Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { PriceQuoteState } from '../../hooks/use-stream';
import { useThemeSettings } from '../../lib/theme-store';
import type { ContractBase, ContractInfo } from '../../lib/types/contract';
import type { Snapshot } from '../../lib/types/market';
import { fmtPct, fmtPrice } from '../../lib/utils/format';
import { fmtCompactInt } from '../lib/num-format';
import { useMediaQuery } from '../hooks/use-media-query';
import { loadWatchSparkline } from '../lib/deferred-modules';
import { useWatchSparklineEnabled } from '../lib/watch-prefs';
import { haptic } from '../motion/haptics';
import { pressableRow } from '../styles/primitives.css';
import * as styles from '../styles/watchlist.css';
import { IconButton } from '../ui/icon-button';
import { usePriceFlash } from '../ui/price-flash';
import * as flashStyles from '../ui/price-flash.css';
import { ModuleErrorBoundary, retryableLazy } from './route-error-boundary';

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
    /** 今日最高、最低（日內區間小條；缺少時不顯示） */
    high?: number;
    low?: number;
}

/** 有限正數才留下 */
const pos = (n: number | undefined) => (n !== undefined && n > 0 && Number.isFinite(n) ? n : undefined);

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
    const day = tick ?? index;
    return {
        close: close !== undefined && Number.isFinite(close) ? close : undefined,
        chg: chg !== undefined && Number.isFinite(chg) ? chg : undefined,
        pct: pct !== undefined && Number.isFinite(pct) ? pct : undefined,
        dir,
        simtrade: tick?.simtrade === true,
        vol: vol !== undefined && Number.isFinite(vol) && vol >= 0 ? vol : undefined,
        high: pos(day ? Number(day.high) : snapshot?.high),
        low: pos(day ? Number(day.low) : snapshot?.low),
    };
}

/** 現價在今日高低區間的位置（0＝最低、1＝最高，超出時夾住）；缺資料、最高 ≤ 最低、試撮時 null（不顯示小條） */
export function dayRangePosition(v: RowQuoteView): number | null {
    const { close, high, low } = v;
    if (v.simtrade || close === undefined || high === undefined || low === undefined || !(high > low)) return null;
    return Math.min(1, Math.max(0, (close - low) / (high - low)));
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

// ---------------------------------------------------------------------------
// 第二行指標（自選表頭切換鍵循環；排行固定 pct）

/** pct：第二行顯示「漲跌 漲跌幅」；vol：第二行顯示總量 */
export type WatchMetric = 'pct' | 'vol';

// ---------------------------------------------------------------------------
// 迷你走勢欄是否放得下

/** 窄螢幕：字級「大」時列寬放不下走勢（名稱約 120＋數字約 140＋走勢 40＋下單鍵 44＋內距約 32 ≈ 376px） */
export const NARROW_WATCH_QUERY = '(max-width: 400px)';
/** 字級「大」（theme-store FontScale；殼層寫入 html[data-sj-font-scale]） */
export const LARGE_FONT_SCALE = 1.3;

/** 迷你走勢是否放得下：窄螢幕且字級「大」時不放（讓出寬度，代碼不截斷） */
export function sparkFitsRow(fontScale: number, narrow: boolean): boolean {
    return !(narrow && fontScale === LARGE_FONT_SCALE);
}

/** 走勢欄：設定開啟且放得下才掛載（否則不掛載、不請求、不留佔位） */
export function useSparkColumn(): boolean {
    const enabled = useWatchSparklineEnabled();
    const { fontScale } = useThemeSettings();
    const narrow = useMediaQuery(NARROW_WATCH_QUERY);
    return enabled && sparkFitsRow(fontScale, narrow);
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

/** 元件存活期間一個追蹤器（卸載時 disconnect） */
export function useVisibilityTracker(): VisibilityTracker | null {
    const [tracker, setTracker] = useState<VisibilityTracker | null>(null);
    useEffect(() => {
        const t = createVisibilityTracker();
        setTracker(t);
        return () => t.disconnect();
    }, []);
    return tracker;
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

// ---------------------------------------------------------------------------
// 迷你走勢欄

// 延遲載入（首屏體積）：components/watch-sparkline.tsx 與 lib/watch-sparkline-data.ts 不進首屏 chunk，
// 閒置時由 app.tsx 預載。走勢欄只在列可見時掛載 WatchSparkCell（canvas、點陣、rAF、K 線 retain 都只屬於可見列）；
// 不可見、載入中、載入失敗都是同尺寸的空白佔位（aria-hidden，不顯示錯誤字樣，不影響列與頁面）。
const WatchSparkCell = retryableLazy(() => loadWatchSparkline().then(m => m.WatchSparkCell), 'WatchSparkCell');

export type SparkSlotState = 'na' | 'hidden' | 'loading' | 'failed';

function SparkPlaceholder({ state, testId }: { state: SparkSlotState; testId: string }) {
    return <span className={styles.spark} aria-hidden='true' data-testid={testId} data-spark={state} />;
}

/**
 * 可見列的走勢欄：列每次變為可見都重新掛載。上次載入失敗時，掛載當下（子樹渲染前）換新的 lazy，
 * 這次就會重新 import（retryableLazy.reset 只在失敗後才換新；多列同時可見時只有第一列換新、其餘共用同一次載入）。
 */
function VisibleSpark({ contract, reference, tick, testId }: { contract: ContractBase; reference?: number; tick: PriceQuoteState['tick']; testId: string }) {
    useState(() => WatchSparkCell.reset());
    return (
        <ModuleErrorBoundary fallback={() => <SparkPlaceholder state='failed' testId={testId} />}>
            <Suspense fallback={<SparkPlaceholder state='loading' testId={testId} />}>
                <WatchSparkCell contract={contract} reference={reference} tick={tick} />
            </Suspense>
        </ModuleErrorBoundary>
    );
}

// ---------------------------------------------------------------------------
// 列尾快速下單鍵

/** 只呼叫 onTicket（呼叫端只開下單面板、不帶方向；之後仍需預覽與滑動確認，設計規格 §10 S1） */
export function TicketButton({ code, name, onTicket, testId }: { code: string; name: string; onTicket: (code: string) => void; testId: string }) {
    return <IconButton ariaLabel={`下單 ${code} ${name}`.trim()} icon={ArrowLeftRight} onClick={() => onTicket(code)} testId={testId} />;
}

// ---------------------------------------------------------------------------
// 列

export interface QuoteRowProps {
    /** testid 前綴：自選 'watch'、排行 'ranking'、持倉分段 'holding' */
    testPrefix: 'watch' | 'ranking' | 'holding';
    code: string;
    name: string;
    tag: MarketTag | null;
    tradable: boolean;
    index: number;
    tracker: VisibilityTracker | null;
    metric: WatchMetric;
    /** 顯示迷你走勢欄（設定開啟且放得下；否則不掛載走勢欄、不請求、不留佔位） */
    spark: boolean;
    /** 走勢資料的合約；null 時走勢欄是空白佔位（指數、組合商品、排行中未知交易所的股票） */
    sparkContract: ContractBase | null;
    /** 昨收（參考價）；0 或缺少時走勢不畫基準線 */
    sparkReference?: number;
    punished: boolean;
    /** 固定的行情（排行：快照資料、不訂閱）；未給時以 quoteContract＋snapshot＋即時行情推算 */
    staticView?: RowQuoteView;
    quoteContract?: Pick<ContractInfo, 'reference'> & Partial<Pick<ContractInfo, 'security_type'>>;
    snapshot?: Snapshot;
    /** 可見時掛載的行情探針（自選：WatchQuoteProbe）；行情交給列自行節流重繪 */
    probe?: ComponentType<{ code: string; onQuote: (q: PriceQuoteState | undefined) => void }>;
    /** 名稱前的小字（排行名次） */
    lead?: ReactNode;
    /** 第二行徽章後的附加資訊（排行的量／值／價差） */
    metaExtra?: ReactNode;
    ariaPrefix?: string;
    ariaSuffix?: string;
    onOpen: (code: string) => void;
    /** 長按（或右鍵）；未給時不處理長按 */
    onLongPress?: (code: string) => void;
    /** 快速下單鍵；trailing 未給時，可交易商品顯示下單鍵、其他放同寬佔位 */
    onTicket?: (code: string) => void;
    /** 列按鈕前的兄弟節點（自選編輯模式的移除鍵） */
    leading?: ReactNode;
    /** 取代預設的列尾（下單鍵或佔位） */
    trailing?: ReactNode;
    /** 拖曳中的列（自選編輯模式） */
    dragging?: boolean;
    /** 列可見度改變（排行：可見列才為走勢解析合約）；需為穩定的函式 */
    onVisibleChange?: (visible: boolean) => void;
}

export function QuoteRow({
    testPrefix, code, name, tag, tradable, index, tracker, metric, spark, sparkContract, sparkReference, punished,
    staticView, quoteContract, snapshot, probe: Probe, lead, metaExtra, ariaPrefix = '', ariaSuffix = '',
    onOpen, onLongPress, onTicket, leading, trailing, dragging = false, onVisibleChange,
}: QuoteRowProps) {
    const t = (id: string) => `${testPrefix}-${id}`;
    const ref = useRef<HTMLLIElement | null>(null);
    const flashRef = useRef<HTMLSpanElement | null>(null);
    const visible = useRowVisible(ref, tracker, index < FALLBACK_VISIBLE_ROWS);
    useEffect(() => { onVisibleChange?.(visible); }, [visible, onVisibleChange]);
    const [quote, pushQuote] = useThrottledValue<PriceQuoteState | undefined>(undefined, WATCH_REPAINT_MS);
    const view = staticView ?? rowQuoteView(quoteContract ?? { reference: 0 }, snapshot, quote);
    // 跳價閃爍：快照 → 即時的那一筆不閃（來源切換）；只閃可見格（price-flash 內共用 IntersectionObserver）
    usePriceFlash(flashRef, view.close, { source: quote ? 'live' : 'snapshot', enabled: visible });

    // 長按：LONG_PRESS_MS 不放開且未移動 → onLongPress；長按後的 click 不開交易頁
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
        if (!onLongPress || (e.pointerType === 'mouse' && e.button !== 0)) return;
        press.current = {
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            timer: setTimeout(() => {
                press.current = null;
                longPressed.current = true;
                haptic('longPress');
                onLongPress(code);
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
    const range = dayRangePosition(view);
    const rangePct = range === null ? 0 : Math.round(range * 100);
    const ariaLabel = `${ariaPrefix}${code} ${name}${tag ? ` ${MARKET_FULL[tag]}` : ''}，${view.simtrade ? `${SIM_LABEL} ` : ''}${priceText}，${DIR_TEXT[view.dir]} ${chgText} ${pctText}`.trim()
        + (volText ? `，總量 ${volText}` : '')
        + (range === null ? '' : `，今日最低 ${fmtPrice(view.low!)} 最高 ${fmtPrice(view.high!)}，現價位於區間 ${rangePct}%`)
        + (punished ? `，${PUNISH_LABEL}股` : '')
        + ariaSuffix;

    const title = <span className={lead ? styles.rowTitleFlex : styles.rowTitle} data-testid={t('name')}>{name || code}</span>;

    return (
        <li
            ref={ref}
            className={dragging ? `${styles.rowItem} ${styles.rowDragging}` : styles.rowItem}
            data-code={code}
            data-testid={t('row')}
            data-visible={visible ? 'true' : 'false'}
            data-dragging={dragging ? 'true' : undefined}
        >
            {leading}
            <button
                type='button'
                className={`${styles.row} ${spark ? styles.rowWithSpark : styles.rowNoSpark} ${pressableRow} ${styles.rowHasTrailing}${leading ? ` ${styles.rowHasLeading}` : ''}`}
                aria-label={ariaLabel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={clearPress}
                onPointerCancel={clearPress}
                onPointerLeave={clearPress}
                onContextMenu={onLongPress ? e => {
                    // Android 長按與滑鼠右鍵都會觸發 contextmenu：不開系統選單，改開操作面板（只開一次）
                    e.preventDefault();
                    const already = longPressed.current;
                    clearPress();
                    longPressed.current = true;
                    if (!already) {
                        haptic('longPress');
                        onLongPress(code);
                    }
                } : undefined}
                onClick={() => {
                    if (longPressed.current) {
                        longPressed.current = false;
                        return;
                    }
                    onOpen(code);
                }}
                data-testid={t('row-button')}
            >
                <span className={styles.rowName}>
                    {lead ? <span className={styles.rowTitleLead}>{lead}{title}</span> : title}
                    <span className={styles.rowMeta}>
                        {/* 代碼＋市場標記同一組、不縮不換行；放不下時只有後面的徽章換行 */}
                        <span className={styles.rowMetaKey}>
                            <span className={styles.rowMetaCode} data-testid={t('code')}>{code}</span>
                            {tag && <span className={styles.marketTag} data-testid={t('market')}>{tag}</span>}
                        </span>
                        {view.simtrade && <span className={styles.simBadge} data-testid={t('simtrade')}>{SIM_LABEL}</span>}
                        {punished && <span className={styles.punishBadge} data-testid={t('punish')}>{PUNISH_LABEL}</span>}
                        {metaExtra}
                    </span>
                </span>
                <span className={styles.priceCell}>
                    <span className={`${styles.rowPrice} ${styles.rowPriceLarge} ${flashStyles.host} ${styles.tone[view.dir]}`}>
                        <span ref={flashRef} className={flashStyles.overlay} aria-hidden='true' />
                        <span data-testid={t('price')}>{priceText}</span>
                    </span>
                    <span className={`${styles.rowChange} ${styles.tone[changeTone]}`} data-testid={t('change')} data-metric={metric}>{changeText}</span>
                    {range !== null && <span className={styles.dayRange} style={{ '--p': `${rangePct}%` } as CSSProperties} aria-hidden='true' data-testid={t('range')} />}
                </span>
                {spark && (!sparkContract
                    ? <SparkPlaceholder state='na' testId={t('spark-blank')} />
                    : visible
                        ? <VisibleSpark contract={sparkContract} reference={sparkReference} tick={quote?.tick} testId={t('spark-blank')} />
                        : <SparkPlaceholder state='hidden' testId={t('spark-blank')} />)}
            </button>
            {visible && Probe && <Probe code={code} onQuote={pushQuote} />}
            {trailing !== undefined ? trailing : tradable && onTicket ? (
                <span className={styles.rowTrailing}>
                    <TicketButton code={code} name={name} onTicket={onTicket} testId={t('row-ticket')} />
                </span>
            ) : (
                // 指數、組合商品沒有快速下單鍵：放同寬的空白佔位，價格欄與走勢欄才和其他列對齊
                <span className={styles.rowTrailing} aria-hidden='true'>
                    <span className={styles.ticketSpacer} data-testid={t('row-ticket-spacer')} />
                </span>
            )}
        </li>
    );
}
