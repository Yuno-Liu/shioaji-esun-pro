// src/components/bottom-dock-scope.ts — fork：Dock 帳戶範圍的「預設值」跟隨頂欄帳號。
// 只在頂欄帳號改變的那一刻把範圍重設為頂欄帳號（render 期推導，不用 effect 鎖回），
// 之後使用者仍可改選「全部帳戶」；「開啟委託查詢（全部帳戶）」、「顯示全部」與
// 批次刪單全選看到的就是全部帳戶，不會被蓋回頂欄帳號。
import { useCallback, useState } from 'react';
import { useAccounts } from '../lib/account-store';
import { headerAccountOf } from '../lib/order-route';
import { accountToRef, refKey } from './bottom-dock-shared';

export function useHeaderDefaultScope(): [string, (scope: string) => void] {
    const header = headerAccountOf(useAccounts());
    const headerKey = header ? refKey(accountToRef(header)) : '';
    const [state, setState] = useState({ headerKey, scope: headerKey });
    let current = state;
    if (state.headerKey !== headerKey) {
        // 頂欄切換：同一次 render 就改用新帳號，子元件不會先用舊範圍發查詢
        current = { headerKey, scope: headerKey };
        setState(current);
    }
    const setScope = useCallback((scope: string) => setState((s) => ({ ...s, scope })), []);
    return [current.scope, setScope];
}
