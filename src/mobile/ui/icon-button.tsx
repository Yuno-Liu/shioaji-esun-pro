// src/mobile/ui/icon-button.tsx — 圖示鍵（設計規格 §6.10）
//
// aria-label 必填（純圖示沒有可見文字）；pressed 有給時輸出 aria-pressed（切換型，例如編輯模式）。
// variant 'close'：面板關閉鈕（30px 圓內 X 18px）；icon 未給時預設 X。

import { X, type LucideIcon } from 'lucide-react';
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
}

export function IconButton({ ariaLabel, onClick, icon, iconSize, variant = 'regular', pressed, disabled = false, testId, className }: IconButtonProps) {
    const Icon = icon ?? X;
    const size = variant === 'close' ? 18 : Math.min(24, Math.max(18, iconSize ?? 20));
    return (
        <button
            type='button'
            className={[styles.button[variant], pressable, focusRing, className ?? ''].filter(Boolean).join(' ')}
            aria-label={ariaLabel}
            aria-pressed={pressed === undefined ? undefined : pressed}
            disabled={disabled}
            data-testid={testId}
            onClick={() => onClick()}
        >
            <Icon className={styles.icon} size={size} aria-hidden='true' focusable='false' />
        </button>
    );
}
