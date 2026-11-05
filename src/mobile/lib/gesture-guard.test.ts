// 手勢防護：頁面雙指縮放與 iOS gesture 事件被擋；圖表（data-allow-pinch）內與單指操作不受影響
import { describe, expect, it, vi } from 'vitest';
import { ALLOW_PINCH_SELECTOR, GESTURE_EVENTS, installGestureGuard, isInPinchAllowedArea } from './gesture-guard';

type Listener = (e: Event) => void;

function fakeTarget() {
    const listeners = new Map<string, { fn: Listener; opts: unknown }[]>();
    return {
        listeners,
        addEventListener: vi.fn((type: string, fn: Listener, opts: unknown) => {
            listeners.set(type, [...(listeners.get(type) ?? []), { fn, opts }]);
        }),
        removeEventListener: vi.fn((type: string, fn: Listener) => {
            listeners.set(type, (listeners.get(type) ?? []).filter(l => l.fn !== fn));
        }),
        dispatchEvent: () => true,
        fire(type: string, e: object) {
            for (const l of listeners.get(type) ?? []) l.fn(e as unknown as Event);
        },
    };
}

/** 假元素：inAllowed＝是否在 [data-allow-pinch="true"] 之內 */
const element = (inAllowed: boolean) => ({ closest: (sel: string) => (sel === ALLOW_PINCH_SELECTOR && inAllowed ? {} : null) });

function event(target: unknown, extra: { touches?: unknown[]; cancelable?: boolean } = {}) {
    return { target, cancelable: extra.cancelable ?? true, touches: extra.touches, preventDefault: vi.fn() };
}

describe('isInPinchAllowedArea', () => {
    it('元素、文字節點（用父元素）、無目標', () => {
        expect(isInPinchAllowedArea(element(true) as unknown as EventTarget)).toBe(true);
        expect(isInPinchAllowedArea(element(false) as unknown as EventTarget)).toBe(false);
        expect(isInPinchAllowedArea({ parentElement: element(true) } as unknown as EventTarget)).toBe(true);
        expect(isInPinchAllowedArea({} as EventTarget)).toBe(false);
        expect(isInPinchAllowedArea(null)).toBe(false);
    });
});

describe('installGestureGuard', () => {
    it('以 passive:false 監聽 gesture 事件與 touchmove', () => {
        const t = fakeTarget();
        installGestureGuard(t);
        for (const type of [...GESTURE_EVENTS, 'touchmove']) {
            const l = t.listeners.get(type);
            expect(l).toHaveLength(1);
            expect(l![0]!.opts).toMatchObject({ passive: false });
        }
    });

    it('非允許區域：擋下 gesturestart／gesturechange／gestureend', () => {
        const t = fakeTarget();
        installGestureGuard(t);
        for (const type of GESTURE_EVENTS) {
            const e = event(element(false));
            t.fire(type, e);
            expect(e.preventDefault).toHaveBeenCalledTimes(1);
        }
    });

    it('允許區域（圖表）：gesture 事件與雙指 touchmove 都不擋', () => {
        const t = fakeTarget();
        installGestureGuard(t);
        const g = event(element(true));
        t.fire('gesturestart', g);
        expect(g.preventDefault).not.toHaveBeenCalled();
        const pinch = event(element(true), { touches: [{}, {}] });
        t.fire('touchmove', pinch);
        expect(pinch.preventDefault).not.toHaveBeenCalled();
    });

    it('非允許區域：兩指以上 touchmove 被擋；單指不擋（捲動、輸入框不受影響）', () => {
        const t = fakeTarget();
        installGestureGuard(t);
        const two = event(element(false), { touches: [{}, {}] });
        t.fire('touchmove', two);
        expect(two.preventDefault).toHaveBeenCalledTimes(1);
        const three = event(element(false), { touches: [{}, {}, {}] });
        t.fire('touchmove', three);
        expect(three.preventDefault).toHaveBeenCalledTimes(1);
        const one = event(element(false), { touches: [{}] });
        t.fire('touchmove', one);
        expect(one.preventDefault).not.toHaveBeenCalled();
        const none = event(element(false));
        t.fire('touchmove', none);
        expect(none.preventDefault).not.toHaveBeenCalled();
    });

    it('不可取消的事件不呼叫 preventDefault', () => {
        const t = fakeTarget();
        installGestureGuard(t);
        const e = event(element(false), { touches: [{}, {}], cancelable: false });
        t.fire('touchmove', e);
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('重複安裝只有一組監聽器；解除後全部移除', () => {
        const t = fakeTarget();
        const off1 = installGestureGuard(t);
        const off2 = installGestureGuard(t);
        expect(off2).toBe(off1);
        expect(t.listeners.get('touchmove')).toHaveLength(1);
        off1();
        for (const type of [...GESTURE_EVENTS, 'touchmove']) expect(t.listeners.get(type)).toHaveLength(0);
        // 解除後可以再安裝
        installGestureGuard(t);
        expect(t.listeners.get('touchmove')).toHaveLength(1);
    });

    it('沒有 document（非瀏覽器）時不丟錯', () => {
        expect(() => installGestureGuard()()).not.toThrow();
    });
});
