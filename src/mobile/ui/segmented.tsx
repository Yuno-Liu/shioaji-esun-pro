// src/mobile/ui/segmented.tsx — 全站唯一的分段控制（設計規格 §6.7）
//
// - semantics 'tabs'：role=tablist／tab＋aria-selected（自選／排行、五檔／明細、排行種類、委託狀態）。
// - semantics 'toggle'：role=group＋aria-pressed（週期、市場、下單單位／信用／時段／效期／倉別等）。
// - 每段是原生 <button>，可見文字恰為 label（測試以 btn('IOC')、btn('融資') 精確定位）；停用段維持原生 disabled。
// - 停用原因：footnote 顯示在組下方並以 aria-describedby 關聯（describedBy 指向呼叫端元素，或用 note 由本元件渲染）。
// - thumb 拇指是 aria-hidden 的 span，不在任何按鈕內（不影響按鈕文字）；value 為 null 時 opacity 0。

import { useId, type ReactNode } from 'react';
import { focusRing } from '../styles/primitives.css';
import * as styles from './segmented.css';

export interface SegmentedItem<T> {
    value: T;
    label: string;
    disabled?: boolean;
    testId?: string;
    ariaLabel?: string;
}

export interface SegmentedProps<T extends string | number> {
    items: readonly SegmentedItem<T>[];
    value: T | null;
    onChange(v: T): void;
    semantics: 'tabs' | 'toggle';
    ariaLabel: string;
    size?: 'regular' | 'compact';
    variant?: 'thumb' | 'scroll';
    /** 整組停用（例如送出中） */
    disabled?: boolean;
    /** 停用原因元素 id（呼叫端自行渲染） */
    describedBy?: string;
    /** 停用原因文字：由本元件以 footnote 渲染在組下方並關聯 aria-describedby（與 describedBy 可並用） */
    note?: ReactNode;
    testId?: string;
}

/** 拇指的 inline style（純函式，供測試）：寬 (100% − 4px)/n、translateX(100%·i)；沒有選取時 opacity 0 */
export function thumbStyle(count: number, index: number): { width: string; transform: string; opacity: number } {
    const n = Math.max(1, count);
    const i = Math.max(0, index);
    return {
        width: `calc((100% - 4px) / ${n})`,
        transform: `translateX(${i * 100}%)`,
        opacity: index < 0 ? 0 : 1,
    };
}

export function Segmented<T extends string | number>({
    items, value, onChange, semantics, ariaLabel, size = 'regular', variant = 'thumb', disabled = false, describedBy, note, testId,
}: SegmentedProps<T>) {
    const noteId = useId();
    const tabs = semantics === 'tabs';
    const selectedIndex = value === null ? -1 : items.findIndex(it => it.value === value);
    const describedByIds = [describedBy, note ? noteId : undefined].filter(Boolean).join(' ') || undefined;

    const buttons = items.map(item => {
        const selected = value !== null && item.value === value;
        return (
            <button
                key={String(item.value)}
                type='button'
                role={tabs ? 'tab' : undefined}
                aria-selected={tabs ? selected : undefined}
                aria-pressed={tabs ? undefined : selected}
                aria-label={item.ariaLabel}
                className={`${variant === 'scroll' ? styles.pill : styles.segment} ${focusRing}`}
                disabled={disabled || !!item.disabled}
                data-testid={item.testId}
                // 點已選段也回報（與既有分段按鈕行為一致，由呼叫端決定是否忽略）
                onClick={() => onChange(item.value)}
            >
                {item.label}
            </button>
        );
    });

    const group = variant === 'scroll' ? (
        <div className={styles.scroller} role={tabs ? 'tablist' : 'group'} aria-label={ariaLabel} aria-describedby={describedByIds} data-testid={testId}>
            {buttons}
        </div>
    ) : (
        <div className={styles.track[size]} role={tabs ? 'tablist' : 'group'} aria-label={ariaLabel} aria-describedby={describedByIds} data-testid={testId}>
            <span className={styles.thumb} aria-hidden='true' style={thumbStyle(items.length, selectedIndex)} />
            {buttons}
        </div>
    );

    if (!note) return group;
    return (
        <div className={styles.root}>
            {group}
            <p className={styles.note} id={noteId}>{note}</p>
        </div>
    );
}
