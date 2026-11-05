// 解析解彈簧：純函式誤差（對照 RK4 數值積分）、§4.9 係數、同步模式、共用 rAF、retarget 速度連續、淡入淡出
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    animateSpring,
    animateTween,
    canAnimate,
    motionNow,
    project,
    rubberband,
    setMotionClockForTest,
    springAt,
    springCoefficients,
    SPRINGS,
    writeStyle,
    type MotionClock,
    type SpringConfig,
} from './spring';

/** 假時鐘：frame 排入佇列，advance 推進時間並執行一幀 */
function fakeClock() {
    let t = 1000;
    let seq = 0;
    const queue = new Map<number, (t: number) => void>();
    const clock: MotionClock & { advance(ms: number): void; pending(): number } = {
        now: () => t,
        frame: vi.fn((cb: (t: number) => void) => { queue.set(++seq, cb); return seq; }),
        cancel: vi.fn((id: number) => { queue.delete(id); }),
        advance(ms: number) {
            t += ms;
            const cbs = Array.from(queue.values());
            queue.clear();
            cbs.forEach(cb => cb(t));
        },
        pending: () => queue.size,
    };
    return clock;
}

const node = () => ({ style: {} as Record<string, string>, isConnected: true });

/** x'' = −k x − c x' 的 RK4 數值解 */
function rk4(cfg: SpringConfig, x0: number, v0: number, t: number, steps = 20000) {
    const { stiffness: k, damping: c } = springCoefficients(cfg);
    const h = t / steps;
    let x = x0;
    let v = v0;
    const a = (xx: number, vv: number) => -k * xx - c * vv;
    for (let i = 0; i < steps; i++) {
        const k1x = v, k1v = a(x, v);
        const k2x = v + (h / 2) * k1v, k2v = a(x + (h / 2) * k1x, v + (h / 2) * k1v);
        const k3x = v + (h / 2) * k2v, k3v = a(x + (h / 2) * k2x, v + (h / 2) * k2v);
        const k4x = v + h * k3v, k4v = a(x + h * k3x, v + h * k3v);
        x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
        v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
    }
    return { x, v };
}

afterEach(() => {
    setMotionClockForTest(null);
    vi.unstubAllGlobals();
});

describe('§4.9 彈簧係數', () => {
    it('k＝ω0²、c＝2ζω0 與規格表一致', () => {
        const table: Record<keyof typeof SPRINGS, [number, number]> = {
            default: [322.3, 35.9], snappy: [815.7, 57.12], sheet: [385.5, 39.27],
            sheetFling: [438.6, 34.35], toast: [273.4, 29.76], bump: [631.7, 27.65],
        };
        for (const [name, [k, c]] of Object.entries(table)) {
            const co = springCoefficients(SPRINGS[name as keyof typeof SPRINGS]);
            expect(co.stiffness).toBeCloseTo(k, 0);
            expect(co.damping).toBeCloseTo(c, 1);
        }
    });

    it('zeta > 1 以 1 計（Math.min 防呆）', () => {
        const over = springAt({ zeta: 3, response: 0.3 }, 100, 0, 0.1);
        const crit = springAt({ zeta: 1, response: 0.3 }, 100, 0, 0.1);
        expect(over).toEqual(crit);
    });
});

describe('springAt 解析解', () => {
    const cases: [string, SpringConfig, number, number][] = [
        ['ζ=1 回彈', SPRINGS.sheet, 400, 0],
        ['ζ=1 帶反向初速', SPRINGS.default, -120, 2500],
        ['ζ<1 sheetFling', SPRINGS.sheetFling, 300, -1800],
        ['ζ<1 bump', SPRINGS.bump, 6, 0],
        ['ζ<1 toast', SPRINGS.toast, -80, 600],
    ];
    it.each(cases)('%s：對照 RK4 誤差 < 1e-4（相對初值尺度）', (_n, cfg, x0, v0) => {
        const scale = Math.abs(x0) + Math.abs(v0) * cfg.response;
        for (const t of [0.016, 0.05, 0.12, 0.3, 0.6]) {
            const a = springAt(cfg, x0, v0, t);
            const n = rk4(cfg, x0, v0, t);
            expect(Math.abs(a.x - n.x) / scale).toBeLessThan(1e-4);
            expect(Math.abs(a.v - n.v) / (scale / cfg.response)).toBeLessThan(1e-4);
        }
    });

    it('t=0 回到初值；v 是 x 的導數', () => {
        for (const cfg of [SPRINGS.sheet, SPRINGS.bump]) {
            const s0 = springAt(cfg, 50, -300, 0);
            expect(s0.x).toBeCloseTo(50, 10);
            expect(s0.v).toBeCloseTo(-300, 10);
            const t = 0.07;
            const h = 1e-6;
            const fd = (springAt(cfg, 50, -300, t + h).x - springAt(cfg, 50, -300, t - h).x) / (2 * h);
            expect(springAt(cfg, 50, -300, t).v).toBeCloseTo(fd, 3);
        }
    });
});

describe('project／rubberband', () => {
    it('project：面板 .99 → v×0.099、通知 .998 → v×0.499；無效減速率為 0', () => {
        expect(project(1000, 0.99)).toBeCloseTo(99, 6);
        expect(project(-500, 0.99)).toBeCloseTo(-49.5, 6);
        expect(project(1000, 0.998)).toBeCloseTo(499, 6);
        expect(project(1000, 1)).toBe(0);
        expect(project(1000, 0)).toBe(0);
        expect(project(Number.NaN, 0.99)).toBe(0);
    });

    it('rubberband：小位移約 c 倍、單調、不超過 dimension、保留正負號', () => {
        expect(rubberband(1, 800)).toBeCloseTo(0.55, 2);
        expect(rubberband(-100, 800)).toBeCloseTo(-(100 * 800 * 0.55) / (800 + 55), 6);
        let prev = 0;
        for (const o of [10, 100, 1000, 10000]) {
            const r = rubberband(o, 800);
            expect(r).toBeGreaterThan(prev);
            expect(r).toBeLessThan(800);
            prev = r;
        }
        expect(rubberband(50, 0)).toBe(0);
        expect(rubberband(0, 800)).toBe(0);
    });
});

describe('同步模式', () => {
    it('沒有 window／document／rAF（node）→ 立即 onUpdate(to,0)＋onRest，done', () => {
        const onUpdate = vi.fn();
        const onRest = vi.fn();
        const h = animateSpring({ from: 0, to: 300, velocity: 900, config: SPRINGS.sheet, onUpdate, onRest });
        expect(onUpdate).toHaveBeenCalledExactlyOnceWith(300, 0);
        expect(onRest).toHaveBeenCalledOnce();
        expect(h.done).toBe(true);
        expect(h.value()).toBe(300);
        expect(h.stop()).toEqual({ value: 300, velocity: 0 });
    });

    it('trade-chart.test 式 stub rAF＋window／document，但目標節點為 null 或 node mock 未連線 → 仍同步、不排 rAF', () => {
        const raf = vi.fn((cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number);
        vi.stubGlobal('requestAnimationFrame', raf);
        vi.stubGlobal('window', {});
        vi.stubGlobal('document', { visibilityState: 'visible' });
        for (const el of [null, {}, { style: {} }, { style: {}, isConnected: false }, { isConnected: true }]) {
            const onRest = vi.fn();
            animateSpring({ from: 0, to: 1, config: SPRINGS.default, el, onUpdate: () => undefined, onRest });
            expect(onRest).toHaveBeenCalledOnce();
        }
        expect(raf).not.toHaveBeenCalled();
    });

    it('有 rAF 環境且節點已連線 → 以 rAF 動畫', () => {
        const raf = vi.fn(() => 1);
        vi.stubGlobal('requestAnimationFrame', raf);
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.stubGlobal('window', {});
        vi.stubGlobal('document', { visibilityState: 'visible' });
        const onRest = vi.fn();
        const h = animateSpring({ from: 0, to: 100, config: SPRINGS.default, el: node(), onUpdate: () => undefined, onRest });
        expect(raf).toHaveBeenCalledOnce();
        expect(onRest).not.toHaveBeenCalled();
        expect(h.done).toBe(false);
        h.stop();
    });

    it('頁面隱藏 → 同步', () => {
        setMotionClockForTest(fakeClock());
        vi.stubGlobal('document', { visibilityState: 'hidden' });
        const onRest = vi.fn();
        animateSpring({ from: 0, to: 100, config: SPRINGS.default, el: node(), onUpdate: () => undefined, onRest });
        animateTween({ from: 0, to: 1, durationMs: 150, el: node(), onUpdate: () => undefined, onRest });
        expect(onRest).toHaveBeenCalledTimes(2);
    });

    it('減少動態：animateSpring 同步；animateTween 照常淡入淡出', () => {
        const clock = fakeClock();
        setMotionClockForTest(clock);
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' }));
        const springRest = vi.fn();
        animateSpring({ from: 0, to: 100, config: SPRINGS.default, el: node(), onUpdate: () => undefined, onRest: springRest });
        expect(springRest).toHaveBeenCalledOnce();
        const tweenRest = vi.fn();
        const t = animateTween({ from: 0, to: 1, durationMs: 150, el: node(), onUpdate: () => undefined, onRest: tweenRest });
        expect(tweenRest).not.toHaveBeenCalled();
        expect(t.done).toBe(false);
        for (let i = 0; i < 10; i++) clock.advance(16);
        expect(tweenRest).toHaveBeenCalledOnce();
    });

    it('canAnimate：只接受有 style 且 isConnected 的節點', () => {
        expect(canAnimate(node())).toBe(true);
        expect(canAnimate(null)).toBe(false);
        expect(canAnimate(undefined)).toBe(false);
        expect(canAnimate({ style: {} })).toBe(false);
        expect(canAnimate({ isConnected: true })).toBe(false);
        expect(canAnimate({ style: null, isConnected: true })).toBe(false);
    });

    it('writeStyle 容忍沒有 style 的 node mock', () => {
        expect(() => writeStyle(null, { transform: 'none' })).not.toThrow();
        expect(() => writeStyle({}, { transform: 'none' })).not.toThrow();
        const n = node();
        writeStyle(n, { transform: 'translateY(4px)', willChange: 'transform' });
        expect(n.style).toEqual({ transform: 'translateY(4px)', willChange: 'transform' });
        writeStyle(n, { willChange: null });
        expect(n.style.willChange).toBe('');
    });
});

describe('假時鐘動畫', () => {
    let clock: ReturnType<typeof fakeClock>;
    beforeEach(() => {
        clock = fakeClock();
        setMotionClockForTest(clock);
    });

    it('逐幀依解析解更新、靜止時最後 onUpdate(to,0)＋onRest 一次、will-change 期間存在', () => {
        const el = node();
        const seen: [number, number][] = [];
        const onRest = vi.fn();
        const h = animateSpring({ from: 0, to: 300, config: SPRINGS.sheet, el, onUpdate: (v, vel) => seen.push([v, vel]), onRest });
        expect(el.style.willChange).toBe('transform');
        expect(seen).toHaveLength(0);
        clock.advance(16);
        const exp = springAt(SPRINGS.sheet, -300, 0, 0.016);
        expect(seen[0]![0]).toBeCloseTo(300 + exp.x, 9);
        expect(seen[0]![1]).toBeCloseTo(exp.v, 9);
        for (let i = 0; i < 200 && !h.done; i++) clock.advance(16);
        expect(h.done).toBe(true);
        expect(seen[seen.length - 1]).toEqual([300, 0]);
        expect(onRest).toHaveBeenCalledOnce();
        expect(el.style.willChange).toBe('');
        expect(clock.pending()).toBe(0); // 沒有動畫時停止迴圈
        clock.advance(16);
        expect(onRest).toHaveBeenCalledOnce();
    });

    it('多個動畫共用同一個 rAF', () => {
        animateSpring({ from: 0, to: 100, config: SPRINGS.default, el: node(), onUpdate: () => undefined });
        animateSpring({ from: 0, to: 1, config: SPRINGS.snappy, restDelta: 0.001, el: node(), onUpdate: () => undefined });
        animateTween({ from: 0, to: 1, durationMs: 150, el: node(), onUpdate: () => undefined });
        expect(clock.frame).toHaveBeenCalledTimes(1);
        clock.advance(16);
        expect(clock.frame).toHaveBeenCalledTimes(2);
    });

    it('起點已在終點且無速度 → 立即靜止', () => {
        const onRest = vi.fn();
        animateSpring({ from: 5, to: 5, config: SPRINGS.default, el: node(), onUpdate: () => undefined, onRest });
        expect(onRest).toHaveBeenCalledOnce();
        expect(clock.pending()).toBe(0);
    });

    it('retarget：位置與速度連續（以當下解析狀態為新初值）', () => {
        let last = { v: 0, vel: 0 };
        const h = animateSpring({ from: 0, to: 400, velocity: 0, config: SPRINGS.sheetFling, el: node(), onUpdate: (v, vel) => { last = { v, vel }; } });
        for (let i = 0; i < 6; i++) clock.advance(16);
        const before = { value: h.value(), velocity: h.velocity() };
        expect(before.velocity).not.toBe(0);
        h.retarget(-50);
        // retarget 當下的值與速度不跳
        expect(h.value()).toBeCloseTo(before.value, 9);
        expect(h.velocity()).toBeCloseTo(before.velocity, 9);
        clock.advance(1);
        // 1ms 後位置變化量 ≈ 速度×1ms、速度變化有限（加速度 × 1ms）
        expect(last.v - before.value).toBeCloseTo(before.velocity / 1000, 0);
        const accel = springCoefficients(SPRINGS.sheetFling).stiffness * Math.abs(before.value + 50) + springCoefficients(SPRINGS.sheetFling).damping * Math.abs(before.velocity);
        expect(Math.abs(last.vel - before.velocity)).toBeLessThanOrEqual(accel / 1000 + 1e-6);
        for (let i = 0; i < 200 && !h.done; i++) clock.advance(16);
        expect(h.value()).toBe(-50);
    });

    it('retarget 指定速度（例如放手速度）', () => {
        const h = animateSpring({ from: 0, to: 0, config: SPRINGS.sheet, el: node(), onUpdate: () => undefined });
        expect(h.done).toBe(true);
        h.retarget(200, 1500);
        expect(h.done).toBe(false);
        expect(h.velocity()).toBe(1500);
        clock.advance(16);
        expect(h.value()).toBeCloseTo(200 + springAt(SPRINGS.sheet, -200, 1500, 0.016).x, 6);
    });

    it('stop：回傳畫面上的當下值，之後不再回呼', () => {
        const onUpdate = vi.fn();
        const onRest = vi.fn();
        const el = node();
        const h = animateSpring({ from: 0, to: 100, config: SPRINGS.default, el, onUpdate, onRest });
        clock.advance(16);
        clock.advance(16);
        const [v, vel] = onUpdate.mock.calls[1]!;
        expect(h.stop()).toEqual({ value: v, velocity: vel });
        expect(el.style.willChange).toBe('');
        onUpdate.mockClear();
        clock.advance(16);
        expect(onUpdate).not.toHaveBeenCalled();
        expect(onRest).not.toHaveBeenCalled();
    });

    it('ζ<1 會越過目標再回來，最終靜止', () => {
        const values: number[] = [];
        const h = animateSpring({ from: 0, to: 6, config: SPRINGS.bump, restDelta: 0.01, el: node(), onUpdate: v => values.push(v) });
        for (let i = 0; i < 200 && !h.done; i++) clock.advance(8);
        expect(Math.max(...values)).toBeGreaterThan(6);
        expect(values[values.length - 1]).toBe(6);
    });

    it('onUpdate 丟例外只停掉該動畫，其他動畫照跑', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        animateSpring({ from: 0, to: 100, config: SPRINGS.default, el: node(), onUpdate: () => { throw new Error('boom'); } });
        const ok = vi.fn();
        animateSpring({ from: 0, to: 100, config: SPRINGS.default, el: node(), onUpdate: ok });
        clock.advance(16);
        clock.advance(16);
        expect(ok).toHaveBeenCalledTimes(2);
        expect(err).toHaveBeenCalledOnce();
        err.mockRestore();
    });

    it('animateTween：150ms、端點正確、單調、retarget 從當下值出發', () => {
        const values: number[] = [];
        const onRest = vi.fn();
        const el = node();
        const h = animateTween({ from: 0, to: 1, durationMs: 150, el, onUpdate: v => values.push(v), onRest });
        expect(el.style.willChange).toBe('opacity');
        for (let i = 0; i < 5; i++) clock.advance(16);
        for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
        const mid = h.value();
        h.retarget(0);
        clock.advance(75);
        expect(h.value()).toBeLessThan(mid);
        expect(h.value()).toBeGreaterThan(0);
        clock.advance(80);
        expect(h.value()).toBe(0);
        expect(onRest).toHaveBeenCalledOnce();
    });

    it('setMotionClockForTest(null) 取消進行中的動畫；motionNow 取測試時鐘', () => {
        expect(motionNow()).toBe(1000);
        const onRest = vi.fn();
        animateSpring({ from: 0, to: 100, config: SPRINGS.default, el: node(), onUpdate: () => undefined, onRest });
        setMotionClockForTest(null);
        expect(clock.cancel).toHaveBeenCalled();
        expect(onRest).not.toHaveBeenCalled();
    });
});
