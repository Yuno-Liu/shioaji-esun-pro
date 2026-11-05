// src/mobile/components/tick-list.tsx — 逐筆明細（規格 §6.2）
//
// 先以 fetchLastTicks(contract, 50) 取最近 50 筆，再接 onAnyTick()（只取目前商品）；
// 最多保留 200 筆。內外盤以 tick_type 著色並附文字（1 外盤、2 內盤），不只靠顏色。

import { useEffect, useRef, useState } from 'react';
import { retainQuote } from '../../lib/quote-ownership';
import { fetchLastTicks } from '../../lib/shioaji';
import { onAnyTick } from '../../lib/stream';
import type { ContractInfo } from '../../lib/types/contract';
import type { SseTick } from '../../lib/types/market';
import type { HistoryTicks } from '../../lib/types/tick';
import { fmtInt } from '../../lib/utils/format';
import { dateStrOffset } from '../../lib/utils/kbars';
import { formatToTick } from '../../lib/utils/ticksize';
import * as styles from '../styles/trade.css';

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

export function TickList({ code, contract }: { code: string; contract: ContractInfo }) {
    const [rows, setRows] = useState<TickRow[]>([]);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [retry, setRetry] = useState(0);
    const pending = useRef<TickRow[]>([]);
    // 合約快取更新會換物件參照；只在商品真的改變時重新載入
    const contractRef = useRef(contract);
    contractRef.current = contract;

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const ct = contractRef.current;
        pending.current = [];
        setRows([]);
        setStatus('loading');

        loadHistory(ct)
            .then(h => {
                if (cancelled) return;
                // 即時列可能已先到：保留在最上面
                setRows(live => mergeTickRows(live, historyRows(h)));
                setStatus('ready');
            })
            .catch(() => { if (!cancelled) setStatus('error'); });

        const flush = () => {
            timer = null;
            const batch = pending.current;
            pending.current = [];
            if (batch.length) setRows(prev => mergeTickRows(batch, prev));
        };
        const release = retainQuote(ct, 'Tick');
        const off = onAnyTick(tick => {
            // 連續月別名：stream 會以別名代碼再送一次，所以比對頁面代碼即可
            if (tick.code !== code) return;
            pending.current = [liveRow(tick), ...pending.current].slice(0, TICK_LIST_MAX);
            if (timer === null) timer = setTimeout(flush, TICK_LIST_FLUSH_MS);
        });
        return () => {
            cancelled = true;
            off();
            release();
            if (timer !== null) clearTimeout(timer);
        };
    }, [code, contract.code, contract.security_type, retry]);

    const unit = contract.security_type === 'STK' ? '張' : '口';
    return (
        <div data-testid='tick-list'>
            {status === 'error' && rows.length === 0 && (
                <p className={styles.emptyText}>
                    明細載入失敗　<button type='button' className={styles.toggle} onClick={() => setRetry(n => n + 1)}>重試</button>
                </p>
            )}
            {status === 'loading' && rows.length === 0 && <p className={styles.emptyText}>載入中…</p>}
            {status === 'ready' && rows.length === 0 && <p className={styles.emptyText}>今日尚無成交</p>}
            <ul className={styles.tickList} aria-label={`逐筆明細（量：${unit}）`}>
                {rows.map(r => {
                    const tone = r.tickType === 1 ? 'up' : r.tickType === 2 ? 'down' : 'flat';
                    return (
                        <li key={r.id} className={styles.tickRow}>
                            <span className={styles.tickTime}>{r.time}</span>
                            <span className={`${styles.tickNum} ${styles.dirText[tone]}`}>{formatToTick(contract, r.price)}</span>
                            <span className={styles.tickNum}>{fmtInt(r.volume)}</span>
                            <span className={`${styles.tickSide} ${styles.dirText[tone]}`}>{SIDE_TEXT[r.tickType] ?? ''}</span>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
