// src/mobile/ui/direction-toggle.tsx — 買賣方向鍵（設計規格 §6.8）
//
// role="group" aria-label="買賣方向"；兩顆原生 button，可見文字恰為「買進」「賣出」，aria-pressed。
// 選中段附 lucide Check（svg、aria-hidden，不產生文字節點）。只選方向，不送單。

import { Check } from 'lucide-react';
import { fill, focusRing, pressable } from '../styles/primitives.css';
import * as styles from './direction-toggle.css';

export type Direction = 'Buy' | 'Sell';

export interface DirectionToggleProps {
    value: Direction | null;
    onChange(v: Direction): void;
    disabled?: boolean;
    testId?: string;
}

const KEYS: readonly { value: Direction; label: '買進' | '賣出'; tone: 'up' | 'down' }[] = [
    { value: 'Buy', label: '買進', tone: 'up' },
    { value: 'Sell', label: '賣出', tone: 'down' },
];

export function DirectionToggle({ value, onChange, disabled = false, testId }: DirectionToggleProps) {
    return (
        <div className={styles.group} role='group' aria-label='買賣方向' data-testid={testId}>
            {KEYS.map(k => {
                const selected = value === k.value;
                const cls = selected ? `${styles.on} ${fill[k.tone].large}` : styles.off[k.tone];
                return (
                    <button
                        key={k.value}
                        type='button'
                        className={`${cls} ${pressable} ${focusRing}`}
                        aria-pressed={selected}
                        disabled={disabled}
                        onClick={() => onChange(k.value)}
                    >
                        {selected ? <Check className={styles.check} aria-hidden='true' focusable='false' strokeWidth={2.75} /> : null}
                        {k.label}
                    </button>
                );
            })}
        </div>
    );
}
