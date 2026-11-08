// src/mobile/lib/line-indicators.ts — 走勢副圖指標的設定（分時買賣力、大單／小單買賣力；設計規格 §7.3）
//
// - 存 localStorage 'sj-mobile-line-indicators-v1'（與 K 線指標的 'sj-mobile-indicators-v1' 分開，不改它的格式）；
//   讀寫都包 try/catch（私密瀏覽、停用儲存時退回記憶體），損毀或不認得的資料一律回預設。
// - 預設兩個都關閉：開啟才下載當日全部逐筆（lib/line-flow.ts）。
// - 大單門檻：單筆成交金額（萬元），只能選 LINE_FLOW_THRESHOLDS 其中之一，預設 500 萬。

import { useSyncExternalStore } from 'react';

export const LINE_INDICATORS_KEY = 'sj-mobile-line-indicators-v1';
/** 大單門檻選項（萬元）；line-flow 依這組預先分類，改門檻不必重抓 */
export const LINE_FLOW_THRESHOLDS: readonly number[] = [100, 300, 500, 1000, 2000];
export const DEFAULT_LINE_FLOW_THRESHOLD = 500;

export interface LineIndicatorSettings {
    version: 1;
    /** 分時買賣力副圖 */
    flow: boolean;
    /** 大單／小單買賣力副圖 */
    bigSmall: boolean;
    /** 大單門檻（萬元） */
    threshold: number;
}

export function defaultLineIndicatorSettings(): LineIndicatorSettings {
    return { version: 1, flow: false, bigSmall: false, threshold: DEFAULT_LINE_FLOW_THRESHOLD };
}

/** 任意輸入（localStorage 讀出的 JSON）→ 合法設定 */
export function sanitizeLineIndicatorSettings(raw: unknown): LineIndicatorSettings {
    const d = defaultLineIndicatorSettings();
    if (!raw || typeof raw !== 'object') return d;
    const o = raw as Record<string, unknown>;
    if (o.version !== 1) return d;
    return {
        version: 1,
        flow: o.flow === true,
        bigSmall: o.bigSmall === true,
        threshold: typeof o.threshold === 'number' && LINE_FLOW_THRESHOLDS.includes(o.threshold) ? o.threshold : d.threshold,
    };
}

/** 門檻在 LINE_FLOW_THRESHOLDS 的索引（不認得時用預設） */
export function thresholdIndex(threshold: number): number {
    const i = LINE_FLOW_THRESHOLDS.indexOf(threshold);
    return i >= 0 ? i : LINE_FLOW_THRESHOLDS.indexOf(DEFAULT_LINE_FLOW_THRESHOLD);
}

/** 1000 萬以上寫成「千萬」：500萬、1,000萬 → 「1千萬」；圖例與面板共用 */
export function thresholdLabel(threshold: number): string {
    return threshold >= 1000 && threshold % 1000 === 0 ? `${threshold / 1000}千萬` : `${threshold}萬`;
}

function readStorage(): LineIndicatorSettings {
    try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(LINE_INDICATORS_KEY);
        return raw === null ? defaultLineIndicatorSettings() : sanitizeLineIndicatorSettings(JSON.parse(raw));
    } catch {
        return defaultLineIndicatorSettings();
    }
}

let state: LineIndicatorSettings | null = null;
const listeners = new Set<() => void>();

export function getLineIndicatorSettings(): LineIndicatorSettings {
    if (state === null) state = readStorage();
    return state;
}

export function setLineIndicatorSettings(patch: Partial<Omit<LineIndicatorSettings, 'version'>>) {
    const cur = getLineIndicatorSettings();
    const next = sanitizeLineIndicatorSettings({ ...cur, ...patch });
    if (next.flow === cur.flow && next.bigSmall === cur.bigSmall && next.threshold === cur.threshold) return;
    state = next;
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(LINE_INDICATORS_KEY, JSON.stringify(next));
    } catch {
        // 儲存空間不可用：保留記憶體中的設定
    }
    listeners.forEach(l => l());
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function useLineIndicatorSettings(): LineIndicatorSettings {
    return useSyncExternalStore(subscribe, getLineIndicatorSettings, getLineIndicatorSettings);
}

/** 測試用：清掉記憶體狀態，下次讀取時重新從 localStorage 載入 */
export function resetLineIndicatorSettingsForTest() {
    state = null;
    listeners.forEach(l => l());
}
