// src/mobile/components/account/account-ui.tsx — 帳戶頁區塊共用的小元件（卡片、鍵值列、開關、分段選擇）
// 設計規格 §7.8：GroupedSection 外觀（標題在卡片外 footnote、資訊列 ≥44px、髮絲分隔）；props 與 testId 不變。

import { ChevronRight, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { isEsunAccount } from '../../../lib/esun';
import type { Account } from '../../../lib/types/portfolio';
import * as styles from '../../styles/account.css';
import { Segmented as UiSegmented } from '../../ui/segmented';

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

/** 區塊（GroupedSection 外觀）：標題在卡片外（footnote），extra 在標題列右側；props 與 testId 不變。id：跳轉錨點（可程式聚焦） */
export function Card({ title, extra, children, testId, id }: { title: string; extra?: ReactNode; children: ReactNode; testId?: string; id?: string }) {
    return (
        <section className={styles.card} data-testid={testId} aria-label={title} id={id} tabIndex={id ? -1 : undefined}>
            <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>{title}</h2>
                {extra}
            </div>
            <div className={styles.cardBody}>{children}</div>
        </section>
    );
}

/**
 * 可展開的卡片：收合時只顯示標題列（展開才讀取資料的區塊用）。
 * 標題列是卡片內第一列（整列可點、≥ 44px、chevron 旋轉）；展開立即掛載內容、150ms 淡入。
 * 讀取時機由呼叫端的 onToggle／open 決定，本元件只負責外觀。
 */
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
            <div className={styles.cardBody}>
                <div className={styles.disclosureRow}>
                    <h2 className={styles.disclosureHeading}>
                        <button type='button' className={styles.disclosure} aria-expanded={open} onClick={onToggle} data-testid={testId ? `${testId}-toggle` : undefined}>
                            {title}
                            <ChevronRight className={styles.chevron} aria-hidden='true' focusable='false' />
                        </button>
                    </h2>
                    {open && extra}
                </div>
                {open && <div className={styles.collapsibleContent}>{children}</div>}
            </div>
        </section>
    );
}

/** 鍵值列：dt＋dd（testId 在 dd）；warn 為 foreground 文字＋amber 圖示（§4.8 規則 4） */
export function Item({ term, children, tone = 'normal', className, testId }: { term: ReactNode; children: ReactNode; tone?: Tone; className?: string; testId?: string }) {
    return (
        <>
            <dt className={styles.term}>{term}</dt>
            <dd className={`${styles.value} ${styles.tone[tone]}${className ? ` ${className}` : ''}`} data-testid={testId}>
                {tone === 'warn' && <TriangleAlert className={styles.warnIcon} aria-hidden='true' focusable='false' />}
                {children}
            </dd>
        </>
    );
}

/** 開關（role=switch）：拇指以 transform 移動、開啟底色以 opacity 淡入 */
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

/** 分段選擇：沿用全站唯一的 ui/segmented（toggle 語意：role=group＋aria-pressed、按鈕文字恰為選項文字） */
export function Segmented<T extends string | number>({ label, value, options, onChange, testId }: { label: string; value: T; options: readonly { value: T; text: string }[]; onChange: (v: T) => void; testId?: string }) {
    return (
        <UiSegmented<T>
            semantics='toggle'
            ariaLabel={label}
            value={value}
            items={options.map(o => ({ value: o.value, label: o.text }))}
            onChange={onChange}
            testId={testId}
        />
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
