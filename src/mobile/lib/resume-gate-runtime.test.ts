// ResumeGate 執行期（規格 §7.4、§14.1）：事件來源、時鐘與 src/lib 呼叫全部注入，不打任何真實 API
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lib = vi.hoisted(() => ({
    resolveOrderConfirm: vi.fn(),
    fetchSnapshots: vi.fn(),
    getCachedContract: vi.fn(),
    getStreamStatus: vi.fn(() => 'live'),
    streamConnectionEpoch: vi.fn(() => 1),
    subscribeStatusStore: vi.fn(() => () => undefined),
    onAnyTick: vi.fn(),
    onAnyBidAsk: vi.fn(() => () => undefined),
    onStreamEvent: vi.fn(() => () => undefined),
    refreshTradingState: vi.fn(async () => undefined),
    reconcileOrdersOnce: vi.fn(async () => undefined),
    getTradingState: vi.fn(),
}));
vi.mock('../../lib/order-confirm', () => ({ resolveOrderConfirm: lib.resolveOrderConfirm }));
vi.mock('../../lib/shioaji', () => ({ fetchSnapshots: lib.fetchSnapshots }));
vi.mock('../../lib/contracts-cache', () => ({ getCachedContract: lib.getCachedContract }));
vi.mock('../../lib/stream', () => ({
    getStreamStatus: lib.getStreamStatus,
    streamConnectionEpoch: lib.streamConnectionEpoch,
    subscribeStatusStore: lib.subscribeStatusStore,
    onAnyTick: lib.onAnyTick,
    onAnyBidAsk: lib.onAnyBidAsk,
    onStreamEvent: lib.onStreamEvent,
}));
vi.mock('../../lib/trading-state', () => ({
    refreshTradingState: lib.refreshTradingState,
    reconcileOrdersOnce: lib.reconcileOrdersOnce,
    getTradingState: lib.getTradingState,
}));

import type { ContractBase } from '../../lib/types/contract';
import { resetMobileUiForTest, setCurrentCode } from './mobile-store';
import { ACTIVITY_SETTLE_MS, HIDDEN_THRESHOLD_MS, RESYNC_TIMEOUT_MS } from './resume-gate';
import {
    acknowledgeStaleData,
    assertResumeReady,
    getResumeGate,
    MAX_READS_PER_SCOPE,
    READ_RETRY_DELAY_MS,
    retryResume,
    setResumeGateForTest,
    startResumeGate,
    subscribeResumeGate,
    type ResumeGateDeps,
} from './resume-gate-runtime';

class FakeDocument extends EventTarget {
    visibilityState: 'visible' | 'hidden' = 'visible';
}

type Scope = 'orders' | 'positions';

/** 可控的時鐘、頁面事件與串流／讀取來源 */
function harness(over: Partial<ResumeGateDeps> = {}) {
    let now = 1_000_000;
    let nextId = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const doc = new FakeDocument();
    const win = new EventTarget();
    const stream = { status: 'live', epoch: 7 };
    const tick = new Set<() => void>();
    const bidask = new Set<() => void>();
    const heartbeat = new Set<() => void>();
    const status = new Set<() => void>();
    const readFailed: Record<Scope, string | null> = { orders: null, positions: null };
    /** queries[scope].updatedAt；'now'＝剛讀完（目前時鐘） */
    const updatedAt: Record<Scope, number | null | 'now'> = { orders: 'now', positions: 'now' };
    /** ③ 的讀取（readOrders → 'orders'、readPositions → 'positions'） */
    const read = vi.fn(async (_scope: Scope): Promise<void> => undefined);
    const contract = { code: '2330', security_type: 'STK', exchange: 'TSE' } as ContractBase;
    const sub = (set: Set<() => void>) => (l: () => void) => { set.add(l); return () => { set.delete(l); }; };
    const base = {
        now: () => now,
        setTimeout: (fn: () => void, ms: number) => { timers.set(++nextId, { at: now + ms, fn }); return nextId; },
        clearTimeout: (h: unknown) => { timers.delete(h as number); },
        document: doc,
        window: win,
        getStreamStatus: () => stream.status,
        streamConnectionEpoch: () => (stream.status === 'live' ? stream.epoch : -1),
        subscribeStreamStatus: sub(status),
        onAnyTick: vi.fn(sub(tick)),
        onAnyBidAsk: vi.fn(sub(bidask)),
        onHeartbeat: vi.fn(sub(heartbeat)),
        readOrders: () => read('orders'),
        readPositions: () => read('positions'),
        tradingReadFailed: (scope: Scope) => readFailed[scope],
        tradingUpdatedAt: (scope: Scope) => (updatedAt[scope] === 'now' ? now : updatedAt[scope]),
        getCurrentCode: vi.fn((): string | null => '2330'),
        getCachedContract: vi.fn((code: string) => (code === '2330' ? contract : undefined)),
        fetchSnapshots: vi.fn(async (_c: ContractBase[]): Promise<unknown> => []),
        resolveOrderConfirm: vi.fn(),
        reload: vi.fn(),
    };
    // 覆寫只用於測試個別來源；保留 base 的 mock 型別
    const deps = Object.assign(base, over) as typeof base;
    const h = {
        deps,
        doc,
        win,
        stream,
        tick,
        bidask,
        heartbeat,
        readFailed,
        updatedAt,
        read,
        contract,
        now: () => now,
        /** 推進時鐘並依序執行到期的計時器 */
        advance(ms: number) {
            const end = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                now = Math.max(now, due[1].at);
                due[1].fn();
            }
            now = end;
        },
        hide() { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); },
        show() { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); },
        /** 隱藏 ms 後回前景 */
        away(ms: number) { h.hide(); h.advance(ms); h.show(); },
        /** 回前景後等過 ② 的排隊事件窗（之後收到的 tick／bidask／heartbeat 才算活動） */
        settle() { h.advance(ACTIVITY_SETTLE_MS); },
        pageshow(persisted: boolean) { win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted })); },
        pagehide() { win.dispatchEvent(new Event('pagehide')); },
        emit(set: Set<() => void>) { [...set].forEach(l => l()); },
        setStatus(next: string, epoch = stream.epoch) { stream.status = next; stream.epoch = epoch; h.emit(status); },
        pendingTimers: () => timers.size,
        start() { return startResumeGate(deps); },
    };
    return h;
}

/** 讓 promise 鏈跑完 */
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const notStartedOrPass = (fn: () => void) => {
    try { fn(); } catch (err) { return (err as { mutationNotStarted?: boolean }).mutationNotStarted === true ? 'not-started' : 'other'; }
    return 'passed';
};

let stop: (() => void) | null = null;

beforeEach(() => {
    setResumeGateForTest(null);
});

afterEach(() => {
    stop?.();
    stop = null;
    setResumeGateForTest(null);
    resetMobileUiForTest();
    vi.clearAllMocks();
});

describe('觸發（§14.1）', () => {
    it('隱藏少於 5 秒不進入 resyncing', () => {
        const h = harness();
        stop = h.start();
        h.away(HIDDEN_THRESHOLD_MS - 1);
        expect(getResumeGate().state).toBe('ready');
        expect(getResumeGate().resumeSeq).toBe(0);
        expect(h.deps.resolveOrderConfirm).not.toHaveBeenCalled();
        expect(h.read).not.toHaveBeenCalled();
        expect(h.pendingTimers()).toBe(0);
    });

    it('隱藏 ≥ 5 秒進入 resyncing：resumeSeq 遞增、關閉進行中的確認、擋下新單／改價／減量', () => {
        const h = harness();
        stop = h.start();
        h.away(HIDDEN_THRESHOLD_MS);
        const s = getResumeGate();
        expect(s.state).toBe('resyncing');
        expect(s.resumeSeq).toBe(1);
        expect(s.checks).toMatchObject({ streamLive: true, activitySinceResume: false, tradingReadSettled: 'pending', snapshotSettled: 'pending' });
        expect(h.deps.resolveOrderConfirm).toHaveBeenCalledTimes(1);
        expect(h.deps.resolveOrderConfirm).toHaveBeenCalledWith(false);
        expect(notStartedOrPass(() => assertResumeReady())).toBe('not-started');
        expect(notStartedOrPass(() => assertResumeReady({ allowStale: true }))).toBe('not-started');
    });

    it('pagehide 也算進入背景', () => {
        const h = harness();
        stop = h.start();
        h.pagehide();
        h.advance(HIDDEN_THRESHOLD_MS);
        h.pageshow(false);
        expect(getResumeGate().state).toBe('resyncing');
        expect(h.deps.reload).not.toHaveBeenCalled();
    });

    it('pageshow(persisted) 視同回前景（bfcache 還原），即使沒有記到隱藏時間', () => {
        const h = harness();
        stop = h.start();
        h.pageshow(false);
        expect(getResumeGate().state).toBe('ready');
        expect(h.deps.reload).not.toHaveBeenCalled();
        h.pageshow(true);
        expect(getResumeGate().state).toBe('resyncing');
        expect(getResumeGate().resumeSeq).toBe(1);
    });

    it('B5：pageshow(persisted)（bfcache 還原）先擋下送單再重新載入頁面（quote-ownership 已在 pagehide 拆除報價訂閱）', () => {
        const h = harness();
        stop = h.start();
        const order: string[] = [];
        h.deps.resolveOrderConfirm.mockImplementation(() => { order.push('confirm-cancelled'); });
        h.deps.reload.mockImplementation(() => { order.push(`reload@${getResumeGate().state}`); });
        h.pagehide();
        h.advance(60_000);
        h.pageshow(true);
        expect(h.deps.reload).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['confirm-cancelled', 'reload@resyncing']);
        expect(notStartedOrPass(() => assertResumeReady({ allowStale: true }))).toBe('not-started');
    });

    it('B5：reload 丟錯時閘門仍停在 resyncing（fail-closed）', () => {
        const h = harness();
        stop = h.start();
        h.deps.reload.mockImplementation(() => { throw new Error('blocked'); });
        expect(() => h.pageshow(true)).not.toThrow();
        expect(getResumeGate().state).toBe('resyncing');
    });

    it('同一次還原的 visibilitychange 與 pageshow(persisted) 只觸發一次', () => {
        const h = harness();
        stop = h.start();
        h.pagehide();
        h.hide();
        h.advance(HIDDEN_THRESHOLD_MS + 1);
        h.show();
        h.pageshow(true);
        expect(getResumeGate().resumeSeq).toBe(1);
        expect(h.deps.resolveOrderConfirm).toHaveBeenCalledTimes(1);

        // 順序相反：pageshow 先、visibilitychange 後
        const h2 = harness();
        stop!();
        setResumeGateForTest(null);
        stop = h2.start();
        h2.hide();
        h2.advance(HIDDEN_THRESHOLD_MS + 1);
        h2.pageshow(true);
        h2.show();
        expect(getResumeGate().resumeSeq).toBe(1);
    });

    it('啟動時頁面已在背景：回前景超過門檻仍會觸發', () => {
        const h = harness();
        h.doc.visibilityState = 'hidden';
        stop = h.start();
        h.advance(HIDDEN_THRESHOLD_MS);
        h.show();
        expect(getResumeGate().state).toBe('resyncing');
    });
});

describe('四個條件（§14.1）', () => {
    it('四個條件全成立才 ready；①② 成立前不發出讀取', async () => {
        const h = harness();
        stop = h.start();
        h.away(10_000);
        h.advance(20_000);
        await flush();
        // 串流仍是 live（看門狗寬限期內），但回前景後沒有任何活動 → 不讀、不放行
        expect(getResumeGate().state).toBe('resyncing');
        expect(h.read).not.toHaveBeenCalled();
        expect(h.deps.fetchSnapshots).not.toHaveBeenCalled();

        let finishOrders!: () => void;
        let finishPositions!: () => void;
        h.read.mockImplementation((scope: Scope) => new Promise<undefined>(r => {
            if (scope === 'orders') finishOrders = () => r(undefined);
            else finishPositions = () => r(undefined);
        }));
        let finishSnapshot!: () => void;
        h.deps.fetchSnapshots.mockImplementation(() => new Promise(r => { finishSnapshot = () => r([]); }));

        h.emit(h.tick); // ② 回前景後第一筆 tick
        expect(getResumeGate().checks).toMatchObject({ streamLive: true, activitySinceResume: true });
        // ③ 委託先讀，完成後才讀持倉；④ 目前商品的快照經合約快取取得
        expect(h.read.mock.calls).toEqual([['orders']]);
        expect(h.deps.getCachedContract).toHaveBeenCalledWith('2330');
        expect(h.deps.fetchSnapshots).toHaveBeenCalledWith([h.contract]);

        finishOrders();
        await flush();
        expect(h.read.mock.calls).toEqual([['orders'], ['positions']]);
        expect(getResumeGate().state).toBe('resyncing');

        finishSnapshot();
        await flush();
        expect(getResumeGate().checks?.snapshotSettled).toBe('ok');
        expect(getResumeGate().state).toBe('resyncing');

        finishPositions();
        await flush();
        expect(getResumeGate().state).toBe('ready');
        expect(getResumeGate().checks).toBeNull();
        expect(getResumeGate().message).toBeNull();
        expect(getResumeGate().resumeSeq).toBe(1);
        expect(notStartedOrPass(() => assertResumeReady())).toBe('passed');
        expect(h.pendingTimers()).toBe(0);
    });

    it('串流不是 live 時即使有活動也不放行；轉為 live 後才讀', async () => {
        const h = harness();
        stop = h.start();
        h.hide();
        h.advance(6_000);
        h.stream.status = 'stale';
        h.show();
        h.settle();
        h.emit(h.tick);
        await flush();
        expect(getResumeGate().checks).toMatchObject({ streamLive: false, activitySinceResume: true });
        expect(h.read).not.toHaveBeenCalled();
        h.setStatus('live', 7);
        await flush();
        expect(h.read).toHaveBeenCalled();
        expect(getResumeGate().state).toBe('ready');
    });

    it('回前景後重新連上（連線世代與回前景當下不同）視為已有活動', async () => {
        const h = harness();
        stop = h.start();
        h.hide();
        h.advance(30_000);
        h.stream.status = 'down';
        h.show();
        expect(getResumeGate().checks?.streamLive).toBe(false);
        h.setStatus('live', 8);
        await flush();
        expect(getResumeGate().state).toBe('ready');
        expect(h.deps.onAnyTick).toHaveBeenCalledTimes(1);
    });

    it('bidask 或 heartbeat 也算活動', async () => {
        for (const kind of ['bidask', 'heartbeat'] as const) {
            stop?.();
            setResumeGateForTest(null);
            let fire!: () => void;
            const listen = (l: () => void) => { fire = l; return () => undefined; };
            const h = harness(kind === 'bidask' ? { onAnyBidAsk: vi.fn(listen) } : { onHeartbeat: vi.fn(listen) });
            stop = h.start();
            h.away(6_000);
            h.settle();
            fire();
            await flush();
            expect(getResumeGate().state).toBe('ready');
        }
    });

    it('沒有目前商品或合約不在快取：不讀快照，④ 直接完成', async () => {
        const h = harness({ getCurrentCode: vi.fn(() => null) });
        stop = h.start();
        h.away(6_000);
        h.settle();
        h.emit(h.tick);
        await flush();
        expect(h.deps.fetchSnapshots).not.toHaveBeenCalled();
        expect(getResumeGate().state).toBe('ready');

        stop!();
        setResumeGateForTest(null);
        const h2 = harness({ getCurrentCode: vi.fn(() => '9999') });
        stop = h2.start();
        h2.away(6_000);
        h2.settle();
        h2.emit(h2.tick);
        await flush();
        expect(h2.deps.fetchSnapshots).not.toHaveBeenCalled();
        expect(getResumeGate().state).toBe('ready');
    });

    it('tick 洪流不會造成查詢風暴：第一筆活動後即解除監聽，每週期各讀一次', async () => {
        const h = harness();
        stop = h.start();
        h.away(6_000);
        h.settle();
        for (let i = 0; i < 100; i++) h.emit(h.tick);
        await flush();
        h.advance(10_000);
        expect(h.tick.size).toBe(0);
        expect(h.read).toHaveBeenCalledTimes(2);
        expect(h.deps.fetchSnapshots).toHaveBeenCalledTimes(1);
    });
});

describe('A-3：② 只認回前景之後的活動（比 §7.4 字面更嚴格）', () => {
    it('回前景後立即派送的排隊事件（tick／bidask／heartbeat）不算；1 秒後的新事件才算', async () => {
        const h = harness();
        stop = h.start();
        h.away(6_000);
        // 背景期間排隊、回前景時才派送的舊事件
        h.emit(h.tick);
        h.emit(h.bidask);
        h.emit(h.heartbeat);
        h.advance(ACTIVITY_SETTLE_MS - 1);
        h.emit(h.tick);
        await flush();
        expect(getResumeGate().state).toBe('resyncing');
        expect(getResumeGate().checks?.activitySinceResume).toBe(false);
        expect(h.read).not.toHaveBeenCalled();
        expect(h.deps.fetchSnapshots).not.toHaveBeenCalled();
        // 監聽仍在：之後的新事件會算
        expect(h.tick.size).toBe(1);
        h.advance(1);
        h.emit(h.tick);
        await flush();
        expect(getResumeGate().state).toBe('ready');
        expect(h.tick.size).toBe(0);
    });

    it('隱藏期間的重新連線不算（基準是回前景當下的連線世代）；回前景後的重連才算', async () => {
        const h = harness();
        stop = h.start();
        h.hide();
        h.advance(10_000);
        h.setStatus('stale');
        h.setStatus('live', 8); // 背景中重連：之後這條連線可能又已中斷
        h.advance(10_000);
        h.show();
        h.advance(20_000);
        await flush();
        expect(getResumeGate().state).toBe('resyncing');
        expect(getResumeGate().checks).toMatchObject({ streamLive: true, activitySinceResume: false });
        expect(h.read).not.toHaveBeenCalled();
        // 回前景後看門狗判 stale 並重連 → 新世代
        h.setStatus('stale');
        h.setStatus('live', 9);
        await flush();
        expect(getResumeGate().state).toBe('ready');
    });

    it('回前景後立刻重連（世代改變）不必等 1 秒', async () => {
        const h = harness();
        stop = h.start();
        h.away(6_000);
        h.setStatus('live', 8);
        await flush();
        expect(getResumeGate().state).toBe('ready');
    });

    it('休市只有心跳：第一秒內的心跳不算，下一次心跳（約 30 秒後）在 45 秒內 ready', async () => {
        const h = harness();
        stop = h.start();
        h.away(6_000);
        h.advance(500);
        h.emit(h.heartbeat);
        await flush();
        expect(getResumeGate().state).toBe('resyncing');
        h.advance(30_000);
        h.emit(h.heartbeat);
        await flush();
        expect(getResumeGate().state).toBe('ready');
    });
});

describe('A-4：③ 確認真的重新讀取（updatedAt 晚於週期開始）', () => {
    const resume = async (h: ReturnType<typeof harness>) => {
        stop = h.start();
        h.away(6_000);
        h.settle();
        h.emit(h.tick);
        await flush();
    };

    it('持倉讀取被冷卻吸收（updatedAt 仍是舊的）→ 等冷卻後重讀一次，讀到才 ready', async () => {
        const h = harness();
        h.updatedAt.positions = 1; // 回前景前的讀取
        h.read.mockImplementation(async (scope: Scope) => {
            if (scope === 'positions' && h.read.mock.calls.filter(c => c[0] === 'positions').length === 2) h.updatedAt.positions = 'now';
        });
        await resume(h);
        expect(h.read.mock.calls).toEqual([['orders'], ['positions']]);
        expect(getResumeGate().state).toBe('resyncing');
        h.advance(READ_RETRY_DELAY_MS - 1);
        await flush();
        expect(h.read.mock.calls).toEqual([['orders'], ['positions']]);
        h.advance(1);
        await flush();
        expect(h.read.mock.calls).toEqual([['orders'], ['positions'], ['positions']]);
        expect(getResumeGate().state).toBe('ready');
        expect(h.pendingTimers()).toBe(0);
    });

    it('兩次都沒讀到 → stale-data；每個範圍最多讀 2 次（不造成查詢風暴）', async () => {
        const h = harness();
        h.updatedAt.positions = null;
        await resume(h);
        h.advance(READ_RETRY_DELAY_MS);
        await flush();
        expect(getResumeGate().state).toBe('stale-data');
        expect(getResumeGate().message).toContain('持倉未能確認已重新讀取');
        h.advance(30_000);
        await flush();
        expect(h.read.mock.calls.filter(c => c[0] === 'positions')).toHaveLength(MAX_READS_PER_SCOPE);
        expect(h.read.mock.calls.filter(c => c[0] === 'orders')).toHaveLength(1);
    });

    it('委託：updatedAt 早於週期開始 → 立刻再 reconcile 一次（reconcileOrdersOnce 自己等冷卻），仍舊 → stale-data', async () => {
        const h = harness();
        h.updatedAt.orders = 5;
        await resume(h);
        expect(h.read.mock.calls).toEqual([['orders'], ['orders'], ['positions']]);
        expect(getResumeGate().state).toBe('stale-data');
        expect(getResumeGate().message).toContain('委託未能確認已重新讀取');
    });

    it('讀取失敗原因優先，不重讀', async () => {
        const h = harness();
        h.readFailed.positions = '持倉讀取失敗';
        h.updatedAt.positions = null;
        await resume(h);
        expect(h.read.mock.calls.filter(c => c[0] === 'positions')).toHaveLength(1);
        expect(getResumeGate().state).toBe('stale-data');
    });

    it('等待重讀時週期結束（再次進入背景）：計時器清除、不再讀', async () => {
        const h = harness();
        h.updatedAt.positions = 1;
        await resume(h);
        stop!();
        stop = null;
        expect(h.pendingTimers()).toBe(0);
        h.advance(READ_RETRY_DELAY_MS);
        await flush();
        expect(h.read.mock.calls.filter(c => c[0] === 'positions')).toHaveLength(1);
    });
});

describe('讀取失敗 → stale-data（§14.1）', () => {
    const toStale = async (setup: (h: ReturnType<typeof harness>) => void) => {
        const h = harness();
        setup(h);
        stop = h.start();
        h.away(6_000);
        h.settle();
        h.emit(h.tick);
        await flush();
        return h;
    };

    it('委託／持倉讀取失敗（lib 記錄 query-failed，不 reject）', async () => {
        await toStale(h => { h.readFailed.positions = '持倉讀取失敗'; });
        const s = getResumeGate();
        expect(s.state).toBe('stale-data');
        expect(s.checks?.tradingReadSettled).toBe('failed');
        expect(s.message).toContain('持倉讀取失敗');
    });

    it('refreshTradingState reject', async () => {
        await toStale(h => { h.read.mockRejectedValueOnce(new Error('boom')); });
        expect(getResumeGate().state).toBe('stale-data');
        expect(getResumeGate().message).toContain('boom');
    });

    it('目前商品快照讀取失敗', async () => {
        await toStale(h => { h.deps.fetchSnapshots.mockRejectedValueOnce(new Error('503')); });
        expect(getResumeGate().state).toBe('stale-data');
        expect(getResumeGate().checks?.snapshotSettled).toBe('failed');
        expect(getResumeGate().message).toContain('2330');
    });

    it('stale-data 需使用者確認（acknowledgeStaleData）且呼叫端傳 allowStale 才放行新單', async () => {
        await toStale(h => { h.readFailed.orders = '委託讀取失敗'; });
        expect(notStartedOrPass(() => assertResumeReady())).toBe('not-started');
        expect(notStartedOrPass(() => assertResumeReady({ allowStale: true }))).toBe('not-started');
        acknowledgeStaleData();
        expect(getResumeGate().staleAcknowledged).toBe(true);
        // 改價／減量不傳 allowStale：仍擋下
        expect(notStartedOrPass(() => assertResumeReady())).toBe('not-started');
        expect(notStartedOrPass(() => assertResumeReady({ allowStale: true }))).toBe('passed');
    });
});

describe('45 秒逾時 → failed（§14.1）', () => {
    it('串流未恢復：45 秒整進入 failed，之後的結果不再改變狀態', async () => {
        const h = harness();
        stop = h.start();
        h.hide();
        h.advance(60_000);
        h.stream.status = 'down';
        h.show();
        h.advance(RESYNC_TIMEOUT_MS - 1);
        expect(getResumeGate().state).toBe('resyncing');
        h.advance(1);
        expect(getResumeGate().state).toBe('failed');
        expect(getResumeGate().message).toContain('重新整理');
        expect(notStartedOrPass(() => assertResumeReady({ allowStale: true }))).toBe('not-started');
        expect(h.pendingTimers()).toBe(0);
        h.setStatus('live', 8);
        h.emit(h.tick);
        await flush();
        expect(getResumeGate().state).toBe('failed');
        expect(h.read).not.toHaveBeenCalled();
    });

    it('讀取卡住超過 45 秒也是 failed；遲到的結果被忽略', async () => {
        let finish!: () => void;
        const h = harness();
        h.read.mockImplementation(() => new Promise<undefined>(r => { finish = () => r(undefined); }));
        stop = h.start();
        h.away(6_000);
        h.settle();
        h.emit(h.tick);
        h.advance(RESYNC_TIMEOUT_MS);
        expect(getResumeGate().state).toBe('failed');
        expect(getResumeGate().message).toContain('讀取');
        finish();
        await flush();
        expect(getResumeGate().state).toBe('failed');
        expect(h.read).toHaveBeenCalledTimes(1);
    });
});

describe('重試與生命週期', () => {
    it('retryResume：stale-data 重新同步（同一條連線仍 live 時不必再等活動）', async () => {
        const h = harness();
        h.readFailed.orders = '委託讀取失敗';
        stop = h.start();
        h.away(6_000);
        h.settle();
        h.emit(h.tick);
        await flush();
        expect(getResumeGate().state).toBe('stale-data');
        acknowledgeStaleData();

        h.readFailed.orders = null;
        retryResume();
        expect(getResumeGate().state).toBe('resyncing');
        expect(getResumeGate().resumeSeq).toBe(2);
        expect(getResumeGate().staleAcknowledged).toBe(false);
        expect(h.deps.resolveOrderConfirm).toHaveBeenCalledTimes(2);
        await flush();
        expect(h.read).toHaveBeenCalledTimes(4);
        expect(getResumeGate().state).toBe('ready');
    });

    it('retryResume：failed 需要新的串流活動；ready／resyncing 時不做任何事', async () => {
        const h = harness();
        stop = h.start();
        retryResume();
        expect(getResumeGate().resumeSeq).toBe(0);

        h.hide();
        h.advance(6_000);
        h.stream.status = 'down';
        h.show();
        retryResume(); // resyncing：不重啟
        expect(getResumeGate().resumeSeq).toBe(1);
        h.advance(RESYNC_TIMEOUT_MS);
        expect(getResumeGate().state).toBe('failed');

        h.stream.status = 'live';
        retryResume();
        expect(getResumeGate().state).toBe('resyncing');
        expect(getResumeGate().resumeSeq).toBe(2);
        await flush();
        expect(h.read).not.toHaveBeenCalled();
        h.settle();
        h.emit(h.tick);
        await flush();
        expect(getResumeGate().state).toBe('ready');
    });

    it('同步中再次隱藏 ≥ 5 秒：重新開始週期', () => {
        const h = harness();
        stop = h.start();
        h.away(6_000);
        h.away(6_000);
        expect(getResumeGate().resumeSeq).toBe(2);
        expect(h.tick.size).toBe(1);
    });

    it('startResumeGate 冪等；停止後不再監聽', () => {
        const h = harness();
        stop = h.start();
        const second = startResumeGate(h.deps);
        second();
        h.away(6_000);
        expect(getResumeGate().resumeSeq).toBe(1);

        stop();
        stop = null;
        expect(h.pendingTimers()).toBe(0);
        expect(h.tick.size).toBe(0);
        setResumeGateForTest(null);
        h.away(6_000);
        expect(getResumeGate().state).toBe('ready');
    });

    it('通知訂閱者', () => {
        const h = harness();
        stop = h.start();
        const seen: string[] = [];
        const off = subscribeResumeGate(() => seen.push(getResumeGate().state));
        h.away(6_000);
        off();
        expect(seen[0]).toBe('resyncing');
    });
});

describe('預設依賴接到 src/lib（vi.mock）', () => {
    it('resolveOrderConfirm(false)、委託 reconcileOrdersOnce → 持倉 refreshTradingState(positions)、經合約快取讀目前商品快照、query-failed 判為讀取失敗', async () => {
        const doc = new FakeDocument();
        const win = new EventTarget();
        let now = 0;
        const ticks = new Set<() => void>();
        lib.onAnyTick.mockImplementation((l: () => void) => { ticks.add(l); return () => { ticks.delete(l); }; });
        const contract = { code: '2330', security_type: 'STK', exchange: 'TSE' };
        lib.getCachedContract.mockImplementation((code: string) => (code === '2330' ? contract : undefined));
        lib.fetchSnapshots.mockResolvedValue([]);
        lib.getTradingState.mockReturnValue({
            queries: {
                orders: { reasons: [], error: null, updatedAt: 7_000 },
                positions: { reasons: ['query-failed'], error: 'S 持倉查詢失敗，保留上次資料', updatedAt: 1 },
            },
        });
        setCurrentCode('2330');
        stop = startResumeGate({ now: () => now, setTimeout: () => 0, clearTimeout: () => undefined, document: doc, window: win });

        doc.visibilityState = 'hidden';
        doc.dispatchEvent(new Event('visibilitychange'));
        now += 6_000;
        doc.visibilityState = 'visible';
        doc.dispatchEvent(new Event('visibilitychange'));
        expect(lib.resolveOrderConfirm).toHaveBeenCalledWith(false);
        expect(lib.onStreamEvent).toHaveBeenCalledWith('heartbeat', expect.any(Function));

        now += 1_000; // 回前景 1 秒後的 tick 才算活動
        [...ticks].forEach(l => l());
        await flush();
        // A-4：委託走 reconcileOrdersOnce（等進行中讀取與冷卻後真的讀一次），不直接呼叫 refreshTradingState('orders')
        expect(lib.reconcileOrdersOnce).toHaveBeenCalledTimes(1);
        expect(lib.refreshTradingState.mock.calls).toEqual([['positions']]);
        expect(lib.fetchSnapshots).toHaveBeenCalledWith([contract]);
        expect(getResumeGate().state).toBe('stale-data');
        expect(getResumeGate().message).toContain('S 持倉查詢失敗');
    });
});
