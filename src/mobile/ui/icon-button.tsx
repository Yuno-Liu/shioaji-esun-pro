// src/mobile/ui/icon-button.tsx — 圖示鍵（設計規格 §6.10）
//
// aria-label 必填（純圖示沒有可見文字）；pressed 有給時輸出 aria-pressed（切換型，例如編輯模式）。
// variant 'close'：面板關閉鈕（30px 圓內 X 18px）；icon 未給時預設 X。
// children：圖示之後的附加內容（例如狀態列通知鈴的未讀徽章；以按鈕為定位基準，aria-label 仍是無障礙名稱）。
// ariaDisabled：只輸出 aria-disabled、不設 disabled（處理中暫時不能按時用：disabled 會讓已聚焦的按鈕失去焦點；
// 呼叫端自己在 onClick 忽略點擊）。

import { X, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { focusRing, pressable } from '../styles/primitives.css';
import * as styles from './icon-button.css';

export interface IconButtonProps {
    ariaLabel: string;
    onClick(): void;
    /** lucide 圖示元件；variant 'close' 未給時用 X */
    icon?: LucideIcon;
    /** 圖示尺寸 px（18–24；close 固定 18） */
    iconSize?: number;
    variant?: 'regular' | 'close';
    /** 切換型：undefined 時不輸出 aria-pressed */
    pressed?: boolean;
    disabled?: boolean;
    testId?: string;
    className?: string;
    children?: ReactNode;
    /** 只輸出 aria-disabled（不設 disabled，焦點留在按鈕上）；點擊由呼叫端自行忽略 */
    ariaDisabled?: boolean;
}

export function IconButton({ ariaLabel, onClick, icon, iconSize, variant = 'regular', pressed, disabled = false, testId, className, children, ariaDisabled }: IconButtonProps) {
    const Icon = icon ?? X;
    const size = variant === 'close' ? 18 : Math.min(24, Math.max(18, iconSize ?? 20));
    return (
        <button
            type='button'
            className={[styles.button[variant], pressable, focusRing, className ?? ''].filter(Boolean).join(' ')}
            aria-label={ariaLabel}
            aria-pressed={pressed === undefined ? undefined : pressed}
            disabled={disabled}
            aria-disabled={ariaDisabled ? true : undefined}
            data-testid={testId}
            onClick={() => onClick()}
        >
            <Icon className={styles.icon} size={size} aria-hidden='true' focusable='false' />
            {children}
        </button>
    );
}
