// src/mobile/hooks/use-product-search.ts — 商品搜尋（debounce＋取消舊查詢；規格 §6.1）
//
// 自選的搜尋面板（search-sheet.tsx）與交易頁的切換商品面板（trade-switch-sheet.tsx）共用：
// - 輸入停頓 SEARCH_DEBOUNCE_MS 才以 searchProducts(q, SEARCH_LIMIT, { signal }) 查詢；
// - 新的輸入（或關閉、清空）會 abort 前一次查詢，晚到的舊結果不會蓋掉新結果；
// - 關閉或查詢字串為空白時回到 idle、清空結果，不發查詢。
// - paused（例如面板退場中：內容凍結、畫面還看得到）：只取消 debounce 計時與進行中的查詢，不發新查詢，
//   結果與狀態維持原樣（退場中的畫面不變回空白，晚到的結果也不會換掉它）。

import { useEffect, useState } from 'react';
import { searchProducts, type ProductSuggestion } from '../../lib/product-search';

/** 輸入停頓多久才查詢（ms） */
export const SEARCH_DEBOUNCE_MS = 250;
/** 每次查詢的結果上限（規格 §6.1） */
export const SEARCH_LIMIT = 10;

export type SearchStatus = 'idle' | 'loading' | 'done' | 'error';

const TYPE_TEXT: Record<string, string> = { STK: '股票', FUT: '期貨', OPT: '選擇權', IND: '指數' };

/** 商品種類文字（未知種類原樣） */
export function securityTypeText(type: string | null | undefined): string {
    return type ? TYPE_TEXT[type] ?? type : '';
}

/** 結果列第二行：種類 · 細節（例如「股票 · 上市」） */
export function suggestionSubText(s: Pick<ProductSuggestion, 'security_type' | 'detail'>): string {
    return [securityTypeText(s.security_type), s.detail].filter(Boolean).join(' · ');
}

export function useProductSearch(
    query: string,
    active: boolean,
    options?: { paused?: boolean },
): { results: ProductSuggestion[]; status: SearchStatus } {
    const [results, setResults] = useState<ProductSuggestion[]>([]);
    const [status, setStatus] = useState<SearchStatus>('idle');
    const paused = options?.paused === true;

    useEffect(() => {
        // 暫停：上一次 effect 的 cleanup 已 clearTimeout＋abort；這裡不動結果與狀態
        if (paused) return;
        const q = query.trim();
        if (!active || !q) {
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
    }, [query, active, paused]);

    return { results, status };
}
