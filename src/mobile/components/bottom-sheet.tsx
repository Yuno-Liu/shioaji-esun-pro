// src/mobile/components/bottom-sheet.tsx — 共用底部面板（下單、確認、委託操作、帳戶切換、連線詳情）
//
// - 關閉方式：點背景、在把手／標題區往下滑超過 DISMISS_DRAG_PX、Esc、標題列的「關閉」。
// - dismissible=false 時以上方式全部停用（例如送出中，避免結果未知時面板消失）。
// - 底部加 env(safe-area-inset-bottom)；遵守 prefers-reduced-motion（見 styles/sheet.css.ts）。
// - tone（選填）：'buy'／'sell' 時整個面板以買賣方向色（vars.color.up／down）淡色疊底，並加方向色頂框；
//   缺省或 null＝中性（既有行為不變）。

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import * as styles from '../styles/sheet.css';

/** 往下拖曳超過這個距離（px）放開即關閉 */
export const DISMISS_DRAG_PX = 80;

export interface BottomSheetProps {
    open: boolean;
    /** 使用者要求關閉（背景、下滑、Esc、關閉鈕）；父層決定是否真的關閉 */
    onClose: () => void;
    title?: ReactNode;
    children: ReactNode;
    /** false：不能以背景、下滑、Esc、關閉鈕關閉；預設 true */
    dismissible?: boolean;
    /** 疊層：一般面板（預設）或確認面板（在一般面板之上） */
    layer?: 'sheet' | 'confirm';
    /** 沒有 title 時的無障礙名稱 */
    ariaLabel?: string;
    testId?: string;
    /** 買賣方向著色：buy＝vars.color.up、sell＝vars.color.down 的淡色底；null／缺省＝中性 */
    tone?: 'buy' | 'sell' | null;
}

export function BottomSheet({ open, onClose, title, children, dismissible = true, layer = 'sheet', ariaLabel, testId, tone = null }: BottomSheetProps) {
    const titleId = useId();
    const panelRef = useRef<HTMLDivElement | null>(null);
    const drag = useRef<{ pointerId: number; startY: number } | null>(null);
    const [offset, setOffset] = useState(0);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    // Esc 關閉；開啟時把焦點移到面板（螢幕閱讀器從面板開始讀）
    useEffect(() => {
        if (!open) return;
        panelRef.current?.focus?.();
        if (!dismissible || typeof document === 'undefined') return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, dismissible]);

    useEffect(() => { if (!open) setOffset(0); }, [open]);

    if (!open) return null;

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!dismissible) return;
        // 按在按鈕上不開始拖曳：pointer capture 會把 click 轉給拖曳區，按鈕就按不到了
        const target = e.target as { closest?: (selector: string) => unknown } | null;
        if (target?.closest?.('button, a, input, select, textarea')) return;
        drag.current = { pointerId: e.pointerId, startY: e.clientY };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        setOffset(Math.max(0, e.clientY - d.startY));
    };
    const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        drag.current = null;
        const dy = Math.max(0, e.clientY - d.startY);
        setOffset(0);
        if (dy >= DISMISS_DRAG_PX) onCloseRef.current();
    };
    const cancelDrag = () => { drag.current = null; setOffset(0); };

    const onBackdropKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        // Esc 由 document 監聽處理；這裡只阻止事件冒泡到頁面
        if (e.key === 'Escape') e.stopPropagation();
    };

    return (
        <div
            className={layer === 'confirm' ? `${styles.backdrop} ${styles.backdropConfirm}` : styles.backdrop}
            data-testid={testId ? `${testId}-backdrop` : undefined}
            onClick={(e) => { if (dismissible && e.target === e.currentTarget) onCloseRef.current(); }}
            onKeyDown={onBackdropKey}
        >
            <div
                ref={panelRef}
                className={tone ? `${styles.panel} ${styles.panelTone[tone]}` : styles.panel}
                data-tone={tone ?? undefined}
                role='dialog'
                aria-modal='true'
                aria-labelledby={title ? titleId : undefined}
                aria-label={title ? undefined : ariaLabel}
                tabIndex={-1}
                data-testid={testId}
                style={offset > 0 ? { transform: `translateY(${offset}px)` } : undefined}
            >
                <div
                    className={styles.grabArea}
                    data-testid={testId ? `${testId}-grab` : undefined}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={cancelDrag}
                >
                    <div className={styles.handle} aria-hidden='true' />
                    {(title || dismissible) && (
                        <div className={styles.header}>
                            {title ? <h2 id={titleId} className={styles.title}>{title}</h2> : <span className={styles.title} />}
                            {dismissible && (
                                <button type='button' className={styles.closeButton} onClick={() => onCloseRef.current()} aria-label='關閉'>
                                    ✕
                                </button>
                            )}
                        </div>
                    )}
                </div>
                <div className={styles.body}>{children}</div>
            </div>
        </div>
    );
}
