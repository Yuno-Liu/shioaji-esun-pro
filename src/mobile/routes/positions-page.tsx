// src/mobile/routes/positions-page.tsx — 持倉（規格 §6.6）
// 【目前為樁（T1）】只顯示標題與「開發中」；T7 實作。

import * as layout from '../styles/layout.css';

export function PositionsPage() {
    return (
        <section className={layout.page} data-testid='page-positions'>
            <h1 className={layout.pageTitle}>持倉</h1>
            <p className={layout.placeholder}>開發中</p>
        </section>
    );
}
