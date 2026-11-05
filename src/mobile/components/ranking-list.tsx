// src/mobile/components/ranking-list.tsx — 漲跌幅排行（規格 §2.2、§8.1、§13 Phase 3）
//
// - 資料：fetchScanner(type, RANKING_COUNT, ascending)（POST /api/v1/data/scanner，src/lib/shioaji.ts）。
//   伺服器的 ascending 旗標相反（sinotrade/shioaji#207，桌面 scanner-panel.tsx 同樣處理）：true＝由大到小。
//   取回後再依各排行的指標在前端排序一次（穩定排序，同值保留伺服器順序），名次以此為準。
//   例外：「高低價差」（DayRangeRank）依伺服器的排序依據（最高 − 最低的絕對價差），前端無法重現，
//   一律保留伺服器名次；振幅%只當附加資訊顯示（不是振幅排行：低價大振幅的股票可能不在名單內）。
// - 只在自選頁的「排行」分段掛載本元件時才讀取；頁面在背景（document.hidden）時不讀，回前景時若快取過期才讀。
// - 每種排行有模組層快取 RANKING_CACHE_MS（30 秒）：切換種類、切換分頁再回來都先用快取；
//   任何讀取（含自動、手動、錯誤後重試）距上次讀取未滿 RANKING_COOLDOWN_MS（15 秒）都不發出。
// - 列：名次、名稱代碼、成交價、漲跌（▲▼＋顏色）、漲跌%、成交量（張）；點一列 → 交易頁；「＋」加入自選。
// - 排行是快照資料（不訂閱即時行情），以「更新於」標示時間。

import { Check, Plus } from 'lucide-react';
import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { fetchScanner } from '../../lib/shioaji';
import type { ScannerItem, ScannerType } from '../../lib/types/market';
import { fmtCompactInt, fmtPct, fmtPrice } from '../../lib/utils/format';
import * as controls from '../styles/controls.css';
import * as styles from '../styles/watchlist.css';

export type RankingKind = 'gainers' | 'losers' | 'volume' | 'amount' | 'range';

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
    { kind: 'volume', label: '成交量', type: 'VolumeRank', serverAscending: true },
    { kind: 'amount', label: '成交值', type: 'AmountRank', serverAscending: true },
    { kind: 'range', label: '高低價差', type: 'DayRangeRank', serverAscending: true },
];

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
        case 'volume':
            return Number(item.total_volume);
        case 'amount':
            return Number(item.total_amount);
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
 * 依排行指標排序（跌幅由小到大，其餘由大到小；無法計算的排最後；同值保留伺服器順序）。
 * 高低價差排行保留伺服器名次（伺服器依絕對價差排序，前端不重排）。
 */
export function sortRanking(kind: RankingKind, items: readonly ScannerItem[]): ScannerItem[] {
    if (kind === 'range') return [...items];
    const sign = kind === 'losers' ? 1 : -1;
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

const ARROW = { up: '▲', down: '▼', flat: '' } as const;
const DIR_TEXT = { up: '漲', down: '跌', flat: '平盤' } as const;

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
    const [addError, setAddError] = useState<string | null>(null);

    const setKind = useCallback((k: RankingKind) => {
        lastKind = k;
        setKindState(k);
    }, []);

    // 掛載（＝排行分段可見）與切換種類時：前景才讀；快取未過期不讀
    useEffect(() => {
        if (!pageHidden()) requestRanking(kind);
        if (typeof document === 'undefined') return;
        const onVisible = () => { if (!pageHidden()) requestRanking(kind); };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [kind]);

    const add = async (code: string) => {
        if (adding) return;
        setAdding(code);
        setAddError(null);
        try {
            await onAdd(code);
        } catch (e) {
            setAddError(`${code} 加入自選失敗：${e instanceof Error && e.message ? e.message : '請稍後再試'}`);
        } finally {
            setAdding(null);
        }
    };

    const def = defOf(kind);
    const cooling = cooldown > 0;
    const secs = Math.ceil(cooldown / 1_000);
    const items = state.items;

    return (
        <div data-testid='ranking'>
            <div className={styles.rankKinds} role='tablist' aria-label='排行種類'>
                {RANKING_DEFS.map(d => (
                    <button
                        key={d.kind}
                        type='button'
                        role='tab'
                        aria-selected={kind === d.kind}
                        className={kind === d.kind ? styles.rankKind.on : styles.rankKind.off}
                        onClick={() => setKind(d.kind)}
                        data-testid={`ranking-kind-${d.kind}`}
                    >
                        {d.label}
                    </button>
                ))}
            </div>

            <div className={styles.rankMeta}>
                <span className={styles.rankMetaText} role='status' data-testid='ranking-updated'>
                    {state.loading
                        ? `${def.label}排行讀取中…`
                        : state.fetchedAt !== null
                            ? `${def.label}前 ${RANKING_COUNT} 名・更新於 ${fmtTime(state.fetchedAt)}`
                            : ''}
                </span>
                <button
                    type='button'
                    className={controls.button.neutral}
                    disabled={state.loading || cooling}
                    aria-label={cooling ? `更新排行（${secs} 秒後可再按）` : '更新排行'}
                    onClick={() => requestRanking(kind, { force: true })}
                    data-testid='ranking-refresh'
                >
                    {cooling ? `⟳ 更新（${secs}）` : '⟳ 更新'}
                </button>
            </div>

            {state.error && (
                <div role='alert' data-testid='ranking-error'>
                    <p className={styles.error}>排行讀取失敗：{state.error}</p>
                    {!items && (
                        <div className={styles.stateActions}>
                            <button
                                type='button'
                                className={controls.button.neutral}
                                disabled={state.loading || cooling}
                                onClick={() => requestRanking(kind, { force: true })}
                                data-testid='ranking-retry'
                            >
                                {cooling ? `重試（${secs}）` : '重試'}
                            </button>
                        </div>
                    )}
                </div>
            )}
            {addError && <p className={styles.error} role='alert' data-testid='ranking-add-error'>{addError}</p>}

            {!items && state.loading && <p className={styles.state}>排行讀取中…</p>}
            {items && items.length === 0 && (
                <p className={styles.state} data-testid='ranking-empty'>目前沒有排行資料（非交易時段或模擬環境可能沒有資料）。</p>
            )}

            {items && items.length > 0 && (
                <ol className={styles.list} aria-label={`${def.label}排行`} data-testid='ranking-list'>
                    {items.map((item, index) => (
                        <RankingRow
                            key={item.code}
                            rank={index + 1}
                            kind={kind}
                            item={item}
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

function RankingRow({ rank, kind, item, watched, canAdd, adding, onOpen, onAdd }: {
    rank: number;
    kind: RankingKind;
    item: ScannerItem;
    watched: boolean;
    canAdd: boolean;
    adding: boolean;
    onOpen: (code: string) => void;
    onAdd: (code: string) => void;
}) {
    const chg = Number(item.change_price);
    const dir = !Number.isFinite(chg) || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down';
    const pct = rankingChangePct(item);
    const priceText = fmtPrice(item.close);
    const chgText = Number.isFinite(chg) ? `${ARROW[dir]}${fmtPrice(Math.abs(chg))}` : '—';
    const pctText = pct !== undefined ? fmtPct(pct) : '—';
    const volText = fmtCompactInt(Number(item.total_volume));
    const extra = kind === 'amount'
        ? `值 ${fmtAmount(Number(item.total_amount))}`
        : kind === 'range'
            ? rangeText(item)
            : null;
    const name = item.name ?? '';

    return (
        <li className={styles.rowItem} data-code={item.code} data-testid='ranking-row'>
            <button
                type='button'
                className={styles.rankRow}
                aria-label={`第 ${rank} 名 ${item.code} ${name}，${priceText}，${DIR_TEXT[dir]} ${chgText} ${pctText}，成交量 ${volText} 張${extra ? `，${extra}` : ''}`}
                onClick={() => onOpen(item.code)}
                data-testid='ranking-row-button'
            >
                <span className={styles.rankNo}>{rank}</span>
                <span className={styles.rowName}>
                    <span className={styles.rowCode}>{name || item.code}</span>
                    <span className={styles.rowSub}>{item.code}</span>
                </span>
                <span className={styles.rankPriceCell}>
                    <span className={`${styles.rowPrice} ${styles.tone[dir]}`} data-testid='ranking-price'>{priceText}</span>
                    <span className={styles.rankVolume}>量 {volText}{extra ? ` ${extra}` : ''}</span>
                </span>
                <span className={`${styles.rowChange} ${styles.tone[dir]}`}>
                    <span data-testid='ranking-change'>{chgText}</span>
                    <span data-testid='ranking-pct'>{pctText}</span>
                </span>
            </button>
            <button
                type='button'
                className={styles.rowMore}
                disabled={watched || !canAdd}
                aria-label={watched ? `${item.code} 已在自選` : adding ? `${item.code} 加入自選中` : `${item.code} 加入自選`}
                onClick={() => onAdd(item.code)}
                data-testid='ranking-add'
            >
                {watched ? <Check size={20} aria-hidden='true' /> : <Plus size={20} aria-hidden='true' />}
            </button>
        </li>
    );
}
