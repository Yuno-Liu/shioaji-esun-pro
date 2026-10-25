// src/components/esun-position-details.tsx — 玉山庫存明細（持倉列展開，fork 元件）
//
// 上游 bottom-dock-positions 只掛三個點：代碼旁的展開按鈕（toggle）、表格列下方的整寬明細列（row）、
// 窄版卡片內的明細區（card）。資料來自 account-details 的庫存明細 store（同一次 get_inventories 寫入），
// 只讀不查詢。玉山 qty_l 是券商權威資料，玉山列也不套用永豐的昨餘提示（yesterdayNotice）。

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
// 直接引用輕量子模組：'../lib/esun' 的 index 會帶進 service／帳戶 store，持倉表不需要
import {
    esunInventoryApCodeLabel,
    esunMarketLabel,
    esunTradeTypeLabel,
    findEsunInventoryDetail,
    useEsunInventoryDetails,
    type EsunInventoryDetail,
    type EsunInventoryLot,
} from '../lib/esun/account-details';
import { isEsunBroker } from '../lib/esun/order-mapping';
import { maskAccountId, maskMoney, usePrivacyMode, usePrivacyMoney } from '../lib/privacy';
import {
    discountText,
    feeRebate,
    hasMonthlyRebate,
    marginFinancing,
    marginInterest,
    marginInterestDays,
    percentText,
    shortSellingFee,
    useTradingCostSettings,
    type TradingCostSettings,
} from '../lib/trading-cost-settings';
import type { AccountedPosition, StockPosition } from '../lib/types/portfolio';
import { applyRateYuan, priceCents, STOCK_FEE_RATE } from '../lib/utils/contract-cost';
import { todayStr } from '../lib/utils/date';
import { fmtInt, fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
import * as panel from './panel.css';
import * as css from './esun-position-details.css';
import { isStockPosition } from './bottom-dock-shared';

type EsunStockPosition = StockPosition & { account?: AccountedPosition['account'] };

/** 玉山帳戶的股票持倉列才有庫存明細 */
export function isEsunStockPosition(p: AccountedPosition): p is EsunStockPosition {
    return isStockPosition(p) && isEsunBroker(p.account?.broker_id);
}

function expandKey(p: AccountedPosition): string {
    const acc = p.account ? `${p.account.broker_id}-${p.account.account_id}` : '';
    return `${acc}:${p.code}:${'cond' in p ? p.cond ?? '' : ''}:${p.id}`;
}

/** 推導與券商數字的容許誤差（元） */
const TOLERANCE = 1;

/** 全部有值才加總；空陣列或任一筆缺值 → null（不把缺值當成 0） */
function sumOrNull(values: readonly (number | null)[]): number | null {
    if (values.length === 0 || values.some(v => v === null)) return null;
    return (values as number[]).reduce((s, v) => s + v, 0);
}

function clock(ms: number): string {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '—';
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

const nonZero = (v: number | null): boolean => v !== null && v !== 0;
const dirClass = (v: number | null) => panel.dirText[v === null || v === 0 ? 'flat' : v > 0 ? 'up' : 'down'];

/** 現股成本推導；任一值缺漏或與券商數字差超過 1 元 → derivable=false */
export function esunCashCostBreakdown(detail: EsunInventoryDetail) {
    const buyFee = sumOrNull(detail.lots.map(l => l.fee));
    const costTotal = detail.costSum === null ? null : Math.abs(detail.costSum);
    const sellCost = detail.marketValue !== null && detail.unrealizedIncome !== null
        ? detail.marketValue - detail.unrealizedIncome
        : null;
    const totalCost = buyFee !== null && sellCost !== null ? buyFee + sellCost : null;
    const complete = detail.priceQtySum !== null && buyFee !== null && costTotal !== null
        && sellCost !== null && detail.unrealizedIncome !== null && detail.unrealizedPnl !== null;
    const consistent = complete
        && Math.abs(detail.priceQtySum! + buyFee! - costTotal!) <= TOLERANCE
        && Math.abs(detail.unrealizedIncome! - costTotal! - detail.unrealizedPnl!) <= TOLERANCE;
    return { buyFee, costTotal, sellCost, totalCost, complete, derivable: complete && consistent };
}

/**
 * 現股月退（折數 < 1）的預估退佣：Σ買進手續費 × (1 − 折數)＋預估賣出手續費 × (1 − 折數)，
 * 預估賣出手續費＝round(市值 × 0.1425%)。不適用（即折、無折扣、非現股）或缺值回 null。
 */
export function esunCashRebate(detail: EsunInventoryDetail, settings: TradingCostSettings) {
    if (detail.tradeType !== '0' || !hasMonthlyRebate(settings)) return null;
    const buyFee = sumOrNull(detail.lots.map(l => l.fee));
    if (buyFee === null || detail.marketValue === null) return null;
    const sellFee = applyRateYuan(Math.abs(detail.marketValue) * 100, STOCK_FEE_RATE);
    const buyRebate = feeRebate(buyFee, settings);
    const sellRebate = feeRebate(sellFee, settings);
    const rebate = buyRebate + sellRebate;
    const pnlWithRebate = detail.unrealizedPnl === null ? null : detail.unrealizedPnl + rebate;
    return { buyFee, sellFee, buyRebate, sellRebate, rebate, pnlWithRebate };
}

export interface EsunMarginLotEstimate {
    financed: number | null;
    days: number | null;
    interest: number | null;
}

/**
 * 融資部位逐筆估算：融資金額＝lot 價金 × 成數（依 detail.market），計息天數＝交割日（成交日後第 2 個
 * 週一至週五）到 today 的日曆天數；未設定年利率時 interest 為 null。賣出 lot 不計。
 */
export function esunMarginLotEstimates(detail: EsunInventoryDetail, settings: TradingCostSettings, today: string): EsunMarginLotEstimate[] {
    return detail.lots.map(lot => {
        if (lot.action === 'Sell' || lot.price === null || lot.shares === null) return { financed: null, days: null, interest: null };
        const financing = marginFinancing(priceCents(lot.price) * Math.abs(lot.shares), detail.market);
        const days = marginInterestDays(lot.tradeDate, today);
        const financed = financing?.financed ?? null;
        const interest = financed !== null && days !== null ? marginInterest(financed, days, settings) : null;
        return { financed, days, interest };
    });
}

function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
    return (
        <div className={css.row}>
            <span className={css.label}>{label}</span>
            <span className={`${css.value}${className ? ` ${className}` : ''}`}>{children}</span>
        </div>
    );
}

function Term({ label, value, result }: { label: string; value: string; result?: boolean }) {
    return (
        <span className={css.formulaTerm}>
            <span className={css.label}>{label}</span>
            <span className={result ? css.formulaResult : undefined}>{value}</span>
        </span>
    );
}

const Op = ({ children }: { children: string }) => <span className={css.formulaOp}>{children}</span>;

interface LotColumn {
    title: string;
    cell: (lot: EsunInventoryLot) => ReactNode;
    className?: (lot: EsunInventoryLot) => string | undefined;
}

/** 單一玉山持倉列的庫存明細 */
export function EsunPositionDetails({ position }: { position: EsunStockPosition }) {
    const snapshot = useEsunInventoryDetails(position.account);
    const detail = findEsunInventoryDetail(snapshot?.details, position);
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const costSettings = useTradingCostSettings();
    if (!snapshot || !detail) {
        return <div className={css.empty}>尚無玉山庫存明細，請更新帳務</div>;
    }

    const m = (text: string) => maskMoney(text, privMoney);
    const money = (v: number | null) => m(v === null ? '—' : fmtInt(v));
    const signed = (v: number | null) => m(v === null ? '—' : fmtSigned(v, 0));
    const price = (v: number | null) => m(fmtPrice(v ?? undefined));
    const shares = (v: number | null) => m(v === null ? '—' : `${fmtInt(v)} 股`);
    const pair = (a: number | null, b: number | null) =>
        m(`${a === null ? '—' : fmtInt(a)} / ${b === null ? '—' : fmtInt(b)} 股`);
    const pct = (v: number | null) => fmtPct(v ?? undefined);

    const isCash = detail.tradeType === '0';
    const cost = esunCashCostBreakdown(detail);
    const showAdjusted = detail.marketPriceAdjusted !== null && detail.marketPriceAdjusted !== detail.marketPrice;

    const lotColumns: LotColumn[] = [
        { title: '成交日期 時間', cell: l => `${l.tradeDate} ${l.tradeTime}`.trim() || '—' },
        { title: '買賣', cell: l => (l.action === 'Buy' ? '買' : l.action === 'Sell' ? '賣' : l.buySell || '—') },
        { title: '委託書號', cell: l => (l.orderNo ? maskAccountId(l.orderNo, priv) : '—') },
        { title: '成交價', cell: l => price(l.price) },
        { title: '股數', cell: l => m(l.shares === null ? '—' : fmtInt(l.shares)) },
        { title: '手續費', cell: l => money(l.fee) },
        { title: '交易稅', cell: l => money(l.tax) },
        { title: '證所稅', cell: l => money(l.capitalGainsTax) },
        { title: '淨收付', cell: l => money(l.netAmount) },
        { title: '損益平衡價', cell: l => price(l.breakEvenPrice) },
        { title: '市值', cell: l => money(l.marketValue) },
        { title: '未實現損益', cell: l => signed(l.unrealizedPnl), className: l => dirClass(l.unrealizedPnl) },
        { title: '獲利率', cell: l => pct(l.unrealizedPnlPct), className: l => dirClass(l.unrealizedPnlPct) },
    ];
    const optional: [string, (l: EsunInventoryLot) => number | null, (v: number | null) => string][] = [
        ['已分攤成本', l => l.allocatedCost, money],
        ['已分攤股數', l => l.allocatedShares, v => m(v === null ? '—' : fmtInt(v))],
        ['調整股數', l => l.adjustShares, v => m(v === null ? '—' : fmtInt(v))],
        ['實高權值', l => l.highWeightShares, v => m(v === null ? '—' : fmtInt(v))],
    ];
    for (const [title, get, fmt] of optional) {
        if (detail.lots.some(l => nonZero(get(l)))) lotColumns.push({ title, cell: l => fmt(get(l)) });
    }

    // ---- 依交易成本設定的估算（fork 設定：設定 → 風控 → 交易成本） ----
    const rebate = isCash ? esunCashRebate(detail, costSettings) : null;
    const isMargin = detail.tradeType === '3';
    const isShort = detail.tradeType === '4';
    const marginRateSet = costSettings.marginAnnualRate !== null;
    const marginLots = isMargin ? esunMarginLotEstimates(detail, costSettings, todayStr()) : [];
    const marginOf = new Map(detail.lots.map((l, i) => [l, marginLots[i]]));
    const counted = marginLots.filter(e => e.financed !== null);
    const financedTotal = counted.length ? sumOrNull(counted.map(e => e.financed)) : null;
    const interestTotal = marginRateSet && counted.length ? sumOrNull(counted.map(e => e.interest)) : null;
    if (isMargin) {
        lotColumns.push(
            { title: '融資金額（估）', cell: l => money(marginOf.get(l)?.financed ?? null) },
            { title: '計息天數（估）', cell: l => { const d = marginOf.get(l)?.days; return d === null || d === undefined ? '—' : `${d} 天`; } },
            { title: '預估融資利息', cell: l => money(marginOf.get(l)?.interest ?? null) },
        );
    }
    const shortNotional = isShort && detail.priceQtySum !== null ? Math.abs(detail.priceQtySum) : null;
    const shortFee = shortNotional === null ? null : shortSellingFee(shortNotional * 100, costSettings);
    const approx = (text: string) => (text === '—' ? text : `≈ ${text}`);

    return (
        <div className={css.wrap}>
            <div className={css.head}>
                <span className={css.tag}>{esunMarketLabel(detail.marketCode) || '市場別未知'}</span>
                <span className={css.tag}>{esunTradeTypeLabel(detail.tradeType) || '交易類別未知'}</span>
                <span className={css.tag}>{esunInventoryApCodeLabel(detail.apCode)}</span>
                <span className={css.snapshot}>券商快照 {clock(snapshot.fetchedAt)}</span>
                <span className={css.note}>
                    主列的現價與損益是即時行情；這裡是券商查詢當下的數值。
                </span>
            </div>

            <div className={css.sections}>
                <div className={css.section}>
                    <div className={css.sectionTitle}>數量</div>
                    <Row label='成本股數'>{shares(detail.costShares)}</Row>
                    <Row label='昨餘股數'>{shares(detail.yesterdayShares)}</Row>
                    <Row label='今委買／成交'>{pair(detail.todayBuyShares, detail.todayBuyFilledShares)}</Row>
                    <Row label='今委賣／成交'>{pair(detail.todaySellShares, detail.todaySellFilledShares)}</Row>
                    {nonZero(detail.adjustShares) && <Row label='調整股數'>{shares(detail.adjustShares)}</Row>}
                </div>

                <div className={css.section}>
                    <div className={css.sectionTitle}>價格</div>
                    <Row label='成交均價'>{price(detail.avgPrice)}</Row>
                    <Row label='損益平衡價'>{price(detail.breakEvenPrice)}</Row>
                    <Row label='即時價（無假除權息）'>{fmtPrice(detail.marketPrice ?? undefined)}</Row>
                    {showAdjusted && (
                        <Row label='即時價（有假除權息）'>{fmtPrice(detail.marketPriceAdjusted ?? undefined)}</Row>
                    )}
                </div>

                <div className={css.section}>
                    <div className={css.sectionTitle}>交易成本</div>
                    {isCash && cost.derivable ? (
                        <>
                            <div className={css.formula}>
                                <Term label='價金總計' value={money(detail.priceQtySum)} />
                                <Op>＋</Op>
                                <Term label='買進手續費' value={money(cost.buyFee)} />
                                <Op>＝</Op>
                                <Term label='成本總計' value={money(cost.costTotal)} result />
                            </div>
                            <div className={css.formula}>
                                <Term label='市值' value={money(detail.marketValue)} />
                                <Op>−</Op>
                                <Term label='預估賣出手續費及交易稅' value={money(cost.sellCost)} />
                                <Op>＝</Op>
                                <Term label='未實現收入' value={money(detail.unrealizedIncome)} result />
                            </div>
                            <div className={css.formula}>
                                <Term label='未實現收入' value={money(detail.unrealizedIncome)} />
                                <Op>−</Op>
                                <Term label='成本總計' value={money(cost.costTotal)} />
                                <Op>＝</Op>
                                <Term label='未實現損益' value={signed(detail.unrealizedPnl)} result />
                            </div>
                            <div className={css.rule} />
                            <Row label='交易成本合計（已付手續費＋預估賣出費稅）'>{money(cost.totalCost)}</Row>
                            <Row label='券商未實現獲利率' className={dirClass(detail.unrealizedPnlPct)}>
                                {pct(detail.unrealizedPnlPct)}
                            </Row>
                        </>
                    ) : isCash ? (
                        <>
                            <Row label='價金總計'>{money(detail.priceQtySum)}</Row>
                            <Row label='買進手續費（明細合計）'>{money(cost.buyFee)}</Row>
                            <Row label='成本總計'>{money(cost.costTotal)}</Row>
                            <Row label='市值'>{money(detail.marketValue)}</Row>
                            <Row label='預估賣出手續費及交易稅'>{money(cost.sellCost)}</Row>
                            <Row label='未實現收入'>{money(detail.unrealizedIncome)}</Row>
                            <Row label='未實現損益' className={dirClass(detail.unrealizedPnl)}>
                                {signed(detail.unrealizedPnl)}
                            </Row>
                            <Row label='交易成本合計（已付手續費＋預估賣出費稅）'>{money(cost.totalCost)}</Row>
                            <Row label='券商未實現獲利率' className={dirClass(detail.unrealizedPnlPct)}>
                                {pct(detail.unrealizedPnlPct)}
                            </Row>
                            <div className={css.note}>
                                {cost.complete
                                    ? '券商數字與推導相差超過 1 元，僅列各欄位。'
                                    : '部分欄位缺值，僅列各欄位。'}
                            </div>
                        </>
                    ) : (
                        <>
                            <Row label='價金總計'>{money(detail.priceQtySum)}</Row>
                            <Row label='成本總計'>{money(detail.costSum)}</Row>
                            <Row label='手續費（明細合計）'>{money(cost.buyFee)}</Row>
                            <Row label='市值'>{money(detail.marketValue)}</Row>
                            <Row label='未實現收入'>{money(detail.unrealizedIncome)}</Row>
                            <Row label='未實現損益' className={dirClass(detail.unrealizedPnl)}>
                                {signed(detail.unrealizedPnl)}
                            </Row>
                            <Row label='券商未實現獲利率' className={dirClass(detail.unrealizedPnlPct)}>
                                {pct(detail.unrealizedPnlPct)}
                            </Row>
                            <div className={css.note}>融資、融券的成本與收入定義和現股不同，僅列券商欄位。</div>
                        </>
                    )}
                    {rebate && (
                        <>
                            <div className={css.rule} />
                            <Row label={`預估退佣（月退 ${discountText(costSettings.feeDiscount)} 折）`}>{approx(money(rebate.rebate))}</Row>
                            <Row label='含退佣未實現損益' className={dirClass(rebate.pnlWithRebate)}>
                                {approx(signed(rebate.pnlWithRebate))}
                            </Row>
                            <div className={css.note}>
                                {`買進手續費 ${money(rebate.buyFee)} 與預估賣出手續費 ${money(rebate.sellFee)}（市值 × 0.1425%）各乘 (1 − 折數)，退佣 ≈ ${money(rebate.buyRebate)} ＋ ${money(rebate.sellRebate)}；實際退佣以券商入帳為準。`}
                            </div>
                        </>
                    )}
                    {isMargin && (
                        <>
                            <div className={css.rule} />
                            <Row label='融資金額合計（估）'>{approx(money(financedTotal))}</Row>
                            <Row label='預估融資利息合計'>{approx(money(interestTotal))}</Row>
                            <div className={css.note}>
                                {marginRateSet
                                    ? `融資金額 ≈ 各筆價金 × 成數（上市 6 成、上櫃 5 成，千元以下捨去）；計息天數 ≈ 交割日（成交日後第 2 個週一至週五）到今天的日曆天數；利息 ≈ 融資金額 × 年利率 ${percentText(costSettings.marginAnnualRate!)}% × 天數 ÷ 365。未計國定假日、個股成數調降與已償還部分，以券商計算為準。`
                                    : '未設定融資年利率，無法估算利息；請到「設定 → 風控 → 交易成本」填寫融資年利率。'}
                            </div>
                        </>
                    )}
                    {isShort && (
                        <>
                            <div className={css.rule} />
                            <Row label='借券費（估）'>{approx(money(shortFee))}</Row>
                            <div className={css.note}>
                                {`借券費 ≈ 賣出價金 × 借券費率 ${percentText(costSettings.shortFeeRate)}%（實際以券商收取為準）。`}
                            </div>
                        </>
                    )}
                </div>
            </div>

            {detail.lots.length > 0 && (
                <div className={css.lotsScroll}>
                    <table className={css.lots}>
                        <thead>
                            <tr>
                                {lotColumns.map(c => (
                                    <th key={c.title} className={css.lotsTh}>{c.title}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {detail.lots.map((lot, idx) => (
                                <tr key={idx}>
                                    {lotColumns.map(c => (
                                        <td key={c.title} className={`${css.lotsTd} ${c.className?.(lot) ?? ''}`}>
                                            {c.cell(lot)}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

/**
 * 上游持倉表的掛鉤：展開狀態留在這裡，上游只呼叫回傳的函式。
 * 非玉山股票列：toggle／row／card 回 null，yesterdayNotice 原樣回傳。
 */
export function useEsunPositionDetails() {
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    return useMemo(() => {
        const isOpen = (p: AccountedPosition) => isEsunStockPosition(p) && open.has(expandKey(p));
        return {
            /** 代碼旁的展開按鈕 */
            toggle(p: AccountedPosition): ReactNode {
                if (!isEsunStockPosition(p)) return null;
                const expanded = isOpen(p);
                return (
                    <button
                        type='button'
                        className={css.toggle}
                        aria-expanded={expanded}
                        aria-label='玉山庫存明細'
                        title='玉山庫存明細'
                        onClick={(e) => {
                            e.stopPropagation();
                            const key = expandKey(p);
                            setOpen((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                            });
                        }}
                    >
                        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    </button>
                );
            },
            /** 表格模式：該列下方的整寬明細列 */
            row(p: AccountedPosition, colSpan: number): ReactNode {
                if (!isEsunStockPosition(p) || !isOpen(p)) return null;
                return (
                    <tr>
                        <td className={css.detailCell} colSpan={colSpan}>
                            <EsunPositionDetails position={p} />
                        </td>
                    </tr>
                );
            },
            /** 窄版卡片：卡片內的明細區（點擊不觸發卡片的連動） */
            card(p: AccountedPosition): ReactNode {
                if (!isEsunStockPosition(p) || !isOpen(p)) return null;
                return (
                    <div className={css.cardDetail} onClick={(e) => e.stopPropagation()}>
                        <EsunPositionDetails position={p} />
                    </div>
                );
            },
            /** 玉山 qty_l 是券商權威資料，不套用永豐的昨餘提示 */
            yesterdayNotice(p: AccountedPosition, notice: string | undefined): string | undefined {
                return isEsunBroker(p.account?.broker_id) ? undefined : notice;
            },
        };
    }, [open]);
}
