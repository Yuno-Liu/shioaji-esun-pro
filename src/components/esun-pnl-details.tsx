// src/components/esun-pnl-details.tsx — 今日已實現損益：玉山列的交易成本與逐筆成交（fork 元件）
//
// 資料來自 esunTradeService.fetchProfitLoss 寫入的成交明細 store（useEsunTransactionDetails）。
// store 的鍵是呼叫 fetchProfitLoss 時傳入的原始區間字串：帳務 tab 以預設值呼叫
// fetchProfitLoss(market, account)，預設 beginDate／endDate 皆為 todayStr()（YYYY-MM-DD），
// 經 accountQueryPost 的 begin_date／end_date 原樣送到玉山 dispatch → service，因此這裡也用 todayStr() 查。

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import {
    findEsunTransactionDetail,
    getEsunTransactionDetailsSnapshot,
    isEsunBroker,
    subscribeEsunTransactionDetails,
    useEsunTransactionDetails,
    type EsunAccountRef,
    type EsunTransactionDetail,
    type EsunTransactionFill,
} from '../lib/esun';
import { maskAccountId, maskMoney, usePrivacyMode, usePrivacyMoney } from '../lib/privacy';
import type { ProfitLoss } from '../lib/shioaji';
import {
    discountText,
    feeRebate,
    hasMonthlyRebate,
    useTradingCostSettings,
    type TradingCostSettings,
} from '../lib/trading-cost-settings';
import { applyRateYuan, STOCK_FEE_RATE } from '../lib/utils/contract-cost';
import { fmtMoney, fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
import { todayStr } from '../lib/utils/date';
import * as dock from './bottom-dock.css';
import * as styles from './esun-account-overview.css';
import * as panel from './panel.css';

/** 帳務 tab 已實現損益列（AccountPaneContent 的 AccountedPnl） */
export type EsunPnlRow = ProfitLoss & { market: 'S' | 'F'; accountKey: string };

/** accountKey（`${broker_id}:${account_id}`）→ 玉山帳戶參照；非玉山或格式不符回 null */
export function esunRefOfPnlRow(row: Pick<EsunPnlRow, 'market' | 'accountKey'>): EsunAccountRef | null {
    if (row.market !== 'S') return null;
    const idx = row.accountKey.lastIndexOf(':');
    if (idx <= 0) return null;
    const broker_id = row.accountKey.slice(0, idx);
    const account_id = row.accountKey.slice(idx + 1);
    return isEsunBroker(broker_id) && account_id ? { broker_id, account_id } : null;
}

function sumOf(values: readonly (number | null)[]): number | null {
    const known = values.filter((v): v is number => v !== null);
    return known.length ? known.reduce((s, v) => s + v, 0) : null;
}

export interface EsunFillCosts {
    fee: number | null;
    tax: number | null;
    capitalGainsTax: number | null;
    shortFee: number | null;
    total: number | null;
}

/** 逐筆成交的手續費、交易稅、證所稅、融券手續費加總（缺值不當 0；全部缺值為 null） */
export function esunFillCosts(fills: readonly EsunTransactionFill[]): EsunFillCosts {
    const fee = sumOf(fills.map(f => f.fee));
    const tax = sumOf(fills.map(f => f.tax));
    const capitalGainsTax = sumOf(fills.map(f => f.capitalGainsTax));
    const shortFee = sumOf(fills.map(f => f.shortFee));
    return { fee, tax, capitalGainsTax, shortFee, total: sumOf([fee, tax, capitalGainsTax, shortFee]) };
}

/** 月退且折數 < 1 時的預估退佣＝round(Σfee × (1 − 折數))；不適用或手續費全缺值回 null */
export function esunFillRebate(fills: readonly EsunTransactionFill[], settings: TradingCostSettings): number | null {
    if (!hasMonthlyRebate(settings)) return null;
    const fee = sumOf(fills.map(f => f.fee));
    return fee === null ? null : feeRebate(fee, settings);
}

/** 逐筆手續費合計與「價金合計 × 0.1425%」相差 2 元內 → 券商看起來收的是牌告手續費 */
export function esunFeesLookListRate(fills: readonly EsunTransactionFill[]): boolean {
    const fee = sumOf(fills.map(f => f.fee));
    const priceQty = sumOf(fills.map(f => (f.priceQty === null ? null : Math.abs(f.priceQty))));
    if (fee === null || priceQty === null || priceQty <= 0) return false;
    return Math.abs(fee - applyRateYuan(priceQty * 100, STOCK_FEE_RATE)) <= 2;
}

function dirOf(n: number | null): 'up' | 'down' | 'flat' {
    return n === null || n === 0 ? 'flat' : n > 0 ? 'up' : 'down';
}

function Kv({ label, value, dir }: { label: string; value: string; dir?: 'up' | 'down' | 'flat' }) {
    return (
        <div className={dock.fundRow}>
            <span className={dock.fundLabel}>{label}</span>
            <span className={`${dock.fundValue} ${dir ? panel.dirText[dir] : ''}`}>{value}</span>
        </div>
    );
}

export function EsunTransactionDetailView({ detail }: { detail: EsunTransactionDetail }) {
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const money = (n: number | null) => (n === null ? '—' : maskMoney(fmtMoney(n), privMoney));
    const signed = (n: number | null) => (n === null ? '—' : maskMoney(fmtSigned(n, 0), privMoney));
    const price = (n: number | null) => (n === null ? '—' : maskMoney(fmtPrice(n), privMoney));
    const shares = (n: number | null) => (n === null ? '—' : maskMoney(`${n.toLocaleString('en-US')} 股`, privMoney));
    const pct = (n: number | null) => (n === null ? '—' : maskMoney(fmtPct(n), privMoney));
    const costs = esunFillCosts(detail.fills);
    const costSettings = useTradingCostSettings();
    const rebate = esunFillRebate(detail.fills, costSettings);
    const pnlWithRebate = rebate !== null && detail.realizedPnl !== null ? detail.realizedPnl + rebate : null;
    const listRateHint = costSettings.rebateMode === 'instant' && costSettings.feeDiscount < 1 && esunFeesLookListRate(detail.fills);
    const side =detail.action === 'Buy' ? '買' : detail.action === 'Sell' ? '賣' : '';
    return (
        <div className={styles.pnlDetail}>
            <div className={styles.kvGrid}>
                <Kv label='交易類別' value={`${detail.tradeTypeLabel || '—'}${side ? ` ${side}` : ''}`} />
                <Kv label='成交均價' value={price(detail.avgPrice)} />
                <Kv label='股數' value={shares(detail.shares)} />
                <Kv label='價金小計' value={money(detail.priceQty)} />
                <Kv label='成本' value={money(detail.cost)} />
                <Kv label='收入' value={money(detail.income)} />
                <Kv label='已實現損益' value={signed(detail.realizedPnl)} dir={dirOf(detail.realizedPnl)} />
                <Kv label='獲利率' value={pct(detail.realizedPnlPct)} dir={dirOf(detail.realizedPnlPct)} />
            </div>
            <span className={styles.subHead}>交易成本（逐筆成交加總）</span>
            <div className={styles.kvGrid}>
                <Kv label='手續費' value={money(costs.fee)} />
                <Kv label='交易稅' value={money(costs.tax)} />
                <Kv label='證所稅' value={money(costs.capitalGainsTax)} />
                <Kv label='融券手續費' value={money(costs.shortFee)} />
                <Kv label='成本合計' value={money(costs.total)} />
                {rebate !== null && (
                    <>
                        <Kv label={`預估退佣（月退 ${discountText(costSettings.feeDiscount)} 折）`} value={`≈ ${money(rebate)}`} />
                        <Kv label='含退佣損益' value={pnlWithRebate === null ? '—' : `≈ ${signed(pnlWithRebate)}`} dir={dirOf(pnlWithRebate)} />
                    </>
                )}
            </div>
            {listRateHint && (
                <span className={styles.settleNote}>券商實際收取牌告手續費，若為事後退佣請將退佣方式設為月退（設定 → 風控 → 交易成本）。</span>
            )}
            <span className={styles.subHead}>逐筆成交</span>
            {detail.fills.length === 0 ? (
                <span className={dock.acctHint}>券商未提供逐筆成交</span>
            ) : (
                <div className={styles.fillsWrap}>
                    <table className={styles.fillsTable}>
                        <thead>
                            <tr>
                                {['成交日期 時間', '委託書號', '成交價', '股數', '價金', '手續費', '交易稅', '證所稅', '融券手續費', '淨收付', '損益'].map(h => (
                                    <th key={h} className={styles.fillsHead}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {detail.fills.map((f, i) => (
                                <tr key={`${f.orderNo}-${f.tradeDate}-${f.tradeTime}-${i}`}>
                                    <td className={styles.fillsCell}>{`${f.tradeDate || '—'}${f.tradeTime ? ` ${f.tradeTime}` : ''}`}</td>
                                    <td className={styles.fillsCell}>{f.orderNo ? maskAccountId(f.orderNo, priv || privMoney) : '—'}</td>
                                    <td className={styles.fillsCell}>{price(f.price)}</td>
                                    <td className={styles.fillsCell}>{f.shares === null ? '—' : maskMoney(f.shares.toLocaleString('en-US'), privMoney)}</td>
                                    <td className={styles.fillsCell}>{money(f.priceQty)}</td>
                                    <td className={styles.fillsCell}>{money(f.fee)}</td>
                                    <td className={styles.fillsCell}>{money(f.tax)}</td>
                                    <td className={styles.fillsCell}>{money(f.capitalGainsTax)}</td>
                                    <td className={styles.fillsCell}>{money(f.shortFee)}</td>
                                    <td className={styles.fillsCell}>{signed(f.netAmount)}</td>
                                    <td className={`${styles.fillsCell} ${panel.dirText[dirOf(f.realizedPnl)]}`}>{signed(f.realizedPnl)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

/** 已實現損益明細列內的「交易成本明細」展開鈕；非玉山證券列不渲染 */
export function EsunPnlRowDetail({ row }: { row: EsunPnlRow }) {
    const [open, setOpen] = useState(false);
    const ref = esunRefOfPnlRow(row);
    const today = todayStr();
    const snapshot = useEsunTransactionDetails(ref, today, today);
    if (!ref) return null;
    const detail = findEsunTransactionDetail(snapshot?.details, row);
    return (
        <div className={styles.pnlExtra}>
            <button
                type='button'
                className={styles.pnlToggle}
                aria-expanded={open}
                title={open ? '收合交易成本明細' : '展開交易成本明細'}
                onClick={() => setOpen(v => !v)}
            >
                {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                交易成本明細
            </button>
            {open && (detail
                ? <EsunTransactionDetailView detail={detail} />
                : <span className={dock.acctHint}>尚未取得對應的玉山成交明細，請重新整理</span>)}
        </div>
    );
}

/**
 * 今日已實現玉山列的交易成本合計（手續費＋交易稅＋證所稅＋融券手續費）。
 * 回傳原始字串 `${玉山列數}|${對到明細的列數}|${合計或空字串}`，讓 useSyncExternalStore 的快照為原始值。
 */
function esunCostSummaryKey(rows: readonly EsunPnlRow[], date: string, settings: TradingCostSettings): string {
    let count = 0;
    let matched = 0;
    const totals: (number | null)[] = [];
    const rebates: (number | null)[] = [];
    for (const row of rows) {
        const ref = esunRefOfPnlRow(row);
        if (!ref) continue;
        count += 1;
        const detail = findEsunTransactionDetail(getEsunTransactionDetailsSnapshot(ref, date, date)?.details, row);
        if (!detail) continue;
        matched += 1;
        totals.push(esunFillCosts(detail.fills).total);
        rebates.push(esunFillRebate(detail.fills, settings));
    }
    const total = sumOf(totals);
    const rebate = sumOf(rebates);
    return `${count}|${matched}|${total === null ? '' : total}|${rebate === null ? '' : rebate}`;
}

/** 已實現損益區塊的「今日交易成本合計（玉山）」；範圍內沒有玉山證券列時不渲染 */
export function EsunPnlCostTotal({ rows }: { rows: readonly EsunPnlRow[] }) {
    const privMoney = usePrivacyMoney();
    const today = todayStr();
    const costSettings = useTradingCostSettings();
    const key = useSyncExternalStore(subscribeEsunTransactionDetails, () => esunCostSummaryKey(rows, today, costSettings), () => '0|||');
    const [countText, matchedText, totalText, rebateText] = key.split('|');
    const count = Number(countText);
    const matched = Number(matchedText);
    if (!count) return null;
    const total = totalText ? Number(totalText) : null;
    const rebate = rebateText ? Number(rebateText) : null;
    return (
        <>
            <div className={styles.costTotalRow} title='今日已實現玉山列逐筆成交的手續費、交易稅、證所稅、融券手續費加總'>
                <span className={dock.fundLabel}>今日交易成本合計（玉山）</span>
                <span className={dock.fundValue}>
                    {total === null ? '—' : maskMoney(fmtMoney(total), privMoney)}
                    {matched < count && <span className={styles.badge}>{count - matched} 筆明細未取得</span>}
                </span>
            </div>
            {rebate !== null && (
                <div className={styles.costTotalRow} title='月退：今日已實現玉山列逐筆手續費合計 × (1 − 折數) 的估算，實際以券商入帳為準'>
                    <span className={dock.fundLabel}>{`今日預估退佣（月退 ${discountText(costSettings.feeDiscount)} 折）`}</span>
                    <span className={dock.fundValue}>{`≈ ${maskMoney(fmtMoney(rebate), privMoney)}`}</span>
                </div>
            )}
        </>
    );
}
