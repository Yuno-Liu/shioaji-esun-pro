// src/mobile/lib/order-fills.ts — 委託列與委託明細的成交資料（純函式；委託頁、委託明細、委託操作面板共用）
//
// - 成交均價：OrderStatusInfo 沒有均價欄位，同桌面 bottom-dock-orders.tsx 的 avgFillPrice 由 status.deals 加權平均回推；
//   沒有逐筆成交時回 null（不以委託價冒充均價）。
// - 成交進度：成交量 ÷（原始委託量 − 已取消量），同桌面 FillRing。減量累計在 cancel_quantity，不會改寫 order.quantity。
// - 委託類別徽章：價別、效期、倉別（期貨）、交易單位（零股等）、信用、當沖。
// - 逐筆成交清單：攤平所有委託的 status.deals，附委託資訊；逐筆合計量少於 deal_quantity 時另列「未提供逐筆明細」的差額。

import { esunAggregateDealSeq } from '../../lib/esun/order-mapping';
import { isOddLot, lotLabel, orderQtyUnit } from '../../lib/odd-lot';
import { octypeLabel, PRICE_TYPE_LABEL } from '../../lib/order-conditions';
import type { Deal, FuturesPriceType, Trade } from '../../lib/types/order';

function isFutures(trade: Pick<Trade, 'contract'>): boolean {
    const st = trade.contract.security_type;
    return st === 'FUT' || st === 'OPT';
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 逐筆成交（數量 > 0、價格有效） */
export function validDeals(trade: Trade): Deal[] {
    const deals = Array.isArray(trade.status.deals) ? trade.status.deals : [];
    return deals.filter(d => d && num(d.quantity) > 0 && num(d.price) > 0);
}

/** 成交均價（由 deals 加權）；沒有逐筆成交回 null */
export function avgFillPrice(trade: Trade): number | null {
    const deals = validDeals(trade);
    const qty = deals.reduce((s, d) => s + d.quantity, 0);
    if (qty <= 0) return null;
    return deals.reduce((s, d) => s + d.price * d.quantity, 0) / qty;
}

/** 均價顯示位數：整數價維持原格式，有小數時固定兩位（避免 ≥ 500 的價格被四捨五入成整數） */
export function avgPriceDigits(avg: number): number | undefined {
    return Number.isInteger(Math.round(avg * 1e6) / 1e6) ? undefined : 2;
}

export interface FillProgress {
    /** 已成交量 */
    filled: number;
    /** 有效委託量＝原始委託量 − 已取消量（減量後） */
    effective: number;
    /** 原始委託量（order.quantity，減量不改寫） */
    original: number;
    cancelled: number;
    /** 0–1 */
    ratio: number;
}

export function fillProgress(trade: Trade): FillProgress {
    const original = Math.max(0, num(trade.order.quantity));
    const cancelled = Math.max(0, num(trade.status.cancel_quantity));
    const filled = Math.max(0, num(trade.status.deal_quantity));
    const effective = Math.max(0, original - cancelled);
    const ratio = effective > 0 ? Math.min(1, filled / effective) : 0;
    return { filled, effective, original, cancelled, ratio };
}

export type OrderBadgeKind = 'price' | 'tif' | 'octype' | 'lot' | 'credit' | 'daytrade';
export interface OrderBadge {
    kind: OrderBadgeKind;
    label: string;
}

const CREDIT_LABEL: Record<string, string> = {
    MarginTrading: '融資',
    ShortSelling: '融券',
    SBLShort: '借券賣出',
    SBLShortPriceExempt: '借券賣出（豁免）',
};

/** 委託類別徽章（顯示順序：交易單位／倉別、信用、當沖、價別、效期） */
export function orderBadges(trade: Trade): OrderBadge[] {
    const o = trade.order;
    const out: OrderBadge[] = [];
    if (isFutures(trade)) {
        if (o.octype && o.octype !== 'Auto') {
            out.push(o.octype === 'DayTrade' ? { kind: 'daytrade', label: octypeLabel(o.octype) } : { kind: 'octype', label: octypeLabel(o.octype) });
        }
    } else {
        out.push({ kind: 'lot', label: lotLabel(o.order_lot || 'Common') });
        if (o.order_cond && CREDIT_LABEL[o.order_cond]) out.push({ kind: 'credit', label: CREDIT_LABEL[o.order_cond]! });
        if (o.daytrade_short) out.push({ kind: 'daytrade', label: '當沖先賣' });
    }
    const pt = (o.price_type ?? 'LMT') as FuturesPriceType;
    out.push({ kind: 'price', label: PRICE_TYPE_LABEL[pt] ?? String(pt) });
    if (o.order_type) out.push({ kind: 'tif', label: o.order_type });
    return out;
}

/** 玉山彙總成交（快照已含、沒有逐筆序號）；時間是委託時間而非成交時間 */
export function isAggregateDeal(trade: Trade, deal: Pick<Deal, 'seq'>): boolean {
    return deal.seq === esunAggregateDealSeq(trade.order.id);
}

/** 逐筆合計量少於 deal_quantity 的差額（券商只回總量、沒有逐筆明細） */
export function missingDealQuantity(trade: Trade): number {
    const listed = validDeals(trade).reduce((s, d) => s + d.quantity, 0);
    return Math.max(0, num(trade.status.deal_quantity) - listed);
}

/** 成交時間軸：時間由舊到新（沒有時間的排最後，同時間保持原順序） */
export function dealTimeline(trade: Trade): Deal[] {
    return validDeals(trade)
        .map((d, i) => ({ d, i }))
        .sort((a, b) => {
            const ta = num(a.d.ts) > 0 ? a.d.ts : Infinity;
            const tb = num(b.d.ts) > 0 ? b.d.ts : Infinity;
            return ta === tb ? a.i - b.i : ta - tb;
        })
        .map(x => x.d);
}

export interface DealRow {
    key: string;
    trade: Trade;
    /** null＝券商未提供逐筆明細的差額 */
    deal: Deal | null;
    price: number | null;
    quantity: number;
    ts: number;
    unit: string;
    aggregate: boolean;
}

/** 所有委託的逐筆成交，最新在前（沒有時間的排最後） */
export function collectDealRows(trades: readonly Trade[]): DealRow[] {
    const rows: DealRow[] = [];
    for (const trade of trades) {
        const unit = orderQtyUnit(isFutures(trade), trade.order.order_lot);
        validDeals(trade).forEach((deal, i) => {
            rows.push({
                key: `${trade.order.id}|${deal.seq || i}|${i}`,
                trade,
                deal,
                price: deal.price,
                quantity: deal.quantity,
                ts: num(deal.ts),
                unit,
                aggregate: isAggregateDeal(trade, deal),
            });
        });
        const missing = missingDealQuantity(trade);
        if (missing > 0) {
            rows.push({ key: `${trade.order.id}|missing`, trade, deal: null, price: null, quantity: missing, ts: 0, unit, aggregate: true });
        }
    }
    return rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => {
            const ta = a.r.ts > 0 ? a.r.ts : -Infinity;
            const tb = b.r.ts > 0 ? b.r.ts : -Infinity;
            return ta === tb ? a.i - b.i : tb - ta;
        })
        .map(x => x.r);
}

export interface SideTotals {
    /** 筆數 */
    count: number;
    /** 依單位分開的數量（張、股、口不可相加） */
    quantities: Record<string, number>;
    /** 股票成交金額（元；價格未知的差額列不計） */
    stockAmount: number;
}

export interface DealTotals {
    count: number;
    Buy: SideTotals;
    Sell: SideTotals;
    /** 有期貨／選擇權成交（金額不計，需契約乘數） */
    hasDerivatives: boolean;
    /** 有價格未知的差額列（金額不完整） */
    amountIncomplete: boolean;
}

const emptySide = (): SideTotals => ({ count: 0, quantities: {}, stockAmount: 0 });

export function dealTotals(rows: readonly DealRow[]): DealTotals {
    const totals: DealTotals = { count: 0, Buy: emptySide(), Sell: emptySide(), hasDerivatives: false, amountIncomplete: false };
    for (const r of rows) {
        const side = totals[r.trade.order.action === 'Sell' ? 'Sell' : 'Buy'];
        totals.count += 1;
        side.count += 1;
        side.quantities[r.unit] = (side.quantities[r.unit] ?? 0) + r.quantity;
        if (isFutures(r.trade)) {
            totals.hasDerivatives = true;
        } else if (r.price === null) {
            totals.amountIncomplete = true;
        } else {
            side.stockAmount += r.price * r.quantity * (isOddLot(r.trade.order.order_lot) ? 1 : 1000);
        }
    }
    return totals;
}

/** 「3 張、200 股」；沒有時回「0」 */
export function quantitiesText(quantities: Record<string, number>, fmt: (n: number) => string): string {
    const order = ['張', '股', '口'];
    const keys = Object.keys(quantities).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const parts = keys.filter(k => quantities[k]! > 0).map(k => `${fmt(quantities[k]!)} ${k}`);
    return parts.length ? parts.join('、') : '0';
}

/** 玉山中繼資料可否刪的說明（刪單一律提供，這裡只是券商提示） */
export function esunCancellableText(cancellable: boolean | null): string {
    if (cancellable === true) return '券商標示可刪';
    if (cancellable === false) return '券商標示不可刪（仍可嘗試刪單，以回讀結果為準）';
    return '券商未提供';
}
