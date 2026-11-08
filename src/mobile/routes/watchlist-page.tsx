// src/mobile/routes/watchlist-page.tsx — 自選（規格 §6.1、§9.1、§9.4；設計規格 §7.2）
//
// - 清單：useWatchlist()（伺服器端清單，與桌面共用）由 MobileShell 的 WatchlistProvider 常駐掛載，
//   這裡以 useMobileWatchlist() 取用；切換分頁再回來不會重新讀取清單（lib/watchlist-context.tsx）。
//   清單切換 serverLists／setActiveList。
// - 行情：**只有可見列**訂閱（IntersectionObserver）。不可見的列不掛載 WatchQuoteProbe，
//   也就不呼叫 useQuote；離開畫面時 probe 卸載，由 src/lib/quote-ownership 在 RELEASE_GRACE_MS（1.5 秒）
//   後才真正退訂，快速捲動來回不會反覆訂閱／退訂。永豐行情訂閱 50 次／5 秒（§9.1）。
// - 重繪：行情 store 已以 50 ms 合併通知；每列再以 WATCH_REPAINT_MS（100 ms）節流重繪（§9.4）。
// - 列（components/quote-row.tsx，與排行共用）：兩行列、迷你走勢、處置徽章、快速下單鍵、指數／組合商品佔位。
// - 點一列 → #/trade/:code；長按（或編輯模式的「⋯」鍵）→ 操作面板：開啟交易頁、買進…、賣出…、移到最上、上移、下移、移除。
//   「買進…／賣出…」**只呼叫 openTicket()**（只開下單面板；之後仍需預覽與滑動確認才會送出，設計規格 §10 S1）。
// - 搜尋：search-sheet.tsx（searchProducts(query, 10)）。延遲載入（lib/deferred-modules.ts loadSearchSheet，閒置預載），
//   第一次要求開啟時才掛載；載入失敗以底部面板「載入失敗」＋［重試］顯示。
// - 試撮（tick.simtrade）：比照桌面，代碼旁加「試撮」徽章，不當成真實成交顯示。
// - 分段「自選｜排行」（§13 Phase 3）：排行見 components/ranking-list.tsx（延遲載入），只在「排行」分段掛載時讀取；
//   「排行」分段不掛載自選列，自選列的行情訂閱隨之釋放。分段選擇在模組層保留（切換分頁再回來不變）。
// - 版面（設計規格 §7.2，依使用者參考圖改版）：PageHeader（搜尋）；Segmented tabs（自選｜排行）；
//   清單列：多個清單時清單分頁（Segmented scroll 變體，選中的自動捲進可見範圍；順序依這台裝置的群組順序，
//   lib/watch-list-order.ts），只有一個清單時顯示名稱；最後是「＋」新增清單；
//   表頭「名稱｜指標切換鍵（watch-metric-toggle）｜編輯（watch-edit）」，都在表頭、不在列按鈕內（避免巢狀互動）；
//   列 64px：名稱／代碼＋市場標記＋徽章（試撮、處置）｜成交價／「漲跌 漲跌幅」或總量（純文字、漲跌色）｜迷你走勢｜快速下單鍵。
//   載入 Skeleton、空清單 EmptyState、錯誤 InlineNote。
// - 清單增減（使用者要求「自選要增加可增加或減少的功能」）：
//   - 新增清單：清單列最後的「＋」→ 名稱面板（components/watch-list-sheet.tsx；空白與重複名稱檢查）→ createList。
//   - 編輯模式：目前清單「重新命名」（renameCurrentList；改名會換清單 id；失敗時面板與編輯模式保持）、
//     「刪除清單」（兩段式確認；只剩一個清單時停用）→ deleteCurrentList（失敗顯示原因、保持編輯模式）。
//   - 編輯模式每列列首「−」→ 移除確認面板（沿用操作面板的移除流程與文字）；清單底部「加入股票」開既有搜尋面板。
//     非編輯模式沿用長按操作面板。
//   - 多選刪除：編輯模式清單工具列的「多選」（延遲載入的 WatchEditTools，components/watch-edit-controls.tsx）→ 列首勾選圈、
//     全選、底部「刪除 N 檔」→ 確認面板 → 逐檔 await removeSymbol（每檔 DELETE＋GET 清單）。多選狀態在編輯 chunk 內，
//     本頁只把列點擊的代碼交給 blocked(code)（多選中切換勾選、不開交易頁）；多選中握把停用。
//     編輯模式的說明文字（watch-edit-hint）也在 WatchEditTools（首屏體積；多選中改為多選的說明）。
//   - 排序群組：編輯模式「排序群組」（同在 WatchEditTools）→ 面板拖曳或 ↑／↓ 調整清單分頁的順序。伺服器的自選清單沒有順序
//     欄位與排序 API，順序只存在這台裝置（lib/watch-list-order.ts，localStorage），桌面不受影響，不發任何請求。
// - 手指拖曳排序（使用者要求；lib/watch-reorder.ts）：編輯模式每列列尾有握把（touch-action none，只有握把能拖，
//   列的其他區域照常捲動，§8）；列以 transform 跟手指、其他列以 transform 讓位（減少動態時不做讓位動畫）、靠近
//   main 上下緣自動捲動；放手時位置有變才呼叫一次 reorderSymbol（hook 每次是 GET＋PUT＋GET）；pointercancel 還原；
//   拖曳中與放手後短時間內不觸發列點擊與長按；清單載入中、載入失敗（loadError）、結構更新中或清單不可寫入
//   （canReplaceList false）時停用握把。鍵盤 ↑／↓ 一次移一格（忽略自動重複與寫入中），移動後焦點留在該列握把。
//   操作面板的上移、下移、移到最上保留。
//   延遲載入（首屏體積）：列首「−」、列尾「⋯」＋握把與 useListReorder 都在 components/watch-edit-controls.tsx
//   （lib/deferred-modules.ts loadWatchEditControls，閒置預載），非編輯模式不載入。列仍由本頁渲染（QuoteRow 的
//   leading／trailing），進出編輯模式不重掛列；useListReorder 包成不渲染畫面的 WatchEditReorder，只在編輯模式且有清單時
//   掛載，把拖曳狀態與握把事件交回本頁。載入前與載入失敗時列首、列尾是同尺寸空白佔位（握把 NOOP），失敗在清單上方顯示
//   「載入失敗」＋［重試］（再次進入編輯模式也會重新 import）；表頭、清單工具、加入股票與非編輯模式的列不受影響。
//   編輯模式不顯示迷你走勢（列首、列尾各多一個鍵，讓出寬度給名稱）。
// - 迷你走勢（使用者明確要求，有限制地做）：只為可見列讀取目前（或最近一段）交易時段的 1 分 K，模組層快取每檔每段一次
//   （盤中讀過的收盤後補讀一次）、佇列同時 2 個，即時成交以分鐘為桶接在尾段（lib/watch-sparkline-data.ts）；
//   帳戶頁「顯示」可關閉，關閉時不掛載走勢欄、不發 K 線請求。指數、組合商品顯示空白佔位。
//   窄螢幕（視窗寬 ≤400px，matchMedia）且字級「大」（1.3）時也不顯示，與關閉相同：不掛載、不請求、不排 rAF、
//   不留空白佔位（各列一致改為「名稱｜數字」），讓出寬度給名稱欄，第二行代碼與市場標記不截斷（sparkFitsRow）。
//   延遲載入（lib/deferred-modules.ts loadWatchSparkline，閒置預載）；只有可見列掛載 canvas（不可見列沒有點陣、不排 rAF），
//   不可見、載入中、載入失敗都是同尺寸空白佔位；載入失敗後列下次變為可見時重新 import。
// - 處置徽章：lib/regulatory-punish.ts（自選頁顯示清單且含股票時才讀，最多每 30 分鐘一次，失敗靜默）。
// - 快速下單鍵（watch-row-ticket）：列尾的兄弟節點（不在列按鈕內，不觸發開交易頁或長按），只呼叫
//   openTicket({ code, source: 'other' })（不帶方向；之後仍需預覽與滑動確認，設計規格 §10 S1）。指數、組合商品不顯示，
//   改放同寬的 aria-hidden 空白佔位（watch-row-ticket-spacer），各列的價格欄與走勢欄對齊；編輯模式改顯示「⋯」與握把。
// - 表頭編輯鍵的無障礙名稱包含可見文字（WCAG 2.5.3）：「編輯」→「編輯自選」、「完成」→「完成編輯」。
// - 底部指數列（components/watch-index-strip.tsx）：ShellSlot bottom，加權／櫃買，點按只 navigate；
//   沒有即時指數時以快照（自選頁掛載時讀，最多每 INDEX_SNAPSHOT_TTL_MS 一次）顯示收盤值。
//   以 ContractBase 直接訂閱 Quote（retainContractQuotes），不經 useQuote → ensureContract，沒有合約解析 GET。
// - 進入本頁的請求（清單本身由 WatchlistProvider 常駐讀取，不在此列）：
//   處置清單 GET ≤1（含股票時，30 分鐘最多 1 次）；指數快照 POST ≤1（10 分鐘最多 1 次）；合約解析 0
//   （列的合約由 useWatchlist 預先放進快取，指數不經解析）；Quote 訂閱＝指數 2 筆＋每個可見列 Tick、BidAsk 各 1 筆；
//   K 線 POST 每個可見可交易列 ≤1（假日補找時 2，同時 2 個，每檔每段讀過即快取）；走勢 chunk 1 個（通常已閒置預載）。
//   清單管理只在使用者操作時發出（新增、改名、刪除、移除、排序各自是 use-watchlist 的既有請求）。

import { ChevronsUpDown, Pencil, Plus, Search, Star } from 'lucide-react';
import { memo, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useQuote, type PriceQuoteState } from '../../hooks/use-stream';
import type { WatchItem } from '../../hooks/use-watchlist';
import { neighborCode } from '../../lib/list-move';
import type { ProductSuggestion } from '../../lib/product-search';
import { BottomSheet } from '../components/bottom-sheet';
import {
    marketTag,
    QuoteRow,
    tradableContract,
    useSparkColumn,
    useVisibilityTracker,
    type VisibilityTracker,
    type WatchMetric,
} from '../components/quote-row';
import { ModuleErrorBoundary, ModuleLoadError, retryableLazy, SheetLoadError } from '../components/route-error-boundary';
import { WatchIndexStrip } from '../components/watch-index-strip';
import { loadRankingList, loadSearchSheet, loadWatchEditControls, loadWatchListSheet } from '../lib/deferred-modules';
import { navigate } from '../lib/hash-router';
import { openTicket } from '../lib/mobile-store';
import { usePunishedCodes } from '../lib/regulatory-punish';
import type { ListReorder } from '../lib/watch-reorder';
import { orderLists } from '../lib/watch-list-order';
import { useMobileWatchlist } from '../lib/watchlist-context';
import { prefersReducedMotion } from '../motion/prefs';
import { fill, focusRing, pressable, pressableRow } from '../styles/primitives.css';
import * as styles from '../styles/watchlist.css';
import { EmptyState } from '../ui/empty-state';
import { GroupedSection, ListRow } from '../ui/grouped';
import { IconButton } from '../ui/icon-button';
import { InlineNote } from '../ui/inline-note';
import { PageHeader } from '../ui/page-header';
import { Segmented } from '../ui/segmented';
import { ShellSlot } from '../ui/shell-slots';
import { Skeleton } from '../ui/skeleton';

// 列、行情推算、可見列追蹤等搬到 components/quote-row.tsx（自選與排行共用）；保留從這裡匯出
export {
    createVisibilityTracker,
    FALLBACK_VISIBLE_ROWS,
    LARGE_FONT_SCALE,
    LONG_PRESS_MOVE_PX,
    LONG_PRESS_MS,
    marketTag,
    NARROW_WATCH_QUERY,
    PUNISH_LABEL,
    rowQuoteView,
    SIM_LABEL,
    sparkFitsRow,
    tradableContract,
    VISIBILITY_ROOT_MARGIN,
    WATCH_REPAINT_MS,
} from '../components/quote-row';
export type { MarketTag, RowQuoteView, SparkSlotState, VisibilityTracker, WatchMetric } from '../components/quote-row';

/** 讓 item 完整露出時捲動容器 scrollLeft 需要的位移（px；已完整可見時 0）。純函式，供清單分頁自動捲動與測試 */
export function revealDelta(container: { left: number; right: number }, item: { left: number; right: number }, pad = 8): number {
    if (item.left < container.left) return item.left - container.left - pad;
    if (item.right > container.right) return item.right - container.right + pad;
    return 0;
}

/**
 * 只在列可見時掛載：呼叫 useQuote(code, { narrow: true })，把行情交給列（列自行節流重繪）。
 * 本身不渲染任何東西，行情每次更新只喚醒這個空元件。
 */
export function WatchQuoteProbe({ code, onQuote }: { code: string; onQuote: (q: PriceQuoteState | undefined) => void }) {
    const quote = useQuote(code, { narrow: true });
    useEffect(() => { onQuote(quote); }, [quote, onQuote]);
    return null;
}

// ---------------------------------------------------------------------------
// 列右側指標（表頭切換鍵循環；存 localStorage）

export const WATCH_METRICS: readonly WatchMetric[] = ['pct', 'vol'];
export const WATCH_METRIC_LABEL: Readonly<Record<WatchMetric, string>> = { pct: '漲跌幅', vol: '總量' };
/** localStorage 鍵（per-device 偏好；讀寫失敗只在本次有效） */
export const WATCH_METRIC_KEY = 'sj-mobile-watch-metric';

function readMetric(): WatchMetric {
    try {
        const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(WATCH_METRIC_KEY);
        // 舊版的 'chg'（只顯示漲跌）併入 'pct'：第二行已同時顯示漲跌與漲跌幅
        return v === 'vol' ? 'vol' : 'pct';
    } catch {
        return 'pct';
    }
}

function writeMetric(m: WatchMetric): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(WATCH_METRIC_KEY, m);
    } catch {
        // 無法寫入時只在本次有效
    }
}

/** 下一個指標（漲跌幅 → 總量 → 漲跌幅） */
export function nextWatchMetric(m: WatchMetric): WatchMetric {
    return WATCH_METRICS[(WATCH_METRICS.indexOf(m) + 1) % WATCH_METRICS.length]!;
}

// ---------------------------------------------------------------------------
// 列

// 編輯模式的列首、列尾鍵與拖曳排序只在編輯模式用到：延遲載入（同一個 chunk），閒置時由 app.tsx 預載。
// 載入前與載入失敗時列首、列尾是同尺寸空白佔位、握把 NOOP；失敗以「載入失敗」＋［重試］顯示在清單上方（WatchEditReorder 的邊界），
// 列內的邊界只放佔位、不顯示錯誤（editKey 改變時清除，重試後重新渲染）。
const WatchEditReorder = retryableLazy(() => loadWatchEditControls().then(m => m.WatchEditReorder), 'WatchEditReorder');
const WatchEditLeading = retryableLazy(() => loadWatchEditControls().then(m => m.WatchEditLeading), 'WatchEditLeading');
const WatchEditTrailing = retryableLazy(() => loadWatchEditControls().then(m => m.WatchEditTrailing), 'WatchEditTrailing');
const WatchEditTools = retryableLazy(() => loadWatchEditControls().then(m => m.WatchEditTools), 'WatchEditTools');
/** 上次載入失敗時換新的 lazy（四個都要呼叫，不可短路）；未失敗時不動 */
const resetWatchEditControls = () => {
    WatchEditReorder.reset();
    WatchEditLeading.reset();
    WatchEditTrailing.reset();
    WatchEditTools.reset();
};
/**
 * 閒置預載（app.tsx）：四個 lazy 都先記住元件（retryableLazy.preload），第一次進入編輯模式直接渲染、不 suspend
 * （只 import chunk 的話 lazy 仍會 suspend 一次，React 的 Suspense 節流會讓佔位多停留最多約 300ms）。
 * 四個共用同一個 chunk，瀏覽器只抓一次；失敗時 preload 靜默，進入編輯模式再重新 import。
 */
export const preloadWatchEditControls = (): Promise<void> =>
    Promise.all([WatchEditReorder.preload(), WatchEditLeading.preload(), WatchEditTrailing.preload(), WatchEditTools.preload()]).then(() => undefined);
const noop = () => undefined;
const NOOP_GRIP: ListReorder['grip'] = {
    onPointerDown: noop,
    onPointerMove: noop,
    onPointerUp: noop,
    onPointerCancel: noop,
    onKeyDown: noop,
    onClick: noop,
};

/** 列首、列尾編輯鍵的延遲載入槽：載入中與失敗時是同尺寸空白佔位（列寬不跳動、不顯示錯誤） */
function EditSlot({ editKey, placeholder, children }: { editKey: number; placeholder: ReactNode; children: ReactNode }) {
    return (
        <ModuleErrorBoundary resetKey={String(editKey)} fallback={() => placeholder}>
            <Suspense fallback={placeholder}>{children}</Suspense>
        </ModuleErrorBoundary>
    );
}

const LEADING_PLACEHOLDER = (
    <span className={styles.rowLeading} aria-hidden='true' data-testid='watch-edit-leading-blank'>
        <span className={styles.ticketSpacer} />
    </span>
);
const TRAILING_PLACEHOLDER = (
    <span className={`${styles.rowTrailing} ${styles.trailingPair}`} aria-hidden='true' data-testid='watch-edit-trailing-blank'>
        <span className={styles.ticketSpacer} />
        <span className={styles.ticketSpacer} />
    </span>
);

interface WatchRowProps {
    item: WatchItem;
    index: number;
    tracker: VisibilityTracker | null;
    editing: boolean;
    /** 編輯鍵重試次數：改變時清除列內編輯槽的錯誤狀態 */
    editKey: number;
    metric: WatchMetric;
    /** 顯示迷你走勢：設定開啟且放得下（否則不掛載走勢欄、不請求、不留佔位） */
    spark: boolean;
    punished: boolean;
    /** 拖曳中的列 */
    dragging: boolean;
    /** 握把停用（清單載入或結構更新中，或拖曳排序尚未就緒） */
    gripDisabled: boolean;
    grip: ListReorder['grip'];
    onOpen: (code: string) => void;
    onActions: (code: string) => void;
    onRemove: (code: string) => void;
    onTicket: (code: string) => void;
}

const WatchRow = memo(function WatchRow({ item, index, tracker, editing, editKey, metric, spark, punished, dragging, gripDisabled, grip, onOpen, onActions, onRemove, onTicket }: WatchRowProps) {
    const code = item.contract.code;
    const name = item.contract.name ?? '';
    const tradable = tradableContract(item.contract);
    const label = `${code} ${name}`.trim();
    return (
        <QuoteRow
            testPrefix='watch'
            code={code}
            name={name}
            tag={marketTag(item.contract)}
            tradable={tradable}
            index={index}
            tracker={tracker}
            metric={metric}
            spark={spark && !editing}
            sparkContract={tradable ? item.contract : null}
            sparkReference={item.contract.reference || undefined}
            punished={punished}
            quoteContract={item.contract}
            snapshot={item.snapshot}
            probe={WatchQuoteProbe}
            onOpen={onOpen}
            onLongPress={onActions}
            onTicket={onTicket}
            dragging={dragging}
            leading={editing ? (
                <EditSlot editKey={editKey} placeholder={LEADING_PLACEHOLDER}>
                    <WatchEditLeading code={code} label={label} onRemove={onRemove} />
                </EditSlot>
            ) : undefined}
            trailing={editing ? (
                <EditSlot editKey={editKey} placeholder={TRAILING_PLACEHOLDER}>
                    <WatchEditTrailing code={code} label={label} gripDisabled={gripDisabled} grip={grip} onActions={onActions} />
                </EditSlot>
            ) : undefined}
        />
    );
});

// ---------------------------------------------------------------------------
// 長按操作面板（mode 'remove'：編輯模式列首「−」，只顯示移除並直接進入確認）

function RowActionsSheet({ code, mode, items, onClose, onOpen, onRemove, onMove }: {
    code: string | null;
    mode: 'actions' | 'remove';
    items: WatchItem[];
    onClose: () => void;
    onOpen: (code: string) => void;
    onRemove: (code: string) => Promise<void>;
    onMove: (from: string, to: string) => void;
}) {
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        setConfirmRemove(mode === 'remove');
        setError(null);
        setBusy(false);
    }, [code, mode]);
    const item = code ? items.find(i => i.contract.code === code) : undefined;
    const codes = items.map(i => i.contract.code);
    const up = code ? neighborCode(codes, code, -1) : null;
    const down = code ? neighborCode(codes, code, 1) : null;
    const top = codes[0] && codes[0] !== code ? codes[0] : null;
    const tradable = item ? tradableContract(item.contract) : false;

    const remove = async () => {
        if (!code) return;
        if (!confirmRemove) {
            setConfirmRemove(true);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onRemove(code);
            onClose();
        } catch (e) {
            setError(e instanceof Error && e.message ? e.message : '移除失敗，請稍後再試');
            setBusy(false);
        }
    };

    /** 只開下單面板（不送單）：面板內仍需預覽 → 確認面板滑動確認 */
    const ticket = (action: 'Buy' | 'Sell') => {
        if (!code) return;
        onClose();
        openTicket({ code, action, source: 'other' });
    };

    return (
        <BottomSheet open={code !== null && item !== undefined} onClose={onClose} title={item ? `${item.contract.code} ${item.contract.name ?? ''}` : ''} testId='watch-actions'>
            {code && (
                <div className={styles.actionSheet}>
                    {mode === 'actions' && (
                        <>
                            <GroupedSection>
                                <ListRow title='開啟交易頁' chevron onClick={() => { onOpen(code); onClose(); }} testId='watch-action-open' />
                                {tradable && (
                                    <ListRow
                                        title='買進…'
                                        leading={<span className={`${styles.sideBadge} ${fill.up.strong}`}>買</span>}
                                        disabled={busy}
                                        onClick={() => ticket('Buy')}
                                        testId='watch-action-buy'
                                    />
                                )}
                                {tradable && (
                                    <ListRow
                                        title='賣出…'
                                        leading={<span className={`${styles.sideBadge} ${fill.down.strong}`}>賣</span>}
                                        disabled={busy}
                                        onClick={() => ticket('Sell')}
                                        testId='watch-action-sell'
                                    />
                                )}
                            </GroupedSection>
                            <GroupedSection>
                                <ListRow title='移到最上' disabled={!top || busy} onClick={() => top && onMove(code, top)} />
                                <ListRow title='上移' disabled={!up || busy} onClick={() => up && onMove(code, up)} />
                                <ListRow title='下移' disabled={!down || busy} onClick={() => down && onMove(code, down)} />
                            </GroupedSection>
                        </>
                    )}
                    <GroupedSection footer={confirmRemove && !busy ? '自選清單與桌面共用，移除後桌面也會看不到。' : undefined}>
                        <button
                            type='button'
                            className={`${styles.dangerRow} ${pressableRow} ${focusRing}`}
                            disabled={busy}
                            onClick={() => void remove()}
                            data-testid='watch-remove'
                        >
                            {busy ? '移除中…' : confirmRemove ? `確定從自選移除 ${code}` : '從自選移除'}
                        </button>
                    </GroupedSection>
                    {error && <InlineNote tone='danger' role='alert'>{error}</InlineNote>}
                </div>
            )}
        </BottomSheet>
    );
}

// ---------------------------------------------------------------------------
// 頁面

export type WatchSegment = 'watchlist' | 'ranking';

// 排行只在「排行」分段才用到：延遲載入（規格 §13 首次載入體積），閒置時由 app.tsx 預載。
// 載入失敗只在分段內容區顯示「載入失敗」＋［重試］（retryableLazy 換新的 lazy 重新 import）。
const RankingList = retryableLazy(() => loadRankingList().then(m => m.RankingList), 'RankingList');
const resetRankingList = () => { RankingList.reset(); };

// 搜尋面板只在按「搜尋」（或空清單的「搜尋並加入」、編輯模式的「加入股票」）後才用到：延遲載入（連同 lib/product-search
// 面板約 1.4 KiB gzip，另需上游搜尋本體 product-search chunk 約 18.7 KiB），閒置時由 app.tsx 預載。第一次要求開啟時才掛載、之後保持掛載（面板開關動畫正常；同 app.tsx 的下單面板）。
// 載入失敗以底部面板顯示「載入失敗」＋［重試］（SheetLoadError），可關閉，不影響頁面。
const SearchSheet = retryableLazy(() => loadSearchSheet().then(m => m.SearchSheet), 'SearchSheet');
const resetSearchSheet = () => { SearchSheet.reset(); };

// 清單名稱面板（新增、重新命名）只在按「＋」或「重新命名」後才用到：延遲載入，第一次要求開啟時才掛載、之後保持掛載。
// 載入失敗以底部面板顯示「載入失敗」＋［重試］（SheetLoadError），可關閉，不影響頁面。
const WatchListSheet = retryableLazy(() => loadWatchListSheet().then(m => m.WatchListSheet), 'WatchListSheet');
const resetWatchListSheet = () => { WatchListSheet.reset(); };

const SEGMENTS = [
    { value: 'watchlist', label: '自選', testId: 'watch-segment-watchlist' },
    { value: 'ranking', label: '排行', testId: 'watch-segment-ranking' },
] as const satisfies readonly { value: WatchSegment; label: string; testId: string }[];

/** 上次選的分段（切換分頁再回來保留） */
let lastSegment: WatchSegment = 'watchlist';

/**
 * 握把（拖曳、鍵盤排序）是否可用：清單已載入、沒有載入失敗、沒有結構更新，且清單可整份寫入。
 * use-watchlist 的 canReplaceList 是 hook 內部的 ref（未回傳；不可修改 src/hooks）：依該 hook 的寫法，它為 false 時
 * loading、loadError 或 structureBusy 必有其一為 true，因此以這三者判斷；若日後 hook 回傳 canReplaceList 也一併採用。
 */
export function canReorderList(wl: { loading: boolean; structureBusy: boolean; loadError: boolean; canReplaceList?: boolean }): boolean {
    return !wl.loading && !wl.structureBusy && !wl.loadError && wl.canReplaceList !== false;
}

/** 刪除清單鍵的無障礙名稱：以可見文字開頭（WCAG 2.5.3），再補上清單名稱 */
export function deleteListLabel(name: string, confirming: boolean, busy: boolean): string {
    if (busy) return `刪除中…（清單「${name}」）`;
    return confirming ? `確定刪除「${name}」清單` : `刪除清單「${name}」`;
}

/** 測試用：分段回到「自選」 */
export function resetWatchlistSegmentForTest(): void {
    lastSegment = 'watchlist';
}

export function WatchlistPage() {
    const wl = useMobileWatchlist();
    const tracker = useVisibilityTracker();
    const [searchOpen, setSearchOpen] = useState(false);
    /** 搜尋面板第一次要求開啟後保持掛載 */
    const [searchMounted, setSearchMounted] = useState(false);
    const [editing, setEditing] = useState(false);
    const [actionCode, setActionCode] = useState<string | null>(null);
    const [actionMode, setActionMode] = useState<'actions' | 'remove'>('actions');
    const [segment, setSegmentState] = useState<WatchSegment>(lastSegment);
    const [metric, setMetricState] = useState<WatchMetric>(readMetric);
    /** 清單名稱面板（新增／重新命名） */
    const [listSheet, setListSheetState] = useState<'create' | 'rename' | null>(null);
    /** 清單名稱面板第一次要求開啟後保持掛載 */
    const [listSheetMounted, setListSheetMounted] = useState(false);
    const setListSheet = useCallback((mode: 'create' | 'rename' | null) => {
        if (mode) setListSheetMounted(true);
        setListSheetState(mode);
    }, []);
    /** 刪除清單的兩段式確認 */
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [listBusy, setListBusy] = useState(false);
    const [listError, setListError] = useState<string | null>(null);
    const setSegment = useCallback((next: WatchSegment) => {
        lastSegment = next;
        setSegmentState(next);
        if (next === 'ranking') setEditing(false);
    }, []);
    const cycleMetric = useCallback(() => {
        setMetricState(m => {
            const next = nextWatchMetric(m);
            writeMetric(next);
            return next;
        });
    }, []);

    const openTrade = useCallback((code: string) => {
        navigate({ name: 'trade', code });
    }, []);
    const openSearch = useCallback(() => {
        setSearchMounted(true);
        setSearchOpen(true);
    }, []);
    const closeSearch = useCallback(() => setSearchOpen(false), []);
    /** 列尾快速下單鍵：只開下單面板、不帶方向（S1：之後仍需預覽與滑動確認） */
    const quickTicket = useCallback((code: string) => { openTicket({ code, source: 'other' }); }, []);

    const watchedCodes = useMemo(() => new Set(wl.items.map(i => i.contract.code)), [wl.items]);
    const { addSymbol, removeSymbol, reorderSymbol, createList, renameCurrentList, deleteCurrentList } = wl;
    const onAdd = useCallback(async (s: ProductSuggestion) => {
        await addSymbol(s.code, s.security_type, s.contract);
    }, [addSymbol]);
    const onRemove = useCallback(async (code: string) => { await removeSymbol(code); }, [removeSymbol]);
    // 排行都是上市櫃股票：以 STK 解析合約後加入目前清單
    const onAddRanked = useCallback(async (code: string) => { await addSymbol(code, 'STK'); }, [addSymbol]);
    const canAdd = !wl.loading && !wl.structureBusy && !wl.loadError;

    // 拖曳排序（編輯模式的握把；延遲載入的 WatchEditReorder 把 useListReorder 的結果交回）：放手時位置有變才呼叫一次 reorderSymbol
    const listRef = useRef<HTMLUListElement | null>(null);
    const codes = useMemo(() => wl.items.map(i => i.contract.code), [wl.items]);
    const gripDisabled = !canReorderList(wl);
    const [reorder, setReorder] = useState<ListReorder | null>(null);
    const reorderRef = useRef<ListReorder | null>(null);
    const onReorder = useCallback((next: ListReorder | null) => {
        reorderRef.current = next;
        setReorder(next);
    }, []);
    const blocked = useCallback((code?: string) => reorderRef.current?.blocked(code) ?? false, []);
    /** 編輯鍵載入失敗後按［重試］的次數：改變時清除列內編輯槽的錯誤狀態 */
    const [editKey, setEditKey] = useState(0);
    const retryEditControls = useCallback(() => {
        resetWatchEditControls();
        setEditKey(k => k + 1);
    }, []);
    // 拖曳中與剛放手時不開交易頁、不開操作面板
    const openRow = useCallback((code: string) => { if (!blocked(code)) openTrade(code); }, [blocked, openTrade]);
    const openActions = useCallback((code: string) => {
        if (blocked()) return;
        setActionMode('actions');
        setActionCode(code);
    }, [blocked]);
    const askRemove = useCallback((code: string) => {
        if (blocked()) return;
        setActionMode('remove');
        setActionCode(code);
    }, [blocked]);

    const activeList = wl.serverLists.find(l => l.id === wl.activeListId);
    // 群組（清單）分頁的順序只存在這台裝置（lib/watch-list-order.ts，每次渲染讀取）；編輯模式「排序群組」存檔後以 bumpOrder 重繪
    const [orderKey, bumpOrder] = useReducer((n: number) => n + 1, 0);
    const ranking = segment === 'ranking';
    const showList = !ranking && wl.items.length > 0;
    const metricLabel = WATCH_METRIC_LABEL[metric];
    // 走勢欄：設定開啟且放得下才掛載（窄螢幕＋字級「大」時與設定關閉相同：不掛載、不請求、不留佔位）
    const spark = useSparkColumn();
    // 處置清單：只在顯示自選列且清單含股票時讀取（受 30 分鐘間隔限制）
    const hasStocks = useMemo(() => wl.items.some(i => i.contract.security_type === 'STK'), [wl.items]);
    const punished = usePunishedCodes(showList && hasStocks);
    const showListTabs = !ranking && wl.serverLists.length > 1;
    // 清單本身載入中（hook 的 loading 在清單結構更新時也為 true；結構更新中不算，避免編輯模式中途被收起）
    const listLoading = wl.loading && !wl.structureBusy;
    // 空清單（已載入）也顯示表頭的編輯鍵：才能重新命名或刪除空的清單
    const emptyList = !ranking && !wl.items.length && !listLoading && !wl.loadError;
    const showHeader = showList || (emptyList && activeList !== undefined);
    const listNames = useMemo(() => wl.serverLists.map(l => l.name), [wl.serverLists]);
    const canDeleteList = wl.serverLists.length > 1;

    // 換清單或離開編輯模式時，取消刪除確認與錯誤訊息
    useEffect(() => {
        setConfirmDelete(false);
        setListError(null);
    }, [wl.activeListId, editing]);
    // 清單變空且不再顯示表頭時（例如載入中）結束編輯模式
    useEffect(() => {
        if (!showHeader) setEditing(false);
    }, [showHeader]);

    const deleteList = async () => {
        if (!canDeleteList || listBusy) return;
        if (!confirmDelete) {
            setConfirmDelete(true);
            return;
        }
        setListBusy(true);
        setListError(null);
        try {
            await deleteCurrentList();
            setConfirmDelete(false);
        } catch (e) {
            setListError(`刪除清單失敗：${e instanceof Error && e.message ? e.message : '請稍後再試'}`);
        } finally {
            setListBusy(false);
        }
    };

    // 清單分頁：選中的那個自動捲進可見範圍（只動水平 scrollLeft，不捲動頁面）
    const listTabsRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const root = listTabsRef.current;
        if (!showListTabs || !root || typeof root.querySelector !== 'function') return;
        const scroller = root.querySelector<HTMLElement>('[role="tablist"]');
        const selected = root.querySelector<HTMLElement>('[aria-selected="true"]');
        if (!scroller || !selected) return;
        const delta = revealDelta(scroller.getBoundingClientRect(), selected.getBoundingClientRect());
        if (delta !== 0) scroller.scrollLeft += delta;
    }, [showListTabs, wl.activeListId, wl.serverLists.length, orderKey]);

    const structureBusy = wl.structureBusy || listBusy;

    return (
        <section className={styles.page} data-testid='page-watchlist'>
            <PageHeader
                title='自選'
                actions={(
                    <>
                        <IconButton ariaLabel='搜尋商品' icon={Search} iconSize={22} onClick={openSearch} testId='watch-search' />
                    </>
                )}
            />

            <div className={styles.controls}>
                <Segmented<WatchSegment>
                    items={SEGMENTS}
                    value={segment}
                    onChange={setSegment}
                    semantics='tabs'
                    ariaLabel='自選或排行'
                />
                {!ranking && wl.serverLists.length > 0 && (
                    <div className={styles.listBar}>
                        {showListTabs ? (
                            <div ref={listTabsRef} className={styles.listTabs}>
                                <Segmented<string>
                                    items={orderLists(wl.serverLists).map(l => ({ value: l.id, label: l.name, testId: `watch-list-tab-${l.id}` }))}
                                    value={wl.activeListId}
                                    onChange={id => { if (id !== wl.activeListId) wl.setActiveList(id); }}
                                    semantics='tabs'
                                    variant='scroll'
                                    ariaLabel='自選清單'
                                    disabled={wl.structureBusy}
                                    testId='watch-list-tabs'
                                />
                            </div>
                        ) : (
                            <p className={styles.listBarName}>{activeList?.name ?? ''}</p>
                        )}
                        <IconButton ariaLabel='新增自選清單' icon={Plus} onClick={() => setListSheet('create')} disabled={structureBusy} testId='watch-list-add' />
                    </div>
                )}
                {!ranking && editing && activeList && (
                    <div className={styles.listTools} data-testid='watch-list-tools'>
                        <button
                            type='button'
                            className={`${styles.listTool} ${pressable} ${focusRing}`}
                            disabled={structureBusy}
                            onClick={() => setListSheet('rename')}
                            data-testid='watch-list-rename'
                        >
                            重新命名
                        </button>
                        <button
                            type='button'
                            className={`${styles.listTool} ${styles.listToolDanger} ${pressable} ${focusRing}`}
                            disabled={!canDeleteList || structureBusy}
                            aria-label={deleteListLabel(activeList.name, confirmDelete, listBusy)}
                            onClick={() => void deleteList()}
                            data-testid='watch-list-delete'
                        >
                            {listBusy ? '刪除中…' : confirmDelete ? `確定刪除「${activeList.name}」` : '刪除清單'}
                        </button>
                        <EditSlot editKey={editKey} placeholder={null}>
                            <WatchEditTools confirmDelete={confirmDelete} reducedMotion={prefersReducedMotion} onOrder={bumpOrder} />
                        </EditSlot>
                    </div>
                )}
                {!ranking && listError && <InlineNote tone='danger' role='alert' testId='watch-list-error'>{listError}</InlineNote>}
            </div>

            {ranking && (
                <ModuleErrorBoundary onRetry={resetRankingList} fallback={props => <ModuleLoadError {...props} testId='ranking-load-error' />}>
                    <Suspense fallback={<Skeleton label='排行讀取中…' rows={6} testId='ranking-module-loading' />}>
                        <RankingList watchedCodes={watchedCodes} canAdd={canAdd} onAdd={onAddRanked} onOpen={openTrade} />
                    </Suspense>
                </ModuleErrorBoundary>
            )}

            {!ranking && wl.loadError && (
                <div className={styles.stateBlock}>
                    <InlineNote tone='danger' role='alert' action={{ label: '重試', onClick: () => wl.retryLoad(), testId: 'watch-retry' }}>
                        自選清單載入失敗。
                    </InlineNote>
                </div>
            )}
            {!ranking && !showList && listLoading && !wl.loadError && <Skeleton label='自選清單載入中…' rows={6} testId='watch-loading' />}

            {showHeader && (
                <div className={styles.listHeader} data-testid='watch-list-header'>
                    <span className={styles.headerName} aria-hidden='true'>名稱</span>
                    {showList && (
                        <button
                            type='button'
                            className={`${styles.metricToggle} ${pressable} ${focusRing}`}
                            aria-label={`第二行顯示${metric === 'pct' ? '漲跌與漲跌幅' : metricLabel}，點按切換（漲跌與漲跌幅、總量）`}
                            onClick={cycleMetric}
                            data-testid='watch-metric-toggle'
                            data-metric={metric}
                        >
                            {metricLabel}
                            <ChevronsUpDown className={styles.metricIcon} aria-hidden='true' focusable='false' />
                        </button>
                    )}
                    <button
                        type='button'
                        className={`${styles.editButton} ${pressable} ${focusRing}`}
                        aria-label={editing ? '完成編輯' : '編輯自選'}
                        aria-pressed={editing}
                        onClick={() => {
                            // 編輯鍵上次載入失敗：再次進入編輯模式時重新 import（未失敗時不動）
                            if (!editing) resetWatchEditControls();
                            setEditing(v => !v);
                        }}
                        data-testid='watch-edit'
                    >
                        <Pencil className={styles.metricIcon} aria-hidden='true' focusable='false' />
                        {editing ? '完成' : '編輯'}
                    </button>
                </div>
            )}

            {emptyList && !editing && (
                <EmptyState
                    icon={Star}
                    title='這份清單還沒有商品。'
                    description='搜尋代碼或名稱加入；自選清單與桌面共用。'
                    action={{ label: '搜尋並加入', onClick: openSearch, testId: 'watch-empty-search' }}
                    testId='watch-empty'
                />
            )}

            {showList && editing && (
                <ModuleErrorBoundary onRetry={retryEditControls} fallback={props => <ModuleLoadError {...props} testId='watch-edit-load-error' />}>
                    <Suspense fallback={null}>
                        <WatchEditReorder listRef={listRef} codes={codes} disabled={gripDisabled} onMove={reorderSymbol} reducedMotion={prefersReducedMotion} onChange={onReorder} />
                    </Suspense>
                </ModuleErrorBoundary>
            )}
            {showList && (
                <ul ref={listRef} className={styles.list} aria-label='自選商品' data-testid='watch-list'>
                    {wl.items.map((item, index) => (
                        <WatchRow
                            key={item.contract.code}
                            item={item}
                            index={index}
                            tracker={tracker}
                            editing={editing}
                            editKey={editKey}
                            metric={metric}
                            spark={spark}
                            punished={punished.has(item.contract.code)}
                            dragging={reorder?.dragging === item.contract.code}
                            gripDisabled={gripDisabled || !reorder}
                            grip={reorder?.grip ?? NOOP_GRIP}
                            onOpen={openRow}
                            onActions={openActions}
                            onRemove={askRemove}
                            onTicket={quickTicket}
                        />
                    ))}
                </ul>
            )}
            {!ranking && editing && (
                <button
                    type='button'
                    className={`${styles.addSymbolRow} ${pressableRow} ${focusRing}`}
                    disabled={!canAdd}
                    onClick={openSearch}
                    data-testid='watch-add-symbol'
                >
                    <Plus size={20} aria-hidden='true' focusable='false' />
                    加入股票
                </button>
            )}

            <ModuleErrorBoundary
                onRetry={resetSearchSheet}
                fallback={props => <SheetLoadError {...props} open={searchOpen} onClose={closeSearch} testId='search-load-error' />}
            >
                <Suspense fallback={null}>
                    {searchMounted && (
                        <SearchSheet
                            open={searchOpen}
                            onClose={closeSearch}
                            watchedCodes={watchedCodes}
                            canAdd={canAdd}
                            onAdd={onAdd}
                            onOpenTrade={code => {
                                setSearchOpen(false);
                                openTrade(code);
                            }}
                        />
                    )}
                </Suspense>
            </ModuleErrorBoundary>
            <RowActionsSheet
                code={actionCode}
                mode={actionMode}
                items={wl.items}
                onClose={() => setActionCode(null)}
                onOpen={openTrade}
                onRemove={onRemove}
                onMove={reorderSymbol}
            />
            <ModuleErrorBoundary
                onRetry={resetWatchListSheet}
                fallback={props => <SheetLoadError {...props} open={!ranking && listSheet !== null} onClose={() => setListSheet(null)} testId='watch-list-sheet-load-error' />}
            >
                <Suspense fallback={null}>
                    {listSheetMounted && (
                        <WatchListSheet
                            mode={ranking ? null : listSheet}
                            currentName={activeList?.name ?? ''}
                            names={listNames}
                            busy={wl.structureBusy}
                            onCreate={createList}
                            onRename={renameCurrentList}
                            onClose={() => setListSheet(null)}
                        />
                    )}
                </Suspense>
            </ModuleErrorBoundary>
            {/* 底部指數列：殼層配件槽（分頁列之上）；只在自選頁掛載時訂閱加權／櫃買 */}
            <ShellSlot slot='bottom'>
                <WatchIndexStrip />
            </ShellSlot>
        </section>
    );
}
