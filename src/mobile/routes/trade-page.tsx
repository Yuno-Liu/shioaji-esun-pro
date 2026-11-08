// src/mobile/routes/trade-page.tsx — 交易（#/trade/:code；規格 §6.2）
//
// ┌ 標頭：名稱・市場・［可當沖］／大字成交價・漲跌・漲跌%・［漲停／跌停］［參考價］［試撮］
// │       統計格（股票）開 高 均 總／參 低 單 額（期權無「額」；顏色相對參考價）
// │       漲跌停價・非「可當沖」的當沖狀態（股票）或到期月份・時段（期權）
// │       當沖資訊列（components/trade-info）：可當沖／先賣・漲跌停狀態・振幅小條・量比・處置 → 唯讀「籌碼與當沖」面板（延遲載入）
// ├ 週期 Segmented（toggle）［走勢］［1分］［5分］［15分］［60分］［日］＋交易圖表（委託線、成本線、漲跌停、參考價）
// ├ 五檔／明細／公司 Segmented（tabs）＋同列右側［整股｜盤中零股］（股票；明細、公司分頁時隱藏但保留狀態、窄螢幕換行）
// │   （五檔買賣同列：委買量｜買價｜賣價｜委賣量、量條、五檔總量、買賣比與內外盤比）
// │   （公司：components/company/company-tab，切到該分頁才延遲載入並讀 shioaji-data；只導覽與開外部連結，不下單）
// ├ 持倉摘要・未成交 N 筆 ›（#/orders；GroupedSection）
// └［買 進］［賣 出］→ openTicket()（只開下單面板，送單一律經確認面板）；以 ShellSlot bottom 放進底部 chrome
//
// 主價列下緣的哨兵離開 main 頂端時，ShellSlot top 顯示精簡標頭（trade-compact；實心 panel，沒有 IntersectionObserver 時不顯示）。
// 標頭右上的 ☆（trade-watch-star）：開「加入自選」清單選擇面板（components/watch-picker-sheet.tsx，延遲載入），一次加入／移出
// 多個自選清單（殼層常駐的 WatchlistProvider）；aria-pressed＝已在任一清單，無障礙名稱列出所在清單（「自選：已在 主要、觀察」）。
// 清單載入中、更新中、載入失敗、套用中、合約未載入或組合商品時停用（套用中只標 aria-disabled，焦點不掉）；
// 結果以既有通知（lib/trade notify → ToastHost）回報。只改自選，不下單（S1）。
// 標頭的「代碼 名稱」是切換商品鍵（trade-switch；精簡標頭顯示時另有 trade-compact-switch）：開 TradeSwitchSheet 搜尋並切換，
// 以 replace 導覽（返回鍵回到進交易頁之前的畫面）；只做查詢與導覽，不開下單面板。合約載入後記入「最近查看」（lib/recent-codes）。
// code 來自 hash 路由（已過濾不合法代碼）；null＝尚未選商品。合約解析出的正規代碼與路由不同（小寫、舊指數代碼）時改寫路由。
// 交易狀態（委託、持倉）只由葉節點訂閱：圖上的線、五檔的委託標記、持倉摘要（稽核 P2）；持倉市價重估不重繪標頭、五檔與圖表。

import { ChevronDown, Star } from 'lucide-react';
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { useQuote } from '../../hooks/use-stream';
import { contractMarket } from '../../lib/contract-market';
import { ensureContract, useContract } from '../../lib/contracts-cache';
import { sessionWindowFor } from '../../lib/intraday-session';
import { getMarketSnapshot, subscribeMarketSnapshots } from '../../lib/market-snapshot-store';
import { fetchSnapshots } from '../../lib/shioaji';
import { maskMoney, usePrivacyMoney } from '../../lib/privacy';
import { notify } from '../../lib/trade';
import { useTradingState } from '../../lib/trading-state';
import type { ContractInfo, DayTrade, Exchange, SecurityType } from '../../lib/types/contract';
import type { AccountedTrade } from '../../lib/types/order';
import type { AccountedPosition } from '../../lib/types/portfolio';
import { nowWallClockUtc } from '../../lib/utils/kbars';
import { remainingWorkingOrderQuantity } from '../../lib/working-order-quantity';
import { loadCompanyTab } from '../components/company/load-company-tab';
import { loadWatchPickerSheet } from '../components/load-watch-picker-sheet';
import { DepthLadder, depthOddCapable, DepthOddToggle } from '../components/depth-ladder';
import { ModuleErrorBoundary, ModuleLoadError, retryableLazy, SheetLoadError } from '../components/route-error-boundary';
import { TickList } from '../components/tick-list';
import { TradeChart } from '../components/trade-chart';
import { loadTradeChipsSheet } from '../components/trade-info/load-trade-chips-sheet';
import { TradeInfoStrip } from '../components/trade-info/trade-info-strip';
import { useDocumentVisible } from '../components/trade-info/use-document-visible';
import { TradeSwitchSheet } from '../components/trade-switch-sheet';
import { chartPriceLines, formatLinePrice, priceLinesKey } from '../lib/chart-model';
import { CHART_PERIODS, DEFAULT_CHART_PERIOD, isChartPeriod, type ChartPeriod } from '../lib/chart-ranges';
import { createFocusProxy, type FocusProxy } from '../lib/focus-proxy';
import { formatRoute, navigate } from '../lib/hash-router';
import { openTicket, setCurrentCode } from '../lib/mobile-store';
import { fmtCompactInt, fmtInt, fmtStockLots, formatNumber, formatToTick } from '../lib/num-format';
import { headerQuote, headerStats, limitHit, toneVsReference, volumeUnit, type HeaderStats, type HeaderTick } from '../lib/quote-display';
import { recordRecentCode } from '../lib/recent-codes';
import { usePunishedCodes, usePunishedListLoaded } from '../lib/regulatory-punish';
import { orderLists } from '../lib/watch-list-order';
import { useOptionalMobileWatchlist } from '../lib/watchlist-context';
import * as controls from '../styles/controls.css';
import * as layout from '../styles/layout.css';
import { focusRing, pressable } from '../styles/primitives.css';
import { SIZE } from '../styles/tokens';
import * as styles from '../styles/trade.css';
import { GroupedSection } from '../ui/grouped';
import { IconButton } from '../ui/icon-button';
import { InlineNote } from '../ui/inline-note';
import { usePriceFlash } from '../ui/price-flash';
import * as flash from '../ui/price-flash.css';
import { Segmented } from '../ui/segmented';
import { ShellSlot } from '../ui/shell-slots';
import { Skeleton } from '../ui/skeleton';

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

export interface PositionSummary {
    label: string;
    quantity: string;
    avg: number;
    pnl: number;
}

const STOCK_COND_TEXT: Record<string, string> = { Cash: '現股', MarginTrading: '融資', ShortSelling: '融券' };

/** 股票部位標籤：現股空單（當沖先賣＝Cash＋Sell）獨立一列，不與現股多單合併 */
function stockSummaryLabel(cond: string | undefined, direction: string): string {
    const c = cond || 'Cash';
    if (c === 'Cash') return direction === 'Sell' ? '現股空（當沖）' : '現股';
    return STOCK_COND_TEXT[c] ?? (direction === 'Sell' ? '空' : '多');
}

/** 目前商品的持倉摘要（股票依信用條件＋多空、期權依多空分列；數量加總、均價以數量加權） */
export function positionSummaries(orderableCode: string, displayCode: string, positions: readonly AccountedPosition[], isStock: boolean): PositionSummary[] {
    const groups = new Map<string, { qty: number; cost: number; pnl: number }>();
    for (const p of positions) {
        if (p.code !== orderableCode && p.code !== displayCode) continue;
        if (!(p.quantity > 0)) continue;
        const cond = 'cond' in p && typeof p.cond === 'string' ? p.cond : undefined;
        const label = isStock
            ? stockSummaryLabel(cond, p.direction)
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

const PERIOD_ITEMS = CHART_PERIODS.map(p => ({ value: p.key, label: p.label }));
type PanelKey = 'depth' | 'ticks' | 'company';
const PANEL_ITEMS = [
    { value: 'depth', label: '五檔' },
    { value: 'ticks', label: '明細' },
    { value: 'company', label: '公司', testId: 'trade-panel-company' },
] as const;

// 「公司」分頁（公司資料、產業鏈、營收、題材、上下游、來源）：只有切到這個分頁才 import 並開始讀 shioaji-data，
// 不閒置預載、不增加首屏體積。載入失敗只在分頁內容區顯示「載入失敗」＋［重試］（retryableLazy 換新的 lazy 重新 import）。
const CompanyTab = retryableLazy(() => loadCompanyTab().then(m => m.CompanyTab), 'CompanyTab');
const resetCompanyTab = () => { CompanyTab.reset(); };

// 「籌碼與當沖」說明面板（唯讀）：第一次點當沖資訊列才 import，不閒置預載；融資融券與券源的讀取也在面板模組內。
const TradeChipsSheet = retryableLazy(() => loadTradeChipsSheet().then(m => m.TradeChipsSheet), 'TradeChipsSheet');
const resetChipsSheet = () => { TradeChipsSheet.reset(); };

// ☆「加入自選」清單選擇面板：第一次按 ☆ 才 import，不閒置預載；第一次開啟後保持掛載（開關動畫正常）。
// 載入失敗以底部面板「載入失敗」＋［重試］顯示（SheetLoadError），可關閉。
const WatchPickerSheet = retryableLazy(() => loadWatchPickerSheet().then(m => m.WatchPickerSheet), 'WatchPickerSheet');
const resetWatchPicker = () => { WatchPickerSheet.reset(); };

type StatKey = 'open' | 'high' | 'low' | 'reference' | 'avg' | 'total' | 'last' | 'amount';

const STAT_LABEL: Record<StatKey, string> = { open: '開', high: '高', low: '低', reference: '參', avg: '均', total: '總', last: '單', amount: '額' };
const STAT_NAME: Record<StatKey, string> = { open: '開盤', high: '最高', low: '最低', reference: '參考價', avg: '均價', total: '總量', last: '單量', amount: '成交金額' };

/** 統計格的欄位與順序（4 欄、列優先）：股票 開 高 均 總／參 低 單 額；期權 開 高 均 總／參 低 單；指數 開 高 低 參 */
export function statKeys(secType: SecurityType | undefined): StatKey[] {
    if (secType === 'STK' || secType === 'WRT') return ['open', 'high', 'avg', 'total', 'reference', 'low', 'last', 'amount'];
    if (secType === 'FUT' || secType === 'OPT') return ['open', 'high', 'avg', 'total', 'reference', 'low', 'last'];
    return ['open', 'high', 'low', 'reference'];
}

/** 交易頁持倉摘要是否以股票單位（張／股、現股／融資／融券）顯示：證券市場商品（STK、WRT，lib contractMarket） */
export function summaryUsesStockUnits(secType: SecurityType | undefined): boolean {
    return contractMarket(secType) === 'S';
}

const fmtAvg = (v: number) => formatNumber(v, 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function StatsGrid({ contract, stats }: { contract: ContractInfo; stats: HeaderStats }) {
    const unit = volumeUnit(contract.security_type);
    const price = (v: number | null) => (v === null ? '—' : formatToTick(contract, v));
    const vol = (v: number | null) => (v === null ? '—' : `${fmtCompactInt(v)}${unit}`);
    const value: Record<StatKey, { text: string; tone: 'up' | 'down' | 'flat' }> = {
        open: { text: price(stats.open), tone: toneVsReference(stats.open, stats.reference) },
        high: { text: price(stats.high), tone: toneVsReference(stats.high, stats.reference) },
        low: { text: price(stats.low), tone: toneVsReference(stats.low, stats.reference) },
        reference: { text: price(stats.reference), tone: 'flat' },
        avg: { text: stats.avg === null ? '—' : fmtAvg(stats.avg), tone: toneVsReference(stats.avg, stats.reference) },
        total: { text: vol(stats.totalVolume), tone: 'flat' },
        last: { text: vol(stats.lastVolume), tone: 'flat' },
        amount: { text: stats.totalAmount === null ? '—' : fmtCompactInt(stats.totalAmount), tone: 'flat' },
    };
    return (
        <dl className={styles.statsGrid} data-testid='trade-stats'>
            {statKeys(contract.security_type).map(k => (
                <div key={k} className={styles.statCell} data-testid={`trade-stat-${k}`}>
                    <dt className={styles.statLabel} title={STAT_NAME[k]}>{STAT_LABEL[k]}</dt>
                    <dd className={`${styles.statValue} ${styles.dirText[value[k].tone]}`}>{value[k].text}</dd>
                </div>
            ))}
        </dl>
    );
}

/** 哨兵是否已捲出 main 頂端（在根範圍之上、不相交）；捲到下方看不到時不算 */
export function scrolledPast(entry: { isIntersecting: boolean; boundingClientRect: { top: number }; rootBounds: { top: number } | null }): boolean {
    return !entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds ? entry.rootBounds.top : 0);
}

/**
 * 精簡標頭：哨兵（主價列下緣）離開 main 頂端時顯示。
 * available＝環境支援 IntersectionObserver 且哨兵已掛上（測試、舊瀏覽器為 false → 不渲染精簡標頭）。
 */
function useCompactHeader(sentinel: { current: HTMLElement | null }): { available: boolean; visible: boolean } {
    const [available, setAvailable] = useState(false);
    const [visible, setVisible] = useState(false);
    const rootRef = useRef<HTMLElement | null>(null);
    useEffect(() => {
        const el = sentinel.current;
        if (!el || typeof IntersectionObserver !== 'function') return undefined;
        // main 是唯一的捲動容器（殼層）；找不到時以 viewport 為根
        const root = typeof el.closest === 'function' ? el.closest('main') : null;
        rootRef.current = root;
        let observer: IntersectionObserver;
        try {
            observer = new IntersectionObserver(entries => {
                const last = entries[entries.length - 1];
                if (last) setVisible(scrolledPast(last));
            }, { root });
            observer.observe(el);
        } catch {
            return undefined;
        }
        setAvailable(true);
        return () => observer.disconnect();
    }, [sentinel]);
    // 精簡標頭顯示期間（疊在 main 頂端 SIZE.compactBarH），main 的 scroll-padding-top 讓出它：
    // scrollIntoView、焦點移動不會把元素停在精簡標頭後面（底部 chrome 由 layout.css.ts 的 scroll-padding-bottom 讓出）。
    useEffect(() => {
        const main = rootRef.current;
        if (!visible || typeof main?.style?.setProperty !== 'function') return undefined;
        main.style.setProperty('scroll-padding-top', SIZE.compactBarH);
        return () => { main.style.removeProperty('scroll-padding-top'); };
    }, [visible]);
    return { available, visible };
}

interface SwitchEntry {
    /** 開切換商品面板（必須在點擊的同步呼叫內：代理輸入框要在手勢內聚焦） */
    onOpenSwitch?: () => void;
    switchOpen?: boolean;
    /** 標頭切換鍵（trade-switch）的 ref：選了其他商品、面板退場結束後把焦點放回新頁的這顆鍵 */
    switchRef?: Ref<HTMLButtonElement>;
}

/** 當沖資訊列（標頭最下方）：處置名單與「籌碼與當沖」面板狀態由 TradeView 持有 */
interface InfoEntry {
    punished: boolean | null;
    open: boolean;
    onOpen: () => void;
}

/** 自選 ☆ 停用時的原因（寫進無障礙名稱）；可操作時 null */
export function watchStarBlocked(
    wl: { loading: boolean; structureBusy: boolean; loadError: boolean },
    contract: Pick<ContractInfo, 'combo'> | undefined,
    busy: boolean,
): string | null {
    if (!contract) return '商品載入中';
    if (contract.combo) return '組合商品不能加入自選';
    if (wl.loadError) return '自選清單載入失敗';
    if (busy || wl.loading || wl.structureBusy) return '自選清單更新中';
    return null;
}

/** 含這個商品的清單（serverLists[].contracts 以代碼＋商品類別比對） */
export function listsWithContract<L extends { contracts: readonly { code: string; security_type: string | null }[] }>(
    lists: readonly L[],
    contract: Pick<ContractInfo, 'code' | 'security_type'> | undefined,
): L[] {
    return contract ? lists.filter(l => l.contracts.some(c => c.code === contract.code && c.security_type === contract.security_type)) : [];
}

/** ☆ 的無障礙名稱：所在清單（或未加入），停用時附原因 */
export function watchStarLabel(names: readonly string[], blocked: string | null): string {
    return `自選：${names.length ? `已在 ${names.join('、')}` : '未加入'}${blocked ? `，${blocked}` : ''}`;
}

/** 標頭 ☆：開「加入自選」清單選擇面板（一次加入／移出多個清單）。不在 WatchlistProvider 內（測試、獨立掛載）時不顯示 */
function WatchStar({ contract }: { contract: ContractInfo | undefined }) {
    const wl = useOptionalMobileWatchlist();
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    /** 面板第一次要求開啟後保持掛載 */
    const [sheetMounted, setSheetMounted] = useState(false);
    const mounted = useRef(true);
    // StrictMode 會模擬卸載再掛載：掛載時要設回 true，否則之後 setBusy(false) 永遠不執行（☆ 一直停用）
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const onBusy = useCallback((b: boolean) => { if (mounted.current) setBusy(b); }, []);
    const close = useCallback(() => setOpen(false), []);
    if (!wl) return null;
    // 所在清單的名稱依這台裝置的群組順序（lib/watch-list-order.ts）
    const inLists = listsWithContract(orderLists(wl.serverLists), contract);
    const blocked = watchStarBlocked(wl, contract, busy);
    return (
        <>
            <span className={styles.watchStar}>
                <IconButton
                    ariaLabel={watchStarLabel(inLists.map(l => l.name), blocked)}
                    icon={Star}
                    pressed={inLists.length > 0}
                    // 套用中只標 aria-disabled（不設 disabled，按的人焦點不會掉）；點擊由 blocked 檢查忽略
                    disabled={blocked !== null && !busy}
                    ariaDisabled={busy}
                    onClick={() => {
                        if (blocked) return;
                        setSheetMounted(true);
                        setOpen(true);
                    }}
                    testId='trade-watch-star'
                />
            </span>
            {sheetMounted && contract && (
                <ModuleErrorBoundary
                    onRetry={resetWatchPicker}
                    fallback={props => <SheetLoadError {...props} open={open} onClose={close} testId='watch-picker-load-error' />}
                >
                    <Suspense fallback={null}>
                        <WatchPickerSheet open={open} contract={contract} wl={wl} onClose={close} onBusy={onBusy} />
                    </Suspense>
                </ModuleErrorBoundary>
            )}
        </>
    );
}

function Header({ code, contract, onOpenSwitch, switchOpen = false, switchRef, info }: { code: string; contract: ContractInfo | undefined; info?: InfoEntry } & SwitchEntry) {
    const quote = useQuote(code, { narrow: true });
    const tick = quote?.tick;
    // 試撮期間仍以本頁看過的上一筆真實成交為最新價
    const lastReal = useRef<HeaderTick | undefined>(undefined);
    if (tick && !tick.simtrade) lastReal.current = tick;
    const snapshot = useSyncExternalStore(subscribeMarketSnapshots, () => (contract ? getMarketSnapshot(contract) : undefined));
    const input = { reference: contract?.reference, tick, index: quote?.index, lastRealTick: lastReal.current, snapshot };
    const q = headerQuote(input);
    const stats = headerStats(input);
    const price = q.price;
    const chg = q.change !== null ? { change: q.change, pct: q.pct, dir: q.dir } : null;
    const isStock = contract?.security_type === 'STK';
    const isFop = contract?.security_type === 'FUT' || contract?.security_type === 'OPT';
    const fmt = (p: number) => (contract ? formatToTick(contract, p) : String(p));
    const arrow = chg?.dir === 'up' ? '▲' : chg?.dir === 'down' ? '▼' : '';
    // 「可當沖」放徽章；其他狀態（僅先買後賣、不可當沖）以文字放資訊列
    const dayTrade = contract && isStock && contract.day_trade !== 'Yes' ? dayTradeText(contract.day_trade) : null;
    const delivery = contract && isFop ? deliveryMonthText(contract.delivery_month) : null;
    // 只有成交或快照的價格才判斷漲跌停（參考價不算）
    const limit = contract && (q.source === 'tick' || q.source === 'snapshot') ? limitHit(price, contract.limit_up, contract.limit_down) : null;
    const priceText = price !== null ? fmt(price) : '—';
    const changeText = chg ? `${arrow}${contract && price !== null ? formatToTick(contract, Math.abs(chg.change), { at: price }) : Math.abs(chg.change)}` : null;
    const pctText = chg && chg.pct !== null ? ` (${chg.pct > 0 ? '+' : ''}${chg.pct.toFixed(2)}%)` : null;
    const title = `${code}${contract?.name ? ` ${contract.name}` : ''}`;
    const switchLabel = `切換商品，目前 ${title}`;

    // 主價跳價閃爍（資料來源切換那一筆不閃）
    const flashRef = useRef<HTMLSpanElement | null>(null);
    usePriceFlash(flashRef, price, { source: q.source });
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const compact = useCompactHeader(sentinelRef);

    return (
        <header className={styles.header}>
            <div className={styles.headTop}>
                <div className={styles.headMain}>
                    <div className={styles.titleRow}>
                        <h1 className={styles.title}>
                            {onOpenSwitch
                                ? (
                                    <button
                                        ref={switchRef}
                                        type='button'
                                        className={`${styles.titleButton} ${pressable} ${focusRing}`}
                                        onClick={() => onOpenSwitch()}
                                        aria-haspopup='dialog'
                                        aria-expanded={switchOpen}
                                        aria-label={switchLabel}
                                        data-testid='trade-switch'
                                    >
                                        {title}
                                        <ChevronDown className={styles.titleIcon} aria-hidden='true' focusable='false' />
                                    </button>
                                )
                                : title}
                        </h1>
                        {contract && <span className={styles.subtle}>{exchangeText(contract.exchange)}</span>}
                        {contract && isStock && contract.day_trade === 'Yes' && <span className={styles.badge} data-testid='trade-daytrade'>可當沖</span>}
                    </div>
                    <div className={styles.priceRow} data-testid='trade-price'>
                        <span className={`${styles.lastPrice} ${styles.dirText[chg?.dir ?? 'flat']}`}>
                            <span ref={flashRef} className={flash.overlay} aria-hidden='true' />
                            {priceText}
                        </span>
                        {q.source === 'reference' && <span className={styles.badge} data-testid='trade-price-reference'>參考價</span>}
                        {chg && (
                            <span className={`${styles.change} ${styles.dirText[chg.dir]}`}>
                                {changeText}
                                {pctText}
                            </span>
                        )}
                        {limit && (
                            <span className={`${styles.badge} ${styles.badgeTone[limit]}`} data-testid='trade-limit'>
                                {limit === 'up' ? '漲停' : '跌停'}
                            </span>
                        )}
                        {q.sim && (
                            <span className={styles.badge} title='試撮揭示價，非成交價' data-testid='trade-simtrade'>
                                試撮 {fmt(q.sim.price)}
                            </span>
                        )}
                    </div>
                </div>
                <WatchStar contract={contract} />
            </div>
            <div ref={sentinelRef} className={styles.sentinel} aria-hidden='true' />
            {compact.available && (
                <ShellSlot slot='top'>
                    {/* 視覺輔助（與標頭重複）：不進無障礙樹；隱藏時不攔點擊 */}
                    <div className={styles.compactBar} data-visible={compact.visible ? 'true' : 'false'} aria-hidden='true' data-testid='trade-compact'>
                        <span className={styles.compactTitle}>{title}</span>
                        {onOpenSwitch && <ChevronDown className={styles.compactIcon} aria-hidden='true' focusable='false' />}
                        <span className={`${styles.compactPrice} ${styles.dirText[chg?.dir ?? 'flat']}`}>{priceText}</span>
                        {changeText !== null && chg && (
                            <span className={`${styles.compactChange} ${styles.dirText[chg.dir]}`}>{changeText}{pctText}</span>
                        )}
                    </div>
                    {/* 切換商品鍵在 aria-hidden 的精簡標頭之外（可被輔助技術讀到）；精簡標頭隱藏時不渲染（不可聚焦、不可點） */}
                    {onOpenSwitch && compact.visible && (
                        <button
                            type='button'
                            className={styles.compactSwitch}
                            onClick={() => onOpenSwitch()}
                            aria-haspopup='dialog'
                            aria-expanded={switchOpen}
                            aria-label={switchLabel}
                            data-testid='trade-compact-switch'
                        />
                    )}
                </ShellSlot>
            )}
            {contract && <StatsGrid contract={contract} stats={stats} />}
            {contract && isStock && (contract.limit_up > 0 || contract.limit_down > 0 || dayTrade) && (
                <div className={styles.infoRow} data-testid='trade-info'>
                    {contract.limit_up > 0 && <span className={styles.infoUp}>漲停 {fmt(contract.limit_up)}</span>}
                    {contract.limit_down > 0 && <span className={styles.infoDown}>跌停 {fmt(contract.limit_down)}</span>}
                    {dayTrade && <span>{dayTrade}</span>}
                </div>
            )}
            {contract && isFop && (
                <div className={styles.infoRow} data-testid='trade-info'>
                    {delivery && <span>到期 {delivery}</span>}
                    <span>{sessionText(contract.security_type, nowWallClockUtc())}</span>
                </div>
            )}
            {/* 當沖資訊列：一般文件流、在統計格與漲跌停列之下；點擊只開唯讀說明面板（S1） */}
            {contract && info && (
                <TradeInfoStrip
                    code={code}
                    contract={contract}
                    price={price}
                    priceIsTrade={q.source === 'tick' || q.source === 'snapshot'}
                    quoteRef={(q.source === 'tick' || q.source === 'snapshot') && q.price !== null && q.change !== null && q.price - q.change > 0 ? q.price - q.change : undefined}
                    stats={stats}
                    tickDate={stats.source === 'tick' ? (tick && !tick.simtrade ? tick : lastReal.current)?.date : undefined}
                    snapshot={snapshot}
                    punished={info.punished}
                    open={info.open}
                    onOpen={info.onOpen}
                />
            )}
        </header>
    );
}

// ---- 交易狀態的葉節點（稽核 P2）----
// 交易狀態每次發布（持倉市價重估最多每 50ms 一次）只重繪這三個葉節點；它們把結果傳給 memo 的圖表與五檔，
// 內容沒變（委託未變、線的價位與標籤未變）時圖表與五檔不重繪。

const MemoTradeChart = memo(TradeChart);
const MemoDepthLadder = memo(DepthLadder);

/** 圖上的水平線（委託、成本、漲跌停、參考價）：線的內容（priceLinesKey）沒變時沿用同一個陣列 */
function TradeChartWithLines({ code, contract, period, onPeriodChange }: { code: string; contract: ContractInfo; period: ChartPeriod; onPeriodChange: (p: ChartPeriod) => void }) {
    const { trades, positions } = useTradingState();
    const lines = useMemo(() => chartPriceLines({ contract, trades, positions }), [contract, trades, positions]);
    const linesKey = priceLinesKey(lines);
    // 只依內容 key 換陣列：持倉市價重估時成本線不變，圖表不必重繪
    const stableLines = useMemo(() => lines, [linesKey]); // eslint-disable-line react-hooks/exhaustive-deps
    return <MemoTradeChart code={code} contract={contract} period={period} lines={stableLines} onPeriodChange={onPeriodChange} />;
}

/** 五檔：只把委託（trades）交給五檔畫「我 買2」標記；持倉重估不改 trades，五檔不因此重繪 */
function DepthWithTrades({ code, contract, oddLot }: { code: string; contract: ContractInfo | undefined; oddLot: boolean }) {
    const { trades } = useTradingState();
    return <MemoDepthLadder code={code} contract={contract} trades={trades} oddLot={oddLot} />;
}

/** 持倉摘要與未成交筆數：唯一需要跟著持倉市價重估更新的區塊 */
function TradePositionSummary({ orderable, sym, isStock }: { orderable: string; sym: string; isStock: boolean }) {
    const { trades, positions } = useTradingState();
    const privMoney = usePrivacyMoney();
    const summaries = useMemo(() => positionSummaries(orderable, sym, positions, isStock), [orderable, sym, positions, isStock]);
    const working = useMemo(() => workingOrderCount(orderable, trades), [orderable, trades]);
    return (
        <div className={styles.summaryWrap}>
            <GroupedSection testId='trade-summary'>
                {summaries.length === 0
                    ? <span className={`${styles.summaryRow} ${styles.summaryMuted}`}>持倉：無</span>
                    : summaries.map(s => (
                        <span key={s.label} className={styles.summaryRow}>
                            <span>
                                持倉：{s.label} {maskMoney(s.quantity, privMoney)} · 均價 {formatLinePrice(s.avg)} ·{' '}
                                <span className={styles.dirText[s.pnl > 0 ? 'up' : s.pnl < 0 ? 'down' : 'flat']}>
                                    {maskMoney(`${s.pnl > 0 ? '+' : ''}${fmtInt(Math.round(s.pnl))}`, privMoney)}
                                </span>
                            </span>
                        </span>
                    ))}
                {/* 外層承接卡片髮絲線，連結的 ::after 只當按壓層（見 trade.css.ts workingLinkRow） */}
                <div className={styles.workingLinkRow}>
                    <a className={styles.workingLink} href={formatRoute({ name: 'orders' })} data-testid='trade-working-link'>
                        未成交：{working} 筆 ›
                    </a>
                </div>
            </GroupedSection>
        </div>
    );
}

function TradeView({ code, onOpenSwitch, switchOpen, switchRef }: { code: string } & SwitchEntry) {
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

    // 路由接受小寫、舊指數代碼等非正規寫法：合約解析後改用正規代碼（報價、成交、目前商品都以正規代碼比對）
    const canonical = contract?.code;
    useEffect(() => {
        if (!canonical) return;
        if (canonical !== code) navigate({ name: 'trade', code: canonical }, { replace: true });
        setCurrentCode(canonical);
    }, [canonical, code]);
    const sym = canonical ?? code;

    // 最近查看：合約資訊載入後記錄目前商品（非正規代碼的頁面會改寫路由後重新掛載，由那一頁記錄）
    const contractName = contract?.name ?? '';
    const contractType = contract?.security_type ?? undefined;
    useEffect(() => {
        if (!canonical || canonical !== code) return;
        recordRecentCode({ code: canonical, name: contractName, securityType: contractType });
    }, [canonical, code, contractName, contractType]);

    // 報價快照：沒有即時成交（夜間、週末、冷門商品、試撮中）時標頭以它顯示最新價。
    // 回前景後由 ResumeGate ④ 以目前商品（正規代碼）重新取快照、寫入同一個快照 store，這裡不重複查詢。
    const contractRef = useRef(contract);
    contractRef.current = contract;
    useEffect(() => {
        const ct = contractRef.current;
        // 非正規代碼的頁面會改寫路由後以正規代碼重新掛載，由那一頁查詢
        if (!canonical || !ct || canonical !== code) return;
        fetchSnapshots([ct]).catch(() => undefined);
    }, [canonical, code]);

    // 交易狀態（委託、持倉）不在這裡訂閱：持倉商品每筆成交都會重估市價並發布，整頁重繪會連帶標頭、五檔、圖表外框。
    // 改由需要它的葉節點各自訂閱（圖上的線、五檔的委託標記、持倉摘要；稽核 P2）。
    const [period, setPeriodState] = useState<ChartPeriod>(loadPeriod);
    const setPeriod = useCallback((p: ChartPeriod) => { setPeriodState(p); savePeriod(p); }, []);
    const [panel, setPanelState] = useState<PanelKey>('depth');
    // 公司分頁第一次切入後保持掛載（切走只隱藏）：子分頁、展開狀態不重設，也不重新讀取；換商品時整頁重建而重設
    // 隱藏時傳 active=false：公司分頁不再跟著成交重繪（不和五檔、圖表搶主執行緒）
    const [companyMounted, setCompanyMounted] = useState(false);
    const setPanel = (p: PanelKey) => {
        setPanelState(p);
        if (p === 'company') setCompanyMounted(true);
    };
    // 五檔整股／盤中零股：放在本頁（切到明細再回來不重設）；換商品時整頁重建而重設為整股
    const [oddLot, setOddLot] = useState(false);

    const orderable = contract ? contract.target_code || contract.code : sym;
    const isStock = summaryUsesStockUnits(contract?.security_type);
    const tradable = contract ? contract.security_type !== 'IND' : true;
    const comboNote = contract?.combo ? '組合商品不支援手機下單' : null;

    // 當沖資訊列的處置徽章：只有股票、且頁面在前景時讀處置名單（與自選頁共用模組層快取，30 分鐘內 0 次）
    const isStk = contract?.security_type === 'STK';
    const pageVisible = useDocumentVisible();
    const punishedCodes = usePunishedCodes(isStk && pageVisible);
    // 名單還沒成功取得過：null（面板寫「處置名單尚未取得」，不當成未處置）
    const punishLoaded = usePunishedListLoaded();
    const punished = isStk && contract && punishLoaded ? punishedCodes.has(contract.code) : null;
    // 「籌碼與當沖」面板：第一次點資訊列才載入並掛載（換商品時整頁重建而關閉）
    const [infoOpen, setInfoOpen] = useState(false);
    const [infoMounted, setInfoMounted] = useState(false);
    const openInfo = useCallback(() => {
        setInfoMounted(true);
        setInfoOpen(true);
    }, []);
    const closeInfo = useCallback(() => setInfoOpen(false), []);
    const info: InfoEntry = { punished, open: infoOpen, onOpen: openInfo };

    return (
        <section className={styles.page} data-testid='page-trade'>
            <Header code={sym} contract={contract} onOpenSwitch={onOpenSwitch} switchOpen={switchOpen} switchRef={switchRef} info={info} />

            <div className={styles.controlRow}>
                <div className={styles.controlGrow}>
                    <Segmented items={PERIOD_ITEMS} value={period} onChange={setPeriod} semantics='toggle' ariaLabel='圖表週期' size='compact' />
                </div>
            </div>

            {contract
                ? <TradeChartWithLines code={sym} contract={contract} period={period} onPeriodChange={setPeriod} />
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

            <div className={styles.panelRow} data-testid='trade-panel-row'>
                <div className={styles.panelTabs}>
                    <Segmented<PanelKey> items={PANEL_ITEMS} value={panel} onChange={setPanel} semantics='tabs' ariaLabel='五檔、明細與公司' size='compact' />
                </div>
                {depthOddCapable(contract) && (
                    <div className={styles.oddToggleSlot}>
                        {panel === 'depth' && <DepthOddToggle oddLot={oddLot} onChange={setOddLot} />}
                    </div>
                )}
            </div>
            {panel === 'depth' && <DepthWithTrades code={sym} contract={contract} oddLot={oddLot} />}
            {panel === 'ticks' && contract && <TickList code={sym} contract={contract} />}
            {companyMounted && (
                <div hidden={panel !== 'company'} data-testid='trade-company'>
                    <ModuleErrorBoundary onRetry={resetCompanyTab} fallback={props => <ModuleLoadError {...props} testId='company-load-error' />}>
                        <Suspense fallback={<Skeleton label='公司資料載入中…' rows={5} testId='company-module-loading' />}>
                            <CompanyTab contract={contract} active={panel === 'company'} />
                        </Suspense>
                    </ModuleErrorBoundary>
                </div>
            )}

            <TradePositionSummary orderable={orderable} sym={sym} isStock={isStock} />

            {infoMounted && contract && (
                <ModuleErrorBoundary
                    onRetry={resetChipsSheet}
                    fallback={props => <SheetLoadError {...props} open={infoOpen} onClose={closeInfo} testId='trade-chips-load-error' />}
                >
                    <Suspense fallback={null}>
                        <TradeChipsSheet open={infoOpen} onClose={closeInfo} contract={contract} punished={punished} />
                    </Suspense>
                </ModuleErrorBoundary>
            )}

            {tradable && (
                <ShellSlot slot='bottom'>
                    <div className={styles.tradeBar}>
                        {comboNote && <InlineNote tone='warn' role='note'>{comboNote}</InlineNote>}
                        <div className={controls.tradeButtonRow}>
                            <button
                                type='button'
                                className={`${controls.tradeButton.buy} ${styles.tradeButtonSize}`}
                                disabled={!!comboNote}
                                onClick={() => openTicket({ code: sym, action: 'Buy', source: 'button' })}
                                data-testid='trade-buy'
                            >
                                買 進
                            </button>
                            <button
                                type='button'
                                className={`${controls.tradeButton.sell} ${styles.tradeButtonSize}`}
                                disabled={!!comboNote}
                                onClick={() => openTicket({ code: sym, action: 'Sell', source: 'button' })}
                                data-testid='trade-sell'
                            >
                                賣 出
                            </button>
                        </div>
                    </div>
                </ShellSlot>
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
    return <TradeWithSwitch code={code} />;
}

function activeElementOrNull(): Element | null {
    try {
        return typeof document === 'undefined' ? null : document.activeElement;
    } catch {
        return null;
    }
}

/**
 * 選了其他商品、面板退場結束後把焦點放到新頁的切換鍵：目標要仍連到文件、不在 inert／aria-hidden 區；
 * 焦點已被使用者移到別處就不搶（只在焦點落在 body、已卸載的節點或已關閉面板之內時移動）。
 */
function focusSwitchKey(el: HTMLButtonElement | null): void {
    const t = el as (HTMLButtonElement & { isConnected?: boolean }) | null;
    if (!t || t.isConnected !== true || t.closest?.('[inert], [aria-hidden="true"]')) return;
    const active = activeElementOrNull() as (Element & { isConnected?: boolean }) | null;
    const bodyEl = typeof document === 'undefined' ? null : document.body;
    const stray = !active || active === bodyEl || active.isConnected === false || !!active.closest?.('[inert], [aria-hidden="true"]');
    if (!stray) return;
    try {
        t.focus({ preventScroll: true });
    } catch {
        // 忽略
    }
}

/**
 * 交易頁＋切換商品面板。面板放在 TradeView 之外：切換後 TradeView 以新代碼重建，面板照常播放退場動畫。
 * 焦點：選了其他商品時，BottomSheet 記下的觸發鍵（舊頁的切換鍵）已隨舊 TradeView 卸載、無法還原；改在面板退場結束
 * （onExited，殼層已解除 inert）且頁面已換成新代碼後，把焦點移到新頁的切換鍵。取消、點暗化幕、點目前商品沿用 BottomSheet 的還原。
 */
function TradeWithSwitch({ code }: { code: string }) {
    const [switchOpen, setSwitchOpen] = useState(false);
    const [sheetMounted, setSheetMounted] = useState(false);
    const openRef = useRef(false);
    const proxyRef = useRef<FocusProxy | null>(null);
    const switchRef = useRef<HTMLButtonElement | null>(null);
    // 選了其他商品：記下原代碼；退場結束（exited）且已換成新代碼才移焦點（兩者先後不定：同步模式退場先結束）
    const refocusRef = useRef<{ from: string; exited: boolean } | null>(null);
    const codeRef = useRef(code);

    const tryRefocus = useCallback(() => {
        const r = refocusRef.current;
        if (!r || !r.exited || codeRef.current === r.from) return;
        refocusRef.current = null;
        focusSwitchKey(switchRef.current);
    }, []);
    useEffect(() => {
        codeRef.current = code;
        tryRefocus();
    }, [code, tryRefocus]);
    const onSheetExited = useCallback(() => {
        const r = refocusRef.current;
        if (!r) return;
        r.exited = true;
        tryRefocus();
    }, [tryRefocus]);

    const releaseProxy = useCallback(() => {
        const proxy = proxyRef.current;
        proxyRef.current = null;
        proxy?.release();
    }, []);
    // 卸載時移除仍在的代理輸入框
    useEffect(() => releaseProxy, [releaseProxy]);

    const openSwitch = useCallback(() => {
        if (openRef.current) return;
        openRef.current = true;
        refocusRef.current = null; // 退場中又開啟：不再移焦點（BottomSheet 從目前位置反向進場）
        releaseProxy();
        const proxy = createFocusProxy();
        proxyRef.current = proxy;
        // 先同步提交面板（BottomSheet 進場時會把焦點放到標題），再於同一個手勢內聚焦代理輸入框，iOS 才會叫出鍵盤
        flushSync(() => {
            setSheetMounted(true);
            setSwitchOpen(true);
        });
        proxy?.engage();
    }, [releaseProxy]);

    const closeSwitch = useCallback(() => {
        openRef.current = false;
        releaseProxy();
        setSwitchOpen(false);
    }, [releaseProxy]);

    // replace：返回鍵回到進交易頁之前的畫面；目前商品（ui.currentCode）由 app.tsx 的路由 effect 與 TradeView 的正規代碼 effect 更新
    const selectCode = useCallback((next: string) => {
        refocusRef.current = { from: code, exited: false };
        closeSwitch();
        navigate({ name: 'trade', code: next }, { replace: true });
    }, [closeSwitch, code]);

    return (
        <>
            {/* 換商品時整頁重建（圖表、五檔、明細內部狀態一併重設） */}
            <TradeView key={code} code={code} onOpenSwitch={openSwitch} switchOpen={switchOpen} switchRef={switchRef} />
            {sheetMounted && (
                <TradeSwitchSheet
                    open={switchOpen}
                    onClose={closeSwitch}
                    currentCode={code}
                    onSelect={selectCode}
                    focusProxy={proxyRef}
                    onExited={onSheetExited}
                />
            )}
        </>
    );
}
