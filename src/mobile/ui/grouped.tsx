// src/mobile/ui/grouped.tsx — GroupedSection／ListRow／ValueRow（設計規格 §6.11）
//
// - GroupedSection：卡片外的 header／footer（footnote），卡片內放列。
// - ListRow：可點列的按鈕（或連結）內只放 title 文字；副標、原因放在按鈕外並以 aria-describedby 關聯
//   （避免破壞 btn('改價') 類精確比對）。列尾（trailing）在點擊區之上，可放自己的按鈕。
// - ValueRow：label／value；tone warn 時加 amber 圖示，文字仍 foreground。

import { ChevronRight, TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import * as styles from './grouped.css';

export interface GroupedSectionProps {
    header?: ReactNode;
    footer?: ReactNode;
    children: ReactNode;
    testId?: string;
}

export function GroupedSection({ header, footer, children, testId }: GroupedSectionProps) {
    return (
        <section className={styles.section} data-testid={testId}>
            {header ? <h2 className={styles.sectionHeader}>{header}</h2> : null}
            <div className={styles.card}>{children}</div>
            {footer ? <p className={styles.sectionFooter}>{footer}</p> : null}
        </section>
    );
}

export interface ListRowProps {
    title: string;
    subtitle?: ReactNode;
    leading?: ReactNode;
    trailing?: ReactNode;
    chevron?: boolean;
    onClick?(): void;
    href?: string;
    disabled?: boolean;
    testId?: string;
}

export function ListRow({ title, subtitle, leading, trailing, chevron = false, onClick, href, disabled = false, testId }: ListRowProps) {
    const subId = useId();
    const describedBy = subtitle ? subId : undefined;
    let main: ReactNode;
    if (href !== undefined && !disabled) {
        main = <a className={styles.titleButton} href={href} aria-describedby={describedBy} onClick={onClick ? () => onClick() : undefined}>{title}</a>;
    } else if (onClick || href !== undefined) {
        main = (
            <button type='button' className={styles.titleButton} disabled={disabled} aria-describedby={describedBy} onClick={() => onClick?.()}>
                {title}
            </button>
        );
    } else {
        main = <span className={styles.title}>{title}</span>;
    }
    return (
        <div className={styles.row} data-testid={testId}>
            {leading ? <span className={styles.leading} aria-hidden='true'>{leading}</span> : null}
            <div className={styles.body}>
                {main}
                {subtitle ? <span className={styles.subtitle} id={subId}>{subtitle}</span> : null}
            </div>
            {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
            {chevron ? <ChevronRight className={styles.chevron} aria-hidden='true' focusable='false' /> : null}
        </div>
    );
}

export interface ValueRowProps {
    label: ReactNode;
    value: ReactNode;
    tone?: 'warn';
    /** 放在數值元素上（text 恰為 value） */
    testId?: string;
}

export function ValueRow({ label, value, tone, testId }: ValueRowProps) {
    return (
        <div className={styles.valueRow}>
            <span className={styles.valueLabel}>{label}</span>
            <span className={styles.value}>
                {tone === 'warn' ? <TriangleAlert className={styles.warnIcon} aria-hidden='true' focusable='false' /> : null}
                <span data-testid={testId}>{value}</span>
            </span>
        </div>
    );
}
