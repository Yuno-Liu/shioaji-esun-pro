// src/mobile/components/position-summary.tsx — 持倉頁摘要卡（比照桌面 bottom-dock 摘要列）
//
// - 未實現損益合計（估）：目前篩選範圍（帳戶＋市場）的列加總；持倉尚未讀到時顯示「—」，不顯示 0。
//   全部為股票時附報酬率（損益 ÷ 成本）。
// - 總市值：股票列 |股數|×現價（sumStockMarketValue）；有列缺價時標示「部分缺價未計」。
// - 期貨權益數與風險指標：useTradingState().margin 屬於「目前選取的期貨帳戶」，由呼叫端決定是否顯示
//   並傳入帳戶標籤；風險指標無意義（模擬或未押保證金）時顯示「—」並說明。風險等級一律附文字，不只靠顏色。
// - 金額用 maskMoney 遮蔽；百分比不含金額，不遮蔽。

import { maskMoney } from '../../lib/privacy';
import type { Margin } from '../../lib/types/portfolio';
import { fmtInt, fmtPct, fmtSigned } from '../../lib/utils/format';
import * as styles from '../styles/positions.css';
import { futuresRiskOf, RISK_LEVEL_TEXT, type PositionsSummary } from './position-metrics';

export interface PositionSummaryCardProps {
    summary: PositionsSummary;
    /** 持倉是否已讀到（未讀到時合計顯示「—」） */
    known: boolean;
    /** 要顯示的期貨保證金（屬於 futuresLabel 帳戶）；不顯示時為 null */
    margin: Pick<Margin, 'equity' | 'initial_margin' | 'risk_indicator'> | null;
    /** 期貨帳戶標籤（已遮蔽） */
    futuresLabel: string;
    privMoney: boolean;
}

const tone = (v: number): 'up' | 'down' | 'flat' => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

export function PositionSummaryCard({ summary, known, margin, futuresLabel, privMoney }: PositionSummaryCardProps) {
    const risk = margin ? futuresRiskOf(margin) : null;
    const value = summary.marketValue;
    return (
        <div className={styles.summary} data-testid='position-summary'>
            <div className={styles.summaryMain}>
                <span className={styles.summaryLabel}>未實現損益合計</span>
                <span className={`${styles.summaryValue} ${styles.tone[known ? tone(summary.pnl) : 'flat']}`} data-testid='position-total'>
                    {known ? maskMoney(fmtSigned(summary.pnl, 0), privMoney) : '—'}
                </span>
                {known && summary.pnlPct !== null && (
                    <span className={styles.tone[tone(summary.pnlPct)]} data-testid='position-total-pct'>（{fmtPct(summary.pnlPct)}）</span>
                )}
                <span className={styles.estimate}>（估）</span>
            </div>
            <dl className={styles.summaryGrid}>
                {value && (
                    <div className={styles.summaryItem}>
                        <dt className={styles.summaryLabel}>股票總市值</dt>
                        <dd className={styles.summaryItemValue} data-testid='position-market-value'>
                            {known ? maskMoney(fmtInt(Math.round(value.value)), privMoney) : '—'}
                            {known && value.incomplete && <span className={styles.summaryNote}>（部分缺價未計）</span>}
                        </dd>
                    </div>
                )}
                {risk && (
                    <>
                        <div className={styles.summaryItem}>
                            <dt className={styles.summaryLabel}>期貨權益數{futuresLabel ? `（${futuresLabel}）` : ''}</dt>
                            <dd className={styles.summaryItemValue} data-testid='position-equity'>
                                {risk.equity === null ? '—' : maskMoney(fmtInt(Math.round(risk.equity)), privMoney)}
                            </dd>
                        </div>
                        <div className={styles.summaryItem}>
                            <dt className={styles.summaryLabel}>風險指標</dt>
                            <dd className={`${styles.summaryItemValue} ${risk.level ? styles.risk[risk.level] : ''}`} data-testid='position-risk'>
                                {risk.risk === null ? '—' : `${risk.risk.toFixed(0)}%（${RISK_LEVEL_TEXT[risk.level!]}）`}
                            </dd>
                        </div>
                    </>
                )}
            </dl>
            {risk && risk.risk === null && (
                <p className={styles.summaryNote} data-testid='position-risk-note'>沒有原始保證金（模擬環境或未持有期權部位）時，風險指標無意義，顯示「—」。</p>
            )}
        </div>
    );
}
