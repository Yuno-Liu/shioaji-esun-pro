// src/mobile/components/toast-host.tsx — 通知 v2（規格 §5.5；設計規格 docs/fork/mobile-design.md §6.4、§8、§10 S8）
//
// - onNotice()（src/lib/trade.ts）：lib 發出的通知。
// - onOrderEvent()（src/lib/stream.ts）＋ describeOrderReport()：成交／委託回報文字（與桌面 event-toasts 同一來源）。
// - 遮蔽金額／隱私模式：以 useRevealTextCompat()（mobile/lib/reveal-compat.ts，與 useRevealText 輸出一致但不用
//   lookbehind，iOS 15.4 可用）在渲染時依目前開關重新遮蔽（通知產生後才打開也會遮）。
// - 每則通知各包一層錯誤邊界：單則渲染失敗只略過（並移除）該則，不會卸載整個 App。
// - 成交震動不在這裡：由 hooks/use-fill-sound.ts 依帳戶頁「震動」開關呼叫 vibrateOnFill()（Android；iOS 不支援）。
// - 「結果未知」（kind 'err' 且標題含「結果未知」，例如下單面板的 OUTCOME_UNKNOWN_TITLE、mutationErrorNotice 的
//   「刪單失敗或結果未知」）改用琥珀色（規格 §7.2），與確定未送出的紅色錯誤區分。通知只報告事件，不提供重送鍵。
//
// v2：
// - 雙錨點：沒有面板＝分頁列／配件列上方（底部模式）；有面板（useSheetStack().depth > 0）＝狀態列區域內的
//   單行膠囊（頂部精簡模式），只顯示前景一則，其餘以「+N」計數；切換錨點時整組 150ms 淡出淡入，不跨螢幕滑動。
// - 疊放：DOM 依時間（舊→新）；前景＝最新的 warn（結果未知），其次最新的 err，都沒有則最新一則（§10 S8、§0.2 第 4 項）。超過 MAX_TOASTS 時先淘汰最舊的
//   deal／ok／info，其次最舊的 err，warn（結果未知）最後才淘汰（§10 S8）。
// - 按住任一通知時暫停全部 TTL，放開以剩餘時間續算。
// - 拖曳離場：往錨點邊緣 1:1、反向橡皮筋；放手 projected = offset + project(v, .998)，超過 40px 或速度 ≥500px/s
//   （往錨點邊緣）離場，否則以放手速度彈回。拖曳後 350ms 內攔下 click。減少動態：只淡入淡出、放手直接定位。
// - 動畫由 motion/spring.ts 直接寫 element.style（transform／opacity）；測試環境（ref 為 null）走同步模式立即完成。

import { CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { describeOrderReport } from '../../lib/order-report';
import { onOrderEvent } from '../../lib/stream';
import { onNotice, type AppNotice } from '../../lib/trade';
import { useRevealTextCompat } from '../lib/reveal-compat';
import { useSheetStack } from '../lib/sheet-stack';
import { suppressClicksAfterDrag, usePointerDrag, type PointerLike } from '../motion/gesture';
import { useReducedMotion } from '../motion/prefs';
import { animateSpring, animateTween, canAnimate, project, rubberband, SPRINGS, writeStyle, type SpringHandle } from '../motion/spring';
import * as styles from '../styles/toast.css';
import { DUR, GESTURE } from '../styles/tokens';

export type ToastKind = 'deal' | 'ok' | 'err' | 'warn' | 'info';
/** bottom＝分頁列上方；top＝有面板時狀態列區域內的精簡膠囊 */
export type ToastAnchor = 'bottom' | 'top';

interface ToastItem {
    id: number;
    kind: ToastKind;
    title: string;
    lines: { text: string; dir?: 'up' | 'down' }[];
    /** 退場中（動畫結束才移除）：不計入前景、疊放與上限 */
    leaving: boolean;
}

/** 同時最多顯示幾則（不含退場中） */
export const MAX_TOASTS = 3;
export const TTL_MS: Readonly<Record<ToastKind, number>> = { deal: 6000, ok: 5000, info: 5000, err: 9000, warn: 9000 };
/** 展開（底部疊放展開、頂部膠囊展開內文）無互動多久後收合 */
export const TOAST_EXPAND_MS = 5000;
/** 放手離場的投射距離門檻（px） */
export const TOAST_DISMISS_PX = 40;

/** 結果未知的標題關鍵字（§7.2：琥珀色「結果未知：請到委託頁按『更新』核對，勿重送」） */
export const OUTCOME_UNKNOWN_KEYWORD = '結果未知';

/** lib 通知對應的 toast 樣式：錯誤且標題含「結果未知」→ 琥珀色 warn，其餘照原 kind */
export function noticeToastKind(n: Pick<AppNotice, 'kind' | 'title'>): ToastKind {
    if (n.kind === 'err') return n.title.includes(OUTCOME_UNKNOWN_KEYWORD) ? 'warn' : 'err';
    return n.kind === 'ok' ? 'ok' : 'info';
}

const isAlert = (k: ToastKind) => k === 'err' || k === 'warn';
/** 淘汰保護等級：數字越大越晚淘汰（warn＝結果未知最後） */
const keepRank = (k: ToastKind) => (k === 'warn' ? 2 : k === 'err' ? 1 : 0);

/**
 * 超過上限時要淘汰的 id（list 依時間舊→新）：每次淘汰保護等級最低者中最舊的一則——
 * 先 deal／ok／info，全是 alert 才淘汰 err，warn 最後。
 */
export function pickToastEvictions(list: readonly Pick<ToastItem, 'id' | 'kind'>[], max: number = MAX_TOASTS): number[] {
    const rest = [...list];
    const victims: number[] = [];
    while (rest.length > Math.max(0, max)) {
        const min = Math.min(...rest.map(t => keepRank(t.kind)));
        const idx = rest.findIndex(t => keepRank(t.kind) === min);
        victims.push(rest[idx]!.id);
        rest.splice(idx, 1);
    }
    return victims;
}

/**
 * 前景（list 依時間舊→新）：最新的 warn（結果未知），其次最新的 err，都沒有則最新一則。
 * 結果未知不可被較晚到的 err 壓到後面（§10 S8、§0.2 第 4 項）；頂部精簡模式只顯示這一則。
 */
export function frontToastId(list: readonly Pick<ToastItem, 'id' | 'kind'>[]): number | null {
    for (const kind of ['warn', 'err'] as const) {
        for (let i = list.length - 1; i >= 0; i--) if (list[i]!.kind === kind) return list[i]!.id;
    }
    return list.length > 0 ? list[list.length - 1]!.id : null;
}

/** 疊放深度：前景 0，其餘由新到舊 1、2… */
export function toastDepths(list: readonly Pick<ToastItem, 'id' | 'kind'>[]): Map<number, number> {
    const front = frontToastId(list);
    const depths = new Map<number, number>();
    if (front === null) return depths;
    depths.set(front, 0);
    let d = 1;
    for (let i = list.length - 1; i >= 0; i--) {
        const id = list[i]!.id;
        if (id !== front) depths.set(id, d++);
    }
    return depths;
}

/**
 * 放手判定（§8）：offset、velocity 為螢幕座標（往下為正）；底部模式往下＝離場方向，頂部模式鏡像。
 * projected = offset + project(v, .998)；projected > 40 或 v ≥ 500（往錨點邊緣）離場。
 */
export function toastRelease(i: { offset: number; velocity: number; anchor: ToastAnchor }): 'dismiss' | 'stay' {
    const sign = i.anchor === 'top' ? -1 : 1;
    const offset = Number.isFinite(i.offset) ? i.offset * sign : 0;
    const v = Number.isFinite(i.velocity) ? i.velocity * sign : 0;
    const projected = offset + project(v, GESTURE.toastDeceleration);
    return projected > TOAST_DISMISS_PX || v >= GESTURE.flingVelocity ? 'dismiss' : 'stay';
}

// ---- 卡片 ----

type Rect = { height: number; top: number; bottom: number };

function rectOf(el: unknown): Rect | null {
    try {
        const r = (el as { getBoundingClientRect?: () => Rect } | null)?.getBoundingClientRect?.();
        return r && Number.isFinite(r.height) && Number.isFinite(r.top) && Number.isFinite(r.bottom) ? r : null;
    } catch {
        return null;
    }
}

/** 從目前位置移到錨點邊緣外所需的位移（底部往下、頂部往上） */
function offscreenOffset(el: unknown, anchor: ToastAnchor, current: number): number {
    const r = rectOf(el);
    const vh = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
    if (anchor === 'top') return current - (r ? Math.max(0, r.bottom) + 8 : 120);
    return current + (r && vh > 0 ? Math.max(0, vh - r.top) + 8 : (r?.height ?? 80) + 80);
}

interface HostApi {
    dismiss(id: number): void;
    exited(id: number): void;
    activate(id: number): void;
    hold(): void;
    release(): void;
}

interface CardProps {
    item: ToastItem;
    anchor: ToastAnchor;
    front: boolean;
    /** 退場中為 undefined（沿用最後一次的深度） */
    depth: number | undefined;
    reduced: boolean;
    reveal: (s: string) => string;
    api: HostApi;
}

function ToastCard({ item, anchor, front, depth, reduced, reveal, api }: CardProps) {
    const ref = useRef<HTMLDivElement>(null);
    const offset = useRef(0);
    const dragBase = useRef(0);
    const anim = useRef<SpringHandle | null>(null);
    const exitVelocity = useRef(0);
    const holding = useRef(false);
    const lastDragEnd = useRef(Number.NEGATIVE_INFINITY);
    const lastDepth = useRef(depth ?? 0);
    if (depth !== undefined) lastDepth.current = depth;
    const anchorRef = useRef(anchor);
    anchorRef.current = anchor;
    const reducedRef = useRef(reduced);
    reducedRef.current = reduced;
    const leavingRef = useRef(item.leaving);
    leavingRef.current = item.leaving;

    const write = useCallback((y: number) => {
        offset.current = y;
        writeStyle(ref.current, { transform: Math.abs(y) < 0.01 ? 'none' : `translateY(${y}px)` });
    }, []);
    const writeOpacity = useCallback((v: number | null) => {
        writeStyle(ref.current, { opacity: v === null ? null : String(v) });
    }, []);

    // 進場：從錨點邊緣外以 spring.toast 到 0；減少動態只淡入
    useLayoutEffect(() => {
        const el = ref.current;
        if (canAnimate(el)) {
            if (reducedRef.current) {
                writeOpacity(0);
                anim.current = animateTween({ from: 0, to: 1, durationMs: DUR.fade, el, onUpdate: writeOpacity, onRest: () => writeOpacity(null) });
            } else {
                const from = offscreenOffset(el, anchorRef.current, 0);
                write(from);
                anim.current = animateSpring({ from, to: 0, config: SPRINGS.toast, el, onUpdate: write });
            }
        }
        return () => {
            anim.current?.stop();
            anim.current = null;
        };
    }, [write, writeOpacity]);

    // 退場：以放手速度（沒有則 0）滑出錨點邊緣；減少動態只淡出；同步模式立即移除
    useEffect(() => {
        if (!item.leaving) return;
        anim.current?.stop();
        const el = ref.current;
        const done = () => api.exited(item.id);
        if (reducedRef.current) {
            anim.current = animateTween({ from: 1, to: 0, durationMs: DUR.fade, el, onUpdate: writeOpacity, onRest: done });
        } else {
            anim.current = animateSpring({
                from: offset.current,
                to: offscreenOffset(el, anchorRef.current, offset.current),
                velocity: exitVelocity.current,
                config: SPRINGS.toast,
                restDelta: 2,
                el,
                onUpdate: write,
                onRest: done,
            });
        }
    }, [item.leaving, item.id, api, write, writeOpacity]);

    const settle = (velocity: number) => {
        anim.current?.stop();
        // 減少動態時 animateSpring 走同步模式（放手直接定位）
        anim.current = animateSpring({ from: offset.current, to: 0, velocity, config: SPRINGS.toast, el: ref.current, onUpdate: write });
    };

    const drag = usePointerDrag({
        axis: 'y',
        canStart: () => !leavingRef.current,
        onStart: () => {
            anim.current?.stop();
            anim.current = null;
            if (reducedRef.current) writeOpacity(null);
            dragBase.current = offset.current;
        },
        onMove: i => {
            const raw = dragBase.current + i.delta;
            const towardEdge = anchorRef.current === 'top' ? raw <= 0 : raw >= 0;
            write(towardEdge ? raw : rubberband(raw, rectOf(ref.current)?.height || 80, GESTURE.rubberband));
        },
        onEnd: i => {
            lastDragEnd.current = Date.now();
            if (i.element && typeof i.element === 'object') suppressClicksAfterDrag(i.element as Element);
            if (!i.cancelled && toastRelease({ offset: offset.current, velocity: i.velocity, anchor: anchorRef.current }) === 'dismiss') {
                exitVelocity.current = i.velocity;
                api.dismiss(item.id);
                return;
            }
            settle(i.velocity);
        },
    });

    const releaseHold = useCallback(() => {
        if (!holding.current) return;
        holding.current = false;
        api.release();
    }, [api]);
    useEffect(() => releaseHold, [releaseHold]);

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement> | PointerLike) => {
        drag.onPointerDown(e);
        if (!holding.current) {
            holding.current = true;
            api.hold();
        }
    };
    const ending = (fn: (e: PointerLike) => void) => (e: ReactPointerEvent<HTMLDivElement> | PointerLike) => {
        fn(e);
        releaseHold();
    };

    const onClick = () => {
        if (item.leaving) return;
        if (Date.now() - lastDragEnd.current < GESTURE.clickSuppressMs) return;
        api.activate(item.id);
    };

    const Icon = item.kind === 'ok' || item.kind === 'deal' ? CircleCheck : item.kind === 'info' ? Info : TriangleAlert;
    return (
        <div
            ref={ref}
            className={styles.toast[item.kind]}
            role={isAlert(item.kind) ? 'alert' : 'status'}
            data-testid='toast-item'
            data-front={front ? 'true' : 'false'}
            data-depth={String(lastDepth.current)}
            data-leaving={item.leaving ? 'true' : undefined}
            aria-hidden={item.leaving ? true : undefined}
            onClick={onClick}
            onPointerDown={onPointerDown}
            onPointerMove={drag.onPointerMove}
            onPointerUp={ending(drag.onPointerUp)}
            onPointerCancel={ending(drag.onPointerCancel)}
            onLostPointerCapture={ending(drag.onLostPointerCapture)}
            onPointerLeave={releaseHold}
        >
            <Icon className={styles.icon[item.kind]} aria-hidden='true' focusable='false' />
            <span className={item.kind === 'warn' ? styles.titleWarn : styles.title}>{reveal(item.title)}</span>
            {item.lines.map((l, i) => (
                <span key={i} className={l.dir ? styles.line[l.dir] : styles.line.plain}>{reveal(l.text)}</span>
            ))}
            <button
                type='button'
                className={styles.close}
                aria-label='關閉通知'
                onClick={e => {
                    e.stopPropagation();
                    api.dismiss(item.id);
                }}
            >
                <X size={16} aria-hidden='true' focusable='false' />
            </button>
        </div>
    );
}

// ---- 單則錯誤邊界 ----

/**
 * 單則通知渲染失敗（例如遮蔽文字時丟例外）只略過該則：渲染 null 並從清單移除（清掉 TTL），
 * 不往上拋，其餘通知與整個 App 照常運作。以 key＝通知 id 掛載，每則各自一個邊界。
 */
class ToastBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(): void {
        this.props.onError();
    }

    render(): ReactNode {
        return this.state.failed ? null : this.props.children;
    }
}

// ---- 容器 ----

interface TtlEntry {
    timer: ReturnType<typeof setTimeout> | null;
    remaining: number;
    startedAt: number;
}

export function ToastHost() {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const listRef = useRef<ToastItem[]>([]);
    const nextId = useRef(1);
    const ttl = useRef(new Map<number, TtlEntry>());
    const holds = useRef(0);
    const [expanded, setExpanded] = useState(false);
    const expandedRef = useRef(false);
    expandedRef.current = expanded;
    const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reveal = useRevealTextCompat();
    const reduced = useReducedMotion();
    const wantAnchor: ToastAnchor = useSheetStack().depth > 0 ? 'top' : 'bottom';
    const [anchor, setAnchor] = useState<ToastAnchor>(wantAnchor);
    const anchorRef = useRef(anchor);
    anchorRef.current = anchor;
    const stackRef = useRef<HTMLDivElement>(null);
    const fade = useRef<SpringHandle | null>(null);

    const api = useMemo(() => {
        const commit = (fn: (l: ToastItem[]) => ToastItem[]) => {
            listRef.current = fn(listRef.current);
            setToasts(listRef.current);
        };
        const clearTtl = (id: number) => {
            const e = ttl.current.get(id);
            if (e?.timer) clearTimeout(e.timer);
            ttl.current.delete(id);
        };
        const dismiss = (id: number) => {
            clearTtl(id);
            if (!listRef.current.some(t => t.id === id && !t.leaving)) return;
            commit(l => l.map(t => (t.id === id ? { ...t, leaving: true } : t)));
        };
        const startTtl = (id: number) => {
            const e = ttl.current.get(id);
            if (!e || e.timer || holds.current > 0) return;
            e.startedAt = Date.now();
            e.timer = setTimeout(() => {
                e.timer = null;
                dismiss(id);
            }, e.remaining);
        };
        const stopExpandTimer = () => {
            if (expandTimer.current) clearTimeout(expandTimer.current);
            expandTimer.current = null;
        };
        const touchExpand = () => {
            stopExpandTimer();
            expandTimer.current = setTimeout(() => {
                expandTimer.current = null;
                setExpanded(false);
            }, TOAST_EXPAND_MS);
        };
        const host = {
            push(kind: ToastKind, title: string, lines: ToastItem['lines']) {
                const item: ToastItem = { id: nextId.current++, kind, title, lines, leaving: false };
                const active = listRef.current.filter(t => !t.leaving);
                const victims = new Set(pickToastEvictions([...active, item]));
                victims.forEach(clearTtl);
                const keepNew = !victims.has(item.id);
                commit(l => {
                    const next = l.map(t => (victims.has(t.id) ? { ...t, leaving: true } : t));
                    return keepNew ? [...next, item] : next;
                });
                if (keepNew) {
                    ttl.current.set(item.id, { timer: null, remaining: TTL_MS[kind], startedAt: 0 });
                    startTtl(item.id);
                }
            },
            dismiss,
            exited(id: number) {
                clearTtl(id);
                commit(l => l.filter(t => t.id !== id));
            },
            activate(id: number) {
                const count = listRef.current.filter(t => !t.leaving).length;
                if (anchorRef.current === 'top') {
                    // 頂部膠囊：點一下展開內文 5 秒（使用者主動），再點收合
                    if (expandedRef.current) { stopExpandTimer(); setExpanded(false); }
                    else { setExpanded(true); touchExpand(); }
                    return;
                }
                if (count <= 1) { dismiss(id); return; } // 單則：點一下關閉（沿用）
                if (!expandedRef.current) { setExpanded(true); touchExpand(); return; }
                dismiss(id);
                touchExpand();
            },
            hold() {
                holds.current += 1;
                if (expandTimer.current) touchExpand();
                if (holds.current !== 1) return;
                const now = Date.now();
                ttl.current.forEach(e => {
                    if (!e.timer) return;
                    clearTimeout(e.timer);
                    e.timer = null;
                    e.remaining = Math.max(0, e.remaining - (now - e.startedAt));
                });
            },
            release() {
                if (holds.current <= 0) return;
                holds.current -= 1;
                if (holds.current === 0) ttl.current.forEach((_e, id) => startTtl(id));
            },
            stopExpandTimer,
            clearAll() {
                ttl.current.forEach(e => { if (e.timer) clearTimeout(e.timer); });
                ttl.current.clear();
                stopExpandTimer();
            },
        };
        return host;
    }, []);

    useEffect(() => {
        const offOrder = onOrderEvent((ev) => {
            const d = describeOrderReport(ev);
            api.push(d.kind, d.title, d.lines);
        });
        const offNotice = onNotice((n) => {
            api.push(noticeToastKind(n), n.title, n.body ? [{ text: n.body }] : []);
        });
        return () => {
            offOrder();
            offNotice();
            api.clearAll();
            fade.current?.stop();
        };
    }, [api]);

    const active = toasts.filter(t => !t.leaving);
    const frontId = frontToastId(active);
    const depths = toastDepths(active);

    // 底部疊放只剩一則時收合
    useEffect(() => {
        if (expanded && anchor === 'bottom' && active.length <= 1) {
            api.stopExpandTimer();
            setExpanded(false);
        }
    }, [expanded, anchor, active.length, api]);

    // 錨點切換：整組 150ms 淡出 → 換錨點 → 淡入（不跨螢幕滑動）；同步模式立即換
    useEffect(() => {
        const el = stackRef.current;
        if (anchor === wantAnchor) {
            // 淡出途中又切回：從目前值淡回
            if (fade.current && !fade.current.done) {
                const { value } = fade.current.stop();
                fade.current = animateTween({ from: value, to: 1, durationMs: DUR.fade, el, onUpdate: v => writeStyle(el, { opacity: String(v) }), onRest: () => writeStyle(el, { opacity: null }) });
            }
            return;
        }
        fade.current?.stop();
        fade.current = animateTween({
            from: 1,
            to: 0,
            durationMs: DUR.fade,
            el,
            onUpdate: v => writeStyle(el, { opacity: String(v) }),
            onRest: () => setAnchor(wantAnchor),
        });
    }, [anchor, wantAnchor]);

    const firstAnchor = useRef(true);
    useLayoutEffect(() => {
        if (firstAnchor.current) { firstAnchor.current = false; return; }
        api.stopExpandTimer();
        setExpanded(false);
        const el = stackRef.current;
        fade.current?.stop();
        if (!canAnimate(el)) { fade.current = null; return; }
        writeStyle(el, { opacity: '0' });
        fade.current = animateTween({ from: 0, to: 1, durationMs: DUR.fade, el, onUpdate: v => writeStyle(el, { opacity: String(v) }), onRest: () => writeStyle(el, { opacity: null }) });
    }, [anchor, api]);

    const hiddenCount = anchor === 'top' && frontId !== null ? active.length - 1 : 0;

    return (
        <div
            ref={stackRef}
            className={styles.stack}
            aria-live='polite'
            aria-atomic='false'
            data-testid='toast-host'
            data-anchor={anchor}
            data-expanded={expanded ? 'true' : 'false'}
        >
            {toasts.map(t => (
                <ToastBoundary key={t.id} onError={() => api.exited(t.id)}>
                    <ToastCard
                        item={t}
                        anchor={anchor}
                        front={t.id === frontId}
                        depth={t.leaving ? undefined : depths.get(t.id)}
                        reduced={reduced}
                        reveal={reveal}
                        api={api}
                    />
                </ToastBoundary>
            ))}
            {hiddenCount > 0 && (
                <span className={styles.more} aria-hidden='true' data-testid='toast-more'>+{hiddenCount}</span>
            )}
        </div>
    );
}
