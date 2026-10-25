// src/lib/esun/dispatch.ts — 上游模組與玉山 service 之間的掛鉤（fork 專屬）
//
// 上游檔案（shioaji.ts、trade.ts、order-confirm.ts、trading-state.ts）只留一兩行呼叫
// 這裡的函式；玉山帳戶以外一律回 null／原樣，交回上游原本的流程。
//
// 安全規則與上游相同：
// - 送單閘門：帳戶仍在清單內且可交易、主視窗交易狀態同步（同 sendOrderMutation／apiPost）。
// - 刪單 HTTP 成功不等於已取消：以同帳戶回讀確認（verifyCancellation），否則結果未知。
// - 改價／改量登記 mutation intent，讓之後的回報能確認這一筆。
// - 結果未知（逾時、5xx、outcome unknown）沿用上游旗標，絕不自動重送。

import { canTrade } from '../account-tradable';
import { getAccountState } from '../account-store';
import { verifyCancellation, type CancelBatchMember } from '../cancel-verification';
import { noteMutationIntent } from '../mutation-intent';
import { isTauri } from '../runtime';
import { markConfirmedCancellation } from '../trade-mutations';
import { observeTradeResponse } from '../trade-observations';
import { getTradingMirrorFresh } from '../trading-mirror-lease';
import type { ServerModeGuard } from '../server-info-store';
import type { ContractBase } from '../types/contract';
import type { Action, OrderType, StockOrderCond, StockOrderLot, StockOrderReq, Trade, TradeCacheHealth } from '../types/order';
import type { Account } from '../types/portfolio';
import { esunUnresolvedFailureOf, isEsunAccount, isEsunBroker, validateEsunStockOrder } from './order-mapping';
import { esunTradeService } from './service';
import { ensureEsunOrderStream, getEsunStreamStatus, isEsunStreamStarted, onEsunStreamSignal } from './stream';
import { ESUN_BROKER_NAME } from './types';

const notStarted = (message: string) => Object.assign(new Error(message), { mutationNotStarted: true as const });

// ---- 帳戶 ----

/** 探測失敗後的冷卻：帳戶載入是啟動熱路徑，bridge 不在時不要每次都等 3～6 秒 */
export const ESUN_PROBE_RETRY_MS = 10_000;
let lastProbeFailure = 0;

function connectEsunBridge(): Promise<unknown> {
    // Vitest：不探測真實 /esun（測試以 setDriver/registerAccount 自行注入）
    if (import.meta.env?.MODE === 'test') return Promise.resolve(null);
    if (!esunTradeService.getBridgeHealth() && Date.now() - lastProbeFailure < ESUN_PROBE_RETRY_MS) return Promise.resolve(null);
    return esunTradeService.connectBridge().then(health => {
        if (!health) lastProbeFailure = Date.now();
        else if (health.ok) ensureEsunOrderStream();
        return health;
    }).catch(() => null);
}

/**
 * 帳戶清單：永豐帳戶在前、玉山帳戶附加在後（維持上游 stocks[0] 的預設選取；
 * 要預設用玉山由已存的選取決定）。永豐失敗照常丟出（帳戶清單保留原狀並標示載入失敗），
 * 永豐回空清單時也不合併玉山：玉山不能在永豐短暫失敗時被靜默選成下單帳戶。
 */
export function fetchAccountsWithEsun(fetchSinopac: () => Promise<Account[]>): Promise<Account[]> {
    return connectEsunBridge().then(fetchSinopac).then(accounts => {
        if (!Array.isArray(accounts) || accounts.length === 0) return accounts;
        const esun = esunTradeService.getAccounts()
            .filter(e => !accounts.some(a => a.broker_id === e.broker_id && a.account_id === e.account_id));
        return esun.length ? [...accounts, ...esun] : accounts;
    });
}

/** 憑證效期：只有明確指定玉山帳戶才查玉山，其餘一律走永豐（呼叫端查的是永豐憑證） */
export function esunCaExpire(personId: string, account?: Pick<Account, 'broker_id'> | null) {
    if (!account || !isEsunAccount(account)) return null;
    return esunTradeService.fetchCaExpire(personId).then(expire_time => ({ person_id: personId, expire_time }));
}

/** 玉山帳戶的「訂閱回報」＝啟動玉山回報串流 */
export function subscribeEsunTradeEvents(account: Pick<Account, 'broker_id'>): Promise<void> | null {
    if (!isEsunAccount(account)) return null;
    ensureEsunOrderStream();
    return Promise.resolve();
}

// ---- 送單閘門 ----

/** 與 sendOrderMutation 相同的送出閘門：帳戶仍在清單且可交易、主視窗交易狀態同步 */
function assertDispatchable(account: Account) {
    const current = getAccountState().accounts.find(a => a.account_type === account.account_type
        && a.broker_id === account.broker_id && a.account_id === account.account_id);
    if (!canTrade(current)) {
        throw Object.assign(new Error('伺服器模式或帳戶已變更，帳戶不可交易；未送出此筆'),
            { mutationNotStarted: true as const, tradingGateRejected: true as const });
    }
    if (!getTradingMirrorFresh()) {
        throw notStarted('主視窗交易狀態未同步，委託尚未送出；請重新開啟主視窗');
    }
}

function refuseAgent(agentInitiated?: boolean) {
    // 桌面版的 Agent 委託必須經 Agent Harness 簽署；玉山委託不經過 sidecar，無法簽署
    if (agentInitiated && isTauri) throw notStarted('桌面版 Agent 不能操作玉山證券帳戶（玉山委託不經 Agent Harness 簽署）；未送出');
}

/** placeStockOrder 的玉山分支（上游的零股與信用規則已先檢查過） */
export function placeEsunStockOrder(
    contract: ContractBase,
    order: StockOrderReq,
    account: Account,
    opts?: { agentInitiated?: boolean; beforeDispatch?: () => void; onResponse?: (res: Response) => void },
): Promise<Trade> {
    try {
        refuseAgent(opts?.agentInitiated);
        assertDispatchable(account);
    } catch (error) {
        return Promise.reject(error);
    }
    return esunTradeService.placeStockOrder(contract, order, account, {
        onResponse: opts?.onResponse,
        beforeDispatch: () => {
            assertDispatchable(account);
            opts?.beforeDispatch?.();
        },
    }).then(trade => observeTradeResponse(trade, account));
}

/** placeQuickOrder 的玉山額外規則（上游 stockOrderProblem 之外；非玉山帳戶回 null） */
export function esunQuickOrderProblem(
    account: Account | null | undefined,
    contract: ContractBase,
    input: { action: Action; price: number | null; quantity: number; orderType?: OrderType; orderLot?: StockOrderLot; orderCond?: StockOrderCond; daytradeShort?: boolean },
): string | null {
    if (!isEsunAccount(account)) return null;
    return validateEsunStockOrder(contract, {
        action: input.action,
        price: input.price ?? 0,
        quantity: input.quantity,
        price_type: input.price === null ? 'MKT' : 'LMT',
        order_type: input.price === null ? 'IOC' : (input.orderType ?? 'ROD'),
        order_lot: input.orderLot ?? 'Common',
        order_cond: input.orderCond,
        daytrade_short: input.daytradeShort,
    });
}

// ---- 刪單（刪單確認） ----

/** 確認回讀遇到 bridge 的 refresh 節流（429 AGR0005）時，依 retry_after 最多等這麼久再重讀一次 */
export const ESUN_CONFIRM_RETRY_MAX_MS = 6_000;

/** refresh 節流（429 AGR0005）時依 retry_after（上限 6 秒）重讀一次；其他錯誤照原樣丟出 */
async function readThroughThrottle<T>(read: () => Promise<T>): Promise<T> {
    try {
        return await read();
    } catch (error) {
        const e = error as { status?: unknown; code?: unknown; retryAfter?: unknown } | null;
        if (e?.status !== 429 || e.code !== 'AGR0005') throw error;
        const seconds = typeof e.retryAfter === 'number' && Number.isFinite(e.retryAfter) ? e.retryAfter : Number.POSITIVE_INFINITY;
        const waitMs = Math.min(ESUN_CONFIRM_RETRY_MAX_MS, Math.max(0, seconds * 1000));
        await new Promise<void>(resolve => { globalThis.setTimeout(resolve, waitMs); });
        return read();
    }
}

/**
 * 玉山刪單：送出後以同帳戶回讀確認（CONTEXT「刪單確認」）。bridge 委託快取不是券商回讀，
 * 一律直接做一次 refresh:true（遇到 refresh 節流時依 retry_after 重讀一次）；回讀不到 Cancelled
 * 且取消量涵蓋剩餘量就丟出 CANCEL_UNCONFIRMED（結果未知，不重送）。
 */
export async function cancelEsunOrder(
    before: Trade,
    account: Account,
    opts: { beforeSend?: () => void; batch?: CancelBatchMember; agentInitiated?: boolean } = {},
): Promise<Trade> {
    refuseAgent(opts.agentInitiated);
    assertDispatchable(account);
    const generation = esunTradeService.getSessionGeneration();
    await esunTradeService.cancelOrder(before, account, {
        beforeDispatch: () => {
            assertDispatchable(account);
            opts.beforeSend?.();
        },
    });
    const { trade } = await verifyCancellation(before, account, {
        scope: `esun|${account.broker_id}:${account.account_id}|session:${generation ?? '?'}`,
        cacheTrusted: () => false,
        locallyCancelled: () => false,
        guard: () => {
            assertAccountListed(account);
            if (esunTradeService.getSessionGeneration() !== generation) throw new Error('刪單後玉山 session 已變更');
        },
        // 全部刪單／全平並取消先做過 refresh:true：確認回讀可能落在 bridge 的間隔內
        readTrades: refresh => readThroughThrottle(() => esunTradeService.fetchTrades(account, refresh)),
        readHealth: async () => esunCacheHealth(),
        batch: opts.batch,
    });
    return markConfirmedCancellation({ ...trade, account });
}

function assertAccountListed(account: Account) {
    if (!getAccountState().accounts.some(a => a.account_type === account.account_type
        && a.broker_id === account.broker_id && a.account_id === account.account_id && canTrade(a))) {
        throw new Error('刪單後玉山帳戶已不可用');
    }
}

// ---- 改價／改量 ----

/** updateOrderPrice 的玉山分支：登記 intent 後送出，回傳的 Trade 只代表「已送出」 */
export function updateEsunOrderPrice(tradeId: string, trade: Trade, account: Account, price: number): Promise<Trade> {
    assertDispatchable(account);
    return esunTradeService.updateOrderPrice(trade, price, account, {
        beforeDispatch: () => {
            assertDispatchable(account);
            noteMutationIntent(tradeId, { kind: 'price', price });
        },
    });
}

/** updateOrderQty 的玉山分支：`quantity` 為減少量（上游語意） */
export function updateEsunOrderQty(tradeId: string, trade: Trade, account: Account, quantity: number): Promise<Trade> {
    assertDispatchable(account);
    return esunTradeService.updateOrderQty(trade, quantity, account, {
        beforeDispatch: () => {
            assertDispatchable(account);
            noteMutationIntent(tradeId, { kind: 'qty', quantity });
        },
    });
}

// ---- 查詢 ----

// 最近一次權威委託讀取（refresh:true）時的 bridge session 代次：代次變了就不能拿快取重建
let authoritativeGeneration: number | null | undefined;

const esunAccountKey = (a: Pick<Account, 'account_type' | 'broker_id' | 'account_id'>) => `${a.account_type}:${a.broker_id}:${a.account_id}`;

// 進行中的權威委託讀取（esunAccountQuery 的 refresh:true，依帳戶）：bridge 保證這些讀取回傳的
// 快照不比讀取進行中才完成的背景快照舊
const authoritativeReads = new Map<string, Set<Promise<unknown>>>();

function trackAuthoritativeRead(account: Account, read: Promise<unknown>) {
    const key = esunAccountKey(account);
    const reads = authoritativeReads.get(key) ?? new Set();
    reads.add(read);
    authoritativeReads.set(key, reads);
    const done = () => {
        reads.delete(read);
        if (reads.size === 0 && authoritativeReads.get(key) === reads) authoritativeReads.delete(key);
    };
    read.then(done, done);
}

/** 每個玉山帳戶都有進行中的權威讀取時回傳這些讀取，否則 null */
function authoritativeReadsCoveringAll(): Promise<unknown>[] | null {
    const accounts = esunTradeService.getAccounts();
    if (!accounts.length) return null;
    const reads: Promise<unknown>[] = [];
    for (const account of accounts) {
        const pending = authoritativeReads.get(esunAccountKey(account));
        if (!pending?.size) return null;
        reads.push(...pending);
    }
    return reads;
}

const ESUN_DOWN_MESSAGE = '玉山回報串流中斷，期間可能漏收委託／成交回報；重新連線後請確認';
let lastDownMessage = ESUN_DOWN_MESSAGE;

/**
 * 權威讀取在玉山回報串流中斷期間完成：trading-state 會以這次讀取 resolve 讀取開始前的
 * disconnect（它只看永豐串流），但讀取之後到串流恢復之前的回報仍會漏收。讀取完成時重新
 * 提出（新的原因時間晚於讀取開始），等串流恢復後由 reconnect 的健康檢查／對帳處理。
 */
function keepDisconnectWhileDown(scope: 'orders' | 'positions') {
    if (getEsunStreamStatus() === 'down') hooks?.raise(scope, 'disconnect', lastDownMessage);
}

/** 玉山的 trade_cache_health：依回報串流與 session 連續性回報（不呼叫券商） */
export function esunCacheHealth(): TradeCacheHealth {
    if (!isEsunStreamStarted()) return { state: 'Degraded', reasons: [{ event_type: 'StockOrder', reason: 'NotSubscribed' }] };
    if (getEsunStreamStatus() !== 'live') return { state: 'Degraded', reasons: [] };
    if (authoritativeGeneration === undefined || authoritativeGeneration !== esunTradeService.getSessionGeneration()) {
        return { state: 'Degraded', reasons: [] };
    }
    return { state: 'Healthy', reasons: [] };
}

/** accountQueryPost 的玉山分派；非玉山帳戶回 null（交回上游 apiPost） */
export function esunAccountQuery<T>(path: string, account: Account, extra: Record<string, unknown> = {}): Promise<T> | null {
    if (!isEsunAccount(account)) return null;
    switch (path) {
        case '/api/v1/order/trades': {
            // 上游語意：省略 refresh 時伺服器預設為 true（權威讀取）
            const refresh = extra.refresh === undefined ? true : Boolean(extra.refresh);
            const generation = esunTradeService.getSessionGeneration();
            const read = esunTradeService.fetchTrades(account, refresh).then(rows => {
                const skipped = esunTradeService.lastSkippedOrderRows;
                if (skipped > 0) {
                    hooks?.raise('orders', 'pending-report', `玉山委託資料有 ${skipped} 筆缺少必要欄位，已略過；請手動對帳`);
                }
                if (refresh) {
                    authoritativeGeneration = generation;
                    keepDisconnectWhileDown('orders');
                    raiseUnconfirmedFailures(rows);
                }
                return rows as T;
            });
            if (refresh) trackAuthoritativeRead(account, read);
            return read;
        }
        case '/api/v1/order/trade_cache_health':
            return Promise.resolve(esunCacheHealth() as T);
        case '/api/v1/portfolio/position_unit': {
            const unit = (extra.unit === 'Share' ? 'Share' : 'Common') as 'Common' | 'Share';
            return esunTradeService.fetchPositions(account, unit).then(rows => {
                keepDisconnectWhileDown('positions');
                return rows;
            }) as Promise<T>;
        }
        case '/api/v1/portfolio/account_balance':
            return esunTradeService.fetchAccountBalance(account) as Promise<T>;
        case '/api/v1/portfolio/settlements':
            return esunTradeService.fetchSettlements(account) as Promise<T>;
        case '/api/v1/portfolio/profit_loss':
            return esunTradeService.fetchProfitLoss(account, String(extra.begin_date ?? ''), String(extra.end_date ?? '')) as Promise<T>;
        case '/api/v1/portfolio/profitloss_sum':
            return esunTradeService.fetchProfitLossSummary(account, String(extra.begin_date ?? ''), String(extra.end_date ?? '')) as Promise<T>;
        case '/api/v1/portfolio/trading_limits':
            return esunTradeService.fetchTradingLimits(account) as Promise<T>;
        case '/api/v1/portfolio/stock_reserve_summary':
        case '/api/v1/order/stock_reserve_summary':
            return esunTradeService.fetchStockReserveSummary(account) as Promise<T>;
        case '/api/v1/order/stock_reserve_detail':
        case '/api/v1/order/earmarking_detail':
            return Promise.resolve({ stocks: [], account } as T);
        default:
            return Promise.reject(new Error(`玉山證券帳戶暫不支援此查詢 (${path})`));
    }
}

/** 損益面板（30 日已實現損益）的玉山查詢；非玉山帳戶回 null */
export function esunProfitLossRows(account: Account, beginDate: string, endDate: string): Promise<{ date: string; pnl: number }[]> | null {
    if (!isEsunAccount(account)) return null;
    return esunTradeService.fetchProfitLoss(account, beginDate, endDate)
        .then(rows => rows.map(r => ({ date: r.date, pnl: r.pnl })));
}

// ---- 委託確認視窗 ----

/** 確認視窗帳號標籤的券商段：玉山帳戶一律顯示「玉山證券」（帳戶鍵的 -SIM 後綴不外露） */
export function esunConfirmBrokerLabel(brokerId: string): string {
    return isEsunBroker(brokerId) ? ESUN_BROKER_NAME : brokerId;
}

type ConfirmLabel = { accountLabel?: string } | null | undefined;

/** 確認視窗的帳戶標籤中有幾個玉山帳戶（accountConfirmLabel 以「玉山證券-」開頭） */
function esunShare(request: ConfirmLabel): 'none' | 'all' | 'mixed' {
    const label = request?.accountLabel ?? '';
    const entries = label.split(/[：、]/).map(s => s.trim()).filter(s => /-[*•\d]/.test(s));
    const esun = entries.filter(s => s.includes(`${ESUN_BROKER_NAME}-`)).length;
    if (esun === 0) return 'none';
    return esun === entries.length ? 'all' : 'mixed';
}

/**
 * 確認視窗的環境徽章：玉山帳戶的委託顯示玉山 bridge 的環境（未知為 null，不能確認）；
 * 玉山與永豐混合的分倉，兩邊環境一致才顯示，否則為 null。
 */
export function esunConfirmSimulation(request: ConfirmLabel, sinopac: boolean | null): boolean | null {
    const share = esunShare(request);
    if (share === 'none') return sinopac;
    const esun = esunTradeService.isEnvironmentKnown() ? esunTradeService.isSimulation() : null;
    if (share === 'all') return esun;
    return esun !== null && esun === sinopac ? sinopac : null;
}

/** 確認期間玉山環境或 session 變了就不送（與上游伺服器模式閘門合併） */
export function esunConfirmGuard(guard: ServerModeGuard, request: ConfirmLabel): ServerModeGuard {
    if (esunShare(request) === 'none') return guard;
    const snapshot = () => `${esunTradeService.isEnvironmentKnown()}|${esunTradeService.getEnvironment()}|${esunTradeService.getSessionGeneration()}`;
    const captured = snapshot();
    const same = (() => guard() && snapshot() === captured) as ServerModeGuard;
    same.rebaseIfUnknown = () => guard.rebaseIfUnknown();
    same.snapshot = () => guard.snapshot();
    same.rebaseTo = snap => guard.rebaseTo(snap);
    return same;
}

/** 玉山環境快照變更通知（確認視窗用來即時標示「環境已變更」） */
export function subscribeEsunEnvironment(listener: () => void): () => void {
    return esunTradeService.subscribe(listener);
}

// ---- trading-state ----

export type EsunReconcileScope = 'orders' | 'positions' | 'account';

export interface EsunTradingHooks {
    /** 提出待對帳原因（trading-state 的 raise） */
    raise(scope: EsunReconcileScope, reason: 'disconnect' | 'sequence-gap' | 'pending-report' | 'untrackable-event' | 'snapshot-boundary', message: string): void;
    /** 玉山帳戶出現、被替換（環境切換）或 bridge 重新登入：清掉離開清單的帳戶資料並立即重讀
     *  （trading-state 在第一次串流連線前不讀，初次讀取本來就會包含目前的帳戶） */
    accountsChanged(): Promise<void>;
    /** trade_cache_health 檢查（重連、跳號時；全部 Healthy 時以快取重建委託） */
    checkHealth(trigger: 'reconnect' | 'gap'): Promise<void>;
}

let hooks: EsunTradingHooks | null = null;

export const ESUN_STALE_CACHE_MESSAGE = '玉山 bridge 重新連線後未能重讀委託，快取可能缺少斷線期間的成交／取消；請按更新確認';
export const ESUN_UNREFRESHED_CACHE_MESSAGE = '玉山 bridge 未能重讀委託，快取可能缺少部分成交／取消；請按更新確認';
/** failed_ack_refreshed：快取重建（CACHE_RESYNC_RESOLVES 的 sequence-gap）即可解除 */
export const ESUN_FAILED_ACK_REFRESHED_MESSAGE = 'bridge 已依失敗回報重讀委託，快取同步中';
export const ESUN_FAILED_ACK_REFRESH_FAILED_MESSAGE = '玉山 bridge 依失敗回報重讀委託失敗，快取未反映被拒的操作；請按更新確認';

const ESUN_TERMINAL_STATUSES: readonly string[] = ['Filled', 'Cancelled', 'Failed'];

/** 快取重建遇到矛盾、保留本地列時提出的待對帳訊息（cause 依委託 id 區分） */
export function esunCacheConflictMessage(orderId: string): string {
    return `玉山 bridge 快取的委託 ${orderId} 與本地不一致（成交／取消量較低或狀態未終結），已保留本地資料；請按更新確認`;
}

/**
 * 失敗回報無法判定被拒的是哪一項操作時提出的待對帳訊息（SSE 回報與快取列的
 * esun_unresolved_failure 共用；cause 依委託 id 與失敗碼區分，同一筆失敗只列一次）
 */
export function esunUnresolvedFailureMessage(orderId: string, opCode: string): string {
    const code = opCode ? `（${opCode}）` : '';
    return `玉山委託 ${orderId} 收到失敗回報${code}，無法判定被拒的是新單、刪單或改單，已保留本地資料；請按更新確認`;
}

/** 權威讀取的列同時帶 esun_unresolved_failure 與 esun_snapshot_missing（券商最近一次快照沒列出）時的訊息 */
export function esunSnapshotMissingFailureMessage(orderId: string, opCode: string): string {
    const code = opCode ? `（${opCode}）` : '';
    return `玉山委託 ${orderId} 收到失敗回報${code}，券商最近一次委託查詢沒有列出這筆，仍無法判定被拒的操作；請稍後按更新確認`;
}

/**
 * 權威讀取（refresh:true）回傳的列同時帶 esun_unresolved_failure 與 esun_snapshot_missing：bridge
 * 只是因近期保留而列出它，券商快照沒有判定這筆失敗，不能當成已確認。在讀取完成前（原因時間晚於
 * 讀取開始）對 orders 提出 snapshot-boundary，同一次讀取不會解除，只有之後的權威讀取能解除。
 * 只帶其中一個旗標的列不在這裡處理（維持上游語意：權威讀取以快照為準）。
 */
function raiseUnconfirmedFailures(rows: Trade[]) {
    for (const row of rows) {
        const unresolved = esunUnresolvedFailureOf(row);
        if (unresolved?.snapshotMissing) {
            hooks?.raise('orders', 'snapshot-boundary', esunSnapshotMissingFailureMessage(row.order.id, unresolved.opCode));
        }
    }
}

/**
 * trading-state 快取重建（refresh:false 的 upsert）合併一筆本地列時的玉山規則。快取列的成交量與
 * 取消量都不低於本地、且狀態不矛盾時採用快取列（補回漏收的回報，這是快取重建的目的）。
 * 快取列的成交量或取消量低於本地，或本地已是終態（Filled／Cancelled／Failed）而快取列不是時，
 * 前端無法判定哪一方正確（快照落後與推播落後的資料形狀相同）：保留本地列，並對 orders 提出
 * snapshot-boundary（不在 CACHE_RESYNC_RESOLVES，只有權威讀取能解除）。非玉山帳戶原樣回傳快取列
 * （上游語意）。權威讀取（replace）不經過這裡。快取列帶 esun_unresolved_failure（bridge 收到對到
 * 這筆委託的失敗 ACK、還沒有快照判定）時同樣保留本地列並提出 snapshot-boundary。
 */
export function esunCacheUpsertRow<T extends Trade & { account?: Account }>(local: T, cached: T): T {
    if (!isEsunAccount(cached.account ?? local.account)) return cached;
    const unresolved = esunUnresolvedFailureOf(cached);
    if (unresolved) {
        hooks?.raise('orders', 'snapshot-boundary', esunUnresolvedFailureMessage(local.order.id, unresolved.opCode));
        return local;
    }
    const behind = cached.status.deal_quantity < local.status.deal_quantity
        || cached.status.cancel_quantity < local.status.cancel_quantity;
    const reopened = ESUN_TERMINAL_STATUSES.includes(local.status.status)
        && !ESUN_TERMINAL_STATUSES.includes(cached.status.status);
    if (!behind && !reopened) return cached;
    hooks?.raise('orders', 'snapshot-boundary', esunCacheConflictMessage(local.order.id));
    return local;
}

function esunAccountKeys() {
    return esunTradeService.getAccounts().map(esunAccountKey).sort().join('|');
}

/** trading-state.start() 呼叫：玉山 session／串流事件 → 重讀、待對帳原因、快取重建 */
export function startEsunTradingState(next: EsunTradingHooks): () => void {
    hooks = next;
    let keys = esunAccountKeys();
    let generation = esunTradeService.getSessionGeneration();
    const stopService = esunTradeService.subscribe(() => {
        const nextKeys = esunAccountKeys();
        const nextGeneration = esunTradeService.getSessionGeneration();
        const changed = nextKeys !== keys;
        const relogged = generation !== null && nextGeneration !== null && nextGeneration !== generation;
        keys = nextKeys;
        generation = nextGeneration;
        if (changed || relogged) void next.accountsChanged();
    });
    const stopStream = onEsunStreamSignal(signal => {
        if (!esunTradeService.getAccounts().length) return;
        if (signal.kind === 'down') {
            lastDownMessage = signal.message || ESUN_DOWN_MESSAGE;
            next.raise('orders', 'disconnect', lastDownMessage);
            next.raise('positions', 'disconnect', lastDownMessage);
        } else if (signal.kind === 'reconnected') {
            void esunTradeService.refreshHealth().then(() => next.checkHealth('reconnect'));
        } else if (signal.kind === 'untrackable') {
            // 收到但無法轉換的回報：不能投影，也不能靜默丟棄
            const message = '玉山回報無法解析（欄位不足或環境未知），已略過；請手動對帳';
            next.raise('orders', 'untrackable-event', message);
            if (signal.deal) next.raise('positions', 'untrackable-event', message);
        } else if (signal.kind === 'unresolved-failure') {
            // 失敗回報推不出操作別：本地委託不變（上游投影），只有權威讀取（券商快照）能判定
            next.raise('orders', 'snapshot-boundary', esunUnresolvedFailureMessage(signal.orderId, signal.opCode));
        } else if (signal.reason === 'failed_ack_refreshed' && signal.cacheRefreshed === true) {
            // bridge 已依失敗 ACK 做完背景權威查詢並套用快照：沒有漏收回報，持倉不受影響。只提出一個
            // 快取重建能解除的 orders 原因（讓健康檢查以快取重建委託）。每個玉山帳戶都有進行中的權威讀取時
            // 不提出（bridge 保證那些讀取的快照不比背景快照舊）；那些讀取失敗時才補提出
            const rebuild = () => {
                if (hooks !== next) return;
                next.raise('orders', 'sequence-gap', ESUN_FAILED_ACK_REFRESHED_MESSAGE);
                void next.checkHealth('gap');
            };
            const covering = authoritativeReadsCoveringAll();
            if (!covering) rebuild();
            else void Promise.allSettled(covering).then(results => { if (results.some(r => r.status === 'rejected')) rebuild(); });
        } else if (signal.reason === 'failed_ack_refresh_failed') {
            // bridge 的背景權威查詢重試用盡：快取沒有反映失敗 ACK 的結果，快取重建不能解除（也沒有漏收回報，
            // 不提出 positions 的原因、不做快取重建）。只有權威讀取能清除
            next.raise('orders', 'snapshot-boundary', ESUN_FAILED_ACK_REFRESH_FAILED_MESSAGE);
        } else {
            const message = '玉山回報漏收超過 bridge 補送範圍；以 bridge 委託快取重建中，必要時請手動對帳';
            next.raise('orders', 'sequence-gap', message);
            next.raise('positions', 'sequence-gap', message);
            // bridge 沒能重讀委託快取（cacheRefreshed:false；ws_reconnected 未帶旗標時也視為沒有重讀）：
            // 快取可能缺少期間的回報，快取重建不能解除。snapshot-boundary 不在 CACHE_RESYNC_RESOLVES，只有權威讀取能清除
            if (signal.cacheRefreshed === false || (signal.reason === 'ws_reconnected' && signal.cacheRefreshed !== true)) {
                next.raise('orders', 'snapshot-boundary', signal.reason === 'ws_reconnected' ? ESUN_STALE_CACHE_MESSAGE : ESUN_UNREFRESHED_CACHE_MESSAGE);
            }
            void next.checkHealth('gap');
        }
    });
    return () => {
        if (hooks === next) hooks = null;
        stopService();
        stopStream();
    };
}
