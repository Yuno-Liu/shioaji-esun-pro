// src/mobile/lib/mobile-indicators.ts — 手機圖表的技術指標設定（規格 Phase 3「更多指標」）
//
// - 指標定義與計算一律重用 src/lib/indicator-defs.ts（INDICATOR_DEFS／DEF_BY_TYPE）；這裡只管「手機啟用哪些、參數多少」。
// - 設定存 localStorage 'sj-mobile-indicators-v1'（與桌面 'sj-pro-indicators-v2' 分開：手機版面上限不同）；
//   讀寫都包 try/catch（私密瀏覽、停用儲存時退回記憶體），損毀或不認得的資料一律回預設。
// - 上限（手機版面）：主圖疊加 MAX_OVERLAYS 個、副圖 MAX_PANES 個；預設＝MA(5)、MA(20)＋成交量（與 MVP 相同）。
// - 參數依定義的 min／max／step 夾住；顏色以調色盤索引保存（只用於單一輸出的指標）。

import { useSyncExternalStore } from 'react';
import { DEF_BY_TYPE, INDICATOR_DEFS, type IndicatorDef, type ParamDef } from '../../lib/indicator-defs';

export const MOBILE_INDICATORS_KEY = 'sj-mobile-indicators-v1';
/** 主圖疊加指標上限（手機寬度下再多線條就看不清楚） */
export const MAX_OVERLAYS = 4;
/** 副圖上限（每個副圖約 96px，手機高度有限） */
export const MAX_PANES = 2;

/** 指標線顏色（刻意避開純紅、純綠：漲跌顏色留給 K 棒與使用者的配色設定） */
export const INDICATOR_PALETTE: readonly string[] = ['#e0a43c', '#8e7cf0', '#19b6c9', '#ff8a3d', '#5a89c9', '#d36fb5'];

export type IndicatorCategory = IndicatorDef['category'];

export interface MobileIndicator {
    /** 穩定 id（同一個指標可加入多次，例如 MA5、MA20） */
    id: string;
    type: string;
    params: Record<string, number>;
    /** INDICATOR_PALETTE 的索引 */
    color: number;
}

export interface MobileIndicatorSettings {
    version: 1;
    /** K 線模式是否顯示成交量（走勢模式一律顯示） */
    volume: boolean;
    items: MobileIndicator[];
}

/** 手機可用的指標定義（內建 21 個；桌面自訂指標不帶到手機） */
export const MOBILE_INDICATOR_DEFS: readonly IndicatorDef[] = INDICATOR_DEFS;

export function defaultIndicatorSettings(): MobileIndicatorSettings {
    return {
        version: 1,
        volume: true,
        items: [
            { id: 'sma-default-5', type: 'sma', params: { period: 5 }, color: 0 },
            { id: 'sma-default-20', type: 'sma', params: { period: 20 }, color: 1 },
        ],
    };
}

// ---- 參數 ----

function stepOf(p: ParamDef): number {
    return p.step && p.step > 0 ? p.step : 1;
}

function decimalsOf(n: number): number {
    const s = String(n);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
}

/** 單一參數：非數字回預設，夾在 [min, max]，對齊步進（沒寫步進＝整數） */
export function clampParam(p: ParamDef, value: unknown): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(n)) return p.def;
    const step = stepOf(p);
    const clamped = Math.min(p.max, Math.max(p.min, n));
    const snapped = p.min + Math.round((clamped - p.min) / step) * step;
    const d = Math.max(decimalsOf(step), decimalsOf(p.min));
    return Number(Math.min(p.max, Math.max(p.min, snapped)).toFixed(d));
}

/** 一個指標的全部參數（只留定義裡有的 key；缺的補預設） */
export function normalizeParams(def: IndicatorDef, params: unknown): Record<string, number> {
    const src = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    const out: Record<string, number> = {};
    for (const p of def.params) out[p.key] = clampParam(p, src[p.key]);
    return out;
}

export function defaultParams(def: IndicatorDef): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of def.params) out[p.key] = p.def;
    return out;
}

// ---- 顯示 ----

/** 「MA(5)」「BOLL(20,2)」「VWAP」 */
export function indicatorLabel(item: Pick<MobileIndicator, 'type' | 'params'>): string {
    const def = DEF_BY_TYPE.get(item.type);
    if (!def) return item.type;
    const args = def.params.map(p => item.params[p.key] ?? p.def);
    return args.length > 0 ? `${def.short}(${args.join(',')})` : def.short;
}

/** 定義的中文名（label 去掉開頭的英文簡稱：「MA 移動平均」→「移動平均」） */
export function indicatorName(def: IndicatorDef): string {
    const i = def.label.indexOf(' ');
    return i > 0 ? def.label.slice(i + 1).trim() : def.label;
}

/** 單一輸出的指標才套用調色盤顏色；多輸出（BOLL、MACD…）沿用定義的配色 */
export function usesPaletteColor(def: IndicatorDef): boolean {
    return def.outputs.length === 1;
}

export function paletteColor(index: number): string {
    return INDICATOR_PALETTE[((index % INDICATOR_PALETTE.length) + INDICATOR_PALETTE.length) % INDICATOR_PALETTE.length]!;
}

// ---- 上限 ----

export function categoryCount(s: MobileIndicatorSettings, category: IndicatorCategory): number {
    let n = 0;
    for (const it of s.items) if (DEF_BY_TYPE.get(it.type)?.category === category) n++;
    return n;
}

export function categoryLimit(category: IndicatorCategory): number {
    return category === 'overlay' ? MAX_OVERLAYS : MAX_PANES;
}

/** 達上限時的說明（沒達上限回傳 null） */
export function limitReason(s: MobileIndicatorSettings, category: IndicatorCategory): string | null {
    if (categoryCount(s, category) < categoryLimit(category)) return null;
    return category === 'overlay'
        ? `主圖最多 ${MAX_OVERLAYS} 個指標（手機畫面有限），請先移除一個再加入`
        : `副圖最多 ${MAX_PANES} 個（手機畫面高度有限），請先移除一個再加入`;
}

export type CanAdd = { ok: true } | { ok: false; reason: string };

export function canAddIndicator(s: MobileIndicatorSettings, type: string): CanAdd {
    const def = DEF_BY_TYPE.get(type);
    if (!def || !MOBILE_INDICATOR_DEFS.includes(def)) return { ok: false, reason: '不支援的指標' };
    const reason = limitReason(s, def.category);
    return reason ? { ok: false, reason } : { ok: true };
}

// ---- 驗證 ----

let idSeq = 0;
function newId(type: string): string {
    idSeq += 1;
    return `${type}-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

/** 下一個沒被用掉的顏色（全部用過就輪替） */
function nextColor(items: readonly MobileIndicator[]): number {
    const used = new Set(items.map(i => i.color));
    for (let i = 0; i < INDICATOR_PALETTE.length; i++) if (!used.has(i)) return i;
    return items.length % INDICATOR_PALETTE.length;
}

/**
 * 任意輸入（localStorage 讀出的 JSON）→ 合法設定。
 * 版本不符、不是物件、items 不是陣列 → 預設；不認得的指標丟掉；超過上限的丟掉（先到先留）；
 * 參數夾住；顏色索引不合法時重新分配；id 重複或缺漏時重新產生。
 */
export function sanitizeIndicatorSettings(raw: unknown): MobileIndicatorSettings {
    if (!raw || typeof raw !== 'object') return defaultIndicatorSettings();
    const r = raw as Record<string, unknown>;
    if (r.version !== 1 || !Array.isArray(r.items)) return defaultIndicatorSettings();
    const items: MobileIndicator[] = [];
    const ids = new Set<string>();
    const counts = { overlay: 0, pane: 0 };
    for (const entry of r.items) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const def = typeof e.type === 'string' ? DEF_BY_TYPE.get(e.type) : undefined;
        if (!def || !MOBILE_INDICATOR_DEFS.includes(def)) continue;
        if (counts[def.category] >= categoryLimit(def.category)) continue;
        counts[def.category] += 1;
        let id = typeof e.id === 'string' && /^[\w.-]{1,64}$/.test(e.id) ? e.id : '';
        if (!id || ids.has(id)) id = newId(def.type);
        ids.add(id);
        const color = typeof e.color === 'number' && Number.isInteger(e.color) && e.color >= 0 && e.color < INDICATOR_PALETTE.length
            ? e.color
            : nextColor(items);
        items.push({ id, type: def.type, params: normalizeParams(def, e.params), color });
    }
    return { version: 1, volume: r.volume !== false, items };
}

// ---- 純函式：變更 ----

export function addIndicator(s: MobileIndicatorSettings, type: string): MobileIndicatorSettings {
    const def = DEF_BY_TYPE.get(type);
    if (!def || !canAddIndicator(s, type).ok) return s;
    return { ...s, items: [...s.items, { id: newId(type), type, params: defaultParams(def), color: nextColor(s.items) }] };
}

export function removeIndicator(s: MobileIndicatorSettings, id: string): MobileIndicatorSettings {
    const items = s.items.filter(i => i.id !== id);
    return items.length === s.items.length ? s : { ...s, items };
}

export function updateIndicatorParams(s: MobileIndicatorSettings, id: string, params: Record<string, unknown>): MobileIndicatorSettings {
    let changed = false;
    const items = s.items.map(it => {
        if (it.id !== id) return it;
        const def = DEF_BY_TYPE.get(it.type);
        if (!def) return it;
        const next = normalizeParams(def, { ...it.params, ...params });
        if (def.params.every(p => next[p.key] === it.params[p.key])) return it;
        changed = true;
        return { ...it, params: next };
    });
    return changed ? { ...s, items } : s;
}

export function resetIndicatorParams(s: MobileIndicatorSettings, id: string): MobileIndicatorSettings {
    const it = s.items.find(i => i.id === id);
    const def = it ? DEF_BY_TYPE.get(it.type) : undefined;
    return it && def ? updateIndicatorParams(s, id, defaultParams(def)) : s;
}

export function setIndicatorColor(s: MobileIndicatorSettings, id: string, color: number): MobileIndicatorSettings {
    if (!Number.isInteger(color) || color < 0 || color >= INDICATOR_PALETTE.length) return s;
    let changed = false;
    const items = s.items.map(it => {
        if (it.id !== id || it.color === color) return it;
        changed = true;
        return { ...it, color };
    });
    return changed ? { ...s, items } : s;
}

export function setVolumeVisible(s: MobileIndicatorSettings, volume: boolean): MobileIndicatorSettings {
    return s.volume === volume ? s : { ...s, volume };
}

/** 設定的穩定字串（作為 effect 依賴） */
export function indicatorSettingsKey(s: MobileIndicatorSettings): string {
    return JSON.stringify(s);
}

// ---- 持久化＋store ----

function readStorage(): MobileIndicatorSettings {
    try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(MOBILE_INDICATORS_KEY);
        if (raw === null) return defaultIndicatorSettings();
        return sanitizeIndicatorSettings(JSON.parse(raw));
    } catch {
        return defaultIndicatorSettings();
    }
}

function writeStorage(s: MobileIndicatorSettings) {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(MOBILE_INDICATORS_KEY, JSON.stringify(s));
    } catch {
        // 儲存空間不可用：保留記憶體中的設定
    }
}

let state: MobileIndicatorSettings | null = null;
const listeners = new Set<() => void>();

export function getIndicatorSettings(): MobileIndicatorSettings {
    if (state === null) state = readStorage();
    return state;
}

export function setIndicatorSettings(next: MobileIndicatorSettings) {
    const cur = getIndicatorSettings();
    if (next === cur) return;
    state = next;
    writeStorage(next);
    listeners.forEach(l => l());
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** 測試用：清掉記憶體狀態，下次讀取時重新從 localStorage 載入 */
export function resetIndicatorSettingsForTest() {
    state = null;
    listeners.forEach(l => l());
}

export interface MobileIndicatorsApi {
    settings: MobileIndicatorSettings;
    add: (type: string) => void;
    remove: (id: string) => void;
    updateParams: (id: string, params: Record<string, unknown>) => void;
    resetParams: (id: string) => void;
    setColor: (id: string, color: number) => void;
    setVolume: (volume: boolean) => void;
    resetAll: () => void;
}

const api: Omit<MobileIndicatorsApi, 'settings'> = {
    add: type => setIndicatorSettings(addIndicator(getIndicatorSettings(), type)),
    remove: id => setIndicatorSettings(removeIndicator(getIndicatorSettings(), id)),
    updateParams: (id, params) => setIndicatorSettings(updateIndicatorParams(getIndicatorSettings(), id, params)),
    resetParams: id => setIndicatorSettings(resetIndicatorParams(getIndicatorSettings(), id)),
    setColor: (id, color) => setIndicatorSettings(setIndicatorColor(getIndicatorSettings(), id, color)),
    setVolume: volume => setIndicatorSettings(setVolumeVisible(getIndicatorSettings(), volume)),
    resetAll: () => setIndicatorSettings(defaultIndicatorSettings()),
};

export function useMobileIndicators(): MobileIndicatorsApi {
    const settings = useSyncExternalStore(subscribe, getIndicatorSettings, getIndicatorSettings);
    return { settings, ...api };
}
