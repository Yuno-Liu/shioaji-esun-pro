// src/mobile/components/position-summary.tsx — 持倉頁摘要卡（比照桌面 bottom-dock 摘要列）
//
// - 未實現淨損益合計（估）：目前篩選範圍（帳戶＋市場）的列加總（股票＝含手續費折數與證交稅的淨損益，期權＝券商損益）；
//   持倉尚未讀到時顯示「—」，不顯示 0。全部為股票時附報酬率（淨損益 ÷ 成本）。
//   有列無法計算淨損益時不猜：只加總可計算的列並標示「合計待確認」（全部無法計算時顯示「—」）；含期權時註明未扣費稅。
// - 總市值：股票列 |股數|×現價（sumStockMarketValue）；有列缺價時標示「部分缺價未計」。
// - 期貨權益數與風險指標：useTradingState().margin 屬於「目前選取的期貨帳戶」，由呼叫端決定是否顯示
//   並傳入帳戶標籤；風險指標無意義（模擬或未押保證金）時顯示「—」並說明。風險等級一律附文字，不只靠顏色。
// - 今日剩餘交易額度（一行，account/today-limits.tsx）：篩選單一證券帳戶時為該帳戶（limitsAccount），
//   否則為目前選取的證券帳戶（玉山為上限），共用 useTradingLimits 快取；標籤帶券商名稱；
//   篩選範圍只有期貨列時不顯示；點擊跳到帳戶頁的額度卡。
// - 金額用 maskMoney 遮蔽；百分比不含金額，不遮蔽。
// - 版面（設計規格 §7.7）：GroupedSection 卡片；caption「未實現淨損益合計（估）」＋numHero（漲跌色、正負號）；
//   合計跳價閃爍（PriceFlash：遮蔽或未讀到時不閃、只動畫 opacity）；下方雙欄市值、權益數與風險指標
//   （數值文字＋等級文字為 foreground，狀態色只給下方進度條 scaleX）。
// - compact（持倉頁精簡檢視）：同樣內容，內距與合計字級縮小。

import { useRef } from 'react';
import { maskMoney } from '../../lib/privacy';
import type { Account, Margin } from '../../lib/types/portfolio';
import { fmtPct, fmtSigned } from '../../lib/utils/format';
import { fmtInt } from '../lib/num-format';
import * as styles from '../styles/positions.css';
import { ProgressBar, type BarTone } from '../ui/bars';
import { GroupedSection } from '../ui/grouped';
import { usePriceFlash } from '../ui/price-flash';
import * as flash from '../ui/price-flash.css';
import { TodayLimitsLine } from './account/today-limits';
import { futuresRiskOf, RISK_LEVEL_TEXT, type PositionsSummary, type RiskLevel } from './position-metrics';

export interface PositionSummaryCardProps {
    summary: PositionsSummary;
    /** 持倉是否已讀到（未讀到時合計顯示「—」） */
    known: boolean;
    /** 要顯示的期貨保證金（屬於 futuresLabel 帳戶）；不顯示時為 null */
    margin: Pick<Margin, 'equity' | 'initial_margin' | 'risk_indicator'> | null;
    /** 期貨帳戶標籤（已遮蔽） */
    futuresLabel: string;
    privMoney: boolean;
    /** 無法計算淨損益（未計入合計）的列數 */
    pending?: number;
    /** 所有列都無法計算：合計顯示「—」 */
    allPending?: boolean;
    /** 合計含期權的券商損益（未扣費稅） */
    derivGross?: boolean;
    /** 額度列要顯示的證券帳戶（持倉頁篩選單一證券帳戶時）；未提供時用目前選取的證券帳戶 */
    limitsAccount?: Pick<Account, 'broker_id' | 'account_id' | 'account_type'> | null;
    /** 持倉頁精簡檢視：內距、間距與合計字級縮小（內容不變） */
    compact?: boolean;
}

const tone = (v: number): 'up' | 'down' | 'flat' => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

/** 風險指標進度條的滿格（%）：300% 以上滿格；100%（危險線）約為三分之一 */
export const RISK_BAR_FULL_PCT = 300;
const RISK_TONE: Record<RiskLevel, BarTone> = { danger: 'danger', warn: 'amber', ok: 'success' };

export function PositionSummaryCard({ summary, known, margin, futuresLabel, privMoney, pending = 0, allPending = false, derivGross = false, limitsAccount, compact = false }: PositionSummaryCardProps) {
    const risk = margin ? futuresRiskOf(margin) : null;
    const value = summary.marketValue;
    const flashRef = useRef<HTMLSpanElement | null>(null);
    const shown = known && !allPending;
    usePriceFlash(flashRef, shown && Number.isFinite(summary.pnl) ? summary.pnl : null, { enabled: shown, masked: privMoney });
    return (
        <GroupedSection testId='position-summary'>
            <div className={compact ? styles.summaryTight : styles.summary}>
                <div>
                    <p className={styles.summaryCaption}>未實現淨損益合計（估）</p>
                    <div className={styles.summaryMain}>
                        <span className={`${compact ? styles.summaryValueTight : styles.summaryValue} ${flash.host}`}>
                            <span ref={flashRef} className={flash.overlay} aria-hidden='true' />
                            <span className={styles.tone[shown ? tone(summary.pnl) : 'flat']} data-testid='position-total'>
                                {shown ? maskMoney(fmtSigned(summary.pnl, 0), privMoney) : '—'}
                            </span>
                        </span>
                        {shown && summary.pnlPct !== null && (
                            <span className={`${styles.summaryPct} ${styles.tone[tone(summary.pnlPct)]}`} data-testid='position-total-pct'>（{fmtPct(summary.pnlPct)}）</span>
                        )}
                    </div>
                    {known && pending > 0 && (
                        <p className={styles.summaryNote} data-testid='position-total-pending'>合計待確認：{pending} 筆無法計算淨損益，未計入</p>
                    )}
                    {known && derivGross && (
                        <p className={styles.summaryNote} data-testid='position-total-deriv'>期貨／選擇權以券商損益計，未扣費稅</p>
                    )}
                </div>
                {(value || risk) && (
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
                                    <dd className={styles.summaryItemValue}>
                                        <span data-testid='position-risk'>
                                            {risk.risk === null ? '—' : `${risk.risk.toFixed(0)}%（${RISK_LEVEL_TEXT[risk.level!]}）`}
                                        </span>
                                        {risk.risk !== null && risk.level && (
                                            <span className={styles.riskBar}>
                                                <ProgressBar percent={(risk.risk / RISK_BAR_FULL_PCT) * 100} tone={RISK_TONE[risk.level]} testId='position-risk-bar' />
                                            </span>
                                        )}
                                    </dd>
                                </div>
                            </>
                        )}
                    </dl>
                )}
                {risk && risk.risk === null && (
                    <p className={styles.summaryNote} data-testid='position-risk-note'>沒有原始保證金（模擬環境或未持有期權部位）時，風險指標無意義，顯示「—」。</p>
                )}
                {/* 篩選範圍有列但沒有股票列（只看期貨）時不顯示證券額度 */}
                {!(summary.count > 0 && !value) && <TodayLimitsLine privMoney={privMoney} account={limitsAccount} />}
            </div>
        </GroupedSection>
    );
}
