// src/mobile/routes/account-page.tsx — 帳戶（規格 §6.7、§9.1、§10）
//
// 區塊（各自在 src/mobile/components/account/*.tsx）：
//   今日剩餘交易額度（使用者要求置頂；持倉頁摘要的額度列會跳到這裡）→ 帳號 → 資金（股票＋期貨）→ 交割行事曆 → 已實現損益 → 玉山帳務概覽（玉山證券帳戶）
//   → 預收券款／圈存（永豐證券帳戶，唯讀）→ 風控 → 交易成本 → 連線（含玉山重新連線）→ 伺服器 → 顯示 → 本裝置 → 診斷。
// 讀取原則（§9.1）：
// - 餘額、保證金、持倉只透過 useTradingState()，不自行輪詢。
// - 交割款 30 秒內重用；交易額度共用 useTradingLimits 快取。
// - 已實現損益、玉山帳務概覽、永豐預收／圈存只在使用者展開或按「查詢」時讀取，並有冷卻（src/mobile/lib/account-on-demand.ts）。
// - 玉山資料一律經由 src/lib（esunTradeService 或 shioaji 查詢函式的玉山路由），不自行 fetch。
// - 金額以 usePrivacyMoney＋maskMoney 遮蔽，帳號以 maskAccountId／mobileAccountLabel 遮蔽。

import { AccountsCard } from '../components/account/accounts-card';
import { ConnectionCard } from '../components/account/connection-card';
import { DeviceSettingsSection } from '../components/account/device-settings-section';
import { DiagnosticsCard } from '../components/account/diagnostics-card';
import { DisplayCard } from '../components/account/display-card';
import { EsunOverviewCard } from '../components/account/esun-overview-card';
import { FundsSections } from '../components/account/funds-section';
import { LimitsCard } from '../components/account/limits-card';
import { RealizedPnlCard } from '../components/account/realized-pnl-card';
import { ReserveCard } from '../components/account/reserve-card';
import { RiskCard } from '../components/account/risk-card';
import { ServerCard } from '../components/account/server-card';
import { TradingCostSection } from '../components/account/trading-cost-section';
import { resetOnDemandForTest } from '../lib/account-on-demand';
import { resetSettlementCacheForTest } from '../lib/account-settlements';
import * as layout from '../styles/layout.css';

export { formatClock, formatTwd } from '../lib/account-format';
export { SETTLEMENT_REUSE_MS } from '../lib/account-settlements';
export { CONNECTION_REFRESH_MS, RECHECK_COOLDOWN_MS } from '../components/account/connection-card';
export { USAGE_REFRESH_MS } from '../components/account/server-card';

/** 測試用：清除交割款與按需查詢的快取 */
export function resetAccountPageCacheForTest(): void {
    resetSettlementCacheForTest();
    resetOnDemandForTest();
}

export function AccountPage() {
    return (
        <section className={layout.page} data-testid='page-account'>
            <h1 className={layout.pageTitle}>帳戶</h1>
            <LimitsCard />
            <AccountsCard />
            <FundsSections />
            <RealizedPnlCard />
            <EsunOverviewCard />
            <ReserveCard />
            <RiskCard />
            <TradingCostSection />
            <ConnectionCard />
            <ServerCard />
            <DisplayCard />
            <DeviceSettingsSection />
            <DiagnosticsCard />
        </section>
    );
}
