// src/mobile/components/ranking-list.tsx — 漲跌幅排行（規格 §2.2、§8.1、§13 Phase 3；設計規格 §7.2）
//
// - 資料：fetchScanner(type, RANKING_COUNT, ascending)（POST /api/v1/data/scanner，src/lib/shioaji.ts）。
//   伺服器的 ascending 旗標相反（sinotrade/shioaji#207，桌面 scanner-panel.tsx 同樣處理）：true＝由大到小。
//   取回後再依各排行的指標在前端排序一次（穩定排序，同值保留伺服器順序），名次以此為準。
//   例外：「高低價差」（DayRangeRank）依伺服器的排序依據（最高 − 最低的絕對價差），前端無法重現，
//   一律保留伺服器名次；振幅%只當附加資訊顯示（不是振幅排行：低價大振幅的股票可能不在名單內）。
//   「成交筆數」（TickCountRank）的筆數欄位未經確認（rank_value 語意不明），同樣保留伺服器名次，第二行仍顯示量。
//   「漲價差／跌價差」（ChangePriceRank）依漲跌（元）排序，ascending 旗標與漲跌幅相同處理。
// - 篩選（只在前端過濾已取回的名單，不發新請求；名次維持過濾前的名次）：
//   排除處置（沿用本頁已讀的處置清單；名單尚未取得時不排除並說明）、排除 ETF（代碼 00 開頭，與 lib 的證交稅、
//   升降單位判斷相同）、排除權證（6 碼、03–08 或 7 開頭）。上市／上櫃無法由排行資料判斷（沒有交易所），不提供。
// - 只在自選頁的「排行」分段掛載本元件時才讀取；頁面在背景（document.hidden）時不讀，回前景時若快取過期才讀。
// - 每種排行有模組層快取 RANKING_CACHE_MS（30 秒）：切換種類、切換分頁再回來都先用快取；
//   任何讀取（含自動、手動、錯誤後重試）距上次讀取未滿 RANKING_COOLDOWN_MS（15 秒）都不發出。
// - 列（與自選共用 components/quote-row.tsx，使用者要求「排行的顯示方式也要跟自選一樣」）：
//   第一行名次（小字）＋名稱；第二行代碼（＋市場標記，合約快取有時）＋處置徽章＋附加資訊（成交值排行顯示值、
//   高低價差排行顯示價差，其餘顯示量）；右側成交價與「漲跌 漲跌幅」（純文字、依漲跌著色）；迷你走勢；
//   列尾星號「加入自選／已在自選」與快速下單鍵（只呼叫 openTicket，不帶方向，設計規格 §10 S1）。點一列 → 交易頁。
// - 排行是快照資料（不訂閱即時行情），以「更新於」標示時間。
// - 迷你走勢沿用自選的限制（lib/watch-sparkline-data.ts）：只有可見列、每檔每時段上限、佇列同時 ≤2、帳戶頁可關閉。
//   排行資料沒有交易所：可見、走勢開關開啟（且放得下）的列，合約不在快取時經 lib/ranking-spark-contracts.ts
//   以 ensureContract(code) 解析一次（同時 ≤2、列不可見或開關關閉時取消未開始的、失敗 5 分鐘內不重試）；
//   解析成功後列顯示市場標記與走勢。每次進入排行最多多出「捲到可見且不在快取的不同代碼數」個合約 GET（≤30／種）。
// - 處置徽章：與自選共用 lib/regulatory-punish.ts 的模組層快取（有排行資料時才讀，30 分鐘最多 1 次，失敗靜默）。
// - 版面（設計規格 §7.2）：種類用 Segmented scroll 變體（tablist 語意不變）；載入 Skeleton、空 EmptyState、錯誤 InlineNote。

import { Star, TrendingUp } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { useContract } from '../../lib/contracts-cache';
import { fetchScanner } from '../../lib/shioaji';
import type { ContractInfo } from '../../lib/types/contract';
import type { ScannerItem, ScannerType } from '../../lib/types/market';
import { fmtPrice } from '../../lib/utils/format';
import { fmtCompactInt } from '../lib/num-format';
import { openTicket } from '../lib/mobile-store';
import { requestSparkContract } from '../lib/ranking-spark-contracts';
import { usePunishedCodes, usePunishedListLoaded } from '../lib/regulatory-punish';
import { focusRing, pressable } from '../styles/primitives.css';
import * as styles from '../styles/watchlist.css';
import { chip, expandHit } from '../ui/chip.css';
import { EmptyState } from '../ui/empty-state';
import { IconButton } from '../ui/icon-button';
import { InlineNote } from '../ui/inline-note';
import { Segmented } from '../ui/segmented';
import { Skeleton } from '../ui/skeleton';
import { marketTag, QuoteRow, TicketButton, useSparkColumn, useVisibilityTracker, type RowQuoteView, type VisibilityTracker } from './quote-row';

export type RankingKind = 'gainers' | 'losers' | 'priceUp' | 'priceDown' | 'volume' | 'amount' | 'ticks' | 'range';

export interface RankingDef {
    kind: RankingKind;
    label: string;
    type: ScannerType;
    /** 送給伺服器的 ascending（已依 shioaji#207 反轉：true＝由大到小） */
    serverAscending: boolean;
}

export const RANKING_DEFS: readonly RankingDef[] = [
    { kind: 'gainers', label: '漲幅', type: 'ChangePercentRank', serverAscending: true },
    { kind: 'losers', label: '跌幅', type: 'ChangePercentRank', serverAscending: false },
    { kind: 'priceUp', label: '漲價差', type: 'ChangePriceRank', serverAscending: true },
    { kind: 'priceDown', label: '跌價差', type: 'ChangePriceRank', serverAscending: false },
    { kind: 'volume', label: '成交量', type: 'VolumeRank', serverAscending: true },
    { kind: 'amount', label: '成交值', type: 'AmountRank', serverAscending: true },
    { kind: 'ticks', label: '成交筆數', type: 'TickCountRank', serverAscending: true },
    { kind: 'range', label: '高低價差', type: 'DayRangeRank', serverAscending: true },
];

/** 保留伺服器名次（前端無法重現排序依據）的排行 */
const SERVER_ORDER: ReadonlySet<RankingKind> = new Set<RankingKind>(['range', 'ticks']);

export const RANKING_COUNT = 30;
export const RANKING_CACHE_MS = 30_000;
export const RANKING_COOLDOWN_MS = 15_000;

const defOf = (kind: RankingKind): RankingDef => RANKING_DEFS.find(d => d.kind === kind)!;

// ---------------------------------------------------------------------------
// 數值

/** 參考價＝成交價 − 漲跌 */
function referenceOf(item: ScannerItem): number {
    return Number(item.close) - Number(item.change_price);
}

/** 漲跌幅（%）；參考價無效時 undefined */
export function rankingChangePct(item: ScannerItem): number | undefined {
    const ref = referenceOf(item);
    const chg = Number(item.change_price);
    if (!Number.isFinite(ref) || ref <= 0 || !Number.isFinite(chg)) return undefined;
    return (chg / ref) * 100;
}

/** 振幅（%）＝（最高 − 最低）／參考價 */
export function rankingRangePct(item: ScannerItem): number | undefined {
    const ref = referenceOf(item);
    const range = Number(item.high) - Number(item.low);
    if (!Number.isFinite(ref) || ref <= 0 || !Number.isFinite(range)) return undefined;
    return (range / ref) * 100;
}

function metricOf(kind: RankingKind, item: ScannerItem): number | undefined {
    switch (kind) {
        case 'gainers':
        case 'losers':
            return rankingChangePct(item);
        case 'priceUp':
        case 'priceDown':
            return Number(item.change_price);
        case 'volume':
            return Number(item.total_volume);
        case 'amount':
            return Number(item.total_amount);
        case 'ticks':
        case 'range':
            return undefined; // 不在前端排序（見 sortRanking）
    }
}

/** 高低價差（最高 − 最低）；伺服器的 price_range 無效時以最高、最低計算 */
export function rankingPriceRange(item: ScannerItem): number | undefined {
    const raw = item.price_range as unknown;
    const server = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    if (Number.isFinite(server) && server >= 0) return server;
    const range = Number(item.high) - Number(item.low);
    return Number.isFinite(range) ? range : undefined;
}

/**
 * 依排行指標排序（跌幅、跌價差由小到大，其餘由大到小；無法計算的排最後；同值保留伺服器順序）。
 * 高低價差、成交筆數排行保留伺服器名次（前端無法重現排序依據，不重排）。
 */
export function sortRanking(kind: RankingKind, items: readonly ScannerItem[]): ScannerItem[] {
    if (SERVER_ORDER.has(kind)) return [...items];
    const sign = kind === 'losers' || kind === 'priceDown' ? 1 : -1;
    return items
        .map((item, index) => ({ item, index, v: metricOf(kind, item) }))
        .sort((a, b) => {
            const av = a.v !== undefined && Number.isFinite(a.v) ? a.v : null;
            const bv = b.v !== undefined && Number.isFinite(b.v) ? b.v : null;
            if (av === null || bv === null) return av === bv ? a.index - b.index : av === null ? 1 : -1;
            return av === bv ? a.index - b.index : sign * (av - bv);
        })
        .map(x => x.item);
}

// ---------------------------------------------------------------------------
// 篩選（前端過濾已取回的名單，不發新請求）

export interface RankingFilters {
    noPunished: boolean;
    noEtf: boolean;
    noWarrant: boolean;
}

export const RANKING_FILTER_DEFS: readonly { key: keyof RankingFilters; label: string }[] = [
    { key: 'noPunished', label: '排除處置' },
    { key: 'noEtf', label: '排除 ETF' },
    { key: 'noWarrant', label: '排除權證' },
];

const NO_FILTERS: RankingFilters = { noPunished: false, noEtf: false, noWarrant: false };

/**
 * 篩選晶片列：放不下時換行，列距 8px（擴張的點擊區不互相重疊）。
 * 用 inline style 而不是新的 .css.ts：本 chunk 原本沒有自己的 CSS，多一個 CSS 檔會讓首屏 chunk 的預載清單多一筆；
 * 間距寫死 0.5rem（＝tokens SPACE.s2）而不 import tokens：tokens 被打包在另一個 chunk，import 會讓預載清單變長。
 */
const FILTER_ROW = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', minWidth: 0 } as const;

/** ETF：代碼 00 開頭（與 lib 的證交稅、升降單位判斷相同；含債券、槓桿反向 ETF） */
export function isEtfCode(code: string): boolean {
    return code.startsWith('00');
}

/** 權證：6 碼，上市 03–08 開頭、上櫃 7 開頭（末碼可為英文字母，例如認售 P） */
export function isWarrantCode(code: string): boolean {
    return /^(?:0[3-8]|7\d)\d{3}[\dA-Z]$/.test(code);
}

/**
 * 依篩選條件過濾；rank 維持過濾前的名次。
 * punished 為 null（處置名單尚未取得）時不排除處置股（「不在集合裡」不能當成「未處置」，也不能整份藏起來）。
 */
export function filterRanking(items: readonly ScannerItem[], f: RankingFilters, punished: ReadonlySet<string> | null): { item: ScannerItem; rank: number }[] {
    const out: { item: ScannerItem; rank: number }[] = [];
    items.forEach((item, i) => {
        const c = item.code;
        if (f.noPunished && punished?.has(c)) return;
        if (f.noEtf && isEtfCode(c)) return;
        if (f.noWarrant && isWarrantCode(c)) return;
        out.push({ item, rank: i + 1 });
    });
    return out;
}

// ---------------------------------------------------------------------------
// 模組層快取（跨掛載保留）

export interface RankingState {
    items: ScannerItem[] | null;
    /** 最近一次成功取回的時間 */
    fetchedAt: number | null;
    /** 最近一次發出讀取的時間（冷卻以此計算，成功或失敗都算） */
    attemptedAt: number | null;
    loading: boolean;
    error: string | null;
}

/** 上次選的排行種類（切換分頁再回來保留） */
let lastKind: RankingKind = 'gainers';
/** 上次的篩選（同上；不寫入儲存，重新開啟 App 時全部關閉） */
let lastFilters: RankingFilters = NO_FILTERS;

const EMPTY_STATE: RankingState = { items: null, fetchedAt: null, attemptedAt: null, loading: false, error: null };
const states = new Map<RankingKind, RankingState>();
const listeners = new Set<() => void>();

export function getRankingState(kind: RankingKind): RankingState {
    return states.get(kind) ?? EMPTY_STATE;
}

function patchState(kind: RankingKind, patch: Partial<RankingState>) {
    states.set(kind, { ...getRankingState(kind), ...patch });
    listeners.forEach(l => l());
}

function subscribeRanking(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

/** 距離可以再次讀取還有多少毫秒（0＝可以讀） */
export function rankingCooldownLeft(kind: RankingKind, now = Date.now()): number {
    const at = getRankingState(kind).attemptedAt;
    return at === null ? 0 : Math.max(0, at + RANKING_COOLDOWN_MS - now);
}

export function rankingIsFresh(kind: RankingKind, now = Date.now()): boolean {
    const at = getRankingState(kind).fetchedAt;
    return at !== null && now - at < RANKING_CACHE_MS;
}

/**
 * 視需要讀取排行。force＝使用者按「更新」（忽略 30 秒快取，但仍受 15 秒冷卻限制）。
 * 回傳是否真的發出了請求。
 */
export function requestRanking(kind: RankingKind, opts: { force?: boolean } = {}): boolean {
    const now = Date.now();
    const s = getRankingState(kind);
    if (s.loading) return false;
    if (!opts.force && rankingIsFresh(kind, now)) return false;
    if (rankingCooldownLeft(kind, now) > 0) return false;
    const def = defOf(kind);
    patchState(kind, { loading: true, attemptedAt: now });
    fetchScanner(def.type, RANKING_COUNT, def.serverAscending).then(
        items => patchState(kind, {
            items: sortRanking(kind, Array.isArray(items) ? items : []),
            fetchedAt: Date.now(),
            loading: false,
            error: null,
        }),
        (e: unknown) => patchState(kind, {
            loading: false,
            error: e instanceof Error && e.message ? e.message : '排行讀取失敗',
        }),
    );
    return true;
}

/** 測試用：清空快取與選擇 */
export function resetRankingForTest(): void {
    states.clear();
    lastKind = 'gainers';
    lastFilters = NO_FILTERS;
    listeners.forEach(l => l());
}

// ---------------------------------------------------------------------------
// 元件

function pageHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function useRankingState(kind: RankingKind): RankingState {
    return useSyncExternalStore(subscribeRanking, () => getRankingState(kind), () => getRankingState(kind));
}

/** 冷卻倒數：冷卻中每秒重繪一次（讀取狀態改變時由 useRankingState 重繪） */
function useCooldownLeft(kind: RankingKind): number {
    const [, tick] = useReducer((x: number) => x + 1, 0);
    const left = rankingCooldownLeft(kind);
    useEffect(() => {
        if (left <= 0) return;
        const id = setTimeout(tick, Math.min(1_000, left));
        return () => clearTimeout(id);
    });
    return left;
}


function fmtTime(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtAmount(amount: number): string {
    if (!Number.isFinite(amount) || amount <= 0) return '—';
    return amount >= 1e8 ? `${(amount / 1e8).toFixed(1)}億` : `${(amount / 1e4).toFixed(0)}萬`;
}

export interface RankingListProps {
    /** 已在目前自選清單中的代碼 */
    watchedCodes: ReadonlySet<string>;
    /** 自選清單是否可加入（載入中、更新中、載入失敗時 false） */
    canAdd: boolean;
    /** 加入自選；失敗時丟錯（訊息顯示給使用者） */
    onAdd: (code: string) => Promise<void>;
    /** 開啟交易頁 */
    onOpen: (code: string) => void;
}

export function RankingList({ watchedCodes, canAdd, onAdd, onOpen }: RankingListProps) {
    const [kind, setKindState] = useState<RankingKind>(lastKind);
    const state = useRankingState(kind);
    const cooldown = useCooldownLeft(kind);
    const [adding, setAdding] = useState<string | null>(null);
    const addingRef = useRef(false);
    const [addError, setAddError] = useState<string | null>(null);
    const tracker = useVisibilityTracker();
    const spark = useSparkColumn();

    const setKind = useCallback((k: RankingKind) => {
        lastKind = k;
        setKindState(k);
    }, []);
    const [filters, setFiltersState] = useState<RankingFilters>(lastFilters);
    const toggleFilter = (key: keyof RankingFilters) => {
        const next = { ...filters, [key]: !filters[key] };
        lastFilters = next;
        setFiltersState(next);
    };

    // 掛載（＝排行分段可見）與切換種類時：前景才讀；快取未過期不讀
    useEffect(() => {
        if (!pageHidden()) requestRanking(kind);
        if (typeof document === 'undefined') return;
        const onVisible = () => { if (!pageHidden()) requestRanking(kind); };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [kind]);

    const onAddRef = useRef(onAdd);
    onAddRef.current = onAdd;
    const add = useCallback(async (code: string) => {
        if (addingRef.current) return;
        addingRef.current = true;
        setAdding(code);
        setAddError(null);
        try {
            await onAddRef.current(code);
        } catch (e) {
            setAddError(`${code} 加入自選失敗：${e instanceof Error && e.message ? e.message : '請稍後再試'}`);
        } finally {
            addingRef.current = false;
            setAdding(null);
        }
    }, []);

    const def = defOf(kind);
    const cooling = cooldown > 0;
    const secs = Math.ceil(cooldown / 1_000);
    const items = state.items;
    // 處置清單：有排行資料時才讀（與自選共用快取，30 分鐘最多 1 次）
    const punished = usePunishedCodes(items !== null && items.length > 0);
    const punishLoaded = usePunishedListLoaded();
    const shown = useMemo(
        () => (items ? filterRanking(items, filters, punishLoaded ? punished : null) : []),
        [items, filters, punished, punishLoaded],
    );
    const hidden = items ? items.length - shown.length : 0;

    return (
        <div data-testid='ranking'>
            <div className={styles.rankControls}>
                <Segmented<RankingKind>
                    items={RANKING_DEFS.map(d => ({ value: d.kind, label: d.label, testId: `ranking-kind-${d.kind}` }))}
                    value={kind}
                    onChange={setKind}
                    semantics='tabs'
                    variant='scroll'
                    ariaLabel='排行種類'
                />

                <div style={FILTER_ROW} role='group' aria-label='排行篩選' data-testid='ranking-filters'>
                    {RANKING_FILTER_DEFS.map(f => (
                        <button
                            key={f.key}
                            type='button'
                            className={`${chip} ${pressable} ${focusRing}`}
                            aria-pressed={filters[f.key]}
                            onClick={() => toggleFilter(f.key)}
                            data-testid={`ranking-filter-${f.key}`}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>

                <div className={styles.rankMeta}>
                    <span className={styles.rankMetaText} role='status' data-testid='ranking-updated'>
                        {state.loading
                            ? `${def.label}排行讀取中…`
                            : state.fetchedAt !== null
                                ? `${def.label}前 ${RANKING_COUNT} 名${hidden > 0 ? `・已排除 ${hidden} 檔` : ''}・更新於 ${fmtTime(state.fetchedAt)}`
                                : ''}
                    </span>
                    <button
                        type='button'
                        className={`${styles.rankRefresh} ${expandHit} ${pressable} ${focusRing}`}
                        disabled={state.loading || cooling}
                        aria-label={cooling ? `更新排行（${secs} 秒後可再按）` : '更新排行'}
                        onClick={() => requestRanking(kind, { force: true })}
                        data-testid='ranking-refresh'
                    >
                        {cooling ? `⟳ 更新（${secs}）` : '⟳ 更新'}
                    </button>
                </div>

                {state.error && (
                    <InlineNote
                        tone='danger'
                        role='alert'
                        testId='ranking-error'
                        action={items ? undefined : {
                            label: cooling ? `重試（${secs}）` : '重試',
                            onClick: () => requestRanking(kind, { force: true }),
                            disabled: state.loading || cooling,
                            testId: 'ranking-retry',
                        }}
                    >
                        排行讀取失敗：{state.error}
                    </InlineNote>
                )}
                {addError && <InlineNote tone='danger' role='alert' testId='ranking-add-error'>{addError}</InlineNote>}
                {filters.noPunished && !punishLoaded && items !== null && items.length > 0 && (
                    <InlineNote tone='info' role='status' testId='ranking-filter-punish-pending'>
                        處置名單尚未取得，暫時無法排除處置股。
                    </InlineNote>
                )}
            </div>

            {!items && state.loading && <Skeleton label='排行讀取中…' rows={6} testId='ranking-loading' />}
            {items && items.length === 0 && (
                <EmptyState
                    icon={TrendingUp}
                    title='目前沒有排行資料'
                    description='非交易時段或模擬環境可能沒有資料。'
                    testId='ranking-empty'
                />
            )}

            {items && items.length > 0 && shown.length === 0 && (
                <EmptyState
                    icon={TrendingUp}
                    title='沒有符合篩選條件的股票'
                    description={`前 ${RANKING_COUNT} 名都被排除了，可關閉上方的排除條件。`}
                    testId='ranking-filtered-empty'
                />
            )}

            {shown.length > 0 && (
                <ol className={styles.list} aria-label={`${def.label}排行`} data-testid='ranking-list'>
                    {shown.map(({ item, rank }, index) => (
                        <RankingRow
                            key={item.code}
                            rank={rank}
                            kind={kind}
                            item={item}
                            index={index}
                            tracker={tracker}
                            spark={spark}
                            punished={punished.has(item.code)}
                            watched={watchedCodes.has(item.code)}
                            canAdd={canAdd && adding === null}
                            adding={adding === item.code}
                            onOpen={onOpen}
                            onAdd={add}
                        />
                    ))}
                </ol>
            )}
        </div>
    );
}

/** 高低價差列的附加資訊：「價差 12.5（振幅 3.20%）」；振幅%只是參考 */
function rangeText(item: ScannerItem): string {
    const range = rankingPriceRange(item);
    const pct = rankingRangePct(item);
    return `價差 ${range !== undefined ? fmtPrice(range) : '—'}${pct !== undefined ? `（振幅 ${pct.toFixed(2)}%）` : ''}`;
}

/** 排行列第二行的附加資訊（依種類）：成交值排行顯示值、高低價差排行顯示價差，其餘顯示量 */
export function rankingExtraText(kind: RankingKind, item: ScannerItem): string {
    if (kind === 'amount') return `值 ${fmtAmount(Number(item.total_amount))}`;
    if (kind === 'range') {
        const range = rankingPriceRange(item);
        return `價差 ${range !== undefined ? fmtPrice(range) : '—'}`;
    }
    const vol = Number(item.total_volume);
    return `量 ${Number.isFinite(vol) && vol >= 0 ? fmtCompactInt(vol) : '—'}`;
}

/** 排行的快照行情（不訂閱即時）：漲跌與漲跌幅由伺服器的漲跌與成交價推算 */
export function rankingView(item: ScannerItem): RowQuoteView {
    const close = Number(item.close);
    const chg = Number(item.change_price);
    const vol = Number(item.total_volume);
    return {
        close: Number.isFinite(close) ? close : undefined,
        chg: Number.isFinite(chg) ? chg : undefined,
        pct: rankingChangePct(item),
        dir: !Number.isFinite(chg) || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down',
        simtrade: false,
        vol: Number.isFinite(vol) && vol >= 0 ? vol : undefined,
    };
}

/**
 * 走勢用的合約：合約快取裡的股票合約（自選、看過的交易頁、或可見列經 requestSparkContract 解析後進快取）。
 * 沒有、或不是股票時走勢欄是空白佔位。
 */
function sparkContractOf(c: ContractInfo | undefined): ContractInfo | null {
    return c && c.security_type === 'STK' && !c.combo ? c : null;
}

/** 只開下單面板、不帶方向（S1：之後仍需預覽與滑動確認） */
const quickTicket = (code: string) => { openTicket({ code, source: 'other' }); };

const RankingRow = memo(function RankingRow({ rank, kind, item, index, tracker, spark, punished, watched, canAdd, adding, onOpen, onAdd }: {
    rank: number;
    kind: RankingKind;
    item: ScannerItem;
    index: number;
    tracker: VisibilityTracker | null;
    spark: boolean;
    punished: boolean;
    watched: boolean;
    canAdd: boolean;
    adding: boolean;
    onOpen: (code: string) => void;
    onAdd: (code: string) => void;
}) {
    const code = item.code;
    const name = item.name ?? '';
    const view = useMemo(() => rankingView(item), [item]);
    const cached = useContract(code);
    const contract = sparkContractOf(cached);
    // 可見、走勢欄開啟、合約不在快取：解析一次（佇列同時 ≤2）；不可見、開關關閉、卸載時取消未開始的解析
    const [visible, setVisible] = useState(false);
    const needContract = spark && visible && !cached;
    useEffect(() => (needContract ? requestSparkContract(code) : undefined), [needContract, code]);
    const extra = rankingExtraText(kind, item);
    const reference = view.close !== undefined && view.chg !== undefined ? view.close - view.chg : undefined;
    const ariaSuffix = kind === 'amount'
        ? `，成交${extra}`
        : kind === 'range'
            ? `，${rangeText(item)}`
            : '';
    return (
        <QuoteRow
            testPrefix='ranking'
            code={code}
            name={name}
            tag={contract ? marketTag(contract) : null}
            tradable
            index={index}
            tracker={tracker}
            metric='pct'
            spark={spark}
            sparkContract={contract}
            sparkReference={contract?.reference || (reference !== undefined && reference > 0 ? reference : undefined)}
            punished={punished}
            staticView={view}
            lead={<span className={styles.rankNo} aria-hidden='true' data-testid='ranking-rank'>{rank}</span>}
            metaExtra={<span className={styles.rankExtra} data-testid='ranking-extra'>{extra}</span>}
            ariaPrefix={`第 ${rank} 名 `}
            ariaSuffix={ariaSuffix}
            onVisibleChange={setVisible}
            onOpen={onOpen}
            trailing={(
                <span className={`${styles.rowTrailing} ${styles.trailingPair}`}>
                    <IconButton
                        ariaLabel={watched ? `${code} 已在自選` : adding ? `${code} 加入自選中` : `${code} 加入自選`}
                        icon={Star}
                        className={watched ? styles.starOn : undefined}
                        disabled={watched || !canAdd}
                        onClick={() => onAdd(code)}
                        testId='ranking-add'
                    />
                    <TicketButton code={code} name={name} onTicket={quickTicket} testId='ranking-row-ticket' />
                </span>
            )}
        />
    );
});