// src/mobile/lib/num-format.ts — 手機版高頻路徑的數字格式化（稽核 P1）
//
// Number.prototype.toLocaleString(locale, opts) 每次呼叫都重建 Intl 格式器（headless Chrome 約 10–17µs／次），
// 交易頁每次行情 flush 約 40 次、持倉頁每列多次，是重繪中最大的 JS 熱點。這裡以模組層 Map 快取
// Intl.NumberFormat（key＝locale＋選項組合），format() 約 0.4µs。
//
// 與 src/lib 版本（lib/utils/format、lib/utils/ticksize）輸出逐字相同（num-format.test.ts 以大量向量逐一比對）：
// - 依規格 toLocaleString(locales, options) 就是 new Intl.NumberFormat(locales, options).format(x)；
//   只傳原本有傳的選項（useGrouping 未傳與傳 true 在新版 Intl 不同：未傳是 'auto'）。
// - 只有 number 走快取；非 number（執行期壞資料，例如字串）交回原本的 toLocaleString，行為不變。
// src/lib 不修改：桌面版與其他呼叫端照舊。

import { tickDecimals, tickSizeFor } from '../../lib/utils/ticksize';

interface NumberFormatKeyOptions {
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    useGrouping?: boolean;
}

const formats = new Map<string, Intl.NumberFormat>();

/** 快取的 Intl.NumberFormat；locale 為 undefined 時是執行環境預設語系（同 toLocaleString() 不帶參數） */
export function cachedNumberFormat(locale: string | undefined, opts: NumberFormatKeyOptions = {}): Intl.NumberFormat {
    const key = `${locale ?? ''}|${opts.minimumFractionDigits ?? ''}|${opts.maximumFractionDigits ?? ''}|${opts.useGrouping ?? ''}`;
    let f = formats.get(key);
    if (!f) {
        const o: Intl.NumberFormatOptions = {};
        if (opts.minimumFractionDigits !== undefined) o.minimumFractionDigits = opts.minimumFractionDigits;
        if (opts.maximumFractionDigits !== undefined) o.maximumFractionDigits = opts.maximumFractionDigits;
        if (opts.useGrouping !== undefined) o.useGrouping = opts.useGrouping;
        f = new Intl.NumberFormat(locale, o);
        formats.set(key, f);
    }
    return f;
}

/**
 * 等同 v.toLocaleString(locale, opts)（v 為 number 時走快取）。locale 必填且沒有預設值：
 * undefined 就是執行環境預設語系（同 toLocaleString() 不帶參數），不會被換成 en-US。
 */
export function formatNumber(v: number, locale: string | undefined, opts?: NumberFormatKeyOptions): string {
    if (typeof v !== 'number') return (v as { toLocaleString(l?: string, o?: Intl.NumberFormatOptions): string }).toLocaleString(locale, opts);
    return cachedNumberFormat(locale, opts).format(v);
}

/** 同 lib/utils/format fmtInt：千分位整數（en-US）；undefined／null → — */
export function fmtInt(v: number | undefined): string {
    if (v === undefined || v === null) return '—';
    return formatNumber(v, 'en-US');
}

/** 同 lib/utils/format fmtCompactInt：五檔等窄格的量（9,999／10.4萬／235萬／1.2億） */
export function fmtCompactInt(v: number | undefined): string {
    if (v === undefined || v === null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a < 10_000) return formatNumber(Math.round(v), 'en-US');
    if (a < 100_000_000) return `${(v / 10_000).toFixed(a < 1_000_000 ? 1 : 0)}萬`;
    return `${(v / 100_000_000).toFixed(1)}億`;
}

/** 同 lib/utils/format fmtStockLots：股數以張＋股（1000 → 1張、5010 → 5張+10股）；張數用預設語系千分位（同原本 toLocaleString()） */
export function fmtStockLots(shares: number): string {
    const s = Math.round(shares);
    const lots = Math.trunc(s / 1000);
    const odd = s - lots * 1000;
    if (lots && odd) return `${formatNumber(lots, undefined)}張+${odd}股`;
    if (lots) return `${formatNumber(lots, undefined)}張`;
    return `${odd}股`;
}

/** 同 lib/utils/ticksize formatToTick：先吸附到跳動價位，再依級距小數位數格式化 */
export function formatToTick(
    contract: Parameters<typeof tickSizeFor>[0],
    price: number,
    opts: { grouping?: boolean; at?: number } = {},
): string {
    if (!Number.isFinite(price)) return '—';
    const tick = tickSizeFor(contract, Math.abs(opts.at ?? price));
    const decimals = tickDecimals(tick);
    const rounded = Math.round(price / tick) * tick;
    return cachedNumberFormat('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        useGrouping: opts.grouping ?? true,
    }).format(rounded);
}

/**
 * 行情價格文字：指數固定兩位、不吸附跳動價位（同 lib/utils/format fmtPrice(v, 2)、桌面 quote-board 的指數）；
 * 其他商品同 formatToTick。指數沒有跳動單位，tickSizeFor 對 IND 會套股票級距（23,456.78 → 23,455），不能用。
 */
export function formatQuotePrice(
    contract: Parameters<typeof tickSizeFor>[0],
    price: number,
    opts: { grouping?: boolean; at?: number } = {},
): string {
    if (contract.security_type !== 'IND') return formatToTick(contract, price, opts);
    if (!Number.isFinite(price)) return '—';
    const two = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return cachedNumberFormat('en-US', opts.grouping === false ? { ...two, useGrouping: false } : two).format(price);
}
