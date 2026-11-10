// src/mobile/components/account/fill-history-card.tsx — 帳戶頁「成交明細」（買賣成交完整明細＋統整；已實現損益卡片下方）
//
// - 帳戶：只看選定的證券帳戶（selectedStock）；期貨不在範圍內（委託頁「成交」分頁有期貨成交）。
// - 區間：與已實現損益相同的期間膠囊與自訂日期欄（period-range.tsx；最長 180 天），自訂起訖存在本卡自己的模組層 slot。
// - 玉山：esunTradeService.fetchTransactions 讀區間內全部成交（玉山區間先以 clampEsunDateRange180Days 裁切）。
//   只在展開（且這個區間尚未讀過）或按「查詢」時讀取；同一 key（帳戶＋裁切後區間＋玉山環境）PNL_COOLDOWN_MS 內不重查；
//   與已實現損益卡片共用 PNL_ESUN_GATE（同一個 bridge 端點，兩張卡合計任意 60 秒最多 PNL_ESUN_QUERIES_PER_MIN 次）。
// - 永豐：Shioaji 沒有歷史成交 API，不發請求；區間含今天時顯示今日成交（useTradingState().trades 中該帳戶的股票成交，
//   order-fills 的 collectDealRows），手續費與交易稅為估算（lib/fill-history）。過去的區間清單為空，一律顯示說明。
// - 檢視：明細（依交易日分組，一次 FILLS_PAGE 筆、「再顯示」加一頁）／依股票／依日期；總計固定在最上面。
// - 金額、股數、價格經 maskMoney（遮蔽金額）；書號經 maskAccountId。只讀，沒有任何下單入口。

import { useMemo, useState } from 'react';
import { useAccounts } from '../../../lib/account-store';
import { clampEsunDateRange180Days, esunTradeService, isEsunAccount, useEsunEnvironment, type EsunTransactionDetail } from '../../../lib/esun';
import { maskAccountId, maskMoney, usePrivacyMode, usePrivacyMoney } from '../../../lib/privacy';
import { useTradingState } from '../../../lib/trading-state';
import type { AccountedTrade } from '../../../lib/types/order';
import type { Account } from '../../../lib/types/portfolio';
import { accountKeyOf, formatClock, formatPrice, formatShares, formatTwd, signDir } from '../../lib/account-format';
import { canLoadOnDemand, cooldownLeftSec, gateLeftSec, loadOnDemand, onDemandNow, useOnDemand } from '../../lib/account-on-demand';
import { PNL_COOLDOWN_MS, PNL_ESUN_GATE, PNL_ESUN_QUERIES_PER_MIN, pnlDateRange } from '../../lib/account-pnl';
import { useBrokerCostSettings } from '../../lib/broker-cost-settings';
import { useContractName } from '../../lib/contract-names';
import {
    fillTotals,
    fromEsunDetails,
    fromSinopacDeals,
    groupFillsByDate,
    sortFillRecords,
    summarizeByDate,
    summarizeByStock,
    type DateSummary,
    type FillRecord,
    type FillTotals,
    type StockSummary,
} from '../../lib/fill-history';
import { collectDealRows } from '../../lib/order-fills';
import * as styles from '../../styles/account.css';
import { CollapsibleCard, Item, RefreshButton, Segmented, useNow } from './account-ui';
import { PeriodRangeFields, usePeriodRange, type CustomRangeSlot } from './period-range';

/** 明細一次顯示的筆數（「再顯示」每次加這麼多） */
export const FILLS_PAGE = 100;

export type FillView = 'list' | 'stock' | 'date';
const VIEWS: readonly { value: FillView; text: string }[] = [
    { value: 'list', text: '明細' },
    { value: 'stock', text: '依股票' },
    { value: 'date', text: '依日期' },
];

export const FILLS_TEXT = {
    sinopac: '永豐不提供歷史成交查詢，只顯示今日成交（來自委託回報；手續費與交易稅為估算）。',
    futures: '期貨成交請看委託頁「成交」。',
    netUnknown: (n: number) => `${n} 筆信用交易沒有交割金額資料（融資自備款、融券保證金由券商計算），未計入淨收付。`,
    noAccount: '尚未選擇證券帳戶。',
} as const;

/** 自訂起訖（模組層：本次使用期間保留，不寫 storage；與已實現損益卡片分開） */
const customRange: CustomRangeSlot = { current: null };

export function resetFillHistoryCardForTest(): void {
    customRange.current = null;
}

function sameAccount(a: { broker_id?: string; account_id?: string } | null | undefined, b: Account): boolean {
    return !!a && a.broker_id === b.broker_id && a.account_id === b.account_id;
}

function useMoney() {
    const privMoney = usePrivacyMoney();
    return {
        privMoney,
        money: (n: number | null) => maskMoney(formatTwd(n), privMoney),
        signed: (n: number | null) => maskMoney(formatTwd(n, true), privMoney),
        shares: (n: number | null) => maskMoney(formatShares(n), privMoney),
        price: (n: number | null) => maskMoney(formatPrice(n), privMoney),
    };
}

const est = (estimated: boolean) => (estimated ? '（估）' : '');

/** 淨收付合計：全部筆數都沒有交割金額資料時為 null（顯示「—」），否則為有值筆數的加總 */
const knownNet = (t: FillTotals): number | null => (t.count > 0 && t.netUnknown === t.count ? null : t.net);

function TotalsView({ totals, showPnl }: { totals: FillTotals; showPnl: boolean }) {
    const { money, signed, shares } = useMoney();
    const e = est(totals.estimated);
    return (
        <div data-testid='fills-totals'>
            <div className={styles.totalLine}>
                <span>淨收付{e}（{totals.count} 筆）</span>
                <span className={`${styles.totalValue} ${styles.dir[signDir(knownNet(totals))]}`}>{signed(knownNet(totals))}</span>
            </div>
            <dl className={styles.kv}>
                <Item term='買進'>{money(totals.buyAmount)}（{shares(totals.buyShares)}）</Item>
                <Item term='賣出'>{money(totals.sellAmount)}（{shares(totals.sellShares)}）</Item>
                <Item term={`手續費${e}`}>{money(totals.fee)}</Item>
                <Item term={`交易稅${e}`}>{money(totals.tax)}</Item>
                {totals.otherFees !== 0 && <Item term='證所稅／融券手續費'>{money(totals.otherFees)}</Item>}
                {showPnl && (
                    <Item term='已實現損益' className={styles.dir[signDir(totals.realizedPnl)]}>{totals.realizedPnl === null ? '—' : signed(totals.realizedPnl)}</Item>
                )}
            </dl>
            {totals.netUnknown > 0 && (
                <p className={styles.note} data-testid='fills-net-unknown'>{FILLS_TEXT.netUnknown(totals.netUnknown)}</p>
            )}
        </div>
    );
}

function FillRow({ r }: { r: FillRecord }) {
    const priv = usePrivacyMode();
    const { privMoney, money, signed, price } = useMoney();
    const name = useContractName(r.code || null, r.name || null);
    const e = est(r.estimated);
    const fees = r.tax + r.otherFees;
    return (
        <div className={styles.fillsRow} data-testid='fills-row' role='group' aria-label={`${name ?? r.code} ${r.action === 'Buy' ? '買進' : '賣出'}`}>
            <div className={styles.fillsHead}>
                <span className={styles.pnlCode}>
                    <span className={styles.pnlName}>{name ?? r.code}</span>
                    <span className={styles.pnlMeta}>
                        <span className={styles.sideBadge[r.action]}>{r.action === 'Buy' ? '買' : '賣'}</span>
                        {[name ? r.code : '', r.tradeTypeLabel, r.time ?? ''].filter(Boolean).join(' · ')}
                    </span>
                </span>
                <span className={`${styles.pnlValue} ${styles.dir[signDir(r.net)]}`}>{signed(r.net)}</span>
            </div>
            <p className={styles.fillsFacts}>
                <span>{price(r.price)} × {maskMoney(r.shares.toLocaleString('en-US'), privMoney)} 股</span>
                <span>價金 {money(r.amount)}</span>
                <span>手續費{e} {money(r.fee)}／稅{e} {money(fees)}</span>
                {r.realizedPnl !== null && <span className={styles.dir[signDir(r.realizedPnl)]}>損益 {signed(r.realizedPnl)}</span>}
                <span>書號 {r.orderNo ? maskAccountId(r.orderNo, priv || privMoney) : '—'}</span>
            </p>
        </div>
    );
}

function SummaryFacts({ s }: { s: FillTotals }) {
    const { money } = useMoney();
    const e = est(s.estimated);
    return (
        <p className={styles.fillsFacts}>
            <span>買 {money(s.buyAmount)}</span>
            <span>賣 {money(s.sellAmount)}</span>
            <span>費稅{e} {money(s.fee + s.tax + s.otherFees)}</span>
        </p>
    );
}

function StockRow({ s }: { s: StockSummary }) {
    const { signed } = useMoney();
    const name = useContractName(s.code || null, s.name || null);
    return (
        <div className={styles.fillsRow} data-testid='fills-stock-row' role='group' aria-label={`${name ?? s.code} 統整`}>
            <div className={styles.fillsHead}>
                <span className={styles.pnlCode}>
                    <span className={styles.pnlName}>{name ?? s.code}</span>
                    <span className={styles.pnlMeta}>{[name ? s.code : '', `${s.count} 筆`].filter(Boolean).join(' · ')}</span>
                </span>
                <span className={`${styles.pnlValue} ${styles.dir[signDir(knownNet(s))]}`}>{signed(knownNet(s))}</span>
            </div>
            <SummaryFacts s={s} />
            {s.realizedPnl !== null && (
                <p className={`${styles.fillsFacts} ${styles.dir[signDir(s.realizedPnl)]}`}>已實現損益 {signed(s.realizedPnl)}</p>
            )}
        </div>
    );
}

function DateRow({ s }: { s: DateSummary }) {
    const { signed } = useMoney();
    return (
        <div className={styles.fillsRow} data-testid='fills-date-row' role='group' aria-label={`${s.date} 統整`}>
            <div className={styles.fillsHead}>
                <span className={styles.pnlCode}>
                    <span className={styles.pnlName}>{s.date}</span>
                    <span className={styles.pnlMeta}>{s.count} 筆</span>
                </span>
                <span className={`${styles.pnlValue} ${styles.dir[signDir(knownNet(s))]}`}>{signed(knownNet(s))}</span>
            </div>
            <SummaryFacts s={s} />
        </div>
    );
}

function ListView({ records, dataKey }: { records: readonly FillRecord[]; dataKey: string }) {
    // 換資料（帳戶、區間、重新查詢）時回到第一頁
    const [page, setPage] = useState({ key: dataKey, n: FILLS_PAGE });
    const limit = page.key === dataKey ? page.n : FILLS_PAGE;
    const sorted = useMemo(() => sortFillRecords(records), [records]);
    const groups = groupFillsByDate(sorted.slice(0, limit));
    const left = sorted.length - limit;
    return (
        <div data-testid='fills-list'>
            {groups.map(g => (
                <div key={g.date}>
                    <h3 className={styles.fillsDate}>{g.date}</h3>
                    {g.records.map((r, i) => <FillRow key={`${r.orderNo}|${r.time}|${i}`} r={r} />)}
                </div>
            ))}
            {left > 0 && (
                <div className={styles.actions}>
                    <span className={styles.note}>還有 {left} 筆</span>
                    <button type='button' className={styles.smallButton} onClick={() => setPage({ key: dataKey, n: limit + FILLS_PAGE })} data-testid='fills-more'>
                        再顯示 {Math.min(FILLS_PAGE, left)} 筆
                    </button>
                </div>
            )}
        </div>
    );
}

export function FillHistoryCard() {
    const { selectedStock } = useAccounts();
    const env = useEsunEnvironment();
    const trading = useTradingState();
    const costs = useBrokerCostSettings();
    const [open, setOpen] = useState(false);
    const [view, setView] = useState<FillView>('list');
    // 展開時每秒重繪（冷卻倒數）；收合時只需跟上日期變化
    const now = useNow(open ? 1_000 : 60_000);
    const picker = usePeriodRange(customRange, now);
    const { range, problem } = picker;
    const account = selectedStock && selectedStock.account_type === 'S' ? selectedStock : null;
    const esun = !!account && isEsunAccount(account);

    // 玉山：裁切後區間＋帳戶＋環境為 key；自訂區間不合法時沒有 key（不讀取、「查詢」停用）
    const clamp = esun ? clampEsunDateRange180Days(range.begin, range.end) : null;
    const key = esun && clamp && !problem ? `fills:${accountKeyOf(account)}@${clamp.beginDate}~${clamp.endDate}:${env.environment}` : null;
    const state = useOnDemand<EsunTransactionDetail[]>(key);
    const clockNow = onDemandNow();
    const gateLeft = esun ? gateLeftSec(PNL_ESUN_GATE, clockNow) : 0;
    const canLoad = !!key && canLoadOnDemand(state, PNL_COOLDOWN_MS, clockNow) && gateLeft === 0;
    const load = () => {
        if (!key || !account || !clamp) return;
        const { beginDate, endDate } = clamp;
        // 冷卻與共用視窗由 loadOnDemand 在呼叫當下再判斷一次（被擋下時不發請求）
        void loadOnDemand(key, () => esunTradeService.fetchTransactions(account, beginDate, endDate), PNL_COOLDOWN_MS, PNL_ESUN_GATE);
    };
    const toggle = () => {
        const next = !open;
        setOpen(next);
        // 展開時只在這個區間尚未讀過時讀取一次（之後由「查詢」更新）
        if (next && esun && state.data === null && !state.loading && canLoad) load();
    };

    // 永豐：今日成交（不發請求）；區間不含今天時為空
    const today = pnlDateRange('today', now).end;
    const sinopacToday = !esun && !!account && !problem && range.begin <= today && today <= range.end;
    const trades = trading?.trades;
    const sinopacSettings = costs.sinopac;
    const sinopacRecords = useMemo(() => {
        if (!open || !sinopacToday || !account || !Array.isArray(trades)) return [];
        const mine = trades.filter(t => sameAccount((t as AccountedTrade).account ?? t.order.account, account));
        return fromSinopacDeals(collectDealRows(mine), { settings: sinopacSettings, now: Date.now() }).filter(r => r.tradeDate === today);
    }, [open, sinopacToday, account, trades, sinopacSettings, today]);

    // 玉山：bridge 回傳的就是查詢區間內的成交，不再以日期篩選（避免缺日期的列被默默丟掉）
    const esunData = esun ? state.data : null;
    const records = useMemo<FillRecord[] | null>(() => {
        if (esun) return esunData ? fromEsunDetails(esunData) : null;
        return sinopacRecords;
    }, [esun, esunData, sinopacRecords]);
    const totals = useMemo(() => (records && records.length ? fillTotals(records) : null), [records]);
    const byStock = useMemo(() => (records && view === 'stock' ? summarizeByStock(records) : []), [records, view]);
    const byDate = useMemo(() => (records && view === 'date' ? summarizeByDate(records) : []), [records, view]);
    const dataKey = esun ? `${key}#${state.updatedAt ?? 0}` : `sinopac:${accountKeyOf(account)}@${range.begin}~${range.end}`;

    return (
        <CollapsibleCard title='成交明細' open={open} onToggle={toggle} testId='account-fills'>
            {!account ? (
                <p className={styles.note}>{FILLS_TEXT.noAccount}</p>
            ) : (
                <>
                    <PeriodRangeFields picker={picker} now={now} testIdPrefix='fills' />
                    {!esun && <p className={styles.note} data-testid='fills-sinopac-note'>{FILLS_TEXT.sinopac}</p>}
                    {esun && state.loading && !records && <p className={styles.note}>成交明細查詢中…</p>}
                    {esun && !state.loading && !records && !state.error && !problem && (
                        <p className={styles.note} data-testid='fills-idle'>按「查詢」讀取這個區間的成交明細。</p>
                    )}
                    {records && records.length > 0 && totals && (
                        <>
                            <TotalsView totals={totals} showPnl={esun} />
                            <Segmented<FillView> label='檢視' value={view} options={VIEWS} onChange={setView} testId='fills-view' />
                            {view === 'list' && <ListView records={records} dataKey={dataKey} />}
                            {view === 'stock' && <div data-testid='fills-stock'>{byStock.map(s => <StockRow key={s.code} s={s} />)}</div>}
                            {view === 'date' && <div data-testid='fills-date'>{byDate.map(s => <DateRow key={s.date} s={s} />)}</div>}
                        </>
                    )}
                    {records && records.length === 0 && !problem && (
                        <p className={styles.note} data-testid='fills-empty'>{esun || sinopacToday ? '這個區間沒有股票成交。' : '這個區間不含今天，沒有可顯示的永豐成交。'}</p>
                    )}
                    {esun && state.error && <p className={styles.warning} role='alert'>成交明細查詢失敗：{state.error}</p>}
                    {esun && (
                        <p className={styles.note} data-testid='fills-esun-limit'>
                            {!problem && clamp?.clamped
                                ? '玉山查詢區間最長 180 天，已自動縮短。'
                                : `玉山成交明細最長查詢 180 天；與已實現損益合計每分鐘最多查詢 ${PNL_ESUN_QUERIES_PER_MIN} 次。`}
                        </p>
                    )}
                    <p className={styles.note}>{FILLS_TEXT.futures}</p>
                    {esun && (
                        <div className={styles.actions}>
                            <span className={styles.note}>資料時間 {formatClock(state.updatedAt)}</span>
                            <RefreshButton
                                label='查詢'
                                loading={state.loading}
                                cooldownSec={state.loading || !key ? 0 : Math.max(cooldownLeftSec(state, PNL_COOLDOWN_MS, clockNow), gateLeft)}
                                disabled={!canLoad}
                                onClick={load}
                                testId='fills-query'
                            />
                        </div>
                    )}
                </>
            )}
        </CollapsibleCard>
    );
}
