// 手勢核心：VelocityTracker 100ms／50ms 規則、拖曳狀態機（方向鎖定、capture 時機、事件欄位容錯、取消路徑）、
// usePointerDrag 回傳 React props、拖曳後 click 攔截 350ms
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createPointerDrag,
    DRAG_EXCLUDE_SELECTOR,
    suppressClicksAfterDrag,
    usePointerDrag,
    VelocityTracker,
    type DragEndInfo,
    type DragInfo,
    type PointerDragOptions,
    type PointerDragProps,
} from './gesture';
import { setMotionClockForTest } from './spring';

describe('VelocityTracker', () => {
    it('等速樣本 → 斜率（px/s）', () => {
        const v = new VelocityTracker();
        for (let t = 0; t <= 80; t += 8) v.add(t, t * 2); // 2px/ms
        expect(v.velocity(80)).toBeCloseTo(2000, 6);
    });

    it('只取最近 100ms：先慢後快以快為準', () => {
        const v = new VelocityTracker();
        for (let t = 0; t <= 200; t += 10) v.add(t, t * 0.1);
        for (let t = 210; t <= 400; t += 10) v.add(t, 20 + (t - 200) * 3);
        expect(v.velocity(400)).toBeCloseTo(3000, 6);
    });

    it('最後樣本早於 now 超過 50ms → 0；剛好 50ms 仍計算', () => {
        const v = new VelocityTracker();
        v.add(0, 0);
        v.add(16, 32);
        expect(v.velocity(66)).not.toBe(0);
        expect(v.velocity(67)).toBe(0);
    });

    it('樣本不足、reset、時間倒退', () => {
        const v = new VelocityTracker();
        expect(v.velocity(0)).toBe(0);
        v.add(10, 5);
        expect(v.velocity(10)).toBe(0);
        v.add(20, 15);
        v.reset();
        expect(v.velocity(20)).toBe(0);
        v.add(100, 0);
        v.add(50, 100); // 倒退：重新開始
        expect(v.velocity(50)).toBe(0);
    });
});

function setup(o: Partial<PointerDragOptions> = {}) {
    const calls = { start: [] as DragInfo[], move: [] as DragInfo[], end: [] as DragEndInfo[] };
    let opts: PointerDragOptions = {
        axis: 'y',
        onStart: i => calls.start.push(i),
        onMove: i => calls.move.push(i),
        onEnd: i => calls.end.push(i),
        ...o,
    };
    const props = createPointerDrag(() => opts);
    return { props, calls, set: (p: Partial<PointerDragOptions>) => { opts = { ...opts, ...p }; } };
}
const el = () => ({ setPointerCapture: vi.fn() });

describe('createPointerDrag', () => {
    let now = 0;
    beforeEach(() => {
        now = 0;
        setMotionClockForTest({ now: () => now, frame: () => 0, cancel: () => undefined });
    });
    afterEach(() => setMotionClockForTest(null));

    it('測試式假事件（只有 pointerId、單軸座標、currentTarget）：超過 slop 後 onStart＋onMove，位移從按下點起算（1:1）', () => {
        const { props, calls } = setup();
        const ct = el();
        props.onPointerDown({ pointerId: 1, clientY: 100, currentTarget: ct });
        props.onPointerMove({ pointerId: 1, clientY: 105, currentTarget: ct });
        expect(calls.start).toHaveLength(0);
        expect(ct.setPointerCapture).not.toHaveBeenCalled(); // 鎖定方向前不 capture
        props.onPointerMove({ pointerId: 1, clientY: 190, currentTarget: ct });
        expect(calls.start).toHaveLength(1);
        expect(calls.move.map(i => i.delta)).toEqual([90]);
        expect(ct.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
        props.onPointerUp({ pointerId: 1, clientY: 220, currentTarget: ct });
        expect(calls.end).toHaveLength(1);
        expect(calls.end[0]).toMatchObject({ delta: 120, start: 100, position: 220, cancelled: false, element: ct });
    });

    it('滑塊式（axis x、slop 0）：按下即 onStart 並 capture；沒有 target／isPrimary／timeStamp 也可', () => {
        const { props, calls } = setup({ axis: 'x', slop: 0 });
        const ct = el();
        props.onPointerDown({ pointerId: 1, clientX: 0, currentTarget: ct });
        expect(calls.start).toHaveLength(1);
        expect(ct.setPointerCapture).toHaveBeenCalledWith(1);
        props.onPointerMove({ pointerId: 1, clientX: 3, currentTarget: ct });
        expect(calls.move.map(i => i.delta)).toEqual([3]);
        props.onPointerUp({ pointerId: 1, clientX: 250, currentTarget: ct });
        expect(calls.end[0]!.delta).toBe(250);
    });

    it('只在 isPrimary === false 時拒絕；滑鼠非左鍵拒絕', () => {
        const a = setup({ slop: 0 });
        a.props.onPointerDown({ pointerId: 2, isPrimary: false, clientY: 0 });
        expect(a.calls.start).toHaveLength(0);
        a.props.onPointerDown({ pointerId: 3, pointerType: 'mouse', button: 2, clientY: 0 });
        expect(a.calls.start).toHaveLength(0);
        a.props.onPointerDown({ pointerId: 4, pointerType: 'mouse', button: 0, isPrimary: true, clientY: 0 });
        expect(a.calls.start).toHaveLength(1);
    });

    it('不屬本軸（橫向為主）→ 放棄、不 capture、不 onEnd，之後的 move 也不理', () => {
        const { props, calls } = setup();
        const ct = el();
        props.onPointerDown({ pointerId: 1, clientX: 0, clientY: 0, currentTarget: ct });
        props.onPointerMove({ pointerId: 1, clientX: 30, clientY: 12, currentTarget: ct });
        props.onPointerMove({ pointerId: 1, clientX: 30, clientY: 200, currentTarget: ct });
        props.onPointerUp({ pointerId: 1, clientX: 30, clientY: 200, currentTarget: ct });
        expect(calls.start).toHaveLength(0);
        expect(calls.move).toHaveLength(0);
        expect(calls.end).toHaveLength(0);
        expect(ct.setPointerCapture).not.toHaveBeenCalled();
    });

    it('只追蹤第一個指標；其他 pointerId 的事件忽略', () => {
        const { props, calls } = setup({ slop: 0 });
        props.onPointerDown({ pointerId: 1, clientY: 0 });
        props.onPointerDown({ pointerId: 2, clientY: 50 });
        props.onPointerMove({ pointerId: 2, clientY: 300 });
        props.onPointerUp({ pointerId: 2, clientY: 300 });
        expect(calls.start).toHaveLength(1);
        expect(calls.move).toHaveLength(0);
        expect(calls.end).toHaveLength(0);
        props.onPointerUp({ pointerId: 1, clientY: 40 });
        expect(calls.end[0]!.delta).toBe(40);
    });

    it('放手速度：依事件 timeStamp 計算；停住超過 50ms 才放手 → 0', () => {
        const a = setup({ slop: 0 });
        a.props.onPointerDown({ pointerId: 1, clientY: 0, timeStamp: 1000 });
        for (let i = 1; i <= 5; i++) a.props.onPointerMove({ pointerId: 1, clientY: i * 16, timeStamp: 1000 + i * 8 });
        a.props.onPointerUp({ pointerId: 1, clientY: 96, timeStamp: 1048 });
        expect(a.calls.end[0]!.velocity).toBeCloseTo(2000, 0);

        const b = setup({ slop: 0 });
        b.props.onPointerDown({ pointerId: 1, clientY: 0, timeStamp: 1000 });
        b.props.onPointerMove({ pointerId: 1, clientY: 80, timeStamp: 1016 });
        b.props.onPointerUp({ pointerId: 1, clientY: 80, timeStamp: 1200 });
        expect(b.calls.end[0]!.velocity).toBe(0);
    });

    it('放手前最後一個移動樣本早於放手 50ms 以上 → 0（放手樣本不算「最新樣本」）；剛好 50ms 仍計算', () => {
        // 停頓 60ms（> 50ms、< 100ms 視窗）：修正前放手樣本先加入，停頓規則不觸發、會算出非 0 速度
        const a = setup({ slop: 0 });
        a.props.onPointerDown({ pointerId: 1, clientY: 0, timeStamp: 1000 });
        for (let i = 1; i <= 5; i++) a.props.onPointerMove({ pointerId: 1, clientY: i * 16, timeStamp: 1000 + i * 8 });
        a.props.onPointerUp({ pointerId: 1, clientY: 80, timeStamp: 1100 });
        expect(a.calls.end[0]!.velocity).toBe(0);
        expect(a.calls.end[0]!.delta).toBe(80);

        // 停頓剛好 50ms：仍計算（100ms 視窗內含放手樣本）
        const b = setup({ slop: 0 });
        b.props.onPointerDown({ pointerId: 1, clientY: 0, timeStamp: 1000 });
        for (let i = 1; i <= 5; i++) b.props.onPointerMove({ pointerId: 1, clientY: i * 16, timeStamp: 1000 + i * 8 });
        b.props.onPointerUp({ pointerId: 1, clientY: 80, timeStamp: 1090 });
        expect(b.calls.end[0]!.velocity).toBeGreaterThan(0);

        // 沒有任何移動、按下後停超過 50ms 才放手（放手位置不同）→ 0；位置照常回報
        const c = setup({ slop: 0 });
        c.props.onPointerDown({ pointerId: 1, clientY: 0, timeStamp: 1000 });
        c.props.onPointerUp({ pointerId: 1, clientY: 30, timeStamp: 1080 });
        expect(c.calls.end[0]).toMatchObject({ velocity: 0, delta: 30 });
    });

    it('沒有 timeStamp 時用動畫時鐘', () => {
        const { props, calls } = setup({ slop: 0 });
        now = 500;
        props.onPointerDown({ pointerId: 1, clientY: 0 });
        now = 510;
        props.onPointerMove({ pointerId: 1, clientY: -10 });
        now = 520;
        props.onPointerUp({ pointerId: 1, clientY: -20 });
        expect(calls.end[0]!.velocity).toBeCloseTo(-1000, 6);
    });

    it('pointercancel、lostpointercapture → cancelled true、velocity 0、位置維持最後一次 move', () => {
        for (const kind of ['onPointerCancel', 'onLostPointerCapture'] as const) {
            const { props, calls } = setup({ slop: 0 });
            props.onPointerDown({ pointerId: 1, clientY: 0, timeStamp: 1 });
            props.onPointerMove({ pointerId: 1, clientY: 60, timeStamp: 9 });
            props[kind]({ pointerId: 1, clientY: 999, timeStamp: 10 });
            expect(calls.end).toHaveLength(1);
            expect(calls.end[0]).toMatchObject({ cancelled: true, velocity: 0, delta: 60 });
            // 結束後的 lostpointercapture（瀏覽器在 pointerup 後也會送）不再回呼
            props.onLostPointerCapture({ pointerId: 1 });
            expect(calls.end).toHaveLength(1);
        }
    });

    it('slop 內放手（點按）不呼叫 onEnd', () => {
        const { props, calls } = setup();
        props.onPointerDown({ pointerId: 1, clientY: 0 });
        props.onPointerUp({ pointerId: 1, clientY: 4 });
        expect(calls.end).toHaveLength(0);
    });

    it('canStart 為假不開始；可依當下選項改變', () => {
        const s = setup({ slop: 0, canStart: () => false });
        s.props.onPointerDown({ pointerId: 1, clientY: 0 });
        expect(s.calls.start).toHaveLength(0);
        s.set({ canStart: () => true });
        s.props.onPointerDown({ pointerId: 1, clientY: 0 });
        expect(s.calls.start).toHaveLength(1);
    });

    it('info.cancel()：呼叫端中途放棄，之後不再回呼也不 onEnd', () => {
        const { props, calls, set } = setup({ slop: 0 });
        set({ onMove: i => { calls.move.push(i); if (i.delta > 50) i.cancel(); } });
        props.onPointerDown({ pointerId: 1, clientY: 0 });
        props.onPointerMove({ pointerId: 1, clientY: 30 });
        props.onPointerMove({ pointerId: 1, clientY: 60 });
        props.onPointerMove({ pointerId: 1, clientY: 90 });
        props.onPointerUp({ pointerId: 1, clientY: 90 });
        expect(calls.move.map(i => i.delta)).toEqual([30, 60]);
        expect(calls.end).toHaveLength(0);
        // 可以重新開始
        props.onPointerDown({ pointerId: 1, clientY: 0 });
        expect(calls.start).toHaveLength(2);
    });

    it('setPointerCapture 丟例外或沒有 currentTarget 都不影響拖曳', () => {
        const { props, calls } = setup({ slop: 0 });
        props.onPointerDown({ pointerId: 1, clientY: 0, currentTarget: { setPointerCapture: () => { throw new Error('InvalidStateError'); } } });
        props.onPointerUp({ pointerId: 1, clientY: 10 });
        expect(calls.end[0]!.delta).toBe(10);
        const b = setup({ slop: 0 });
        b.props.onPointerDown({ pointerId: 1, clientY: 0 });
        b.props.onPointerUp({ pointerId: 1 });
        expect(b.calls.end[0]!.delta).toBe(0);
    });
});

describe('usePointerDrag（React props）', () => {
    let view: ReactTestRenderer | undefined;
    beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
    afterEach(async () => {
        await act(async () => view?.unmount());
        view = undefined;
        vi.unstubAllGlobals();
    });

    it('回傳可展開的 handler；跨 render 參照穩定且讀到最新選項', async () => {
        const seen: PointerDragProps[] = [];
        const ends: number[] = [];
        function Probe({ factor }: { factor: number }) {
            const props = usePointerDrag({ axis: 'y', slop: 0, onEnd: i => ends.push(i.delta * factor) });
            seen.push(props);
            return createElement('div', { 'data-testid': 'probe', ...props });
        }
        await act(async () => { view = create(createElement(Probe, { factor: 1 })); });
        await act(async () => { view!.update(createElement(Probe, { factor: 2 })); });
        expect(seen[0]).toBe(seen[seen.length - 1]);
        const div = view!.root.find(n => n.props['data-testid'] === 'probe');
        expect(Object.keys(div.props).filter(k => k.startsWith('onPointer') || k === 'onLostPointerCapture').sort())
            .toEqual(['onLostPointerCapture', 'onPointerCancel', 'onPointerDown', 'onPointerMove', 'onPointerUp']);
        div.props.onPointerDown({ pointerId: 1, clientY: 10 });
        div.props.onPointerUp({ pointerId: 1, clientY: 30 });
        expect(ends).toEqual([40]);
    });
});

describe('suppressClicksAfterDrag', () => {
    afterEach(() => vi.useRealTimers());

    it('350ms 內在 capture 階段攔下 click，之後移除監聽', () => {
        vi.useFakeTimers();
        const handlers: ((e: Event) => void)[] = [];
        const target = {
            addEventListener: vi.fn((_t: string, h: (e: Event) => void, cap: boolean) => { expect(cap).toBe(true); handlers.push(h); }),
            removeEventListener: vi.fn(),
        };
        suppressClicksAfterDrag(target as unknown as Element);
        expect(target.addEventListener).toHaveBeenCalledWith('click', expect.any(Function), true);
        const ev = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
        vi.advanceTimersByTime(349);
        handlers[0]!(ev as unknown as Event);
        expect(ev.stopPropagation).toHaveBeenCalledOnce();
        expect(ev.preventDefault).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(1);
        expect(target.removeEventListener).toHaveBeenCalledWith('click', handlers[0], true);
    });

    it('節點不支援監聽（node mock）時不丟錯', () => {
        expect(() => suppressClicksAfterDrag({} as Element)).not.toThrow();
    });

    it('DRAG_EXCLUDE_SELECTOR 排除按鈕、輸入、滑塊與 data-sheet-nodrag', () => {
        for (const s of ['button', 'a', 'input', 'select', 'textarea', '[role="slider"]', '[data-sheet-nodrag]']) {
            expect(DRAG_EXCLUDE_SELECTOR.split(', ')).toContain(s);
        }
    });
});
