// src/mobile/lib/chart-readout.ts — 交易圖表點選／長按追蹤時圖例上方的價格資訊列（設計規格 §7.3）
//
// - 走勢：時間 HH:mm、該分鐘的價格（formatToTick）、漲跌（▲▼＋差額）與漲跌%（正負號、2 位小數），
//   基準與走勢 BaselineSeries 的基準線相同：合約參考價。參考價 ≤ 0（例如指數沒有參考價）時只顯示價格。
// - K 線：該根的收盤與「較前一根」收盤的漲跌；日 K 時間改 MM/DD；第一根沒有前一根，只顯示收盤。
// - 漲跌差額不吸附到跳動價位（參考價與成交價可能落在不同級距，例如 99.9 → 100.5 差 0.6，
//   吸附到 0.5 檔會錯）；小數位數取兩邊級距的較大者。
// - 顏色只輔助：方向以 ▲／▼ 與正負號標示（文字，不只靠顏色）；無障礙名稱另寫「上漲／下跌／平盤」。

import { tickDecimals, tickSizeFor } from '../../lib/utils/ticksize';
import type { Candle } from '../../lib/types/market';
import { cachedNumberFormat, formatToTick } from './num-format';

type TickContract = Parameters<typeof tickSizeFor>[0];

export type ReadoutDir = 'up' | 'down' | 'flat';

export interface ChartReadout {
    /** tap＝輕點釘住（有 ✕）；track＝長按追蹤或滑鼠移動（跟著十字線） */
    source: 'tap' | 'track';
    /** 該根的時間（秒，牆鐘當 UTC）：判斷「再點同一點」 */
    at: number;
    /** HH:mm；日 K 為 MM/DD */
    time: string;
    /** 走勢為空字串；K 線為「收」 */
    priceLabel: string;
    price: string;
    dir: ReadoutDir;
    change: {
        /** 走勢為空字串；K 線為「較前一根」 */
        label: string;
        /** ▲10／▼0.25／0 */
        text: string;
        /** +0.93%／-0.47%／0.00% */
        pct: string;
    } | null;
    ariaLabel: string;
}

export interface ReadoutOptions {
    mode: 'line' | 'kbar';
    /** 日 K：時間顯示 MM/DD */
    daily: boolean;
    contract: TickContract;
    /** 走勢的基準（合約參考價）；K 線不使用 */
    reference: number;
    source: ChartReadout['source'];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 牆鐘當 UTC 的秒數 → HH:mm（日 K → MM/DD） */
export function readoutTime(time: number, daily: boolean): string {
    const d = new Date(time * 1000);
    return daily ? `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}` : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 差額的小數位數：價格與基準各自級距的較大者 */
function diffDecimals(contract: TickContract, price: number, base: number): number {
    return Math.max(tickDecimals(tickSizeFor(contract, Math.abs(price))), tickDecimals(tickSizeFor(contract, Math.abs(base))));
}

/** 價格相對基準的漲跌文字；基準不是正數時回傳 null */
export function readoutChange(contract: TickContract, price: number, base: number): { dir: ReadoutDir; text: string; pct: string; abs: string } | null {
    if (!Number.isFinite(price) || !Number.isFinite(base) || !(base > 0)) return null;
    const dec = diffDecimals(contract, price, base);
    const diff = Number((price - base).toFixed(dec));
    const dir: ReadoutDir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    const abs = cachedNumberFormat('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(Math.abs(diff));
    const pct = dir === 'flat' ? 0 : (diff / base) * 100;
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
    return { dir, text: `${arrow}${abs}`, pct: `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`, abs };
}

/** bars[i] 的資訊列；i 超出範圍時回傳 null */
export function chartReadout(bars: readonly Candle[], i: number, o: ReadoutOptions): ChartReadout | null {
    const bar = bars[i];
    if (!bar || !Number.isFinite(bar.close)) return null;
    const line = o.mode === 'line';
    const base = line ? o.reference : bars[i - 1]?.close ?? NaN;
    const ch = readoutChange(o.contract, bar.close, base);
    const time = readoutTime(bar.time, !line && o.daily);
    const price = formatToTick(o.contract, bar.close);
    const label = line ? '' : '較前一根';
    const dirWord = ch ? (ch.dir === 'up' ? '上漲' : ch.dir === 'down' ? '下跌' : '平盤') : '';
    const aria = [
        time,
        `${line ? '價格' : '收盤'} ${price}`,
        ch ? `${line ? '漲跌' : '較前一根'} ${dirWord} ${ch.abs}，${line ? '漲跌幅' : '幅度'} ${ch.pct}` : '',
    ].filter(Boolean).join('，');
    return {
        source: o.source,
        at: bar.time,
        time,
        priceLabel: line ? '' : '收',
        price,
        dir: ch?.dir ?? 'flat',
        change: ch ? { label, text: ch.text, pct: ch.pct } : null,
        ariaLabel: aria,
    };
}

/** 資訊列的小 store：只讓資訊列元件重繪，不重繪整個圖表元件 */
export interface ReadoutStore {
    get: () => ChartReadout | null;
    set: (next: ChartReadout | null) => void;
    subscribe: (fn: () => void) => () => void;
}

export function createReadoutStore(): ReadoutStore {
    let cur: ChartReadout | null = null;
    let key = '';
    const subs = new Set<() => void>();
    return {
        get: () => cur,
        set: next => {
            const k = next ? JSON.stringify(next) : '';
            if (k === key) return;
            key = k;
            cur = next;
            for (const fn of [...subs]) fn();
        },
        subscribe: fn => {
            subs.add(fn);
            return () => { subs.delete(fn); };
        },
    };
}
