// src/mobile/routes/watchlist-page.tsx — 自選（規格 §6.1）
// 【目前為樁（T1）】只顯示標題與「開發中」；T8 實作。

import * as layout from '../styles/layout.css';

export function WatchlistPage() {
    return (
        <section className={layout.page} data-testid='page-watchlist'>
            <h1 className={layout.pageTitle}>自選</h1>
            <p className={layout.placeholder}>開發中</p>
        </section>
    );
}
