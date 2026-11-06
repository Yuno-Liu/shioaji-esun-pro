// src/mobile/ui/shell-slots.tsx — 殼層插槽（設計規格 §6.6）
//
// 頁面要放在捲動容器之外的列（交易頁精簡標頭→top、交易鍵列→bottom 配件槽）用 <ShellSlot slot>：
// - ShellSlotsContext 為 { top, bottom } 時 createPortal 到殼層的 .topSlot／.accessorySlot；
//   對應節點尚未掛上（null）時該幀不渲染。
// - 'inline'（預設：測試、獨立渲染、沒有 provider）時原地渲染，testId 與結構不變。
// 配件槽的實際高度由殼層以 ResizeObserver 寫入 --sj-accessory-h（main 底部內距與通知錨點會讓出）。

import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type ShellSlotName = 'top' | 'bottom';

export interface ShellSlotTargets {
    top: HTMLElement | null;
    bottom: HTMLElement | null;
}

export const ShellSlotsContext = createContext<ShellSlotTargets | 'inline'>('inline');

export function ShellSlot({ slot, children }: { slot: ShellSlotName; children: ReactNode }) {
    const targets = useContext(ShellSlotsContext);
    if (targets === 'inline') return <>{children}</>;
    const target = targets[slot];
    if (!target) return null;
    return createPortal(children, target);
}
