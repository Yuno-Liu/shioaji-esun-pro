// src/mobile/routes/orders-page.tsx — 委託（規格 §6.5）
// 【目前為樁（T1）】只顯示標題與「開發中」；T6 實作。

import * as layout from '../styles/layout.css';

export function OrdersPage() {
    return (
        <section className={layout.page} data-testid='page-orders'>
            <h1 className={layout.pageTitle}>委託</h1>
            <p className={layout.placeholder}>開發中</p>
        </section>
    );
}
