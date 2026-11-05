// src/mobile/components/account/account-ui.tsx — 帳戶頁區塊共用的小元件（卡片、鍵值列、開關、分段選擇）

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { isEsunAccount } from '../../../lib/esun';
import type { Account } from '../../../lib/types/portfolio';
import * as styles from '../../styles/account.css';

export type Tone = 'normal' | 'muted' | 'accent' | 'good' | 'warn' | 'bad';

export function brokerName(account: Pick<Account, 'broker_id'>): string {
    return isEsunAccount(account) ? '玉山' : '永豐';
}

export function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(t);
    }, [intervalMs]);
    return now;
}

export function Card({ title, extra, children, testId }: { title: string; extra?: ReactNode; children: ReactNode; testId?: string }) {
    return (
        <section className={styles.card} data-testid={testId} aria-label={title}>
            <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>{title}</h2>
                {extra}
            </div>
            {children}
        </section>
    );
}

/** 可展開的卡片：收合時只顯示標題（展開才讀取資料的區塊用） */
export function CollapsibleCard({ title, open, onToggle, extra, children, testId }: {
    title: string;
    open: boolean;
    onToggle: () => void;
    extra?: ReactNode;
    children: ReactNode;
    testId?: string;
}) {
    return (
        <section className={styles.card} data-testid={testId} aria-label={title}>
            <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>
                    <button type='button' className={styles.disclosure} aria-expanded={open} onClick={onToggle} data-testid={testId ? `${testId}-toggle` : undefined}>
                        {open ? <ChevronDown size={18} aria-hidden='true' /> : <ChevronRight size={18} aria-hidden='true' />}
                        {title}
                    </button>
                </h2>
                {open && extra}
            </div>
            {open && children}
        </section>
    );
}

export function Item({ term, children, tone = 'normal', className, testId }: { term: ReactNode; children: ReactNode; tone?: Tone; className?: string; testId?: string }) {
    return (
        <>
            <dt className={styles.term}>{term}</dt>
            <dd className={`${styles.value} ${styles.tone[tone]}${className ? ` ${className}` : ''}`} data-testid={testId}>{children}</dd>
        </>
    );
}

export function Switch({ checked, onChange, label, disabled = false, testId }: { checked: boolean; onChange?: (next: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
    return (
        <button
            type='button'
            role='switch'
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            className={styles.switchButton}
            onClick={() => { if (!disabled) onChange?.(!checked); }}
            data-testid={testId}
        >
            <span className={styles.switchTrack} aria-hidden='true'>
                <span className={styles.switchThumb} />
            </span>
        </button>
    );
}

export function Segmented<T extends string | number>({ label, value, options, onChange, testId }: { label: string; value: T; options: readonly { value: T; text: string }[]; onChange: (v: T) => void; testId?: string }) {
    return (
        <div className={styles.segmented} role='group' aria-label={label} data-testid={testId}>
            {options.map(o => (
                <button key={String(o.value)} type='button' className={styles.segment} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
                    {o.text}
                </button>
            ))}
        </div>
    );
}

/** 「查詢／更新」鍵：進行中或冷卻中停用，冷卻時顯示剩餘秒數 */
export function RefreshButton({ label, disabled, loading, cooldownSec, onClick, testId }: {
    label: string;
    disabled: boolean;
    loading: boolean;
    cooldownSec: number;
    onClick: () => void;
    testId?: string;
}) {
    const text = loading ? '查詢中…' : cooldownSec > 0 ? `${label}（${cooldownSec} 秒）` : label;
    return (
        <button type='button' className={styles.smallButton} disabled={disabled} aria-busy={loading} onClick={onClick} data-testid={testId}>
            {text}
        </button>
    );
}
