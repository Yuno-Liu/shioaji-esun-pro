// src/mobile/components/position-esun-details.tsx — 玉山股票持倉的庫存明細（持倉卡片展開區）
//
// 資料只讀：庫存明細 store（lib/esun/account-details，玉山持倉查詢時同一次 get_inventories 寫入；持倉頁「⟳」會更新）。
// 推導與估算沿用桌面 esun-position-details 匯出的純函式：
// - esunCashCostBreakdown：現股成本推導（價金＋買進手續費＝成本；市值−預估賣出費稅＝未實現收入；收入−成本＝損益），
//   與券商數字相差超過 1 元或缺值時只列各欄位；
// - esunCashRebate：現股月退的預估退佣（標示「估」）；
// - esunMarginLotEstimates：融資金額與利息（估）；
// - 借券費（估）＝價金 × 借券費率（shortSellingFee）。
// 估算參數來自交易成本設定（玉山的折數與退佣方式：useBrokerCostSettings().esun；融資年利率、借券費率共用）；金額與股數用 maskMoney 遮蔽。
// 版面（設計規格 §7.7）：中性島（islandBg）內呈現；持倉列按「庫存明細」立即展開、內容 150ms 淡入（只動畫 opacity，減少動態時不動畫）。

import {
    esunCashCostBreakdown,
    esunCashRebate,
    esunMarginLotEstimates,
} from '../../components/esun-position-details';
import {
    esunInventoryApCodeLabel,
    esunMarketLabel,
    esunTradeTypeLabel,
    findEsunInventoryDetail,
    useEsunInventoryDetails,
    type EsunInventoryDetail,
} from '../../lib/esun/account-details';
import { maskMoney, usePrivacyMoney } from '../../lib/privacy';
import { discountText, percentText, shortSellingFee, type TradingCostSettings } from '../../lib/trading-cost-settings';
import type { AccountedPosition, StockPosition } from '../../lib/types/portfolio';
import { todayStr } from '../../lib/utils/date';
import { fmtPct, fmtPrice, fmtSigned } from '../../lib/utils/format';
import { useBrokerCostSettings } from '../lib/broker-cost-settings';
import { fmtInt } from '../lib/num-format';
import { taipeiClock } from '../lib/taipei-clock';
import * as styles from '../styles/positions.css';

export const ESUN_DETAIL_TEXT = {
    noSnapshot: '尚無玉山庫存明細：請按上方「⟳」更新持倉（帳務）後再看。',
    noMatch: '庫存明細與這筆持倉對不上（可能是之後有成交或明細尚未更新），請按上方「⟳」更新持倉（帳務）。',
    snapshotNote: '持倉列的現價與損益是即時行情推估；這裡是券商查詢當下的數值。',
    costSettingsHint: '估算參數（折數、退佣方式、融資年利率、借券費率）可在「帳戶 → 交易成本」設定。',
} as const;

type EsunStockRow = StockPosition & { account?: AccountedPosition['account'] };


/** 全部有值才加總；空陣列或任一筆缺值 → null */
function sumOrNull(values: readonly (number | null)[]): number | null {
    if (values.length === 0 || values.some(v => v === null)) return null;
    return (values as number[]).reduce((s, v) => s + v, 0);
}

const toneOf = (v: number | null): 'up' | 'down' | 'flat' => (v === null || v === 0 ? 'flat' : v > 0 ? 'up' : 'down');

function Item({ label, value, className, testId }: { label: string; value: string; className?: string; testId?: string }) {
    return (
        <div className={styles.detailItem}>
            <dt className={styles.detailLabel}>{label}</dt>
            <dd className={`${styles.detailValue}${className ? ` ${className}` : ''}`} data-testid={testId}>{value}</dd>
        </div>
    );
}

export function PositionEsunDetails({ position }: { position: EsunStockRow }) {
    const snapshot = useEsunInventoryDetails(position.account);
    const privMoney = usePrivacyMoney();
    const settings = useBrokerCostSettings().esun;
    if (!snapshot) return <p className={styles.detailEmpty} data-testid='esun-detail-empty'>{ESUN_DETAIL_TEXT.noSnapshot}</p>;
    const detail = findEsunInventoryDetail(snapshot.details, position);
    if (!detail) return <p className={styles.detailEmpty} data-testid='esun-detail-empty'>{ESUN_DETAIL_TEXT.noMatch}</p>;
    return <EsunDetailBody detail={detail} fetchedAt={snapshot.fetchedAt} privMoney={privMoney} settings={settings} />;
}

function EsunDetailBody({ detail, fetchedAt, privMoney, settings }: {
    detail: EsunInventoryDetail;
    fetchedAt: number;
    privMoney: boolean;
    settings: TradingCostSettings;
}) {
    const m = (text: string) => maskMoney(text, privMoney);
    const money = (v: number | null) => m(v === null ? '—' : fmtInt(v));
    const signed = (v: number | null) => m(v === null ? '—' : fmtSigned(v, 0));
    const price = (v: number | null) => m(fmtPrice(v ?? undefined));
    const shares = (v: number | null) => m(v === null ? '—' : `${fmtInt(v)} 股`);
    const approx = (text: string) => (text === '—' || text === '•••••' ? text : `≈ ${text}`);

    const isCash = detail.tradeType === '0';
    const isMargin = detail.tradeType === '3';
    const isShort = detail.tradeType === '4';
    const cost = esunCashCostBreakdown(detail);
    const rebate = isCash ? esunCashRebate(detail, settings) : null;
    const marginLots = isMargin ? esunMarginLotEstimates(detail, settings, todayStr()) : [];
    const counted = marginLots.filter(e => e.financed !== null);
    const marginRateSet = settings.marginAnnualRate !== null;
    const financedTotal = counted.length ? sumOrNull(counted.map(e => e.financed)) : null;
    const interestTotal = marginRateSet && counted.length ? sumOrNull(counted.map(e => e.interest)) : null;
    const shortNotional = isShort && detail.priceQtySum !== null ? Math.abs(detail.priceQtySum) : null;
    const shortFee = shortNotional === null ? null : shortSellingFee(shortNotional * 100, settings);

    return (
        <div className={styles.detail} data-testid='esun-detail'>
            <div className={styles.detailHead}>
                <span className={styles.tag}>{esunMarketLabel(detail.marketCode) || '市場別未知'}</span>
                <span className={styles.tag}>{esunTradeTypeLabel(detail.tradeType) || '交易類別未知'}</span>
                <span className={styles.tag}>{esunInventoryApCodeLabel(detail.apCode)}</span>
                <span className={styles.detailNote}>券商快照 {taipeiClock(fetchedAt)}</span>
            </div>
            <p className={styles.detailNote}>{ESUN_DETAIL_TEXT.snapshotNote}</p>

            <h3 className={styles.detailTitle}>數量與價格</h3>
            <dl className={styles.detailGrid}>
                <Item label='成本股數' value={shares(detail.costShares)} />
                <Item label='昨餘股數' value={shares(detail.yesterdayShares)} />
                <Item label='今委買／成交' value={m(`${detail.todayBuyShares === null ? '—' : fmtInt(detail.todayBuyShares)} / ${detail.todayBuyFilledShares === null ? '—' : fmtInt(detail.todayBuyFilledShares)} 股`)} />
                <Item label='今委賣／成交' value={m(`${detail.todaySellShares === null ? '—' : fmtInt(detail.todaySellShares)} / ${detail.todaySellFilledShares === null ? '—' : fmtInt(detail.todaySellFilledShares)} 股`)} />
                <Item label='成交均價' value={price(detail.avgPrice)} />
                <Item label='損益平衡價' value={price(detail.breakEvenPrice)} testId='esun-detail-breakeven' />
                <Item label='即時價（券商）' value={fmtPrice(detail.marketPrice ?? undefined)} />
            </dl>

            <h3 className={styles.detailTitle}>成本推導</h3>
            {isCash && cost.derivable ? (
                <ol className={styles.formulaList} data-testid='esun-detail-formula'>
                    <li>價金 {money(detail.priceQtySum)} ＋ 買進手續費 {money(cost.buyFee)} ＝ <strong>成本 {money(cost.costTotal)}</strong></li>
                    <li>市值 {money(detail.marketValue)} − 預估賣出費稅 {money(cost.sellCost)} ＝ <strong>未實現收入 {money(detail.unrealizedIncome)}</strong></li>
                    <li>
                        未實現收入 {money(detail.unrealizedIncome)} − 成本 {money(cost.costTotal)} ＝{' '}
                        <strong className={styles.tone[toneOf(detail.unrealizedPnl)]}>未實現損益 {signed(detail.unrealizedPnl)}</strong>
                    </li>
                </ol>
            ) : (
                <dl className={styles.detailGrid}>
                    <Item label='價金總計' value={money(detail.priceQtySum)} />
                    <Item label={isCash ? '買進手續費（明細合計）' : '手續費（明細合計）'} value={money(cost.buyFee)} />
                    <Item label='成本總計' value={money(isCash ? cost.costTotal : detail.costSum)} />
                    <Item label='市值' value={money(detail.marketValue)} />
                    {isCash && <Item label='預估賣出費稅' value={money(cost.sellCost)} />}
                    <Item label='未實現收入' value={money(detail.unrealizedIncome)} />
                    <Item label='未實現損益' value={signed(detail.unrealizedPnl)} className={styles.tone[toneOf(detail.unrealizedPnl)]} />
                </dl>
            )}
            {isCash && !cost.derivable && (
                <p className={styles.detailNote}>{cost.complete ? '券商數字與推導相差超過 1 元，僅列各欄位。' : '部分欄位缺值，僅列各欄位。'}</p>
            )}
            {!isCash && <p className={styles.detailNote}>融資、融券的成本與收入定義和現股不同，僅列券商欄位。</p>}
            <dl className={styles.detailGrid}>
                {isCash && cost.derivable && <Item label='交易成本合計（已付手續費＋預估賣出費稅）' value={money(cost.totalCost)} />}
                <Item
                    label='券商未實現獲利率'
                    value={fmtPct(detail.unrealizedPnlPct ?? undefined)}
                    className={styles.tone[toneOf(detail.unrealizedPnlPct)]}
                />
            </dl>

            {rebate && (
                <>
                    <h3 className={styles.detailTitle}>預估退佣（估）</h3>
                    <dl className={styles.detailGrid}>
                        <Item label={`預估退佣（月退 ${discountText(settings.feeDiscount)} 折）`} value={approx(money(rebate.rebate))} testId='esun-detail-rebate' />
                        <Item label='含退佣未實現損益（估）' value={approx(signed(rebate.pnlWithRebate))} className={styles.tone[toneOf(rebate.pnlWithRebate)]} />
                    </dl>
                    <p className={styles.detailNote}>買進手續費與預估賣出手續費（市值 × 0.1425%）各乘 (1 − 折數)；實際退佣以券商入帳為準。</p>
                </>
            )}
            {isMargin && (
                <>
                    <h3 className={styles.detailTitle}>融資利息（估）</h3>
                    <dl className={styles.detailGrid}>
                        <Item label='融資金額合計（估）' value={approx(money(financedTotal))} />
                        <Item label='預估融資利息合計' value={approx(money(interestTotal))} testId='esun-detail-interest' />
                    </dl>
                    <p className={styles.detailNote}>
                        {marginRateSet
                            ? `融資金額 ≈ 各筆價金 × 成數（上市 6 成、上櫃 5 成，千元以下捨去）；利息 ≈ 融資金額 × 年利率 ${percentText(settings.marginAnnualRate!)}% × 天數 ÷ 365（天數自成交日後第 2 個營業日起算，未計國定假日）。以券商計算為準。`
                            : '未設定融資年利率，無法估算利息。'}
                    </p>
                </>
            )}
            {isShort && (
                <>
                    <h3 className={styles.detailTitle}>借券費（估）</h3>
                    <dl className={styles.detailGrid}>
                        <Item label='借券費（估）' value={approx(money(shortFee))} testId='esun-detail-short-fee' />
                    </dl>
                    <p className={styles.detailNote}>借券費 ≈ 賣出價金 × 借券費率 {percentText(settings.shortFeeRate)}%（實際以券商收取為準）。</p>
                </>
            )}

            {detail.lots.length > 0 && (
                <>
                    <h3 className={styles.detailTitle}>分批明細（{detail.lots.length} 筆）</h3>
                    <ul className={styles.lotList} data-testid='esun-detail-lots'>
                        {detail.lots.map((lot, idx) => {
                            const est = marginLots[idx];
                            return (
                                <li key={idx} className={styles.lot} data-testid='esun-detail-lot'>
                                    <div className={styles.lotHead}>
                                        <span>{`${lot.tradeDate} ${lot.tradeTime}`.trim() || '日期不明'}</span>
                                        <span className={lot.action === 'Buy' ? styles.lotSide.long : lot.action === 'Sell' ? styles.lotSide.short : undefined}>
                                            {lot.action === 'Buy' ? '買進' : lot.action === 'Sell' ? '賣出' : lot.buySell || '—'}
                                        </span>
                                    </div>
                                    <dl className={styles.detailGrid}>
                                        <Item label='股數' value={m(lot.shares === null ? '—' : fmtInt(lot.shares))} />
                                        <Item label='成交價' value={price(lot.price)} />
                                        <Item label='手續費' value={money(lot.fee)} />
                                        <Item label='交易稅' value={money(lot.tax)} />
                                        {lot.capitalGainsTax !== null && lot.capitalGainsTax !== 0 && <Item label='證所稅' value={money(lot.capitalGainsTax)} />}
                                        <Item label='損益平衡價' value={price(lot.breakEvenPrice)} />
                                        <Item label='未實現損益' value={signed(lot.unrealizedPnl)} className={styles.tone[toneOf(lot.unrealizedPnl)]} />
                                        {isMargin && est && <Item label='融資金額（估）' value={approx(money(est.financed))} />}
                                        {isMargin && est && <Item label='融資利息（估）' value={est.days === null ? '—' : `${approx(money(est.interest))}（${est.days} 天）`} />}
                                    </dl>
                                </li>
                            );
                        })}
                    </ul>
                </>
            )}
            <p className={styles.detailNote}>{ESUN_DETAIL_TEXT.costSettingsHint}</p>
        </div>
    );
}
