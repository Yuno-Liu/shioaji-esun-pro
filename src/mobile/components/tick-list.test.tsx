// 逐筆明細（規格 §6.2；稽核 P1）：列 memo（flush 只重繪新列）、隱藏時不重繪也不重抓、切回來一次寫入、
// 歷史讀取失敗但已有即時列時的提示與重試、載入狀態 role=status。
// 以 vi.mock 隔離 src/lib，不打任何真實 API。
import { createElement, Profiler } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { SseTick } from '../../lib/types/market';
import type { HistoryTicks } from '../../lib/types/tick';

const m = vi.hoisted(() => ({
    fetchLastTicks: vi.fn(),
    retainQuote: vi.fn(),
    listeners: new Set<(t: unknown) => void>(),
    formatCalls: 0,
}));
vi.mock('../../lib/shioaji', () => ({ fetchLastTicks: m.fetchLastTicks }));
vi.mock('../../lib/quote-ownership', () => ({ retainQuote: m.retainQuote }));
vi.mock('../../lib/stream', () => ({
    onAnyTick: (fn: (t: unknown) => void) => {
        m.listeners.add(fn);
        return () => { m.listeners.delete(fn); };
    },
}));
vi.mock('../../lib/utils/kbars', () => ({ dateStrOffset: () => '2026-11-14' }));
// 計算每列格式化次數（＝實際重繪的列數）；輸出仍用原本的函式
vi.mock('../lib/num-format', async importOriginal => {
    const real = await importOriginal<typeof import('../lib/num-format')>();
    return { ...real, formatToTick: (...a: Parameters<typeof real.formatToTick>) => { m.formatCalls++; return real.formatToTick(...a); } };
});

import { historyWithoutOverlap, TICK_LIST_FLUSH_MS, TickList, type TickRow } from './tick-list';

const contract = { exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', reference: 984 } as unknown as ContractInfo;

function history(n: number): HistoryTicks {
    const h: HistoryTicks = { datetime: [], close: [], volume: [], bid_price: [], bid_volume: [], ask_price: [], ask_volume: [], tick_type: [] };
    for (let i = 0; i < n; i++) {
        const s = String(i % 60).padStart(2, '0');
        const mm = String(Math.floor(i / 60) % 60).padStart(2, '0');
        h.datetime.push(`2026-11-13 09:${mm}:${s}.000000`);
        h.close.push(980 + (i % 5));
        h.volume.push(1 + (i % 3));
        h.tick_type.push(1 + (i % 2));
    }
    return h;
}

let seq = 0;
function emit(close = '985', time?: string): void {
    seq++;
    const t = { code: '2330', date: '2026/11/13', time: time ?? `10:${String(Math.floor(seq / 60) % 60).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.000`, close, volume: 1, total_volume: 1, tick_type: 1 } as unknown as SseTick;
    for (const fn of [...m.listeners]) fn(t);
}

let view: ReactTestRenderer | undefined;
let commits = 0;
const onRender = () => { commits++; };
const el = (active?: boolean) => createElement(Profiler, { id: 'ticks', onRender }, createElement(TickList, { code: '2330', contract, active }));
const items = () => view!.root.findAll(n => n.type === 'li');
const allById = (id: string) => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === id);
const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));

async function mount(active?: boolean) {
    await act(async () => { view = create(el(active)); });
}
async function settle() {
    await act(async () => { await Promise.resolve(); });
}
async function flush() {
    await act(async () => { vi.advanceTimersByTime(TICK_LIST_FLUSH_MS); });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    m.fetchLastTicks.mockReset();
    m.retainQuote.mockReset().mockReturnValue(() => undefined);
    m.listeners.clear();
    m.formatCalls = 0;
    commits = 0;
});
afterEach(() => {
    act(() => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('TickList', () => {
    it('列為 memo：200 列時再進 1 筆，只重繪新列與前一個最新列（2 次格式化，原本 200 次）', async () => {
        m.fetchLastTicks.mockResolvedValue(history(200));
        await mount();
        await settle();
        expect(items()).toHaveLength(200);
        m.formatCalls = 0;
        emit('986');
        await flush();
        expect(items()).toHaveLength(200);
        expect(text(items()[0]!)).toContain('986');
        expect(m.formatCalls).toBe(2);
    });

    it('切換 5 次（active 真假交替）：歷史只讀 1 次、訂閱 1 次；隱藏時不重繪；切回來列完整、不閃載入中', async () => {
        m.fetchLastTicks.mockResolvedValue(history(50));
        await mount(true);
        await settle();
        expect(items()).toHaveLength(50);
        for (let i = 0; i < 5; i++) {
            await act(async () => { view!.update(el(false)); });
            expect(allById('tick-list')[0]!.props.hidden).toBe(true);
            commits = 0;
            m.formatCalls = 0;
            emit();
            emit();
            await flush();
            await flush();
            // 隱藏時：不 setState、不重繪
            expect(commits).toBe(0);
            expect(m.formatCalls).toBe(0);
            expect(items()).toHaveLength(50 + i * 2);
            // 切回來：同一次 commit 就寫入隱藏期間的 2 筆，沒有「載入中」
            await act(async () => { view!.update(el(true)); });
            expect(allById('tick-list')[0]!.props.hidden).toBe(false);
            expect(allById('tick-loading')).toHaveLength(0);
            expect(items()).toHaveLength(50 + (i + 1) * 2);
        }
        expect(m.fetchLastTicks).toHaveBeenCalledTimes(1);
        expect(m.retainQuote).toHaveBeenCalledTimes(1);
    });

    it('第一次 active 前不掛載、不讀取', async () => {
        m.fetchLastTicks.mockResolvedValue(history(3));
        await mount(false);
        expect(view!.toJSON()).toBeNull();
        expect(m.fetchLastTicks).not.toHaveBeenCalled();
        await act(async () => { view!.update(el(true)); });
        await settle();
        expect(m.fetchLastTicks).toHaveBeenCalledTimes(1);
        expect(items()).toHaveLength(3);
    });

    it('歷史讀取中：骨架 role=status，保留「載入中…」文字', async () => {
        m.fetchLastTicks.mockReturnValue(new Promise(() => undefined));
        await mount();
        const loading = allById('tick-loading');
        expect(loading).toHaveLength(1);
        expect(loading[0]!.props.role).toBe('status');
        expect(text(loading[0]!)).toContain('載入中…');
    });

    it('歷史讀取失敗且沒有列：明細載入失敗＋重試', async () => {
        m.fetchLastTicks.mockRejectedValue(new Error('boom'));
        await mount();
        await settle();
        expect(text(allById('tick-error')[0]!)).toContain('明細載入失敗');
        expect(allById('tick-history-error')).toHaveLength(0);
    });

    it('歷史讀取失敗但已有即時列：顯示「較早的明細載入失敗」；重試不清空畫面，成功後補上較早的列', async () => {
        m.fetchLastTicks.mockRejectedValueOnce(new Error('boom'));
        await mount();
        await settle();
        emit('990', '10:00:01.000');
        await flush();
        expect(items()).toHaveLength(1);
        const note = allById('tick-history-error');
        expect(note).toHaveLength(1);
        expect(note[0]!.props.role).toBe('status');
        expect(text(note[0]!)).toContain('較早的明細載入失敗');
        let resolve!: (h: HistoryTicks) => void;
        m.fetchLastTicks.mockReturnValueOnce(new Promise<HistoryTicks>(r => { resolve = r; }));
        await act(async () => { note[0]!.findByType('button').props.onClick(); });
        // 重試中：已有的列不清掉、也不閃「載入中」
        expect(items()).toHaveLength(1);
        expect(allById('tick-loading')).toHaveLength(0);
        await act(async () => { resolve(history(5)); });
        expect(m.fetchLastTicks).toHaveBeenCalledTimes(2);
        expect(allById('tick-history-error')).toHaveLength(0);
        expect(items()).toHaveLength(6);
        expect(text(items()[0]!)).toContain('990');
    });
});

describe('historyWithoutOverlap', () => {
    const row = (id: number, time: string, price = 100, volume = 1, tickType = 1): TickRow => ({ id, time, price, volume, tickType });
    it('沒有既有列時原樣回傳', () => {
        const h = [row(1, '09:00:01'), row(2, '09:00:00')];
        expect(historyWithoutOverlap([], h)).toEqual(h);
    });
    it('逐筆抵銷重疊的成交；同一秒相同成交只抵銷重疊的筆數', () => {
        const existing = [row(10, '09:00:02'), row(11, '09:00:01')];
        const h = [row(1, '09:00:02'), row(2, '09:00:01'), row(3, '09:00:01'), row(4, '09:00:00')];
        expect(historyWithoutOverlap(existing, h).map(r => r.id)).toEqual([3, 4]);
    });
});
