// PriceFlash：350ms 節流與不閃條件（第一次、來源切換、遮蔽、停用、不可見、減少動態、沒有 WAAPI）；只動畫 opacity
import { createElement, useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vars } from '../../theme.css';
import { setMotionClockForTest } from '../motion/spring';
import { createFlashGate, isFlashVisible, nextFlash, usePriceFlash, type PriceFlashOptions } from './price-flash';

describe('nextFlash (pure gate)', () => {
    it('never flashes on the first value', () => {
        const g = createFlashGate();
        expect(nextFlash(g, 100, 'trade', 0, true)).toBeNull();
        expect(nextFlash(g, 101, 'trade', 1000, true)).toBe('up');
        expect(nextFlash(g, 99, 'trade', 2000, true)).toBe('down');
    });

    it('throttles the same cell to one flash per 350ms; skipped ticks do not extend the window', () => {
        const g = createFlashGate();
        nextFlash(g, 100, 'trade', 0, true);
        expect(nextFlash(g, 101, 'trade', 1000, true)).toBe('up');
        expect(nextFlash(g, 102, 'trade', 1200, true)).toBeNull(); // 200ms
        expect(nextFlash(g, 103, 'trade', 1349, true)).toBeNull(); // 349ms
        expect(nextFlash(g, 104, 'trade', 1350, true)).toBe('up'); // 350ms（自上次實際閃爍起算）
    });

    it('does not flash on equal values, nulls or a source switch', () => {
        const g = createFlashGate();
        nextFlash(g, 100, 'snapshot', 0, true);
        expect(nextFlash(g, 100, 'snapshot', 1000, true)).toBeNull();
        expect(nextFlash(g, 105, 'trade', 2000, true)).toBeNull(); // 快照 → 成交
        expect(nextFlash(g, null, 'trade', 3000, true)).toBeNull();
        expect(nextFlash(g, 106, 'trade', 4000, true)).toBeNull(); // 上一筆是 null
        expect(nextFlash(g, 107, 'trade', 5000, true)).toBe('up');
    });

    it('when not allowed it only records the value (no flash, no throttle window)', () => {
        const g = createFlashGate();
        nextFlash(g, 100, undefined, 0, true);
        expect(nextFlash(g, 101, undefined, 1000, false)).toBeNull();
        expect(g.prev).toBe(101);
        expect(nextFlash(g, 100, undefined, 1100, true)).toBe('down');
    });
});

describe('usePriceFlash', () => {
    let view: ReactTestRenderer | undefined;
    let now = 0;
    let node: { style: Record<string, string>; animate?: ReturnType<typeof vi.fn> };

    function Cell({ value, opts }: { value: number | null; opts?: PriceFlashOptions }) {
        const ref = useRef<HTMLSpanElement | null>(null);
        usePriceFlash(ref, value, opts);
        return createElement('span', { ref, 'aria-hidden': 'true' });
    }
    async function render(value: number | null, opts?: PriceFlashOptions) {
        const el = createElement(Cell, { value, opts });
        await act(async () => {
            if (view) view.update(el);
            else view = create(el, { createNodeMock: () => node });
        });
    }

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        now = 10_000;
        setMotionClockForTest({ now: () => now, frame: () => 0, cancel: () => undefined });
        node = { style: {}, animate: vi.fn() };
    });
    afterEach(async () => {
        await act(async () => view?.unmount());
        view = undefined;
        setMotionClockForTest(null);
        vi.unstubAllGlobals();
    });

    it('animates only opacity 1→0 over 600ms with the up/down flash colour', async () => {
        await render(100);
        expect(node.animate).not.toHaveBeenCalled();
        now += 1000;
        await render(101);
        expect(node.animate).toHaveBeenCalledTimes(1);
        expect(node.animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0 }], { duration: 600, easing: 'ease-out' });
        expect(node.style.backgroundColor).toBe(vars.color.upFlash);
        now += 1000;
        await render(99);
        expect(node.style.backgroundColor).toBe(vars.color.downFlash);
        expect(node.animate).toHaveBeenCalledTimes(2);
    });

    it('throttles within 350ms', async () => {
        await render(100);
        now += 1000;
        await render(101);
        now += 100;
        await render(102);
        now += 249;
        await render(103);
        expect(node.animate).toHaveBeenCalledTimes(1);
        now += 1;
        await render(104);
        expect(node.animate).toHaveBeenCalledTimes(2);
    });

    it('does not flash when masked, disabled, or on a source switch', async () => {
        await render(100, { source: 'snapshot' });
        now += 1000;
        await render(101, { source: 'trade' });
        now += 1000;
        await render(102, { source: 'trade', masked: true });
        now += 1000;
        await render(103, { source: 'trade', enabled: false });
        expect(node.animate).not.toHaveBeenCalled();
        now += 1000;
        await render(104, { source: 'trade' });
        expect(node.animate).toHaveBeenCalledTimes(1);
    });

    it('does not flash with reduced motion', async () => {
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduced-motion'), addEventListener() {}, removeEventListener() {} }));
        await render(100);
        now += 1000;
        await render(101);
        expect(node.animate).not.toHaveBeenCalled();
    });

    it('skips silently without Element.animate', async () => {
        node = { style: {} };
        await render(100);
        now += 1000;
        await expect(render(101)).resolves.toBeUndefined();
        expect(node.style.backgroundColor).toBeUndefined();
    });

    it('only flashes visible cells (shared IntersectionObserver)', async () => {
        const observers: { cb: (e: { target: unknown; isIntersecting: boolean }[]) => void; observed: unknown[] }[] = [];
        class FakeIO {
            observed: unknown[] = [];
            constructor(public cb: (e: { target: unknown; isIntersecting: boolean }[]) => void) { observers.push(this); }
            observe(el: unknown) { this.observed.push(el); }
            unobserve() {}
            disconnect() {}
        }
        vi.stubGlobal('IntersectionObserver', FakeIO);
        node = { style: {}, animate: vi.fn(), nodeType: 1 } as typeof node;
        await render(100);
        expect(observers).toHaveLength(1);
        expect(observers[0]!.observed).toEqual([node]);
        expect(isFlashVisible(node)).toBe(false); // 尚未回報 → 視為不可見
        now += 1000;
        await render(101);
        expect(node.animate).not.toHaveBeenCalled();
        observers[0]!.cb([{ target: node, isIntersecting: true }]);
        now += 1000;
        await render(102);
        expect(node.animate).toHaveBeenCalledTimes(1);
        observers[0]!.cb([{ target: node, isIntersecting: false }]);
        now += 1000;
        await render(103);
        expect(node.animate).toHaveBeenCalledTimes(1);
    });
});
