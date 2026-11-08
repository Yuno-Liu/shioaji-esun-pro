// src/mobile/components/watch-edit-controls.tsx — 自選編輯模式的列首、列尾鍵與拖曳排序（延遲載入；規格 §13 首次載入體積）
//
// - 只有編輯模式用到，不進首屏 chunk：自選頁經 lib/deferred-modules.ts 的 loadWatchEditControls() 以 retryableLazy
//   載入（三個匯出共用同一個 chunk），app.tsx 閒置預載。非編輯模式不載入本檔與 lib/watch-reorder.ts。
// - WatchEditReorder：本身不渲染任何東西，呼叫 useListReorder（hooks 不能條件呼叫，所以拆成元件），把結果
//   （拖曳中的代碼、blocked、握把事件）以 onChange 交給自選頁；只在編輯模式且有清單時掛載，卸載時 onChange(null)，
//   useListReorder 卸載時取消拖曳並還原列的 transform。
// - WatchEditLeading（列首「−」）、WatchEditTrailing（列尾「⋯」＋握把）：列（components/quote-row.tsx）仍由自選頁渲染，
//   進出編輯模式不重掛列（列的可見度與行情訂閱不受影響）；這兩個只是列的 leading／trailing。
//   載入前與載入失敗時，自選頁放同尺寸的空白佔位（列寬不跳動）。
// - 本檔不 import motion/prefs（減少動態由自選頁傳入）：避免 prefs 從首屏共用 chunk 拆成另一個首屏請求。

import { CircleMinus, GripVertical, MoreHorizontal } from 'lucide-react';
import { memo, useLayoutEffect, type RefObject } from 'react';
import { useListReorder, type ListReorder } from '../lib/watch-reorder';
import { focusRing } from '../styles/primitives.css';
import * as styles from '../styles/watchlist.css';
import { IconButton } from '../ui/icon-button';

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
    const { dragging, blocked, grip } = useListReorder({ listRef, codes, disabled, onMove, reducedMotion });
    // layout effect：拖曳中的列樣式與握把啟用在繪製前就反映到自選頁
    useLayoutEffect(() => { onChange({ dragging, blocked, grip }); }, [dragging, blocked, grip, onChange]);
    useLayoutEffect(() => () => onChange(null), [onChange]);
    return null;
});

/** 列首「−」：開移除確認（自選頁的操作面板 'remove' 模式） */
export function WatchEditLeading({ code, label, onRemove }: { code: string; label: string; onRemove: (code: string) => void }) {
    return (
        <span className={styles.rowLeading}>
            <IconButton ariaLabel={`從自選移除 ${label}`} icon={CircleMinus} onClick={() => onRemove(code)} testId='watch-row-remove' />
        </span>
    );
}

/** 列尾「⋯」（操作面板）＋拖曳握把（只有握把能拖；↑／↓ 一次移一格） */
export function WatchEditTrailing({ code, label, gripDisabled, grip, onActions }: {
    code: string;
    label: string;
    /** 握把停用（清單忙碌，或拖曳排序尚未就緒） */
    gripDisabled: boolean;
    grip: ListReorder['grip'];
    onActions: (code: string) => void;
}) {
    return (
        <span className={`${styles.rowTrailing} ${styles.trailingPair}`}>
            <IconButton ariaLabel={`${code} 更多操作`} icon={MoreHorizontal} onClick={() => onActions(code)} testId='watch-more' />
            <button
                type='button'
                className={`${styles.grip} ${focusRing}`}
                aria-label={`拖曳以調整 ${label} 的位置`}
                aria-keyshortcuts='ArrowUp ArrowDown'
                disabled={gripDisabled}
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
