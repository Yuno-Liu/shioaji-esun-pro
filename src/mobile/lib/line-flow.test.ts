// 走勢買賣力的逐筆彙總（lib/line-flow.ts）：時間解析、每分鐘分桶（與走勢 K 棒同 label）、tick_type 分流、
// 金額門檻分類、累積線、歷史與即時接合（不重複、不漏）、快取與請求數、失敗重試、漏量重抓；設定（lib/line-indicators.ts）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseTick } from '../../lib/types/market';
import type { HistoryTicks } from '../../lib/types/tick';

const m = vi.hoisted(() => ({
    fetch: vi.fn(),
    listeners: new Set<(tk: unknown) => void>(),
}));
vi.mock('../../lib/shioaji', () => ({ fetchHistoryTicks: m.fetch }));
vi.mock('../../lib/stream', () => ({
    onAnyTick: (fn: (tk: unknown) => void) => { m.listeners.add(fn); return () => { m.listeners.delete(fn); }; },
}));

import {
    addFlowTick,
    aggregateHistory,
    buyRatio,
    dateDigits,
    dateOfWallClock,
    dayStartUtc,
    FLOW_GAP_REFETCH_MIN_MS,
    FLOW_RETRY_MIN_MS,
    flowView,
    lineFlowRequestsForTest,
    lineFlowSupported,
    newFlowAgg,
    resetLineFlowForTest,
    retainLineFlow,
    takeAfterJoin,
    tickSecondsOfDay,
} from './line-flow';
import { defaultLineIndicatorSettings, LINE_FLOW_THRESHOLDS, sanitizeLineIndicatorSettings, thresholdIndex, thresholdLabel } from './line-indicators';

const DAY = dayStartUtc('20261105');
const at = (hms: string) => DAY + tickSecondsOfDay(hms);
const sod = (hms: string) => tickSecondsOfDay(hms);
const T500 = thresholdIndex(500);
const contract = { exchange: 'TSE', code: '2330', security_type: 'STK' } as never;

function hist(rows: Array<[string, number, number, number]>): HistoryTicks {
    return {
        datetime: rows.map(r => `2026-11-05 ${r[0]}`),
        close: rows.map(r => r[1]),
        volume: rows.map(r => r[2]),
        tick_type: rows.map(r => r[3]),
        bid_price: [], bid_volume: [], ask_price: [], ask_volume: [],
    };
}
function live(time: string, close: number, volume: number, tickType: number, total: number, extra: Partial<SseTick> = {}): SseTick {
    return { code: '2330', date: '2026/11/05', time, open: '0', high: '0', low: '0', close: String(close), volume, total_volume: total, tick_type: tickType, ...extra };
}
const emit = (tk: SseTick) => { for (const fn of [...m.listeners]) fn(tk); };
const flush = () => new Promise(r => setTimeout(r, 0));

describe('line-flow 純函式', () => {
    it('時間解析：日期與時間之間可為空白或 T，微秒保留；日期取 8 位數字', () => {
        expect(tickSecondsOfDay('2026-11-05 09:01:02.123456')).toBeCloseTo(9 * 3600 + 62.123456, 6);
        expect(tickSecondsOfDay('2026-11-05T13:30:00')).toBe(13.5 * 3600);
        expect(tickSecondsOfDay('09:00:00.5')).toBe(9 * 3600 + 0.5);
        expect(tickSecondsOfDay('bad')).toBeNaN();
        expect(dateDigits('2026/11/05')).toBe('20261105');
        expect(dateDigits('2026-11-05 09:00:00')).toBe('20261105');
        expect(dateOfWallClock(at('09:30:00'))).toBe('2026-11-05');
    });

    it('每分鐘分桶與走勢 K 棒同 label：時間無條件進位到分，夾在 (09:00, 13:30]；開盤前與收盤後（逾 4 分）不計', () => {
        const agg = newFlowAgg();
        const add = (hms: string) => addFlowTick(agg, DAY, sod(hms), 100, 1, 1);
        expect(add('08:59:59.9')).toBe(false); // 開盤前
        expect(add('09:00:00')).toBe(false); // 時段起點本身不屬於這個時段
        expect(add('09:00:00.2')).toBe(true); // 開盤集合競價 → 09:01
        expect(add('09:01:00')).toBe(true); // 09:01
        expect(add('09:01:00.1')).toBe(true); // 09:02
        expect(add('13:30:00.3')).toBe(true); // 收盤集合競價 → 夾到 13:30
        expect(add('13:34:01')).toBe(false); // 超過 CLOSE_GRACE（盤後定價等）
        const labels = [...agg.minutes.keys()].sort((a, b) => a - b).map(t => new Date(t * 1000).toISOString().slice(11, 16));
        expect(labels).toEqual(['09:01', '09:02', '13:30']);
        expect(agg.minutes.get(at('09:01:00'))!.buy).toBe(2);
    });

    it('tick_type 分流：1 外盤、2 內盤；0 或其他、量 ≤ 0、價格 ≤ 0 不計', () => {
        const agg = newFlowAgg();
        addFlowTick(agg, DAY, sod('09:00:10'), 100, 3, 1);
        addFlowTick(agg, DAY, sod('09:00:20'), 100, 2, 2);
        expect(addFlowTick(agg, DAY, sod('09:00:30'), 100, 9, 0)).toBe(false);
        expect(addFlowTick(agg, DAY, sod('09:00:40'), 100, 9, 3)).toBe(false);
        expect(addFlowTick(agg, DAY, sod('09:00:50'), 100, 0, 1)).toBe(false);
        expect(addFlowTick(agg, DAY, sod('09:00:50'), 0, 5, 1)).toBe(false);
        const mm = agg.minutes.get(at('09:01:00'))!;
        expect([mm.buy, mm.sell, agg.ticks]).toEqual([3, 2, 2]);
    });

    it('大單以單筆成交金額（價格 × 張 × 1000）≥ 門檻分類，每個門檻各記一份', () => {
        expect(LINE_FLOW_THRESHOLDS).toEqual([100, 300, 500, 1000, 2000]);
        const agg = newFlowAgg();
        addFlowTick(agg, DAY, sod('09:00:10'), 1000, 5, 1); // 500 萬：≥100、300、500
        addFlowTick(agg, DAY, sod('09:00:20'), 1000, 4, 2); // 400 萬：≥100、300
        addFlowTick(agg, DAY, sod('09:00:30'), 1000, 1, 1); // 100 萬：≥100
        addFlowTick(agg, DAY, sod('09:00:40'), 99.5, 1, 2); // 9.95 萬：小單
        const mm = agg.minutes.get(at('09:01:00'))!;
        expect(mm.bigBuy).toEqual([6, 5, 5, 0, 0]);
        expect(mm.bigSell).toEqual([4, 4, 0, 0, 0]);
        expect([mm.buy, mm.sell]).toEqual([6, 5]);
    });

    it('flowView：時間由舊到新；每分鐘外內盤、累積淨買、大單／小單累積淨買；外盤比', () => {
        const agg = newFlowAgg();
        addFlowTick(agg, DAY, sod('09:02:00'), 1000, 10, 2); // 09:02 大單賣 10
        addFlowTick(agg, DAY, sod('09:00:30'), 1000, 6, 1); // 09:01 大單買 6
        addFlowTick(agg, DAY, sod('09:00:40'), 100, 2, 2); // 09:01 小單賣 2
        addFlowTick(agg, DAY, sod('09:01:30'), 100, 3, 1); // 09:02 小單買 3
        const v = flowView(agg, T500);
        expect(v.times).toEqual([at('09:01:00'), at('09:02:00')]);
        expect(v.buy).toEqual([6, 3]);
        expect(v.sell).toEqual([2, 10]);
        expect(v.cumNet).toEqual([4, -3]);
        expect(v.bigNet).toEqual([6, -4]);
        expect(v.smallNet).toEqual([-2, 1]);
        expect([v.totalBuy, v.totalSell]).toEqual([9, 12]);
        expect(v.index.get(at('09:02:00'))).toBe(1);
        // 門檻 1 千萬：只有 09:02 那筆 1 千萬的賣單算大單；2 千萬：全部算小單
        expect(flowView(agg, thresholdIndex(1000)).bigNet).toEqual([0, -10]);
        expect(flowView(agg, thresholdIndex(2000)).bigNet).toEqual([0, 0]);
        expect(buyRatio(9, 12)).toBeCloseTo(42.857, 2);
        expect(buyRatio(0, 0)).toBeNull();
    });

    it('歷史接合：最後一筆歷史之前的緩衝略過；同一時間的略過與歷史相同的筆數，其餘接上', () => {
        const { agg, join } = aggregateHistory(hist([
            ['09:05:00.400000', 100, 1, 1],
            ['09:05:00.500000', 100, 1, 1],
            ['09:05:00.500000', 100, 2, 2],
        ]), DAY);
        expect(agg.ticks).toBe(3);
        expect(join).toEqual({ lastSod: sod('09:05:00.5'), sameCount: 2 });
        const taken = ['09:05:00.4', '09:05:00.5', '09:05:00.5', '09:05:00.5', '09:05:01'].map(h => takeAfterJoin(join, sod(h)));
        expect(taken).toEqual([false, false, false, true, true]);
        // 沒有歷史：全部接上
        const empty = aggregateHistory(hist([]), DAY).join;
        expect(takeAfterJoin(empty, sod('09:00:01'))).toBe(true);
    });

    it('只提供股票＋ETF', () => {
        expect(lineFlowSupported('STK')).toBe(true);
        for (const t of ['WRT', 'IND', 'FUT', 'OPT', undefined, null]) expect(lineFlowSupported(t)).toBe(false);
    });
});

describe('line-indicators 設定', () => {
    it('預設兩個都關閉、門檻 500 萬；損毀或不認得的門檻回預設', () => {
        expect(defaultLineIndicatorSettings()).toEqual({ version: 1, flow: false, bigSmall: false, threshold: 500 });
        expect(sanitizeLineIndicatorSettings({ version: 1, flow: true, bigSmall: 'yes', threshold: 700 })).toEqual({ version: 1, flow: true, bigSmall: false, threshold: 500 });
        expect(sanitizeLineIndicatorSettings({ version: 2, flow: true })).toEqual(defaultLineIndicatorSettings());
        expect(sanitizeLineIndicatorSettings(null)).toEqual(defaultLineIndicatorSettings());
        expect([100, 500, 1000, 2000].map(thresholdLabel)).toEqual(['100萬', '500萬', '1千萬', '2千萬']);
    });
});

describe('line-flow 快取與即時累加', () => {
    let now = Date.UTC(2026, 10, 5, 2, 0, 0);
    beforeEach(() => {
        resetLineFlowForTest();
        m.fetch.mockReset();
        m.listeners.clear();
        now = Date.UTC(2026, 10, 5, 2, 0, 0);
        vi.spyOn(Date, 'now').mockImplementation(() => now);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        resetLineFlowForTest();
    });

    it('請求進行中的即時成交先緩衝，只接在最後一筆歷史之後（不重複、不漏）；之後的成交直接累加', async () => {
        let resolve!: (h: HistoryTicks) => void;
        m.fetch.mockReturnValueOnce(new Promise<HistoryTicks>(r => { resolve = r; }));
        const onChange = vi.fn();
        const h = retainLineFlow(contract, '2026-11-05', onChange);
        expect(m.fetch).toHaveBeenCalledWith(contract, '2026-11-05');
        expect(h.get().status).toBe('loading');
        // 請求期間：一筆已在歷史裡（同時間），一筆在歷史之後
        emit(live('09:01:10.000000', 100, 5, 1, 15));
        emit(live('09:01:20.000000', 100, 7, 2, 22));
        resolve(hist([['09:00:30.000000', 100, 10, 1], ['09:01:10.000000', 100, 5, 1]]));
        await flush();
        const v1 = flowView(h.get().agg, T500);
        expect(h.get().status).toBe('ready');
        expect([v1.totalBuy, v1.totalSell]).toEqual([15, 7]);
        // 之後的成交直接累加；零股、試撮、別的日期、別的代碼不計
        emit(live('09:02:00.000000', 100, 3, 1, 25));
        emit(live('09:02:01.000000', 100, 9, 1, 25, { intraday_odd: true }));
        emit(live('09:02:02.000000', 100, 9, 1, 25, { simtrade: true }));
        emit({ ...live('09:02:03.000000', 100, 9, 1, 34), date: '2026/11/06' });
        emit({ ...live('09:02:03.000000', 100, 9, 1, 34), code: '2317' });
        const v2 = flowView(h.get().agg, T500);
        expect([v2.totalBuy, v2.totalSell]).toEqual([18, 7]);
        expect(onChange).toHaveBeenCalled();
        h.release();
    });

    it('同檔同日：再次取用（換週期、換檔再回來）沿用快取，只送 1 次請求', async () => {
        m.fetch.mockResolvedValue(hist([['09:00:30', 100, 1, 1]]));
        const a = retainLineFlow(contract, '2026-11-05', () => undefined);
        await flush();
        a.release();
        now += 10 * 60_000;
        const b = retainLineFlow(contract, '2026-11-05', () => undefined);
        expect(b.get().status).toBe('ready');
        expect(lineFlowRequestsForTest('2330', '2026-11-05')).toBe(1);
        // 另一個日期是另一份
        retainLineFlow(contract, '2026-11-04', () => undefined);
        expect(m.fetch).toHaveBeenCalledTimes(2);
    });

    it('失敗不自動重試；重新取用且距失敗 ≥ FLOW_RETRY_MIN_MS 才重抓', async () => {
        m.fetch.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(hist([]));
        const a = retainLineFlow(contract, '2026-11-05', () => undefined);
        await flush();
        expect(a.get().status).toBe('error');
        a.release();
        now += FLOW_RETRY_MIN_MS - 1;
        const b = retainLineFlow(contract, '2026-11-05', () => undefined);
        expect(m.fetch).toHaveBeenCalledTimes(1);
        b.release();
        now += 1;
        const c = retainLineFlow(contract, '2026-11-05', () => undefined);
        expect(m.fetch).toHaveBeenCalledTimes(2);
        await flush();
        expect(c.get().status).toBe('ready');
    });

    it('累計量顯示中間漏了成交：有人在看且距上次下載 ≥ FLOW_GAP_REFETCH_MIN_MS 才重抓；重抓期間保留目前的彙總', async () => {
        m.fetch.mockResolvedValue(hist([['09:00:30', 100, 10, 1]]));
        const h = retainLineFlow(contract, '2026-11-05', () => undefined);
        await flush();
        emit(live('09:01:10', 100, 1, 1, 11));
        emit(live('09:01:20', 100, 1, 1, 12)); // 連續
        expect(m.fetch).toHaveBeenCalledTimes(1);
        emit(live('09:01:30', 100, 1, 1, 50)); // 漏了 37 張，但距上次下載不到 2 分鐘
        expect(m.fetch).toHaveBeenCalledTimes(1);
        now += FLOW_GAP_REFETCH_MIN_MS;
        emit(live('09:03:00', 100, 1, 1, 80)); // 又漏了 → 重抓
        expect(m.fetch).toHaveBeenCalledTimes(2);
        expect(h.get().status).toBe('ready');
        h.release();
    });
});
