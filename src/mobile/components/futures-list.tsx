// src/mobile/components/futures-list.tsx — 自選清單最後的兩個固定清單「股期近月」「股期遠月」（使用者要求；設計規格 §7.2）
//
// - 延遲載入（lib/deferred-modules.ts loadFuturesList）：只在選了固定清單分頁時掛載；首屏只有兩個分頁標籤與 lazy 入口。
// - 資料：lib/futures-lists.ts（fetchFutures({}) 一次取回全部期貨，依台北日期快取；一般＋小型股票期貨的 R1／R2 對到實際月份）。
//   讀取中 Skeleton、失敗 InlineNote＋［重試］、沒有資料 EmptyState。分頁停留跨過台北午夜時重新讀取（換到新的近月／遠月）。
// - 不存到永豐伺服器、不能編輯（同「持倉」分段）：沒有「＋」、編輯、多選、排序群組、移除；
//   點列 → 交易頁；長按 → 只有「開啟交易頁」「買進…」「賣出…」；快速下單鍵與買賣只呼叫 openTicket（只開下單面板，
//   之後仍需預覽與滑動確認，設計規格 §10 S1）。
// - 列代碼是實際月份合約（例如 CDFK6，不用 CDFR1）：交易頁、下單面板、五檔與確認面板顯示的就是實際送出的合約。
//   開交易頁或下單面板前，若合約快取還沒有這檔，以清單資料 primeContract（同桌面 stock-futures-panel、flash-link-host），
//   交易頁與下單面板的 ensureContract 直接命中，不發合約解析請求；只為使用者點的那一檔放入，不會把 300 檔都放進快取
//   （contracts-cache 的 refreshCachedContracts 會逐檔重新解析快取內的合約）。
// - 請求：清單資料每個台北日 1 次（兩個分頁共用）；開啟清單時 1 次批次快照（lib fetchSnapshots，≤500 檔一批；
//   列的價格備援，同自選清單載入時的快照，也是股價類排序的依據）；每列 0 個合約請求（名稱、參考價取自清單資料，
//   不經 useQuote → ensureContract）；行情只為可見列訂閱 Tick（retainQuote，不訂 BidAsk），迷你走勢依設定、只為可見列讀取。
//   約 300 列：捲動中進入可見範圍的列先不算可見，捲動停下 SCROLL_SETTLE_MS 後才訂閱、讀 K 線（createSettledTracker），
//   快速滑過整份清單不會一路訂閱／退訂上百檔（永豐行情訂閱有頻率限制）；捲動中列顯示開啟時的批次快照。離開可見範圍立即釋放。
// - 排序：components/watch-sort.tsx（固定清單預設股票代號：標的代號、一般在小型前）。

import { ChevronsUpDown } from 'lucide-react';
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { PriceQuoteState } from '../../hooks/use-stream';
import { getCachedContract, primeContract } from '../../lib/contracts-cache';
import { retainQuote } from '../../lib/quote-ownership';
import { ensureStream, getQuote, subscribeQuoteStore } from '../../lib/stream';
import type { ContractInfo } from '../../lib/types/contract';
import type { Snapshot } from '../../lib/types/market';
import { FUTURES_LISTS, loadFuturesLists, msToTaipeiMidnight, peekFuturesLists, taipeiDate, type FuturesListId, type FuturesLists, type FuturesRow } from '../lib/futures-lists';
import { openTicket } from '../lib/mobile-store';
import { fill, focusRing, pressable } from '../styles/primitives.css';
import * as sortStyles from '../styles/watch-sort.css';
import * as styles from '../styles/watchlist.css';
import { EmptyState } from '../ui/empty-state';
import { GroupedSection, ListRow } from '../ui/grouped';
import { InlineNote } from '../ui/inline-note';
import { Skeleton } from '../ui/skeleton';
import { BottomSheet } from './bottom-sheet';
import { createVisibilityTracker, marketTag, QuoteRow, useSparkColumn, type VisibilityTracker, type WatchMetric } from './quote-row';
import { useSortBasis, WatchSort } from './watch-sort';

const METRIC_LABEL: Readonly<Record<WatchMetric, string>> = { pct: '漲跌幅', vol: '總量' };

/** 可見列的行情探針用：代碼 → 合約（列代碼都是實際月份，沒有連續月別名） */
const ContractsContext = createContext<ReadonlyMap<string, ContractInfo>>(new Map());

/**
 * 只在列可見時掛載：直接以清單資料的合約訂閱 Tick（不經 useQuote → ensureContract，沒有合約解析請求）；
 * 只把成交與指數交給列（同 useQuote narrow），BidAsk 不訂。
 */
function FuturesQuoteProbe({ code, onQuote }: { code: string; onQuote: (q: PriceQuoteState | undefined) => void }) {
    const contract = useContext(ContractsContext).get(code);
    useEffect(() => {
        ensureStream();
        return contract ? retainQuote(contract, 'Tick') : undefined;
    }, [contract]);
    const quote = useSyncExternalStore(l => subscribeQuoteStore(code, l), () => getQuote(code));
    const tick = quote?.tick;
    const index = quote?.index;
    const view = useMemo(() => (tick || index ? { tick, index } : undefined), [tick, index]);
    useEffect(() => { onQuote(view); }, [view, onQuote]);
    return null;
}

/** 捲動停下多久後，才把捲動中進入可見範圍的列當成可見（ms） */
export const SCROLL_SETTLE_MS = 200;

/**
 * 可見列追蹤（包住 quote-row 的 createVisibilityTracker）：沒有捲動時與原本相同；捲動中進入可見範圍的列延到
 * 捲動停下 settleMs 後才通知可見（仍可見才算），離開可見範圍立即通知。捲動事件以 document capture 監聽（main 是捲動容器）。
 */
export function createSettledTracker(settleMs = SCROLL_SETTLE_MS): VisibilityTracker {
    const base = createVisibilityTracker();
    const doc = typeof document === 'undefined' ? null : document;
    if (!base.supported || !doc) return base;
    const pending = new Map<Element, (visible: boolean) => void>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
        timer = undefined;
        const ready = [...pending.values()];
        pending.clear();
        for (const cb of ready) cb(true);
    };
    const onScroll = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(flush, settleMs);
    };
    doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return {
        supported: true,
        observe(el, onChange) {
            const stop = base.observe(el, visible => {
                if (!visible) {
                    pending.delete(el);
                    onChange(false);
                } else if (timer !== undefined) {
                    pending.set(el, onChange);
                } else {
                    onChange(true);
                }
            });
            return () => {
                pending.delete(el);
                stop();
            };
        },
        disconnect() {
            if (timer !== undefined) clearTimeout(timer);
            pending.clear();
            doc.removeEventListener('scroll', onScroll, { capture: true });
            base.disconnect();
        },
    };
}

function useSettledTracker(): VisibilityTracker | null {
    const [tracker, setTracker] = useState<VisibilityTracker | null>(null);
    useEffect(() => {
        const t = createSettledTracker();
        setTracker(t);
        return () => t.disconnect();
    }, []);
    return tracker;
}

/** 開交易頁或下單面板前：快取沒有這檔時以清單資料放入（只放使用者點的這一檔） */
function primeRow(rows: ReadonlyMap<string, ContractInfo>, code: string): void {
    const contract = rows.get(code);
    if (contract && !getCachedContract(code)) primeContract(contract);
}

interface RowProps {
    row: FuturesRow;
    index: number;
    tracker: VisibilityTracker | null;
    metric: WatchMetric;
    spark: boolean;
    snapshot: Snapshot | undefined;
    onOpen: (code: string) => void;
    onActions: (code: string) => void;
    onTicket: (code: string) => void;
}

const FuturesRowView = memo(function FuturesRowView({ row, index, tracker, metric, spark, snapshot, onOpen, onActions, onTicket }: RowProps) {
    const kind = row.mult === 100 ? '小型' : '一般';
    return (
        <QuoteRow
            testPrefix='futures'
            code={row.code}
            name={row.name}
            tag={marketTag(row.contract)}
            tradable
            index={index}
            tracker={tracker}
            metric={metric}
            spark={spark}
            sparkContract={row.contract}
            sparkReference={row.contract.reference || undefined}
            punished={false}
            quoteContract={row.contract}
            snapshot={snapshot}
            probe={FuturesQuoteProbe}
            metaExtra={<span className={styles.rankExtra} data-testid='futures-under'>{row.under}</span>}
            ariaSuffix={`，標的 ${row.under}，${kind}`}
            onOpen={onOpen}
            onLongPress={onActions}
            onTicket={onTicket}
        />
    );
});

/** 長按操作面板：只有開啟交易頁、買進…、賣出…（固定清單不能移動或移除；買賣只開下單面板） */
function FuturesActionsSheet({ row, onClose, onOpen, onTicket }: {
    row: FuturesRow | undefined;
    onClose: () => void;
    onOpen: (code: string) => void;
    onTicket: (code: string, action: 'Buy' | 'Sell') => void;
}) {
    const code = row?.code;
    return (
        <BottomSheet open={row !== undefined} onClose={onClose} title={row ? `${row.code} ${row.contract.name}` : ''} testId='futures-actions'>
            {code && (
                <div className={styles.actionSheet}>
                    <GroupedSection>
                        <ListRow title='開啟交易頁' chevron onClick={() => { onClose(); onOpen(code); }} testId='futures-action-open' />
                        <ListRow
                            title='買進…'
                            leading={<span className={`${styles.sideBadge} ${fill.up.strong}`}>買</span>}
                            onClick={() => { onClose(); onTicket(code, 'Buy'); }}
                            testId='futures-action-buy'
                        />
                        <ListRow
                            title='賣出…'
                            leading={<span className={`${styles.sideBadge} ${fill.down.strong}`}>賣</span>}
                            onClick={() => { onClose(); onTicket(code, 'Sell'); }}
                            testId='futures-action-sell'
                        />
                    </GroupedSection>
                </div>
            )}
        </BottomSheet>
    );
}

export interface FuturesListProps {
    listId: FuturesListId;
    metric: WatchMetric;
    onCycleMetric: () => void;
    /** 開交易頁（只 navigate） */
    onOpen: (code: string) => void;
}

/** 讀取清單資料（今天已讀過時同步取得）；台北日期改變時重新讀取 */
function useFuturesLists(): { data: FuturesLists | undefined; error: boolean; retry: () => void } {
    const [day, setDay] = useState(taipeiDate);
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState<{ data?: FuturesLists; error: boolean }>(() => ({ data: peekFuturesLists(), error: false }));
    useEffect(() => {
        const t = setTimeout(() => setDay(taipeiDate()), msToTaipeiMidnight() + 1_000);
        return () => clearTimeout(t);
    }, [day]);
    useEffect(() => {
        const ready = peekFuturesLists();
        if (ready) {
            setState({ data: ready, error: false });
            return;
        }
        let alive = true;
        setState({ error: false });
        loadFuturesLists().then(
            data => { if (alive) setState({ data, error: false }); },
            () => { if (alive) setState({ error: true }); },
        );
        return () => { alive = false; };
    }, [day, attempt]);
    const retry = useCallback(() => setAttempt(n => n + 1), []);
    return { data: state.data, error: state.error, retry };
}

export function FuturesList({ listId, metric, onCycleMetric, onOpen }: FuturesListProps) {
    const { data, error, retry } = useFuturesLists();
    const label = FUTURES_LISTS.find(l => l.id === listId)?.label ?? '';
    if (error) {
        return (
            <div className={styles.stateBlock}>
                <InlineNote tone='danger' role='alert' action={{ label: '重試', onClick: retry, testId: 'futures-retry' }} testId='futures-error'>
                    {label}清單載入失敗。
                </InlineNote>
            </div>
        );
    }
    if (!data) return <Skeleton label={`${label}讀取中…`} rows={6} testId='futures-loading' />;
    const rows = listId === 'fut:near' ? data.near : data.next;
    if (!rows.length) return <EmptyState title={`目前沒有${label}合約`} description='資料由期貨合約清單自動產生。' testId='futures-empty' />;
    return <FuturesRows key={listId} listId={listId} label={label} rows={rows} metric={metric} onCycleMetric={onCycleMetric} onOpen={onOpen} />;
}

function FuturesRows({ listId, label, rows, metric, onCycleMetric, onOpen }: Omit<FuturesListProps, 'listId'> & { listId: FuturesListId; label: string; rows: FuturesRow[] }) {
    const tracker = useSettledTracker();
    const spark = useSparkColumn();
    const contracts = useMemo(() => new Map(rows.map(r => [r.code, r.contract])), [rows]);
    const byCode = useMemo(() => new Map(rows.map(r => [r.code, r])), [rows]);
    // 開啟清單就取一次批次快照：列的價格備援，也是股價類排序的依據
    const basis = useSortBasis(listId, rows, true);
    const [order, setOrder] = useState<string[] | null>(null);
    const shown = useMemo(() => (order ? order.flatMap(c => byCode.get(c) ?? []) : rows), [order, byCode, rows]);
    const [actionCode, setActionCode] = useState<string | null>(null);

    const open = useCallback((code: string) => { primeRow(contracts, code); onOpen(code); }, [contracts, onOpen]);
    const ticket = useCallback((code: string, action?: 'Buy' | 'Sell') => {
        primeRow(contracts, code);
        openTicket(action ? { code, action, source: 'other' } : { code, source: 'other' });
    }, [contracts]);
    const quick = useCallback((code: string) => ticket(code), [ticket]);
    const onActions = useCallback((code: string) => setActionCode(code), []);
    const snapshots = basis.entry?.snapshots;

    return (
        <ContractsContext.Provider value={contracts}>
            <div className={`${styles.listHeader} ${sortStyles.fixedHeader}`} data-testid='futures-header'>
                <span className={styles.headerName} aria-hidden='true'>名稱</span>
                <WatchSort listId={listId} fixed items={rows} onOrder={setOrder} basis={basis} />
                <button
                    type='button'
                    className={`${styles.metricToggle} ${pressable} ${focusRing}`}
                    aria-label={`第二行顯示${metric === 'pct' ? '漲跌與漲跌幅' : METRIC_LABEL[metric]}，點按切換（漲跌與漲跌幅、總量）`}
                    onClick={onCycleMetric}
                    data-testid='futures-metric-toggle'
                    data-metric={metric}
                >
                    {METRIC_LABEL[metric]}
                    <ChevronsUpDown className={styles.metricIcon} aria-hidden='true' focusable='false' />
                </button>
            </div>
            <ul className={styles.list} aria-label={`${label}（${rows.length} 檔，自動產生，不能編輯）`} data-testid='futures-list'>
                {shown.map((row, index) => (
                    <FuturesRowView
                        key={row.code}
                        row={row}
                        index={index}
                        tracker={tracker}
                        metric={metric}
                        spark={spark}
                        snapshot={snapshots?.get(row.code)}
                        onOpen={open}
                        onActions={onActions}
                        onTicket={quick}
                    />
                ))}
            </ul>
            <FuturesActionsSheet row={actionCode ? byCode.get(actionCode) : undefined} onClose={() => setActionCode(null)} onOpen={open} onTicket={ticket} />
        </ContractsContext.Provider>
    );
}
