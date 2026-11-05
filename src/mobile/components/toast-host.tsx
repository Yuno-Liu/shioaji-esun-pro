// src/mobile/components/toast-host.tsx — 通知（規格 §5.5）
//
// - onNotice()（src/lib/trade.ts）：lib 發出的通知。
// - onOrderEvent()（src/lib/stream.ts）＋ describeOrderReport()：成交／委託回報文字（與桌面 event-toasts 同一來源）。
// - 遮蔽金額／隱私模式：以 useRevealText() 在渲染時依目前開關重新遮蔽（通知產生後才打開也會遮）。
// - 成交時 Android 震動 10 ms（iOS 不支援，只作加分，不是唯一回饋）。點一下關閉。

import { useEffect, useRef, useState } from 'react';
import { describeOrderReport } from '../../lib/order-report';
import { useRevealText } from '../../lib/privacy-text';
import { onOrderEvent } from '../../lib/stream';
import { onNotice } from '../../lib/trade';
import * as styles from '../styles/toast.css';

type ToastKind = 'deal' | 'ok' | 'err' | 'info';

interface ToastItem {
    id: number;
    kind: ToastKind;
    title: string;
    lines: { text: string; dir?: 'up' | 'down' }[];
}

/** 同時最多顯示幾則（新的在下方） */
export const MAX_TOASTS = 3;
const TTL_MS: Record<ToastKind, number> = { deal: 6000, ok: 5000, info: 5000, err: 9000 };

function vibrate(ms: number) {
    try {
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
    } catch {
        // 部分瀏覽器在沒有使用者手勢時丟出例外：忽略
    }
}

export function ToastHost() {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const nextId = useRef(1);
    const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
    const reveal = useRevealText();

    useEffect(() => {
        const timerSet = timers.current;
        const push = (kind: ToastKind, title: string, lines: ToastItem['lines']) => {
            const id = nextId.current++;
            setToasts(prev => [...prev.slice(-(MAX_TOASTS - 1)), { id, kind, title, lines }]);
            const timer = setTimeout(() => {
                timerSet.delete(timer);
                setToasts(prev => prev.filter(t => t.id !== id));
            }, TTL_MS[kind]);
            timerSet.add(timer);
        };
        const offOrder = onOrderEvent((ev) => {
            const d = describeOrderReport(ev);
            push(d.kind, d.title, d.lines);
            if (d.kind === 'deal') vibrate(10);
        });
        const offNotice = onNotice((n) => {
            const kind: ToastKind = n.kind === 'err' ? 'err' : n.kind === 'ok' ? 'ok' : 'info';
            push(kind, n.title, n.body ? [{ text: n.body }] : []);
        });
        return () => {
            offOrder();
            offNotice();
            timerSet.forEach(clearTimeout);
            timerSet.clear();
        };
    }, []);

    return (
        <div className={styles.stack} aria-live='polite' aria-atomic='false' data-testid='toast-host'>
            {toasts.map(t => (
                <button
                    key={t.id}
                    type='button'
                    className={styles.toast[t.kind]}
                    role={t.kind === 'err' ? 'alert' : 'status'}
                    onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
                >
                    <span className={styles.title}>{reveal(t.title)}</span>
                    {t.lines.map((l, i) => (
                        <span key={i} className={l.dir ? styles.line[l.dir] : styles.line.plain}>{reveal(l.text)}</span>
                    ))}
                </button>
            ))}
        </div>
    );
}
