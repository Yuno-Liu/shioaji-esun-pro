// src/mobile/motion/spring.ts — 解析解彈簧、淡入淡出與共用 rAF 迴圈（設計規格 §4.9、§5.1）
//
// - 彈簧以阻尼比 ζ 與反應時間 response 描述（m=1、ω0=2π/response）；位置與速度都用解析解，
//   任何時刻可取樣，retarget 以「當下的位置與速度」為新初值，速度連續。
// - 全部動畫共用一個 rAF 迴圈，沒有動畫時停止；onUpdate 由呼叫端直接寫 element.style（transform／opacity），
//   不觸發 React render。
// - 同步模式（立即 onUpdate(to, 0)＋onRest()），任一成立即同步：
//   沒有 window／document／requestAnimationFrame（注入測試時鐘時不看這三項）；有傳 el 但 canAnimate(el) 為假
//   （react-test-renderer 的 ref 為 null、node mock 沒有 style／isConnected）；document.visibilityState 為 hidden；
//   animateSpring 另外在減少動態時同步（呼叫端改用 animateTween 做 150ms 淡入淡出，它不看減少動態）。
//   注意 trade-chart.test.tsx 會 stub requestAnimationFrame，所以 rAF 存在不代表可以動畫，必須同時看目標節點。

import { SPRING } from '../styles/tokens';
import { prefersReducedMotion } from './prefs';

export interface SpringConfig {
    /** 阻尼比，0 < zeta ≤ 1（> 1 以 1 計） */
    zeta: number;
    /** 反應時間（秒） */
    response: number;
}

export type SpringName = 'default' | 'snappy' | 'sheet' | 'sheetFling' | 'toast' | 'bump';

/** §4.9 彈簧 token（唯一來源為 styles/tokens.ts 的 SPRING） */
export const SPRINGS: Readonly<Record<SpringName, SpringConfig>> = SPRING;

export interface SpringHandle {
    /** 停止並回傳畫面上的當下值（之後不再呼叫 onUpdate／onRest） */
    stop(): { value: number; velocity: number };
    /** 以當下值與速度（或指定速度）為新初值改往新目標；已停止或已靜止時重新開始 */
    retarget(to: number, velocity?: number): void;
    value(): number;
    velocity(): number;
    readonly done: boolean;
}

export interface MotionClock {
    now(): number;
    frame(cb: (t: number) => void): number;
    cancel(id: number): void;
}

/** 超過這個時間仍未靜止就直接到終點（防呆；正常彈簧 1 秒內靜止） */
const MAX_DURATION_MS = 10_000;

// ---- 純函式 ----

/** 以 ζ、response 換算 k、c（m=1）：ω0=2π/response、k=ω0²、c=2ζω0 */
export function springCoefficients(c: SpringConfig): { omega0: number; zeta: number; stiffness: number; damping: number } {
    const omega0 = (2 * Math.PI) / c.response;
    const zeta = Math.min(1, Math.max(0.01, c.zeta));
    return { omega0, zeta, stiffness: omega0 * omega0, damping: 2 * zeta * omega0 };
}

/** 相對目標的位移 x0、初速 v0，經過 t 秒後的位移與速度 */
export function springAt(c: SpringConfig, x0: number, v0: number, t: number): { x: number; v: number } {
    const { omega0: w0, zeta } = springCoefficients(c);
    if (zeta >= 1 - 1e-9) {
        const e = Math.exp(-w0 * t);
        const b = v0 + w0 * x0;
        return { x: e * (x0 + b * t), v: e * (v0 - w0 * b * t) };
    }
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * w0 * t);
    const cos = Math.cos(wd * t);
    const sin = Math.sin(wd * t);
    return {
        x: e * (x0 * cos + ((v0 + zeta * w0 * x0) / wd) * sin),
        v: e * (v0 * cos - ((zeta * w0 * v0 + w0 * w0 * x0) / wd) * sin),
    };
}

/** 依減速率投射放手後的滑行距離：(v/1000)·d/(1−d)；d 不在 (0,1) 時為 0 */
export function project(velocityPxPerS: number, decelerationRate: number): number {
    if (!(decelerationRate > 0 && decelerationRate < 1) || !Number.isFinite(velocityPxPerS)) return 0;
    return ((velocityPxPerS / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** 橡皮筋：sign·|o|·dim·c/(dim + c·|o|)；dimension 量不到時為 0 */
export function rubberband(offset: number, dimension: number, c = 0.55): number {
    if (!(dimension > 0) || !Number.isFinite(offset)) return 0;
    const a = Math.abs(offset);
    return (Math.sign(offset) * a * dimension * c) / (dimension + c * a);
}

// ---- 環境與時鐘 ----

/** 目標是否為已連到文件、有 style 的節點（node mock 需提供 { style:{}, isConnected:true }） */
export function canAnimate(el: unknown): el is HTMLElement {
    if (!el || typeof el !== 'object') return false;
    const n = el as { style?: unknown; isConnected?: unknown };
    return !!n.style && typeof n.style === 'object' && n.isConnected === true;
}

let testClock: MotionClock | null = null;

function realClock(): MotionClock | null {
    if (typeof window === 'undefined' || typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return null;
    return {
        now: motionNow,
        frame: cb => requestAnimationFrame(cb),
        cancel: id => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); },
    };
}

/** 動畫與手勢共用的現在時間（ms）；注入測試時鐘時用測試時鐘 */
export function motionNow(): number {
    if (testClock) return testClock.now();
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function pageHidden(): boolean {
    try {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    } catch {
        return false;
    }
}

/** 可動畫時回傳時鐘；應走同步模式時回傳 null */
function clockFor(el: unknown, respectReducedMotion: boolean): MotionClock | null {
    const clock = testClock ?? realClock();
    if (!clock) return null;
    if (el !== undefined && !canAnimate(el)) return null;
    if (pageHidden()) return null;
    if (respectReducedMotion && prefersReducedMotion()) return null;
    return clock;
}

// ---- 共用 rAF 迴圈 ----

interface Runner { step(now: number): void }

const running = new Set<Runner>();
let frameId: number | null = null;
let frameClock: MotionClock | null = null;

function tick(): void {
    frameId = null;
    const clock = frameClock;
    if (!clock) return;
    const now = clock.now();
    for (const r of Array.from(running)) {
        if (!running.has(r)) continue;
        try {
            r.step(now);
        } catch (err) {
            running.delete(r);
            if (typeof console !== 'undefined') console.error('[motion] onUpdate failed', err);
        }
    }
    schedule(clock);
}

function schedule(clock: MotionClock): void {
    if (frameId !== null || running.size === 0) return;
    frameClock = clock;
    frameId = clock.frame(tick);
}

/**
 * 測試用：注入假時鐘（null 還原）。切換時停止所有進行中的動畫（不呼叫 onRest），避免跨測試殘留。
 * 注入後不再看 window／document／requestAnimationFrame 是否存在，但仍看目標節點、可見度與減少動態。
 */
export function setMotionClockForTest(clock: MotionClock | null): void {
    if (frameId !== null && frameClock) frameClock.cancel(frameId);
    frameId = null;
    frameClock = null;
    running.clear();
    testClock = clock;
}

// ---- style helper ----

/** 寫入 element.style；節點沒有 style（node mock）時不寫、不丟錯。值為 null 時清除 */
export function writeStyle(el: unknown, patch: Record<string, string | null>): void {
    const style = el && typeof el === 'object' ? (el as { style?: unknown }).style : undefined;
    if (!style || typeof style !== 'object') return;
    for (const [k, v] of Object.entries(patch)) {
        try {
            (style as Record<string, string>)[k] = v ?? '';
        } catch {
            // 唯讀屬性等：忽略
        }
    }
}

// ---- 動畫 ----

interface DriveModel {
    /** 經過 elapsedMs 後的值與速度；atRest 表示可以結束 */
    sample(elapsedMs: number): { value: number; velocity: number; atRest: boolean };
    /** 以 value、velocity 為初值改往 to */
    reset(value: number, velocity: number, to: number): void;
    to(): number;
}

interface DriveOptions {
    el?: unknown;
    willChange?: string | false;
    onUpdate(value: number, velocity: number): void;
    onRest?(): void;
}

function drive(model: DriveModel, initial: { value: number; velocity: number }, o: DriveOptions, respectReducedMotion: boolean): SpringHandle {
    let value = initial.value;
    let velocity = initial.velocity;
    let done = false;
    let t0 = 0;
    let clock: MotionClock | null = null;
    const willChange = o.willChange === undefined ? 'transform' : o.willChange;

    const release = () => {
        running.delete(runner);
        if (willChange && clock && o.el !== undefined) writeStyle(o.el, { willChange: null });
        clock = null;
    };
    const finish = () => {
        release();
        value = model.to();
        velocity = 0;
        done = true;
        o.onUpdate(value, 0);
        o.onRest?.();
    };
    const runner: Runner = {
        step(now) {
            const elapsed = Math.max(0, now - t0);
            const s = model.sample(elapsed);
            if (s.atRest || elapsed > MAX_DURATION_MS) { finish(); return; }
            value = s.value;
            velocity = s.velocity;
            o.onUpdate(value, velocity);
        },
    };
    const start = () => {
        done = false;
        const c = clockFor(o.el, respectReducedMotion);
        if (!c) { finish(); return; }
        if (model.sample(0).atRest) { clock = c; finish(); return; }
        clock = c;
        t0 = c.now();
        if (willChange && o.el !== undefined) writeStyle(o.el, { willChange });
        running.add(runner);
        schedule(c);
    };

    start();

    return {
        stop() {
            if (!done) { release(); done = true; }
            return { value, velocity };
        },
        retarget(to, v) {
            if (!done && clock) {
                const s = model.sample(Math.max(0, clock.now() - t0));
                value = s.value;
                velocity = s.velocity;
            }
            release();
            if (v !== undefined && Number.isFinite(v)) velocity = v;
            model.reset(value, velocity, to);
            start();
        },
        value: () => value,
        velocity: () => velocity,
        get done() { return done; },
    };
}

export interface AnimateSpringOptions {
    from: number;
    to: number;
    /** 初速（單位／秒），例如放手速度 */
    velocity?: number;
    config: SpringConfig;
    /** 靜止位移門檻：0.5（px）；opacity／scale 用 0.001 */
    restDelta?: number;
    /** 靜止速度門檻：5（單位／秒） */
    restSpeed?: number;
    /**
     * 目標節點（選填）：有傳時必須 canAnimate(el) 才會動畫，否則同步完成；
     * 動畫期間寫 will-change（預設 'transform'，false 不寫），結束或 stop 時清除。
     */
    el?: unknown;
    willChange?: string | false;
    onUpdate(value: number, velocity: number): void;
    onRest?(): void;
}

export function animateSpring(o: AnimateSpringOptions): SpringHandle {
    const restDelta = o.restDelta ?? 0.5;
    const restSpeed = o.restSpeed ?? 5;
    let to = o.to;
    let x0 = o.from - o.to;
    let v0 = typeof o.velocity === 'number' && Number.isFinite(o.velocity) ? o.velocity : 0;
    const model: DriveModel = {
        sample(ms) {
            const s = springAt(o.config, x0, v0, ms / 1000);
            return { value: to + s.x, velocity: s.v, atRest: Math.abs(s.x) < restDelta && Math.abs(s.v) < restSpeed };
        },
        reset(value, velocity, next) { to = next; x0 = value - next; v0 = velocity; },
        to: () => to,
    };
    if (!(o.config.response > 0)) {
        // response 無效：直接到終點
        return drive({ ...model, sample: () => ({ value: to, velocity: 0, atRest: true }) }, { value: o.from, velocity: v0 }, o, true);
    }
    return drive(model, { value: o.from, velocity: v0 }, o, true);
}

export interface AnimateTweenOptions {
    from: number;
    to: number;
    durationMs: number;
    el?: unknown;
    willChange?: string | false;
    onUpdate(value: number): void;
    onRest?(): void;
}

/** 減少動態用的淡入淡出（ease-out cubic）；不看減少動態，但同樣受環境、節點、可見度的同步條件約束 */
export function animateTween(o: AnimateTweenOptions): SpringHandle {
    let from = o.from;
    let to = o.to;
    const duration = o.durationMs;
    const model: DriveModel = {
        sample(ms) {
            if (!(duration > 0) || from === to) return { value: to, velocity: 0, atRest: true };
            const p = Math.min(1, ms / duration);
            const inv = 1 - p;
            return {
                value: from + (to - from) * (1 - inv * inv * inv),
                velocity: ((to - from) * 3 * inv * inv * 1000) / duration,
                atRest: p >= 1,
            };
        },
        reset(value, _velocity, next) { from = value; to = next; },
        to: () => to,
    };
    return drive(model, { value: o.from, velocity: 0 }, {
        el: o.el,
        willChange: o.willChange === undefined ? 'opacity' : o.willChange,
        onUpdate: v => o.onUpdate(v),
        onRest: o.onRest,
    }, false);
}
