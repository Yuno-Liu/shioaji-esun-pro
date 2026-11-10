// src/mobile/lib/realized-rebate.ts — 已實現損益列的預估手續費退佣（轉接到共用核心 src/lib/realized-rebate）
//
// 估算邏輯、四捨五入與買賣拆分在 src/lib/realized-rebate.ts（桌面玉山明細共用）；這裡只從列／玉山成交明細取值：
// - 股數＝detail.shares 或 round(|quantity| × 1000)（永豐 quantity 為張，可能有小數）；
// - 平倉價金＝|detail.priceQty| 或 price × 股數；損益＝detail.realizedPnl 或列的 pnl；
// - 平倉是否為回補：有明細買賣別用 detail.action === 'Buy'，否則 cond === 'ShortSelling'；
// - 玉山成交明細的 fills 交給核心判斷平倉／開倉手續費是否用實收。
// 期貨列不計退佣（'na'）。

import { SHARES_PER_LOT } from '../../lib/odd-lot';
import type { EsunTransactionDetail } from '../../lib/esun';
import {
    emptyRealizedRebate,
    estimateRealizedRebate,
    type RealizedRebate,
    type RealizedRebateFill,
} from '../../lib/realized-rebate';
import type { TradingCostSettings } from '../../lib/trading-cost-settings';
import type { RealizedPnlRow } from './account-pnl';

export {
    realizedRebateSourceText,
    realizedRebateTotals,
    type RealizedRebate,
    type RealizedRebateStatus,
    type RealizedRebateTotals,
} from '../../lib/realized-rebate';

type DetailLike = Partial<Pick<EsunTransactionDetail, 'shares' | 'priceQty' | 'action' | 'realizedPnl'>> & { fills?: readonly RealizedRebateFill[] };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 一列已實現損益的預估退佣 */
export function realizedRowRebate(row: RealizedPnlRow, settings: TradingCostSettings, detail?: DetailLike | null): RealizedRebate {
    if (row.market !== 'S') return emptyRealizedRebate('na');

    const r = row as RealizedPnlRow & { price?: unknown; cond?: unknown };
    const shares = detail && finite(detail.shares) && detail.shares !== 0
        ? Math.round(Math.abs(detail.shares))
        : finite(r.quantity) ? Math.round(Math.abs(r.quantity) * SHARES_PER_LOT) : 0;
    const closeNotional = detail && finite(detail.priceQty) && detail.priceQty !== 0
        ? Math.abs(detail.priceQty)
        : finite(r.price) && r.price > 0 ? r.price * shares : 0;
    const cover = detail?.action === 'Buy' || detail?.action === 'Sell' ? detail.action === 'Buy' : r.cond === 'ShortSelling';
    const pnl = detail && finite(detail.realizedPnl) ? detail.realizedPnl : finite(r.pnl) ? r.pnl : null;

    return estimateRealizedRebate({ shares, closeNotional, pnl, cover, fills: detail?.fills }, settings);
}
