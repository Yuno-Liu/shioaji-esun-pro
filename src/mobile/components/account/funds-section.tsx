// src/mobile/components/account/funds-section.tsx — 帳戶頁「資金」與「交割行事曆」（比照桌面 bottom-dock-account.tsx FundsSection／SettleSection）
//
// - 股票：交割帳戶餘額（useTradingState().funds）、股票市值（sumStockMarketValue）、未交割款（pendingSettlementAmount）、
//   資產市值＝Σ清算價值（useStockLiquidationValue）＋未交割款＋交割戶餘額；有待確認原因時不給合計。
// - 期貨：權益數、可用／原始／維持保證金、風險指標與色條、期貨平倉損益。
// - 交割行事曆：固定 T+0／T+1／T+2；交割款 SETTLEMENT_REUSE_MS 內重用、手動更新受同一間隔限制，不自動重查。
// - 餘額與保證金隨帳務同步更新，不另外輪詢（§9.1）。

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { useAccounts } from '../../../lib/account-store';
import { isEsunAccount } from '../../../lib/esun';
import { accountMatches } from '../../../lib/flash-account';
import {
    isPriorTaipeiDay,
    pendingSettlementAmount,
    settlementsOlderThanPositions,
    stockPositionsSignature,
    sumStockMarketValue,
    useStockLiquidationValue,
    type ValuedStockPosition,
} from '../../../lib/position-value';
import { maskMoney, usePrivacyMoney } from '../../../lib/privacy';
import { useTradingState } from '../../../lib/trading-state';
import type { Account, AccountFunds, AccountedPosition } from '../../../lib/types/portfolio';
import { useOrderRoute } from '../route-badge';
import { accountKeyOf, formatClock, formatTwd, signDir } from '../../lib/account-format';
import { marginLooksBlank, marginRisk, settlementSlots, stockAssetSummary, stockPositionKind, type RiskLevel } from '../../lib/account-funds';
import { SETTLEMENT_REUSE_MS, useSettlements, type SettlementState } from '../../lib/account-settlements';
import * as styles from '../../styles/account.css';
import { brokerName, Card, Item, useNow, type Tone } from './account-ui';

function fundsFor(funds: AccountFunds[] | undefined, account: Account | null): AccountFunds | undefined {
    if (!account) return undefined;
    return funds?.find(f => accountMatches(f.account, account));
}

/** 選定證券帳戶的股票部位（持倉資料帶帳戶；股票部位有 yd_quantity） */
export function stockRowsOf(positions: readonly AccountedPosition[] | undefined, account: Account | null): ValuedStockPosition[] {
    if (!account || !positions) return [];
    return positions.filter((p): p is ValuedStockPosition => 'yd_quantity' in p && !!p.account && accountMatches(p.account, account));
}

const RISK_TONE: Record<RiskLevel, Tone> = { none: 'muted', danger: 'bad', warn: 'warn', safe: 'good' };
const RISK_TEXT: Record<RiskLevel, string> = { none: '', danger: '追繳風險', warn: '偏低', safe: '安全' };

function useMoney() {
    const privMoney = usePrivacyMoney();
    return {
        privMoney,
        money: (v: number | undefined | null, signed = false) => maskMoney(formatTwd(v, signed), privMoney),
    };
}

interface StockFundsProps {
    stock: Account;
    stockFunds: AccountFunds | undefined;
    rows: ValuedStockPosition[];
    pending: number | null;
    settlementsStale: boolean;
    priorDay: boolean;
}

function StockFunds({ stock, stockFunds, rows, pending, settlementsStale, priorDay }: StockFundsProps) {
    const { privMoney, money } = useMoney();
    const route = useOrderRoute(stock);
    const [showBreakdown, setShowBreakdown] = useState(false);
    const balance = stockFunds?.balance;
    const simBlank = route?.simulation === true && !!balance && balance.acc_balance === 0;
    const cash = balance && !balance.errmsg?.trim() && !stockFunds?.error ? balance.acc_balance : null;
    const marketValue = sumStockMarketValue(rows);
    const liquidation = useStockLiquidationValue(rows);
    const summary = stockAssetSummary({ cash, liquidation, pending, settlementsStale, priorDay });

    return (
        <>
            <h3 className={styles.subTitle}>股票（{brokerName(stock)}）</h3>
            <dl className={styles.kv}>
                <Item term='交割帳戶餘額' testId='funds-balance' tone={simBlank ? 'muted' : 'normal'}>
                    {simBlank ? '模擬環境無法查詢' : balance ? money(balance.acc_balance) : '—'}
                </Item>
                <Item term='股票市值' testId='funds-market-value'>
                    {money(marketValue.value)}
                    {marketValue.incomplete && <span className={styles.badge}>部分待確認</span>}
                </Item>
                <Item term='未交割款' testId='funds-pending' className={pending === null ? undefined : styles.dir[signDir(pending)]}>
                    {pending === null ? '待確認' : money(pending, true)}
                </Item>
                <Item term='資產市值' testId='funds-total-assets' tone={summary.total === null ? 'muted' : 'normal'}>
                    {simBlank ? '—' : summary.total === null ? '待確認' : money(summary.total)}
                </Item>
                <Item term='資料時間' tone='muted'>{formatClock(stockFunds?.updatedAt)}</Item>
            </dl>
            {stockFunds?.error && <p className={styles.warning}>{stockFunds.error}</p>}
            {!simBlank && summary.total === null && (
                <p className={styles.warning} role='status' data-testid='funds-total-reasons'>{summary.reasons.join('；')}；合計待確認</p>
            )}
            <p className={styles.note}>資產市值含未交割款；信用部位以清算價值計。</p>
            <button
                type='button'
                className={styles.toggleRow}
                aria-expanded={showBreakdown}
                onClick={() => setShowBreakdown(v => !v)}
                data-testid='funds-breakdown-toggle'
            >
                {showBreakdown ? <ChevronDown size={16} aria-hidden='true' /> : <ChevronRight size={16} aria-hidden='true' />}
                資產組成（核對用）
            </button>
            {showBreakdown && (
                <dl className={styles.kv} data-testid='funds-breakdown'>
                    <Item term='交割戶餘額'>{cash === null ? '—' : money(cash)}</Item>
                    <Item term='未交割款'>{pending === null ? '待確認' : money(pending, true)}</Item>
                    {rows.length === 0 && <Item term='股票部位' tone='muted'>無</Item>}
                    {rows.map((p, i) => {
                        const v = liquidation.values[i];
                        return (
                            <Item
                                key={`${i}-${p.code}-${p.cond}-${p.direction}`}
                                term={`${p.code} ${stockPositionKind(p)} ${maskMoney(`${Math.abs(p.quantity).toLocaleString('en-US')} 股`, privMoney)}`}
                            >
                                {v === null || v === undefined ? '待確認' : money(v)}
                            </Item>
                        );
                    })}
                </dl>
            )}
        </>
    );
}

function FuturesFunds({ fut, futFunds }: { fut: Account; futFunds: AccountFunds | undefined }) {
    const { money } = useMoney();
    const route = useOrderRoute(fut);
    const margin = futFunds?.margin;
    const simBlank = route?.simulation === true && marginLooksBlank(margin);
    const risk = marginRisk(margin);
    return (
        <>
            <h3 className={styles.subTitle}>期貨（{brokerName(fut)}）</h3>
            {simBlank ? (
                <p className={styles.note}>模擬環境無法查詢保證金。</p>
            ) : (
                <>
                    <dl className={styles.kv}>
                        <Item term='權益數' testId='funds-equity'>{margin ? money(margin.equity) : '—'}</Item>
                        <Item term='可用保證金'>{margin ? money(margin.available_margin) : '—'}</Item>
                        <Item term='原始保證金' testId='funds-initial-margin'>{margin ? money(margin.initial_margin) : '—'}</Item>
                        <Item term='維持保證金' testId='funds-maintenance-margin'>{margin ? money(margin.maintenance_margin) : '—'}</Item>
                        <Item term='風險指標' tone={RISK_TONE[risk.level]} testId='funds-risk'>
                            {risk.meaningful ? `${risk.value.toFixed(0)}%（${RISK_TEXT[risk.level]}）` : '—'}
                        </Item>
                    </dl>
                    {risk.meaningful && (
                        <div
                            className={styles.riskTrack}
                            role='meter'
                            aria-label='風險指標'
                            aria-valuemin={0}
                            aria-valuemax={300}
                            aria-valuenow={Math.round(risk.value)}
                            aria-valuetext={`${risk.value.toFixed(0)}%，${RISK_TEXT[risk.level]}`}
                            data-testid='funds-risk-bar'
                        >
                            <span className={styles.riskFill[risk.level]} style={{ width: `${risk.barPercent}%` }} />
                        </div>
                    )}
                    <dl className={styles.kv}>
                        <Item
                            term='期貨平倉損益'
                            testId='funds-settle-pnl'
                            className={margin ? styles.dir[signDir(margin.future_settle_profitloss)] : undefined}
                        >
                            {margin ? money(margin.future_settle_profitloss, true) : '—'}
                        </Item>
                        <Item term='資料時間' tone='muted'>{formatClock(futFunds?.updatedAt)}</Item>
                    </dl>
                    <p className={styles.note}>風險指標低於 200% 偏低、低於 100% 有追繳風險（多帳戶不合計）。</p>
                </>
            )}
            {futFunds?.error && <p className={styles.warning}>{futFunds.error}</p>}
        </>
    );
}

interface SettlementCardProps {
    stock: Account | null;
    settle: SettlementState & { refresh: () => void };
    pending: number | null;
    settlementsStale: boolean;
    priorDay: boolean;
    now: number;
}

function SettlementCard({ stock, settle, pending, settlementsStale, priorDay, now }: SettlementCardProps) {
    const { money } = useMoney();
    const canRefresh = !!stock && !settle.loading && (settle.at === null || now - settle.at >= SETTLEMENT_REUSE_MS);
    const slots = settle.rows ? settlementSlots(settle.rows, now) : null;
    return (
        <Card title='交割行事曆' testId='account-settlements'>
            {!stock ? (
                <p className={styles.note}>尚未選擇證券帳戶。</p>
            ) : (
                <>
                    <p className={styles.note}>正＝應收、負＝應付</p>
                    {slots ? (
                        <div data-testid='funds-settlements'>
                            {slots.map(s => (
                                <div key={s.t} className={styles.settleRow}>
                                    <span className={styles.settleTag}>T+{s.t}</span>
                                    <span className={styles.settleDate}>{s.dateLabel}</span>
                                    <span className={`${styles.settleAmount} ${styles.dir[signDir(s.amount)]}`}>{money(s.amount, true)}</span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className={styles.note}>{settle.loading ? '交割款查詢中…' : '—'}</p>
                    )}
                    <dl className={styles.kv}>
                        <Item term='未交割合計' testId='settle-pending' className={pending === null ? undefined : styles.dir[signDir(pending)]}>
                            {pending === null ? '待確認' : money(pending, true)}
                        </Item>
                    </dl>
                    {settlementsStale && <p className={styles.warning} role='status' data-testid='settle-stale'>成交後交割款尚未更新，請按「更新交割款」。</p>}
                    {priorDay && settle.rows && <p className={styles.warning} role='status' data-testid='settle-prior-day'>交割戶餘額或交割款為前一日資料，請更新。</p>}
                    {isEsunAccount(stock) && <p className={styles.note}>玉山：盤中交割款為試算，21:00 帳務更新後為正確 T+2 金額。</p>}
                    {settle.error && <p className={styles.warning} role='alert'>{settle.error}</p>}
                    <div className={styles.actions}>
                        <span className={styles.note}>資料時間 {formatClock(settle.at)}</span>
                        <button type='button' className={styles.smallButton} disabled={!canRefresh} onClick={() => settle.refresh()} data-testid='funds-settle-refresh'>
                            更新交割款
                        </button>
                    </div>
                </>
            )}
        </Card>
    );
}

/** 資金卡＋交割行事曆卡（共用同一份交割款，只查一次） */
export function FundsSections() {
    const accounts = useAccounts();
    const trading = useTradingState();
    const now = useNow(5_000);
    const stock = accounts.selectedStock;
    const fut = accounts.selectedFutures;
    const stockFunds = fundsFor(trading.funds, stock);
    const futFunds = fundsFor(trading.funds, fut);
    const settle = useSettlements(stock);
    const rows = stockRowsOf(trading.positions, stock);
    const settlementsStale = !!stock && settlementsOlderThanPositions(
        `mobile-settlements:${accountKeyOf(stock)}`, settle.at, settle.loading, stockPositionsSignature(rows),
    );
    const balanceAt = typeof stockFunds?.updatedAt === 'number' && Number.isFinite(stockFunds.updatedAt) ? stockFunds.updatedAt : null;
    const pending = balanceAt === null ? null : pendingSettlementAmount(settle.rows ?? undefined, balanceAt);
    const priorDay = (balanceAt !== null && isPriorTaipeiDay(balanceAt, now)) || (settle.rows !== null && isPriorTaipeiDay(settle.at, now));

    return (
        <>
            <Card title='資金' testId='account-funds'>
                {!stock ? (
                    <>
                        <h3 className={styles.subTitle}>股票</h3>
                        <p className={styles.note}>尚未選擇證券帳戶。</p>
                    </>
                ) : (
                    <StockFunds stock={stock} stockFunds={stockFunds} rows={rows} pending={pending} settlementsStale={settlementsStale} priorDay={priorDay} />
                )}
                {!fut ? (
                    <>
                        <h3 className={styles.subTitle}>期貨</h3>
                        <p className={styles.note}>尚未選擇期貨帳戶。</p>
                    </>
                ) : (
                    <FuturesFunds fut={fut} futFunds={futFunds} />
                )}
                <p className={styles.note}>餘額與保證金隨帳務同步更新，不另外輪詢（避免觸及券商查詢頻率限制）。</p>
            </Card>
            <SettlementCard stock={stock} settle={settle} pending={pending} settlementsStale={settlementsStale} priorDay={priorDay} now={now} />
        </>
    );
}
