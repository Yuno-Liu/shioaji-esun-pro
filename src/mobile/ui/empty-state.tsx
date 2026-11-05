// src/mobile/ui/empty-state.tsx — 空狀態（設計規格 §6.13）
//
// 標題沿用既有空狀態常數，testId 放在標題元素上（既有測試以 testid 取文字比對常數）。
// 主要動作是 accent 實心小字鍵（fill.accent.strong）。

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { fill, focusRing, pressable } from '../styles/primitives.css';
import * as styles from './empty-state.css';

export interface EmptyStateAction {
    label: string;
    onClick(): void;
    testId?: string;
}

export interface EmptyStateProps {
    icon?: LucideIcon;
    title: string;
    description?: ReactNode;
    action?: EmptyStateAction;
    /** 放在標題元素上 */
    testId?: string;
}

export function EmptyState({ icon: Icon, title, description, action, testId }: EmptyStateProps) {
    return (
        <div className={styles.root}>
            {Icon ? <Icon className={styles.icon} strokeWidth={1.5} aria-hidden='true' focusable='false' /> : null}
            <p className={styles.title} data-testid={testId}>{title}</p>
            {description ? <p className={styles.description}>{description}</p> : null}
            {action ? (
                <button
                    type='button'
                    className={`${styles.action} ${fill.accent.strong} ${pressable} ${focusRing}`}
                    data-testid={action.testId}
                    onClick={() => action.onClick()}
                >
                    {action.label}
                </button>
            ) : null}
        </div>
    );
}
