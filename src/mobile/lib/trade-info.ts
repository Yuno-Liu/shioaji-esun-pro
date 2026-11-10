// src/mobile/lib/trade-info.ts — 交易頁「當沖資訊列」的純函式（components/trade-info/trade-info-strip）
//
// 資訊列只用交易頁已有的資料（合約、標頭的報價與快照、處置名單），不發新請求。內容依序：
//   1. 可當沖／先賣（只有股票 STK：合約 day_trade）
//   2. 漲跌停狀態（lib/limit-state：hasPriceLimits、limitStateOf；指數、興櫃、權證沒有漲跌停 → 不顯示；選擇權不判：
//      跌停只是最小跳動的地板，同桌面 quote-board）
//      - 鎖漲停：價位在漲停、最佳委買在漲停且委賣已空；鎖跌停反之。沒有五檔資料時只寫「漲停」「跌停」。
//      - 接近漲停／跌停：距停板 ≤ NEAR_LIMIT_PCT（以參考價計）。
//      - 只用成交或快照的價格（參考價、指數不算），同標頭的「漲停」「跌停」徽章。
//   3. 日內振幅位置（lib/day-range）：有漲跌停的股票、期貨畫以參考價為中心的尺（railScale 檔位、railPos 位置）；
//      選擇權（兩側停板差數十倍）、指數改畫「最低到最高」之間的位置。文字一律寫振幅 %。
//   4. 量比（只有股票，同桌面看板：期權夜盤量會失真）：今日累計量 ÷ 快照的前一交易日量；快照日期與成交對不上時不算。
//   5. 處置（只有股票；mobile/lib/regulatory-punish）。
// 每一項都有文字，不只靠顏色（設計規格 §11）。
// 同一交易日（同桌面 quote-board 的 sameDay）：報價推出的參考價（現價 − 漲跌）與合約參考價相差半個跳動以上時，
// 兩者不是同一個交易日（盤前開 App 的除權息、分割日；期貨夜盤時合約仍是日盤的參考價與漲跌停）：
// 不判停板、不畫以參考價為中心的尺，振幅改以報價自身的參考價計。

import { dayRangeOf, dirVsOpen, INDEX_FUTURE_SCALES, railEndPcts, railPos, railScale, STOCK_SCALES } from '../../lib/day-range';
import { hasPriceLimits, limitStateOf } from '../../lib/limit-state';
import type { ContractInfo, DayTrade, SecurityType } from '../../lib/types/contract';
import { tickSizeFor } from '../../lib/utils/ticksize';
import { fmtVolumeRatio, ratioSnapshotStale, volumeRatioOf } from '../../lib/volume-ratio';

export type InfoTone = 'neutral' | 'warn' | 'danger' | 'up' | 'down';

export interface InfoChip {
    key: 'daytrade' | 'limit' | 'range' | 'ratio' | 'punish';
    text: string;
    tone: InfoTone;
}

// ---- 1. 可當沖／先賣 ----

/** 資訊列的當沖膠囊（只有股票）：Yes＝可當沖也可先賣；OnlyBuy＝只能先買後賣；No＝不可當沖；空字串不顯示 */
export function dayTradeChip(secType: SecurityType | undefined, dt: DayTrade | undefined): InfoChip | null {
    if (secType !== 'STK') return null;
    if (dt === 'Yes') return { key: 'daytrade', text: '可當沖・可先賣', tone: 'neutral' };
    if (dt === 'OnlyBuy') return { key: 'daytrade', text: '僅先買後賣', tone: 'warn' };
    if (dt === 'No') return { key: 'daytrade', text: '不可當沖', tone: 'warn' };
    return null;
}

// ---- 2. 漲跌停狀態 ----

/** 「接近漲停／跌停」的門檻：距停板 ≤ 參考價的 1% */
export const NEAR_LIMIT_PCT = 1;

export type LimitKind = 'lockedUp' | 'up' | 'openUp' | 'nearUp' | 'lockedDown' | 'down' | 'openDown' | 'nearDown';

export const LIMIT_TEXT: Record<LimitKind, string> = {
    lockedUp: '鎖漲停',
    up: '漲停',
    openUp: '漲停未鎖',
    nearUp: '接近漲停',
    lockedDown: '鎖跌停',
    down: '跌停',
    openDown: '跌停未鎖',
    nearDown: '接近跌停',
};

/** 五檔（只讀價量；串流 Decimal 為字串） */
export interface BookSide {
    bid_price?: readonly (string | number)[];
    bid_volume?: readonly number[];
    ask_price?: readonly (string | number)[];
    ask_volume?: readonly number[];
}

type LimitContract = Parameters<typeof limitStateOf>[0];

/**
 * 報價與合約是否同一交易日：quoteRef（報價自身的參考價＝現價 − 漲跌）與合約參考價相差不到半個跳動。
 * 沒有 quoteRef（只有合約推得出的漲跌）或合約沒有參考價時視為同一天（沒有反證）。
 */
export function sameTradingDay(contract: Parameters<typeof tickSizeFor>[0] & { reference?: number }, quoteRef: number | null | undefined): boolean {
    const ref = Number(contract.reference);
    if (quoteRef === null || quoteRef === undefined || !Number.isFinite(quoteRef) || quoteRef <= 0) return true;
    if (!Number.isFinite(ref) || ref <= 0) return true;
    return Math.abs(quoteRef - ref) < tickSizeFor(contract, ref) / 2;
}

const numOf = (v: unknown): number => (v === undefined || v === null || v === '' ? NaN : Number(v));

/** 一側是否已空（沒有任何價格 > 0 且量 > 0 的檔位） */
function sideEmpty(prices: readonly (string | number)[] | undefined, volumes: readonly number[] | undefined): boolean {
    const n = Math.max(prices?.length ?? 0, volumes?.length ?? 0);
    for (let i = 0; i < n; i++) {
        if (numOf(prices?.[i]) > 0 && numOf(volumes?.[i]) > 0) return false;
    }
    return true;
}

/**
 * 第一個有價格（> 0）且有量的檔位價格。交易所以價格 0 揭示排隊中的市價單（例如鎖漲停時委買第 1 檔 0／3,350 張），
 * 市價單沒有價位，「最佳價」要從下一檔有價格的檔位算起。沒有回 null。
 */
function firstPricedLevel(prices: readonly (string | number)[] | undefined, volumes: readonly number[] | undefined): number | null {
    const n = Math.max(prices?.length ?? 0, volumes?.length ?? 0);
    for (let i = 0; i < n; i++) {
        const p = numOf(prices?.[i]);
        if (p > 0 && numOf(volumes?.[i]) > 0) return p;
    }
    return null;
}

/**
 * 價位在停板時是否「鎖住」：漲停＝最佳委買（第一個有價格的檔位，市價單不算）在漲停且委賣已空；跌停反之。
 * 沒有五檔資料、或五檔兩側都空（盤前、收盤後）時回傳 null（無法判斷）。
 */
export function limitLocked(contract: LimitContract, state: 'up' | 'down', book: BookSide | undefined): boolean | null {
    if (!book) return null;
    const bidEmpty = sideEmpty(book.bid_price, book.bid_volume);
    const askEmpty = sideEmpty(book.ask_price, book.ask_volume);
    if (bidEmpty && askEmpty) return null;
    if (state === 'up') {
        const best = firstPricedLevel(book.bid_price, book.bid_volume);
        return askEmpty && best !== null && limitStateOf(contract, best) === 'up';
    }
    const best = firstPricedLevel(book.ask_price, book.ask_volume);
    return bidEmpty && best !== null && limitStateOf(contract, best) === 'down';
}

/**
 * 漲跌停狀態：在停板（再以五檔判斷是否鎖住）或距停板 ≤ NEAR_LIMIT_PCT；其他（含沒有漲跌停的商品）回傳 null。
 * priceIsTrade：價格是成交或快照（參考價、指數不判斷）。
 */
export function limitKind(
    contract: LimitContract & { reference?: number; security_type?: SecurityType },
    price: number | null | undefined,
    priceIsTrade: boolean,
    book?: BookSide,
): LimitKind | null {
    if (!priceIsTrade || price === null || price === undefined || contract.security_type === 'OPT' || !hasPriceLimits(contract)) return null;
    const state = limitStateOf(contract, price);
    if (state) {
        const locked = limitLocked(contract, state, book);
        if (state === 'up') return locked === null ? 'up' : locked ? 'lockedUp' : 'openUp';
        return locked === null ? 'down' : locked ? 'lockedDown' : 'openDown';
    }
    const ref = Number(contract.reference);
    if (!Number.isFinite(ref) || ref <= 0 || !Number.isFinite(price) || price <= 0) return null;
    const toUp = ((Number(contract.limit_up) - price) / ref) * 100;
    const toDown = ((price - Number(contract.limit_down)) / ref) * 100;
    if (toUp >= 0 && toUp <= NEAR_LIMIT_PCT) return 'nearUp';
    if (toDown >= 0 && toDown <= NEAR_LIMIT_PCT) return 'nearDown';
    return null;
}

/** 停板狀態是否需要五檔判斷（在停板）：只有這時才讀完整報價（含五檔），其他時候資訊列不隨五檔重繪 */
export const limitNeedsBook = (kind: LimitKind | null): boolean => kind === 'up' || kind === 'down';

export function limitChip(kind: LimitKind | null): InfoChip | null {
    if (!kind) return null;
    const up = kind === 'up' || kind.endsWith('Up');
    const hit = kind !== 'nearUp' && kind !== 'nearDown';
    return { key: 'limit', text: LIMIT_TEXT[kind], tone: hit ? (up ? 'up' : 'down') : 'warn' };
}

// ---- 3. 日內振幅位置 ----

export interface RangeInput {
    reference: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
}

export interface RangeInfo {
    /** 振幅（％）＝（最高 − 最低）÷ 參考價 */
    amplitudePct: number;
    /** 現價在「最低到最高」之間的位置（0＝最低、1＝最高）；高低相同時為 null */
    position: number | null;
    /**
     * 小條的幾何（0–1，左到右）：
     * - 'rail'：以參考價（0.5）為中心的尺（lib/day-range），ends 為兩端的幅度（％）
     * - 'span'：整條＝最低到最高（選擇權、指數、沒有漲跌停）
     */
    bar: {
        mode: 'rail' | 'span';
        low: number;
        high: number;
        close: number;
        reference: number | null;
        ends: [number, number] | null;
        /** 現價相對開盤（lib/day-range dirVsOpen） */
        dir: 'up' | 'down' | null;
    };
}

const pos = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** rail＝false（報價與合約不是同一交易日）時不畫以參考價為中心的尺，一律畫最低到最高 */
export function rangeInfo(
    contract: Pick<ContractInfo, 'security_type' | 'exchange' | 'limit_up' | 'limit_down'> & { underlying_kind?: string },
    v: RangeInput,
    rail = true,
): RangeInfo | null {
    const { reference, open, high, low, close } = v;
    if (!pos(reference) || !pos(high) || !pos(low) || !pos(close) || low > high) return null;
    const amplitudePct = ((high - low) / reference) * 100;
    const position = high > low ? clamp01((close - low) / (high - low)) : null;
    const dir = pos(open) ? dirVsOpen(close, open) : null;
    const st = contract.security_type;
    if (rail && (st === 'STK' || st === 'FUT') && hasPriceLimits(contract) && pos(open)) {
        const r = dayRangeOf({ reference, limitUp: contract.limit_up, limitDown: contract.limit_down, open, high, low, close });
        if (r) {
            const scales = st === 'FUT' && contract.underlying_kind === 'I' ? INDEX_FUTURE_SCALES : STOCK_SCALES;
            const scale = railScale(r, scales);
            return {
                amplitudePct,
                position,
                bar: {
                    mode: 'rail',
                    low: railPos(r.low, r, scale),
                    high: railPos(r.high, r, scale),
                    close: railPos(r.close, r, scale),
                    reference: 0.5,
                    ends: railEndPcts(r, scale),
                    dir,
                },
            };
        }
    }
    return { amplitudePct, position, bar: { mode: 'span', low: 0, high: 1, close: position ?? 0.5, reference: null, ends: null, dir } };
}

export const fmtPct2 = (v: number) => `${v.toFixed(2)}%`;

export function rangeChip(info: RangeInfo | null): InfoChip | null {
    return info ? { key: 'range', text: `振幅 ${fmtPct2(info.amplitudePct)}`, tone: 'neutral' } : null;
}

/** 小條的文字等價（給輔助技術）：現價在今日最低到最高之間的位置 */
export function rangePositionText(info: RangeInfo): string {
    if (info.position === null) return '今日最高與最低相同';
    const p = Math.round(info.position * 100);
    const zone = p >= 80 ? '接近今日最高' : p <= 20 ? '接近今日最低' : '在今日區間中段';
    return `現價位於今日最低到最高的 ${p}%（${zone}）`;
}

// ---- 4. 量比 ----

export interface RatioInput {
    secType: SecurityType | undefined;
    /** 今日累計量（與標頭統計格同一來源） */
    totalVolume: number | null;
    /** 統計格的來源：成交時才需要比對快照日期 */
    source: 'tick' | 'index' | 'snapshot' | 'none';
    tickDate?: string;
    snapshot?: { datetime?: string; yesterday_volume?: number };
}

/** 量比（只有股票）；任一邊缺值、昨日量為 0、或快照與成交不是同一交易日時為 null */
export function volumeRatio({ secType, totalVolume, source, tickDate, snapshot }: RatioInput): number | null {
    if (secType !== 'STK' || totalVolume === null || (source !== 'tick' && source !== 'snapshot')) return null;
    if (source === 'tick' && ratioSnapshotStale(tickDate, snapshot?.datetime)) return null;
    return volumeRatioOf(totalVolume, snapshot?.yesterday_volume) ?? null;
}

export function ratioChip(ratio: number | null): InfoChip | null {
    return ratio === null ? null : { key: 'ratio', text: `量比 ${fmtVolumeRatio(ratio)}`, tone: 'neutral' };
}

// ---- 5. 處置 ----

export function punishChip(secType: SecurityType | undefined, punished: boolean | null): InfoChip | null {
    return secType === 'STK' && punished === true ? { key: 'punish', text: '處置股', tone: 'danger' } : null;
}

/** 資訊列與面板是否顯示信用相關（融資融券、券源、資券餘額、處置、現股當沖）：只有股票 */
export const showsCredit = (secType: SecurityType | undefined): boolean => secType === 'STK';

/** 依序排列（略過 null） */
export function infoChips(...chips: (InfoChip | null)[]): InfoChip[] {
    return chips.filter((c): c is InfoChip => c !== null);
}
