// src/components/esun-account-overview.tsx — 帳務/交割 tab 的玉山帳務概覽（fork 元件）
//
// bottom-dock-account.tsx（上游）只留掛鉤：
// - useEsunAccountPane：依券商決定模擬旗標、分出非玉山證券帳戶（交易額度／預收只走上游查詢）、
//   以帳戶範圍的 useQuery 查玉山帳務概覽（key 含玉山環境）。
// - EsunAccountOverview：交割試算提示＋每個玉山證券帳戶的銀行餘額、交易額度及權限、預收／圈存、市場狀態。
// - EsunPnlRowDetail／EsunPnlCostTotal：已實現損益的玉山交易成本（見 esun-pnl-details.tsx）。
//
// 官方欄位語意：trade_limit／margin_limit／short_limit 只是額度，沒有已用或剩餘；
// 交割款盤中為試算，21:00 帳務更新後才是正確的 T+2 金額。

import { useCallback, type ReactNode } from 'react';
import { useQuery } from '../hooks/use-query';
import {
    esunTradeService,
    isEsunAccount,
    useEsunEnvironment,
    type EsunAccountOverview as EsunAccountOverviewData,
} from '../lib/esun';
import { esunEnvKey } from '../lib/order-route';
import { maskAccountId, maskMoney, usePrivacyMode, usePrivacyMoney } from '../lib/privacy';
import type { Account } from '../lib/types/portfolio';
import { fmtMoney } from '../lib/utils/format';
import { AsyncStatus } from './async-status';
import * as dock from './bottom-dock.css';
import * as styles from './esun-account-overview.css';

export { EsunPnlCostTotal, EsunPnlRowDetail } from './esun-pnl-details';

const accountId = (a: Pick<Account, 'account_type' | 'broker_id' | 'account_id'>) =>
    `${a.account_type}:${a.broker_id}:${a.account_id}`;

/**
 * 模擬旗標依券商：玉山帳戶看玉山環境、其他帳戶看永豐 fetchInfo().simulation；
 * 範圍內同時有兩家時，兩家都是模擬才算模擬。範圍內沒有帳戶時沿用永豐旗標。
 */
export function esunScopedSimulation(
    accounts: readonly Pick<Account, 'broker_id'>[],
    sinopacSimulation: boolean,
    esunSimulation: boolean,
): boolean {
    const hasEsun = accounts.some(a => isEsunAccount(a));
    const hasOther = accounts.some(a => !isEsunAccount(a));
    if (!hasEsun) return sinopacSimulation;
    if (!hasOther) return esunSimulation;
    return sinopacSimulation && esunSimulation;
}

export interface EsunOverviewRow {
    key: string;
    overview: EsunAccountOverviewData;
}

/**
 * 帳務 pane 的玉山掛鉤。queryAccounts 為 AccountPaneContent 已依範圍與市場篩好的帳戶。
 * - sim：永豐旗標（LimitsSection／ReserveSection 只含永豐資料；FundsSection 的期貨提示也只看永豐）。
 * - stockSim：範圍內證券帳戶所屬券商的旗標（FundsSection 的證券交割帳戶提示）。
 * - sinopacStock：非玉山的證券帳戶（上游交易額度與預收查詢只查這些）。
 * - overview：玉山帳務概覽的 useQuery 結果（refresh／loading／error 併入 refreshReports）。
 */
export function useEsunAccountPane(queryAccounts: readonly Account[], sinopacSimulation: boolean) {
    const env = useEsunEnvironment();
    const stock = queryAccounts.filter(a => a.account_type === 'S');
    const esunAccounts = stock.filter(a => isEsunAccount(a));
    const esunKey = esunAccounts.map(accountId).sort().join('|');
    const fetcher = useCallback(
        () => Promise.all(esunAccounts.map(async (a): Promise<EsunOverviewRow> => ({
            key: accountId(a),
            overview: await esunTradeService.fetchAccountOverview(a),
        }))),
        // esunKey 決定 esunAccounts 的內容
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [esunKey],
    );
    const overview = useQuery<EsunOverviewRow[]>(
        fetcher,
        `esun-account-overview:${esunKey}${esunEnvKey(esunAccounts, env.environment)}`,
        esunAccounts.length > 0,
        esunAccounts,
    );
    return {
        sim: sinopacSimulation,
        stockSim: esunScopedSimulation(stock, sinopacSimulation, env.isSimulation),
        sinopacStock: stock.filter(a => !isEsunAccount(a)),
        overview,
    };
}

export type EsunOverviewQuery = ReturnType<typeof useEsunAccountPane>['overview'];

/** ISO → 台北時間 YYYY-MM-DD HH:MM:SS；不合法 → '' */
export function taipeiDateTime(iso: string): string {
    const t = Date.parse(iso);
    if (!iso || !Number.isFinite(t)) return '';
    const d = new Date(t + 8 * 3600_000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function Row({ label, value, valueClass }: { label: string; value: ReactNode; valueClass?: string }) {
    return (
        <div className={dock.fundRow}>
            <span className={dock.fundLabel}>{label}</span>
            <span className={valueClass ?? dock.fundValue}>{value}</span>
        </div>
    );
}

function StatusRow({ label, text, code }: { label: string; text: string; code: string }) {
    // 不可用的狀態（當沖 N／S、信用 9）以灰字呈現
    const off = code === 'N' || code === 'S' || code === '9' || !text;
    return (
        <Row
            label={label}
            value={text || '—'}
            valueClass={`${styles.statusValue} ${off ? styles.statusOff : ''}`}
        />
    );
}

function Title({ text, note }: { text: string; note?: string }) {
    return (
        <div className={dock.acctTitle}>
            {text}
            {note && <span className={dock.acctTitleNote}>{note}</span>}
        </div>
    );
}

function AccountBlocks({ data, note }: { data: EsunAccountOverviewData; note?: string }) {
    const privMoney = usePrivacyMoney();
    const money = (n: number | null) => (n === null ? '—' : maskMoney(fmtMoney(n), privMoney));
    const { balance, tradeStatus, marketStatus } = data;
    const updated = taipeiDateTime(balance.updatedAt);
    const tradingDay = marketStatus?.isTradingDay;
    return (
        <>
            <section className={dock.acctSection} aria-label='玉山銀行餘額'>
                <Title text='銀行餘額 Bank Balance' note={note} />
                <Row label='可用銀行餘額' value={money(balance.availableBalance)} />
                <Row label='今日票據交換金額' value={money(balance.exchangeBalance)} />
                <Row label='圈存金額' value={money(balance.preSaveAmount)} />
                <div className={dock.fundRow}>
                    <span className={dock.fundLabel}>資料時間</span>
                    <span className={dock.fundValue}>
                        {updated || '—'}
                        {balance.isLatestData === false && (
                            <span className={`${styles.badge} ${styles.badgeWarn}`}>非最新資料</span>
                        )}
                        {balance.cached === true && (
                            <span className={styles.badge}>
                                {balance.cacheAgeSec === null ? '快取資料' : `快取 ${Math.max(0, Math.round(balance.cacheAgeSec))} 秒前`}
                            </span>
                        )}
                    </span>
                </div>
            </section>
            <section className={dock.acctSection} aria-label='玉山交易額度及權限'>
                <Title text='交易額度及權限 Limits' note={note} />
                <Row label='交易額度' value={money(tradeStatus.tradeLimit)} />
                <Row label='融資額度' value={money(tradeStatus.marginLimit)} />
                <Row label='融券額度' value={money(tradeStatus.shortLimit)} />
                <span className={dock.acctHint}>券商提供之額度，未提供已用／剩餘</span>
                <span className={styles.subHead}>權限</span>
                <StatusRow label='現股當沖' text={tradeStatus.dayTradeLabel} code={tradeStatus.dayTradeCode} />
                <StatusRow label='融資' text={tradeStatus.marginLabel} code={tradeStatus.marginCode} />
                <StatusRow label='融券' text={tradeStatus.shortLabel} code={tradeStatus.shortCode} />
            </section>
            <section className={dock.acctSection} aria-label='玉山預收券款／圈存'>
                <Title text='預收券款/圈存 Reserve' note={note} />
                <Row label='圈存金額' value={money(balance.preSaveAmount)} />
                <span className={dock.acctHint}>玉山未提供逐檔預收明細</span>
            </section>
            <section className={dock.acctSection} aria-label='玉山市場狀態'>
                <Title text='市場狀態 Market' note={note} />
                {marketStatus === null ? (
                    <span className={dock.acctHint}>暫時無法查詢市場狀態</span>
                ) : (
                    <>
                        <Row
                            label='今日是否開盤'
                            value={tradingDay === true ? '開盤' : tradingDay === false ? '休市' : '—'}
                            valueClass={styles.statusValue}
                        />
                        <Row label='上個交易日' value={marketStatus.lastTradingDay || '—'} />
                        <Row label='下個交易日' value={marketStatus.nextTradingDay || '—'} />
                    </>
                )}
            </section>
        </>
    );
}

/**
 * 範圍內每個玉山證券帳戶一組概覽區塊；放在交割行事曆之後，第一行是交割試算提示。
 * accounts 為範圍內的證券帳戶（非玉山帳戶會被略過）；沒有玉山帳戶時不渲染。
 */
export function EsunAccountOverview({ accounts, query }: { accounts: readonly Account[]; query: EsunOverviewQuery }) {
    const priv = usePrivacyMode();
    const esunAccounts = accounts.filter(a => a.account_type === 'S' && isEsunAccount(a));
    if (!esunAccounts.length) return null;
    const byKey = new Map((query.data ?? []).map(row => [row.key, row.overview]));
    const multi = esunAccounts.length > 1;
    return (
        <>
            <div className={styles.settleNote} role='note'>
                玉山：盤中交割款為試算，21:00 帳務更新後為正確 T+2 金額
            </div>
            {esunAccounts.map(account => {
                const key = accountId(account);
                const data = byKey.get(key);
                const note = multi ? `玉山-${maskAccountId(account.account_id, priv)}` : '玉山';
                if (data) return <AccountBlocks key={key} data={data} note={note} />;
                return (
                    <section key={key} className={dock.acctSection} aria-label='玉山帳務概覽'>
                        <Title text='玉山帳務 E.SUN' note={note} />
                        {query.error && !query.loading ? (
                            <span className={dock.acctHint} role='status'>玉山帳務概覽查詢失敗：{query.error}</span>
                        ) : (
                            <AsyncStatus phase='loading' text='載入玉山帳務' className={dock.loadingRow} />
                        )}
                    </section>
                );
            })}
        </>
    );
}
