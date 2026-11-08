// src/mobile/components/watch-edit-controls.tsx — 自選編輯模式的列首、列尾鍵、拖曳排序與多選刪除（延遲載入；規格 §13 首次載入體積）
//
// - 只有編輯模式用到，不進首屏 chunk：自選頁經 lib/deferred-modules.ts 的 loadWatchEditControls() 以 retryableLazy
//   載入（各匯出共用同一個 chunk），app.tsx 閒置預載。非編輯模式不載入本檔與 lib/watch-reorder.ts。
// - WatchEditReorder：本身不渲染任何東西，呼叫 useListReorder（hooks 不能條件呼叫，所以拆成元件），把結果
//   （拖曳中的代碼、blocked、握把事件）以 onChange 交給自選頁；只在編輯模式且有清單時掛載，卸載時 onChange(null)，
//   useListReorder 卸載時取消拖曳並還原列的 transform。
// - WatchEditLeading（列首「−」）、WatchEditTrailing（列尾「⋯」＋握把）：列（components/quote-row.tsx）仍由自選頁渲染，
//   進出編輯模式不重掛列（列的可見度與行情訂閱不受影響）；這兩個只是列的 leading／trailing。
//   載入前與載入失敗時，自選頁放同尺寸的空白佔位（列寬不跳動）。
// - 本檔不 import motion/prefs（減少動態由自選頁傳入）：避免 prefs 從首屏共用 chunk 拆成另一個首屏請求。
// - 多選刪除（WatchEditTools，放在編輯模式的清單工具列）：
//   - 「多選」切換鍵（aria-pressed）。開啟時列首「−」換成勾選圈（role=checkbox、aria-checked、「選取 2330 台積電」、44px），
//     點一列也是切換勾選（不開交易頁、不開操作面板）；工具列出現「全選」（三態 aria-checked true／false／mixed）；
//     底部配件槽（ShellSlot bottom）顯示「已選 N 檔」「取消」「刪除 N 檔」；拖曳與鍵盤排序、「⋯」停用。
//   - 選取以代碼為鍵，模組層小 store（本 chunk 內：列首、列尾、WatchEditReorder 與工具列共用，自選頁首屏不必知道多選狀態）；
//     清單裡消失的代碼自動移除，換清單時清空，離開編輯模式（工具列卸載）時結束多選。
//   - 「刪除 N 檔」→ 確認面板列出要移除的商品；確定後依序（逐檔 await）呼叫 hook 的 removeSymbol（每檔 DELETE＋GET 清單），
//     顯示進度；清單變忙碌（載入、結構更新）、出錯、換清單時停止。結束後關閉面板、結束多選並以 notify() 回報移除幾檔、幾檔未移除。
//     開始前清單載入中、結構更新中、載入失敗（canReorderList 同一組條件）時停用。只改自選，不下單（S1）。
// - 排序群組（GroupSortSheet，工具列「排序群組」開啟；兩個以上清單才可用、多選中不顯示）：
//   面板直列每個群組（清單），握把拖曳（useListReorder，與自選列相同的手勢規則與減少動態）、握把上 ↑／↓ 鍵與每列的 ↑／↓ 鍵
//   一次移一格；放手或移動即存（saveListOrder → localStorage，再以 onOrder 通知自選頁重繪），「完成」關閉。伺服器的自選清單沒有順序欄位與排序 API，
//   順序只存在這台裝置（localStorage），桌面不受影響；不發任何網路請求。自選頁清單分頁與交易頁 ☆ 面板都依這個順序顯示。
// - 多選刪除群組（使用者要求「排序群組的時候也支援多選刪除，刪除時須使用者確認」）：排序群組面板的「選取」（aria-pressed）→
//   每列勾選鍵（role=checkbox、「選取群組「主要」（7 檔）」、點列也可切換；握把與 ↑／↓ 隱藏；不提供全選——不能全部刪除）→
//   底部「已選 N 個｜取消｜刪除 N 個群組」（N＝0、全選、清單忙碌或載入失敗時停用並寫原因）→ 同一面板切到確認畫面
//   （「刪除 N 個群組？」、各群組檔數與合計、無法復原的警語、含目前群組時說明會切換）→「確定刪除」才發請求（deleteGroups）。
//   進行中顯示進度、面板不可關閉；結束後一則摘要通知、回到排序、把刪掉的 id 從這台裝置的順序移除。只改自選，不下單（S1）。

import { ChevronDown, ChevronUp, Circle, CircleCheck, CircleMinus, GripVertical, MoreHorizontal, Square, SquareCheck, SquareMinus } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { deleteWatchlist } from '../../lib/shioaji';
import { notify } from '../../lib/trade';
import { emitWatchlistChanged } from '../../lib/watchlist-sync';
import { LIST_ORDER_KEY, orderLists, readListOrder } from '../lib/watch-list-order';
import { useListReorder, type ListReorder } from '../lib/watch-reorder';
import { useMobileWatchlist, type MobileWatchlist } from '../lib/watchlist-context';
import { button } from '../styles/controls.css';
import { focusRing, pressable } from '../styles/primitives.css';
import * as edit from '../styles/watch-edit.css';
import * as styles from '../styles/watchlist.css';
import * as iconStyles from '../ui/icon-button.css';
import { IconButton } from '../ui/icon-button';
import { ShellSlot } from '../ui/shell-slots';
import { BottomSheet } from './bottom-sheet';

// ---------------------------------------------------------------------------
// 多選狀態（本 chunk 內的小 store）

export interface MultiSelect {
    on: boolean;
    /** 已選的代碼 */
    sel: ReadonlySet<string>;
    /** 刪除進行中：已移除幾檔／共幾檔（null＝沒有在刪除） */
    run: { done: number; total: number } | null;
}

let multi: MultiSelect = { on: false, sel: new Set(), run: null };
const multiListeners = new Set<() => void>();
const setMulti = (patch: Partial<MultiSelect>) => {
    multi = { ...multi, ...patch };
    multiListeners.forEach(l => l());
};
const subscribeMulti = (l: () => void) => {
    multiListeners.add(l);
    return () => { multiListeners.delete(l); };
};
const getMulti = () => multi;
export const useMultiSelect = (): MultiSelect => useSyncExternalStore(subscribeMulti, getMulti, getMulti);

/** 切換一檔的勾選（刪除進行中忽略） */
export function toggleSelected(code: string): void {
    if (multi.run) return;
    const sel = new Set(multi.sel);
    if (!sel.delete(code)) sel.add(code);
    setMulti({ sel });
}

const endMulti = () => setMulti({ on: false, sel: new Set(), run: null });

/** 測試用：回到初始狀態 */
export function resetMultiSelectForTest(): void {
    multi = { on: false, sel: new Set(), run: null };
}

// ---------------------------------------------------------------------------
// 拖曳排序、列首、列尾

export interface WatchEditReorderProps {
    listRef: RefObject<HTMLElement | null>;
    codes: readonly string[];
    /** 握把停用（清單載入中、載入失敗、結構更新中或不可寫入） */
    disabled: boolean;
    onMove: (from: string, to: string) => void;
    /** 系統減少動態（motion/prefs 的 prefersReducedMotion；由自選頁傳入） */
    reducedMotion: () => boolean;
    /** 掛載時與拖曳狀態改變時（開始、結束各一次）呼叫；卸載時以 null 呼叫。需為穩定的函式 */
    onChange: (reorder: ListReorder | null) => void;
}

export const WatchEditReorder = memo(function WatchEditReorder({ listRef, codes, disabled, onMove, reducedMotion, onChange }: WatchEditReorderProps) {
    const { on } = useMultiSelect();
    // 多選中不能拖曳、也不能以鍵盤排序
    const { dragging, blocked: dragBlocked, grip } = useListReorder({ listRef, codes, disabled: disabled || on, onMove, reducedMotion });
    // 多選中：點列＝切換勾選（擋下開交易頁與長按）
    const blocked = useCallback((code?: string) => {
        if (!multi.on) return dragBlocked();
        if (code) toggleSelected(code);
        return true;
    }, [dragBlocked]);
    // layout effect：拖曳中的列樣式與握把啟用在繪製前就反映到自選頁
    useLayoutEffect(() => { onChange({ dragging, blocked, grip }); }, [dragging, blocked, grip, onChange]);
    useLayoutEffect(() => () => onChange(null), [onChange]);
    return null;
});

/** 列首：「−」開移除確認（自選頁的操作面板 'remove' 模式）；多選中是勾選圈 */
export function WatchEditLeading({ code, label, onRemove }: { code: string; label: string; onRemove: (code: string) => void }) {
    const { on, sel, run } = useMultiSelect();
    if (on) {
        const checked = sel.has(code);
        const Icon = checked ? CircleCheck : Circle;
        return (
            <span className={edit.checkCell}>
                <button
                    type='button'
                    role='checkbox'
                    aria-checked={checked}
                    aria-label={`選取 ${label}`}
                    className={`${iconStyles.button.regular} ${edit.check} ${pressable} ${focusRing}`}
                    disabled={run !== null}
                    onClick={() => toggleSelected(code)}
                    data-testid='watch-row-select'
                >
                    <Icon size={22} aria-hidden='true' focusable='false' />
                </button>
            </span>
        );
    }
    return (
        <span className={styles.rowLeading}>
            <IconButton ariaLabel={`從自選移除 ${label}`} icon={CircleMinus} onClick={() => onRemove(code)} testId='watch-row-remove' />
        </span>
    );
}

/** 列尾「⋯」（操作面板）＋拖曳握把（只有握把能拖；↑／↓ 一次移一格）；多選中兩者停用 */
export function WatchEditTrailing({ code, label, gripDisabled, grip, onActions }: {
    code: string;
    label: string;
    /** 握把停用（清單忙碌，或拖曳排序尚未就緒） */
    gripDisabled: boolean;
    grip: ListReorder['grip'];
    onActions: (code: string) => void;
}) {
    const { on } = useMultiSelect();
    return (
        <span className={`${styles.rowTrailing} ${styles.trailingPair}`}>
            <IconButton ariaLabel={`${code} 更多操作`} icon={MoreHorizontal} disabled={on} onClick={() => onActions(code)} testId='watch-more' />
            <button
                type='button'
                className={`${styles.grip} ${focusRing}`}
                aria-label={`拖曳以調整 ${label} 的位置`}
                aria-keyshortcuts='ArrowUp ArrowDown'
                disabled={gripDisabled || on}
                onPointerDown={e => grip.onPointerDown(code, e)}
                onPointerMove={grip.onPointerMove}
                onPointerUp={grip.onPointerUp}
                onPointerCancel={grip.onPointerCancel}
                onLostPointerCapture={grip.onPointerCancel}
                onKeyDown={e => grip.onKeyDown(code, e)}
                onClick={grip.onClick}
                onContextMenu={e => e.preventDefault()}
                data-testid='watch-row-grip'
            >
                <GripVertical size={20} aria-hidden='true' focusable='false' />
            </button>
        </span>
    );
}

// ---------------------------------------------------------------------------
// 多選刪除

/** 等條件成立（最多 ms 毫秒；回傳最後一次的結果）。用來等 hook 的狀態更新反映到畫面 */
async function settle(pred: () => boolean, ms = 2_000): Promise<boolean> {
    for (const end = Date.now() + ms; !pred() && Date.now() < end;) await new Promise(r => setTimeout(r, 16));
    return pred();
}

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : '請稍後再試');

export interface RemoveSelectedResult {
    removed: number;
    /** 停止的原因；全部完成時 null */
    reason: string | null;
}

/**
 * 依序移除（逐檔 await hook 的 removeSymbol；每檔 DELETE＋GET 清單，不發其他請求）。
 * get() 回傳最新一次渲染的 hook 狀態：每檔開始前確認仍是同一個清單、沒有載入中／結構更新中／載入失敗；
 * 呼叫後等到該檔從清單消失才算移除（hook 在忙碌時會直接返回、不丟錯，所以不能只看有沒有丟錯）。
 * 已不在清單裡的代碼略過（不算移除、也不發請求）。
 */
export async function removeSelected(get: () => MobileWatchlist, codes: readonly string[], onProgress: (removed: number) => void): Promise<RemoveSelectedResult> {
    const listId = get().activeListId;
    let removed = 0;
    const has = (code: string) => get().items.some(i => i.contract.code === code);
    for (const code of codes) {
        const wl = get();
        if (wl.activeListId !== listId) return { removed, reason: '自選清單已切換' };
        if (wl.loadError) return { removed, reason: '自選清單載入失敗' };
        if (wl.loading || wl.structureBusy) return { removed, reason: '自選清單更新中' };
        if (!has(code)) continue;
        try {
            await wl.removeSymbol(code);
        } catch (e) {
            return { removed, reason: errText(e) };
        }
        if (!(await settle(() => !has(code)))) return { removed, reason: '自選清單更新中' };
        onProgress(++removed);
    }
    return { removed, reason: null };
}

/** 結果通知的文字（全部完成：ok；有未移除：err，附原因） */
export function removeSummary(r: RemoveSelectedResult, total: number, listName: string): { kind: 'ok' | 'err'; title: string; body: string } {
    if (r.reason === null) return { kind: 'ok', title: '已從自選移除', body: `已從「${listName}」移除 ${r.removed} 檔` };
    return { kind: 'err', title: '多選刪除未完成', body: `已移除 ${r.removed} 檔，${total - r.removed} 檔未移除：${r.reason}` };
}

/** 確認面板：列出要移除的商品；確定後依序移除並顯示進度（進行中不可關閉） */
function RemoveConfirmSheet({ open, items, listName, disabled, run, onCancel, onConfirm }: {
    open: boolean;
    items: readonly { code: string; name: string }[];
    listName: string;
    disabled: boolean;
    run: MultiSelect['run'];
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const n = items.length;
    return (
        <BottomSheet open={open} onClose={onCancel} dismissible={run === null} title={`刪除 ${n} 檔自選`} testId='watch-multi-confirm'>
            <div className={edit.sheetBody}>
                <p className={edit.note}>以下商品會從「{listName}」移除。自選清單與桌面共用，移除後桌面也會看不到。</p>
                <ul className={`${edit.sheetList} ${edit.sheetListScroll}`} aria-label='要移除的商品' data-testid='watch-multi-confirm-list'>
                    {items.map(i => (
                        <li key={i.code} className={edit.sheetItem}>
                            <span className={edit.itemName}>{`${i.code} ${i.name}`.trim()}</span>
                        </li>
                    ))}
                </ul>
                <p className={edit.note} role='status' data-testid='watch-multi-progress'>
                    {run ? `刪除中 ${run.done}／${run.total}…` : ''}
                </p>
                <div className={edit.actions}>
                    <button type='button' className={button.neutral} disabled={run !== null} onClick={onCancel} data-testid='watch-multi-confirm-cancel'>
                        取消
                    </button>
                    <button type='button' className={button.danger} disabled={disabled || run !== null || n === 0} onClick={onConfirm} data-testid='watch-multi-confirm-ok'>
                        {run ? '刪除中…' : `確定刪除 ${n} 檔`}
                    </button>
                </div>
            </div>
        </BottomSheet>
    );
}

// ---------------------------------------------------------------------------
// 排序群組（只存在這台裝置）

/** 存群組順序（清單 id 陣列；只存目前顯示的清單，已刪除的 id 因此移除）。寫入失敗（儲存空間不可用）時不保留 */
export function saveListOrder(ids: readonly string[]): void {
    try {
        localStorage.setItem(LIST_ORDER_KEY, JSON.stringify(ids));
    } catch {
        // 無痕或配額不足：不保留
    }
}

/** 把 from 移到 to 的位置（與 use-watchlist 的 reorderSymbol 相同語意）；任一不在清單中時回傳原陣列 */
export function moveId(ids: readonly string[], from: string, to: string): readonly string[] {
    const i = ids.indexOf(from);
    const j = ids.indexOf(to);
    if (i < 0 || j < 0 || i === j) return ids;
    const next = ids.filter(id => id !== from);
    next.splice(j, 0, from);
    return next;
}

// ---------------------------------------------------------------------------
// 多選刪除群組（排序群組面板的「選取」模式）

export interface GroupDeleteResult {
    /** 已刪除的群組名稱（依刪除順序；目前群組在最後） */
    deleted: string[];
    /** 已刪除的群組 id */
    ids: string[];
    /** 執行前已不存在而略過的群組名稱 */
    skipped: string[];
    /** 停止的原因；全部完成時 null */
    reason: string | null;
    /** 有刪到目前群組時，刪除後切換到的群組名稱 */
    switchedTo: string | null;
}

/**
 * 依序刪除群組（遇到第一個失敗就停止）。get() 回傳最新一次渲染的 hook 狀態。
 * - 執行前再驗一次：hook 不在載入中／結構更新中／載入失敗、選取的群組仍存在（不存在的略過）、刪除後至少還剩一個。
 * - 非目前的群組：lib 的 deleteWatchlist(id)，每個 1 次 DELETE（hook 只能刪目前清單，其他清單走 AI Agent 工具同一條外部變更路徑）。
 * - 目前的群組（有選才做）：最後以 hook 的 deleteCurrentList()（排進該清單的寫入佇列，DELETE＋GET 清單，再切到伺服器順序的第一個清單）；
 *   hook 在結構更新中會直接返回、不丟錯，所以等到該群組從 serverLists 消失才算刪除。
 * - 刪過（或試過）非目前的群組、而 hook 的 serverLists 仍有它們時，最後 emitWatchlistChanged({ source: 'user' }) 一次讓 hook 重新讀取；
 *   有刪到目前群組時，deleteCurrentList 的 GET 已經是伺服器的最新清單（也不含其他被刪的群組），就不再重新讀取（省一次整份重讀）。
 *   事件放在最後：若在 deleteCurrentList 之前發，hook 的重新讀取會把結構鎖住，deleteCurrentList 會直接返回。
 */
export async function deleteGroups(get: () => MobileWatchlist, picked: readonly { id: string; name: string }[], onProgress: (deleted: number) => void): Promise<GroupDeleteResult> {
    const result: GroupDeleteResult = { deleted: [], ids: [], skipped: [], reason: null, switchedTo: null };
    const exists = (id: string) => get().serverLists.some(l => l.id === id);
    const busyReason = (wl: MobileWatchlist) => (wl.loadError ? '自選清單載入失敗' : wl.loading || wl.structureBusy ? '自選清單更新中' : null);
    const wl = get();
    result.reason = busyReason(wl);
    if (result.reason) return result;
    const live = picked.filter(p => exists(p.id));
    result.skipped = picked.filter(p => !exists(p.id)).map(p => p.name);
    if (live.length && live.length >= wl.serverLists.length) {
        result.reason = '至少要保留一個群組';
        return result;
    }
    const active = live.find(p => p.id === wl.activeListId);
    const others = live.filter(p => p !== active);
    let tried = 0;
    for (const p of others) {
        tried++;
        try {
            await deleteWatchlist(p.id);
        } catch (e) {
            result.reason = `「${p.name}」${errText(e)}`;
            break;
        }
        result.deleted.push(p.name);
        result.ids.push(p.id);
        onProgress(result.deleted.length);
    }
    if (active && !result.reason) {
        const now = get();
        result.reason = now.activeListId !== active.id ? '自選清單已切換' : busyReason(now);
        if (!result.reason) {
            try {
                await now.deleteCurrentList();
            } catch (e) {
                result.reason = `「${active.name}」${errText(e)}`;
            }
            if (!result.reason && !(await settle(() => !exists(active.id)))) result.reason = '自選清單更新中';
            if (!result.reason) {
                result.deleted.push(active.name);
                result.ids.push(active.id);
                onProgress(result.deleted.length);
                const after = get();
                result.switchedTo = after.serverLists.find(l => l.id === after.activeListId)?.name ?? null;
            }
        }
    }
    if (others.slice(0, tried).some(p => exists(p.id))) emitWatchlistChanged({ source: 'user' });
    return result;
}

/**
 * 結果通知（一則）。只刪了目前群組且成功時回傳 null：hook 的 deleteCurrentList 已發「已刪除清單」，不再重複；
 * 其他情況發摘要（含目前群組時，hook 那則會在摘要之前，摘要寫明切換到哪個群組）。
 */
export function groupDeleteSummary(r: GroupDeleteResult, total: number, activeName: string | null): { kind: 'ok' | 'err' | 'info'; title: string; body: string } | null {
    const skipped = r.skipped.length ? `「${r.skipped.join('」「')}」已不存在，略過。` : '';
    const switched = r.switchedTo ? `已切換到「${r.switchedTo}」。` : '';
    if (r.reason) {
        return { kind: 'err', title: '群組刪除未完成', body: `已刪除 ${r.deleted.length} 個，${total - r.skipped.length - r.deleted.length} 個未刪除：${r.reason}。${skipped}` };
    }
    if (!r.deleted.length) return { kind: 'info', title: '沒有刪除群組', body: skipped };
    if (r.deleted.length === 1 && r.deleted[0] === activeName && !skipped) return null;
    return { kind: 'ok', title: `已刪除 ${r.deleted.length} 個群組`, body: `${r.deleted.join('、')}。${switched}${skipped}` };
}

/** 選取模式「刪除 N 個群組」停用的原因；可刪時 null */
export function groupDeleteBlocked(n: number, lists: number, wl: Pick<MobileWatchlist, 'loading' | 'structureBusy' | 'loadError'>): string | null {
    if (!n) return '請選取要刪除的群組';
    if (n >= lists) return '至少要保留一個群組';
    if (wl.loadError) return '自選清單載入失敗';
    return wl.loading || wl.structureBusy ? '自選清單更新中' : null;
}

/**
 * 排序群組面板：拖曳握把（或握把上 ↑／↓）、每列 ↑／↓ 鍵；移動即存在這台裝置，不發請求。
 * 「選取」模式：每列勾選鍵（點列也可切換）、底部「已選 N 個｜取消｜刪除 N 個群組」；刪除先在同一面板切到確認畫面
 * （列出群組、檔數與合計、警語；焦點移到確認標題，返回時回到刪除鍵），按「確定刪除」才發請求（deleteGroups）。
 */
function GroupSortSheet({ open, onClose, reducedMotion, onOrder }: { open: boolean; onClose: () => void; reducedMotion: () => boolean; onOrder: () => void }) {
    const wl = useMobileWatchlist();
    const latest = useRef(wl);
    latest.current = wl;
    const { serverLists, activeListId } = wl;
    /** 存在這台裝置的順序（開啟時重新讀取；移動時更新並存檔） */
    const [saved, setSaved] = useState<readonly string[]>(readListOrder);
    /** sort：排序；select：選取要刪除的群組；confirm：刪除確認（同一面板） */
    const [mode, setMode] = useState<'sort' | 'select' | 'confirm'>('sort');
    const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set());
    /** 刪除進行中：已刪除幾個／共幾個 */
    const [run, setRun] = useState<{ done: number; total: number } | null>(null);
    /** 這次刪掉的群組：hook 重新讀取完成前 serverLists 可能還有它們，先不顯示（伺服器上已刪除） */
    const [dropped, setDropped] = useState<readonly string[]>([]);
    useEffect(() => {
        if (!open) return;
        setSaved(readListOrder());
        setMode('sort');
        setSel(new Set());
        setDropped([]);
    }, [open]);
    const lists = useMemo(() => orderLists(serverLists.filter(l => !dropped.includes(l.id)), saved), [serverLists, saved, dropped]);
    const ids = useMemo(() => lists.map(l => l.id), [lists]);
    // 清單裡消失的群組移出選取（刪除進行中除外：確認畫面要列出全部）
    useEffect(() => {
        if (!run && [...sel].some(id => !ids.includes(id))) setSel(new Set([...sel].filter(id => ids.includes(id))));
    }, [ids, sel, run]);
    const listRef = useRef<HTMLUListElement | null>(null);
    const move = useCallback((from: string, to: string) => {
        const next = moveId(ids, from, to);
        setSaved(next);
        saveListOrder(next);
        onOrder();
    }, [ids, onOrder]);
    const sorting = mode === 'sort';
    const { dragging, grip } = useListReorder({ listRef, codes: ids, disabled: !open || !sorting, onMove: move, reducedMotion });
    /** ↑／↓ 鍵移動後把焦點放回同一列的同方向鍵（到頂／底而停用時改放另一個方向）；列以 id 為 key，DOM 搬移時可能失焦 */
    const refocus = useRef<{ id: string; dir: 'up' | 'down' } | null>(null);
    useLayoutEffect(() => {
        const r = refocus.current;
        refocus.current = null;
        const row = r ? Array.from(listRef.current?.children ?? []).find(el => el.getAttribute('data-code') === r.id) : undefined;
        if (!r || !row || typeof row.querySelector !== 'function') return;
        const btn = row.querySelector<HTMLButtonElement>(`[data-dir="${r.dir}"]:not(:disabled)`) ?? row.querySelector<HTMLButtonElement>('[data-dir]:not(:disabled)');
        btn?.focus();
    }, [ids]);
    const step = (id: string, dir: 'up' | 'down') => {
        const to = ids[ids.indexOf(id) + (dir === 'up' ? -1 : 1)];
        if (!to) return;
        refocus.current = { id, dir };
        move(id, to);
    };

    // 選取與確認
    const toggle = (id: string) => {
        if (mode !== 'select') return;
        const next = new Set(sel);
        if (!next.delete(id)) next.add(id);
        setSel(next);
    };
    const picked = lists.filter(l => sel.has(l.id));
    const n = picked.length;
    const blocked = groupDeleteBlocked(n, lists.length, wl);
    const activeName = serverLists.find(l => l.id === activeListId)?.name ?? null;
    /** 確認畫面的標題（進入時焦點移到這裡）與選取模式的刪除鍵（返回時焦點回到這裡） */
    const confirmTitle = useRef<HTMLHeadingElement | null>(null);
    const deleteBtn = useRef<HTMLButtonElement | null>(null);
    /** 刪除完成後焦點回到「選取」鍵；只剩一個群組時它停用，改到群組列表（tabIndex −1），不讓焦點掉到 body */
    const selectBtn = useRef<HTMLButtonElement | null>(null);
    const focusAfter = useRef<'title' | 'delete' | 'select' | null>(null);
    useLayoutEffect(() => {
        const f = focusAfter.current;
        focusAfter.current = null;
        const sel = selectBtn.current;
        const el = f === 'title' ? confirmTitle.current
            : f === 'delete' ? deleteBtn.current
            : f === 'select' ? (sel && !sel.disabled ? sel : listRef.current)
            : null;
        if (el && typeof el.focus === 'function') el.focus();
    }, [mode]);
    const exitSelect = () => {
        setSel(new Set());
        setMode('sort');
    };
    const confirm = async () => {
        if (run || groupDeleteBlocked(n, lists.length, latest.current)) return;
        const targets = picked.map(l => ({ id: l.id, name: l.name }));
        setRun({ done: 0, total: targets.length });
        const result = await deleteGroups(() => latest.current, targets, done => setRun({ done, total: targets.length }));
        // 刪掉的群組從這台裝置的順序移除（只留仍存在的清單）
        const left = orderLists(latest.current.serverLists, saved).map(l => l.id).filter(id => !result.ids.includes(id));
        setDropped(result.ids);
        setSaved(left);
        saveListOrder(left);
        onOrder();
        setRun(null);
        setSel(new Set());
        focusAfter.current = 'select';
        setMode('sort');
        const summary = groupDeleteSummary(result, targets.length, activeName);
        if (summary) notify(summary);
    };

    const total = picked.reduce((s, l) => s + l.contracts.length, 0);
    const footer = mode === 'confirm' ? (
        <div className={edit.actions}>
            <button
                type='button'
                className={button.neutral}
                disabled={run !== null}
                onClick={() => {
                    focusAfter.current = 'delete';
                    setMode('select');
                }}
                data-testid='watch-group-del-back'
            >
                返回
            </button>
            <button type='button' className={button.danger} disabled={run !== null || blocked !== null} onClick={() => void confirm()} data-testid='watch-group-del-ok'>
                {run ? '刪除中…' : `確定刪除 ${n} 個群組`}
            </button>
        </div>
    ) : mode === 'select' ? (
        <div className={edit.sheetBody}>
            <p className={edit.barCount} role='status' data-testid='watch-group-sel-count'>{`已選 ${n} 個`}</p>
            {blocked && <p className={edit.note} data-testid='watch-group-del-reason'>{blocked}</p>}
            <div className={edit.actions}>
                <button type='button' className={button.neutral} onClick={exitSelect} data-testid='watch-group-sel-cancel'>取消</button>
                <button
                    ref={deleteBtn}
                    type='button'
                    className={`${edit.dangerOutline} ${pressable} ${focusRing}`}
                    disabled={blocked !== null}
                    onClick={() => {
                        focusAfter.current = 'title';
                        setMode('confirm');
                    }}
                    data-testid='watch-group-del'
                >
                    {`刪除 ${n} 個群組`}
                </button>
            </div>
        </div>
    ) : (
        // 與其他面板一致：鍵填滿底部寬度（edit.actions 的子鍵 flex 1）
        <div className={edit.actions}>
            <button type='button' className={button.primary} onClick={onClose} data-testid='watch-group-sort-done'>完成</button>
        </div>
    );

    return (
        <BottomSheet open={open} onClose={onClose} dismissible={run === null} title='排序群組' testId='watch-group-sort' footer={footer}>
            {mode === 'confirm' ? (
                <div className={edit.sheetBody} data-testid='watch-group-del-confirm'>
                    <h3 ref={confirmTitle} tabIndex={-1} className={edit.confirmTitle} data-testid='watch-group-del-title'>{`刪除 ${n} 個群組？`}</h3>
                    <ul className={`${edit.sheetList} ${edit.sheetListScroll}`} aria-label='要刪除的群組' data-testid='watch-group-del-list'>
                        {picked.map(l => (
                            <li key={l.id} className={edit.sheetItem}>
                                <span className={edit.itemName}>{l.name}{l.id === activeListId ? '（目前）' : ''}</span>
                                <span className={edit.itemMeta}>{`${l.contracts.length} 檔`}</span>
                            </li>
                        ))}
                    </ul>
                    <p className={edit.note} data-testid='watch-group-del-total'>{`合計 ${total} 檔。自選清單與桌面共用，刪除後桌面也會看不到，無法復原。`}</p>
                    {picked.some(l => l.id === activeListId) && (
                        <p className={edit.note} data-testid='watch-group-del-active'>包含目前的群組，刪除後會切換到其他群組。</p>
                    )}
                    <p className={edit.note} role='status' data-testid='watch-group-del-progress'>{run ? `刪除中 ${run.done}／${run.total}…` : ''}</p>
                </div>
            ) : (
                <div className={edit.sheetBody}>
                    <p className={edit.note}>
                        {sorting
                            ? '拖曳右側握把，或按 ↑／↓ 調整自選頁群組分頁的順序。群組順序只存在這台裝置，桌面不受影響。'
                            : '勾選要刪除的群組（點一列也可以勾選），至少要保留一個群組。'}
                    </p>
                    <div className={styles.listTools}>
                        <button
                            ref={selectBtn}
                            type='button'
                            className={`${styles.listTool} ${edit.toolOn} ${pressable} ${focusRing}`}
                            aria-pressed={!sorting}
                            disabled={lists.length < 2}
                            onClick={() => (sorting ? setMode('select') : exitSelect())}
                            data-testid='watch-group-select'
                        >
                            {!sorting && <CircleCheck size={18} aria-hidden='true' focusable='false' />}
                            選取
                        </button>
                    </div>
                    <ul ref={listRef} tabIndex={-1} className={edit.sheetList} aria-label={sorting ? '群組順序' : '選取要刪除的群組'} data-testid='watch-group-sort-list'>
                        {lists.map((l, i) => {
                            const checked = sel.has(l.id);
                            const Check = checked ? CircleCheck : Circle;
                            return (
                                <li
                                    key={l.id}
                                    data-code={l.id}
                                    className={`${edit.sheetItem}${dragging === l.id ? ` ${styles.rowDragging}` : ''}`}
                                    onClick={sorting ? undefined : () => toggle(l.id)}
                                    data-testid='watch-group-row'
                                >
                                    {!sorting && (
                                        <button
                                            type='button'
                                            role='checkbox'
                                            aria-checked={checked}
                                            aria-label={`選取群組「${l.name}」（${l.contracts.length} 檔）`}
                                            className={`${iconStyles.button.regular} ${edit.check} ${edit.groupCheck} ${pressable} ${focusRing}`}
                                            onClick={e => {
                                                e.stopPropagation();
                                                toggle(l.id);
                                            }}
                                            data-testid='watch-group-check'
                                        >
                                            <Check size={22} aria-hidden='true' focusable='false' />
                                        </button>
                                    )}
                                    <span className={edit.itemName}>{l.name}{l.id === activeListId ? '（目前）' : ''}</span>
                                    <span className={edit.itemMeta}>{`${l.contracts.length} 檔`}</span>
                                    {sorting && (
                                        <span className={styles.trailingPair}>
                                            <button
                                                type='button'
                                                className={`${iconStyles.button.regular} ${pressable} ${focusRing}`}
                                                aria-label={`上移「${l.name}」`}
                                                disabled={i === 0}
                                                onClick={() => step(l.id, 'up')}
                                                data-dir='up'
                                                data-testid='watch-group-up'
                                            >
                                                <ChevronUp size={20} aria-hidden='true' focusable='false' />
                                            </button>
                                            <button
                                                type='button'
                                                className={`${iconStyles.button.regular} ${pressable} ${focusRing}`}
                                                aria-label={`下移「${l.name}」`}
                                                disabled={i === lists.length - 1}
                                                onClick={() => step(l.id, 'down')}
                                                data-dir='down'
                                                data-testid='watch-group-down'
                                            >
                                                <ChevronDown size={20} aria-hidden='true' focusable='false' />
                                            </button>
                                            <button
                                                type='button'
                                                className={`${styles.grip} ${focusRing}`}
                                                aria-label={`拖曳以調整「${l.name}」的位置`}
                                                aria-keyshortcuts='ArrowUp ArrowDown'
                                                onPointerDown={e => grip.onPointerDown(l.id, e)}
                                                onPointerMove={grip.onPointerMove}
                                                onPointerUp={grip.onPointerUp}
                                                onPointerCancel={grip.onPointerCancel}
                                                onLostPointerCapture={grip.onPointerCancel}
                                                onKeyDown={e => grip.onKeyDown(l.id, e)}
                                                onClick={grip.onClick}
                                                onContextMenu={e => e.preventDefault()}
                                                data-testid='watch-group-grip'
                                            >
                                                <GripVertical size={20} aria-hidden='true' focusable='false' />
                                            </button>
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </BottomSheet>
    );
}

/** 編輯模式說明文字（自選頁原本的 watch-edit-hint；移到這裡減少首屏體積）。confirmDelete＝刪除清單的確認中 */
export function editHint(multiOn: boolean, lists: number, confirmDelete: boolean): string {
    if (multiOn) return '勾選要移除的商品（點一列也可以勾選），再按下方「刪除」。';
    if (lists < 2) return '只剩一個清單時不能刪除。按住右側握把拖曳可調整順序，按「−」移除。';
    return confirmDelete ? '自選清單與桌面共用，刪除後桌面也會看不到。' : '按住右側握把拖曳可調整順序，按「−」移除；也可按「⋯」或長按一列。';
}

/**
 * 編輯模式的清單工具（自選頁 listTools 內，接在「重新命名」「刪除清單」之後）：「多選」切換、「全選」、「排序群組」、說明文字；
 * 多選中底部配件槽的選取列與確認面板；排序群組面板。reducedMotion：系統減少動態（由自選頁傳入，同 WatchEditReorder）；
 * onOrder：群組順序存檔後通知自選頁重繪清單分頁
 */
export function WatchEditTools({ confirmDelete, reducedMotion, onOrder }: { confirmDelete: boolean; reducedMotion: () => boolean; onOrder: () => void }) {
    const wl = useMobileWatchlist();
    const latest = useRef(wl);
    latest.current = wl;
    const { on, sel, run } = useMultiSelect();
    const [confirming, setConfirming] = useState(false);
    const [sorting, setSorting] = useState(false);
    /** 刪除開始時的清單（進行中面板列出的仍是全部要移除的商品） */
    const [frozen, setFrozen] = useState<readonly { code: string; name: string }[] | null>(null);
    const listName = wl.serverLists.find(l => l.id === wl.activeListId)?.name ?? '自選';
    // 開始前的條件（與握把相同：載入中、結構更新中、載入失敗時不可）
    const busy = wl.loading || wl.structureBusy || wl.loadError;

    // 離開編輯模式（卸載）時結束多選；換清單時清空勾選
    useEffect(() => endMulti, []);
    useEffect(() => { if (!multi.run) setMulti({ sel: new Set() }); }, [wl.activeListId]);
    // 清單裡消失的代碼移除
    useEffect(() => {
        const now = new Set(wl.items.map(i => i.contract.code));
        if ([...multi.sel].some(c => !now.has(c))) setMulti({ sel: new Set([...multi.sel].filter(c => now.has(c))) });
    }, [wl.items]);

    // 依清單順序列出已選的商品
    const picked = useMemo(
        () => wl.items.filter(i => sel.has(i.contract.code)).map(i => ({ code: i.contract.code, name: i.contract.name ?? '' })),
        [wl.items, sel],
    );
    const n = picked.length;
    const total = wl.items.length;
    const allState = n === 0 ? false : n === total ? true : 'mixed';

    const confirm = async () => {
        if (busy || multi.run || !n) return;
        const codes = picked.map(p => p.code);
        setFrozen(picked);
        setMulti({ run: { done: 0, total: codes.length } });
        const result = await removeSelected(() => latest.current, codes, done => setMulti({ run: { done, total: codes.length } }));
        setConfirming(false);
        setFrozen(null);
        endMulti();
        notify(removeSummary(result, codes.length, listName));
    };

    return (
        <>
            <button
                type='button'
                className={`${styles.listTool} ${edit.toolOn} ${pressable} ${focusRing}`}
                aria-pressed={on}
                disabled={run !== null || !total}
                onClick={() => (on ? endMulti() : setMulti({ on: true, sel: new Set() }))}
                data-testid='watch-multi'
            >
                {on && <CircleCheck size={18} aria-hidden='true' focusable='false' />}
                多選
            </button>
            {on && (
                <button
                    type='button'
                    role='checkbox'
                    aria-checked={allState}
                    className={`${styles.listTool} ${edit.toolOn} ${pressable} ${focusRing}`}
                    disabled={run !== null || !total}
                    onClick={() => setMulti({ sel: allState === true ? new Set() : new Set(wl.items.map(i => i.contract.code)) })}
                    data-testid='watch-select-all'
                >
                    {allState === true ? <SquareCheck size={18} aria-hidden='true' focusable='false' />
                        : allState ? <SquareMinus size={18} aria-hidden='true' focusable='false' />
                            : <Square size={18} aria-hidden='true' focusable='false' />}
                    全選
                </button>
            )}
            {!on && (
                <button
                    type='button'
                    className={`${styles.listTool} ${pressable} ${focusRing}`}
                    disabled={wl.serverLists.length < 2}
                    onClick={() => setSorting(true)}
                    data-testid='watch-group-sort-open'
                >
                    排序群組
                </button>
            )}
            {on && (
                <ShellSlot slot='bottom'>
                    <div className={edit.bar} data-testid='watch-multi-bar'>
                        <span className={edit.barCount} role='status' data-testid='watch-multi-count'>已選 {n} 檔</span>
                        <button type='button' className={button.neutral} disabled={run !== null} onClick={endMulti} data-testid='watch-multi-cancel'>
                            取消
                        </button>
                        <button
                            type='button'
                            className={`${edit.dangerOutline} ${pressable} ${focusRing}`}
                            disabled={busy || run !== null || !n}
                            onClick={() => setConfirming(true)}
                            data-testid='watch-multi-delete'
                        >
                            刪除 {n} 檔
                        </button>
                    </div>
                </ShellSlot>
            )}
            <p className={`${styles.listName} ${edit.hint}`} data-testid='watch-edit-hint'>{editHint(on, wl.serverLists.length, confirmDelete)}</p>
            <RemoveConfirmSheet
                open={confirming && (n > 0 || frozen !== null)}
                items={frozen ?? picked}
                listName={listName}
                disabled={busy}
                run={run}
                onCancel={() => { if (!multi.run) setConfirming(false); }}
                onConfirm={() => void confirm()}
            />
            <GroupSortSheet open={sorting} onClose={() => setSorting(false)} reducedMotion={reducedMotion} onOrder={onOrder} />
        </>
    );
}
