// src/mobile/routes/trade-page.tsx — 交易（#/trade/:code；規格 §6.2）
//
// ┌ 標頭：名稱・市場／即時價・漲跌・量／漲跌停・參考・當沖（股票）或到期月份・時段（期權）
// ├ 週期列［走勢］［1分］［5分］［15分］［60分］［日］＋交易圖表（委託線、成本線、漲跌停、參考價）
// ├［五檔］［明細］
// ├ 持倉摘要・未成交 N 筆 ›（#/orders）
// └ sticky［買進］［賣出］→ openTicket()（只開下單面板，送單一律經確認面板）
//
// code 來自 hash 路由（已過濾不合法代碼）；null＝尚未選商品。

import { useEffect, useMemo, useState } from 'react';
import { useQuote } from '../../hooks/use-stream';
import { ensureContract, useContract } from '../../lib/contracts-cache';
import { sessionWindowFor } from '../../lib/intraday-session';
import { maskMoney, usePrivacyMoney } from '../../lib/privacy';
import { useTradingState } from '../../lib/trading-state';
import type { ContractInfo, DayTrade, Exchange, SecurityType } from '../../lib/types/contract';
import type { AccountedTrade } from '../../lib/types/order';
import type { AccountedPosition } from '../../lib/types/portfolio';
import { fmtCompactInt, fmtStockLots } from '../../lib/utils/format';
import { nowWallClockUtc } from '../../lib/utils/kbars';
import { formatToTick } from '../../lib/utils/ticksize';
import { remainingWorkingOrderQuantity } from '../../lib/working-order-quantity';
import { DepthLadder } from '../components/depth-ladder';
import { TickList } from '../components/tick-list';
import { TradeChart } from '../components/trade-chart';
import { chartPriceLines, formatLinePrice } from '../lib/chart-model';
import { CHART_PERIODS, DEFAULT_CHART_PERIOD, isChartPeriod, type ChartPeriod } from '../lib/chart-ranges';
import { formatRoute } from '../lib/hash-router';
import { openTicket, setCurrentCode } from '../lib/mobile-store';
import * as controls from '../styles/controls.css';
import * as layout from '../styles/layout.css';
import * as styles from '../styles/trade.css';

// ---- 純函式（標頭文字） ----

const EXCHANGE_TEXT: Record<string, string> = { TSE: '上市', OTC: '上櫃', OES: '興櫃', TAIFEX: '期交所' };

export function exchangeText(exchange: Exchange): string {
    return exchange ? EXCHANGE_TEXT[exchange] ?? exchange : '';
}

export function dayTradeText(dt: DayTrade): string | null {
    if (dt === 'Yes') return '可當沖';
    if (dt === 'OnlyBuy') return '僅可先買後賣當沖';
    if (dt === 'No') return '不可當沖';
    return null;
}

/** '202612' → '2026/12'；其他格式原樣回傳 */
export function deliveryMonthText(m: string | undefined): string | null {
    if (!m) return null;
    return /^\d{6}$/.test(m) ? `${m.slice(0, 4)}/${m.slice(4)}` : m;
}

function hm(t: number): string {
    const tod = ((t % 86400) + 86400) % 86400;
    return `${String(Math.floor(tod / 3600)).padStart(2, '0')}:${String(Math.floor((tod % 3600) / 60)).padStart(2, '0')}`;
}

/** 目前（或即將開始）的交易時段：「日盤 08:45–13:45」「夜盤 15:00–05:00」 */
export function sessionText(secType: SecurityType, now: number): string {
    const w = sessionWindowFor(secType, now);
    return `${w.night ? '夜盤' : '日盤'} ${hm(w.start)}–${hm(w.end)}`;
}

export interface PriceChange {
    change: number;
    pct: number;
    dir: 'up' | 'down' | 'flat';
}

/** 漲跌與漲跌幅：優先用成交回報的 price_chg／pct_chg，沒有時以參考價計算 */
export function priceChange(price: number | null, reference: number | undefined, tick?: { price_chg?: string; pct_chg?: string }): PriceChange | null {
    if (price === null || !Number.isFinite(price)) return null;
    let change = tick?.price_chg === undefined ? NaN : Number(tick.price_chg);
    let pct = tick?.pct_chg === undefined ? NaN : Number(tick.pct_chg);
    if (!Number.isFinite(change)) {
        if (!reference || reference <= 0) return null;
        change = price - reference;
        pct = (change / reference) * 100;
    } else if (!Number.isFinite(pct)) {
        pct = reference && reference > 0 ? (change / reference) * 100 : 0;
    }
    return { change, pct, dir: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' };
}

export interface PositionSummary {
    label: string;
    quantity: string;
    avg: number;
    pnl: number;
}

const STOCK_COND_TEXT: Record<string, string> = { Cash: '現股', MarginTrading: '融資', ShortSelling: '融券' };

/** 目前商品的持倉摘要（股票依信用條件、期權依多空分列；數量加總、均價以數量加權） */
export function positionSummaries(orderableCode: string, displayCode: string, positions: readonly AccountedPosition[], isStock: boolean): PositionSummary[] {
    const groups = new Map<string, { qty: number; cost: number; pnl: number }>();
    for (const p of positions) {
        if (p.code !== orderableCode && p.code !== displayCode) continue;
        if (!(p.quantity > 0)) continue;
        const cond = 'cond' in p && typeof p.cond === 'string' ? p.cond : undefined;
        const label = isStock
            ? STOCK_COND_TEXT[cond ?? 'Cash'] ?? (p.direction === 'Sell' ? '空' : '多')
            : p.direction === 'Sell' ? '空單' : '多單';
        const g = groups.get(label) ?? { qty: 0, cost: 0, pnl: 0 };
        g.qty += p.quantity;
        g.cost += p.quantity * p.price;
        g.pnl += Number.isFinite(p.pnl) ? p.pnl : 0;
        groups.set(label, g);
    }
    return [...groups].map(([label, g]) => ({
        label,
        quantity: isStock ? fmtStockLots(g.qty) : `${g.qty} 口`,
        avg: g.qty > 0 ? g.cost / g.qty : 0,
        pnl: g.pnl,
    }));
}

/** 目前商品的未成交筆數（任何價格類型，剩餘量 > 0） */
export function workingOrderCount(orderableCode: string, trades: readonly AccountedTrade[]): number {
    let n = 0;
    for (const t of trades) {
        if ((t.contract.target_code || t.contract.code) === orderableCode && remainingWorkingOrderQuantity(t) > 0) n += 1;
    }
    return n;
}

// ---- 週期偏好（只是本機便利設定；讀寫失敗時用預設） ----

const PERIOD_KEY = 'sj-mobile-chart-period';

function loadPeriod(): ChartPeriod {
    try {
        const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(PERIOD_KEY);
        return isChartPeriod(v) ? v : DEFAULT_CHART_PERIOD;
    } catch {
        return DEFAULT_CHART_PERIOD;
    }
}

function savePeriod(p: ChartPeriod) {
    try {
        localStorage.setItem(PERIOD_KEY, p);
    } catch {
        // 只在本次有效
    }
}

// ---- 元件 ----

function Header({ code, contract }: { code: string; contract: ContractInfo | undefined }) {
    const quote = useQuote(code, { narrow: true });
    const tick = quote?.tick;
    const index = quote?.index;
    const live = tick ? Number(tick.close) : index ? Number(index.close) : NaN;
    const price = Number.isFinite(live) && live > 0 ? live : contract && contract.reference > 0 ? contract.reference : null;
    const chg = priceChange(price, contract?.reference, tick);
    const isStock = contract?.security_type === 'STK';
    const isFop = contract?.security_type === 'FUT' || contract?.security_type === 'OPT';
    const fmt = (p: number) => (contract ? formatToTick(contract, p) : String(p));
    const unit = isStock ? '張' : isFop ? '口' : '';
    const arrow = chg?.dir === 'up' ? '▲' : chg?.dir === 'down' ? '▼' : '';
    const dayTrade = contract && isStock ? dayTradeText(contract.day_trade) : null;
    const delivery = contract && isFop ? deliveryMonthText(contract.delivery_month) : null;

    return (
        <header className={styles.header}>
            <div className={styles.titleRow}>
                <h1 className={styles.title}>{code}{contract?.name ? ` ${contract.name}` : ''}</h1>
                {contract && <span className={styles.subtle}>{exchangeText(contract.exchange)}</span>}
            </div>
            <div className={styles.priceRow} data-testid='trade-price'>
                <span className={`${styles.lastPrice} ${styles.dirText[chg?.dir ?? 'flat']}`}>{price !== null ? fmt(price) : '—'}</span>
                {chg && (
                    <span className={`${styles.change} ${styles.dirText[chg.dir]}`}>
                        {arrow}{contract && price !== null ? formatToTick(contract, Math.abs(chg.change), { at: price }) : Math.abs(chg.change)} ({chg.pct > 0 ? '+' : ''}{chg.pct.toFixed(2)}%)
                    </span>
                )}
                {tick && <span className={styles.subtle}>量 {fmtCompactInt(tick.total_volume)}{unit && ` ${unit}`}</span>}
            </div>
            {contract && isStock && (
                <div className={styles.infoRow} data-testid='trade-info'>
                    {contract.limit_up > 0 && <span className={styles.infoUp}>漲停 {fmt(contract.limit_up)}</span>}
                    {contract.limit_down > 0 && <span className={styles.infoDown}>跌停 {fmt(contract.limit_down)}</span>}
                    {contract.reference > 0 && <span>參考 {fmt(contract.reference)}</span>}
                    {dayTrade && <span>{dayTrade}</span>}
                </div>
            )}
            {contract && isFop && (
                <div className={styles.infoRow} data-testid='trade-info'>
                    {delivery && <span>到期 {delivery}</span>}
                    <span>{sessionText(contract.security_type, nowWallClockUtc())}</span>
                    {contract.reference > 0 && <span>參考 {fmt(contract.reference)}</span>}
                </div>
            )}
        </header>
    );
}

function TradeView({ code }: { code: string }) {
    useEffect(() => { setCurrentCode(code); }, [code]);

    // 載入合約（也讓狀態列能依商品判斷市場）
    const contract = useContract(code);
    const [loadError, setLoadError] = useState(false);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        let active = true;
        setLoadError(false);
        ensureContract(code).catch(() => { if (active) setLoadError(true); });
        return () => { active = false; };
    }, [code, retry]);

    const trading = useTradingState();
    const privMoney = usePrivacyMoney();
    const [period, setPeriodState] = useState<ChartPeriod>(loadPeriod);
    const setPeriod = (p: ChartPeriod) => { setPeriodState(p); savePeriod(p); };
    const [panel, setPanel] = useState<'depth' | 'ticks'>('depth');

    const orderable = contract ? contract.target_code || contract.code : code;
    const isStock = contract?.security_type === 'STK';
    const lines = useMemo(
        () => (contract ? chartPriceLines({ contract, trades: trading.trades, positions: trading.positions }) : []),
        [contract, trading.trades, trading.positions],
    );
    const summaries = useMemo(
        () => positionSummaries(orderable, code, trading.positions, isStock),
        [orderable, code, trading.positions, isStock],
    );
    const working = useMemo(() => workingOrderCount(orderable, trading.trades), [orderable, trading.trades]);
    const tradable = contract ? contract.security_type !== 'IND' : true;
    const comboNote = contract?.combo ? '組合商品不支援手機下單' : null;

    return (
        <section className={styles.page} data-testid='page-trade'>
            <Header code={code} contract={contract} />

            <div className={styles.segmentRow} role='group' aria-label='圖表週期'>
                {CHART_PERIODS.map(p => (
                    <button key={p.key} type='button' className={styles.segment} aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}>
                        {p.label}
                    </button>
                ))}
            </div>

            {contract
                ? <TradeChart code={code} contract={contract} period={period} lines={lines} />
                : (
                    <div className={styles.chartWrap}>
                        <div className={styles.chartOverlay}>
                            {loadError
                                ? (
                                    <>
                                        <span>找不到商品或載入失敗：{code}</span>
                                        <button type='button' className={`${styles.toggle} ${styles.chartOverlayAction}`} onClick={() => setRetry(n => n + 1)}>重試</button>
                                    </>
                                )
                                : <span>載入商品資訊…</span>}
                        </div>
                    </div>
                )}

            <div className={styles.segmentRow} role='tablist' aria-label='五檔與明細'>
                <button type='button' role='tab' className={styles.segment} aria-selected={panel === 'depth'} onClick={() => setPanel('depth')}>五檔</button>
                <button type='button' role='tab' className={styles.segment} aria-selected={panel === 'ticks'} onClick={() => setPanel('ticks')}>明細</button>
            </div>
            {panel === 'depth'
                ? <DepthLadder code={code} contract={contract} trades={trading.trades} />
                : contract ? <TickList code={code} contract={contract} /> : null}

            <div className={styles.summary} data-testid='trade-summary'>
                {summaries.length === 0
                    ? <span className={styles.subtle}>持倉：無</span>
                    : summaries.map(s => (
                        <span key={s.label}>
                            持倉：{s.label} {maskMoney(s.quantity, privMoney)} · 均價 {formatLinePrice(s.avg)} ·{' '}
                            <span className={styles.dirText[s.pnl > 0 ? 'up' : s.pnl < 0 ? 'down' : 'flat']}>
                                {maskMoney(`${s.pnl > 0 ? '+' : ''}${Math.round(s.pnl).toLocaleString('en-US')}`, privMoney)}
                            </span>
                        </span>
                    ))}
                <a className={styles.workingLink} href={formatRoute({ name: 'orders' })} data-testid='trade-working-link'>
                    未成交：{working} 筆 ›
                </a>
            </div>

            {tradable && (
                <div className={styles.tradeBar}>
                    {comboNote && <p className={styles.tradeBarNote}>{comboNote}</p>}
                    <div className={controls.tradeButtonRow}>
                        <button
                            type='button'
                            className={controls.tradeButton.buy}
                            disabled={!!comboNote}
                            onClick={() => openTicket({ code, action: 'Buy', source: 'button' })}
                            data-testid='trade-buy'
                        >
                            買 進
                        </button>
                        <button
                            type='button'
                            className={controls.tradeButton.sell}
                            disabled={!!comboNote}
                            onClick={() => openTicket({ code, action: 'Sell', source: 'button' })}
                            data-testid='trade-sell'
                        >
                            賣 出
                        </button>
                    </div>
                </div>
            )}
        </section>
    );
}

export function TradePage({ code }: { code: string | null }) {
    if (!code) {
        return (
            <section className={layout.page} data-testid='page-trade'>
                <h1 className={layout.pageTitle}>交易</h1>
                <p className={layout.placeholder}>尚未選擇商品，請從自選清單選擇。</p>
            </section>
        );
    }
    // 換商品時整頁重建（圖表、五檔、明細內部狀態一併重設）
    return <TradeView key={code} code={code} />;
}
