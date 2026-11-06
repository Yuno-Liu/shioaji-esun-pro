// src/mobile/ui/sheet-context.ts — 面板 portal 目標、面板進退場狀態、footer 目標（設計規格 §5.4、§6.1）
//
// - SheetRootContext：元素＝portal 到殼層的 #sj-sheet-root；'inline'（預設：測試、獨立渲染、沒有 provider）＝原地渲染；
//   null＝provider 已存在但節點尚未掛上（該幀不渲染）。
// - SheetPresenceContext：面板內容讀取進退場狀態（例如滑塊在 settled 前不接受按下、退場中不寫回饋）；
//   預設值等同「已開啟且就緒」，讓不在面板內的元件行為不變。
// - SheetFooterTargetContext：SheetFooter portal 的目標（面板的 footer 節點）。

import { createContext } from 'react';

export const SheetRootContext = createContext<HTMLElement | null | 'inline'>('inline');

export interface SheetPresence {
    phase: 'entering' | 'open' | 'exiting';
    /** 進場完成（或同步模式立即為 true） */
    settled: boolean;
    /** 最近一次開啟的時間（motionNow 的 ms） */
    shownAt: number;
    /** 讀取當下是否退場中（給非同步回呼使用，不受 render 時機影響） */
    isExiting(): boolean;
}

export const SheetPresenceContext = createContext<SheetPresence>({ phase: 'open', settled: true, shownAt: 0, isExiting: () => false });

export const SheetFooterTargetContext = createContext<HTMLElement | null>(null);
