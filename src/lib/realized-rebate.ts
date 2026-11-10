// src/lib/realized-rebate.ts — 已實現損益的預估手續費退佣（fork 模組）
//
// 手機版已實現損益（src/mobile/lib/realized-rebate 轉接）與桌面玉山已實現損益明細（components/esun-pnl-details）共用。
// 退佣＝feeRebate(平倉手續費)＋feeRebate(開倉手續費)，只在月退且折數 < 1 時才有（hasMonthlyRebate）。
// 手續費來源：
// - 成交明細（fills）裡平倉方向的逐筆 fee 都有值 → 用 Σfee（closeExact）；fill 沒有買賣別時當平倉側。
//   fills 也含開倉方向（買賣兩側都有）且 fee 都有值 → 開倉也用 Σfee（openExact）。
// - 其他情況以價金估算（交割收取額＝max(最低, 牌告 0.1425%)，同 stockFeeBreakdown(...).charged）：
//   股數拆整張／零股兩筆（各自最低手續費，價金依股數比例拆，同 position-pnl 的 splitShares）。
// 開倉價金估算＝多單「平倉價金 − 損益」、空單回補「平倉價金 ＋ 損益」（損益已扣費稅，所以是近似值）。
// 買賣拆分：多單 買＝開倉、賣＝平倉；空單回補 買＝平倉（回補）、賣＝開倉（融券賣出）。
// 股數或價金無法得知、需估開倉卻沒有損益時不猜（'unknown'，不計入合計）。

import { SHARES_PER_LOT } from './odd-lot';
import { feeRebate, hasMonthlyRebate, stockFeeBreakdown, type TradingCostSettings } from './trading-cost-settings';

/** ok＝已估算；none＝設定沒有月退（成交即折或 10 折）；unknown＝缺股數或價金；na＝不適用（期貨，由呼叫端給） */
export type RealizedRebateStatus = 'ok' | 'none' | 'unknown' | 'na';

export interface RealizedRebate {
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
    /** 買進手續費的退佣（元）：多單＝開倉、空單回補＝平倉 */
    buyRebate: number | null;
    /** 賣出手續費的退佣（元）：多單＝平倉、空單回補＝開倉 */
    sellRebate: number | null;
}

export interface RealizedRebateFill {
    action: 'Buy' | 'Sell' | null | undefined;
    fee: number | null | undefined;
}

export interface RealizedRebateInput {
    /** 股數 */
    shares: number;
    /** 平倉價金（元） */
    closeNotional: number;
    /** 已實現損益（元）；null＝未知（只在需要估算開倉價金時才必要） */
    pnl: number | null;
    /** 平倉為空單回補（買進） */
    cover: boolean;
    /** 券商逐筆成交（玉山 mat_dats）；沒有時全部以價金估算 */
    fills?: readonly RealizedRebateFill[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function emptyRealizedRebate(status: RealizedRebateStatus): RealizedRebate {
    return {
        status, rebate: null, closeRebate: null, openRebate: null, closeFee: null, openFee: null, closeExact: false, openExact: false,
        buyRebate: null, sellRebate: null,
    };
}

/** 逐筆 fee 合計；沒有成交或任一筆缺值回 null */
function exactFee(fills: readonly RealizedRebateFill[]): number | null {
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

/** 一筆已實現損益（股票）的預估退佣 */
export function estimateRealizedRebate(input: RealizedRebateInput, settings: TradingCostSettings): RealizedRebate {
    if (!hasMonthlyRebate(settings)) return emptyRealizedRebate('none');
    const shares = finite(input.shares) ? Math.round(Math.abs(input.shares)) : 0;
    if (!(shares > 0)) return emptyRealizedRebate('unknown');
    const closeNotional = finite(input.closeNotional) ? Math.abs(input.closeNotional) : 0;
    if (!(closeNotional > 0)) return emptyRealizedRebate('unknown');

    const { cover } = input;
    const closeAction = cover ? 'Buy' : 'Sell';
    const openAction = cover ? 'Sell' : 'Buy';
    const pnl = finite(input.pnl) ? input.pnl : null;

    const fills = input.fills ?? [];
    const closeExactFee = exactFee(fills.filter(f => f.action === closeAction || f.action === null || f.action === undefined));
    const openExactFee = exactFee(fills.filter(f => f.action === openAction));

    let openFee: number;
    if (openExactFee !== null) {
        openFee = openExactFee;
    } else {
        if (pnl === null) return emptyRealizedRebate('unknown');
        const openNotional = cover ? closeNotional + pnl : closeNotional - pnl;
        if (!(openNotional > 0)) return emptyRealizedRebate('unknown');
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
        buyRebate: cover ? closeRebate : openRebate,
        sellRebate: cover ? openRebate : closeRebate,
    };
}

/**
 * 手續費來源說明（ok 以外回 null）。例：一般賣出「賣出手續費依成交明細，買進手續費以價金估算（明細未列）。」；
 * 空單回補用「回補（買進）」「開倉賣出」。
 */
export function realizedRebateSourceText(r: RealizedRebate, cover: boolean): string | null {
    if (r.status !== 'ok') return null;
    const close = cover ? '回補（買進）' : '賣出';
    const open = cover ? '開倉賣出' : '買進';
    if (r.closeExact && r.openExact) return `${close}、${open}手續費皆依成交明細。`;
    if (r.closeExact) return `${close}手續費依成交明細，${open}手續費以價金估算（明細未列）。`;
    if (r.openExact) return `${open}手續費依成交明細，${close}手續費以價金估算（明細未列）。`;
    return `${close}、${open}手續費皆以價金估算（明細未列手續費）。`;
}

export interface RealizedRebateTotals {
    /** 'ok' 列的退佣合計（元） */
    rebate: number;
    /** 'ok' 列的買進退佣合計（元） */
    buy: number;
    /** 'ok' 列的賣出退佣合計（元） */
    sell: number;
    /** 已估算（'ok'）的列數 */
    counted: number;
    /** 無法估算（'unknown'）的列數 */
    unknown: number;
    /** 有任何 'ok' 或 'unknown' 列（＝有股票列且設定為月退有折扣） */
    applies: boolean;
}

export function realizedRebateTotals(results: readonly RealizedRebate[]): RealizedRebateTotals {
    let rebate = 0;
    let buy = 0;
    let sell = 0;
    let counted = 0;
    let unknown = 0;
    for (const r of results) {
        if (r.status === 'ok') {
            rebate += r.rebate ?? 0;
            buy += r.buyRebate ?? 0;
            sell += r.sellRebate ?? 0;
            counted += 1;
        } else if (r.status === 'unknown') unknown += 1;
    }
    return { rebate, buy, sell, counted, unknown, applies: counted > 0 || unknown > 0 };
}
