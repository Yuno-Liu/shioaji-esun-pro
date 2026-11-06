// src/mobile/ui/page-header.tsx — 頁首（設計規格 §6.10）
//
// PageHeader({ title, actions }) → h1（文字不變，既有測試以 h1 文字定位）＋右側動作；不做大標題收合。

import type { ReactNode } from 'react';
import * as styles from './page-header.css';

export interface PageHeaderProps {
    title: string;
    actions?: ReactNode;
    testId?: string;
}

export function PageHeader({ title, actions, testId }: PageHeaderProps) {
    return (
        <header className={styles.header} data-testid={testId}>
            <h1 className={styles.title}>{title}</h1>
            {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
    );
}
