// src/mobile/components/toast-host.tsx — 通知（規格 §5.5）
//
// - onNotice()（src/lib/trade.ts）：lib 發出的通知。
// - onOrderEvent()（src/lib/stream.ts）＋ describeOrderReport()：成交／委託回報文字（與桌面 event-toasts 同一來源）。
// - 遮蔽金額／隱私模式：以 useRevealText() 在渲染時依目前開關重新遮蔽（通知產生後才打開也會遮）。
// - 成交震動不在這裡：由 hooks/use-fill-sound.ts 依帳戶頁「震動」開關呼叫 vibrateOnFill()（Android；iOS 不支援）。點一下關閉。
// - 「結果未知」（kind 'err' 且標題含「結果未知」，例如下單面板的 OUTCOME_UNKNOWN_TITLE、mutationErrorNotice 的
//   「刪單失敗或結果未知」）改用琥珀色（規格 §7.2），與確定未送出的紅色錯誤區分。

import { useEffect, useRef, useState } from 'react';
import { describeOrderReport } from '../../lib/order-report';
import { useRevealText } from '../../lib/privacy-text';
import { onOrderEvent } from '../../lib/stream';
import { onNotice, type AppNotice } from '../../lib/trade';
import * as styles from '../styles/toast.css';

type ToastKind = 'deal' | 'ok' | 'err' | 'warn' | 'info';

interface ToastItem {
    id: number;
    kind: ToastKind;
    title: string;
    lines: { text: string; dir?: 'up' | 'down' }[];
}

/** 同時最多顯示幾則（新的在下方） */
export const MAX_TOASTS = 3;
const TTL_MS: Record<ToastKind, number> = { deal: 6000, ok: 5000, info: 5000, err: 9000, warn: 9000 };

/** 結果未知的標題關鍵字（§7.2：琥珀色「結果未知：請到委託頁按『更新』核對，勿重送」） */
export const OUTCOME_UNKNOWN_KEYWORD = '結果未知';

/** lib 通知對應的 toast 樣式：錯誤且標題含「結果未知」→ 琥珀色 warn，其餘照原 kind */
export function noticeToastKind(n: Pick<AppNotice, 'kind' | 'title'>): ToastKind {
    if (n.kind === 'err') return n.title.includes(OUTCOME_UNKNOWN_KEYWORD) ? 'warn' : 'err';
    return n.kind === 'ok' ? 'ok' : 'info';
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
        });
        const offNotice = onNotice((n) => {
            push(noticeToastKind(n), n.title, n.body ? [{ text: n.body }] : []);
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
                    role={t.kind === 'err' || t.kind === 'warn' ? 'alert' : 'status'}
                    onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
                >
                    <span className={t.kind === 'warn' ? styles.titleWarn : styles.title}>{reveal(t.title)}</span>
                    {t.lines.map((l, i) => (
                        <span key={i} className={l.dir ? styles.line[l.dir] : styles.line.plain}>{reveal(l.text)}</span>
                    ))}
                </button>
            ))}
        </div>
    );
}
