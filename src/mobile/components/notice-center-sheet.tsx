// src/mobile/components/notice-center-sheet.tsx — 通知中心面板（唯讀；狀態列的鈴開啟，延遲載入：lib/deferred-modules.ts）
//
// - 來源：src/lib/trade.ts 的記憶體通知紀錄（getNoticeLog／subscribeNoticeLog；上限 200 則，重新整理後清空）。
// - 新的在上；每則：時間（今天 HH:mm:ss，其他日期加月／日，跨年加年）、種類（圖示＋文字，不只靠顏色）、標題、內文。
//   種類沿用 toast 的 noticeToastKind()：錯誤且標題含「結果未知」顯示為琥珀色「待核對」。
// - 隱私：與 ToastHost 完全相同的遮蔽——渲染時以 useRevealTextCompat() 處理標題與內文（隱私模式、遮金額、已知帳號；
//   之後才打開開關也會遮）。通知內容不寫入任何儲存。
// - ［全部清除］兩段式確認（同自選「刪除清單」）：第一次按變成「確定清除 N 則通知」，再按才 clearNoticeLog()；
//   關閉面板或紀錄有變動時回到第一段。清除無法復原，而紀錄可能含待核對的「結果未知」，所以不用一按即清。
// - 交易安全 S1：面板內沒有任何下單、改單、刪單入口（只有清除與關閉）。
// - 樣式：種類圖示沿用 toast 的顏色（styles/toast.css，首屏已載入）；其餘是本檔的 inline style，不另開 .css.ts——
//   新的樣式檔會多一個 CSS chunk，mobile.js 的預載對照表多一個檔名（首屏預算只剩數百 bytes）。

import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { clearNoticeLog, getNoticeLog, subscribeNoticeLog, type LoggedNotice } from '../../lib/trade';
import { useRevealTextCompat } from '../lib/reveal-compat';
import { vars } from '../../theme.css';
import * as controls from '../styles/controls.css';
import * as toastStyles from '../styles/toast.css';
import { EmptyState } from '../ui/empty-state';
import { BottomSheet } from './bottom-sheet';
import { noticeToastKind } from './toast-host';

/** 前景憑證到期提醒與面板同一個延遲載入入口（lib/deferred-modules.ts loadNoticeCenterSheet；app.tsx 閒置時執行） */
export { runCaExpiryCheck } from '../lib/ca-expiry-check';

type Kind = 'ok' | 'err' | 'warn' | 'info';

export const NOTICE_KIND_TEXT: Readonly<Record<Kind, string>> = { ok: '成功', err: '錯誤', warn: '待核對', info: '訊息' };
const KIND_ICON = { ok: CircleCheck, err: TriangleAlert, warn: TriangleAlert, info: Info } as const;

export const NOTICE_EMPTY_TEXT = '沒有通知';

const muted = vars.color.mutedForeground;
const S = {
    list: { listStyle: 'none', margin: 0, padding: 0, minWidth: 0 },
    item: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: '0.75rem', padding: '0.75rem 0', minWidth: 0 },
    /** 列間分隔線（第二則起） */
    sep: { borderTop: `1px solid ${vars.color.border}` },
    main: { gridColumn: '2', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
    meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: '0.5rem', fontSize: '0.75rem', lineHeight: 1.35, color: muted },
    /** 種類文字：foreground 粗體（顏色只在圖示上） */
    kind: { fontWeight: 600, color: vars.color.foreground },
    time: { fontVariantNumeric: 'tabular-nums' },
    title: { margin: 0, fontSize: '0.9375rem', fontWeight: 600, lineHeight: 1.3, overflowWrap: 'anywhere' },
    body: { margin: 0, fontSize: '0.8125rem', lineHeight: 1.4, color: muted, overflowWrap: 'anywhere', whiteSpace: 'pre-line' },
    note: { margin: '0.5rem 0 0', fontSize: '0.75rem', lineHeight: 1.5, color: muted },
    footer: { display: 'flex', flexDirection: 'column', gap: '0.375rem' },
} satisfies Record<string, CSSProperties>;

const pad = (n: number) => String(n).padStart(2, '0');

/** 通知時間（裝置時區）：今天 HH:mm:ss；其他日期 MM/DD HH:mm:ss；不同年 YYYY/MM/DD HH:mm:ss */
export function noticeTimeText(ts: number, now: number): string {
    const d = new Date(ts);
    const n = new Date(now);
    const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return hms;
    const md = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    return d.getFullYear() === n.getFullYear() ? `${md} ${hms}` : `${d.getFullYear()}/${md} ${hms}`;
}

function NoticeItem({ notice, now, reveal, first }: { notice: LoggedNotice; now: number; reveal: (s: string) => string; first: boolean }) {
    // noticeToastKind 對 lib 通知只會回 ok／err／warn／info（deal 只給成交回報）
    const kind = noticeToastKind(notice) as Kind;
    const Icon = KIND_ICON[kind];
    return (
        <li style={first ? S.item : { ...S.item, ...S.sep }} data-testid='notice-item' data-kind={kind}>
            <Icon className={toastStyles.icon[kind]} aria-hidden='true' focusable='false' />
            <div style={S.main}>
                <div style={S.meta}>
                    <span style={S.kind}>{NOTICE_KIND_TEXT[kind]}</span>
                    <time style={S.time} dateTime={new Date(notice.ts).toISOString()}>{noticeTimeText(notice.ts, now)}</time>
                </div>
                <p style={S.title} data-testid='notice-title'>{reveal(notice.title)}</p>
                {notice.body && <p style={S.body} data-testid='notice-body'>{reveal(notice.body)}</p>}
            </div>
        </li>
    );
}

export function NoticeCenterSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
    const log = useSyncExternalStore(subscribeNoticeLog, getNoticeLog);
    const reveal = useRevealTextCompat();
    const [confirming, setConfirming] = useState(false);
    // 關閉面板或紀錄變動（新通知、被清除）：回到第一段
    useEffect(() => setConfirming(false), [open, log]);

    const now = Date.now();
    const count = log.length;
    const clear = () => {
        if (!confirming) {
            setConfirming(true);
            return;
        }
        clearNoticeLog();
        setConfirming(false);
    };

    const footer = count > 0
        ? (
            <div style={S.footer}>
                <button
                    type='button'
                    className={confirming ? controls.button.danger : controls.button.neutral}
                    style={{ width: '100%' }}
                    onClick={clear}
                    data-testid='notice-clear'
                    data-confirming={confirming ? 'true' : 'false'}
                >
                    {confirming ? `確定清除 ${count} 則通知` : '全部清除'}
                </button>
                {confirming && <p style={S.note} role='status' data-testid='notice-clear-hint'>再按一次清除；清除後無法復原。</p>}
            </div>
        )
        : undefined;

    return (
        <BottomSheet open={open} onClose={onClose} title='通知' testId='notice-center-sheet' detent={count > 0 ? 'large' : 'fit'} footer={footer}>
            {count === 0
                ? <EmptyState title={NOTICE_EMPTY_TEXT} description='下單結果、連線與系統訊息會記錄在這裡。' testId='notice-empty' />
                : (
                    <ul style={S.list} aria-label={`通知 ${count} 則，新的在上`} data-testid='notice-list'>
                        {log.map((n, i) => <NoticeItem key={`${n.ts}-${i}`} notice={n} now={now} reveal={reveal} first={i === count - 1} />).reverse()}
                    </ul>
                )}
            <p style={S.note}>只保留這次開啟以來最近 200 則，重新整理頁面後清空；不會存到裝置。</p>
        </BottomSheet>
    );
}
