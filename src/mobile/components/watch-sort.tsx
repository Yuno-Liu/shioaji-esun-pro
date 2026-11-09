// src/mobile/components/watch-sort.tsx — 自選清單的排序鍵（延遲載入；lib/deferred-modules.ts loadWatchSort；設計規格 §7.2）
//
// - 放在清單表頭（名稱｜排序｜指標切換｜編輯）；點按開選項面板：自訂順序（只有自己的清單）、股票代號、股價、漲幅%、漲跌。
//   點目前的選項＝反向（自訂順序除外）；選了就關閉面板。偏好依清單 id 存在這台裝置（lib/watch-sort.ts）。
// - 只是檢視排序：把排好的代碼順序交給 onOrder（自訂順序時 null），**從不寫回伺服器清單**；編輯模式由自選頁隱藏本元件、顯示伺服器順序。
// - 股價類排序：開啟清單（或選了這個排序）時取一次批次快照當排序依據，表頭第二行顯示「排序依據 HH:MM:SS」與［⟳］
//   （最短間隔 SORT_MIN_INTERVAL_MS；讀取中、間隔內停用）。之後即時行情只更新列上的數字，不會重排。
//   讀取失敗：第二行顯示「排序資料讀取失敗」，［⟳］可重試；列維持基準順序。
// - 「持倉」分段（components/holdings-list.tsx）也用本元件：listId 'pos:holdings'，manualLabel「持倉順序」，項目 id 為合併鍵；
//   合約尚未解析的項目（resolved false）不送進排序依據的快照請求。
// - 固定清單（股期近月／遠月）把自己的排序依據（開啟時取的那一次快照，也是列的快照備援）傳進 basis，不另外請求。
// - 安全：本元件與選項面板只改顯示順序與本裝置偏好，不呼叫任何下單、改單、刪單，也不開下單面板（設計規格 §10 S1）。

import { ArrowDown, ArrowUp, ArrowUpDown, Check, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Snapshot } from '../../lib/types/market';
import {
    fetchSortSnapshots,
    getSortBasis,
    isPriceKey,
    nextSortPref,
    readSortPref,
    setSortBasis,
    snapshotIndex,
    SORT_LABEL,
    SORT_MIN_INTERVAL_MS,
    sortCodes,
    sortDirText,
    sortKeys,
    writeSortPref,
    type SortBasisEntry,
    type SortItem,
    type SortKey,
    type SortPref,
} from '../lib/watch-sort';
import { focusRing, pressable } from '../styles/primitives.css';
import * as styles from '../styles/watch-sort.css';
import { GroupedSection, ListRow } from '../ui/grouped';
import { IconButton } from '../ui/icon-button';
import { BottomSheet } from './bottom-sheet';

export interface SortBasis {
    entry: SortBasisEntry | undefined;
    loading: boolean;
    error: boolean;
    /** 間隔內（或讀取中）不能重新取 */
    wait: boolean;
    /** 重新取一次排序依據（讀取中、間隔內不動） */
    refresh: () => void;
}

/** 台北時間 HH:MM:SS */
export const basisTime = (at: number): string => new Date(at + 8 * 3_600_000).toISOString().slice(11, 19);

/**
 * 清單的排序依據（批次快照）：active 時開啟清單就取一次（SORT_MIN_INTERVAL_MS 內取過的沿用）；refresh() 再取。
 * 結果存在模組層（lib/watch-sort.ts），切換清單再回來仍在。
 */
export function useSortBasis(listId: string, items: readonly SortItem[], active: boolean): SortBasis {
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const [entry, setEntry] = useState(() => getSortBasis(listId));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const inflight = useRef(false);
    const alive = useRef(true);
    const [, wake] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
    }, []);

    const refresh = useCallback(() => {
        const cached = getSortBasis(listId);
        // 尚未解析的合約（resolved false）不送出：沒有交易所等欄位，股價類排序視為沒有資料
        const contracts = itemsRef.current.filter(i => i.resolved !== false).map(i => i.contract);
        if (inflight.current || !contracts.length || (cached && Date.now() - cached.at < SORT_MIN_INTERVAL_MS)) return;
        inflight.current = true;
        setLoading(true);
        setError(false);
        fetchSortSnapshots(contracts).then(
            rows => {
                const next = { at: Date.now(), snapshots: snapshotIndex(contracts, rows) };
                setSortBasis(listId, next);
                if (alive.current) setEntry(next);
            },
            () => { if (alive.current) setError(true); },
        ).finally(() => {
            inflight.current = false;
            if (alive.current) setLoading(false);
        });
    }, [listId]);

    useEffect(() => {
        if (active) refresh();
    }, [active, refresh]);

    // 間隔結束時重繪（［⟳］恢復可按）
    const left = entry ? entry.at + SORT_MIN_INTERVAL_MS - Date.now() : 0;
    useEffect(() => {
        if (left <= 0) return;
        const t = setTimeout(wake, left + 50);
        return () => clearTimeout(t);
    }, [entry, left]);

    return { entry, loading, error, wait: loading || left > 0, refresh };
}

const ARROW_ICON = { asc: ArrowUp, desc: ArrowDown } as const;

export interface WatchSortProps {
    /** 清單 id（伺服器清單 id，或固定清單 'fut:near'／'fut:next'） */
    listId: string;
    /** 固定清單：沒有「自訂順序」，預設股票代號 */
    fixed?: boolean;
    items: readonly SortItem[];
    /** 排好的代碼順序；自訂順序時 null。需為穩定的函式 */
    onOrder: (codes: string[] | null) => void;
    /** 固定清單自己的排序依據（未給時本元件在股價類排序時自己取） */
    basis?: SortBasis;
    /** 「自訂順序」那一項的名稱與說明（持倉分段：「持倉順序」） */
    manualLabel?: string;
    manualText?: string;
    /** 選項面板底部說明（未給時用自選清單的說明） */
    footer?: string;
}

const WATCH_SORT_FOOTER = '排序只改變這台裝置上的顯示順序，不會改動自選清單本身的順序；股價類排序依按下時的價格，之後不會自動重排。';

/** 換清單時整個重新建立（偏好、排序依據都依清單 id） */
export function WatchSort(props: WatchSortProps) {
    return <WatchSortInner key={props.listId} {...props} />;
}

function WatchSortInner({ listId, fixed = false, items, onOrder, basis, manualLabel, manualText, footer = WATCH_SORT_FOOTER }: WatchSortProps) {
    const [pref, setPref] = useState<SortPref>(() => readSortPref(listId, fixed));
    const [open, setOpen] = useState(false);
    const price = isPriceKey(pref.key);
    const own = useSortBasis(listId, items, price && !basis);
    const b = basis ?? own;
    const snapshots: ReadonlyMap<string, Snapshot> | undefined = b.entry?.snapshots;
    const order = useMemo(() => sortCodes(items, pref, snapshots), [items, pref, snapshots]);
    // 版面效果：清單在同一次繪製前換成排好的順序（不閃一幀伺服器順序）
    useLayoutEffect(() => { onOrder(order); }, [order, onOrder]);

    const choose = (key: SortKey) => {
        const next = nextSortPref(pref, key);
        setPref(next);
        writeSortPref(listId, next);
        setOpen(false);
        if (isPriceKey(key)) b.refresh();
    };

    const Arrow = ARROW_ICON[pref.dir];
    const labelOf = (key: SortKey) => (key === 'manual' && manualLabel ? manualLabel : SORT_LABEL[key]);
    const dirText = (p: SortPref) => sortDirText(p, manualText);
    const label = labelOf(pref.key);
    return (
        <>
            <button
                type='button'
                className={`${styles.sortButton} ${pressable} ${focusRing}`}
                aria-label={`排序：${label}，${dirText(pref)}；點按變更`}
                aria-haspopup='dialog'
                onClick={() => setOpen(true)}
                data-testid='watch-sort'
                data-sort={`${pref.key}:${pref.dir}`}
            >
                {label}
                {pref.key === 'manual'
                    ? <ArrowUpDown className={styles.sortIcon} aria-hidden='true' focusable='false' />
                    : <Arrow className={styles.sortIcon} aria-hidden='true' focusable='false' />}
            </button>
            {price && (
                <div className={styles.basisLine} data-testid='watch-sort-basis'>
                    <span className={b.error ? `${styles.basisText} ${styles.basisError}` : styles.basisText} role='status'>
                        {b.loading ? '排序資料讀取中…' : b.error ? '排序資料讀取失敗，請按 ⟳ 重試' : b.entry ? `排序依據 ${basisTime(b.entry.at)}` : '排序資料讀取中…'}
                    </span>
                    <IconButton
                        ariaLabel='依目前價格重新排序'
                        icon={RotateCw}
                        iconSize={18}
                        disabled={b.wait}
                        onClick={b.refresh}
                        testId='watch-sort-refresh'
                    />
                </div>
            )}
            <BottomSheet open={open} onClose={() => setOpen(false)} title='排序' testId='watch-sort-sheet'>
                <div className={styles.sheetBody}>
                    <GroupedSection footer={footer}>
                        {sortKeys(fixed).map(key => {
                            const active = key === pref.key;
                            const nextDir = active && key !== 'manual' ? nextSortPref(pref, key) : null;
                            return (
                                <ListRow
                                    key={key}
                                    title={labelOf(key)}
                                    subtitle={active ? `目前：${dirText(pref)}${nextDir ? `；再點一次改為${dirText(nextDir)}` : ''}` : undefined}
                                    trailing={active ? <Check className={styles.optionCheck} aria-hidden='true' focusable='false' /> : undefined}
                                    onClick={() => choose(key)}
                                    testId={`watch-sort-option-${key}`}
                                />
                            );
                        })}
                    </GroupedSection>
                </div>
            </BottomSheet>
        </>
    );
}
