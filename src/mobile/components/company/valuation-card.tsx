// src/mobile/components/company/valuation-card.tsx — 財務子分頁頂部的「估值與體質」卡（給長線投資者）
//
// ┌ 估值與體質                                         ［快取］［官方資料 · 日期］
// │ 指標 2×2：股價淨值比（＋每股淨值）、負債比、盈餘品質（＋文字結論）、累計 EPS（＋去年同期）
// │ 盈餘品質說明：近四季營業現金流合計 X 億元，高於／低於淨利合計 Y 億元
// │ 獲利金額表：近 8 季營收、毛利、營業利益、淨利（億元，單季；新到舊）
// └ 計算方式與來源
//
// - 放在財務子分頁頂部（不放概覽 KPI 旁）：數字都來自同一份財報檔，與月營收、季度財報同一處讀；概覽是業務與研究內容，
//   且 KPI 在每筆成交都重繪的 SummaryCard 內，四格以外再加會拉長所有子分頁共用的標頭。
// - 計算在 valuation.ts（純函式）；缺資料或分母不為正時顯示「—」＋簡短原因，不推估。
// - 即時價只在 P/B 這一格訂閱（live-price.ts，同標頭的同一檔 refcount，不新增訂閱）；其餘以 useMemo 只在財報檔改變時重算，
//   成交時只重繪 P/B 格。分頁隱藏（active=false）時不隨成交重繪。
// - 公開財報數字不是使用者資產，不遮蔽金額。只顯示，沒有任何按鈕或送單入口（S1）。

import { memo, useMemo, type ReactNode } from 'react';
import type { CompanyDataView } from '../../../hooks/use-company-data';
import type { QuarterMetrics } from '../../../lib/company-data';
import type { ContractInfo } from '../../../lib/types/contract';
import * as s from '../../styles/company.css';
import { fmtGrowth, fmtRatio } from './company-format';
import { Card, OfficialTag, StaleTag } from './company-sections';
import { useLivePrice } from './live-price';
import { buildValuation, fmtYi, priceToBook, VERDICT_TEXT, type EarningsQuality, type ProfitTrend, type YtdEps } from './valuation';

export const VALUATION_METHOD_NOTE =
    '股價淨值比＝股價 ÷ 最新一季每股參考淨值（有成交用即時價，否則用收盤）；負債比＝負債總計 ÷ 資產總計；'
    + '盈餘品質＝近四季營業現金流合計 ÷ 近四季淨利合計，大於 1 表示現金流高於淨利；淨利為歸屬母公司業主；來源同季度財報';

function Metric({ id, label, value, sub }: { id: string; label: string; value: string; sub: ReactNode }) {
    return (
        <div className={s.kpi} data-testid={`company-valuation-${id}`}>
            <dt className={s.kpiLabel}>{label}</dt>
            <dd className={s.kpiValue} style={{ margin: 0 }}>{value}</dd>
            <dd className={s.kpiSub} style={{ margin: 0 }}>{sub}</dd>
        </div>
    );
}

/** P/B：本卡唯一跟著成交重繪的格 */
const PbMetric = memo(function PbMetric({ view, contract, viaUnderlying, active, latest }: {
    view: CompanyDataView;
    contract: ContractInfo;
    viaUnderlying: boolean;
    active: boolean;
    latest: QuarterMetrics | undefined;
}) {
    const live = useLivePrice(contract, !viaUnderlying, active, view.company.code, view.market);
    const r = priceToBook(live.price, latest);
    const parts: string[] = [];
    if (r.reason) parts.push(r.reason);
    if (r.bookValuePerShare !== null) parts.push(`每股淨值 ${r.bookValuePerShare.toFixed(2)}（${r.period}）`);
    if (r.pb !== null) {
        parts.push(live.closeDate === null ? '即時價' : `收盤 ${live.closeDate}${view.marketMeta?.stale ? ' · 快取' : ''}`);
    }
    return <Metric id='pb' label='股價淨值比' value={r.pb !== null ? `${r.pb.toFixed(2)} 倍` : '—'} sub={parts.join(' · ')} />;
});

function qualitySub(q: EarningsQuality): string {
    if (q.verdict === null) return q.reason ?? '—';
    return q.reason ? `${q.reason}；${VERDICT_TEXT[q.verdict]}` : VERDICT_TEXT[q.verdict];
}

function ytdSub(y: YtdEps): string {
    if (y.reason) return y.reason;
    const parts = [y.label ?? ''];
    if (y.prev !== null) parts.push(`去年同期 ${y.prev.toFixed(2)}${y.growthPct !== null ? `，年增 ${fmtGrowth(y.growthPct)}` : ''}`);
    if (y.prevReason) parts.push(y.prevReason);
    return parts.filter(Boolean).join(' · ');
}

function QualityDetail({ q }: { q: EarningsQuality }) {
    if (q.cashFlowYi === null || q.netIncomeYi === null || q.verdict === null) return null;
    const relation = q.verdict === 'above' ? '高於' : q.verdict === 'below' ? '低於' : '等於';
    return (
        <p className={s.valuationNote} data-testid='company-valuation-quality-detail'>
            近四季（{q.from}–{q.to}）營業現金流合計 {fmtYi(q.cashFlowYi)} 億元，{relation}淨利合計 {fmtYi(q.netIncomeYi)} 億元
        </p>
    );
}

function ProfitTable({ trend }: { trend: ProfitTrend }) {
    if (trend.rows.length === 0) return <span className={s.muted} data-testid='company-profit-empty'>沒有季報資料</span>;
    const { hasGross, hasOperating } = trend;
    return (
        <div className={s.tableScroll}>
            <table className={s.table} data-testid='company-profit-table'>
                <caption className={s.tableCaption}>獲利金額趨勢（單季，億元；近 {trend.rows.length} 季）</caption>
                <thead>
                    <tr>
                        <th scope='col'>季別</th>
                        <th scope='col'>營收</th>
                        {hasGross && <th scope='col'>毛利</th>}
                        {hasOperating && <th scope='col'>營業利益</th>}
                        <th scope='col'>淨利</th>
                    </tr>
                </thead>
                <tbody>
                    {trend.rows.map(r => (
                        <tr key={r.period}>
                            <td>{r.period}</td>
                            <td>{fmtYi(r.revenueYi)}</td>
                            {hasGross && <td>{fmtYi(r.grossProfitYi)}</td>}
                            {hasOperating && <td>{fmtYi(r.operatingIncomeYi)}</td>}
                            <td>{fmtYi(r.netIncomeYi)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export const ValuationCard = memo(function ValuationCard({ view, contract, viaUnderlying, active }: {
    view: CompanyDataView;
    contract: ContractInfo;
    viaUnderlying: boolean;
    active: boolean;
}) {
    const fin = view.financials;
    const v = useMemo(() => (fin ? buildValuation(fin) : null), [fin]);
    if (!v) return null;
    const { debt, quality, ytd } = v;
    return (
        <Card
            title='估值與體質'
            testId='company-valuation'
            meta={<><StaleTag meta={view.financialsMeta} /><OfficialTag date={view.financialsMeta?.asOf} testId='company-valuation-official' /></>}
        >
            <dl className={s.kpis} data-testid='company-valuation-kpis'>
                <PbMetric view={view} contract={contract} viaUnderlying={viaUnderlying} active={active} latest={v.latest} />
                <Metric id='debt' label='負債比' value={fmtRatio(debt.pct)} sub={debt.reason ?? `${debt.period} 負債 ÷ 資產`} />
                <Metric
                    id='quality'
                    label='盈餘品質'
                    value={quality.ratio !== null ? `${quality.ratio.toFixed(2)} 倍` : '—'}
                    sub={qualitySub(quality)}
                />
                <Metric id='ytd-eps' label='累計 EPS' value={ytd.value !== null ? `${ytd.value.toFixed(2)} 元` : '—'} sub={ytdSub(ytd)} />
            </dl>
            <QualityDetail q={quality} />
            <ProfitTable trend={v.trend} />
            <p className={s.footnote} data-testid='company-valuation-source'>{VALUATION_METHOD_NOTE}</p>
        </Card>
    );
});
