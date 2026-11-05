// src/mobile/routes/account-page.tsx — 帳戶（規格 §6.7）
// 【目前為樁（T1）】只顯示標題與「開發中」；T8 實作。

import * as layout from '../styles/layout.css';

export function AccountPage() {
    return (
        <section className={layout.page} data-testid='page-account'>
            <h1 className={layout.pageTitle}>帳戶</h1>
            <p className={layout.placeholder}>開發中</p>
        </section>
    );
}
