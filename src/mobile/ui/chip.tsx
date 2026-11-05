// src/mobile/ui/chip.tsx — Chip（設計規格 §6.10）
//
// - 原生 <button>；可見文字節點只有標籤（測試以 btn('成交')、btn('買一') 精確比對）。
// - dataPrice：以 data-price 屬性＋CSS ::after 顯示第二行價格；aria-label 已含價格。
// - 停用：原生 disabled、opacity .45；停用原因寫進 aria-label（觸控看不到 title）。
// - selected 有給（布林）時才輸出 aria-pressed（切換型晶片）；動作型晶片不帶 aria-pressed。

import { pressable, focusRing } from '../styles/primitives.css';
import * as styles from './chip.css';

export interface ChipProps {
    label: string;
    onClick(): void;
    /** 切換型晶片的選取狀態；undefined＝動作型（不輸出 aria-pressed） */
    selected?: boolean;
    disabled?: boolean;
    /** 停用原因（寫入 aria-label） */
    disabledReason?: string;
    /** 第二行價格文字（已格式化）；null／undefined 不顯示 */
    dataPrice?: string | null;
    /** 覆寫 aria-label；未給時由標籤、價格與停用原因組成 */
    ariaLabel?: string;
    testId?: string;
    className?: string;
}

/** 預設 aria-label：停用且有原因 → 「標籤（原因）」；有價格 → 「標籤 價格」；否則不設（讀可見文字） */
export function chipAriaLabel(p: Pick<ChipProps, 'label' | 'disabled' | 'disabledReason' | 'dataPrice' | 'ariaLabel'>): string | undefined {
    if (p.ariaLabel) return p.ariaLabel;
    if (p.disabled && p.disabledReason) return `${p.label}（${p.disabledReason}）`;
    if (p.dataPrice) return `${p.label} ${p.dataPrice}`;
    return undefined;
}

export function Chip(props: ChipProps) {
    const { label, onClick, selected, disabled = false, dataPrice, testId, className } = props;
    const price = dataPrice ? dataPrice : undefined;
    const cls = [styles.chip, pressable, focusRing, price ? styles.twoLine : '', className ?? ''].filter(Boolean).join(' ');
    return (
        <button
            type='button'
            className={cls}
            disabled={disabled}
            aria-pressed={selected === undefined ? undefined : selected}
            aria-label={chipAriaLabel(props)}
            data-price={price}
            data-testid={testId}
            onClick={() => onClick()}
        >
            <span className={styles.label}>{label}</span>
        </button>
    );
}
