// src/mobile/lib/chart-model.ts — 由交易狀態與合約資訊產生圖上的水平線、五檔標記、均線（規格 §6.2）
//
// 全部是純函式，不碰圖表 API，方便測試。圖表元件（trade-chart.tsx）只負責把 PriceLineSpec 畫出來。

import type { ContractInfo } from '../../lib/types/contract';
import type { Candle } from '../../lib/types/market';
import { ACTIVE_ORDER_STATUSES, type AccountedTrade } from '../../lib/types/order';
import type { AccountedPosition } from '../../lib/types/portfolio';
import { remainingWorkingOrderQuantity } from '../../lib/working-order-quantity';
import { formatNumber } from './num-format';

export type PriceLineKind = 'order-buy' | 'order-sell' | 'cost' | 'limit-up' | 'limit-down' | 'reference';

export interface PriceLineSpec {
    /** 穩定 key：同一筆委託更新時重用同一條線 */
    key: string;
    price: number;
    kind: PriceLineKind;
    /** 價格軸上的標籤文字 */
    label: string;
    /** 委託線才有：點擊時開啟委託操作面板 */
    tradeId?: string;
}

/** 線上標籤的價格格式：千分位、最多兩位小數（1080 → 1,080；1052.5 → 1,052.5） */
export function formatLinePrice(price: number): string {
    return formatNumber(Number(price.toFixed(2)), 'en-US', { maximumFractionDigits: 2 });
}

/** 委託單位是「股」（盤中零股、盤後零股） */
export function isOddLotOrder(t: Pick<AccountedTrade, 'order'>): boolean {
    return t.order.order_lot === 'IntradayOdd' || t.order.order_lot === 'Odd';
}

interface WorkingLimitOrder {
    trade: AccountedTrade;
    price: number;
    remaining: number;
}

/** 目前商品、仍在工作中、有剩餘量的限價委託（市價單沒有價位可畫） */
function workingLimitOrders(orderableCode: string, trades: readonly AccountedTrade[]): WorkingLimitOrder[] {
    const out: WorkingLimitOrder[] = [];
    for (const t of trades) {
        if ((t.contract.target_code || t.contract.code) !== orderableCode) continue;
        if (!ACTIVE_ORDER_STATUSES.has(t.status.status)) continue;
        if (t.order.price_type !== 'LMT') continue;
        const remaining = remainingWorkingOrderQuantity(t);
        if (remaining <= 0) continue;
        // 改價後以 modified_price 為準（與桌面 OrderEditor 相同）
        const price = t.status.modified_price || t.order.price;
        if (!Number.isFinite(price) || price <= 0) continue;
        out.push({ trade: t, price, remaining });
    }
    return out;
}

/**
 * 目前商品的未成交限價委託 → 委託線（市價、已無剩餘量者不畫）
 * orderableCode：目前商品實際下單的合約代碼。連續月別名（如 TXFR1）下單時會換成實際月份
 * （src/lib/shioaji.ts 的 orderableKey），所以呼叫端傳入 contract.target_code || contract.code。
 */
export function workingOrderLines(orderableCode: string, trades: readonly AccountedTrade[]): PriceLineSpec[] {
    return workingLimitOrders(orderableCode, trades).map(({ trade: t, price, remaining }) => {
        const buy = t.order.action === 'Buy';
        const unit = isOddLotOrder(t) ? '股' : '';
        return {
            key: `order:${t.order.id}`,
            price,
            kind: buy ? 'order-buy' : 'order-sell',
            label: `${buy ? '買' : '賣'} ${remaining}${unit} @${formatLinePrice(price)}`,
            tradeId: t.order.id,
        };
    });
}

/**
 * 持倉成本線：目前商品（以實際下單代碼比對；期貨持倉的代碼是實際月份）的均價，
 * 多空分開、各以數量加權。空單標「空單成本」。
 */
export function positionCostLines(orderableCode: string, positions: readonly AccountedPosition[]): PriceLineSpec[] {
    const sums = { Buy: { qty: 0, cost: 0 }, Sell: { qty: 0, cost: 0 } };
    for (const p of positions) {
        if (p.code !== orderableCode) continue;
        if (!(p.quantity > 0) || !(p.price > 0)) continue;
        const s = sums[p.direction === 'Sell' ? 'Sell' : 'Buy'];
        s.qty += p.quantity;
        s.cost += p.quantity * p.price;
    }
    const out: PriceLineSpec[] = [];
    for (const dir of ['Buy', 'Sell'] as const) {
        const s = sums[dir];
        if (s.qty <= 0) continue;
        const avg = s.cost / s.qty;
        out.push({
            key: `cost:${dir}`,
            price: avg,
            kind: 'cost',
            label: `${dir === 'Sell' ? '空單成本' : '成本'} ${formatLinePrice(avg)}`,
        });
    }
    return out;
}

type LimitContract = Pick<ContractInfo, 'security_type' | 'limit_up' | 'limit_down' | 'reference'>;

/** 漲停／跌停線：只有股票（期貨、選擇權、指數不畫） */
export function limitLines(contract: LimitContract): PriceLineSpec[] {
    if (contract.security_type !== 'STK') return [];
    const out: PriceLineSpec[] = [];
    if (contract.limit_up > 0) out.push({ key: 'limit-up', price: contract.limit_up, kind: 'limit-up', label: '漲停' });
    if (contract.limit_down > 0) out.push({ key: 'limit-down', price: contract.limit_down, kind: 'limit-down', label: '跌停' });
    return out;
}

/** 參考價（平盤）線 */
export function referenceLines(contract: Pick<ContractInfo, 'reference'>): PriceLineSpec[] {
    return contract.reference > 0 ? [{ key: 'reference', price: contract.reference, kind: 'reference', label: '參考' }] : [];
}

/** 圖上全部水平線：參考價、漲跌停（僅股票）、持倉成本、我的委託 */
export function chartPriceLines(input: {
    contract: LimitContract & Pick<ContractInfo, 'code' | 'target_code'>;
    trades: readonly AccountedTrade[];
    positions: readonly AccountedPosition[];
}): PriceLineSpec[] {
    const orderable = input.contract.target_code || input.contract.code;
    return [
        ...referenceLines(input.contract),
        ...limitLines(input.contract),
        ...positionCostLines(orderable, input.positions),
        ...workingOrderLines(orderable, input.trades),
    ];
}

/** 線條集合的穩定字串（作為 effect 依賴） */
export function priceLinesKey(lines: readonly PriceLineSpec[]): string {
    return lines.map(l => `${l.key}|${l.price}|${l.label}`).join(';');
}

// ---- 五檔價格梯上「我 買2」標記 ----

export interface DepthOrderMark {
    buy: number;
    sell: number;
}

/** 價位比對用的 key（五檔價格是字串，委託價是數字） */
export function priceKey(price: number | string): string {
    const n = Number(price);
    return Number.isFinite(n) ? n.toFixed(4) : '';
}

/**
 * 五檔上自己的未成交限價委託（依價位加總剩餘量）。
 * oddLot：五檔切到盤中零股時只算盤中零股（IntradayOdd）委託，整股五檔只算整股委託。
 * 整股、盤中零股、盤後零股是三個分開撮合的市場；盤後零股（'Odd'）沒有即時五檔，不標在任何一份五檔上。
 */
export function depthOrderMarks(orderableCode: string, trades: readonly AccountedTrade[], oddLot: boolean): Map<string, DepthOrderMark> {
    const marks = new Map<string, DepthOrderMark>();
    for (const { trade, price, remaining } of workingLimitOrders(orderableCode, trades)) {
        const lot = trade.order.order_lot;
        if (lot === 'Odd') continue;
        if ((lot === 'IntradayOdd') !== oddLot) continue;
        const k = priceKey(price);
        const m = marks.get(k) ?? { buy: 0, sell: 0 };
        if (trade.order.action === 'Buy') m.buy += remaining;
        else m.sell += remaining;
        marks.set(k, m);
    }
    return marks;
}

/** 「我 買2」「我 賣1」「我 買2 賣1」 */
export function depthMarkText(m: DepthOrderMark | undefined): string | null {
    if (!m || (m.buy <= 0 && m.sell <= 0)) return null;
    const parts: string[] = [];
    if (m.buy > 0) parts.push(`買${m.buy}`);
    if (m.sell > 0) parts.push(`賣${m.sell}`);
    return `我 ${parts.join(' ')}`;
}

// ---- 指標：MA ----

export interface LinePoint {
    time: number;
    value: number;
}

/** 收盤價簡單移動平均；前 period-1 根沒有值 */
export function movingAverage(candles: readonly Pick<Candle, 'time' | 'close'>[], period: number): LinePoint[] {
    const out: LinePoint[] = [];
    if (period <= 0) return out;
    let sum = 0;
    for (let i = 0; i < candles.length; i++) {
        sum += candles[i]!.close;
        if (i >= period) sum -= candles[i - period]!.close;
        if (i >= period - 1) out.push({ time: candles[i]!.time, value: Number((sum / period).toFixed(4)) });
    }
    return out;
}

/** 最後一根的 MA（即時更新用）；不足 period 根回傳 null */
export function lastMovingAverage(candles: readonly Pick<Candle, 'time' | 'close'>[], period: number): LinePoint | null {
    if (period <= 0 || candles.length < period) return null;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) sum += candles[i]!.close;
    return { time: candles[candles.length - 1]!.time, value: Number((sum / period).toFixed(4)) };
}

// ---- 走勢：均價線、當日最高最低 ----

/**
 * 走勢的均價線（由 1 分 K 估算）：累計（典型價 (H+L+C)/3 × 量）／累計量，與桌面 intraday-chart 相同。
 * 1 分 K 歷史沒有逐筆成交金額，所以是估算；即時成交有 avg_price 時由圖表改用交易所均價。
 * 量為 0 的開頭幾根沒有均價（不畫）。
 */
export function intradayAverage(candles: readonly Candle[]): LinePoint[] {
    const out: LinePoint[] = [];
    let cumV = 0;
    let cumPV = 0;
    for (const c of candles) {
        if (c.volume > 0) {
            cumV += c.volume;
            cumPV += ((c.high + c.low + c.close) / 3) * c.volume;
        }
        if (cumV > 0) out.push({ time: c.time, value: Number((cumPV / cumV).toFixed(4)) });
    }
    return out;
}

/** 走勢的當日最高、最低（K 棒的 high／low；沒有資料回傳 null） */
export function dayHighLow(candles: readonly Pick<Candle, 'high' | 'low'>[]): { high: number; low: number } | null {
    let high = -Infinity;
    let low = Infinity;
    for (const c of candles) {
        if (Number.isFinite(c.high) && c.high > 0) high = Math.max(high, c.high);
        if (Number.isFinite(c.low) && c.low > 0) low = Math.min(low, c.low);
    }
    return Number.isFinite(high) && Number.isFinite(low) ? { high, low } : null;
}

/** 圖例上的指標數值：千分位、固定小數位；沒有值顯示「—」 */
export function formatIndicatorValue(value: number | undefined | null, decimals: number): string {
    if (value === undefined || value === null || !Number.isFinite(value)) return '—';
    const d = Math.max(0, Math.min(6, Math.floor(decimals)));
    return formatNumber(value, 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ---- K 棒資料整形 ----

/**
 * 走勢：只留時段 (start, end + CLOSE_GRACE] 內的 1 分 K；收盤後定盤（grace 內）併入最後一根 label。
 * candles 必須已依時間排序（kbarsToCandles 已排序）。
 */
export function intradayBars(candles: readonly Candle[], win: { start: number; end: number }, closeGrace: number): Candle[] {
    const out: Candle[] = [];
    for (const c of candles) {
        if (c.time <= win.start || c.time > win.end + closeGrace) continue;
        const time = Math.min(c.time, win.end);
        const last = out[out.length - 1];
        if (last && last.time === time) {
            last.high = Math.max(last.high, c.high);
            last.low = Math.min(last.low, c.low);
            last.close = c.close;
            last.volume += c.volume;
        } else {
            out.push({ ...c, time });
        }
    }
    return out;
}

/**
 * 即時成交時間（牆鐘編碼秒）→ K 棒的 label。與 aggregate()／1 分 K 歷史同慣例（close-label-right）：
 * N 分 K 為 floor(t / N 分) × N 分 + N 分；日 K 為日曆日 00:00。
 */
export function liveBarTime(minutes: number, tickTime: number): number {
    if (minutes >= 1440) return Math.floor(tickTime / 86400) * 86400;
    const sec = minutes * 60;
    return Math.floor(tickTime / sec) * sec + sec;
}
