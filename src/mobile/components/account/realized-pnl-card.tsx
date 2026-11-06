// src/mobile/components/account/realized-pnl-card.tsx — 帳戶頁「已實現損益」（規格 Phase 2；比照桌面 PnlSection／pnlFetcher）
//
// - 區間：今日／本週／本月／近 30 天（台北日期）；帳戶＝目前選定的證券與期貨帳戶。
// - 只在使用者展開區塊（且這個區間尚未讀過）或按「查詢」時讀取；同一區間＋帳戶 PNL_COOLDOWN_MS 內不重查。
// - 資料經由 src/lib 的 fetchProfitLoss／fetchProfitLossSummary（玉山帳戶由 lib 轉往 bridge）；玉山區間先以
//   clampEsunDateRange180Days 限制在 180 天內，並以同一組日期字串讀取玉山成交明細 store（useEsunTransactionDetails）。
// - 合計規則見 src/mobile/lib/account-pnl.ts（sum 優先、列表加總後備、逐帳戶判斷）。

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { esunFillCosts, esunFillRebate, esunRefOfPnlRow } from '../../../components/esun-pnl-details';
import { useAccounts } from '../../../lib/account-store';
import {
    clampEsunDateRange180Days,
    findEsunTransactionDetail,
    isEsunAccount,
    useEsunEnvironment,
    useEsunTransactionDetails,
    type EsunTransactionDetail,
} from '../../../lib/esun';
import { maskAccountId, maskMoney, usePrivacyMode, usePrivacyMoney } from '../../../lib/privacy';
import { canonicalBrokerCode } from '../../../lib/realized-name';
import { fetchProfitLoss, fetchProfitLossSummary } from '../../../lib/shioaji';
import { discountText, useTradingCostSettings } from '../../../lib/trading-cost-settings';
import type { Account } from '../../../lib/types/portfolio';
import { accountKeyOf, formatClock, formatPct, formatPrice, formatShares, formatTwd, signDir } from '../../lib/account-format';
import { canLoadOnDemand, cooldownLeftSec, loadOnDemand, onDemandNow, useOnDemand } from '../../lib/account-on-demand';
import {
    aggregateRealizedPnl,
    PNL_COOLDOWN_MS,
    PNL_PERIODS,
    pnlDateRange,
    realizedRowKey,
    type PnlPart,
    type PnlPeriod,
    type RealizedPnlResult,
    type RealizedPnlRow,
} from '../../lib/account-pnl';
import * as styles from '../../styles/account.css';
import { brokerName, CollapsibleCard, Item, RefreshButton, Segmented, useNow } from './account-ui';

interface PnlPlan {
    account: Account;
    market: 'S' | 'F';
    begin: string;
    end: string;
    /** 玉山區間被裁到 180 天內 */
    clamped: boolean;
}

/** 依帳戶決定查詢區間：玉山先裁到 180 天內（lib 內部也會裁，這裡裁好才能以同一字串讀成交明細 store） */
export function pnlPlans(accounts: readonly (Account | null)[], range: { begin: string; end: string }): PnlPlan[] {
    return accounts
        .filter((a): a is Account => !!a && (a.account_type === 'S' || a.account_type === 'F'))
        .map(account => {
            const market = account.account_type as 'S' | 'F';
            if (!isEsunAccount(account)) return { account, market, begin: range.begin, end: range.end, clamped: false };
            const c = clampEsunDateRange180Days(range.begin, range.end);
            return { account, market, begin: c.beginDate, end: c.endDate, clamped: c.clamped };
        });
}

const MARKET_TEXT = { S: '證券', F: '期貨' } as const;

function errorText(e: unknown): string {
    return e instanceof Error && e.message ? e.message : String(e || '查詢失敗');
}

/** 逐帳戶讀取列表與彙總（任一失敗不拖垮其他帳戶），再以 aggregateRealizedPnl 合計 */
export async function fetchRealizedPnl(plans: readonly PnlPlan[]): Promise<RealizedPnlResult> {
    const parts = await Promise.all(plans.map(async (p): Promise<PnlPart> => {
        const [list, sum] = await Promise.allSettled([
            fetchProfitLoss(p.market, p.account, p.begin, p.end),
            fetchProfitLossSummary(p.market, p.account, p.begin, p.end),
        ]);
        const label = `${brokerName(p.account)}${MARKET_TEXT[p.market]}`;
        const errors: string[] = [];
        if (list.status === 'rejected') errors.push(`${label}損益明細查詢失敗：${errorText(list.reason)}`);
        if (sum.status === 'rejected' && list.status === 'rejected') errors.push(`${label}損益彙總查詢失敗：${errorText(sum.reason)}`);
        return {
            market: p.market,
            accountKey: `${p.account.broker_id}:${p.account.account_id}`,
            list: list.status === 'fulfilled' && Array.isArray(list.value) ? list.value : null,
            sum: sum.status === 'fulfilled' ? sum.value : null,
            errors,
        };
    }));
    return aggregateRealizedPnl(parts);
}

function EsunDetailView({ detail }: { detail: EsunTransactionDetail }) {
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const costSettings = useTradingCostSettings();
    const money = (n: number | null) => maskMoney(formatTwd(n), privMoney);
    const signed = (n: number | null) => maskMoney(formatTwd(n, true), privMoney);
    const price = (n: number | null) => maskMoney(formatPrice(n), privMoney);
    const shares = (n: number | null) => maskMoney(formatShares(n), privMoney);
    const costs = esunFillCosts(detail.fills);
    const rebate = esunFillRebate(detail.fills, costSettings);
    const withRebate = rebate !== null && detail.realizedPnl !== null ? detail.realizedPnl + rebate : null;
    const side = detail.action === 'Buy' ? '買進' : detail.action === 'Sell' ? '賣出' : '';
    return (
        <div className={styles.detailBox} data-testid='pnl-esun-detail'>
            <dl className={styles.kv}>
                <Item term='交易類別'>{`${detail.tradeTypeLabel || '—'}${side ? ` ${side}` : ''}`}</Item>
                <Item term='成交均價'>{price(detail.avgPrice)}</Item>
                <Item term='股數'>{shares(detail.shares)}</Item>
                <Item term='價金小計'>{money(detail.priceQty)}</Item>
                <Item term='成本'>{money(detail.cost)}</Item>
                <Item term='收入'>{money(detail.income)}</Item>
                <Item term='已實現損益' className={styles.dir[signDir(detail.realizedPnl)]}>{signed(detail.realizedPnl)}</Item>
                <Item term='獲利率' className={styles.dir[signDir(detail.realizedPnlPct)]}>{maskMoney(formatPct(detail.realizedPnlPct), privMoney)}</Item>
            </dl>
            <h4 className={styles.subTitle}>交易成本（逐筆成交加總）</h4>
            <dl className={styles.kv}>
                <Item term='手續費'>{money(costs.fee)}</Item>
                <Item term='交易稅'>{money(costs.tax)}</Item>
                <Item term='證所稅'>{money(costs.capitalGainsTax)}</Item>
                <Item term='融券手續費'>{money(costs.shortFee)}</Item>
                <Item term='成本合計' testId='pnl-esun-cost-total'>{money(costs.total)}</Item>
                {rebate !== null && (
                    <>
                        <Item term={`預估退佣（月退 ${discountText(costSettings.feeDiscount)} 折）`}>≈ {money(rebate)}</Item>
                        <Item term='含退佣損益' className={styles.dir[signDir(withRebate)]}>≈ {signed(withRebate)}</Item>
                    </>
                )}
            </dl>
            <h4 className={styles.subTitle}>逐筆成交</h4>
            {detail.fills.length === 0 ? (
                <p className={styles.note}>券商未提供逐筆成交。</p>
            ) : (
                detail.fills.map((f, i) => (
                    <div key={`${f.orderNo}-${f.tradeDate}-${f.tradeTime}-${i}`} className={styles.fillCard}>
                        <div className={styles.fillHead}>
                            <span>{`${f.tradeDate || '—'}${f.tradeTime ? ` ${f.tradeTime}` : ''}`}</span>
                            <span>書號 {f.orderNo ? maskAccountId(f.orderNo, priv || privMoney) : '—'}</span>
                        </div>
                        <dl className={styles.kv}>
                            <Item term='成交價／股數'>{price(f.price)} × {f.shares === null ? '—' : maskMoney(f.shares.toLocaleString('en-US'), privMoney)}</Item>
                            <Item term='價金'>{money(f.priceQty)}</Item>
                            <Item term='手續費／交易稅'>{money(f.fee)} / {money(f.tax)}</Item>
                            {(f.capitalGainsTax !== null || f.shortFee !== null) && (
                                <Item term='證所稅／融券手續費'>{money(f.capitalGainsTax)} / {money(f.shortFee)}</Item>
                            )}
                            <Item term='淨收付'>{signed(f.netAmount)}</Item>
                            <Item term='損益' className={styles.dir[signDir(f.realizedPnl)]}>{signed(f.realizedPnl)}</Item>
                        </dl>
                    </div>
                ))
            )}
        </div>
    );
}

/** 玉山證券列的「交易成本明細」展開；非玉山證券列不渲染 */
function EsunRowDetail({ row, plans }: { row: RealizedPnlRow; plans: readonly PnlPlan[] }) {
    const [open, setOpen] = useState(false);
    const ref = esunRefOfPnlRow(row);
    const plan = ref ? plans.find(p => p.market === 'S' && p.account.broker_id === ref.broker_id && p.account.account_id === ref.account_id) : undefined;
    const snapshot = useEsunTransactionDetails(plan ? ref : null, plan?.begin ?? '', plan?.end ?? '');
    if (!ref || !plan) return null;
    const detail = findEsunTransactionDetail(snapshot?.details, row);
    return (
        <>
            <button type='button' className={styles.toggleRow} aria-expanded={open} onClick={() => setOpen(v => !v)} data-testid='pnl-esun-detail-toggle'>
                {open ? <ChevronDown size={16} aria-hidden='true' /> : <ChevronRight size={16} aria-hidden='true' />}
                交易成本明細
            </button>
            {open && (detail ? <EsunDetailView detail={detail} /> : <p className={styles.note}>尚未取得對應的玉山成交明細，請重新查詢。</p>)}
        </>
    );
}

function PnlRows({ result, plans, showDate }: { result: RealizedPnlResult; plans: readonly PnlPlan[]; showDate: boolean }) {
    const privMoney = usePrivacyMoney();
    return (
        <div data-testid='pnl-rows'>
            {result.rows.map((r, i) => {
                const meta = [MARKET_TEXT[r.market], showDate && r.date ? r.date : ''].filter(Boolean).join(' · ');
                return (
                    <div key={realizedRowKey(r, i)} className={styles.pnlItem} data-testid='pnl-row'>
                        <div className={styles.pnlRow}>
                            <span className={styles.pnlCode}>
                                <span>{canonicalBrokerCode(String(r.code ?? '')) || r.code}</span>
                                <span className={styles.pnlMeta}>{meta}</span>
                            </span>
                            <span className={styles.pnlQty}>
                                {maskMoney(`${Math.abs(r.quantity).toLocaleString('en-US')}${r.market === 'S' ? '張' : '口'}`, privMoney)}
                            </span>
                            <span className={`${styles.pnlValue} ${styles.dir[signDir(r.pnl)]}`}>{maskMoney(formatTwd(r.pnl, true), privMoney)}</span>
                        </div>
                        <EsunRowDetail row={r} plans={plans} />
                    </div>
                );
            })}
        </div>
    );
}

export function RealizedPnlCard() {
    const { selectedStock, selectedFutures } = useAccounts();
    const env = useEsunEnvironment();
    const privMoney = usePrivacyMoney();
    const [open, setOpen] = useState(false);
    const [period, setPeriod] = useState<PnlPeriod>('today');
    // 展開時每秒重繪（冷卻倒數）；收合時只需跟上日期變化
    const now = useNow(open ? 1_000 : 60_000);
    const range = pnlDateRange(period, now);
    const plans = pnlPlans([selectedStock, selectedFutures], range);
    const hasEsun = plans.some(p => isEsunAccount(p.account));
    const key = plans.length
        ? `pnl:${plans.map(p => `${accountKeyOf(p.account)}@${p.begin}~${p.end}`).join('|')}${hasEsun ? `:${env.environment}` : ''}`
        : null;
    const state = useOnDemand<RealizedPnlResult>(key);
    // useNow 只負責每秒重繪；冷卻以快取的時鐘計算（與 loadOnDemand 同一來源）
    const clockNow = onDemandNow();
    const canLoad = !!key && canLoadOnDemand(state, PNL_COOLDOWN_MS, clockNow);
    const load = () => {
        if (!key) return;
        const snapshot = plans;
        void loadOnDemand(key, () => fetchRealizedPnl(snapshot), PNL_COOLDOWN_MS);
    };
    const toggle = () => {
        const next = !open;
        setOpen(next);
        // 展開時只在這個區間尚未讀過時讀取一次（之後由「查詢」更新）
        if (next && state.data === null && !state.loading && canLoad) load();
    };
    const result = state.data;
    const money = (v: number | null) => maskMoney(formatTwd(v, true), privMoney);

    return (
        <CollapsibleCard title='已實現損益' open={open} onToggle={toggle} testId='account-pnl'>
            {!plans.length ? (
                <p className={styles.note}>尚未選擇帳戶。</p>
            ) : (
                <>
                    <Segmented<PnlPeriod> label='區間' value={period} options={PNL_PERIODS} onChange={setPeriod} testId='pnl-period' />
                    <p className={styles.note}>{range.begin === range.end ? range.end : `${range.begin} ～ ${range.end}`}（台北日期）</p>
                    {state.loading && !result && <p className={styles.note}>已實現損益查詢中…</p>}
                    {!state.loading && !result && !state.error && <p className={styles.note} data-testid='pnl-idle'>按「查詢」讀取這個區間的已實現損益。</p>}
                    {result && (
                        <>
                            <div className={styles.totalLine} data-testid='pnl-total'>
                                <span>合計（{result.rows.length} 筆）</span>
                                <span className={`${styles.totalValue} ${styles.dir[signDir(result.total)]}`}>
                                    {result.total === null ? '—' : money(result.total)}
                                </span>
                            </div>
                            {result.markets.length > 1 && (
                                <dl className={styles.kv}>
                                    {result.markets.map(m => (
                                        <Item key={`${m.market}:${m.accountKey}`} term={`${MARKET_TEXT[m.market]}${m.source === 'list' ? '（明細加總）' : ''}`} className={styles.dir[signDir(m.total)]}>
                                            {m.total === null ? '查詢失敗' : money(m.total)}
                                        </Item>
                                    ))}
                                </dl>
                            )}
                            {result.incomplete && <p className={styles.warning} role='status'>部分帳戶查詢失敗，合計只含成功的帳戶。</p>}
                            {result.errors.map(e => <p key={e} className={styles.warning} role='alert'>{e}</p>)}
                            {result.rows.length === 0
                                ? <p className={styles.note}>這個區間沒有已實現損益。</p>
                                : <PnlRows result={result} plans={plans} showDate={range.begin !== range.end} />}
                        </>
                    )}
                    {state.error && <p className={styles.warning} role='alert'>已實現損益查詢失敗：{state.error}</p>}
                    {hasEsun && (
                        <p className={styles.note} data-testid='pnl-esun-limit'>
                            {plans.some(p => p.clamped) ? '玉山查詢區間最長 180 天，已自動縮短。' : '玉山已實現損益最長查詢 180 天。'}
                        </p>
                    )}
                    <div className={styles.actions}>
                        <span className={styles.note}>資料時間 {formatClock(state.updatedAt)}</span>
                        <RefreshButton
                            label='查詢'
                            loading={state.loading}
                            cooldownSec={state.loading ? 0 : cooldownLeftSec(state, PNL_COOLDOWN_MS, clockNow)}
                            disabled={!canLoad}
                            onClick={load}
                            testId='pnl-query'
                        />
                    </div>
                </>
            )}
        </CollapsibleCard>
    );
}
