// src/mobile/hooks/use-mobile-ticket.ts — 下單面板的欄位狀態、即時驗證與送出（規格 §6.3、§7.1、§7.2）
//
// - 帳戶在開啟時以 captureSelectedAccount(market) 固定（面板顯示的就是送單帳戶）。
// - 價格只在開啟時帶入一次，之後不自動跟價；ResumeGate 的 resumeSeq 改變時標示「價格可能過期」，
//   需重新點快捷價、手動修改或按「使用此價格」確認才可預覽。
// - 即時驗證依 §6.3 的 1～7 順序（ticketProblem），回傳第一個原因；有原因就停用「預覽並確認委託」。
// - 送出一律呼叫 submitMobileOrder()（lib/mobile-order.ts）；結果依 §7.2 分四類處理，結果未知不提供重送。
// MVP 單位只有整股與盤中零股，信用條件固定現股、不提供當沖先賣（P1）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOrderContext } from '../../hooks/use-order-context';
import { useQuote, useTradingLive } from '../../hooks/use-stream';
import { useAccounts } from '../../lib/account-store';
import { canTrade } from '../../lib/account-tradable';
import { isEsunAccount } from '../../lib/esun';
import { accountMatches } from '../../lib/flash-account';
import { isOddLot, ODD_LOT_MAX_SHARES, orderQtyUnit, SHARES_PER_LOT, stockOrderProblem } from '../../lib/odd-lot';
import { captureSelectedAccount } from '../../lib/order-account';
import { defaultOrderTypeFor, futuresOrderProblem, orderTypeDisabledReason, priceTypeDisabledReason } from '../../lib/order-conditions';
import { reconcileAfterUnknownOutcome } from '../../lib/order-outcome';
import { esunStockLegProblem } from '../../lib/order-route';
import { orderStatusWithNumber } from '../../lib/order-status-label';
import { checkOrderAllowed, useRiskSettings } from '../../lib/risk';
import { notify, OrderConfirmCancelled } from '../../lib/trade';
import type { ContractInfo } from '../../lib/types/contract';
import type { Action, FuturesOCType, FuturesPriceType, OrderType, StockOrderLot, StockOrderReq } from '../../lib/types/order';
import type { Account } from '../../lib/types/portfolio';
import { contractMultiplier } from '../../lib/utils/contract-cost';
import { roundToTick, stepPrice } from '../../lib/utils/ticksize';
import { useOrderRoute } from '../components/route-badge';
import { isNotStarted } from '../lib/errors';
import { submitMobileOrder } from '../lib/mobile-order';
import type { MobileOrderInput } from '../lib/mobile-order-types';
import { closeTicket, getMobileUi, type TicketRequest } from '../lib/mobile-store';
import { acknowledgeStaleData, assertResumeReady, getResumeGate, retryResume, type ResumeGateSnapshot } from '../lib/resume-gate-runtime';
import { useResumeGate } from './use-resume-gate';

/** MVP 提供的股票單位（盤後零股屬 P1） */
export type TicketLot = Extract<StockOrderLot, 'Common' | 'IntradayOdd'>;

export interface TicketFields {
    /** null＝尚未選擇買賣（例如五檔價位只帶價） */
    action: Action | null;
    /** 股票只用 LMT／MKT；期權另有 MKP */
    priceType: FuturesPriceType;
    orderType: OrderType;
    /** 期權不使用（固定 Common） */
    orderLot: TicketLot;
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
} as const;

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

/** 股票委託內容：現股時不送 order_cond、不送 daytrade_short（MVP 不提供信用與當沖先賣） */
export function stockOrderOf(fields: TicketFields, action: Action): StockOrderReq {
    return {
        action,
        price: orderPriceOf(fields),
        quantity: fields.quantity,
        price_type: fields.priceType === 'MKT' ? 'MKT' : 'LMT',
        order_type: fields.orderType,
        order_lot: fields.orderLot,
    };
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
        const order = stockOrderOf(fields, fields.action);
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

/** 組出 submitMobileOrder 的輸入（市價 price 0；股票現股不送 order_cond／daytrade_short） */
export function buildMobileOrderInput(contract: ContractInfo, account: Account, fields: TicketFields & { action: Action }): MobileOrderInput {
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
    return { ...common, isFutures: false, priceType: stockOrder.price_type, orderLot: fields.orderLot, stockOrder };
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
    const [fields, setFields] = useState<TicketFields>(() => ({
        action: ticket.action,
        priceType: 'LMT',
        orderType: 'ROD',
        orderLot: 'Common',
        octype: 'Auto',
        priceText: initialPriceText(contract, ticket.price ?? positivePrice(quote?.tick?.close)),
        quantity: 1,
    }));
    const odd = !isFutures && isOddLot(fields.orderLot);
    const oddQuote = useQuote(!isFutures && fields.orderLot === 'IntradayOdd' ? contract.code : null, { oddLot: true });
    const activeQuote = odd ? oddQuote : quote;
    const lastPrice = positivePrice(activeQuote?.tick?.close);
    const bid1 = positivePrice(activeQuote?.bidask?.bid_price?.[0]);
    const ask1 = positivePrice(activeQuote?.bidask?.ask_price?.[0]);

    // 價格帶入當時的 resumeSeq；不同＝價格可能過期
    const [priceSeq, setPriceSeq] = useState(() => gate.resumeSeq);
    // 開啟時還沒有行情：第一次收到成交價時補帶一次（使用者已動過價格就不帶）；之後不再跟價
    const seeded = useRef(fields.priceText !== '');
    const openClose = positivePrice(quote?.tick?.close);
    useEffect(() => {
        if (seeded.current || openClose === null) return;
        seeded.current = true;
        setFields(f => (f.priceText === '' ? { ...f, priceText: initialPriceText(contract, openClose) } : f));
        setPriceSeq(getResumeGate().resumeSeq);
    }, [openClose, contract]);

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
    const busyRef = useRef(false);
    const [feedback, setFeedback] = useState<TicketFeedback | null>(null);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const captureContext = useOrderContext(contract, `${fields.orderLot}:${fields.action ?? ''}`);

    const edit = useCallback((patch: Partial<TicketFields>) => {
        if (busyRef.current) return;
        setFeedback(null);
        setFields(f => ({ ...f, ...patch }));
    }, []);

    const markPriceConfirmed = () => {
        seeded.current = true;
        setPriceSeq(getResumeGate().resumeSeq);
    };

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
    /** 單位切換：數量歸 1；零股強制限價＋ROD（信用固定現股、不當沖） */
    const setOrderLot = (orderLot: TicketLot) => {
        if (isFutures || orderLot === fields.orderLot) return;
        edit(isOddLot(orderLot) ? { orderLot, quantity: 1, priceType: 'LMT', orderType: 'ROD' } : { orderLot, quantity: 1 });
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

    const submit = async (): Promise<void> => {
        if (busyRef.current || problem || !account || !fields.action) return;
        const input = buildMobileOrderInput(contract, account, { ...fields, action: fields.action });
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
                body: `${fields.action === 'Buy' ? '買進' : '賣出'} ${contract.code} ${fields.quantity} ${unit}・${orderStatusWithNumber(trade)}`,
            });
            closeThisTicket();
        } catch (err) {
            const outcome = classifyTicketOutcome(err);
            if (outcome === 'cancelled') {
                if (mounted.current) setFeedback({ kind: 'cancelled', text: '已取消' });
            } else if (outcome === 'not-sent') {
                if (mounted.current) setFeedback({ kind: 'not-sent', text: `未送出：${errorText(err)}` });
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
        account,
        route,
        gate,
        fields,
        quote: { last: lastPrice, bid1, ask1 },
        priceStale,
        problem,
        busy,
        feedback,
        estimate: estimateAmount(contract, fields, lastPrice),
        setAction,
        setPriceType,
        setOrderType,
        setOctype,
        setOrderLot,
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
