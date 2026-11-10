// src/mobile/lib/realized-rebate.ts — 已實現損益的預估手續費退佣（純函式）
//
// 退佣＝feeRebate(平倉手續費)＋feeRebate(開倉手續費)，只在月退且折數 < 1 時才有（hasMonthlyRebate）。
// 手續費來源：
// - 玉山列有成交明細（EsunTransactionDetail）時：平倉方向的逐筆 fee 都有值 → 用 Σfee（closeExact）；
//   fills 也含開倉方向（買賣兩側都有）且 fee 都有值 → 開倉也用 Σfee（openExact）；fill 沒有買賣別時當平倉側。
// - 其他情況以價金估算（交割收取額＝max(最低, 牌告 0.1425%)，同 stockFeeBreakdown(...).charged）：
//   股數拆整張／零股兩筆（各自最低手續費，價金依股數比例拆，同 position-pnl 的 splitShares）。
// 價金：股數＝detail.shares 或 round(|quantity| × 1000)（永豐 quantity 為張，可能有小數）；
//   平倉價金＝|detail.priceQty| 或 price × 股數；開倉價金估算＝多單「平倉價金 − 損益」、空單「平倉價金 ＋ 損益」
//   （損益已扣費稅，所以開倉價金是近似值）。平倉是否為回補：有明細用 detail.action === 'Buy'，否則 cond === 'ShortSelling'。
// 期貨列不計退佣（'na'）；股數或價金無法得知時不猜（'unknown'，不計入合計）。

import { SHARES_PER_LOT } from '../../lib/odd-lot';
import type { EsunTransactionDetail } from '../../lib/esun';
import { feeRebate, hasMonthlyRebate, stockFeeBreakdown, type TradingCostSettings } from '../../lib/trading-cost-settings';
import type { RealizedPnlRow } from './account-pnl';

export type RealizedRebateStatus = 'ok' | 'none' | 'unknown' | 'na';

export interface RealizedRebate {
    /** ok＝已估算；none＝設定沒有月退（成交即折或 10 折）；unknown＝缺股數或價金；na＝期貨 */
    status: RealizedRebateStatus;
    /** 預估退佣合計（元）；ok 以外為 null */
    rebate: number | null;
    /** 平倉手續費的退佣（元） */
    closeRebate: number | null;
    /** 開倉手續費的退佣（元） */
    openRebate: number | null;
    /** 平倉手續費（交割收取額，元） */
    closeFee: number | null;
    /** 開倉手續費（交割收取額，元） */
    openFee: number | null;
    /** 平倉手續費取自券商成交明細 */
    closeExact: boolean;
    /** 開倉手續費取自券商成交明細 */
    openExact: boolean;
}

type Fill = Pick<EsunTransactionDetail['fills'][number], 'action' | 'fee'>;

type DetailLike = Partial<Pick<EsunTransactionDetail, 'shares' | 'priceQty' | 'action' | 'realizedPnl'>> & { fills?: readonly Fill[] };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function empty(status: RealizedRebateStatus): RealizedRebate {
    return { status, rebate: null, closeRebate: null, openRebate: null, closeFee: null, openFee: null, closeExact: false, openExact: false };
}

/** 逐筆 fee 合計；沒有成交或任一筆缺值回 null */
function exactFee(fills: readonly Fill[]): number | null {
    if (!fills.length || fills.some(f => !finite(f.fee))) return null;
    return fills.reduce((s, f) => s + Math.abs(f.fee as number), 0);
}

/** 以價金估算交割收取的手續費：整張、零股各一筆（價金依股數比例拆） */
function estimatedFee(notionalCents: number, shares: number, settings: TradingCostSettings): number {
    const whole = Math.floor(shares / SHARES_PER_LOT) * SHARES_PER_LOT;
    const odd = shares - whole;
    const wholeCents = whole > 0 ? Math.min(notionalCents, Math.round((notionalCents * whole) / shares)) : 0;
    const oddCents = odd > 0 ? notionalCents - wholeCents : 0;
    return stockFeeBreakdown(wholeCents, { odd: false }, settings).charged
        + stockFeeBreakdown(oddCents, { odd: true }, settings).charged;
}

/** 一列已實現損益的預估退佣 */
export function realizedRowRebate(row: RealizedPnlRow, settings: TradingCostSettings, detail?: DetailLike | null): RealizedRebate {
    if (row.market !== 'S') return empty('na');
    if (!hasMonthlyRebate(settings)) return empty('none');

    const r = row as RealizedPnlRow & { price?: unknown; cond?: unknown };
    const shares = detail && finite(detail.shares) && detail.shares !== 0
        ? Math.round(Math.abs(detail.shares))
        : finite(r.quantity) ? Math.round(Math.abs(r.quantity) * SHARES_PER_LOT) : 0;
    if (!(shares > 0)) return empty('unknown');
    const closeNotional = detail && finite(detail.priceQty) && detail.priceQty !== 0
        ? Math.abs(detail.priceQty)
        : finite(r.price) && r.price > 0 ? r.price * shares : 0;
    if (!(closeNotional > 0)) return empty('unknown');

    const cover = detail?.action === 'Buy' || detail?.action === 'Sell' ? detail.action === 'Buy' : r.cond === 'ShortSelling';
    const closeAction = cover ? 'Buy' : 'Sell';
    const openAction = cover ? 'Sell' : 'Buy';
    const pnl = detail && finite(detail.realizedPnl) ? detail.realizedPnl : finite(r.pnl) ? r.pnl : null;

    const fills = detail?.fills ?? [];
    const closeExactFee = exactFee(fills.filter(f => f.action === closeAction || f.action === null || f.action === undefined));
    const openExactFee = exactFee(fills.filter(f => f.action === openAction));

    let openFee: number;
    if (openExactFee !== null) {
        openFee = openExactFee;
    } else {
        if (pnl === null) return empty('unknown');
        const openNotional = cover ? closeNotional + pnl : closeNotional - pnl;
        if (!(openNotional > 0)) return empty('unknown');
        openFee = estimatedFee(Math.round(openNotional * 100), shares, settings);
    }
    const closeFee = closeExactFee ?? estimatedFee(Math.round(closeNotional * 100), shares, settings);
    const closeRebate = feeRebate(closeFee, settings);
    const openRebate = feeRebate(openFee, settings);
    return {
        status: 'ok',
        rebate: closeRebate + openRebate,
        closeRebate,
        openRebate,
        closeFee,
        openFee,
        closeExact: closeExactFee !== null,
        openExact: openExactFee !== null,
    };
}

export interface RealizedRebateTotals {
    /** 'ok' 列的退佣合計（元） */
    rebate: number;
    /** 已估算（'ok'）的列數 */
    counted: number;
    /** 無法估算（'unknown'）的列數 */
    unknown: number;
    /** 有任何 'ok' 或 'unknown' 列（＝有股票列且設定為月退有折扣） */
    applies: boolean;
}

export function realizedRebateTotals(results: readonly RealizedRebate[]): RealizedRebateTotals {
    let rebate = 0;
    let counted = 0;
    let unknown = 0;
    for (const r of results) {
        if (r.status === 'ok') { rebate += r.rebate ?? 0; counted += 1; }
        else if (r.status === 'unknown') unknown += 1;
    }
    return { rebate, counted, unknown, applies: counted > 0 || unknown > 0 };
}
