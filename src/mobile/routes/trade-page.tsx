// src/mobile/routes/trade-page.tsx — 交易（圖表／五檔／明細＋買進／賣出；規格 §6.2）
// 【目前為樁（T1）】只顯示標題與「開發中」；T5 實作。
// 介面：code 來自 hash 路由（#/trade/:code，已過濾不合法代碼）；null＝尚未選商品。
// app.tsx 會把路由的 code 同步到 mobile-store 的 currentCode。

import * as layout from '../styles/layout.css';

export function TradePage({ code }: { code: string | null }) {
    return (
        <section className={layout.page} data-testid='page-trade'>
            <h1 className={layout.pageTitle}>交易{code ? ` ${code}` : ''}</h1>
            <p className={layout.placeholder}>{code ? '開發中' : '尚未選擇商品，請從自選清單選擇。'}</p>
        </section>
    );
}
