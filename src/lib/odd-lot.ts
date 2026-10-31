// src/lib/odd-lot.ts — 零股（盤中零股 IntradayOdd／盤後零股 Odd）共用規則（#204）
//
// 下單面板、閃電下單、鋪單、括號單與觸價單共用同一份規則：
// - 數量以「股」計，1～999 股；1,000 股以上請改用整股（張）。
// - 只接受限價（LMT）＋當日有效（ROD）；沒有市價單。需要「市價」效果的
//   自動出場改以漲跌停價送限價單（與持倉股數平倉相同做法）。
// - 只能現股：不能融資、融券、借券賣出，也不能現股當沖先賣。
// - 價格跳動點與漲跌幅同整股（交易所同一套升降單位）。
//
// placeStockOrder 送出前一律再檢查一次（stockOrderProblem），任何路徑
// 組出不支援的組合都在送出前擋下，並以白話說明原因。

import type { StockOrderCond, StockOrderLot } from './types/order';

export const ODD_LOT_MAX_SHARES = 999;

/** 盤中零股委託不能改價，只能減量（Shioaji ORDERS：IntradayOdd orders
 * cannot update price, only reduce quantity）。盤後零股同樣一次撮合，不提供改價。 */
export const ODD_LOT_NO_PRICE_UPDATE = '零股委託不能改價，只能減量或刪單';

export function canUpdateOrderPrice(order: { order_lot?: string | null; price_type?: string | null }): boolean {
    return !isOddLot(order.order_lot) && (order.price_type ?? 'LMT') === 'LMT';
}
export const SHARES_PER_LOT = 1000;

export function isOddLot(lot: StockOrderLot | string | undefined | null): boolean {
    return lot === 'IntradayOdd' || lot === 'Odd';
}

/** 股票數量單位：零股以「股」、其他以「張」 */
export function stockQtyUnit(lot: StockOrderLot | string | undefined | null): '股' | '張' {
    return isOddLot(lot) ? '股' : '張';
}

/** 委託數量單位（期貨／選擇權一律「口」） */
export function orderQtyUnit(isFutures: boolean, lot?: StockOrderLot | string | null): string {
    return isFutures ? '口' : stockQtyUnit(lot);
}

/** 面板與委託列使用的交易單位名稱 */
export const LOT_LABEL: Record<StockOrderLot, string> = {
    Common: '整股',
    IntradayOdd: '盤中零股',
    Odd: '盤後零股',
    Fixing: '定盤',
    BlockTrade: '鉅額',
};

export function lotLabel(lot: string | undefined | null): string {
    return (lot && LOT_LABEL[lot as StockOrderLot]) || lot || '';
}

export interface StockOrderShape {
    quantity: number;
    price_type?: string;
    order_type?: string;
    order_lot?: StockOrderLot | string;
    order_cond?: StockOrderCond | string;
    daytrade_short?: boolean;
    /** 委託方向（信用規則：借券類只能賣、當沖先賣只能賣；融券可買（回補）可賣） */
    action?: 'Buy' | 'Sell' | string;
    /** 合約的可當沖別（contract.day_trade）；當沖先賣只限 'Yes' */
    day_trade?: string;
}

export const ODD_LOT_TEXT = {
    cond: '零股只能以現股買賣，不能融資、融券或借券賣出；請改用整股，或把信用條件改回現股',
    daytrade: '零股不能現股當沖先賣；請改用整股，或取消當沖',
    priceType: '零股只接受限價委託，沒有市價單；請輸入價格或直接點價位下單',
    orderType: '零股只接受當日有效（ROD）委託，不能用 IOC／FOK',
    quantity: `零股數量須為 1～${ODD_LOT_MAX_SHARES} 股；1,000 股以上請改用整股（張）`,
} as const;

// 整股信用規則（照下單面板現行規則，閃電下單共用）：
// - 融券可買可賣（融券買進＝回補，fork 修正）；借券、借券豁免只在賣出。
// - 現股當沖先賣只限「賣出＋整股＋現股＋contract.day_trade === 'Yes'」。
export const CREDIT_TEXT = {
    shortBuy: '借券、借券豁免只能賣出；回補融券空單請用「融券」買進，其他買進請改用現股或融資',
    daytradeSide: '現股當沖先賣只能用在賣出',
    daytradeCond: '現股當沖先賣只限現股；請把信用條件改回現股，或取消當沖',
    daytradeStock: '此股票不能現股當沖先賣（只能先買後賣或不可當沖）；請取消當沖',
    daytradeLot: '現股當沖先賣只限整股；請改用整股，或取消當沖',
} as const;

/** 信用條件寫進動作名稱（融資買進／融券賣出／現沖賣出）；現股回 undefined */
export type CreditLabel = '融資' | '融券' | '借券' | '借券豁免' | '現沖';
export function creditLabel(action: 'Buy' | 'Sell', orderCond?: StockOrderCond | string, daytradeShort?: boolean): CreditLabel | undefined {
    if (orderCond === 'MarginTrading') return '融資';
    if (orderCond === 'ShortSelling') return '融券';
    if (orderCond === 'SBLShort') return '借券';
    if (orderCond === 'SBLShortPriceExempt') return '借券豁免';
    if ((!orderCond || orderCond === 'Cash') && daytradeShort && action === 'Sell') return '現沖';
    return undefined;
}

const SELL_ONLY_CONDS: ReadonlySet<string> = new Set(['SBLShort', 'SBLShortPriceExempt']);

function creditProblem(o: StockOrderShape): string | null {
    if (o.action === 'Buy' && o.order_cond && SELL_ONLY_CONDS.has(o.order_cond)) return CREDIT_TEXT.shortBuy;
    if (o.daytrade_short) {
        if (o.action !== undefined && o.action !== 'Sell') return CREDIT_TEXT.daytradeSide;
        if (o.order_lot !== undefined && o.order_lot !== 'Common') return CREDIT_TEXT.daytradeLot;
        if (o.order_cond && o.order_cond !== 'Cash') return CREDIT_TEXT.daytradeCond;
        if (o.day_trade !== 'Yes') return CREDIT_TEXT.daytradeStock;
    }
    return null;
}

/** 不支援的條件組合（零股規則＋整股信用規則）→ 白話原因；支援回 null。 */
export function stockOrderProblem(o: StockOrderShape): string | null {
    if (!isOddLot(o.order_lot)) return creditProblem(o);
    if (o.order_cond && o.order_cond !== 'Cash') return ODD_LOT_TEXT.cond;
    if (o.daytrade_short) return ODD_LOT_TEXT.daytrade;
    if (o.price_type !== undefined && o.price_type !== 'LMT') return ODD_LOT_TEXT.priceType;
    if (o.order_type !== undefined && o.order_type !== 'ROD') return ODD_LOT_TEXT.orderType;
    if (!Number.isSafeInteger(o.quantity) || o.quantity < 1 || o.quantity > ODD_LOT_MAX_SHARES) return ODD_LOT_TEXT.quantity;
    return null;
}

/** 風控單筆上限以「張／口」設定；零股換算為張（500 股 = 0.5 張）比較。 */
export function riskLots(quantity: number, lot?: StockOrderLot | string | null): number {
    return isOddLot(lot) ? quantity / SHARES_PER_LOT : quantity;
}

/** 股數 → 指定單位的數量（整股取整張，零股即股數） */
export function sharesToUnits(shares: number, lot?: StockOrderLot | string | null): number {
    return isOddLot(lot) ? shares : Math.floor(shares / SHARES_PER_LOT);
}

/** 指定單位的數量 → 股數 */
export function unitsToShares(quantity: number, lot?: StockOrderLot | string | null): number {
    return isOddLot(lot) ? quantity : quantity * SHARES_PER_LOT;
}

/** 零股沒有市價單：需要立即成交的自動出場以漲跌停價送限價
 *（賣→跌停、買→漲停），價格無效回 null（呼叫端不得送出）。 */
export function oddLotMarketablePrice(
    contract: { limit_up?: number; limit_down?: number },
    action: 'Buy' | 'Sell',
): number | null {
    const p = action === 'Sell' ? contract.limit_down : contract.limit_up;
    return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

/** 數量輸入的上下限（依交易單位） */
export function clampLotQuantity(v: number, lot: StockOrderLot | string | undefined | null, max = Infinity): number {
    const upper = isOddLot(lot) ? Math.min(max, ODD_LOT_MAX_SHARES) : max;
    return Math.max(1, Math.min(upper, Math.trunc(v)));
}

/** 零股行情來源的最小形狀（stream QuoteState 相容） */
export interface OddBaseQuote {
    tick?: { close: string | number };
    bidask?: { bid_price: (string | number)[]; ask_price: (string | number)[] };
}

/** 盤中零股的參考價只看零股行情（#204）：零股成交價；沒有成交時取零股最佳
 * 買賣中價（依跳動點取整，只有一邊就用那一邊）；都沒有回 null（等待零股
 * 行情）— 絕不退回整股價格。 */
export function oddLotReferencePrice(oddQuote: OddBaseQuote | undefined, round: (p: number) => number): number | null {
    if (oddQuote?.tick && Number(oddQuote.tick.close) > 0) return Number(oddQuote.tick.close);
    const bid = Number(oddQuote?.bidask?.bid_price?.[0]);
    const ask = Number(oddQuote?.bidask?.ask_price?.[0]);
    const okBid = Number.isFinite(bid) && bid > 0;
    const okAsk = Number.isFinite(ask) && ask > 0;
    if (okBid && okAsk) return round((bid + ask) / 2);
    if (okBid) return bid;
    if (okAsk) return ask;
    return null;
}

export const ODD_LOT_WAITING = '等待零股行情';
