// src/lib/stock-index.ts — Contract V2 stock catalog and optional typed info.
// Base records stay lightweight; full StockInfo is loaded only by screens that
// genuinely need category/rule fields (for example the sector heatmap).

import {
    fetchContractInfo,
    fetchContracts,
    fetchWarrantUnderlyings,
} from './shioaji';
import { getApiBase } from './runtime';
import { todayStr } from './utils/date';
import { etfNameForLive, refreshEtfNames } from './etf-runtime-catalog';
import { equityNameForLive, ensureEquityNamesFresh } from './stock-runtime-catalog';
import { getProductNamesVersion } from './product-names-version';
import { SearchRequestCache } from './search-request';
import { getProductCatalogVersion, subscribeProductCatalog } from './product-catalog-version';

export interface StockMeta {
    code: string;
    name: string;
    category: string;
    exchange: string;
    day_trade?: string;
    kind?: 'ETF';
    aliases?: string[];
}

// Both name searches and direct codes use the same display policy. The broker
// ContractInfo object remains untouched; aliases never establish availability.
// The broker name is the trading short name and changes on the rename day, while
// TPEx publishes company short names and TWSE lags by a day, so official names
// only add aliases.
export function stockDisplayMeta(code: string, exchange: string, brokerName?: string): Pick<StockMeta, 'name' | 'kind' | 'aliases'> {
    const etf = etfNameForLive(code, exchange);
    const name = brokerName && brokerName !== code ? brokerName : undefined;
    if (!etf) {
        const official = /^[1-9]\d{3}$/.test(code) && (exchange === 'TSE' || exchange === 'OTC' || exchange === 'OES')
            ? equityNameForLive(exchange, code) : undefined;
        if (!official) return { name: name ?? code };
        const display = name ?? official.name;
        return { name: display, aliases: [...new Set([official.name, ...official.aliases])].filter(alias => alias !== display) };
    }
    return {
        name: name ?? etf.name,
        kind: 'ETF',
        aliases: [...new Set([etf.name, ...(etf.aliases ?? []), ...(name ? [name] : [])])],
    };
}

const CATALOG_TTL_MS = 60_000;
// These two shared sources also serve the warrant, stock futures and underlying
// panels. A native cold start can hold reads behind the boot gate for seconds,
// so this deadline stays long; search applies its own shorter cutoff.
const CATALOG_DEADLINE_MS = 10_000;
const sourceOptions = { ttlMs: CATALOG_TTL_MS, limit: 2, deadlineMs: CATALOG_DEADLINE_MS };
const baseCache = new SearchRequestCache<Awaited<ReturnType<typeof fetchContracts>>>(sourceOptions);
const namesCache = new SearchRequestCache<Awaited<ReturnType<typeof fetchWarrantUnderlyings>>>(sourceOptions);
let activeSourceScope = '';
let catalogGeneration = 0;
let detailsCache: StockMeta[] | null = null;
let detailsExpiresAt = 0;
let detailsCatalog: StockMeta[] | undefined;
let detailsLoading: Promise<StockMeta[]> | null = null;
const detailByCode = new Map<string, { value: StockMeta; expiresAt: number }>();
const detailLoadingByCode = new Map<string, Promise<StockMeta | null>>();
let assembledCatalog: {
    scope: string;
    base: Awaited<ReturnType<typeof fetchContracts>>;
    names: Awaited<ReturnType<typeof fetchWarrantUnderlyings>>;
    namesVersion: string;
    rows: StockMeta[];
} | undefined;

const catalogScope = () => JSON.stringify([getApiBase(), todayStr(), getProductCatalogVersion()]);
const detailContext = () => JSON.stringify([catalogScope(), catalogGeneration]);

function ensureSourceScope() {
    const scope = catalogScope();
    if (scope !== activeSourceScope) {
        activeSourceScope = scope;
        catalogGeneration += 1;
        baseCache.clear();
        namesCache.clear();
        assembledCatalog = undefined;
        detailsCache = null;
        detailsExpiresAt = 0;
        detailsCatalog = undefined;
        detailsLoading = null;
        detailByCode.clear();
        detailLoadingByCode.clear();
    }
    return scope;
}

// Contract events invalidate all metadata immediately, including typed Info.
// A lazy scope read may already have moved this cache before its deferred
// notification; ensureSourceScope then deliberately does nothing a second time.
const unsubscribeCatalog = subscribeProductCatalog(() => { ensureSourceScope(); });
if (import.meta.hot) import.meta.hot.dispose(unsubscribeCatalog);

export async function loadStockCatalog(opts?: { signal?: AbortSignal }): Promise<StockMeta[]> {
    const scope = ensureSourceScope();
    // Public name refresh belongs to the mounted App, not to a keystroke's
    // cancellation. SSR callers can explicitly refresh; catalog reads stay local.
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        void refreshEtfNames();
        ensureEquityNamesFresh();
    }
    const generation = catalogGeneration;
    const assertScope = () => {
        if (catalogScope() !== scope || catalogGeneration !== generation) throw new Error('股票目錄載入期間伺服器已切換');
    };
    const [res, underlyings] = await Promise.all([
        baseCache.read(scope, signal => {
            assertScope();
            return fetchContracts('STK', undefined, undefined, { signal });
        }, opts?.signal),
        // Optional names may fail without hiding supported Base identities.
        // Failure is not cached: the next search retries names, not Base.
        namesCache.read(scope, signal => {
            assertScope();
            return fetchWarrantUnderlyings({ signal });
        }, opts?.signal).catch(error => {
            if (opts?.signal?.aborted) throw error;
            return [];
        }),
    ]).catch(error => {
        assertScope();
        throw error;
    });
    assertScope();
    const namesVersion = getProductNamesVersion();
    if (assembledCatalog?.scope === scope && assembledCatalog.base === res && assembledCatalog.names === underlyings
        && assembledCatalog.namesVersion === namesVersion) {
        return assembledCatalog.rows;
    }
    const names = new Map(underlyings.filter(row => row.name).map(row => [row.underlying_code, row.name!]));
    const rows = res.contracts.filter(c => c.code).map(c => {
        const exchange = c.exchange ?? '';
        const brokerName = names.get(c.code);
        return {
            code: c.code,
            ...stockDisplayMeta(c.code, exchange, brokerName),
            category: '',
            exchange,
        };
    });
    assembledCatalog = { scope, base: res, names: underlyings, namesVersion, rows };
    return rows;
}

// ensureSourceScope already drops every details cache when the scope moves.
function ensureDetailsScope() {
    ensureSourceScope();
    return detailContext();
}

// 個股明細請求的並行上限：熱力圖一次可能要 400+ 檔名稱，原生 fallback
// transport 沒有自己的並行限制，不設上限會一口氣送出數百個請求
export const DETAIL_CONCURRENCY = 6;
let detailActive = 0;
const detailQueue: (() => void)[] = [];

function limitDetail<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const run = () => {
            detailActive += 1;
            task()
                .then(resolve, reject)
                .finally(() => {
                    detailActive -= 1;
                    detailQueue.shift()?.();
                });
        };
        if (detailActive < DETAIL_CONCURRENCY) run();
        else detailQueue.push(run);
    });
}

export async function loadStockDetails(codes: string[]): Promise<StockMeta[]> {
    const scope = ensureDetailsScope();
    const unique = [...new Set(codes.filter(Boolean))];
    const load = (code: string) => {
        const cached = detailByCode.get(code);
        if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
        detailByCode.delete(code);
        const pending = detailLoadingByCode.get(code);
        if (pending) return pending;
        const request = limitDetail(() => fetchContractInfo(code, 'STK'))
            .then((info) => {
                if (detailContext() !== scope) return null;
                const detail: StockMeta = {
                    code: info.code,
                    name: info.name,
                    category: info.category,
                    exchange: info.exchange ?? '',
                    day_trade: info.day_trade,
                };
                detailByCode.set(code, { value: detail, expiresAt: Date.now() + CATALOG_TTL_MS });
                return detail;
            })
            .catch(() => null)
            .finally(() => {
                if (detailLoadingByCode.get(code) === request) detailLoadingByCode.delete(code);
            });
        detailLoadingByCode.set(code, request);
        return request;
    };
    const rows = await Promise.all(unique.map(load));
    return rows.filter(
        (detail): detail is StockMeta => detail !== null,
    );
}

export function loadStockIndex(): Promise<StockMeta[]> {
    const scope = ensureDetailsScope();
    if (detailsLoading) return detailsLoading;
    const request = loadStockCatalog()
        .then(async (catalog) => {
            if (detailContext() !== scope) throw new Error('股票目錄載入期間伺服器已切換');
            // Do not let this aggregate cache extend an older Base/name TTL.
            if (detailsCatalog === catalog && detailsCache && detailsExpiresAt > Date.now()) return detailsCache;
            const details = await loadStockDetails(catalog.map((stock) => stock.code));
            if (detailContext() !== scope) throw new Error('股票目錄載入期間伺服器已切換');
            // Partial metadata is returned but retried next time.
            if (details.length >= new Set(catalog.map((stock) => stock.code).filter(Boolean)).size) {
                detailsCache = details;
                detailsCatalog = catalog;
                // Info cached before assembly keeps its original expiry.
                detailsExpiresAt = details.reduce((expiry, detail) => Math.min(
                    expiry, detailByCode.get(detail.code)?.expiresAt ?? Date.now(),
                ), Date.now() + CATALOG_TTL_MS);
            }
            return details;
        }).finally(() => {
            if (detailsLoading === request) detailsLoading = null;
        });
    detailsLoading = request;
    return request;
}

// 只有 ASCII 大寫、數字，以及 U+4E00..U+9FFF（排除「臺」U+81FA）是原鏈的 fixed point，可原樣回傳。
// 其餘字元（換行、control、空白、combining、相容字、surrogate 等）一律完整走原鏈。
// 不用 ^/$ 錨點，也不加 g/y/m flag，讓 test() 保持無狀態。
const nonFixedPointStockChar = /[^A-Z0-9\u4E00-\u81F9\u81FB-\u9FFF]/;
const taiVariant = /\u81FA/g;

export function normalizeStockSearchText(value: string): string {
    if (!nonFixedPointStockChar.test(value)) return value;
    return value.trim().normalize('NFKC').replace(taiVariant, '\u53F0').toUpperCase();
}

/**
 * 若 query 的每個字元依序出現在 target 中（可不連續），回傳中間跳過的總字元數（gap）；
 * 否則回傳 null。用於「元大50 → 元大台灣50」、「國泰高股息 → 國泰永續高股息」等模糊搜尋。
 */
export function fuzzySubsequenceGap(
    target: string,
    query: string,
): number | null {
    if (query.length < 2 || query.length > target.length) return null;
    let tIdx = 0;
    let firstMatch = -1;
    let lastMatch = -1;
    for (let qIdx = 0; qIdx < query.length; qIdx++) {
        const ch = query[qIdx]!;
        const found = target.indexOf(ch, tIdx);
        if (found === -1) return null;
        if (firstMatch === -1) firstMatch = found;
        lastMatch = found;
        tIdx = found + 1;
    }
    return lastMatch - firstMatch + 1 - query.length;
}

/**
 * fork：上游 searchStocks 比不到（代碼前綴、名稱或別名都不含查詢）時的補充候選評分，越小越前；不符合時回傳 null。
 * 依序：去除前導 0 的代碼相符／開頭、代碼片段、多關鍵字（每個關鍵字都出現在代碼或名稱）、名稱子序列（gap ≤ 6）。
 * 一般 4 碼股票優先、00 開頭 ETF 次之、6 碼權證等最後；名稱短的優先。
 */
function forkFuzzyScore(s: StockMeta, code: string, codeNoZero: string, name: string, q: string, tokens: string[], numericQuery: boolean): number | null {
    let score: number | null = null;
    if (numericQuery && codeNoZero.length >= 2 && codeNoZero === q) score = -160;
    else if (numericQuery && codeNoZero.length >= 2 && codeNoZero.startsWith(q)) score = -95;
    else if (q.length >= 2 && code.includes(q)) score = -65;
    else if (tokens.length > 1 && tokens.every(t => code.includes(t) || name.includes(t))) score = -45;
    else if (!numericQuery) {
        const gap = fuzzySubsequenceGap(name, tokens.join(''));
        if (gap !== null && gap <= 6) score = -25 + gap * 3;
    }
    if (score === null) return null;
    return score + (s.code.length === 4 ? 0 : s.code.startsWith('00') ? 4 : 50) + s.name.length;
}

// substring / fuzzy match on name and code — ranked so the actual
// stock beats its thousands of warrants (台積電 before 台積電XX購YY)
export function searchStocks(
    index: StockMeta[],
    query: string,
    limit = 8,
): StockMeta[] {
    const q = normalizeStockSearchText(query);
    if (!q) return [];
    const numericQuery = /^\d+$/.test(q);
    // fork（頂欄與手機快速切換的模糊搜尋）：上游比不到的候選，再以去除前導 0 的代碼、代碼片段、
    // 多關鍵字、名稱子序列補上，排在上游命中之後（rank 3），不改變上游命中之間的順序。
    // 純數字查詢等於去除前導 0 的代碼（50 → 0050、878 → 00878）視同代碼相符，排在真正的代碼相符之後（rank 0.5）。
    const tokens = query.split(/\s+/).map(t => normalizeStockSearchText(t)).filter(Boolean);
    const scored: { s: StockMeta; code: string; score: number; rank: number; letterSuffix: boolean }[] = [];
    for (const s of index) {
        const code = normalizeStockSearchText(s.code);
        const name = s.name === s.code ? code : normalizeStockSearchText(s.name);
        const codeHit = code.startsWith(q);
        let nameHit = name.includes(q);
        let exact = code === q || name === q;
        if (!exact) s.aliases?.some(alias => {
            const normalized = alias === s.name ? name : alias === s.code ? code : normalizeStockSearchText(alias);
            if (normalized === q) {
                exact = true;
                nameHit = true;
                return true;
            }
            // A substring hit must not hide a later alias with the exact-match bonus.
            if (!nameHit) nameHit = normalized.includes(q);
            return false;
        });
        const codeNoZero = code.replace(/^0+/, '');
        const zeroStrippedExact = numericQuery && code !== q && codeNoZero.length >= 2 && codeNoZero === q;
        if (!codeHit && !nameHit) {
            const fuzzy = forkFuzzyScore(s, code, codeNoZero, name, q, tokens, numericQuery);
            if (fuzzy !== null) scored.push({ s, code, score: fuzzy, rank: zeroStrippedExact ? 0.5 : 3, letterSuffix: false });
            continue;
        }
        let score = 0;
        if (exact) score -= 100;
        if (codeHit) score -= 10;
        else if (name.startsWith(q)) score -= 5;
        // plain 4-digit equities rank above warrants/ETNs (6-char codes)
        score += s.code.length === 4 || s.kind === 'ETF' ? 0 : 50;
        score += s.name.length; // shorter names first
        // Code identity and known ETF series outrank incidental name matches.
        const rank = code === q ? 0 : zeroStrippedExact ? 0.5 : numericQuery && s.kind === 'ETF' && codeHit ? 1 : 2;
        scored.push({ s, code, score, rank, letterSuffix: rank === 1 && /^[A-Z]/.test(code.slice(q.length)) });
    }
    scored.sort((a, b) => a.rank - b.rank ||
        (a.rank === 1 ? Number(b.letterSuffix) - Number(a.letterSuffix) ||
            a.code.localeCompare(b.code) || a.s.exchange.localeCompare(b.s.exchange) : 0) || a.score - b.score);
    return scored.slice(0, limit).map((x) => x.s);
}

// distinct categories with member counts (for 類股/heatmap)
export function categoriesOf(
    index: StockMeta[],
): { category: string; count: number }[] {
    const m = new Map<string, number>();
    for (const s of index) {
        if (!s.category) continue;
        m.set(s.category, (m.get(s.category) ?? 0) + 1);
    }
    return [...m.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count);
}

// TWSE category code → readable label (shared by heatmap + leaderboard)
export const SECTOR_LABELS: Record<string, string> = {
    '24': '半導體',
    '25': '電腦週邊',
    '26': '光電',
    '27': '通信網路',
    '28': '電子零組件',
    '29': '電子通路',
    '30': '資訊服務',
    '31': '其他電子',
    '01': '水泥',
    '02': '食品',
    '03': '塑膠',
    '04': '紡織',
    '05': '電機',
    '06': '電器電纜',
    '08': '玻璃陶瓷',
    '09': '造紙',
    '10': '鋼鐵',
    '11': '橡膠',
    '12': '汽車',
    '14': '建材營造',
    '15': '航運',
    '16': '觀光',
    '17': '金融保險',
    '18': '貿易百貨',
    '20': '其他',
    '21': '化學',
    '22': '生技醫療',
    '23': '油電燃氣',
};

export function sectorLabel(category: string): string {
    return (
        SECTOR_LABELS[category] ??
        SECTOR_LABELS[category.padStart(2, '0')] ??
        category
    );
}

// TWSE industry index master code → the stock category it drills into, so the
// heatmap can show a sector-heat overview (which 類股 is hot today) and then
// drill into that sector's members (issue #2).
export const SECTOR_INDICES: {
    index: string;
    category: string;
    label: string;
}[] = [
    { index: 'IX0028', category: '24', label: '半導體' },
    { index: 'IX0029', category: '25', label: '電腦週邊' },
    { index: 'IX0030', category: '26', label: '光電' },
    { index: 'IX0031', category: '27', label: '通信網路' },
    { index: 'IX0032', category: '28', label: '電子零組件' },
    { index: 'IX0033', category: '29', label: '電子通路' },
    { index: 'IX0034', category: '30', label: '資訊服務' },
    { index: 'IX0035', category: '31', label: '其他電子' },
    { index: 'IX0039', category: '17', label: '金融保險' },
    { index: 'IX0037', category: '15', label: '航運' },
    { index: 'IX0026', category: '12', label: '汽車' },
    { index: 'IX0024', category: '10', label: '鋼鐵' },
    { index: 'IX0041', category: '23', label: '油電燃氣' },
    { index: 'IX0021', category: '22', label: '生技醫療' },
    { index: 'IX0036', category: '14', label: '建材營造' },
    { index: 'IX0017', category: '05', label: '電機機械' },
    { index: 'IX0012', category: '03', label: '塑膠' },
    { index: 'IX0011', category: '02', label: '食品' },
    { index: 'IX0016', category: '04', label: '紡織' },
    { index: 'IX0010', category: '01', label: '水泥' },
    { index: 'IX0038', category: '16', label: '觀光' },
    { index: 'IX0040', category: '18', label: '貿易百貨' },
    { index: 'IX0025', category: '11', label: '橡膠' },
    { index: 'IX0023', category: '09', label: '造紙' },
    { index: 'IX0018', category: '06', label: '電器電纜' },
    { index: 'IX0022', category: '08', label: '玻璃陶瓷' },
];

// the category code for a single stock code (for showing/jumping by sector)
export function categoryOf(
    index: StockMeta[],
    code: string,
): string | null {
    return index.find((s) => s.code === code)?.category ?? null;
}
