// src/lib/esun/stream.ts — esun-bridge 回報串流（/esun/stream/orders）的生命週期
//
// - 與行情串流同一個擁有者：只有持有行情 SSE 的視窗連線玉山 SSE，事件經同一條
//   BroadcastChannel 分送其他視窗（一個來源只佔一條長連線）。
// - 斷線交給 EventSource 原生重連，才會帶 Last-Event-ID 讓 bridge 補送；連線被關閉
//   （HTTP 錯誤）時才自行以退避重建。超過 80 秒沒有任何事件或心跳視為停滯並重連。
// - `order`／`deal` 轉成上游回報管線格式後送進 stream.ts 的回報處理；`session` 更新
//   esunTradeService 的環境快照；`resync`（漏收超過補送範圍）交給 trading-state 以快取重建。

import { isStreamOwner, onStreamEvent, publishStreamEvent, subscribeStreamOwner } from '../stream';
import { getCachedContract } from '../contracts-cache';
import type { Account } from '../types/portfolio';
import { bridgeBase, esunTradeService } from './service';
import { toEsunReportWire, type EsunKnownOrder } from './report-adapter';
import type { EsunSessionInfo } from './types';

export type EsunStreamStatus = 'idle' | 'connecting' | 'live' | 'down';
export type EsunStreamSignal =
    | { kind: 'down'; message: string }
    | { kind: 'reconnected' }
    | { kind: 'resync' };

const STATUS_EVENT = 'esun_status';
const SESSION_EVENT = 'esun_session';
const RESYNC_EVENT = 'esun_resync';
/** bridge 每 25 秒送心跳；超過兩個週期加寬限沒有任何訊息就視為停滯 */
export const ESUN_STREAM_STALE_MS = 80_000;
const RETRY_MAX_MS = 30_000;

let started = false;
let es: EventSource | null = null;
let status: EsunStreamStatus = 'idle';
let everLive = false;
let liveBeforeThisConnection = false;
let lastActivity = 0;
let retryDelay = 1_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
const stops: (() => void)[] = [];
const signalListeners = new Set<(signal: EsunStreamSignal) => void>();
let tradingModule: typeof import('../trading-state') | null = null;

/** 這個視窗看到的玉山串流狀態（擁有者為實際連線，其他視窗為擁有者廣播的狀態） */
export function getEsunStreamStatus(): EsunStreamStatus {
    return status;
}

/** 已啟動玉山回報串流（等同「已訂閱」） */
export function isEsunStreamStarted(): boolean {
    return started;
}

export function onEsunStreamSignal(listener: (signal: EsunStreamSignal) => void): () => void {
    signalListeners.add(listener);
    return () => { signalListeners.delete(listener); };
}

function signal(value: EsunStreamSignal) {
    for (const listener of signalListeners) {
        try { listener(value); } catch { /* a display hook cannot break the stream */ }
    }
}

/** 套用（自己或擁有者廣播的）狀態，並在 live ↔ 非 live 轉換時通知 trading-state */
function applyStatus(next: EsunStreamStatus) {
    const prev = status;
    if (prev === next) return;
    status = next;
    if (next === 'live') {
        if (everLive && prev !== 'live') signal({ kind: 'reconnected' });
        everLive = true;
    } else if (prev === 'live') {
        signal({ kind: 'down', message: '玉山回報串流中斷，期間可能漏收委託／成交回報；重新連線後請確認' });
    }
}

function publishStatus(next: EsunStreamStatus) {
    publishStreamEvent(STATUS_EVENT, JSON.stringify({ status: next }));
}

function activity() {
    lastActivity = Date.now();
}

function knownOrder(orderId: string, account: Account): EsunKnownOrder | undefined {
    const row = tradingModule?.getTradingState().trades.find(t => t.order.id === orderId && t.account
        && t.account.broker_id === account.broker_id && t.account.account_id === account.account_id);
    return row ? {
        quantity: row.order.quantity,
        dealQuantity: row.status.deal_quantity,
        cancelQuantity: row.status.cancel_quantity,
        price: row.order.price,
    } : undefined;
}

function onReport(event: string, raw: string) {
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { return; }
    if (!esunTradeService.isEnvironmentKnown()) {
        // 還不知道 bridge 的環境：不能替回報指定帳戶，先同步再說（回讀會補上資料）
        void esunTradeService.refreshHealth();
        return;
    }
    const account = esunTradeService.getAccounts()[0] ?? null;
    const result = toEsunReportWire(event, payload, {
        environment: esunTradeService.getEnvironment(),
        account,
        exchangeOf: code => getCachedContract(code)?.exchange ?? undefined,
        lookup: knownOrder,
    });
    if (result.kind === 'skip') {
        // 舊 session（切換前環境）的事件：丟棄並重新同步環境
        if (result.reason === 'environment') void esunTradeService.refreshHealth();
        return;
    }
    publishStreamEvent('order_event', JSON.stringify(result.wire));
}

function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
}

function connect() {
    if (es || !started || !isStreamOwner() || typeof EventSource === 'undefined') return;
    let source: EventSource;
    try {
        source = new EventSource(`${bridgeBase()}/esun/stream/orders`);
    } catch {
        scheduleRetry();
        return;
    }
    es = source;
    if (status !== 'down') publishStatus('connecting');
    source.onopen = () => {
        if (es !== source) return;
        retryDelay = 1_000;
        activity();
        // 原生重連（同一個 EventSource）與重建的新連線都算「之前連過」：之後的 resync 才有意義
        liveBeforeThisConnection = everLive;
        publishStatus('live');
        // 斷線期間 bridge 可能已切換環境或重新登入
        void esunTradeService.refreshHealth();
    };
    for (const name of ['order', 'deal', 'order_event']) {
        source.addEventListener(name, (event) => {
            if (es !== source) return;
            activity();
            onReport(name, (event as MessageEvent).data);
        });
    }
    source.addEventListener('session', (event) => {
        if (es !== source) return;
        activity();
        publishStreamEvent(SESSION_EVENT, (event as MessageEvent).data);
    });
    source.addEventListener('resync', (event) => {
        if (es !== source) return;
        activity();
        // 本頁第一條連線不帶 Last-Event-ID，bridge 會要求重建：之後的權威讀取已涵蓋，不必重建
        if (liveBeforeThisConnection) publishStreamEvent(RESYNC_EVENT, (event as MessageEvent).data || '{}');
    });
    source.addEventListener('heartbeat', () => {
        if (es !== source) return;
        activity();
        // 心跳時重送狀態，讓之後才開的視窗也知道玉山串流是否連線中
        publishStatus('live');
    });
    source.onerror = () => {
        if (es !== source) return;
        publishStatus('down');
        if (source.readyState === 2 /* CLOSED */) {
            // 不會自動重連（例如 HTTP 錯誤）：自己重建
            source.close();
            es = null;
            scheduleRetry();
        }
        // CONNECTING：交給原生重連（保留 Last-Event-ID）
    };
}

function disconnect() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    es?.close();
    es = null;
}

function checkWatchdog() {
    if (!es || status !== 'live' || !isStreamOwner()) return;
    if (Date.now() - lastActivity <= ESUN_STREAM_STALE_MS) return;
    disconnect();
    publishStatus('down');
    scheduleRetry();
}

/** 啟動玉山回報串流（冪等）。只有行情串流的擁有者視窗會真的連線。 */
export function ensureEsunOrderStream(): void {
    if (started) return;
    started = true;
    void import('../trading-state').then(m => { tradingModule = m; }).catch(() => undefined);
    stops.push(
        onStreamEvent(STATUS_EVENT, raw => {
            try {
                const next = (JSON.parse(raw) as { status?: string }).status;
                if (next === 'live' || next === 'down' || next === 'connecting') applyStatus(next);
            } catch { /* malformed */ }
        }),
        onStreamEvent(SESSION_EVENT, raw => {
            try { esunTradeService.applySession(JSON.parse(raw) as EsunSessionInfo); } catch { /* malformed */ }
        }),
        onStreamEvent(RESYNC_EVENT, () => signal({ kind: 'resync' })),
        subscribeStreamOwner(() => {
            if (isStreamOwner()) connect();
            else disconnect();
        }),
    );
    watchdog = setInterval(checkWatchdog, 5_000);
    connect();
}

/** 舊名稱（相容）：等同 ensureEsunOrderStream */
export const connectEsunOrderStream = ensureEsunOrderStream;

/** 停止玉山回報串流（測試與 HMR 用） */
export function stopEsunOrderStream(): void {
    disconnect();
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    stops.splice(0).forEach(stop => stop());
    started = false;
    status = 'idle';
    everLive = false;
}

import.meta.hot?.dispose(stopEsunOrderStream);
