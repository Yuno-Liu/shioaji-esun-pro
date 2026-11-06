// src/mobile/ui/pop-up-button.tsx — 原生選單彈出鍵（設計規格 §6.10）
//
// 可見部分為「目前選項＋ChevronsUpDown」（aria-hidden）；底層原生 <select> 透明疊滿，
// data-testid、aria-label、value、onChange 都在 select 上（ticket-price-type、orders-account 等測試不變）。

import { ChevronsUpDown } from 'lucide-react';
import * as styles from './pop-up-button.css';

export interface PopUpOption<T extends string> {
    value: T;
    label: string;
    disabled?: boolean;
}

export interface PopUpButtonProps<T extends string> {
    value: T;
    options: readonly PopUpOption<T>[];
    onChange(v: T): void;
    ariaLabel: string;
    testId?: string;
    disabled?: boolean;
    /** 覆寫可見文字（預設為目前選項的 label） */
    displayLabel?: string;
    className?: string;
}

export function PopUpButton<T extends string>({ value, options, onChange, ariaLabel, testId, disabled = false, displayLabel, className }: PopUpButtonProps<T>) {
    const current = displayLabel ?? options.find(o => o.value === value)?.label ?? '';
    const cls = [styles.root, styles.focusWithin, disabled ? styles.disabled : '', className ?? ''].filter(Boolean).join(' ');
    return (
        <span className={cls}>
            <span className={styles.current} aria-hidden='true'>{current}</span>
            <ChevronsUpDown className={styles.chevron} aria-hidden='true' focusable='false' />
            <select
                className={styles.select}
                aria-label={ariaLabel}
                data-testid={testId}
                disabled={disabled}
                value={value}
                onChange={e => onChange(e.target.value as T)}
            >
                {options.map(o => (
                    <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
                ))}
            </select>
        </span>
    );
}
