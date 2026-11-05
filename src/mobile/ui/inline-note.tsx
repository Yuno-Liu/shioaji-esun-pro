// src/mobile/ui/inline-note.tsx — 就地說明（設計規格 §6.11）
//
// 持續狀態就地呈現（對帳、ResumeGateNote、價格過期、信用提醒、帳戶限制、組合商品不可下單），不用通知。
// tone 只決定圖示與左側條顏色；文字一律 foreground。role 由呼叫端決定（status／alert／不設）。

import { CircleX, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { focusRing, pressable } from '../styles/primitives.css';
import * as styles from './inline-note.css';

export type InlineNoteTone = 'warn' | 'danger' | 'info';

export interface InlineNoteAction {
    label: string;
    onClick(): void;
    disabled?: boolean;
    testId?: string;
}

export interface InlineNoteProps {
    tone: InlineNoteTone;
    children: ReactNode;
    action?: InlineNoteAction;
    role?: 'status' | 'alert' | 'note';
    testId?: string;
}

const ICON: Record<InlineNoteTone, LucideIcon> = { warn: TriangleAlert, danger: CircleX, info: Info };

export function InlineNote({ tone, children, action, role, testId }: InlineNoteProps) {
    const Icon = ICON[tone];
    return (
        <div className={styles.note[tone]} role={role} data-testid={testId} data-tone-note={tone}>
            <Icon className={styles.icon[tone]} aria-hidden='true' focusable='false' />
            <div className={styles.content}>{children}</div>
            {action ? (
                <button
                    type='button'
                    className={`${styles.action} ${pressable} ${focusRing}`}
                    disabled={action.disabled}
                    data-testid={action.testId}
                    onClick={() => action.onClick()}
                >
                    {action.label}
                </button>
            ) : null}
        </div>
    );
}
