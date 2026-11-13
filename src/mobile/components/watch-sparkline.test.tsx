// 自選迷你走勢 canvas（components/watch-sparkline.tsx）：DPR 正確、昨收虛線基準與顏色、rAF 合併重繪、沒有資料時不畫、
// 橫軸固定為交易時段（xs：橫向位置依時段、面積只到最後一點；長度不符或附加即時價時退回等距）；WatchSparkCell 傳入快照的點與位置。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sm = vi.hoisted(() => ({ series: null as null | { points: number[]; xs: number[] }, ticks: [] as unknown[] }));
vi.mock('../lib/watch-sparkline-data', async importOriginal => ({
    ...await importOriginal<typeof import('../lib/watch-sparkline-data')>(),
    useSparkline: () => sm.series,
    useSparkTick: (_c: unknown, tick: unknown) => { sm.ticks.push(tick); },
}));

import { vars } from '../../theme.css';
import { drawSparkline, sparkTone, WatchSparkCell, WatchSparkline } from './watch-sparkline';

const varName = (ref: string) => ref.slice(4, -1).split(',')[0]!.trim();

function fakeCtx() {
    const calls: string[] = [];
    const ctx: Record<string, unknown> = { calls, strokes: [] as string[], fills: [] as string[] };
    for (const fn of ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'closePath', 'save', 'restore', 'setLineDash']) {
        ctx[fn] = (...args: unknown[]) => {
            calls.push(`${fn}(${args.join(',')})`);
            if (fn === 'stroke') (ctx.strokes as string[]).push(String(ctx.strokeStyle));
            if (fn === 'fill') (ctx.fills as string[]).push(`${String(ctx.fillStyle)}@${String(ctx.globalAlpha)}`);
        };
    }
    return ctx;
}

function fakeCanvas(ctx: unknown, w = 56, h = 32) {
    return { clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: () => ctx };
}

/** moveTo／lineTo 的 x 座標（依呼叫順序） */
const xsOf = (ctx: Record<string, unknown>) => (ctx.calls as string[])
    .filter(c => c.startsWith('moveTo(') || c.startsWith('lineTo('))
    .map(c => Number(c.slice(c.indexOf('(') + 1).split(',')[0]));

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { devicePixelRatio: 3 });
    vi.stubGlobal('getComputedStyle', () => ({
        getPropertyValue: (name: string) => (name === varName(vars.color.up) ? 'UP' : name === varName(vars.color.down) ? 'DOWN' : 'MUTED'),
    }));
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('sparkTone', () => {
    it('以參考價決定方向；沒有參考價時與第一點比較', () => {
        expect(sparkTone([10, 9, 11], 10)).toBe('up');
        expect(sparkTone([10, 12, 9.5], 10)).toBe('down');
        expect(sparkTone([10, 9], undefined)).toBe('down');
        expect(sparkTone([10, 12], 0)).toBe('up');
    });

    it('最後一點等於參考價（或沒有參考價時等於第一點）為平盤 flat，不算上漲', () => {
        expect(sparkTone([9, 11, 10], 10)).toBe('flat');
        expect(sparkTone([10, 10], 0)).toBe('flat');
        expect(sparkTone([10, 12, 10], undefined)).toBe('flat');
    });
});

describe('drawSparkline', () => {
    it('畫布像素依 devicePixelRatio，座標以 CSS px 計（setTransform dpr）', () => {
        const ctx = fakeCtx();
        const cv = fakeCanvas(ctx);
        drawSparkline(cv as never, [10, 11, 12], 10);
        expect(cv.width).toBe(168);
        expect(cv.height).toBe(96);
        expect((ctx.calls as string[])[0]).toBe('setTransform(3,0,0,3,0,0)');
    });

    it('高於昨收：up 色折線＋淡色面積，昨收虛線；低於昨收：down 色', () => {
        const ctx = fakeCtx();
        drawSparkline(fakeCanvas(ctx) as never, [10, 11, 12], 10);
        expect(ctx.strokes).toEqual(['MUTED', 'UP']);
        expect(ctx.fills).toEqual(['UP@0.14']);
        expect((ctx.calls as string[])).toContain('setLineDash(2,2)');
        const down = fakeCtx();
        drawSparkline(fakeCanvas(down) as never, [10, 9, 8], 10);
        expect(down.strokes).toEqual(['MUTED', 'DOWN']);
    });

    it('平盤（最後一點等於昨收）：折線與面積用 mutedForeground，不用 up 色', () => {
        const ctx = fakeCtx();
        drawSparkline(fakeCanvas(ctx) as never, [10, 11, 10], 10);
        expect(ctx.strokes).toEqual(['MUTED', 'MUTED']);
        expect(ctx.fills).toEqual(['MUTED@0.14']);
    });

    it('xs（時間軸）：橫向位置依 xs，面積在最後一點處封閉（右側留白）；昨收虛線仍橫跨全寬', () => {
        const ctx = fakeCtx();
        drawSparkline(fakeCanvas(ctx, 100, 40) as never, [10, 11, 12], 10, [0.125, 0.25, 0.5]);
        // 虛線 0→100；面積 12.5→25→50→(50,底)→(12.5,底)；折線 12.5→25→50
        expect(xsOf(ctx)).toEqual([0, 100, 12.5, 25, 50, 50, 12.5, 12.5, 25, 50]);
        expect((ctx.calls as string[])).toContain('lineTo(50,40)');
        expect((ctx.calls as string[])).toContain('lineTo(12.5,40)');
    });

    it('xs 長度與點數不符或缺少時：等距排列、填滿寬度', () => {
        for (const xs of [[0.125, 0.25], null, undefined]) {
            const ctx = fakeCtx();
            drawSparkline(fakeCanvas(ctx, 100, 40) as never, [10, 11, 12], 10, xs);
            expect(xsOf(ctx)).toEqual([0, 100, 0, 50, 100, 100, 0, 0, 50, 100]);
        }
    });

    it('少於 2 點只清空不畫；沒有 2D context 時不拋錯', () => {
        const ctx = fakeCtx();
        drawSparkline(fakeCanvas(ctx) as never, [10], 10);
        expect(ctx.strokes).toEqual([]);
        expect(() => drawSparkline(fakeCanvas(null) as never, [1, 2], 1)).not.toThrow();
    });
});

describe('WatchSparkline', () => {
    it('即時價更新以 rAF 合併：同一幀內多次更新只畫最後一次；尾端點為即時價', async () => {
        const frames = new Map<number, () => void>();
        let id = 0;
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.set(++id, cb); return id; });
        vi.stubGlobal('cancelAnimationFrame', (n: number) => { frames.delete(n); });
        const ctx = fakeCtx();
        let view: ReactTestRenderer | undefined;
        const el = (last?: number) => createElement(WatchSparkline, { points: [10, 11], last, reference: 10 });
        await act(async () => { view = create(el(), { createNodeMock: () => fakeCanvas(ctx) }); });
        await act(async () => { view!.update(el(12)); });
        await act(async () => { view!.update(el(9)); });
        expect(frames.size).toBe(1);
        [...frames.values()][0]!();
        // 最後一點 9 低於昨收 10 → down
        expect(ctx.strokes).toEqual(['MUTED', 'DOWN']);
        const lines = (ctx.calls as string[]).filter(c => c.startsWith('lineTo('));
        // 折線 3 點（10、11、即時 9）：面積 2 段＋封閉 2 段、折線 2 段，加上虛線 1 段
        expect(lines).toHaveLength(7);
        const canvas = view!.root.find(n => n.type === 'canvas');
        expect(canvas.props['aria-hidden']).toBe('true');
        await act(async () => view!.unmount());
        expect(frames.size).toBe(0);
    });

    it('卸載時把畫布尺寸歸 0（立即釋放點陣），未執行的 rAF 取消', async () => {
        const frames = new Map<number, () => void>();
        let id = 0;
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.set(++id, cb); return id; });
        vi.stubGlobal('cancelAnimationFrame', (n: number) => { frames.delete(n); });
        const cv = fakeCanvas(fakeCtx());
        let view: ReactTestRenderer | undefined;
        await act(async () => { view = create(createElement(WatchSparkline, { points: [10, 11], reference: 10 }), { createNodeMock: () => cv }); });
        [...frames.values()].forEach(f => f());
        frames.clear();
        expect(cv).toMatchObject({ width: 168, height: 96 });
        await act(async () => { view!.update(createElement(WatchSparkline, { points: [10, 11, 12], reference: 10 })); });
        expect(frames.size).toBe(1);
        await act(async () => view!.unmount());
        expect(cv).toMatchObject({ width: 0, height: 0 });
        expect(frames.size).toBe(0);
    });

    it('xs：沒有附加即時價時依 xs 畫；附加即時價（點數多一）時退回等距', async () => {
        const frames: (() => void)[] = [];
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length; });
        vi.stubGlobal('cancelAnimationFrame', () => undefined);
        const timed = fakeCtx();
        let view: ReactTestRenderer | undefined;
        await act(async () => {
            view = create(createElement(WatchSparkline, { points: [10, 11], reference: 10, xs: [0.25, 0.5] }), { createNodeMock: () => fakeCanvas(timed) });
        });
        frames.splice(0).forEach(f => f());
        // 56 寬：14、28
        expect(xsOf(timed).slice(2)).toEqual([14, 28, 28, 14, 14, 28]);
        await act(async () => view!.unmount());

        const even = fakeCtx();
        await act(async () => {
            view = create(createElement(WatchSparkline, { points: [10, 11], last: 12, reference: 10, xs: [0.25, 0.5] }), { createNodeMock: () => fakeCanvas(even) });
        });
        frames.splice(0).forEach(f => f());
        expect(xsOf(even).slice(2)).toEqual([0, 28, 56, 56, 0, 0, 28, 56]);
        await act(async () => view!.unmount());
    });

    it('WatchSparkCell：把快照的點與時間軸位置交給 WatchSparkline；沒有快照時兩者皆 null', async () => {
        vi.stubGlobal('requestAnimationFrame', () => 1);
        vi.stubGlobal('cancelAnimationFrame', () => undefined);
        const contract = { code: '2330', security_type: 'STK' as const, exchange: 'TSE' as const, target_code: null };
        sm.series = { points: [10, 11, 12], xs: [0.1, 0.2, 0.3] };
        let view: ReactTestRenderer | undefined;
        await act(async () => { view = create(createElement(WatchSparkCell, { contract, reference: 10, tick: undefined }), { createNodeMock: () => fakeCanvas(fakeCtx()) }); });
        const props = () => view!.root.findByType(WatchSparkline).props;
        expect(props()).toMatchObject({ points: [10, 11, 12], xs: [0.1, 0.2, 0.3], reference: 10 });
        expect(props().last).toBeUndefined();
        sm.series = null;
        await act(async () => { view!.update(createElement(WatchSparkCell, { contract, reference: 10, tick: undefined })); });
        expect(props()).toMatchObject({ points: null, xs: null });
        await act(async () => view!.unmount());
    });

    it('沒有資料：不畫（空白佔位）', async () => {
        const frames: (() => void)[] = [];
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length; });
        vi.stubGlobal('cancelAnimationFrame', () => undefined);
        const ctx = fakeCtx();
        let view: ReactTestRenderer | undefined;
        await act(async () => { view = create(createElement(WatchSparkline, { points: null, last: 1010, reference: 1000 }), { createNodeMock: () => fakeCanvas(ctx) }); });
        frames.forEach(f => f());
        expect(ctx.strokes).toEqual([]);
        await act(async () => view!.unmount());
    });
});
