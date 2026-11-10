// src/mobile/components/account/realized-pnl-card.tsx — 帳戶頁「已實現損益」（規格 Phase 2；比照桌面 PnlSection／pnlFetcher）
//
// - 區間：今日／本週／本月／近 30 天／自訂（台北日期）；帳戶＝目前選定的證券與期貨帳戶。
// - 自訂：原生 <input type="date"> 起日／迄日，最多 180 天（含起訖日；customRangeProblem）；不合法時停用「查詢」並以
//   role=status 說明原因，不自動修正日期。起訖存在模組層（本次使用期間保留，不寫 storage），第一次切到自訂帶近 30 天。
// - 只在使用者展開區塊（且這個區間尚未讀過）或按「查詢」時讀取；同一區間＋帳戶 PNL_COOLDOWN_MS 內不重查；
//   含玉山帳戶時另有不分區間的滑動視窗：任意 60 秒最多 PNL_ESUN_QUERIES_PER_MIN 次（避免觸發 bridge 10 次／分限制）。
// - 資料經由 src/lib 的 fetchProfitLoss／fetchProfitLossSummary（玉山帳戶由 lib 轉往 bridge）；玉山區間先以
//   clampEsunDateRange180Days 限制在 180 天內，並以同一組日期字串讀取玉山成交明細 store（useEsunTransactionDetails）。
// - 合計規則見 src/mobile/lib/account-pnl.ts（sum 優先、列表加總後備、逐帳戶判斷）。
// - 明細列顯示商品名稱為主、代碼為次（見 PnlRow；名稱查詢沿用合約快取，每個不重複代碼最多一次）。
// - 預估手續費退佣（lib/realized-rebate，純函式）：每列依該列券商的設定（broker-cost-settings：永豐、玉山分開）估算；
//   玉山成交明細在卡片層讀 store（hook 無條件呼叫，不適用時傳 null），每列只算一次，列、合計、玉山展開明細三處用同一個結果。
//   合計與各市場分項之後、逐筆明細之前顯示「預估退佣合計（估）」「退佣後損益（估）」、無法估算的筆數與各券商設定；沒有月退時只顯示提示。只讀，沒有下單入口。

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { esunFillCosts, esunRefOfPnlRow } from '../../../components/esun-pnl-details';
import { useAccounts } from '../../../lib/account-store';
import {
    clampEsunDateRange180Days,
    findEsunTransactionDetail,
    isEsunAccount,
    useEsunEnvironment,
    useEsunTransactionDetails,
    type EsunTransactionDetail,
} from '../../../lib/esun';
import { maskAccountId, maskMoney, usePrivacyMode, usePrivacyMoney } from '../../../lib/privacy';
import { canonicalBrokerCode } from '../../../lib/realized-name';
import { fetchProfitLoss, fetchProfitLossSummary } from '../../../lib/shioaji';
import { discountText, type TradingCostSettings } from '../../../lib/trading-cost-settings';
import type { Account } from '../../../lib/types/portfolio';
import { accountKeyOf, formatClock, formatPct, formatPrice, formatShares, formatTwd, signDir } from '../../lib/account-format';
import { canLoadOnDemand, cooldownLeftSec, gateLeftSec, loadOnDemand, onDemandNow, useOnDemand, type OnDemandGate } from '../../lib/account-on-demand';
import {
    aggregateRealizedPnl,
    customRangeBounds,
    customRangeProblem,
    PNL_COOLDOWN_MS,
    PNL_ESUN_QUERIES_PER_MIN,
    PNL_PERIODS,
    pnlDateRange,
    pnlRangeDays,
    realizedRowKey,
    type PnlPart,
    type PnlPeriod,
    type RealizedPnlResult,
    type RealizedPnlRow,
} from '../../lib/account-pnl';
import { brokerOfAccountKey, COST_BROKER_TEXT, COST_BROKERS, useBrokerCostSettings, type CostBroker } from '../../lib/broker-cost-settings';
import { instrumentText, realizedLookupCode, useContractName } from '../../lib/contract-names';
import { realizedRebateTotals, realizedRowRebate, type RealizedRebate } from '../../lib/realized-rebate';
import * as styles from '../../styles/account.css';
import { brokerName, CollapsibleCard, Item, RefreshButton, Segmented, useNow } from './account-ui';

interface PnlPlan {
    account: Account;
    market: 'S' | 'F';
    begin: string;
    end: string;
    /** 玉山區間被裁到 180 天內 */
    clamped: boolean;
}

/** 依帳戶決定查詢區間：玉山先裁到 180 天內（lib 內部也會裁，這裡裁好才能以同一字串讀成交明細 store） */
export function pnlPlans(accounts: readonly (Account | null)[], range: { begin: string; end: string }): PnlPlan[] {
    return accounts
        .filter((a): a is Account => !!a && (a.account_type === 'S' || a.account_type === 'F'))
        .map(account => {
            const market = account.account_type as 'S' | 'F';
            if (!isEsunAccount(account)) return { account, market, begin: range.begin, end: range.end, clamped: false };
            const c = clampEsunDateRange180Days(range.begin, range.end);
            return { account, market, begin: c.beginDate, end: c.endDate, clamped: c.clamped };
        });
}

const MARKET_TEXT = { S: '證券', F: '期貨' } as const;

/** 含玉山帳戶的已實現損益查詢共用的滑動視窗（不分區間）；只有永豐帳戶時不套用 */
const PNL_ESUN_GATE: OnDemandGate = { name: 'realized-pnl-esun', max: PNL_ESUN_QUERIES_PER_MIN, windowMs: 60_000 };

type DateRange = { begin: string; end: string };

/** 自訂起訖（模組層：本次使用期間保留，不寫 storage）；null＝尚未切到自訂 */
let customRange: DateRange | null = null;

export function resetRealizedPnlCardForTest(): void {
    customRange = null;
}

function errorText(e: unknown): string {
    return e instanceof Error && e.message ? e.message : String(e || '查詢失敗');
}

/** 逐帳戶讀取列表與彙總（任一失敗不拖垮其他帳戶），再以 aggregateRealizedPnl 合計 */
export async function fetchRealizedPnl(plans: readonly PnlPlan[]): Promise<RealizedPnlResult> {
    const parts = await Promise.all(plans.map(async (p): Promise<PnlPart> => {
        const [list, sum] = await Promise.allSettled([
            fetchProfitLoss(p.market, p.account, p.begin, p.end),
            fetchProfitLossSummary(p.market, p.account, p.begin, p.end),
        ]);
        const label = `${brokerName(p.account)}${MARKET_TEXT[p.market]}`;
        const errors: string[] = [];
        if (list.status === 'rejected') errors.push(`${label}損益明細查詢失敗：${errorText(list.reason)}`);
        if (sum.status === 'rejected' && list.status === 'rejected') errors.push(`${label}損益彙總查詢失敗：${errorText(sum.reason)}`);
        return {
            market: p.market,
            accountKey: `${p.account.broker_id}:${p.account.account_id}`,
            list: list.status === 'fulfilled' && Array.isArray(list.value) ? list.value : null,
            sum: sum.status === 'fulfilled' ? sum.value : null,
            errors,
        };
    }));
    return aggregateRealizedPnl(parts);
}

export const REBATE_TEXT = {
    total: '預估退佣合計（估）',
    after: '退佣後損益（估）',
    note: '退佣＝買進＋賣出手續費 ×（1 − 折數），依「帳戶 › 交易成本」各券商設定估算；永豐以成交價金估算手續費，玉山的平倉手續費用成交明細。實際以券商入帳為準，期貨不計退佣。',
    off: '目前的交易成本設定沒有月退（折數 10 或成交即折），沒有退佣可顯示；可在「帳戶 › 交易成本」依券商設定。',
    unknown: (n: number) => `${n} 筆缺成交價或數量，無法估算退佣，未計入。`,
} as const;

/** 「月退 6 折」「成交即折 2.8 折」「無折扣」 */
export function costModeText(s: Pick<TradingCostSettings, 'feeDiscount' | 'rebateMode'>): string {
    if (s.feeDiscount >= 1) return '無折扣';
    return `${s.rebateMode === 'monthly' ? '月退' : '成交即折'} ${discountText(s.feeDiscount)} 折`;
}

/** 一列的玉山成交明細（applies＝玉山證券列）、預估退佣與所用的設定（列、合計、展開明細共用） */
interface RowInfo {
    esun: { applies: boolean; detail: EsunTransactionDetail | undefined };
    rebate: RealizedRebate;
    settings: TradingCostSettings;
}

function EsunDetailView({ detail, row, info }: { detail: EsunTransactionDetail; row: RealizedPnlRow; info: RowInfo }) {
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const money = (n: number | null) => maskMoney(formatTwd(n), privMoney);
    const signed = (n: number | null) => maskMoney(formatTwd(n, true), privMoney);
    const price = (n: number | null) => maskMoney(formatPrice(n), privMoney);
    const shares = (n: number | null) => maskMoney(formatShares(n), privMoney);
    const costs = esunFillCosts(detail.fills);
    const rebate = info.rebate.status === 'ok' ? info.rebate.rebate : null;
    const withRebate = rebate !== null && Number.isFinite(row.pnl) ? row.pnl + rebate : null;
    const side = detail.action === 'Buy' ? '買進' : detail.action === 'Sell' ? '賣出' : '';
    return (
        <div className={styles.detailBox} data-testid='pnl-esun-detail'>
            <dl className={styles.kv}>
                <Item term='交易類別'>{`${detail.tradeTypeLabel || '—'}${side ? ` ${side}` : ''}`}</Item>
                <Item term='成交均價'>{price(detail.avgPrice)}</Item>
                <Item term='股數'>{shares(detail.shares)}</Item>
                <Item term='價金小計'>{money(detail.priceQty)}</Item>
                <Item term='成本'>{money(detail.cost)}</Item>
                <Item term='收入'>{money(detail.income)}</Item>
                <Item term='已實現損益' className={styles.dir[signDir(detail.realizedPnl)]}>{signed(detail.realizedPnl)}</Item>
                <Item term='獲利率' className={styles.dir[signDir(detail.realizedPnlPct)]}>{maskMoney(formatPct(detail.realizedPnlPct), privMoney)}</Item>
            </dl>
            <h4 className={styles.subTitle}>交易成本（逐筆成交加總）</h4>
            <dl className={styles.kv}>
                <Item term='手續費'>{money(costs.fee)}</Item>
                <Item term='交易稅'>{money(costs.tax)}</Item>
                <Item term='證所稅'>{money(costs.capitalGainsTax)}</Item>
                <Item term='融券手續費'>{money(costs.shortFee)}</Item>
                <Item term='成本合計' testId='pnl-esun-cost-total'>{money(costs.total)}</Item>
                {rebate !== null && (
                    <>
                        <Item term={`預估退佣（月退 ${discountText(info.settings.feeDiscount)} 折）`} testId='pnl-esun-rebate'>{money(rebate)}</Item>
                        <Item term='退佣後損益（估）' className={styles.dir[signDir(withRebate)]} testId='pnl-esun-after-rebate'>{signed(withRebate)}</Item>
                    </>
                )}
            </dl>
            <h4 className={styles.subTitle}>逐筆成交</h4>
            {detail.fills.length === 0 ? (
                <p className={styles.note}>券商未提供逐筆成交。</p>
            ) : (
                detail.fills.map((f, i) => (
                    <div key={`${f.orderNo}-${f.tradeDate}-${f.tradeTime}-${i}`} className={styles.fillCard}>
                        <div className={styles.fillHead}>
                            <span>{`${f.tradeDate || '—'}${f.tradeTime ? ` ${f.tradeTime}` : ''}`}</span>
                            <span>書號 {f.orderNo ? maskAccountId(f.orderNo, priv || privMoney) : '—'}</span>
                        </div>
                        <dl className={styles.kv}>
                            <Item term='成交價／股數'>{price(f.price)} × {f.shares === null ? '—' : maskMoney(f.shares.toLocaleString('en-US'), privMoney)}</Item>
                            <Item term='價金'>{money(f.priceQty)}</Item>
                            <Item term='手續費／交易稅'>{money(f.fee)} / {money(f.tax)}</Item>
                            {(f.capitalGainsTax !== null || f.shortFee !== null) && (
                                <Item term='證所稅／融券手續費'>{money(f.capitalGainsTax)} / {money(f.shortFee)}</Item>
                            )}
                            <Item term='淨收付'>{signed(f.netAmount)}</Item>
                            <Item term='損益' className={styles.dir[signDir(f.realizedPnl)]}>{signed(f.realizedPnl)}</Item>
                        </dl>
                    </div>
                ))
            )}
        </div>
    );
}

/** 玉山證券列的「交易成本明細」展開 */
function EsunRowDetail({ row, info }: { row: RealizedPnlRow; info: RowInfo }) {
    const detail = info.esun.detail;
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type='button' className={styles.toggleRow} aria-expanded={open} onClick={() => setOpen(v => !v)} data-testid='pnl-esun-detail-toggle'>
                {open ? <ChevronDown size={16} aria-hidden='true' /> : <ChevronRight size={16} aria-hidden='true' />}
                交易成本明細
            </button>
            {open && (detail ? <EsunDetailView detail={detail} row={row} info={info} /> : <p className={styles.note}>尚未取得對應的玉山成交明細，請重新查詢。</p>)}
        </>
    );
}

/**
 * 一列已實現損益：商品名稱為主、代碼為次（同自選列）。名稱依序取列本身的 name、玉山成交明細的 stk_na，
 * 都沒有才查合約快取（lib/contract-names：每個不重複代碼最多一次合約查詢，失敗只顯示代碼）。
 * 名稱載入前第一行是代碼、第二行是市場與日期；名稱到達後第一行換成名稱、代碼移到第二行開頭，列高不變。
 */
function PnlRow({ row, info, showDate }: { row: RealizedPnlRow; info: RowInfo; showDate: boolean }) {
    const privMoney = usePrivacyMoney();
    const esun = info.esun;
    const rebate = info.rebate.status === 'ok' ? info.rebate.rebate : null;
    const code = canonicalBrokerCode(String(row.code ?? '')) || String(row.code ?? '');
    const own = (row as { name?: unknown }).name;
    const known = (typeof own === 'string' && own.trim()) || esun.detail?.name || null;
    const lookup = realizedLookupCode(code, row.market);
    const name = useContractName(known ? code : lookup, known);
    const meta = [name ? code : '', MARKET_TEXT[row.market], showDate && row.date ? row.date : ''].filter(Boolean).join(' · ');
    return (
        <div className={styles.pnlItem} data-testid='pnl-row' role='group' aria-label={`${instrumentText(code, name)} 已實現損益`}>
            <div className={styles.pnlRow}>
                <span className={styles.pnlCode}>
                    <span className={styles.pnlName} data-testid='pnl-name'>{name ?? code}</span>
                    <span className={styles.pnlMeta}>{meta}</span>
                </span>
                <span className={styles.pnlQty}>
                    {maskMoney(`${Math.abs(row.quantity).toLocaleString('en-US')}${row.market === 'S' ? '張' : '口'}`, privMoney)}
                </span>
                <span className={`${styles.pnlValue} ${styles.dir[signDir(row.pnl)]}`}>{maskMoney(formatTwd(row.pnl, true), privMoney)}</span>
            </div>
            {rebate !== null && (
                <p className={styles.pnlRebateLine} data-testid='pnl-row-rebate'>
                    {/* 只在「・」處換行：「≈」不與金額拆開 */}
                    <span className={styles.nowrap}>退佣 ≈ {maskMoney(formatTwd(rebate), privMoney)}</span>・<span className={styles.nowrap}>退佣後 ≈ {maskMoney(formatTwd(row.pnl + rebate, true), privMoney)}</span>
                </p>
            )}
            {esun.applies && <EsunRowDetail row={row} info={info} />}
        </div>
    );
}

function PnlRows({ result, infos, showDate }: { result: RealizedPnlResult; infos: readonly RowInfo[]; showDate: boolean }) {
    return (
        <div data-testid='pnl-rows'>
            {result.rows.map((r, i) => <PnlRow key={realizedRowKey(r, i)} row={r} info={infos[i]!} showDate={showDate} />)}
        </div>
    );
}

/** 合計與各市場分項之後的退佣合計、退佣後損益與設定說明；股票列都沒有月退時只顯示提示 */
function RebateSummary({ result, infos, costs }: { result: RealizedPnlResult; infos: readonly RowInfo[]; costs: Record<CostBroker, TradingCostSettings> }) {
    const privMoney = usePrivacyMoney();
    const totals = realizedRebateTotals(infos.map(i => i.rebate));
    const stockRows = result.rows.filter(r => r.market === 'S');
    if (!totals.applies) {
        return stockRows.length > 0 ? <p className={styles.note} data-testid='pnl-rebate-off'>{REBATE_TEXT.off}</p> : null;
    }
    const after = result.total === null ? null : result.total + totals.rebate;
    const brokers = COST_BROKERS.filter(b => stockRows.some(r => brokerOfAccountKey(r.accountKey) === b));
    return (
        <div data-testid='pnl-rebate'>
            <dl className={styles.kv}>
                {/* 標籤已寫「估」：數值不加「≈」（鍵值欄的長數值依 overflowWrap 換行，「≈」單獨落到上一行不好看） */}
                <Item term={REBATE_TEXT.total} testId='pnl-rebate-total'>{maskMoney(formatTwd(totals.rebate), privMoney)}</Item>
                <Item term={REBATE_TEXT.after} className={styles.dir[signDir(after)]} testId='pnl-total-after-rebate'>
                    {after === null ? '—' : maskMoney(formatTwd(after, true), privMoney)}
                </Item>
            </dl>
            {totals.unknown > 0 && <p className={styles.note} role='status' data-testid='pnl-rebate-unknown'>{REBATE_TEXT.unknown(totals.unknown)}</p>}
            <p className={styles.note} data-testid='pnl-rebate-settings'>
                {brokers.map(b => `${COST_BROKER_TEXT[b]}：${costModeText(costs[b])}`).join('｜')}
            </p>
            <p className={styles.note}>{REBATE_TEXT.note}</p>
        </div>
    );
}

export function RealizedPnlCard() {
    const { selectedStock, selectedFutures } = useAccounts();
    const env = useEsunEnvironment();
    const privMoney = usePrivacyMoney();
    const [open, setOpen] = useState(false);
    const [period, setPeriod] = useState<PnlPeriod>('today');
    const [custom, setCustomState] = useState<DateRange | null>(customRange);
    const problemId = useId();
    // 展開時每秒重繪（冷卻倒數）；收合時只需跟上日期變化
    const now = useNow(open ? 1_000 : 60_000);
    const setCustom = (next: DateRange) => {
        customRange = next;
        setCustomState(next);
    };
    const changePeriod = (next: PnlPeriod) => {
        // 第一次切到自訂：帶近 30 天（今天 − 29 到今天）
        if (next === 'custom' && !customRange) setCustom(pnlDateRange('30d', Date.now()));
        setPeriod(next);
    };
    const isCustom = period === 'custom';
    const range: DateRange = period === 'custom' ? (custom ?? pnlDateRange('30d', now)) : pnlDateRange(period, now);
    const problem = isCustom ? customRangeProblem(range.begin, range.end, now) : null;
    const bounds = customRangeBounds(range.end, now);
    const plans = pnlPlans([selectedStock, selectedFutures], range);
    const hasEsun = plans.some(p => isEsunAccount(p.account));
    // 自訂區間不合法：沒有 key（不讀取、「查詢」停用）
    const key = plans.length && !problem
        ? `pnl:${plans.map(p => `${accountKeyOf(p.account)}@${p.begin}~${p.end}`).join('|')}${hasEsun ? `:${env.environment}` : ''}`
        : null;
    const state = useOnDemand<RealizedPnlResult>(key);
    // useNow 只負責每秒重繪；冷卻以快取的時鐘計算（與 loadOnDemand 同一來源）
    const clockNow = onDemandNow();
    const gate = hasEsun ? PNL_ESUN_GATE : undefined;
    const gateLeft = gate ? gateLeftSec(gate, clockNow) : 0;
    const canLoad = !!key && canLoadOnDemand(state, PNL_COOLDOWN_MS, clockNow) && gateLeft === 0;
    const load = () => {
        if (!key) return;
        const snapshot = plans;
        // 冷卻與玉山視窗由 loadOnDemand 在呼叫當下再判斷一次（被擋下時不發請求）
        void loadOnDemand(key, () => fetchRealizedPnl(snapshot), PNL_COOLDOWN_MS, gate);
    };
    const toggle = () => {
        const next = !open;
        setOpen(next);
        // 展開時只在這個區間尚未讀過時讀取一次（之後由「查詢」更新）
        if (next && state.data === null && !state.loading && canLoad) load();
    };
    const result = state.data;
    const money = (v: number | null) => maskMoney(formatTwd(v, true), privMoney);

    // 退佣：各券商設定＋玉山成交明細（卡片層讀 store；hook 無條件呼叫，沒有玉山證券帳戶時傳 null）
    const costs = useBrokerCostSettings();
    const esunPlan = plans.find(p => p.market === 'S' && esunRefOfPnlRow({ market: 'S', accountKey: `${p.account.broker_id}:${p.account.account_id}` }) !== null) ?? null;
    const esunSnapshot = useEsunTransactionDetails(esunPlan ? esunPlan.account : null, esunPlan?.begin ?? '', esunPlan?.end ?? '');
    const infos: RowInfo[] = (result?.rows ?? []).map((row) => {
        const ref = esunRefOfPnlRow(row);
        const applies = !!ref && !!esunPlan && esunPlan.account.broker_id === ref.broker_id && esunPlan.account.account_id === ref.account_id;
        const detail = applies ? findEsunTransactionDetail(esunSnapshot?.details, row) : undefined;
        const settings = costs[brokerOfAccountKey(row.accountKey)];
        return { esun: { applies, detail }, rebate: realizedRowRebate(row, settings, detail), settings };
    });

    return (
        <CollapsibleCard title='已實現損益' open={open} onToggle={toggle} testId='account-pnl'>
            {!plans.length ? (
                <p className={styles.note}>尚未選擇帳戶。</p>
            ) : (
                <>
                    {/* 五個選項放不下等寬分段（360 寬、字級 1.3 時會壓到鄰段）：用換行膠囊 */}
                    <Segmented<PnlPeriod> label='區間' value={period} options={PNL_PERIODS} onChange={changePeriod} testId='pnl-period' variant='wrap' />
                    {isCustom && (
                        <div className={styles.dateFields} data-testid='pnl-custom'>
                            <label className={styles.dateField}>
                                起日
                                <input
                                    type='date'
                                    className={styles.dateInput}
                                    value={range.begin}
                                    min={bounds.beginMin}
                                    max={bounds.beginMax}
                                    aria-invalid={!!problem}
                                    aria-describedby={problem ? problemId : undefined}
                                    onChange={e => setCustom({ begin: e.target.value, end: range.end })}
                                    data-testid='pnl-begin'
                                />
                            </label>
                            <label className={styles.dateField}>
                                迄日
                                <input
                                    type='date'
                                    className={styles.dateInput}
                                    value={range.end}
                                    max={bounds.endMax}
                                    aria-invalid={!!problem}
                                    aria-describedby={problem ? problemId : undefined}
                                    onChange={e => setCustom({ begin: range.begin, end: e.target.value })}
                                    data-testid='pnl-end'
                                />
                            </label>
                        </div>
                    )}
                    {problem ? (
                        <p id={problemId} className={styles.warning} role='status' data-testid='pnl-range-problem'>{problem}</p>
                    ) : (
                        <p className={styles.note} data-testid='pnl-range'>
                            {range.begin === range.end ? range.end : `${range.begin} ～ ${range.end}`}
                            {isCustom ? `（台北日期，共 ${pnlRangeDays(range.begin, range.end)} 天）` : '（台北日期）'}
                        </p>
                    )}
                    {state.loading && !result && <p className={styles.note}>已實現損益查詢中…</p>}
                    {!state.loading && !result && !state.error && !problem && <p className={styles.note} data-testid='pnl-idle'>按「查詢」讀取這個區間的已實現損益。</p>}
                    {result && (
                        <>
                            <div className={styles.totalLine} data-testid='pnl-total'>
                                <span>合計（{result.rows.length} 筆）</span>
                                <span className={`${styles.totalValue} ${styles.dir[signDir(result.total)]}`}>
                                    {result.total === null ? '—' : money(result.total)}
                                </span>
                            </div>
                            {result.markets.length > 1 && (
                                <dl className={styles.kv}>
                                    {result.markets.map(m => (
                                        <Item key={`${m.market}:${m.accountKey}`} term={`${MARKET_TEXT[m.market]}${m.source === 'list' ? '（明細加總）' : ''}`} className={styles.dir[signDir(m.total)]}>
                                            {m.total === null ? '查詢失敗' : money(m.total)}
                                        </Item>
                                    ))}
                                </dl>
                            )}
                            {result.incomplete && <p className={styles.warning} role='status'>部分帳戶查詢失敗，合計只含成功的帳戶。</p>}
                            {result.errors.map(e => <p key={e} className={styles.warning} role='alert'>{e}</p>)}
                            {/* 退佣放在合計與各市場分項之後、逐筆明細之前（合計與分項不被說明文字隔開） */}
                            <RebateSummary result={result} infos={infos} costs={costs} />
                            {result.rows.length === 0
                                ? <p className={styles.note}>這個區間沒有已實現損益。</p>
                                : <PnlRows result={result} infos={infos} showDate={range.begin !== range.end} />}
                        </>
                    )}
                    {state.error && <p className={styles.warning} role='alert'>已實現損益查詢失敗：{state.error}</p>}
                    {hasEsun && (
                        <p className={styles.note} data-testid='pnl-esun-limit'>
                            {!problem && plans.some(p => p.clamped) ? '玉山查詢區間最長 180 天，已自動縮短。' : `玉山已實現損益最長查詢 180 天，每分鐘最多查詢 ${PNL_ESUN_QUERIES_PER_MIN} 次。`}
                        </p>
                    )}
                    <div className={styles.actions}>
                        <span className={styles.note}>資料時間 {formatClock(state.updatedAt)}</span>
                        <RefreshButton
                            label='查詢'
                            loading={state.loading}
                            cooldownSec={state.loading || !key ? 0 : Math.max(cooldownLeftSec(state, PNL_COOLDOWN_MS, clockNow), gateLeft)}
                            disabled={!canLoad}
                            onClick={load}
                            testId='pnl-query'
                        />
                    </div>
                </>
            )}
        </CollapsibleCard>
    );
}
