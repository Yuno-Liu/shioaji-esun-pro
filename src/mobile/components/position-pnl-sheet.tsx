// src/mobile/components/position-pnl-sheet.tsx — 持倉淨損益與損益兩平價的標示文字與計算明細面板
//
// - 標示（持倉列「損益兩平」列與明細面板共用）：手續費以 X 折計、當沖稅率 0.15%、未判斷當沖、估算、未含融資利息、融資利息估算。
// - 融資利息說明：計到以現價賣出的交割日（T+2，週末順延、未計國定假日）；分批缺價（均價估算）、缺股數（未含）如實標示。
// - 明細面板（點持倉列的「損益兩平」開啟；只讀，沒有任何下單入口）：成本、買進手續費、預估賣出手續費、
//   稅率與稅額、借券費、融資利息、兩平價；估算的項目逐一標示。金額與股數遵守遮蔽金額（maskMoney）。
// 計算本身在 lib/position-pnl（純函式）；這裡只負責呈現。

import { maskMoney } from '../../lib/privacy';
import { discountText, percentText } from '../../lib/trading-cost-settings';
import type { ContractInfo } from '../../lib/types/contract';
import { fmtInt, fmtSigned } from '../../lib/utils/format';
import { formatToTick } from '../../lib/utils/ticksize';
import type { StockPnl } from '../lib/position-pnl';
import { breakEvenRelation } from '../lib/position-pnl';
import * as styles from '../styles/positions.css';
import { BottomSheet } from './bottom-sheet';

export const PNL_TEXT = {
    netLabel: '淨損益',
    brokerLabel: '券商',
    breakEven: '損益兩平',
    estimated: '估算',
    dayTradeUnknown: '未判斷當沖',
    dayTradeClosed: '今日已收盤・一般稅率',
    dayShortUncovered: '當沖空單未回補',
    noInterest: '未含融資利息',
    interestEstimated: '融資利息估算',
    derivNote: '券商損益・未扣費稅',
    totalPending: '合計待確認',
    settingsHint: '折數、退佣方式、融資年利率、借券費率可在「帳戶 → 交易成本」設定。',
} as const;

/** 「手續費以 X 折計」；無折扣時寫明以牌告計 */
export function feeDiscountTag(discount: number): string {
    return discount < 1 ? `手續費以 ${discountText(discount)} 折計` : '手續費以牌告計（無折扣）';
}

/** 持倉列的標示（文字，不靠顏色） */
export function pnlTags(pnl: StockPnl): string[] {
    const tags = [feeDiscountTag(pnl.feeDiscount)];
    if (pnl.dayTrade === 'applied') tags.push(`當沖稅率 ${percentText(pnl.dayTradeRate)}%`);
    if (pnl.dayTrade === 'unknown') tags.push(PNL_TEXT.dayTradeUnknown);
    if (pnl.dayTrade === 'closed') tags.push(PNL_TEXT.dayTradeClosed);
    if (pnl.dayTrade === 'uncovered') tags.push(PNL_TEXT.dayShortUncovered);
    if (pnl.interestStatus === 'noRate' || pnl.interestStatus === 'noDate' || pnl.interestStatus === 'incomplete') tags.push(PNL_TEXT.noInterest);
    if (pnl.interestStatus === 'estimated') tags.push(PNL_TEXT.interestEstimated);
    if (pnl.openFeeEstimated || (pnl.side === 'short' && pnl.openTaxEstimated)) tags.push(PNL_TEXT.estimated);
    return tags;
}

/** 現價與兩平價的關係文字；無法比較回 null */
export function breakEvenRelationText(pnl: StockPnl, last: number | null | undefined): string | null {
    const rel = breakEvenRelation(pnl, last);
    if (rel === null) return null;
    if (rel === 'even') return '現價等於兩平價';
    const above = (pnl.side === 'long') === (rel === 'profit');
    return `現價${above ? '高於' : '低於'}兩平價・${rel === 'profit' ? '已過兩平' : '未達兩平'}`;
}

/** 證交稅率說明（含當沖股數） */
export function taxRateText(pnl: StockPnl, privMoney: boolean): string {
    const normal = pnl.shares - pnl.dayTradeShares;
    if (pnl.dayTradeShares <= 0) return `${percentText(pnl.taxRate)}%`;
    const sh = (n: number) => maskMoney(`${fmtInt(n)} 股`, privMoney);
    if (normal <= 0) return `當沖 ${percentText(pnl.dayTradeRate)}%`;
    return `當沖 ${percentText(pnl.dayTradeRate)}% × ${sh(pnl.dayTradeShares)}＋${percentText(pnl.taxRate)}% × ${sh(normal)}`;
}

const DAY_TRADE_NOTE: Record<StockPnl['dayTrade'], string | null> = {
    applied: '今天買進（或當沖先賣）的股數，假設今天收盤（13:30）前賣出（回補）時適用現股當沖減半稅率（證券交易稅條例第 2 條之 1，至 2027-12-31）。',
    none: '今天沒有尚未沖銷的買進，賣出以一般稅率計。',
    closed: '今日已收盤（13:30 後），今天買進的股數最早下一個交易日才能賣出，不適用當沖減半，以一般稅率計。',
    uncovered: '今日已收盤（13:30 後）仍未回補的現股當沖賣出，不適用當沖減半，賣出稅以一般稅率估算；未回補部分由券商依規定處理（可能產生券差），實際以券商為準。',
    unknown: '取不到成交日，無法判斷是否為當沖，賣出一律以一般稅率計（未判斷當沖）。',
    noDayTrade: '此股票目前不可當沖，賣出以一般稅率計。',
    notReduced: 'ETF、權證、債券 ETF 不適用當沖減半（或減半期間已結束），以一般稅率計。',
    na: '融資、融券（資券當沖）不適用現股當沖減半，以一般稅率計。',
};

/** 退佣方式說明：月退的最低手續費也會退佣，成交即折的最低手續費不再打折 */
export function rebateNote(pnl: Pick<StockPnl, 'rebateMode' | 'feeDiscount'>): string {
    if (pnl.feeDiscount >= 1) return '';
    return pnl.rebateMode === 'monthly'
        ? '月退：交割時以牌告收取（最低 20 元），上列為退佣後的淨額（最低手續費也會退佣）。'
        : '成交即折：交割時直接以折扣後收取，最低 20 元不再打折。';
}

const INTEREST_TEXT: Record<StockPnl['interestStatus'], string> = {
    included: '',
    estimated: '',
    incomplete: '分批明細缺股數，未含融資利息',
    noRate: '未設定融資年利率，未含融資利息',
    noDate: '取不到成交日，未含融資利息',
    na: '',
};

const INTEREST_GAP_TEXT: Record<StockPnl['interestGaps'][number], string> = {
    missingPrice: '部分分批缺成交價，該批以持倉均價估算融資金額。',
    sharesMismatch: '分批明細的股數合計與持倉股數不同，利息依分批明細估算。',
};

/** 融資利息的計算說明（含計息終點與國定假日的限制）；不適用回 null */
export function interestNote(pnl: Pick<StockPnl, 'kind' | 'interestStatus' | 'interestGaps' | 'interestUntil'>, total: string): string | null {
    if (pnl.kind !== 'margin') return null;
    if (pnl.interestStatus === 'included' || pnl.interestStatus === 'estimated') {
        const gaps = pnl.interestGaps.map(g => INTEREST_GAP_TEXT[g]).join('');
        return `融資利息 ≈ 融資金額（上市 6 成、上櫃 5 成）× 年利率 × 天數 ÷ 365；天數自各批買進交割日計到以現價賣出的交割日 ${pnl.interestUntil ?? '—'}`
            + `（T+2；營業日以週一至週五推算、週末順延，未計國定假日，遇假日實際天數會較多）；合計 ${total}。${gaps}`;
    }
    if (pnl.interestStatus === 'incomplete') return '分批明細有批次缺股數，無法得知融資金額，淨損益與兩平價未含融資利息。';
    return null;
}

function Item({ label, value, testId, className }: { label: string; value: string; testId?: string; className?: string }) {
    return (
        <div className={styles.detailItem}>
            <dt className={styles.detailLabel}>{label}</dt>
            <dd className={`${styles.detailValue}${className ? ` ${className}` : ''}`} data-testid={testId}>{value}</dd>
        </div>
    );
}

const toneOf = (v: number | null): 'up' | 'down' | 'flat' => (v === null || v === 0 ? 'flat' : v > 0 ? 'up' : 'down');

export interface PositionPnlSheetProps {
    /** 標題列：代碼、名稱、條件、方向與數量（已遮蔽） */
    summary: string;
    pnl: StockPnl;
    contract: Pick<ContractInfo, 'code' | 'security_type' | 'exchange' | 'target_code'>;
    /** 券商原始損益 */
    brokerPnl: number;
    privMoney: boolean;
    onClose: () => void;
}

export function PositionPnlSheet({ summary, pnl, contract, brokerPnl, privMoney, onClose }: PositionPnlSheetProps) {
    const money = (v: number | null) => maskMoney(v === null ? '—' : fmtInt(v), privMoney);
    const signed = (v: number | null) => maskMoney(v === null ? '—' : fmtSigned(v, 0), privMoney);
    const est = (estimated: boolean) => (estimated ? `（${PNL_TEXT.estimated}）` : '（券商明細）');
    const long = pnl.side === 'long';
    const be = pnl.breakEven === null ? '—' : formatToTick(contract, pnl.breakEven);
    const relation = breakEvenRelationText(pnl, pnl.close?.price);
    const counted = pnl.interestStatus === 'included' || pnl.interestStatus === 'estimated';
    const interestText = interestNote(pnl, money(pnl.interest ?? 0));
    return (
        <BottomSheet open onClose={onClose} title='損益計算明細' testId='position-pnl-sheet'>
            <div className={styles.sheetBody}>
                <p className={styles.sheetSummary}>{summary}</p>
                <ul className={styles.pnlTagList} aria-label='計算依據'>
                    {pnlTags(pnl).map(t => <li key={t} className={styles.tag}>{t}</li>)}
                </ul>

                <h3 className={styles.detailTitle}>{long ? '買進成本' : '開倉賣出（已發生）'}</h3>
                <dl className={styles.detailGrid}>
                    <Item label={long ? '買進價金' : '賣出價金'} value={money(pnl.openNotional)} />
                    <Item label={`${long ? '買進' : '賣出'}手續費${est(pnl.openFeeEstimated)}`} value={money(pnl.openFee)} testId='pnl-open-fee' />
                    {!long && <Item label={`賣出證交稅${est(pnl.openTaxEstimated)}`} value={money(pnl.openTax)} />}
                    {!long && <Item label='證交稅率' value={taxRateText(pnl, privMoney)} />}
                    {pnl.borrowFee !== null && <Item label='借券費（估算）' value={money(pnl.borrowFee)} testId='pnl-borrow-fee' />}
                    {pnl.kind === 'margin' && (
                        <Item
                            label={counted ? '融資利息（估算）' : '融資利息'}
                            value={counted ? money(pnl.interest) : INTEREST_TEXT[pnl.interestStatus]}
                            testId='pnl-interest'
                        />
                    )}
                    <Item
                        label={long ? '成本（價金＋手續費）' : '賣出淨額（價金 − 手續費 − 稅）'}
                        value={money(pnl.basis)}
                        testId='pnl-basis'
                    />
                </dl>

                <h3 className={styles.detailTitle}>{long ? '以現價賣出（預估）' : '以現價回補（預估）'}</h3>
                {pnl.close ? (
                    <dl className={styles.detailGrid}>
                        <Item label={long ? '賣出價金' : '回補價金'} value={money(pnl.close.notional)} />
                        <Item label={long ? '預估賣出手續費' : '預估回補手續費'} value={money(pnl.close.fee)} testId='pnl-close-fee' />
                        {long && <Item label='證交稅率' value={taxRateText(pnl, privMoney)} testId='pnl-tax-rate' />}
                        {long && <Item label='預估證交稅' value={money(pnl.close.tax)} testId='pnl-close-tax' />}
                        <Item label='淨損益' value={signed(pnl.net)} className={styles.tone[toneOf(pnl.net)]} testId='pnl-net' />
                        <Item label='券商損益（未依上列費稅）' value={signed(brokerPnl)} />
                    </dl>
                ) : (
                    <p className={styles.detailNote}>缺現價，暫時無法計算淨損益。</p>
                )}

                <h3 className={styles.detailTitle}>損益兩平價</h3>
                <dl className={styles.detailGrid}>
                    <Item label={long ? '賣出價 ≥ 此價位才不虧' : '回補價 ≤ 此價位才不虧'} value={be} testId='pnl-breakeven' />
                    {relation && <Item label='目前' value={relation} />}
                </dl>

                <ul className={styles.sheetList}>
                    <li>
                        手續費＝成交價金 × 0.1425% × {pnl.feeDiscount < 1 ? `${discountText(pnl.feeDiscount)} 折` : '無折扣'}，四捨五入到元；每筆委託最低整股 20 元、零股 1 元
                        （賣出時整張與零股各算一筆）。{rebateNote(pnl)}
                    </li>
                    {DAY_TRADE_NOTE[pnl.dayTrade] && <li>{DAY_TRADE_NOTE[pnl.dayTrade]}</li>}
                    {pnl.borrowFee !== null && <li>借券費＝賣出價金 × 設定的借券費率；實際以券商收取為準。</li>}
                    {interestText && <li data-testid='pnl-interest-note'>{interestText}</li>}
                    <li>兩平價取到合法跳動價位，並已驗證{long ? '前一檔' : '後一檔'}會虧損。實際損益以券商交割為準。</li>
                </ul>
                <p className={styles.detailNote}>{PNL_TEXT.settingsHint}</p>
            </div>
        </BottomSheet>
    );
}
