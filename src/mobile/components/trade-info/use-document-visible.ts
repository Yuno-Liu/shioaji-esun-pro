// src/mobile/components/trade-info/use-document-visible.ts — 文件是否在前景（visibilitychange）
//
// 交易頁的處置名單只在前景讀取與定期更新（App 退到背景時停掉 regulatory-punish 的計時器，回前景再依間隔判斷）。
// 沒有 document（測試、SSR）時視為前景。
import { useSyncExternalStore } from 'react';

function subscribe(listener: () => void): () => void {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => undefined;
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
}

const getVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function useDocumentVisible(): boolean {
    return useSyncExternalStore(subscribe, getVisible, getVisible);
}
