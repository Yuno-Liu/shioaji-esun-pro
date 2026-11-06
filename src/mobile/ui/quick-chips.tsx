// src/mobile/ui/quick-chips.tsx — 快捷價／快捷數量（設計規格 §6.10）
//
// 只負責版面（6 欄價格、4 欄數量）與把每格交給 Chip；點下去只回報 key，由呼叫端決定帶入價格或數量
// （不送單：送出仍只有預覽 → 確認面板滑動一條路）。

import { Chip } from './chip';
import * as styles from './quick-chips.css';

export interface QuickChipItem {
    key: string;
    label: string;
    /** 第二行價格（已格式化）；只在快捷價使用 */
    dataPrice?: string | null;
    ariaLabel?: string;
    disabled?: boolean;
    disabledReason?: string;
    testId?: string;
}

export interface QuickChipsProps {
    variant: 'price' | 'qty';
    /** 群組名稱，例如「快捷價（送限價）」 */
    ariaLabel: string;
    items: readonly QuickChipItem[];
    onPick(key: string): void;
    /** 整組停用（例如送出中） */
    disabled?: boolean;
    testId?: string;
}

export function QuickChips({ variant, ariaLabel, items, onPick, disabled = false, testId }: QuickChipsProps) {
    return (
        <div className={styles.grid[variant]} role='group' aria-label={ariaLabel} data-testid={testId}>
            {items.map(item => (
                <Chip
                    key={item.key}
                    className={styles.cell}
                    label={item.label}
                    dataPrice={variant === 'price' ? item.dataPrice : undefined}
                    ariaLabel={item.ariaLabel}
                    disabled={disabled || !!item.disabled}
                    disabledReason={item.disabledReason}
                    testId={item.testId}
                    onClick={() => onPick(item.key)}
                />
            ))}
        </div>
    );
}
