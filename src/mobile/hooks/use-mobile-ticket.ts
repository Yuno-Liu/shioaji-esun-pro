// src/mobile/hooks/use-mobile-ticket.ts — 下單面板的欄位狀態、即時驗證與送出（規格 §6.3、§7.1、§7.2）
//
// - 帳戶在開啟時以 captureSelectedAccount(market) 固定（面板顯示的就是送單帳戶）。
// - 價格只在開啟時帶入一次，之後不自動跟價；ResumeGate 的 resumeSeq 改變時標示「價格可能過期」，
//   需重新點快捷價、手動修改或按「使用此價格」確認才可預覽。ResumeGate 不是 ready 時自動帶入的價格、
//   以及同步中／失敗時的確認，一律記為未確認（PRICE_UNCONFIRMED），回到可下單狀態後仍須使用者重新確認。
// - 帶入價與即時價：真實成交（排除試撮 simtrade tick；試撮時沿用上一筆真實成交）→ 市場快照收盤 → 參考價，
//   面板標示價格來源。開啟時只有參考價（或沒有價格）時，第一筆真實成交或快照到達時補帶一次
//   （使用者已動過價格就不帶）；之後不再跟價。
// - 盤中零股（#204）：即時價與「成交」快捷價只看零股行情（oddLotMarketPrice），沒有零股行情時停用「成交」；
//   不以整股成交／快照補帶；切到盤中零股時自動帶入的價格清空（使用者輸入或確認過的保留）。
// - 即時驗證依 §6.3 的 1～7 順序（ticketProblem），回傳第一個原因；有原因就停用「預覽並確認委託」。
// - 送出一律呼叫 submitMobileOrder()（lib/mobile-order.ts）；結果依 §7.2 分四類處理，結果未知不提供重送。
// - 單位：整股、盤中零股（IntradayOdd）、盤後零股（Odd）；信用：現股、融資、融券（借券類不提供，§12）；
//   現股當沖先賣只限「賣出＋整股＋現股＋contract.day_trade === 'Yes'」。規則比照桌面 src/components/order-ticket.tsx：
//   切換買賣不改信用條件；openTicket 帶入的 lot／cond／daytradeShort 只在開啟時帶入一次，不合規則時保留並顯示原因。
//   驗證用「使用者的意圖」（含現股與勾選的當沖）；實際送出只在非現股時送 order_cond、只在可送時送 daytrade_short。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSnapshotBaseline } from '../../hooks/use-display-book';
import { useOrderContext } from '../../hooks/use-order-context';
import { useQuote, useTradingLive } from '../../hooks/use-stream';
import { useAccounts } from '../../lib/account-store';
import { canTrade } from '../../lib/account-tradable';
import { isEsunAccount } from '../../lib/esun';
import { accountMatches } from '../../lib/flash-account';
import { creditLabel, isOddLot, ODD_LOT_MAX_SHARES, oddLotReferencePrice, orderQtyUnit, SHARES_PER_LOT, stockOrderProblem, type OddBaseQuote } from '../../lib/odd-lot';
import { captureSelectedAccount } from '../../lib/order-account';
import { defaultOrderTypeFor, futuresOrderProblem, orderTypeDisabledReason, PRICE_TYPE_LABEL, priceTypeDisabledReason } from '../../lib/order-conditions';
import { reconcileAfterUnknownOutcome } from '../../lib/order-outcome';
import { esunStockLegProblem } from '../../lib/order-route';
import { orderStatusWithNumber } from '../../lib/order-status-label';
import { checkOrderAllowed, useRiskSettings } from '../../lib/risk';
import { notify, OrderConfirmCancelled } from '../../lib/trade';
import type { ContractInfo } from '../../lib/types/contract';
import type { Snapshot } from '../../lib/types/market';
import type { Action, FuturesOCType, FuturesPriceType, OrderType, StockOrderReq } from '../../lib/types/order';
import type { Account } from '../../lib/types/portfolio';
import { contractMultiplier } from '../../lib/utils/contract-cost';
import { roundToTick, stepPrice } from '../../lib/utils/ticksize';
import { useOrderRoute } from '../components/route-badge';
import { isNotStarted } from '../lib/errors';
import { submitMobileOrder } from '../lib/mobile-order';
import type { MobileOrderInput } from '../lib/mobile-order-types';
import { closeTicket, getMobileUi, type TicketCond, type TicketLot, type TicketRequest } from '../lib/mobile-store';
import { acknowledgeStaleData, assertResumeReady, getResumeGate, retryResume, type ResumeGateSnapshot } from '../lib/resume-gate-runtime';
import { useResumeGate } from './use-resume-gate';

// 單位與信用條件的型別只有一份（lib/mobile-store.ts），這裡轉出方便元件取用
export type { TicketCond, TicketLot } from '../lib/mobile-store';

export interface TicketFields {
    /** null＝尚未選擇買賣（例如五檔價位只帶價） */
    action: Action | null;
    /** 股票只用 LMT／MKT；期權另有 MKP */
    priceType: FuturesPriceType;
    orderType: OrderType;
    /** 期權不使用（固定 Common） */
    orderLot: TicketLot;
    /** 股票信用條件（期權不使用，固定 Cash）；只限整股，零股只能現股 */
    orderCond: TicketCond;
    /** 現股當沖先賣（勾選）；只在 賣出＋整股＋現股＋可當沖 時有效 */
    daytradeShort: boolean;
    /** 只有期權使用 */
    octype: FuturesOCType;
    /** 價格輸入框的原始文字 */
    priceText: string;
    /** 整股為張、零股為股、期權為口；0 或非整數＝無效（顯示原因） */
    quantity: number;
}

/** 數量快捷鍵：整股（張）與期權（口）；零股以股計另用一組 */
export const QTY_PRESETS: readonly number[] = [1, 2, 5, 10];
export const ODD_QTY_PRESETS: readonly number[] = [10, 50, 100, 500];
/** 玉山整股單筆上限（張）；永豐由券商端檢查。這裡只作輸入上限，規則判斷仍以 esunStockLegProblem 為準 */
export const COMMON_LOT_INPUT_MAX = 499;

export const OUTCOME_UNKNOWN_TITLE = '結果未知：請到委託頁按『更新』核對，勿重送';
/** 面板已關閉時「未送出」改以通知告知的標題 */
export const NOT_SENT_TITLE = '委託未送出';

export const TICKET_TEXT = {
    unsupported: '這個商品無法下單',
    noAction: '請選擇買進或賣出',
    noStockAccount: '沒有可交易的證券帳戶，請先到「帳戶」頁選擇',
    noFuturesAccount: '沒有可交易的永豐期貨帳戶（玉山證券不支援期貨交易）',
    esunFutures: '玉山證券不支援期貨交易',
    marketMismatch: '帳戶市場與商品不符，請關閉面板後重新選擇帳戶',
    notTradable: '這個帳戶目前不可交易（未簽署）',
    accountChanged: '帳戶已變更，請關閉面板後重新開啟',
    quantity: '數量須為正整數',
    priceRequired: '限價單需要有效價格',
    priceTick: '價格不符合升降單位',
    priceRange: '價格超出漲跌停範圍',
    priceStale: '價格可能過期：請重新點選快捷價，或按「使用此價格」確認',
    notLive: '行情／交易連線未就緒，暫停下單',
    resyncing: '回到前景後正在重新同步行情與委託，請稍候',
    staleData: '委託／持倉資料可能過期：請勾選「我了解委託／持倉資料可能過期」或按「重試」',
    failed: '連線未恢復，請重新整理頁面',
    envUnknown: '送單環境未確認（模擬／正式），暫停下單',
    afterHoursCommon: '盤後定價交易不提供；盤後請改用零股（盤後零股）',
    oddCreditOnly: '零股只能現股（不可融資券、不可當沖）',
    oddAfterSession: '盤後零股 13:40–14:30 收單，14:30 一次撮合（沒有即時五檔）',
} as const;

/** 信用條件文字（買進時融券＝回補） */
export function condLabel(cond: TicketCond, action: Action | null): string {
    if (cond === 'MarginTrading') return '融資';
    if (cond === 'ShortSelling') return action === 'Buy' ? '融券（回補）' : '融券';
    return '現股';
}

// ---- 純函式（元件與測試共用）----

export function isFuturesContract(contract: Pick<ContractInfo, 'security_type'>): boolean {
    return contract.security_type === 'FUT' || contract.security_type === 'OPT';
}

/** 指數等沒有委託的商品 */
export function isTradableContract(contract: Pick<ContractInfo, 'security_type'>): boolean {
    return contract.security_type === 'STK' || contract.security_type === 'WRT' || isFuturesContract(contract);
}

/** 正數才回傳（行情的空字串、0、NaN 都視為沒有） */
export function positivePrice(v: string | number | null | undefined): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** 價格輸入框文字 → 數字；空白或無法解析回 NaN */
export function parsePrice(text: string): number {
    const t = text.replace(/,/g, '').trim();
    if (!t) return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
}

/** 真實成交價：試撮（simtrade）tick 的揭示價不是成交，一律不算 */
export function realTradePrice(tick: { close?: string | number | null; simtrade?: boolean } | null | undefined): number | null {
    if (!tick || tick.simtrade) return null;
    return positivePrice(tick.close);
}

/**
 * 價格來源：ticket＝開啟時帶入（例如五檔）、trade＝真實成交、snapshot＝市場快照收盤、reference＝參考價、
 * oddQuote＝盤中零股沒有成交時的零股委買／委賣（中價或單邊，oddLotReferencePrice）
 */
export type PriceSource = 'ticket' | 'trade' | 'snapshot' | 'reference' | 'oddQuote';

export const PRICE_SOURCE_LABEL: Record<Exclude<PriceSource, 'ticket'>, string> = {
    trade: '成交',
    snapshot: '快照收盤',
    reference: '參考價',
    oddQuote: '零股買賣價',
};

export interface SourcedPrice {
    price: number;
    source: PriceSource;
}

/** 即時價：真實成交優先，沒有時用市場快照收盤（不退回參考價） */
export function marketPrice(trade: number | null, snapshot: Pick<Snapshot, 'close'> | null | undefined): SourcedPrice | null {
    if (trade !== null && trade > 0) return { price: trade, source: 'trade' };
    const close = positivePrice(snapshot?.close);
    return close !== null ? { price: close, source: 'snapshot' } : null;
}

/** 開啟時的預設價：帶入價 → 真實成交 → 快照收盤 → 參考價 */
export function defaultTicketPrice(
    ticketPrice: number | null | undefined,
    trade: number | null,
    snapshot: Pick<Snapshot, 'close'> | null | undefined,
    contract: Pick<ContractInfo, 'reference'>,
): SourcedPrice | null {
    const given = positivePrice(ticketPrice);
    if (given !== null) return { price: given, source: 'ticket' };
    const market = marketPrice(trade, snapshot);
    if (market) return market;
    const reference = positivePrice(contract.reference);
    return reference !== null ? { price: reference, source: 'reference' } : null;
}

/**
 * 盤中零股的即時價（#204，比照桌面 order-ticket.tsx）：只看零股行情——零股真實成交（排除試撮），
 * 否則零股委買／委賣的中價或單邊（oddLotReferencePrice）；都沒有回 null（等待零股行情），**絕不退回整股價格或整股快照**。
 */
export function oddLotMarketPrice(
    oddTrade: number | null,
    oddQuote: Pick<OddBaseQuote, 'bidask'> | null | undefined,
    round: (p: number) => number,
): SourcedPrice | null {
    if (oddTrade !== null && oddTrade > 0) return { price: oddTrade, source: 'trade' };
    // 只把委買賣交給 oddLotReferencePrice：零股 tick（可能是試撮）已由 oddTrade 處理
    const p = oddLotReferencePrice(oddQuote?.bidask ? { bidask: oddQuote.bidask } : undefined, round);
    return p !== null ? { price: p, source: 'oddQuote' } : null;
}

/** 開啟時的預設價：帶入盤中零股時只用帶入價，不以整股成交／快照／參考價帶入零股限價（#204） */
export function openingTicketPrice(
    ticket: Pick<TicketRequest, 'price' | 'lot'>,
    isFutures: boolean,
    trade: number | null,
    snapshot: Pick<Snapshot, 'close'> | null | undefined,
    contract: Pick<ContractInfo, 'reference'>,
): SourcedPrice | null {
    if (!isFutures && ticket.lot === 'IntradayOdd') {
        const given = positivePrice(ticket.price);
        return given !== null ? { price: given, source: 'ticket' } : null;
    }
    return defaultTicketPrice(ticket.price, trade, snapshot, contract);
}

/** 價格確認哨兵：resumeSeq 一律 >= 0，所以記成這個值的價格一律視為「價格可能過期」 */
export const PRICE_UNCONFIRMED = -1;

/** stale-data 時串流已恢復（只是委託／持倉或快照讀取失敗），使用者可以確認價格；同步中或失敗時不行 */
export function canConfirmPrice(gate: Pick<ResumeGateSnapshot, 'state'>): boolean {
    return gate.state === 'ready' || gate.state === 'stale-data';
}

/** 自動帶入價格時記下的 resumeSeq：ResumeGate 不是 ready（同步中、資料可能過期、失敗）→ 未確認 */
export function seededPriceSeq(gate: Pick<ResumeGateSnapshot, 'state' | 'resumeSeq'>): number {
    return gate.state === 'ready' ? gate.resumeSeq : PRICE_UNCONFIRMED;
}

/** 使用者確認價格時記下的 resumeSeq：同步中或失敗時的確認不算，恢復後須再確認 */
export function confirmedPriceSeq(gate: Pick<ResumeGateSnapshot, 'state' | 'resumeSeq'>): number {
    return canConfirmPrice(gate) ? gate.resumeSeq : PRICE_UNCONFIRMED;
}

/**
 * 面板掛載時的價格基準（M-PLAT-4）：openTicket 帶入的價格以「帶入當下」為準——
 * 帶入之後（ticket.openedAt 起）ResumeGate 開始過重新同步（resyncStartedAt），即使掛載時已回到 ready，
 * 也記為未確認（價格可能過期）。面板自己帶入的價格（成交、快照、參考價）以掛載當下的 gate 為準。
 * 兩個時間都是 Date.now()（mobile-store 與 ResumeGate 預設時鐘）。
 */
export function openingPriceSeq(
    gate: Pick<ResumeGateSnapshot, 'state' | 'resumeSeq' | 'resyncStartedAt'>,
    openedAt: number | undefined,
    carriedPrice: boolean,
): number {
    if (carriedPrice && openedAt !== undefined && gate.resyncStartedAt !== undefined && gate.resyncStartedAt >= openedAt) {
        return PRICE_UNCONFIRMED;
    }
    return seededPriceSeq(gate);
}

export function isOnTick(contract: ContractInfo, price: number): boolean {
    return Math.abs(roundToTick(contract, price) - price) < 1e-6;
}

/** 股票限價在跌停與漲停之間（合約沒有漲跌停資料時不檢查） */
export function withinLimits(contract: Pick<ContractInfo, 'limit_up' | 'limit_down'>, price: number): boolean {
    const up = Number(contract.limit_up);
    const down = Number(contract.limit_down);
    if (!(up > 0) || !(down > 0)) return true;
    return price <= up + 1e-6 && price >= down - 1e-6;
}

/** 送出的價格：市價／範圍市價送 0；限價無效時也回 0（由驗證擋下） */
export function orderPriceOf(fields: Pick<TicketFields, 'priceType' | 'priceText'>): number {
    if (fields.priceType !== 'LMT') return 0;
    const p = parsePrice(fields.priceText);
    return p > 0 ? p : 0;
}

/** 實際送出 daytrade_short：只在「賣出＋現股＋整股＋勾選」時（其他組合由驗證擋下，不會走到送出） */
export function sendsDaytradeShort(fields: Pick<TicketFields, 'orderLot' | 'orderCond' | 'daytradeShort'>, action: Action): boolean {
    return action === 'Sell' && fields.daytradeShort && fields.orderCond === 'Cash' && fields.orderLot === 'Common';
}

/** 「現股當沖先賣」可以勾選：賣出＋整股＋現股＋contract.day_trade === 'Yes' */
export function daytradeShortEligible(contract: Pick<ContractInfo, 'day_trade'>, fields: Pick<TicketFields, 'action' | 'orderLot' | 'orderCond'>): boolean {
    return fields.action === 'Sell' && fields.orderLot === 'Common' && fields.orderCond === 'Cash' && contract.day_trade === 'Yes';
}

/**
 * 股票委託內容（實際送出）：order_cond 只在非現股時送；daytrade_short 只在 sendsDaytradeShort 時送 true。
 * 兩個欄位不送時不出現在物件上（與桌面 order-ticket.tsx:424-439 相同）。
 */
export function stockOrderOf(fields: TicketFields, action: Action): StockOrderReq {
    const order: StockOrderReq = {
        action,
        price: orderPriceOf(fields),
        quantity: fields.quantity,
        price_type: fields.priceType === 'MKT' ? 'MKT' : 'LMT',
        order_type: fields.orderType,
        order_lot: fields.orderLot,
    };
    if (fields.orderCond !== 'Cash') order.order_cond = fields.orderCond;
    if (sendsDaytradeShort(fields, action)) order.daytrade_short = true;
    return order;
}

/**
 * 驗證用的委託形狀（使用者的意圖）：信用條件一律帶上、勾選的當沖在賣出時一律帶上，
 * 不合規則的組合（零股＋融資、融資＋當沖…）由 stockOrderProblem／玉山規則擋下並顯示原因，
 * 而不是在送出時被悄悄拿掉（比照桌面 execute() 的驗證參數）。
 */
export function stockOrderIntentOf(fields: TicketFields, action: Action): StockOrderReq {
    return { ...stockOrderOf(fields, action), order_cond: fields.orderCond, daytrade_short: action === 'Sell' && fields.daytradeShort };
}

/** 動作文字（含信用名稱）：融資買進、融券買進（回補）、融券賣出、現股當沖賣出、買進、賣出；未選方向回空字串 */
export function ticketActionText(fields: Pick<TicketFields, 'action' | 'orderLot' | 'orderCond' | 'daytradeShort'>, isFutures: boolean): string {
    if (!fields.action) return '';
    const side = fields.action === 'Buy' ? '買進' : '賣出';
    if (isFutures) return side;
    if (fields.orderCond === 'ShortSelling' && fields.action === 'Buy') return '融券買進（回補）';
    const credit = fields.orderCond !== 'Cash' ? creditLabel(fields.action, fields.orderCond) : undefined;
    if (credit) return `${credit}${side}`;
    if (fields.action === 'Sell' && fields.daytradeShort && fields.orderLot === 'Common') return '現股當沖賣出';
    return side;
}

const fmtNumber = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 4 });

/** 預覽鍵文字：「預覽買進委託 · 2330 · 1 張 · 限價 2,240」；未選方向時提示先選 */
export function previewLabel(contract: Pick<ContractInfo, 'code'>, fields: TicketFields, isFutures: boolean): string {
    if (!fields.action) return '請先選擇買進或賣出';
    const unit = orderQtyUnit(isFutures, isFutures ? undefined : fields.orderLot);
    const qty = Number.isSafeInteger(fields.quantity) && fields.quantity > 0 ? `${fmtNumber(fields.quantity)} ${unit}` : `— ${unit}`;
    const p = parsePrice(fields.priceText);
    const price = fields.priceType === 'LMT' ? `限價 ${p > 0 ? fmtNumber(p) : '—'}` : PRICE_TYPE_LABEL[fields.priceType];
    return `預覽${ticketActionText(fields, isFutures)}委託 · ${contract.code} · ${qty} · ${price}`;
}

export interface TicketCheck {
    contract: ContractInfo;
    /** 開啟時固定的送單帳戶 */
    account: Account | undefined;
    /** 目前 account-store 的同市場選取帳戶（與固定的帳戶不同＝已被切換） */
    selected: Account | null | undefined;
    fields: TicketFields;
    /** ResumeGate 的 resumeSeq 已不是帶入價格當時的值 */
    priceStale: boolean;
    tradingLive: boolean;
    gate: Pick<ResumeGateSnapshot, 'state' | 'staleAcknowledged' | 'message'>;
    /** RouteBadge 的環境：true 模擬、false 正式、undefined 未確認 */
    routeSimulation: boolean | undefined;
}

/** 即時驗證（規格 §6.3 的 1～7 順序）；回傳第一個原因，全部通過回 null */
export function ticketProblem(c: TicketCheck): string | null {
    const { contract, account, fields } = c;
    const isFutures = isFuturesContract(contract);
    if (!isTradableContract(contract)) return TICKET_TEXT.unsupported;
    if (!fields.action) return TICKET_TEXT.noAction;
    // 1) 帳戶：存在、市場相符、玉山不可用於期權、canTrade、仍是目前選取的帳戶
    if (!account) return isFutures ? TICKET_TEXT.noFuturesAccount : TICKET_TEXT.noStockAccount;
    if (isFutures && isEsunAccount(account)) return TICKET_TEXT.esunFutures;
    if (account.account_type !== (isFutures ? 'F' : 'S')) return TICKET_TEXT.marketMismatch;
    if (!canTrade(account)) return TICKET_TEXT.notTradable;
    if (!accountMatches(c.selected, account)) return TICKET_TEXT.accountChanged;
    // 2) 數量與風控（鎖單、單筆上限、當日虧損上限）
    if (!Number.isSafeInteger(fields.quantity) || fields.quantity < 1) return TICKET_TEXT.quantity;
    const blocked = checkOrderAllowed(fields.quantity, isFutures ? undefined : fields.orderLot);
    if (blocked) return blocked;
    // 3) 期權條件 4) 股票：玉山規則，再上游規則
    if (isFutures) {
        const problem = futuresOrderProblem({ price_type: fields.priceType, order_type: fields.orderType, octype: fields.octype });
        if (problem) return problem;
    } else {
        const order = stockOrderIntentOf(fields, fields.action);
        const problem = esunStockLegProblem(account, contract, order)
            ?? stockOrderProblem({ ...order, day_trade: contract.day_trade });
        if (problem) return problem;
    }
    // 5) 價格：限價 > 0、符合升降單位、股票在漲跌停內；回前景後需重新確認
    if (fields.priceType === 'LMT') {
        const p = parsePrice(fields.priceText);
        if (!(p > 0)) return TICKET_TEXT.priceRequired;
        if (!isOnTick(contract, p)) return TICKET_TEXT.priceTick;
        if (!isFutures && !withinLimits(contract, p)) return TICKET_TEXT.priceRange;
        if (c.priceStale) return TICKET_TEXT.priceStale;
    }
    // 6) 連線：串流 LIVE 且 ResumeGate ready（stale-data 需勾選了解）
    if (!c.tradingLive) return TICKET_TEXT.notLive;
    if (c.gate.state === 'resyncing') return TICKET_TEXT.resyncing;
    if (c.gate.state === 'failed') return c.gate.message ?? TICKET_TEXT.failed;
    if (c.gate.state === 'stale-data' && !c.gate.staleAcknowledged) return TICKET_TEXT.staleData;
    // 7) 環境：RouteBadge 不是「環境未確認」
    if (c.routeSimulation === undefined) return TICKET_TEXT.envUnknown;
    return null;
}

/**
 * 預估金額：股票＝價格 × 股數（不含手續費、稅）；期權＝名目價值＝價格 × 契約乘數 × 口數（不估保證金）。
 * 市價以最新成交價估；沒有價格或數量無效時 value 為 null。
 */
export function estimateAmount(
    contract: ContractInfo,
    fields: Pick<TicketFields, 'priceType' | 'priceText' | 'quantity' | 'orderLot'>,
    lastPrice: number | null,
): { value: number | null; byLastPrice: boolean } {
    const byLastPrice = fields.priceType !== 'LMT';
    const p = byLastPrice ? lastPrice : parsePrice(fields.priceText);
    if (p === null || !(p > 0) || !Number.isSafeInteger(fields.quantity) || fields.quantity < 1) return { value: null, byLastPrice };
    if (isFuturesContract(contract)) return { value: p * contractMultiplier(contract) * fields.quantity, byLastPrice };
    const shares = isOddLot(fields.orderLot) ? fields.quantity : fields.quantity * SHARES_PER_LOT;
    return { value: p * shares, byLastPrice };
}

/**
 * 組出 submitMobileOrder 的輸入（市價 price 0；股票現股不送 order_cond、只在可送時送 daytrade_short）。
 * creditHint：持倉衝突的信用提醒（只提示、不改條件），附在確認面板的備註。
 */
export function buildMobileOrderInput(contract: ContractInfo, account: Account, fields: TicketFields & { action: Action }, creditHint?: string | null): MobileOrderInput {
    const price = orderPriceOf(fields);
    const common = { contract, displayedAccount: account, action: fields.action, quantity: fields.quantity, price, orderType: fields.orderType };
    if (isFuturesContract(contract)) {
        return {
            ...common,
            isFutures: true,
            priceType: fields.priceType,
            octype: fields.octype,
            futuresOrder: {
                action: fields.action,
                price,
                quantity: fields.quantity,
                price_type: fields.priceType,
                order_type: fields.orderType,
                octype: fields.octype,
            },
        };
    }
    const stockOrder = stockOrderOf(fields, fields.action);
    return {
        ...common,
        isFutures: false,
        priceType: stockOrder.price_type,
        orderLot: fields.orderLot,
        stockOrder,
        ...(creditHint ? { creditHint } : {}),
    };
}

export type TicketOutcome = 'cancelled' | 'not-sent' | 'unknown';

/** 失敗結果分類（§7.2）：取消 → 未送出（mutationNotStarted）→ 其餘一律結果未知 */
export function classifyTicketOutcome(err: unknown): TicketOutcome {
    if (err instanceof OrderConfirmCancelled) return 'cancelled';
    if (isNotStarted(err)) return 'not-sent';
    return 'unknown';
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err ?? ''));

export interface TicketFeedback {
    kind: 'cancelled' | 'not-sent';
    text: string;
}

function initialPriceText(contract: ContractInfo, price: number | null): string {
    return price !== null && price > 0 ? String(roundToTick(contract, price)) : '';
}

/**
 * 開啟時的欄位：openTicket 帶入的 lot／cond／daytradeShort 只在這裡帶入一次（股票）。
 * 帶入值不合規則（例如零股＋融資）時照樣保留，由 ticketProblem 顯示原因並停用預覽，絕不自動換成別的條件。
 * 零股單位只接受限價＋ROD，這兩個本來就是預設值。
 */
export function initialTicketFields(ticket: Pick<TicketRequest, 'action' | 'lot' | 'cond' | 'daytradeShort'>, contract: ContractInfo, price: number | null): TicketFields {
    const stock = !isFuturesContract(contract);
    return {
        action: ticket.action,
        priceType: 'LMT',
        orderType: 'ROD',
        orderLot: stock ? ticket.lot ?? 'Common' : 'Common',
        orderCond: stock ? ticket.cond ?? 'Cash' : 'Cash',
        daytradeShort: stock && ticket.daytradeShort === true,
        octype: 'Auto',
        priceText: initialPriceText(contract, price),
        quantity: 1,
    };
}

// ---- React hook ----

export function useMobileTicket(ticket: TicketRequest, contract: ContractInfo) {
    const isFutures = isFuturesContract(contract);
    const market = isFutures ? 'F' : 'S';
    // 帳戶在開啟時固定（面板關閉前不會因 store 改變而換成別的帳戶）
    const [account] = useState(() => captureSelectedAccount(market));
    const accounts = useAccounts();
    const selected = isFutures ? accounts.selectedFutures : accounts.selectedStock;
    useRiskSettings(); // checkOrderAllowed 讀風控設定：設定改變時重新驗證
    const tradingLive = useTradingLive();
    const gate = useResumeGate();
    const route = useOrderRoute(account);

    const quote = useQuote(contract.code);
    // 沒有真實成交時以市場快照收盤為準（store 已有快照就不再讀取；沒有時 fetchSnapshots 一次）
    const { snapshot } = useSnapshotBaseline(contract.code, undefined, contract);
    const commonTrade = useRealTradePrice(quote?.tick);
    const [initialPrice] = useState(() => openingTicketPrice(ticket, isFutures, commonTrade, snapshot, contract));
    const [fields, setFields] = useState<TicketFields>(() => initialTicketFields(ticket, contract, initialPrice?.price ?? null));
    /** 價格欄自動帶入的來源；使用者動過價格後為 null */
    const [priceSource, setPriceSource] = useState<PriceSource | null>(() => initialPrice?.source ?? null);
    const odd = !isFutures && isOddLot(fields.orderLot);
    const intradayOdd = !isFutures && fields.orderLot === 'IntradayOdd';
    const oddQuote = useQuote(intradayOdd ? contract.code : null, { oddLot: true });
    const oddTrade = useRealTradePrice(oddQuote?.tick);
    // 盤後零股沒有即時五檔（14:30 一次撮合）；成交價沿用整股
    const activeQuote = intradayOdd ? oddQuote : odd ? undefined : quote;
    // 盤中零股的即時價與「成交」快捷價只看零股行情（#204）；沒有零股行情時為 null（等待零股行情）
    const live = intradayOdd
        ? oddLotMarketPrice(oddTrade, oddQuote, p => roundToTick(contract, p))
        : marketPrice(commonTrade, snapshot);
    const lastPrice = live?.price ?? null;
    const bid1 = positivePrice(activeQuote?.bidask?.bid_price?.[0]);
    const ask1 = positivePrice(activeQuote?.bidask?.ask_price?.[0]);

    // 價格帶入當時的 resumeSeq；不同（或 PRICE_UNCONFIRMED）＝價格可能過期。openTicket 帶入的價格以帶入當下為準
    const [priceSeq, setPriceSeq] = useState(() => openingPriceSeq(gate, ticket.openedAt, initialPrice?.source === 'ticket'));
    // 開啟時只有參考價或沒有價格：第一次收到真實成交或快照時補帶一次（使用者已動過價格就不帶）；之後不再跟價。
    // 盤中零股不補帶（整股成交／快照不是零股價格，#204）
    const seeded = useRef(initialPrice !== null && initialPrice.source !== 'reference');
    const busyRef = useRef(false);
    const better = marketPrice(commonTrade, snapshot);
    const betterPrice = better?.price ?? null;
    const betterSource = better?.source ?? null;
    useEffect(() => {
        if (intradayOdd || seeded.current || busyRef.current || betterPrice === null || betterSource === null) return;
        seeded.current = true;
        setFields(f => ({ ...f, priceText: initialPriceText(contract, betterPrice) }));
        setPriceSource(betterSource);
        setPriceSeq(seededPriceSeq(getResumeGate()));
    }, [betterPrice, betterSource, contract, intradayOdd]);

    const priceStale = fields.priceType === 'LMT' && fields.priceText !== '' && priceSeq !== gate.resumeSeq;

    const problem = ticketProblem({
        contract,
        account,
        selected,
        fields,
        priceStale,
        tradingLive,
        gate,
        routeSimulation: route?.simulation,
    });

    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<TicketFeedback | null>(null);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    // 單位、信用條件、當沖、方向任一改變 → 確認中的舊流程在 beforeDispatch 失效
    const captureContext = useOrderContext(contract, `${fields.orderLot}:${fields.orderCond}:${fields.daytradeShort ? 'dt' : ''}:${fields.action ?? ''}`);

    const edit = useCallback((patch: Partial<TicketFields>) => {
        if (busyRef.current) return;
        setFeedback(null);
        setFields(f => ({ ...f, ...patch }));
    }, []);

    const markPriceConfirmed = () => {
        seeded.current = true;
        setPriceSource(null);
        setPriceSeq(confirmedPriceSeq(getResumeGate()));
    };

    /** 切換買賣不改信用條件與當沖勾選（比照桌面；不合規則時由驗證顯示原因） */
    const setAction = (action: Action) => edit({ action });
    const setPriceType = (priceType: FuturesPriceType) => {
        if (priceTypeDisabledReason(priceType, odd)) return;
        if (!isFutures && priceType === 'MKP') return;
        edit({ priceType, orderType: defaultOrderTypeFor(priceType) });
    };
    const setOrderType = (orderType: OrderType) => {
        if (orderTypeDisabledReason(orderType, odd)) return;
        edit({ orderType });
    };
    const setOctype = (octype: FuturesOCType) => edit({ octype });
    /**
     * 單位切換（使用者操作）：數量歸 1；零股強制 限價＋ROD＋現股＋不當沖（比照桌面 order-ticket.tsx:1086-1096）。
     * 切到盤中零股時，價格若仍是自動帶入（使用者沒有手動輸入或確認）就清空（比照桌面 order-ticket.tsx:258-263，
     * 絕不以整股價格帶入零股限價，#204）；之後切回整股／盤後零股時可再補帶一次整股價。使用者自己輸入的價格保留。
     */
    const setOrderLot = (orderLot: TicketLot) => {
        if (isFutures || busyRef.current || orderLot === fields.orderLot) return;
        const clearAuto = orderLot === 'IntradayOdd' && priceSource !== null;
        const patch: Partial<TicketFields> = isOddLot(orderLot)
            ? { orderLot, quantity: 1, priceType: 'LMT', orderType: 'ROD', orderCond: 'Cash', daytradeShort: false }
            : { orderLot, quantity: 1 };
        edit(clearAuto ? { ...patch, priceText: '' } : patch);
        if (clearAuto) {
            seeded.current = false;
            setPriceSource(null);
        }
    };
    /** 信用條件（只限整股）；選非現股時取消當沖勾選（比照桌面 order-ticket.tsx:1162-1164） */
    const setOrderCond = (orderCond: TicketCond) => {
        if (isFutures || odd) return;
        edit(orderCond === 'Cash' ? { orderCond } : { orderCond, daytradeShort: false });
    };
    /** 現股當沖先賣：可勾選的條件見 daytradeShortEligible；取消勾選一律允許（不合規則時才能取消） */
    const setDaytradeShort = (on: boolean) => {
        if (isFutures) return;
        if (on && !daytradeShortEligible(contract, fields)) return;
        edit({ daytradeShort: on });
    };
    /** 手動輸入價格（視同使用者確認這個價格） */
    const setPriceText = (priceText: string) => {
        if (busyRef.current) return;
        edit({ priceText });
        markPriceConfirmed();
    };
    /** 價格步進（升降單位）；沒有有效價格時先帶成交價或平盤價 */
    const stepPriceBy = (steps: number) => {
        if (busyRef.current) return;
        const current = parsePrice(fields.priceText);
        let next: number;
        if (current > 0) next = stepPrice(contract, isOnTick(contract, current) ? current : roundToTick(contract, current), steps);
        else {
            const base = lastPrice ?? positivePrice(contract.reference);
            if (base === null) return;
            next = roundToTick(contract, base);
        }
        if (!(next > 0)) return;
        edit({ priceText: String(next) });
        markPriceConfirmed();
    };
    /** 快捷價：一律送限價 */
    const pickPrice = (price: number | null) => {
        if (busyRef.current || price === null || !(price > 0)) return;
        edit(fields.priceType === 'LMT' ? { priceText: String(price) } : { priceText: String(price), priceType: 'LMT', orderType: defaultOrderTypeFor('LMT') });
        markPriceConfirmed();
    };
    /** 「價格可能過期」時按「使用此價格」 */
    const confirmPrice = () => {
        if (busyRef.current) return;
        markPriceConfirmed();
    };
    const qtyMax = isFutures ? Number.MAX_SAFE_INTEGER : odd ? ODD_LOT_MAX_SHARES : COMMON_LOT_INPUT_MAX;
    const setQuantity = (quantity: number) => {
        if (!Number.isFinite(quantity)) return;
        edit({ quantity: Math.min(qtyMax, Math.max(0, Math.trunc(quantity))) });
    };
    const stepQuantity = (delta: number) => {
        const base = Number.isSafeInteger(fields.quantity) ? fields.quantity : 1;
        edit({ quantity: Math.min(qtyMax, Math.max(1, base + delta)) });
    };

    const submit = async (creditHint?: string | null): Promise<void> => {
        if (busyRef.current || problem || !account || !fields.action) return;
        const input = buildMobileOrderInput(contract, account, { ...fields, action: fields.action }, creditHint);
        const isContextCurrent = captureContext();
        busyRef.current = true;
        setBusy(true);
        setFeedback(null);
        const seq = ticket.seq;
        const closeThisTicket = () => { if (getMobileUi().ticket?.seq === seq) closeTicket(); };
        try {
            const trade = await submitMobileOrder(input, {
                assertResumeReady: () => assertResumeReady({ allowStale: getResumeGate().staleAcknowledged }),
                isContextCurrent,
            });
            const unit = orderQtyUnit(isFutures, isFutures ? undefined : fields.orderLot);
            notify({
                kind: 'ok',
                title: '委託已送出',
                body: `${ticketActionText(fields, isFutures)} ${contract.code} ${fields.quantity} ${unit}・${orderStatusWithNumber(trade)}`,
            });
            closeThisTicket();
        } catch (err) {
            const outcome = classifyTicketOutcome(err);
            if (outcome === 'cancelled') {
                if (mounted.current) setFeedback({ kind: 'cancelled', text: '已取消' });
            } else if (outcome === 'not-sent') {
                // 面板在送出中被卸載（例如被關閉）：改用通知告知，不可靜默丟棄「未送出」
                if (mounted.current) setFeedback({ kind: 'not-sent', text: `未送出：${errorText(err)}` });
                else notify({ kind: 'err', title: NOT_SENT_TITLE, body: errorText(err) });
            } else {
                // 結果未知：禁止重送，關閉面板並提示到委託頁核對（R6、§7.2）
                notify({ kind: 'err', title: OUTCOME_UNKNOWN_TITLE, body: errorText(err) });
                reconcileAfterUnknownOutcome();
                closeThisTicket();
            }
        } finally {
            busyRef.current = false;
            if (mounted.current) setBusy(false);
        }
    };

    return {
        isFutures,
        odd,
        /** 盤中零股：即時價與「成交」只看零股行情 */
        intradayOdd,
        account,
        route,
        gate,
        fields,
        quote: { last: lastPrice, lastSource: live?.source ?? null, bid1, ask1 },
        /** 市場快照（報價列沒有真實成交時用） */
        snapshot,
        /** 開啟時的帶入（lot／cond／daytradeShort）：面板可預設展開條件列 */
        presetConditions: ticket.lot !== undefined || ticket.cond !== undefined || ticket.daytradeShort === true,
        priceSource,
        priceStale,
        canConfirmPrice: canConfirmPrice(gate),
        problem,
        busy,
        feedback,
        estimate: estimateAmount(contract, fields, lastPrice),
        setAction,
        setPriceType,
        setOrderType,
        setOctype,
        setOrderLot,
        setOrderCond,
        setDaytradeShort,
        daytradeShortEligible: daytradeShortEligible(contract, fields),
        actionText: ticketActionText(fields, isFutures),
        previewText: previewLabel(contract, fields, isFutures),
        setPriceText,
        stepPriceBy,
        pickPrice,
        confirmPrice,
        setQuantity,
        stepQuantity,
        acknowledgeStale: acknowledgeStaleData,
        retryResume,
        submit,
    };
}

export type MobileTicket = ReturnType<typeof useMobileTicket>;

/** 最近一筆真實成交價：試撮 tick 到達時沿用上一筆真實成交，不被揭示價覆蓋 */
function useRealTradePrice(tick: { close?: string | number | null; simtrade?: boolean } | null | undefined): number | null {
    const last = useRef<number | null>(null);
    const now = realTradePrice(tick);
    if (now !== null) last.current = now;
    return now ?? last.current;
}
