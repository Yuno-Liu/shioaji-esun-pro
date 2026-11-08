// src/mobile/components/market/signal-model.ts — 盤中異動（即時掃描訊號）的純資料邏輯（無 React、無請求）
//
// 規則分組、標籤與市場沿用桌面 src/components/market-pulse-panel.tsx 的 FAMILY_RULES、FAMILY_LABELS、RULE_LABELS、
// SIGNAL_EXCHANGES（桌面元件不匯入手機版，這裡複製常數，語意必須一致）。
// - 篩選只到「規則家族」（漲跌停、急漲跌、爆量、狀態）＋市場（上市、上櫃）；預設同桌面：急漲跌、上市＋上櫃。
// - 篩選存 localStorage（讀寫都包 try/catch，失敗時本次仍生效、下次回預設）。
// - 名稱：只讀已在記憶體的資料，不為訊號發出逐檔查詢（見 signalName）。

import { getCachedContract } from '../../../lib/contracts-cache';
import { etfNameForLive } from '../../../lib/etf-runtime-catalog';
import { equityNameForLive } from '../../../lib/stock-runtime-catalog';
import type { ScannerExchange, ScannerGapEvent, ScannerRule, ScannerSignalEvent } from '../../../lib/types/market';

export type SignalFamily = 'limit' | 'move' | 'volume' | 'state';

export const SIGNAL_FAMILIES: readonly SignalFamily[] = ['limit', 'move', 'volume', 'state'];

export const FAMILY_RULES: Record<SignalFamily, readonly ScannerRule[]> = {
    limit: ['bid_near_limit_up', 'bid_touch_limit_up', 'limit_up_unlocked', 'ask_near_limit_down', 'ask_touch_limit_down', 'limit_down_unlocked'],
    move: ['trade_price_surge', 'trade_price_drop', 'bid_price_surge', 'ask_price_drop'],
    volume: ['volume_burst'],
    state: ['simtrade', 'suspend'],
};

export const FAMILY_LABELS: Record<SignalFamily, string> = {
    limit: '漲跌停',
    move: '急漲跌',
    volume: '爆量',
    state: '狀態',
};

export const SIGNAL_EXCHANGES: readonly ScannerExchange[] = ['TSE', 'OTC'];

export const EXCHANGE_LABELS: Record<ScannerExchange, string> = { TSE: '上市', OTC: '上櫃' };

export const RULE_LABELS: Record<ScannerRule, string> = {
    bid_near_limit_up: '接近漲停',
    bid_touch_limit_up: '觸及漲停',
    limit_up_unlocked: '漲停打開',
    ask_near_limit_down: '接近跌停',
    ask_touch_limit_down: '觸及跌停',
    limit_down_unlocked: '跌停打開',
    trade_price_surge: '成交急漲',
    trade_price_drop: '成交急跌',
    bid_price_surge: '買價急漲',
    ask_price_drop: '賣價急跌',
    volume_burst: '單筆爆量',
    simtrade: '試撮',
    suspend: '暫停交易',
};

/** 清單最多渲染的列數（lib 保留最新 250 筆） */
export const SIGNAL_ROW_LIMIT = 100;

// ---- 篩選 ----

export interface SignalFilters {
    families: readonly SignalFamily[];
    exchanges: readonly ScannerExchange[];
}

export const DEFAULT_SIGNAL_FILTERS: SignalFilters = { families: ['move'], exchanges: ['TSE', 'OTC'] };

export const SIGNAL_FILTERS_KEY = 'sj-mobile-signal-filters-v1';

/** 任意輸入（localStorage 讀出的 JSON）→ 合法篩選；依固定順序、去重；不是物件時回預設 */
export function normalizeSignalFilters(raw: unknown): SignalFilters {
    if (!raw || typeof raw !== 'object') return DEFAULT_SIGNAL_FILTERS;
    const r = raw as { families?: unknown; exchanges?: unknown };
    if (!Array.isArray(r.families) || !Array.isArray(r.exchanges)) return DEFAULT_SIGNAL_FILTERS;
    const families = SIGNAL_FAMILIES.filter(f => (r.families as unknown[]).includes(f));
    const exchanges = SIGNAL_EXCHANGES.filter(e => (r.exchanges as unknown[]).includes(e));
    return { families, exchanges };
}

export function loadSignalFilters(): SignalFilters {
    try {
        const text = localStorage.getItem(SIGNAL_FILTERS_KEY);
        return text ? normalizeSignalFilters(JSON.parse(text)) : DEFAULT_SIGNAL_FILTERS;
    } catch {
        return DEFAULT_SIGNAL_FILTERS;
    }
}

export function saveSignalFilters(filters: SignalFilters): void {
    try {
        localStorage.setItem(SIGNAL_FILTERS_KEY, JSON.stringify(filters));
    } catch {
        // 無痕模式、配額或停用儲存：本次仍生效
    }
}

export function toggleFamily(filters: SignalFilters, family: SignalFamily): SignalFilters {
    const on = filters.families.includes(family);
    return { ...filters, families: SIGNAL_FAMILIES.filter(f => (f === family ? !on : filters.families.includes(f))) };
}

export function toggleExchange(filters: SignalFilters, exchange: ScannerExchange): SignalFilters {
    const on = filters.exchanges.includes(exchange);
    return { ...filters, exchanges: SIGNAL_EXCHANGES.filter(e => (e === exchange ? !on : filters.exchanges.includes(e))) };
}

export function enabledRules(filters: SignalFilters): ScannerRule[] {
    return filters.families.flatMap(f => FAMILY_RULES[f]);
}

// ---- 訂閱鍵（規則 × 市場；與 lib/shioaji 的 capability key `scanner:${exchange}:${scanner}` 一一對應） ----

export type SignalKey = `${ScannerExchange}:${ScannerRule}`;

export function signalKeys(filters: SignalFilters): SignalKey[] {
    const rules = enabledRules(filters);
    return filters.exchanges.flatMap(exchange => rules.map(rule => `${exchange}:${rule}` as SignalKey));
}

export function parseSignalKey(key: SignalKey): { exchange: ScannerExchange; rule: ScannerRule } {
    const i = key.indexOf(':');
    return { exchange: key.slice(0, i) as ScannerExchange, rule: key.slice(i + 1) as ScannerRule };
}

// ---- 清單 ----

/** 依篩選過濾（lib 的陣列最新在前、原地變動：這裡一律回傳新陣列），最多 limit 筆 */
export function visibleSignals(signals: readonly ScannerSignalEvent[], filters: SignalFilters, limit = SIGNAL_ROW_LIMIT): ScannerSignalEvent[] {
    const rules = new Set(enabledRules(filters));
    const exchanges = new Set(filters.exchanges);
    const out: ScannerSignalEvent[] = [];
    for (const signal of signals) {
        if (out.length >= limit) break;
        if (rules.has(signal.scanner) && exchanges.has(signal.exchange)) out.push(signal);
    }
    return out;
}

export function signalRowKey(signal: ScannerSignalEvent): string {
    return `${signal.exchange}:${signal.scanner}:${signal.quote.code}:${signal.quote.date}:${signal.quote.time}`;
}

export type SignalTone = 'up' | 'down' | 'flat';

/** 規則的方向（同桌面 signalDirection）：只作輔助色，標籤文字本身已說明方向 */
export function ruleTone(rule: ScannerRule): SignalTone {
    if (rule.includes('down') || rule.includes('drop')) return 'down';
    if (rule.includes('up') || rule.includes('surge')) return 'up';
    return 'flat';
}

/** HH:MM:SS（交易所時間字串可能帶小數秒） */
export function fmtSignalTime(time: string | undefined): string {
    return typeof time === 'string' ? time.slice(0, 8) : '';
}

function finite(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function fmtPrice(n: number): string {
    // 台股價格最多 2 位小數；去掉尾端 0（12.50 → 12.5）
    return String(Math.round(n * 100) / 100);
}

/** 規則補充說明（同桌面 signalDetail）：爆量為成交金額、急漲跌為變動幅度、漲跌停為觸發價 */
export function signalDetail(rule: ScannerRule, extra: Record<string, unknown> | undefined): string {
    const x = extra ?? {};
    if (rule === 'volume_burst') {
        const amount = finite(x.amount) ?? 0;
        if (amount >= 100_000_000) return `${(amount / 100_000_000).toFixed(2)} 億`;
        return amount > 0 ? `${Math.round(amount / 10_000).toLocaleString('en-US')} 萬` : '';
    }
    if (rule.includes('surge') || rule.includes('drop')) {
        const pct = finite(x.change_percent);
        return pct === null ? '' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
    }
    const price = finite(x.trigger_price ?? x.limit_price);
    return price !== null && price > 0 ? fmtPrice(price) : '';
}

export interface SignalQuoteView {
    /** 成交價；沒有時 null */
    price: string | null;
    /** 漲跌（帶正負號）與漲跌幅；沒有時 null */
    change: string | null;
    tone: SignalTone;
    simtrade: boolean;
}

/** 事件內 quote 的成交價與漲跌（diff_price 為相對昨收的漲跌；漲跌幅以 close − diff 推回昨收） */
export function signalQuote(signal: ScannerSignalEvent): SignalQuoteView {
    const close = finite(signal.quote.close);
    const diff = finite(signal.quote.diff_price);
    const simtrade = signal.quote.simtrade === true || signal.scanner === 'simtrade';
    const price = close !== null && close > 0 ? fmtPrice(close) : null;
    if (diff === null) return { price, change: null, tone: 'flat', simtrade };
    const tone: SignalTone = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
    const ref = close !== null ? close - diff : null;
    const pct = ref !== null && ref > 0 ? ` (${sign}${(Math.abs(diff) / ref * 100).toFixed(2)}%)` : '';
    return { price, change: `${sign}${fmtPrice(Math.abs(diff))}${pct}`, tone, simtrade };
}

function cleanName(name: unknown, code: string): string | null {
    const text = typeof name === 'string' ? name.trim() : '';
    return text && text !== code ? text : null;
}

/**
 * 訊號列的名稱：只讀記憶體中已有的資料，不為訊號發出任何逐檔查詢。
 *   1. 全域合約快取（自選、交易頁、持倉解析過的合約）；
 *   2. ETF 名稱目錄（lib 內建快照；本頁不觸發更新）；
 *   3. 上市櫃公司名稱目錄（lib/stock-runtime-catalog；本頁顯示時呼叫 ensureEquityNamesFresh，lib 自行合併與節流）。
 * 都沒有時回 null，只顯示代碼。
 */
export function signalName(code: string, exchange: ScannerExchange): string | null {
    const fromContract = cleanName(getCachedContract(code)?.name, code);
    if (fromContract) return fromContract;
    const etf = cleanName(etfNameForLive(code, exchange)?.name, code);
    if (etf) return etf;
    return /^[1-9]\d{3}$/.test(code) ? cleanName(equityNameForLive(exchange, code)?.name, code) : null;
}

/** 斷線期間遺漏的訊號提示 */
export function gapText(gap: ScannerGapEvent): string {
    const from = fmtSignalTime(gap.first_time);
    const to = fmtSignalTime(gap.last_time);
    const range = from && to ? `（${from}–${to}）` : '';
    return `串流重連期間遺漏 ${gap.dropped_count} 筆訊號${range}，該時段的異動未列出。`;
}
