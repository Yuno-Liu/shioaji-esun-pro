// 自選迷你走勢資料（lib/watch-sparkline-data.ts）：交易時段判斷（期貨日盤／夜盤、盤前、週末、跨午夜）、
// 時段內 K 棒篩選與抽樣、每檔每段一次的快取、假日補找、收盤後補讀、即時尾段、佇列上限、取消、重試間隔與計時器。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ fetchKbars: vi.fn() }));
vi.mock('../../lib/shioaji', () => ({ fetchKbars: m.fetchKbars }));

import { CLOSE_GRACE as LIB_CLOSE_GRACE, sessionWindowFor as libSessionWindowFor } from '../../lib/intraday-session';
import { wallClockToUtc } from '../../lib/utils/kbars';
import {
    CLOSE_GRACE,
    currentSparkKey,
    sessionWindowFor,
    getSparklinePoints,
    recordSparkTick,
    resetSparklinesForTest,
    retainSparkline,
    samplePoints,
    sessionBars,
    SPARK_CONCURRENCY,
    SPARK_MAX_POINTS,
    SPARK_RETRY_MS,
    sparkKey,
    sparklineQueueForTest,
    sparkSessionClosed,
    sparkTarget,
    subscribeSparklines,
} from './watch-sparkline-data';

/** 台北時間設為系統時間（只假 Date，計時器另外指定） */
const at = (tw: string) => vi.setSystemTime(new Date(`${tw}+08:00`));
const w = (tw: string) => wallClockToUtc(tw);
const kbars = (rows: [string, number][]) => ({
    datetime: rows.map(r => r[0]),
    Close: rows.map(r => r[1]),
    Open: [], High: [], Low: [], Volume: [], Amount: [],
});
/** 從 from 起每分鐘一根（label＝分鐘結束），共 n 根，收盤 base+i */
function minutes(from: string, n: number, base = 100): [string, number][] {
    const t0 = w(from);
    return Array.from({ length: n }, (_, i) => [new Date((t0 + i * 60) * 1000).toISOString().slice(0, 19).replace('T', ' '), base + i]);
}
const stk = (code: string) => ({ code, security_type: 'STK' as const, exchange: 'TSE' as const, target_code: null });
const fut = (code = 'TXFR1') => ({ code, security_type: 'FUT' as const, exchange: 'TAIFEX' as const, target_code: null });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const range = (call: number) => (m.fetchKbars.mock.calls[call] as unknown[]).slice(1, 3);

beforeEach(() => {
    resetSparklinesForTest();
    m.fetchKbars.mockReset();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    at('2026-11-04T10:00:00'); // 週三盤中
});
afterEach(() => {
    resetSparklinesForTest();
    vi.useRealTimers();
});

describe('sessionWindowFor 複本與 lib/intraday-session.ts 一致', () => {
    it('期貨、股票逐分鐘比對（一週）；CLOSE_GRACE 相同', () => {
        const t0 = w('2026-11-02T00:00');
        const diff: string[] = [];
        for (const sec of ['FUT', 'OPT', 'STK', 'IND', null] as const) {
            for (let t = t0; t < t0 + 7 * 86400; t += 60) {
                const a = sessionWindowFor(sec, t);
                const b = libSessionWindowFor(sec, t);
                if (a.start !== b.start || a.end !== b.end || a.night !== b.night) diff.push(`${sec}@${t}`);
            }
        }
        expect(diff).toEqual([]);
        expect(CLOSE_GRACE).toBe(LIB_CLOSE_GRACE);
    });
});

describe('sparkTarget（交易時段，不用日曆日）', () => {
    it('期貨：07:30 → 前一晚夜盤；10:00 → 日盤；14:00 → 剛收的日盤；21:00 與跨午夜 00:30 → 同一段夜盤', () => {
        expect(sparkTarget('FUT', w('2026-11-04T07:30'))).toEqual({ win: { start: w('2026-11-03T15:00'), end: w('2026-11-04T05:00'), night: true }, current: false });
        expect(sparkTarget('FUT', w('2026-11-04T10:00'))).toEqual({ win: { start: w('2026-11-04T08:45'), end: w('2026-11-04T13:45'), night: false }, current: true });
        expect(sparkTarget('FUT', w('2026-11-04T14:00')).win.start).toBe(w('2026-11-04T08:45'));
        const night = sparkTarget('FUT', w('2026-11-04T21:00'));
        expect(night).toEqual({ win: { start: w('2026-11-04T15:00'), end: w('2026-11-05T05:00'), night: true }, current: true });
        expect(sparkTarget('FUT', w('2026-11-05T00:30')).win).toEqual(night.win);
    });

    it('期貨週末與週一盤前 → 週五夜盤', () => {
        const friNight = w('2026-11-06T15:00');
        expect(sparkTarget('FUT', w('2026-11-07T03:00')).win.start).toBe(friNight); // 週六凌晨仍是週五夜盤（盤中）
        expect(sparkTarget('FUT', w('2026-11-07T10:00')).win.start).toBe(friNight);
        expect(sparkTarget('FUT', w('2026-11-08T20:00')).win.start).toBe(friNight);
        expect(sparkTarget('FUT', w('2026-11-09T07:00'))).toMatchObject({ win: { start: friNight }, current: false });
    });

    it('股票：盤前 → 前一交易日；盤後 → 當日；週六、週日、週一盤前 → 週五', () => {
        expect(sparkTarget('STK', w('2026-11-04T08:30'))).toMatchObject({ win: { start: w('2026-11-03T09:00') }, current: false });
        expect(sparkTarget('STK', w('2026-11-04T20:00'))).toMatchObject({ win: { start: w('2026-11-04T09:00'), end: w('2026-11-04T13:30') }, current: true });
        for (const t of ['2026-11-07T10:00', '2026-11-08T10:00', '2026-11-09T08:00']) {
            expect(sparkTarget('STK', w(t))).toMatchObject({ win: { start: w('2026-11-06T09:00') }, current: false });
        }
    });

    it('快取鍵＝代碼＋時段起點；收盤（含寬限）判斷', () => {
        expect(currentSparkKey('2330', 'STK', w('2026-11-04T10:00'))).toBe(sparkKey('2330', w('2026-11-04T09:00')));
        expect(sparkSessionClosed('STK', w('2026-11-04T13:33'))).toBe(false);
        expect(sparkSessionClosed('STK', w('2026-11-04T13:35'))).toBe(true);
    });
});

describe('sessionBars／samplePoints', () => {
    it('只保留時段 (start, end+寬限] 內的有效收盤', () => {
        const win = sparkTarget('STK', w('2026-11-04T10:00')).win;
        const k = kbars([['2026-11-03 13:30:00', 5], ['2026-11-04 09:00:00', 6], ['2026-11-04 09:01:00', 10], ['2026-11-04 09:02:00', 0], ['2026-11-04 13:33:00', 11], ['2026-11-04 13:40:00', 12]]);
        expect(sessionBars(k as never, win).map(b => b.c)).toEqual([10, 11]);
    });

    it('超過上限時等距抽樣並保留最後一點', () => {
        const out = samplePoints(Array.from({ length: 300 }, (_, i) => i + 1));
        expect(out).toHaveLength(SPARK_MAX_POINTS);
        expect(out[0]).toBe(1);
        expect(out.at(-1)).toBe(300);
    });
});

describe('retainSparkline：時段', () => {
    it('期貨 07:30：只取前一晚夜盤（跨午夜兩側），不混入日盤；08:45 換段後重讀日盤', async () => {
        at('2026-11-04T07:30:00');
        m.fetchKbars.mockResolvedValueOnce(kbars([
            ['2026-11-03 10:00:00', 1], // 前一天日盤
            ['2026-11-03 15:01:00', 20], ['2026-11-03 23:59:00', 21], ['2026-11-04 00:01:00', 22], ['2026-11-04 05:00:00', 23],
        ]));
        const release = retainSparkline(fut());
        await flush();
        expect(range(0)).toEqual(['2026-11-03', '2026-11-04']);
        expect(getSparklinePoints('TXFR1', 'FUT')).toEqual([20, 21, 22, 23]);
        release();
        // 同一段：不再讀
        at('2026-11-04T08:40:00');
        retainSparkline(fut())();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
        // 日盤開始：新鍵、只帶當日
        at('2026-11-04T09:00:00');
        m.fetchKbars.mockResolvedValueOnce(kbars(minutes('2026-11-04T08:46', 14, 300)));
        retainSparkline(fut())();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
        expect(range(1)).toEqual(['2026-11-04', '2026-11-04']);
        expect(getSparklinePoints('TXFR1', 'FUT')?.[0]).toBe(300);
    });

    it('期貨 21:00：只取當晚夜盤（不串前一晚夜盤與當日日盤）', async () => {
        at('2026-11-04T21:00:00');
        m.fetchKbars.mockResolvedValueOnce(kbars([
            ['2026-11-04 00:30:00', 1], ['2026-11-04 10:00:00', 2], ['2026-11-04 13:45:00', 3],
            ['2026-11-04 15:01:00', 30], ['2026-11-04 20:59:00', 31],
        ]));
        retainSparkline(fut());
        await flush();
        expect(range(0)).toEqual(['2026-11-04', '2026-11-05']);
        expect(getSparklinePoints('TXFR1', 'FUT')).toEqual([30, 31]);
    });

    it('期貨 00:30（夜盤中）：同一段；夜盤跨過 00:00 時鍵不變、走勢不清空', async () => {
        at('2026-11-04T23:58:00');
        m.fetchKbars.mockResolvedValueOnce(kbars([['2026-11-04 15:01:00', 30], ['2026-11-04 23:58:00', 31]]));
        const release = retainSparkline(fut());
        await flush();
        const before = currentSparkKey('TXFR1', 'FUT');
        at('2026-11-05T00:30:00');
        expect(currentSparkKey('TXFR1', 'FUT')).toBe(before);
        expect(getSparklinePoints('TXFR1', 'FUT')).toEqual([30, 31]);
        recordSparkTick('TXFR1', 'FUT', 32, w('2026-11-05T00:29:30'));
        expect(getSparklinePoints('TXFR1', 'FUT')).toEqual([30, 31, 32]);
        release();
        retainSparkline(fut())();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
    });

    it('股票週六：讀週五（範圍只有週五），成功後整個週末不再請求', async () => {
        at('2026-11-07T10:00:00');
        m.fetchKbars.mockResolvedValueOnce(kbars(minutes('2026-11-06T09:01', 270)));
        retainSparkline(stk('2330'))();
        await flush();
        expect(range(0)).toEqual(['2026-11-06', '2026-11-06']);
        expect(getSparklinePoints('2330')).toHaveLength(SPARK_MAX_POINTS);
        at('2026-11-08T20:00:00');
        retainSparkline(stk('2330'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
    });

    it('假日（最近一段沒有資料、不在盤中）：同一次排隊補找一次、顯示最近一段；仍沒有就不再重抓', async () => {
        at('2026-11-07T10:00:00'); // 週五休市
        m.fetchKbars.mockResolvedValueOnce(kbars([]));
        m.fetchKbars.mockResolvedValueOnce(kbars([...minutes('2026-11-04T09:01', 3, 10), ...minutes('2026-11-05T09:01', 3, 50)]));
        retainSparkline(stk('2330'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
        expect(range(1)).toEqual(['2026-11-01', '2026-11-06']);
        expect(getSparklinePoints('2330')).toEqual([50, 51, 52]);
        // 都沒有：保持空白直到時段鍵改變
        m.fetchKbars.mockResolvedValue(kbars([]));
        retainSparkline(stk('2317'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(4);
        at('2026-11-07T12:00:00');
        retainSparkline(stk('2317'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(4);
        expect(getSparklinePoints('2317')).toBeNull();
    });
});

describe('retainSparkline：快取、即時尾段與補讀', () => {
    it('每檔每段成功讀取一次，並通知訂閱者', async () => {
        m.fetchKbars.mockResolvedValue(kbars([['2026-11-04 09:01:00', 10], ['2026-11-04 09:02:00', 12]]));
        const listener = vi.fn();
        subscribeSparklines(listener);
        const release = retainSparkline(stk('2330'));
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
        expect(range(0)).toEqual(['2026-11-04', '2026-11-04']);
        expect(getSparklinePoints('2330')).toEqual([10, 12]);
        expect(listener).toHaveBeenCalled();
        release();
        retainSparkline(stk('2330'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
    });

    it('即時尾段：同一分鐘取代、新分鐘 append；早於最後一根 K、其他時段、無效價都略過；同一分鐘更新最後一根', async () => {
        at('2026-11-04T09:20:10');
        m.fetchKbars.mockResolvedValueOnce(kbars(minutes('2026-11-04T09:01', 20)));
        retainSparkline(stk('2330'));
        await flush();
        const pts = () => getSparklinePoints('2330')!;
        expect(pts()).toHaveLength(20);
        expect(pts().at(-1)).toBe(119);
        recordSparkTick('2330', 'STK', 125, w('2026-11-04T09:19:30')); // label 09:20＝最後一根 → 更新它
        expect(pts()).toHaveLength(20);
        expect(pts().at(-1)).toBe(125);
        recordSparkTick('2330', 'STK', 130, w('2026-11-04T09:20:30')); // label 09:21 → append
        recordSparkTick('2330', 'STK', 131, w('2026-11-04T09:20:50')); // 同一分鐘 → 取代
        expect(pts()).toHaveLength(21);
        expect(pts().at(-1)).toBe(131);
        recordSparkTick('2330', 'STK', 132, w('2026-11-04T09:21:05'));
        expect(pts()).toHaveLength(22);
        const snapshot = pts();
        recordSparkTick('2330', 'STK', 1, w('2026-11-04T09:05:00')); // 早於最後一根
        recordSparkTick('2330', 'STK', 1, w('2026-11-03T13:00:00')); // 前一段
        recordSparkTick('2330', 'STK', 0, w('2026-11-04T09:22:00'));
        recordSparkTick('2330', 'STK', 132, w('2026-11-04T09:21:30')); // 同價不變
        expect(pts()).toBe(snapshot);
    });

    it('盤中讀過的商品：收盤後重新 retain 補讀一次（每段最多 2 次）', async () => {
        at('2026-11-04T09:20:00');
        m.fetchKbars.mockResolvedValueOnce(kbars(minutes('2026-11-04T09:01', 20)));
        retainSparkline(stk('2330'))();
        await flush();
        at('2026-11-04T12:00:00');
        retainSparkline(stk('2330'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
        at('2026-11-04T13:40:00');
        m.fetchKbars.mockResolvedValueOnce(kbars(minutes('2026-11-04T09:01', 270)));
        retainSparkline(stk('2330'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
        expect(getSparklinePoints('2330')).toHaveLength(SPARK_MAX_POINTS);
        at('2026-11-04T20:00:00');
        retainSparkline(stk('2330'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
    });

    it('盤後才第一次讀：不補讀', async () => {
        at('2026-11-04T14:00:00');
        m.fetchKbars.mockResolvedValue(kbars(minutes('2026-11-04T09:01', 270)));
        retainSparkline(stk('2330'))();
        await flush();
        at('2026-11-04T15:00:00');
        retainSparkline(stk('2330'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
    });

    it('盤中資料不足 2 根：列一直可見時，SPARK_RETRY_MS 到期由計時器重新排隊；釋放後計時取消', async () => {
        at('2026-11-04T09:00:30');
        m.fetchKbars.mockResolvedValueOnce(kbars([['2026-11-04 09:01:00', 10]]));
        const release = retainSparkline(stk('2330'));
        await flush();
        expect(getSparklinePoints('2330')).toBeNull();
        m.fetchKbars.mockResolvedValueOnce(kbars(minutes('2026-11-04T09:01', 15)));
        await vi.advanceTimersByTimeAsync(SPARK_RETRY_MS);
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
        expect(getSparklinePoints('2330')).toHaveLength(15);
        release();
        // 釋放後：失敗也不由計時器重試
        m.fetchKbars.mockRejectedValue(new Error('500'));
        const r2 = retainSparkline(stk('2317'));
        await flush();
        r2();
        await vi.advanceTimersByTimeAsync(SPARK_RETRY_MS * 2);
        expect(m.fetchKbars).toHaveBeenCalledTimes(3);
    });
});

describe('retainSparkline：佇列', () => {
    it(`同時最多 ${SPARK_CONCURRENCY} 個；完成一個才啟動下一個；最後一個持有者釋放時取消未開始的請求`, async () => {
        const resolvers: ((v: unknown) => void)[] = [];
        m.fetchKbars.mockImplementation(() => new Promise(r => { resolvers.push(r); }));
        at('2026-11-04T13:40:00'); // 收盤後：沒資料也不重試、不補找以外的請求
        const releases = ['1', '2', '3', '4'].map(c => retainSparkline(stk(c)));
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
        expect(sparklineQueueForTest()).toEqual({ queued: 2, inflight: 2 });
        // 第 4 檔兩個持有者：釋放一個仍在排隊
        const extra = retainSparkline(stk('4'));
        releases[3]!();
        expect(sparklineQueueForTest().queued).toBe(2);
        extra();
        expect(sparklineQueueForTest().queued).toBe(1);
        const two = kbars(minutes('2026-11-04T09:01', 2));
        resolvers[0]!(two);
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(3);
        expect((m.fetchKbars.mock.calls[2] as unknown[])[0]).toMatchObject({ code: '3' });
        resolvers[1]!(two);
        resolvers[2]!(two);
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(3);
        expect(sparklineQueueForTest()).toEqual({ queued: 0, inflight: 0 });
        releases.forEach(r => r());
    });

    it('失敗：等 SPARK_RETRY_MS 才重試；同步拋錯不卡住佇列', async () => {
        m.fetchKbars.mockImplementationOnce(() => { throw new Error('boom'); });
        retainSparkline(stk('A'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
        expect(sparklineQueueForTest()).toEqual({ queued: 0, inflight: 0 });
        retainSparkline(stk('A'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + SPARK_RETRY_MS);
        m.fetchKbars.mockResolvedValueOnce(kbars(minutes('2026-11-04T09:01', 3)));
        retainSparkline(stk('A'))();
        await flush();
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
        expect(getSparklinePoints('A')).toEqual([100, 101, 102]);
    });

    it('取消排隊後還原原狀態：之後可見時重新排隊', async () => {
        const resolvers: ((v: unknown) => void)[] = [];
        m.fetchKbars.mockImplementation(() => new Promise(r => { resolvers.push(r); }));
        retainSparkline(stk('1'));
        retainSparkline(stk('2'));
        retainSparkline(stk('3'))();
        expect(sparklineQueueForTest().queued).toBe(0);
        const again = retainSparkline(stk('3'));
        expect(sparklineQueueForTest().queued).toBe(1);
        again();
    });
});
