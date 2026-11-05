// src/mobile/components/search-sheet.tsx — 商品搜尋面板（規格 §6.1）
//
// - searchProducts(query, 10)：輸入以 SEARCH_DEBOUNCE_MS debounce；新的輸入會 abort 前一次查詢（signal），
//   晚到的舊結果不會蓋掉新結果。
// - 每筆結果可「加入自選」（由父層呼叫 useWatchlist().addSymbol）或直接開交易頁。
// - 只做查詢與導覽，不會下單。

import { useEffect, useRef, useState } from 'react';
import { searchProducts, type ProductSuggestion } from '../../lib/product-search';
import * as styles from '../styles/watchlist.css';
import { BottomSheet } from './bottom-sheet';

/** 輸入停頓多久才查詢（ms） */
export const SEARCH_DEBOUNCE_MS = 250;
/** 每次查詢的結果上限（規格 §6.1） */
export const SEARCH_LIMIT = 10;

type SearchStatus = 'idle' | 'loading' | 'done' | 'error';

export interface SearchSheetProps {
    open: boolean;
    onClose: () => void;
    /** 目前自選清單已有的代碼（顯示「已在自選」） */
    watchedCodes: ReadonlySet<string>;
    /** false：清單載入中或更新中，暫不能加入 */
    canAdd: boolean;
    /** 加入自選；失敗時丟出錯誤（訊息會顯示在該列） */
    onAdd: (suggestion: ProductSuggestion) => Promise<void>;
    /** 開啟交易頁 */
    onOpenTrade: (code: string) => void;
}

const TYPE_TEXT: Record<string, string> = { STK: '股票', FUT: '期貨', OPT: '選擇權', IND: '指數' };

export function SearchSheet({ open, onClose, watchedCodes, canAdd, onAdd, onOpenTrade }: SearchSheetProps) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<ProductSuggestion[]>([]);
    const [status, setStatus] = useState<SearchStatus>('idle');
    const [adding, setAdding] = useState<string | null>(null);
    const [messages, setMessages] = useState<Record<string, string>>({});
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);

    // 關閉時清空，下次開啟是乾淨的搜尋
    useEffect(() => {
        if (open) return;
        setQuery('');
        setResults([]);
        setStatus('idle');
        setMessages({});
        setAdding(null);
    }, [open]);

    useEffect(() => {
        const q = query.trim();
        if (!open || !q) {
            setResults([]);
            setStatus('idle');
            return;
        }
        const controller = new AbortController();
        setStatus('loading');
        const timer = setTimeout(() => {
            searchProducts(q, SEARCH_LIMIT, { signal: controller.signal }).then(
                rows => {
                    if (controller.signal.aborted) return;
                    setResults(rows);
                    setStatus('done');
                },
                () => {
                    if (controller.signal.aborted) return;
                    setResults([]);
                    setStatus('error');
                },
            );
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [query, open]);

    const add = async (s: ProductSuggestion) => {
        if (adding) return;
        setAdding(s.code);
        setMessages(m => ({ ...m, [s.code]: '' }));
        try {
            await onAdd(s);
        } catch (e) {
            if (mounted.current) setMessages(m => ({ ...m, [s.code]: e instanceof Error && e.message ? e.message : '加入自選失敗，請稍後再試' }));
        } finally {
            if (mounted.current) setAdding(null);
        }
    };

    return (
        <BottomSheet open={open} onClose={onClose} title='搜尋商品' testId='search-sheet'>
            <input
                className={styles.searchInput}
                type='search'
                inputMode='search'
                enterKeyHint='search'
                autoComplete='off'
                autoCorrect='off'
                autoCapitalize='off'
                spellCheck={false}
                placeholder='代碼或名稱，例如 2330、台積電、台指期'
                aria-label='搜尋商品'
                value={query}
                maxLength={40}
                onChange={e => setQuery(e.target.value)}
                data-testid='search-input'
            />
            {status === 'loading' && <p className={styles.searchStatus} role='status'>搜尋中…</p>}
            {status === 'error' && <p className={styles.searchStatus} role='status'>搜尋失敗，請稍後再試。</p>}
            {status === 'done' && results.length === 0 && <p className={styles.searchStatus} role='status'>找不到符合的商品。</p>}
            {results.length > 0 && (
                <ul className={styles.resultList} data-testid='search-results'>
                    {results.map(s => {
                        const watched = watchedCodes.has(s.code);
                        const message = messages[s.code];
                        return (
                            <li key={`${s.security_type}:${s.exchange}:${s.code}`} data-testid='search-result'>
                                <div className={styles.resultRow}>
                                    <button
                                        type='button'
                                        className={styles.resultMain}
                                        onClick={() => onOpenTrade(s.code)}
                                        aria-label={`開啟 ${s.code} ${s.name} 交易頁`}
                                    >
                                        <span className={styles.rowCode}>{s.code} {s.name}</span>
                                        <span className={styles.rowSub}>{[TYPE_TEXT[s.security_type] ?? s.security_type, s.detail].filter(Boolean).join(' · ')}</span>
                                    </button>
                                    <button
                                        type='button'
                                        className={styles.resultButton}
                                        disabled={watched || !canAdd || adding !== null}
                                        onClick={() => void add(s)}
                                        data-testid='search-add'
                                    >
                                        {watched ? '已在自選' : adding === s.code ? '加入中…' : '加入自選'}
                                    </button>
                                    <button
                                        type='button'
                                        className={styles.resultButton}
                                        onClick={() => onOpenTrade(s.code)}
                                        data-testid='search-trade'
                                    >
                                        交易
                                    </button>
                                </div>
                                {message && <p className={styles.resultMessage} role='alert'>{message}</p>}
                            </li>
                        );
                    })}
                </ul>
            )}
            {!canAdd && results.length > 0 && <p className={styles.searchStatus}>自選清單載入或更新中，稍後才能加入。</p>}
        </BottomSheet>
    );
}
