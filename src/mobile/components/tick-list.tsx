// src/mobile/components/tick-list.tsx — 逐筆明細（規格 §6.2）
//
// 先以 fetchLastTicks(contract, 50) 取最近 50 筆，再接 onAnyTick()（只取目前商品）；
// 最多保留 200 筆。內外盤以 tick_type 著色並附文字（1 外盤、2 內盤），不只靠顏色。
// 欄寬以 minmax(0, …)＋省略號收縮，390px 寬不溢出（trade.css.ts tickGrid）。
// 列高 2rem、系統字 tabular（num 樣式，不用等寬字族）；最新一列 150ms 淡入。
//
// 效能（稽核 P1）：列抽成 memo 元件，每次 flush 只重繪新列與前一個最新列（淡入 class 改變），不重繪全部 200 列。
// 交易頁第一次切到明細才掛載，之後切走只隱藏（active=false）：不卸載、不重抓歷史；隱藏時新成交只累積在 ref，
// 不 setState、不重繪，切回來時一次寫入（同公司分頁的作法）。

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { retainQuote } from '../../lib/quote-ownership';
import { fetchLastTicks } from '../../lib/shioaji';
import { onAnyTick } from '../../lib/stream';
import type { ContractInfo } from '../../lib/types/contract';
import type { SseTick } from '../../lib/types/market';
import type { HistoryTicks } from '../../lib/types/tick';
import { fmtInt, formatToTick } from '../lib/num-format';
import { dateStrOffset } from '../../lib/utils/kbars';
import * as styles from '../styles/trade.css';
import { InlineNote } from '../ui/inline-note';
import { Skeleton } from '../ui/skeleton';

export const TICK_HISTORY_COUNT = 50;
export const TICK_LIST_MAX = 200;
/** 即時明細合併重繪的間隔（行情 store 的 QUOTE_FLUSH_MS 未匯出，這裡自行節流） */
export const TICK_LIST_FLUSH_MS = 100;

export interface TickRow {
    id: number;
    /** HH:MM:SS */
    time: string;
    price: number;
    volume: number;
    /** 1 外盤（買方成交）、2 內盤（賣方成交）、0 未知 */
    tickType: number;
}

let rowSeq = 0;

function hms(time: string): string {
    const m = /(\d{1,2}:\d{2}:\d{2})/.exec(time);
    return m ? m[1]! : time;
}

/** 歷史明細（欄位陣列，舊→新）→ 列（新→舊） */
export function historyRows(h: HistoryTicks): TickRow[] {
    const out: TickRow[] = [];
    for (let i = h.datetime.length - 1; i >= 0; i--) {
        const dt = h.datetime[i];
        if (!dt) continue;
        out.push({ id: rowSeq++, time: hms(dt.slice(11)), price: Number(h.close[i] ?? 0), volume: h.volume[i] ?? 0, tickType: h.tick_type[i] ?? 0 });
    }
    return out;
}

export function liveRow(t: SseTick): TickRow {
    return { id: rowSeq++, time: hms(t.time), price: Number(t.close), volume: t.volume, tickType: t.tick_type };
}

const rowKey = (r: TickRow) => `${r.time}|${r.price}|${r.volume}|${r.tickType}`;

/**
 * 歷史列去掉已在畫面上的部分（即時列可能比歷史先到；已有即時列時重試，最近 50 筆也會重疊）：
 * 以時間＋價＋量＋內外盤逐筆抵銷，同一秒的相同成交只抵銷重疊的筆數。
 */
export function historyWithoutOverlap(existing: readonly TickRow[], history: readonly TickRow[]): TickRow[] {
    if (existing.length === 0) return [...history];
    const seen = new Map<string, number>();
    for (const r of existing) {
        const k = rowKey(r);
        seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return history.filter(r => {
        const k = rowKey(r);
        const n = seen.get(k);
        if (!n) return true;
        seen.set(k, n - 1);
        return false;
    });
}

/** 新列放前面、總數不超過 max */
export function mergeTickRows(newestFirst: readonly TickRow[], existing: readonly TickRow[], max = TICK_LIST_MAX): TickRow[] {
    return [...newestFirst, ...existing].slice(0, max);
}

// 期貨夜盤的明細掛在下一個交易日：期權先查明天，沒有再查今天（與桌面 tick-tape 相同）
async function loadHistory(contract: ContractInfo): Promise<HistoryTicks> {
    if (contract.security_type === 'FUT' || contract.security_type === 'OPT') {
        try {
            const next = await fetchLastTicks(contract, TICK_HISTORY_COUNT, dateStrOffset(-1));
            if (next.datetime.length > 0) return next;
        } catch {
            // 退回今天
        }
    }
    return fetchLastTicks(contract, TICK_HISTORY_COUNT);
}

const SIDE_TEXT: Record<number, string> = { 1: '外', 2: '內' };

type LoadStatus = 'loading' | 'ready' | 'error';

/** 單列：合併時 r 沿用同一物件、contract 只在合約快取更新時換參照，所以 flush 時舊列不重繪 */
const TickRowItem = memo(function TickRowItem({ r, contract, isNew }: { r: TickRow; contract: ContractInfo; isNew: boolean }) {
    const tone = r.tickType === 1 ? 'up' : r.tickType === 2 ? 'down' : 'flat';
    return (
        // 最新一列淡入（新列以新 key 掛載才會播放；只動畫 opacity）
        <li className={isNew ? styles.tickRowNew : styles.tickRow}>
            <span className={styles.tickTime}>{r.time}</span>
            <span className={`${styles.tickNum} ${styles.tickPrice} ${styles.dirText[tone]}`}>{formatToTick(contract, r.price)}</span>
            <span className={styles.tickNum}>{fmtInt(r.volume)}</span>
            <span className={`${styles.tickSide} ${styles.dirText[tone]}`}>{SIDE_TEXT[r.tickType] ?? ''}</span>
        </li>
    );
});

export interface TickListProps {
    code: string;
    contract: ContractInfo;
    /** 目前是否顯示中：第一次為 true 才掛載，之後 false 只隱藏（預設 true） */
    active?: boolean;
}

/** 第一次 active 才掛載明細；之後切走只隱藏（不卸載、不重抓歷史） */
export const TickList = memo(function TickList({ code, contract, active = true }: TickListProps) {
    const [seen, setSeen] = useState(active);
    if (active && !seen) setSeen(true);
    if (!seen) return null;
    return <TickListBody code={code} contract={contract} active={active} />;
});

interface PendingBuffer {
    /** 尚未寫入畫面的即時列（舊→新） */
    live: TickRow[];
    /** 尚未寫入畫面的歷史列 */
    history: TickRow[] | null;
    /** 尚未寫入畫面的讀取結果 */
    status: LoadStatus | null;
    timer: ReturnType<typeof setTimeout> | null;
}

function TickListBody({ code, contract, active }: Required<TickListProps>) {
    const [rows, setRows] = useState<TickRow[]>([]);
    const [status, setStatus] = useState<LoadStatus>('loading');
    const [retry, setRetry] = useState(0);
    const buf = useRef<PendingBuffer>({ live: [], history: null, status: null, timer: null });
    const activeRef = useRef(active);
    activeRef.current = active;
    // 合約快取更新會換物件參照；只在商品真的改變時重新載入
    const contractRef = useRef(contract);
    contractRef.current = contract;

    // 把累積的即時列、歷史列與讀取狀態一次寫入（同一個 tick 內的兩個 setState 合併成一次重繪）
    const commit = useCallback(() => {
        const b = buf.current;
        if (b.timer !== null) {
            clearTimeout(b.timer);
            b.timer = null;
        }
        const newestFirst = b.live.slice(-TICK_LIST_MAX).reverse();
        const history = b.history;
        const next = b.status;
        b.live = [];
        b.history = null;
        b.status = null;
        if (newestFirst.length || history) {
            setRows(prev => {
                // 即時列可能已先到：保留在最上面，歷史列接在下面
                const base = history ? mergeTickRows(prev, historyWithoutOverlap(prev, history)) : prev;
                return newestFirst.length ? mergeTickRows(newestFirst, base) : base;
            });
        }
        if (next) setStatus(next);
    }, []);

    // 即時成交：只在商品改變時重新訂閱
    useEffect(() => {
        const ct = contractRef.current;
        const b = buf.current;
        b.live = [];
        b.history = null;
        b.status = null;
        setRows(prev => (prev.length ? [] : prev));
        const release = retainQuote(ct, 'Tick');
        const off = onAnyTick(tick => {
            // 連續月別名：stream 會以別名代碼再送一次，所以比對頁面代碼即可
            if (tick.code !== code) return;
            b.live.push(liveRow(tick));
            // 隱藏很久時只留最近的（超過兩倍上限才裁，不必每筆都複製陣列）
            if (b.live.length > TICK_LIST_MAX * 2) b.live.splice(0, b.live.length - TICK_LIST_MAX);
            // 隱藏中不排程重繪：切回來時由下面的 layout effect 一次寫入
            if (activeRef.current && b.timer === null) b.timer = setTimeout(commit, TICK_LIST_FLUSH_MS);
        });
        return () => {
            off();
            release();
            if (b.timer !== null) {
                clearTimeout(b.timer);
                b.timer = null;
            }
        };
    }, [code, contract.code, contract.security_type, commit]);

    // 歷史明細：商品改變或按重試時讀取；已有即時列時重試不清空畫面
    useEffect(() => {
        let cancelled = false;
        setStatus('loading');
        loadHistory(contractRef.current)
            .then(h => {
                if (cancelled) return;
                buf.current.history = historyRows(h);
                buf.current.status = 'ready';
                if (activeRef.current) commit();
            })
            .catch(() => {
                if (cancelled) return;
                buf.current.status = 'error';
                if (activeRef.current) commit();
            });
        return () => { cancelled = true; };
    }, [code, contract.code, contract.security_type, retry, commit]);

    // 切回來：在繪製前一次寫入隱藏期間累積的列（不先閃舊畫面）；切走：取消已排程的重繪
    useLayoutEffect(() => {
        if (active) {
            commit();
            return;
        }
        const b = buf.current;
        if (b.timer !== null) {
            clearTimeout(b.timer);
            b.timer = null;
        }
    }, [active, commit]);

    const onRetry = useCallback(() => setRetry(n => n + 1), []);
    const unit = contract.security_type === 'STK' || contract.security_type === 'WRT' ? '張' : '口';
    return (
        <div data-testid='tick-list' hidden={!active}>
            {status === 'error' && rows.length === 0 && (
                <p className={styles.emptyText} role='alert' data-testid='tick-error'>
                    明細載入失敗　<button type='button' className={styles.toggle} onClick={onRetry}>重試</button>
                </p>
            )}
            {status === 'error' && rows.length > 0 && (
                <InlineNote tone='warn' role='status' testId='tick-history-error' action={{ label: '重試', onClick: onRetry }}>
                    較早的明細載入失敗
                </InlineNote>
            )}
            {status === 'loading' && rows.length === 0 && <Skeleton label='載入中…' rows={5} testId='tick-loading' />}
            {status === 'ready' && rows.length === 0 && <p className={styles.emptyText}>今日尚無成交</p>}
            {rows.length > 0 && (
                <div className={styles.tickHead} aria-hidden='true' data-testid='tick-head'>
                    <span>時間</span>
                    <span className={styles.tickNum}>成交價</span>
                    <span className={styles.tickNum}>單量（{unit}）</span>
                    <span className={styles.tickSide}>內外</span>
                </div>
            )}
            <ul className={styles.tickList} aria-label={`逐筆明細（量：${unit}）`}>
                {rows.map((r, i) => <TickRowItem key={r.id} r={r} contract={contract} isNew={i === 0} />)}
            </ul>
        </div>
    );
}
