// src/lib/esun/report-adapter.ts — esun-bridge SSE 委託／成交回報 → 上游回報管線的 wire 形狀
//
// bridge（§5 契約）每筆 `order`（ACK）／`deal`（MAT）事件帶 SDK 原始欄位，另外固定附上
// event_id（<boot_id>-<seq>）、seq、ts（ISO8601 +08:00）、environment、account、order_no、
// op_type。上游 normalizeOrderEvent／projectOrderReport／projectTradeDeal 需要的是 Shioaji
// 的 {state, data:{StockOrder|StockDeal:{…}}} 形狀，帶 order.account、status.exchange_ts、
// contract.security_type、trade_id、exchange_seq，event_id 為 `v1:<stream>:<reset>:<seq>`
// （才能做去重與跳號偵測）。這裡只做轉換，不讀網路、不改狀態。
//
// 數量一律換成 App 單位：整股／盤後為張，零股／興櫃為股（零股的 *_qty 是張的小數）。
// 興櫃（ap_code 4）回報的 *_qty 單位沒有實測資料：沒有 *_qty_share 時不推測股數，整筆不投影，
// 回 skip unit-unknown（帶委託 id）。bridge 也不把這類數量寫進快取，所以呼叫端提出的待對帳
// 只有權威讀取能解除（快取重建不能）。

import type { Exchange } from '../types/contract';
import type { Account } from '../types/portfolio';
import {
    esunAccountForEnvironment,
    esunMktSeqNum,
    esunOrderId,
    esunQuantityFromFields,
    esunTimestamp,
    isEsunFailureCode,
} from './order-mapping';
import { EsunApCode, EsunTradeType, type EsunEnvironment } from './types';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const num = (v: unknown): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
};

/** 本地已知的同一筆委託（用來把累計取消量換成「這次」的取消量） */
export interface EsunKnownOrder {
    /** 本地委託 id（預約單為 pre_ord_no） */
    id: string;
    quantity: number;
    dealQuantity: number;
    cancelQuantity: number;
    price: number;
}

export interface EsunReportContext {
    /** 目前 bridge 環境（與事件不同時事件一律丟棄） */
    environment: EsunEnvironment;
    /** bridge 目前登入的帳號（舊版 bridge 事件沒有 account 時使用） */
    account: Pick<Account, 'broker_id' | 'account_id'> | null;
    /** App 合約快取的交易所 */
    exchangeOf?: (code: string) => Exchange | undefined;
    /** 本地同一帳戶、同一 id（by 'ordno' 時為同一 ord_no）的委託 */
    lookup?: (orderId: string, account: Account, by?: 'id' | 'ordno') => EsunKnownOrder | undefined;
}

/** 失敗回報的操作別在本地推斷後仍未知：不能投影，只能由券商快照判定 */
export interface EsunUnresolvedFailure {
    opCode: string;
    opMsg: string;
}

export type EsunReportResult =
    | { kind: 'report'; wire: Rec; orderId: string; account: Account; unresolvedFailure?: EsunUnresolvedFailure }
    | { kind: 'skip'; reason: 'environment' | 'malformed' }
    /** 興櫃回報缺 *_qty_share：單位未知、不投影（bridge 快取也沒套用），只有權威讀取能對帳 */
    | { kind: 'skip'; reason: 'unit-unknown'; orderId: string };

const positiveInt = (v: unknown, min: number): number | null => {
    const n = num(v);
    return n !== null && Number.isSafeInteger(n) && n >= min ? n : null;
};

/**
 * 回報序號 → v1:esun-<sim|prod>-<order|deal>:<boot_id>.g<generation>:<report_seq>。
 * bridge 的 SSE seq（event_id 的 <boot_id>-<seq>）由 session／resync 事件共用，不能當回報序號；
 * report_seq 以（session generation, report_stream）為範圍、每次新 session 從 1 起算，所以
 * reset 段帶 generation（重新登入、環境來回切換都是新的基準）。缺 report_seq 或
 * session_generation（舊版 bridge）就不產生 v1 id：不做跳號推論。
 */
export function esunEventId(raw: Rec, environment: EsunEnvironment, fallbackStream?: 'order' | 'deal'): string {
    const id = str(raw.event_id);
    const dash = id.lastIndexOf('-');
    const boot = dash > 0 ? id.slice(0, dash) : '';
    const stream = str(raw.report_stream) || fallbackStream || '';
    const reportSeq = positiveInt(raw.report_seq, 1);
    const generation = positiveInt(raw.session_generation, 0);
    if (!boot || boot.includes(':') || (stream !== 'order' && stream !== 'deal') || reportSeq === null || generation === null) return '';
    return `v1:esun-${environment === 'SIMULATION' ? 'sim' : 'prod'}-${stream}:${boot}.g${generation}:${reportSeq}`;
}

/** ISO8601（含時區）或 epoch → epoch 秒 */
function epochSeconds(v: unknown): number | undefined {
    const n = num(v);
    if (n !== null) {
        if (n > 1e14) return n / 1e9;
        if (n > 1e11) return n / 1e3;
        return n > 0 ? n : undefined;
    }
    const text = str(v);
    if (!text) return undefined;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms / 1000 : undefined;
}

/** 舊版 bridge 的包裝形狀 {state, data:{StockOrder|StockDeal}} 解回扁平欄位 */
function flatten(payload: Rec): Rec {
    const data = rec(payload.data);
    const body = rec(data?.StockOrder) ?? rec(data?.StockDeal);
    return body ? { ...body, event_id: body.event_id ?? payload.event_id } : payload;
}

const OP_TYPES: Record<string, string> = {
    NEW: 'New',
    CANCEL: 'Cancel',
    DELETE: 'Cancel',
    MODIFYPRICE: 'UpdatePrice',
    UPDATEPRICE: 'UpdatePrice',
    MODIFYQTY: 'UpdateQty',
    UPDATEQTY: 'UpdateQty',
    REJECT: 'Reject',
};

function orderLotOf(apCode: string): string {
    if (apCode === EsunApCode.IntradayOdd || apCode === EsunApCode.Emg) return 'IntradayOdd';
    if (apCode === EsunApCode.Odd) return 'Odd';
    if (apCode === EsunApCode.AfterMarket) return 'Fixing';
    return 'Common';
}

/**
 * 興櫃（ap_code 4）回報只有 *_qty、沒有 *_qty_share（且數量不為 0）：單位無從判定，不能以推測的
 * 換算投影。缺少的數量欄位（委託量另由必要欄位檢查擋下）與 0 和單位無關，不在此列。
 */
function emgSharesMissing(raw: Rec, base: 'org' | 'mat' | 'cel', apCode: string): boolean {
    if (apCode !== EsunApCode.Emg) return false;
    const camel = { org: 'orgQty', mat: 'matQty', cel: 'celQty' }[base];
    if (num(raw[`${base}_qty_share`] ?? raw[`${camel}Share`]) !== null) return false;
    const lots = num(raw[`${base}_qty`] ?? raw[camel]);
    return lots !== null && lots !== 0;
}

function condOf(trade: string): { cond: string; daytradeShort: boolean } {
    if (trade === EsunTradeType.Margin) return { cond: 'MarginTrading', daytradeShort: false };
    if (trade === EsunTradeType.Short) return { cond: 'ShortSelling', daytradeShort: false };
    return { cond: 'Cash', daytradeShort: trade === EsunTradeType.DayTradingSell };
}

/**
 * 轉換一筆 bridge 回報。`event` 為 SSE 事件名稱（order、deal，或舊版 order_event）。
 * 環境不符（舊 session 的事件）或缺少必要欄位時回 skip。
 */
export function toEsunReportWire(event: string, payload: unknown, ctx: EsunReportContext): EsunReportResult {
    const outer = rec(payload);
    if (!outer) return { kind: 'skip', reason: 'malformed' };
    const raw = flatten(outer);
    const legacyState = str(outer.state);
    const isDeal = event === 'deal' || legacyState === 'StockDeal';

    const envText = str(raw.environment).toUpperCase();
    if (envText && envText !== ctx.environment) return { kind: 'skip', reason: 'environment' };

    const accountRef = rec(raw.account);
    const accountId = str(accountRef?.account_id ?? raw.account_id) || str(ctx.account?.account_id);
    const brokerId = str(accountRef?.broker_id ?? raw.broker_id) || str(ctx.account?.broker_id);
    if (!accountId) return { kind: 'skip', reason: 'malformed' };
    const account = esunAccountForEnvironment({ broker_id: brokerId, account_id: accountId }, ctx.environment);

    // 與委託查詢相同的穩定識別（pre_ord_no 優先），bridge 的 order_no 只作備援
    const orderId = esunOrderId(raw) || str(raw.order_no);
    const code = str(raw.stock_no ?? raw.stockNo ?? raw.code);
    const side = str(raw.buy_sell ?? raw.buySell).toUpperCase();
    const legacyAction = rec(raw.order)?.action ?? raw.action;
    const action = side.startsWith('B') ? 'Buy' : side.startsWith('S') ? 'Sell'
        : legacyAction === 'Buy' || legacyAction === 'Sell' ? legacyAction : '';
    const apCode = str(raw.ap_code ?? raw.apCode) || EsunApCode.Common;
    const eventId = esunEventId(raw, ctx.environment, isDeal ? 'deal' : 'order');
    const ts = epochSeconds(raw.ts) ?? esunTimestamp(raw.mat_date ?? raw.ord_date ?? raw.work_date, raw.mat_time ?? raw.ord_time);
    const { cond, daytradeShort } = condOf(str(raw.trade));
    const orderLot = orderLotOf(apCode);
    const exchange: Exchange = apCode === EsunApCode.Emg ? 'OES' : (ctx.exchangeOf?.(code) ?? 'TSE');
    if (!orderId || !code || !action) return { kind: 'skip', reason: 'malformed' };

    if (isDeal) {
        const matFields = {
            mat_qty: raw.mat_qty ?? raw.deal_qty ?? raw.qty,
            mat_qty_share: raw.mat_qty_share ?? raw.deal_qty_share,
        };
        // 預約單的本地 id 是 pre_ord_no；只帶 ord_no 的成交回報依 ord_no 找回本地同帳戶的委託
        const ordNo = str(raw.ord_no ?? raw.ordNo);
        const preOrdNo = str(raw.pre_ord_no ?? raw.preOrdNo);
        const tradeId = (!preOrdNo && ordNo ? ctx.lookup?.(ordNo, account, 'ordno')?.id : undefined) || orderId;
        // 興櫃成交沒有股數欄位：不投影（呼叫端提出委託與持倉只有權威讀取能解除的待對帳）
        if (emgSharesMissing(matFields, 'mat', apCode)) return { kind: 'skip', reason: 'unit-unknown', orderId: tradeId };
        const quantity = esunQuantityFromFields(matFields, 'mat', apCode);
        const price = num(raw.mat_price ?? raw.deal_price ?? raw.price);
        // 成交識別與 bridge 的 MAT 去重鍵（mkt_seq_num，Python `or` 取值：0、空字串視為沒有）一致，
        // 其次才是其他 SDK 欄位與事件 id
        const seq = esunMktSeqNum(raw) || str(raw.mat_no ?? raw.mat_seq ?? raw.deal_seq ?? raw.match_no ?? raw.seq_no)
            || str(raw.event_id);
        if (quantity === null || quantity <= 0 || price === null || price <= 0) return { kind: 'skip', reason: 'malformed' };
        const body: Rec = {
            trade_id: tradeId,
            exchange_seq: seq,
            code,
            action,
            price,
            quantity,
            order_lot: orderLot,
            order_cond: cond,
            broker_id: account.broker_id,
            account_id: account.account_id,
            seqno: tradeId,
            ordno: ordNo,
            ...(ts !== undefined ? { ts } : {}),
            event_id: eventId,
        };
        return { kind: 'report', orderId: tradeId, account, wire: { state: 'StockDeal', data: { StockDeal: body } } };
    }

    // 興櫃委託回報沒有股數欄位：不投影（呼叫端提出委託只有權威讀取能解除的待對帳）。失敗 ACK 同樣在此
    // 略過，待對帳不比可投影的失敗回報（unresolvedFailure 的 snapshot-boundary）寬鬆
    if ((['org', 'mat', 'cel'] as const).some(base => emgSharesMissing(raw, base, apCode))) {
        return { kind: 'skip', reason: 'unit-unknown', orderId };
    }
    const quantity = esunQuantityFromFields(raw, 'org', apCode);
    if (quantity === null || quantity <= 0) return { kind: 'skip', reason: 'malformed' };
    const dealt = esunQuantityFromFields(raw, 'mat', apCode) ?? 0;
    const cancelledTotal = esunQuantityFromFields(raw, 'cel', apCode) ?? 0;
    const price = num(raw.od_price ?? raw.odPrice ?? rec(raw.order)?.price) ?? 0;
    const known = ctx.lookup?.(orderId, account);

    let opType = OP_TYPES[str(raw.op_type ?? rec(raw.operation)?.op_type).toUpperCase().replace(/[^A-Z]/g, '')] ?? '';
    if (!opType && known) {
        // bridge 推不出操作別（Unknown）：依本地同一筆委託的累計量推斷
        if (cancelledTotal > known.cancelQuantity) opType = dealt + cancelledTotal >= quantity ? 'Cancel' : 'UpdateQty';
        else if (price > 0 && price !== known.price) opType = 'UpdatePrice';
    }
    // 累計取消量 → 這次操作的取消量（Cancel 依本地已知取消量累加；UpdateQty 以委託剩餘量為準）
    const previous = known?.cancelQuantity ?? 0;
    const thisCancel = opType === 'Cancel' || opType === 'UpdateQty'
        ? Math.max(0, cancelledTotal - (known ? previous : 0))
        : cancelledTotal;
    const errCode = str(raw.err_code ?? raw.errCode ?? rec(raw.operation)?.op_code);
    const failed = isEsunFailureCode(errCode);
    const opMsg = str(raw.err_msg ?? raw.errMsg ?? rec(raw.operation)?.op_msg);
    const ordNo = str(raw.ord_no ?? raw.ordNo);
    // 預約單（還沒有委託書號，只有 pre_ord_no 或 ord_status 1）：投影時維持 PreSubmitted 而不是 Submitted
    const reservation = !ordNo && (str(raw.pre_ord_no ?? raw.preOrdNo) !== '' || str(raw.ord_status ?? raw.ordStatus) === '1');
    const body: Rec = {
        operation: {
            op_type: opType,
            op_code: failed ? errCode : '00',
            op_msg: opMsg,
        },
        order: {
            id: orderId,
            seqno: orderId,
            ordno: ordNo,
            action,
            price,
            quantity,
            order_type: str(raw.bs_flag ?? raw.bsFlag).toUpperCase() === 'I' ? 'IOC' : str(raw.bs_flag ?? raw.bsFlag).toUpperCase() === 'F' ? 'FOK' : 'ROD',
            price_type: str(raw.price_flag ?? raw.priceFlag) === '4' ? 'MKT' : 'LMT',
            order_lot: orderLot,
            order_cond: cond,
            daytrade_short: daytradeShort,
            ...(str(raw.user_def ?? raw.memo) ? { custom_field: str(raw.user_def ?? raw.memo) } : {}),
            account: { broker_id: account.broker_id, account_id: account.account_id, account_type: 'S' },
        },
        status: {
            id: orderId,
            ...(reservation ? { status: 'PreSubmitted' } : {}),
            ...(ts !== undefined ? { exchange_ts: ts } : {}),
            // 減量回報：order_quantity 為減量後的委託量（委託量 − 累計取消量）
            order_quantity: opType === 'UpdateQty' ? Math.max(0, quantity - cancelledTotal) : quantity,
            deal_quantity: dealt,
            cancel_quantity: thisCancel,
            modified_price: opType === 'UpdatePrice' ? price : 0,
        },
        contract: { security_type: 'STK', exchange, code },
        event_id: eventId,
    };
    // 失敗回報推不出操作別（bridge Unknown、本地也推斷不出）：可能是新單被拒，也可能是刪改單被拒。
    // 上游投影對操作別空白的失敗回報不改本地委託；呼叫端另外提出只有權威讀取能解除的待對帳。
    const unresolvedFailure = failed && !opType ? { opCode: errCode, opMsg } : undefined;
    return {
        kind: 'report', orderId, account, wire: { state: 'StockOrder', data: { StockOrder: body } },
        ...(unresolvedFailure ? { unresolvedFailure } : {}),
    };
}
