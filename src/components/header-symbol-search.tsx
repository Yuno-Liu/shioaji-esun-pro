// src/components/header-symbol-search.tsx — 頂欄快速商品搜尋與連動切換
// 常駐顯示目前主畫面連動商品；點擊可直接輸入股票名稱／代號（支援模糊搜尋），
// 下拉建議清單可一鍵切換主畫面連動面板或「＋自選」加入目前自選清單。

import { Check, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WatchItem } from '../hooks/use-watchlist';
import { primeContract } from '../lib/contracts-cache';
import {
    searchProducts,
    type ProductSuggestion,
} from '../lib/product-search';
import { loadStockCatalog } from '../lib/stock-index';
import { notify } from '../lib/trade';
import type { ContractInfo, SecurityType } from '../lib/types/contract';
import { AsyncStatus } from './async-status';
import * as styles from './header-symbol-search.css';

export interface HeaderSymbolSearchProps {
    selected?: ContractInfo | null;
    watchlistItems?: WatchItem[];
    onSelectCode?: (
        code: string,
        type?: SecurityType,
    ) => Promise<unknown> | unknown;
    onAddWatchlist?: (
        code: string,
        type?: SecurityType,
        resolved?: ContractInfo,
    ) => Promise<unknown>;
}

function watchItemToSuggestion(item: WatchItem): ProductSuggestion {
    const c = item.contract;
    return {
        code: c.code,
        name: c.name || c.code,
        security_type: (c.security_type ?? 'STK') as Exclude<
            SecurityType,
            null
        >,
        exchange: c.exchange ?? '',
        detail:
            c.security_type === 'FUT'
                ? '期貨'
                : c.security_type === 'IND'
                  ? '指數'
                  : c.security_type === 'OPT'
                    ? '選擇權'
                    : '自選',
        contract: c,
    };
}

export function HeaderSymbolSearch({
    selected = null,
    watchlistItems = [],
    onSelectCode,
    onAddWatchlist,
}: HeaderSymbolSearchProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
    const [activeIndex, setActiveIndex] = useState(0);
    const [addingCode, setAddingCode] = useState<string | null>(null);
    // IME 組字中（注音／倉頡）不搜尋：只在組字結束後以最終文字搜尋
    const [composing, setComposing] = useState(false);

    const wrapRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const resolvedQueryRef = useRef('');

    const watchlistCodes = useMemo(
        () => new Set(watchlistItems.map((i) => i.contract.code)),
        [watchlistItems],
    );

    const watchlistSuggestions = useMemo(
        () => watchlistItems.slice(0, 8).map(watchItemToSuggestion),
        [watchlistItems],
    );

    const trimmedQuery = query.trim();
    const visibleItems = trimmedQuery ? suggestions : watchlistSuggestions;

    // 點擊外部自動收起下拉選單並恢復顯示目前連動商品
    useEffect(() => {
        if (!open || typeof document === 'undefined') return;
        const onMouseDown = (event: MouseEvent) => {
            if (
                wrapRef.current &&
                !wrapRef.current.contains(event.target as Node)
            ) {
                setOpen(false);
                setQuery('');
                setError(null);
            }
        };
        document.addEventListener('mousedown', onMouseDown);
        return () => document.removeEventListener('mousedown', onMouseDown);
    }, [open]);

    // 輸入變更時進行模糊搜尋；新的輸入會取消上一筆尚未完成的搜尋
    useEffect(() => {
        if (composing) {
            setSearching(false);
            return;
        }
        if (!open || !trimmedQuery) {
            setSuggestions([]);
            setSearching(false);
            resolvedQueryRef.current = '';
            return;
        }
        let active = true;
        const controller =
            typeof AbortController !== 'undefined'
                ? new AbortController()
                : undefined;
        setSearching(true);
        const timer = setTimeout(() => {
            void searchProducts(trimmedQuery, 10, {
                signal: controller?.signal,
            })
                .then((items) => {
                    if (!active) return;
                    resolvedQueryRef.current = trimmedQuery;
                    setSuggestions(items);
                    setActiveIndex(0);
                    setSearching(false);
                })
                .catch(() => {
                    if (!active) return;
                    resolvedQueryRef.current = trimmedQuery;
                    setSuggestions([]);
                    setSearching(false);
                });
        }, 90);
        return () => {
            active = false;
            clearTimeout(timer);
            controller?.abort();
        };
    }, [open, trimmedQuery, composing]);

    const closeSearch = () => {
        setOpen(false);
        setQuery('');
        setError(null);
        setComposing(false);
        inputRef.current?.blur();
    };

    const optionId = (idx: number) => `header-symbol-search-opt-${idx}`;
    const activeDescendant =
        open && visibleItems[activeIndex] ? optionId(activeIndex) : undefined;

    const pickSuggestion = async (item: ProductSuggestion) => {
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            if (item.contract) primeContract(item.contract);
            await onSelectCode?.(item.code, item.security_type);
            closeSearch();
        } catch {
            setError(`找不到商品「${item.code}」`);
        } finally {
            setSubmitting(false);
        }
    };

    const submit = async () => {
        if (submitting) return;
        if (!trimmedQuery) {
            const item = visibleItems[activeIndex];
            if (item) await pickSuggestion(item);
            else closeSearch();
            return;
        }
        let target =
            resolvedQueryRef.current === trimmedQuery
                ? suggestions[activeIndex] ?? suggestions[0]
                : undefined;
        setSubmitting(true);
        setError(null);
        try {
            if (!target && resolvedQueryRef.current !== trimmedQuery) {
                const fresh = await searchProducts(trimmedQuery, 4).catch(
                    () => [],
                );
                target = fresh[0];
            }
            if (target) {
                if (target.contract) primeContract(target.contract);
                await onSelectCode?.(target.code, target.security_type);
                closeSearch();
                return;
            }
            const directCode = trimmedQuery.toUpperCase();
            await onSelectCode?.(directCode);
            closeSearch();
        } catch {
            setError(`找不到「${trimmedQuery}」`);
        } finally {
            setSubmitting(false);
        }
    };

    const handleAddWatchlist = async (item: ProductSuggestion) => {
        if (!onAddWatchlist || addingCode) return;
        setAddingCode(item.code);
        try {
            await onAddWatchlist(item.code, item.security_type, item.contract);
            notify({
                kind: 'ok',
                title: '已加入自選',
                body: `${item.code} ${item.name}`,
            });
        } catch (err) {
            notify({
                kind: 'err',
                title: '加入自選失敗',
                body: err instanceof Error ? err.message : String(err),
            });
        } finally {
            setAddingCode(null);
        }
    };

    const idleText = selected
        ? `${selected.code} ${selected.name}`.trim()
        : '';
    const placeholder = open
        ? selected
            ? `${selected.code} ${selected.name} · 輸入名稱或代號…`
            : '輸入股票、期貨或代號（支援模糊搜尋）…'
        : '搜尋股票 / 代號…';

    return (
        <div
            ref={wrapRef}
            className={styles.wrap}
            data-testid='header-symbol-search'
        >
            <div className={styles.inputShell}>
                <span className={styles.searchIcon} aria-hidden='true'>
                    <Search size={12} />
                </span>
                <input
                    ref={inputRef}
                    type='text'
                    role='combobox'
                    aria-label='快速商品搜尋與版面連動'
                    aria-expanded={open}
                    aria-autocomplete='list'
                    aria-controls='header-symbol-search-listbox'
                    aria-activedescendant={activeDescendant}
                    className={styles.input}
                    value={open ? query : idleText}
                    placeholder={placeholder}
                    title='快速輸入股票名稱或代號（支援模糊搜尋）以連動版面'
                    onFocus={() => {
                        setOpen(true);
                        setQuery('');
                        setError(null);
                        setActiveIndex(0);
                        void loadStockCatalog().catch(() => undefined);
                    }}
                    onChange={(e) => {
                        if (!open) setOpen(true);
                        setQuery(e.target.value);
                        setError(null);
                        setActiveIndex(0);
                    }}
                    onCompositionStart={() => setComposing(true)}
                    onCompositionEnd={(e) => {
                        setComposing(false);
                        setQuery(e.currentTarget.value);
                    }}
                    onBlur={(e) => {
                        // Tab 或其他方式把焦點移出元件時收起下拉選單
                        const next = e.relatedTarget as Node | null;
                        if (next && wrapRef.current?.contains(next)) return;
                        setOpen(false);
                        setQuery('');
                        setError(null);
                        setComposing(false);
                    }}
                    onKeyDown={(e) => {
                        if (
                            composing ||
                            e.nativeEvent?.isComposing ||
                            e.keyCode === 229
                        ) {
                            return;
                        }
                        if (e.key === 'ArrowDown' && visibleItems.length > 0) {
                            e.preventDefault?.();
                            setActiveIndex(
                                (idx) => (idx + 1) % visibleItems.length,
                            );
                            return;
                        }
                        if (e.key === 'ArrowUp' && visibleItems.length > 0) {
                            e.preventDefault?.();
                            setActiveIndex(
                                (idx) =>
                                    (idx - 1 + visibleItems.length) %
                                    visibleItems.length,
                            );
                            return;
                        }
                        if (e.key === 'Enter') {
                            e.preventDefault?.();
                            void submit();
                            return;
                        }
                        if (e.key === 'Escape') {
                            e.preventDefault?.();
                            e.stopPropagation?.();
                            closeSearch();
                        }
                    }}
                />
                {open && query ? (
                    <button
                        type='button'
                        className={styles.clearBtn}
                        title='清除輸入'
                        aria-label='清除搜尋輸入'
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                            setQuery('');
                            setError(null);
                            setActiveIndex(0);
                            inputRef.current?.focus();
                        }}
                    >
                        <X size={11} />
                    </button>
                ) : null}
            </div>

            {open && (
                <div className={styles.dropdown}>
                    <div className={styles.sectionHeader}>
                        <span>
                            {trimmedQuery
                                ? '模糊搜尋結果（點擊連動版面）'
                                : '自選清單快速連動（直接打字可模糊搜尋全市場）'}
                        </span>
                        {selected && (
                            <span>目前：{selected.code}</span>
                        )}
                    </div>

                    {/* 狀態列放在 listbox 之外：listbox 只包含 option */}
                    <div role='status' aria-live='polite'>
                        {searching && visibleItems.length === 0 && (
                            <div className={styles.statusRow}>
                                <AsyncStatus
                                    phase='loading'
                                    size={12}
                                    text='搜尋商品中…'
                                />
                            </div>
                        )}

                        {!searching &&
                            !composing &&
                            trimmedQuery &&
                            visibleItems.length === 0 && (
                                <div className={styles.statusRow}>
                                    找不到相符商品，按 Enter 直接解析代碼「
                                    {trimmedQuery.toUpperCase()}」
                                </div>
                            )}

                        {!trimmedQuery && visibleItems.length === 0 && (
                            <div className={styles.statusRow}>
                                輸入代號或中文名稱（如：2330、台積、元大50、小台）
                            </div>
                        )}
                    </div>

                    <div
                        id='header-symbol-search-listbox'
                        role='listbox'
                        aria-label='商品搜尋建議'
                        className={styles.list}
                    >

                        {visibleItems.map((item, idx) => {
                            const isSelected = selected?.code === item.code;
                            const inWatchlist = watchlistCodes.has(item.code);
                            const isActive = idx === activeIndex;
                            return (
                                <div
                                    key={`${item.security_type}:${item.code}`}
                                    id={optionId(idx)}
                                    role='option'
                                    aria-selected={isActive}
                                    className={
                                        isActive ? styles.rowActive : styles.row
                                    }
                                    onMouseEnter={() => setActiveIndex(idx)}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => void pickSuggestion(item)}
                                >
                                    <span className={styles.code}>
                                        {item.code}
                                    </span>
                                    <span className={styles.name}>
                                        {item.name}
                                    </span>
                                    <span className={styles.detail}>
                                        {isSelected ? (
                                            <span className={styles.linkedTag}>
                                                連動中
                                            </span>
                                        ) : (
                                            item.detail
                                        )}
                                    </span>
                                    {item.security_type !== 'OPT' &&
                                        (inWatchlist ? (
                                            <span
                                                className={styles.watchedTag}
                                                title='已在目前自選清單中'
                                            >
                                                <Check size={10} /> 自選
                                            </span>
                                        ) : onAddWatchlist ? (
                                            <button
                                                type='button'
                                                tabIndex={-1}
                                                className={styles.watchBtn}
                                                disabled={
                                                    addingCode === item.code
                                                }
                                                title='加入目前自選清單'
                                                aria-label={`將 ${item.code} 加入自選`}
                                                onMouseDown={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    void handleAddWatchlist(
                                                        item,
                                                    );
                                                }}
                                            >
                                                <Plus size={10} /> 自選
                                            </button>
                                        ) : (
                                            <span />
                                        ))}
                                </div>
                            );
                        })}
                    </div>

                    {error && <div className={styles.errorRow}>{error}</div>}

                    <div className={styles.footer}>
                        <span>↑↓ 選擇 · Enter 連動版面 · Esc 關閉</span>
                        <span>支援代號／簡稱模糊搜尋</span>
                    </div>
                </div>
            )}
        </div>
    );
}
