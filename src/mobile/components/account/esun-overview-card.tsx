// src/mobile/components/account/esun-overview-card.tsx — 帳戶頁「玉山帳務概覽」（比照桌面 esun-account-overview.tsx）
//
// 只在選定的證券帳戶是玉山時顯示。資料：esunTradeService.fetchAccountOverview（銀行餘額、交易額度與權限、市場狀態；
// 一律經由 src/lib，不自行 fetch）。展開區塊（尚未讀過時）或按「查詢」才讀取，冷卻 ESUN_OVERVIEW_COOLDOWN_MS。
// 官方欄位語意：trade_limit／margin_limit／short_limit 只是額度，沒有已用或剩餘。

import { useState } from 'react';
import { useAccounts } from '../../../lib/account-store';
import { esunTradeService, isEsunAccount, useEsunEnvironment, type EsunAccountOverview } from '../../../lib/esun';
import { maskAccountId, maskMoney, usePrivacyMode, usePrivacyMoney } from '../../../lib/privacy';
import type { Account } from '../../../lib/types/portfolio';
import { accountKeyOf, formatClock, formatTaipeiDateTime, formatTwd } from '../../lib/account-format';
import { canLoadOnDemand, cooldownLeftSec, loadOnDemand, onDemandNow, useOnDemand } from '../../lib/account-on-demand';
import * as styles from '../../styles/account.css';
import { CollapsibleCard, Item, RefreshButton, useNow, type Tone } from './account-ui';

/** 玉山帳務概覽的查詢冷卻（bridge 餘額 180 秒快取；避免反覆查詢） */
export const ESUN_OVERVIEW_COOLDOWN_MS = 30_000;

/** 權限狀態不可用（當沖 N／S、信用 9、空白）→ 灰字 */
export function esunStatusOff(code: string, text: string): boolean {
    return code === 'N' || code === 'S' || code === '9' || !text;
}

function StatusItem({ term, text, code }: { term: string; text: string; code: string }) {
    const tone: Tone = esunStatusOff(code, text) ? 'muted' : 'normal';
    return <Item term={term} tone={tone}>{text || '—'}</Item>;
}

function OverviewBody({ data }: { data: EsunAccountOverview }) {
    const privMoney = usePrivacyMoney();
    const money = (n: number | null) => maskMoney(formatTwd(n), privMoney);
    const { balance, tradeStatus, marketStatus } = data;
    const updated = formatTaipeiDateTime(balance.updatedAt);
    const tradingDay = marketStatus?.isTradingDay;
    return (
        <div data-testid='esun-overview-body'>
            <h3 className={styles.subTitle}>銀行餘額</h3>
            <dl className={styles.kv}>
                <Item term='可用銀行餘額' testId='esun-available-balance'>{money(balance.availableBalance)}</Item>
                <Item term='今日票據交換金額'>{money(balance.exchangeBalance)}</Item>
                <Item term='圈存金額'>{money(balance.preSaveAmount)}</Item>
                <Item term='資料時間' tone='muted'>
                    {updated || '—'}
                    {balance.isLatestData === false && <span className={`${styles.badge} ${styles.badgeWarn}`}>非最新資料</span>}
                    {balance.cached === true && (
                        <span className={styles.badge}>
                            {balance.cacheAgeSec === null ? '快取資料' : `快取 ${Math.max(0, Math.round(balance.cacheAgeSec))} 秒前`}
                        </span>
                    )}
                </Item>
            </dl>
            <h3 className={styles.subTitle}>交易額度及權限</h3>
            <dl className={styles.kv}>
                <Item term='交易額度'>{money(tradeStatus.tradeLimit)}</Item>
                <Item term='融資額度'>{money(tradeStatus.marginLimit)}</Item>
                <Item term='融券額度'>{money(tradeStatus.shortLimit)}</Item>
                <StatusItem term='現股當沖' text={tradeStatus.dayTradeLabel} code={tradeStatus.dayTradeCode} />
                <StatusItem term='融資' text={tradeStatus.marginLabel} code={tradeStatus.marginCode} />
                <StatusItem term='融券' text={tradeStatus.shortLabel} code={tradeStatus.shortCode} />
            </dl>
            <p className={styles.note}>券商只提供額度，未提供已用／剩餘；玉山未提供逐檔預收明細（圈存金額見上方）。</p>
            <h3 className={styles.subTitle}>市場狀態</h3>
            {marketStatus === null ? (
                <p className={styles.note}>暫時無法查詢市場狀態。</p>
            ) : (
                <dl className={styles.kv}>
                    <Item term='今日' tone={tradingDay === false ? 'muted' : 'normal'}>{tradingDay === true ? '開盤' : tradingDay === false ? '休市' : '—'}</Item>
                    <Item term='上個交易日'>{marketStatus.lastTradingDay || '—'}</Item>
                    <Item term='下個交易日'>{marketStatus.nextTradingDay || '—'}</Item>
                </dl>
            )}
        </div>
    );
}

function EsunOverviewInner({ stock }: { stock: Account }) {
    const env = useEsunEnvironment();
    const priv = usePrivacyMode();
    const [open, setOpen] = useState(false);
    useNow(open ? 1_000 : 60_000);
    const key = `esun-overview:${env.environment}:${accountKeyOf(stock)}`;
    const state = useOnDemand<EsunAccountOverview>(key);
    const clockNow = onDemandNow();
    const canLoad = canLoadOnDemand(state, ESUN_OVERVIEW_COOLDOWN_MS, clockNow);
    const load = () => {
        const account = stock;
        void loadOnDemand(key, () => esunTradeService.fetchAccountOverview(account), ESUN_OVERVIEW_COOLDOWN_MS);
    };
    const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && state.data === null && canLoad) load();
    };
    return (
        <CollapsibleCard title='玉山帳務概覽' open={open} onToggle={toggle} testId='account-esun-overview'>
            <p className={styles.note}>帳號 {maskAccountId(stock.account_id, priv)}</p>
            {state.loading && !state.data && <p className={styles.note}>玉山帳務查詢中…</p>}
            {state.data && <OverviewBody data={state.data} />}
            {state.error && <p className={styles.warning} role='alert'>玉山帳務概覽查詢失敗：{state.error}</p>}
            <div className={styles.actions}>
                <span className={styles.note}>查詢時間 {formatClock(state.updatedAt)}</span>
                <RefreshButton
                    label='查詢'
                    loading={state.loading}
                    cooldownSec={state.loading ? 0 : cooldownLeftSec(state, ESUN_OVERVIEW_COOLDOWN_MS, clockNow)}
                    disabled={!canLoad}
                    onClick={load}
                    testId='esun-overview-query'
                />
            </div>
        </CollapsibleCard>
    );
}

export function EsunOverviewCard() {
    const { selectedStock } = useAccounts();
    if (!selectedStock || selectedStock.account_type !== 'S' || !isEsunAccount(selectedStock)) return null;
    return <EsunOverviewInner key={accountKeyOf(selectedStock)} stock={selectedStock} />;
}
