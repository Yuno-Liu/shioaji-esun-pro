// src/mobile/components/search-sheet.tsx — 商品搜尋面板（規格 §6.1；設計規格 §7.2）
//
// - searchProducts(query, 10)：輸入以 SEARCH_DEBOUNCE_MS debounce；新的輸入會 abort 前一次查詢（signal），
//   晚到的舊結果不會蓋掉新結果（hooks/use-product-search.ts，與交易頁切換商品面板共用）。
// - 每筆結果可「加入自選」（由父層呼叫 useWatchlist().addSymbol）或直接開交易頁。
// - 只做查詢與導覽，不會下單。
// - 版面：面板 large；搜尋框在 body 內 position: sticky; top: 0（不透明、不模糊）；結果列與自選列同樣式
//   （代碼 headline＋名稱、第二行種類），列尾「加入自選／已在自選」與「交易」晶片（沿用 ui/chip.css 外觀，
//   按鈕文字節點恰為標籤）。

import { useEffect, useRef, useState } from 'react';
import type { ProductSuggestion } from '../../lib/product-search';
import { suggestionSubText, useProductSearch } from '../hooks/use-product-search';
import { focusRing, pressable, pressableRow } from '../styles/primitives.css';
import * as styles from '../styles/watchlist.css';
import { chip } from '../ui/chip.css';
import { InlineNote } from '../ui/inline-note';
import { BottomSheet } from './bottom-sheet';

// debounce 與上限沿用共用 hook（交易頁切換商品面板同一套）；保留從這裡匯出
export { SEARCH_DEBOUNCE_MS, SEARCH_LIMIT } from '../hooks/use-product-search';

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

export function SearchSheet({ open, onClose, watchedCodes, canAdd, onAdd, onOpenTrade }: SearchSheetProps) {
    const [query, setQuery] = useState('');
    const { results, status } = useProductSearch(query, open);
    const [adding, setAdding] = useState<string | null>(null);
    const [messages, setMessages] = useState<Record<string, string>>({});
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);

    // 關閉時清空，下次開啟是乾淨的搜尋
    useEffect(() => {
        if (open) return;
        setQuery('');
        setMessages({});
        setAdding(null);
    }, [open]);

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

    const chipClass = `${chip} ${pressable} ${focusRing} ${styles.resultChip}`;

    return (
        <BottomSheet open={open} onClose={onClose} title='搜尋商品' testId='search-sheet' detent='large'>
            <div className={styles.searchBar}>
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
            </div>
            {status === 'loading' && <p className={styles.searchStatus} role='status'>搜尋中…</p>}
            {status === 'error' && <p className={styles.searchStatus} role='status'>搜尋失敗，請稍後再試。</p>}
            {status === 'done' && results.length === 0 && <p className={styles.searchStatus} role='status'>找不到符合的商品。</p>}
            {results.length > 0 && (
                <ul className={styles.resultList} data-testid='search-results'>
                    {results.map(s => {
                        const watched = watchedCodes.has(s.code);
                        const message = messages[s.code];
                        return (
                            <li key={`${s.security_type}:${s.exchange}:${s.code}`} className={styles.resultItem} data-testid='search-result'>
                                <div className={styles.resultRow}>
                                    <button
                                        type='button'
                                        className={`${styles.resultMain} ${pressableRow}`}
                                        onClick={() => onOpenTrade(s.code)}
                                        aria-label={`開啟 ${s.code} ${s.name} 交易頁`}
                                    >
                                        <span className={styles.rowTitleLine}>
                                            <span className={styles.rowCode}>{s.code}</span>
                                            <span className={styles.resultName}>{s.name}</span>
                                        </span>
                                        <span className={styles.rowSub}>{suggestionSubText(s)}</span>
                                    </button>
                                    <button
                                        type='button'
                                        className={chipClass}
                                        disabled={watched || !canAdd || adding !== null}
                                        aria-label={watched ? `${s.code} 已在自選` : adding === s.code ? `${s.code} 加入中` : `${s.code} 加入自選`}
                                        onClick={() => void add(s)}
                                        data-testid='search-add'
                                    >
                                        {watched ? '已在自選' : adding === s.code ? '加入中…' : '加入自選'}
                                    </button>
                                    <button
                                        type='button'
                                        className={chipClass}
                                        aria-label={`${s.code} 交易`}
                                        onClick={() => onOpenTrade(s.code)}
                                        data-testid='search-trade'
                                    >
                                        交易
                                    </button>
                                </div>
                                {message && (
                                    <div className={styles.resultMessage}>
                                        <InlineNote tone='warn' role='alert'>{message}</InlineNote>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            {!canAdd && results.length > 0 && <p className={styles.searchStatus}>自選清單載入或更新中，稍後才能加入。</p>}
        </BottomSheet>
    );
}
