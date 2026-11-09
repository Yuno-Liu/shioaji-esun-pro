// src/mobile/lib/futures-lists.ts — 自選頁固定清單「股期近月」「股期遠月」的資料（使用者要求；設計規格 §7.2）
//
// - 來源：src/lib 既有的 fetchFutures({})（GET /api/v1/data/contracts/futures?region=TW，一次取回全部期貨合約，
//   約 1.86 MB JSON／118 KB gzip）。只在第一次開啟固定清單分頁時讀取（延遲載入的 components/futures-list.tsx），
//   模組層依台北日期快取：同一個台北日只讀 1 次（兩個分頁共用），日期變了下次開啟（或分頁停留跨過午夜）才重新讀取，
//   清單跟著換到新的近月／遠月。失敗不快取（下次開啟或按［重試］再讀）。
//   伺服器推送期貨合約清單變更（SSE contract 事件 base_changed，FUT 或不分類）時只清掉快取、不立即請求：
//   下次開啟固定清單分頁才重新讀取（伺服器換月後不會一直沿用舊的近月）。
// - 範圍（使用者選「一般＋小型」）：spec_kind 'stock_fut'、underlying_kind 'S'，且 multiplier 2000（一般）或 100（小型）；
//   調整型契約（其他乘數）、ETF 期貨（'etf_fut'）、指數與商品期貨都不列。
// - 近月／遠月：取連續月代碼 <root>R1／<root>R2 的 target_code（實際月份合約）。列代碼**用實際月份代碼**（例如 CDFK6），
//   不用 R1／R2：點列、長按買賣、快速下單鍵、交易頁下單面板與五檔都直接以實際月份合約開啟，面板與確認面板顯示的
//   就是實際送出的合約；行情、快照、K 線也都以實際代碼查詢，不需要連續月別名。
//   合約資料取同一份回應中實際月份那一筆（沒有時以 R1／R2 那筆換成實際代碼）；最後交易日已過的合約不列（資料過期的防呆）。
// - 排序（基準順序，也是「股票代號」排序）：標的股票代號 → 一般在小型前 → 合約代碼。

import { fetchFutures } from '../../lib/shioaji';
import { onContractEvent } from '../../lib/stream';
import type { ContractInfo } from '../../lib/types/contract';

export type FuturesListId = 'fut:near' | 'fut:next';

/** 固定清單（分頁值即清單 id，排序偏好以它為鍵；與伺服器清單 id 不衝突） */
export const FUTURES_LISTS: readonly { id: FuturesListId; label: string; suffix: 'R1' | 'R2' }[] = [
    { id: 'fut:near', label: '股期近月', suffix: 'R1' },
    { id: 'fut:next', label: '股期遠月', suffix: 'R2' },
];

/** 一般股票期貨的乘數（2,000 股） */
export const STANDARD_MULTIPLIER = 2000;
/** 小型股票期貨的乘數（100 股） */
export const MINI_MULTIPLIER = 100;

export interface FuturesRow {
    /** 實際月份合約代碼（列代碼、行情與下單都用它） */
    code: string;
    /** 實際月份合約（target_code 為 null） */
    contract: ContractInfo;
    /** 列名稱：合約名稱去掉月份（例如「台積電期貨」「小型台積電期貨」） */
    name: string;
    /** 標的股票代碼 */
    under: string;
    /** 乘數（2000 或 100） */
    mult: number;
}

export interface FuturesLists {
    near: FuturesRow[];
    next: FuturesRow[];
}

/** 台北日期 YYYY-MM-DD */
export const taipeiDate = (now = Date.now()): string => new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);

/** 到下一個台北午夜的毫秒數 */
export const msToTaipeiMidnight = (now = Date.now()): number => 86_400_000 - ((now + 8 * 3_600_000) % 86_400_000);

const isStockFuture = (c: ContractInfo) =>
    c.spec_kind === 'stock_fut' && c.underlying_kind === 'S' && (c.multiplier === STANDARD_MULTIPLIER || c.multiplier === MINI_MULTIPLIER);

/** 標的代號 → 一般在小型前 → 合約代碼 */
export function compareFuturesRows(a: Pick<FuturesRow, 'under' | 'mult' | 'code'>, b: Pick<FuturesRow, 'under' | 'mult' | 'code'>): number {
    if (a.under !== b.under) return a.under < b.under ? -1 : 1;
    if (a.mult !== b.mult) return b.mult - a.mult;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

function buildOne(all: readonly ContractInfo[], byCode: ReadonlyMap<string, ContractInfo>, suffix: 'R1' | 'R2', today: string): FuturesRow[] {
    const seen = new Set<string>();
    const rows: FuturesRow[] = [];
    for (const c of all) {
        if (!c.code.endsWith(suffix) || c.code !== `${c.root ?? ''}${suffix}` || !c.target_code || !isStockFuture(c)) continue;
        const actual = byCode.get(c.target_code);
        const contract: ContractInfo = actual && isStockFuture(actual) ? actual : { ...c, code: c.target_code, target_code: null };
        if (seen.has(contract.code)) continue;
        // 資料過期（最後交易日已過）：不列，避免開到已到期的合約
        if (contract.last_trading_date && contract.last_trading_date < today) continue;
        seen.add(contract.code);
        rows.push({
            code: contract.code,
            contract,
            name: (contract.name || c.name || contract.code).replace(/\s*(\d{6}|近月|次月)$/, ''),
            under: c.underlying_code ?? '',
            mult: c.multiplier!,
        });
    }
    return rows.sort(compareFuturesRows);
}

/** 由全部期貨合約組出近月與遠月清單（純函式） */
export function buildFuturesLists(all: readonly ContractInfo[], today = taipeiDate()): FuturesLists {
    const list = Array.isArray(all) ? all.filter(c => c && typeof c.code === 'string') : [];
    const byCode = new Map(list.map(c => [c.code, c]));
    return { near: buildOne(list, byCode, 'R1', today), next: buildOne(list, byCode, 'R2', today) };
}

// ---------------------------------------------------------------------------
// 讀取（模組層、依台北日期快取；兩個分頁共用同一次請求）

let cached: { day: string; promise: Promise<FuturesLists> } | null = null;
/** 今天已讀到的資料（同步取得：切換分頁再回來不閃讀取中） */
let settled: { day: string; data: FuturesLists } | null = null;

/** 取得今天（台北）的固定清單：同一個台北日只發 1 次請求；失敗不快取 */
export function loadFuturesLists(now = Date.now()): Promise<FuturesLists> {
    watchFuturesContractEvents();
    const day = taipeiDate(now);
    if (cached?.day === day) return cached.promise;
    const entry = {
        day,
        promise: fetchFutures({}).then(all => {
            const data = buildFuturesLists(all, day);
            settled = { day, data };
            return data;
        }),
    };
    cached = entry;
    entry.promise.catch(() => {
        if (cached === entry) cached = null;
    });
    return entry.promise;
}

/** 今天的資料已讀到時同步回傳；沒有時 undefined */
export function peekFuturesLists(now = Date.now()): FuturesLists | undefined {
    return settled?.day === taipeiDate(now) ? settled.data : undefined;
}

/** 清掉快取（下次 loadFuturesLists 重新讀取）；不發請求 */
export function invalidateFuturesLists(): void {
    cached = null;
    settled = null;
}

let watching = false;
/** 第一次開啟固定清單時開始監聽合約變更事件（模組層一次） */
export function watchFuturesContractEvents(): void {
    if (watching) return;
    watching = true;
    onContractEvent(e => {
        if (e.base_changed && (e.security_type === 'FUT' || e.security_type == null)) invalidateFuturesLists();
    });
}

/** 測試用：清除快取 */
export function resetFuturesListsForTest(): void {
    cached = null;
    settled = null;
}
