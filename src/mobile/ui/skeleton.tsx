// src/mobile/ui/skeleton.tsx — 載入骨架（設計規格 §6.13）
//
// 容器 role=status，保留視覺隱藏的原文字（「委託載入中…」「自選清單載入中…」「載入中…」），既有文字斷言不變；
// 色塊 aria-hidden。

import { srOnly } from '../styles/primitives.css';
import * as styles from './skeleton.css';

export interface SkeletonProps {
    /** 原本顯示的載入文字（視覺隱藏、給輔助技術與既有測試） */
    label: string;
    /** 骨架列數（預設 3） */
    rows?: number;
    testId?: string;
}

export function Skeleton({ label, rows = 3, testId }: SkeletonProps) {
    const count = Math.max(1, Math.floor(rows));
    return (
        <div className={styles.root} role='status' data-testid={testId}>
            <span className={srOnly}>{label}</span>
            {Array.from({ length: count }, (_, i) => (
                <div key={i} className={styles.row} aria-hidden='true'>
                    <span className={`${styles.block} ${styles.blockWide}`} />
                    <span className={`${styles.block} ${styles.blockNarrow}`} />
                </div>
            ))}
        </div>
    );
}
