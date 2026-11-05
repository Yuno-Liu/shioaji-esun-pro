// Stepper：全形「－」「＋」、點擊一步、按住連續（400ms 後 8 步／秒，1.2 秒後 16 步／秒）與所有停止條件、
// 連續後吞 click、atMax／atMin 不呼叫 onStep 並顯示說明、flashKey 外框閃爍（減少動態改靜態）
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { springAt, SPRINGS } from '../motion/spring';
import { BUMP_VELOCITY, Stepper, STEPPER_TIMING, type StepperProps } from './stepper';

const h = vi.hoisted(() => ({ haptic: vi.fn(() => false) }));
vi.mock('../motion/haptics', () => ({ haptic: h.haptic }));

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const onStep = vi.fn();
const onChange = vi.fn();
const animate = vi.fn();
const base: StepperProps = {
    value: '100', onChange, onStep, inputMode: 'decimal', ariaLabel: '價格', decLabel: '價格減一檔', incLabel: '價格加一檔',
    testId: 'ticket-price', maxText: '已到漲停', minText: '已到跌停',
};
let props: StepperProps = base;

const key = (label: string) => view!.root.find(n => n.type === 'button' && n.props['aria-label'] === label);
const inc = () => key('價格加一檔');
const dec = () => key('價格減一檔');
const input = () => view!.root.find(n => n.type === 'input');
const note = () => view!.root.find(n => n.props['data-testid'] === 'ticket-price-bound');
const flashEl = () => view!.root.find(n => n.type === 'span' && n.props['aria-hidden'] === 'true' && 'data-static' in n.props);
const touch = { pointerId: 1, pointerType: 'touch', button: 0 };

async function render(patch: Partial<StepperProps> = {}) {
    props = { ...props, ...patch };
    const el = createElement(Stepper, props);
    await act(async () => {
        if (view) view.update(el);
        else {
            view = create(el, {
                createNodeMock: e => (e.type === 'span' ? { style: {}, animate } : { style: {} }),
            });
        }
    });
}
async function advance(ms: number) {
    await act(async () => { vi.advanceTimersByTime(ms); });
}
async function down(k: ReactTestInstance, e: Record<string, unknown> = touch) {
    await act(async () => { k.props.onPointerDown(e); });
}
async function fire(k: ReactTestInstance, handler: string) {
    await act(async () => { k.props[handler]({}); });
}
async function click(k: ReactTestInstance) {
    await act(async () => { k.props.onClick(); });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    props = base;
    onStep.mockReset();
    onChange.mockReset();
    animate.mockReset();
    h.haptic.mockClear();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('Stepper basics', () => {
    it('keeps full-width － ＋ as the only visible text and the existing aria-labels', async () => {
        await render();
        expect(text(dec())).toBe('－');
        expect(text(inc())).toBe('＋');
        expect(input().props['data-testid']).toBe('ticket-price');
        expect(input().props['aria-label']).toBe('價格');
        expect(input().props.inputMode).toBe('decimal');
        expect(input().props.value).toBe('100');
    });

    it('forwards typing and blur; aria-invalid only when invalid', async () => {
        const onBlur = vi.fn();
        await render({ onBlur });
        await act(async () => { input().props.onChange({ target: { value: '101.5' } }); });
        expect(onChange).toHaveBeenCalledWith('101.5');
        await act(async () => { input().props.onBlur(); });
        expect(onBlur).toHaveBeenCalledTimes(1);
        expect(input().props['aria-invalid']).toBeUndefined();
        await render({ invalid: true });
        expect(input().props['aria-invalid']).toBe(true);
    });

    it('a click is exactly one step in its direction', async () => {
        await render();
        await click(inc());
        await click(dec());
        expect(onStep.mock.calls).toEqual([[1], [-1]]);
    });

    it('disabled disables everything; stepDisabled only the keys', async () => {
        await render({ stepDisabled: true });
        expect(inc().props.disabled).toBe(true);
        expect(dec().props.disabled).toBe(true);
        expect(input().props.disabled).toBe(false);
        await render({ stepDisabled: false, disabled: true });
        expect(input().props.disabled).toBe(true);
        await click(inc());
        await down(inc());
        await advance(2000);
        expect(onStep).not.toHaveBeenCalled();
    });
});

describe('Stepper press-and-hold', () => {
    it('starts after 400ms at 8 steps/s and speeds up to 16 steps/s after 1.2s of repeating', async () => {
        await render();
        await down(inc());
        await advance(STEPPER_TIMING.holdDelay - 1);
        expect(onStep).not.toHaveBeenCalled();
        await advance(1); // t=400：第 1 步
        expect(onStep).toHaveBeenCalledTimes(1);
        await advance(125 * 9); // t=1525：每 125ms 一步（8 步／秒）
        expect(onStep).toHaveBeenCalledTimes(10);
        await advance(125); // t=1650：已連續 1.25s ≥ 1.2s
        expect(onStep).toHaveBeenCalledTimes(11);
        await advance(STEPPER_TIMING.fastInterval * 16); // 之後每 63ms 一步（約 16 步／秒）
        expect(onStep).toHaveBeenCalledTimes(27);
        expect(onStep.mock.calls.every(c => c[0] === 1)).toBe(true);
        await fire(inc(), 'onPointerUp');
    });

    it('swallows the click that ends a repeating press, but not the next real click', async () => {
        await render();
        await down(dec());
        await advance(400 + 125);
        expect(onStep).toHaveBeenCalledTimes(2);
        await fire(dec(), 'onPointerUp');
        await click(dec()); // 同一次按壓的收尾 click
        expect(onStep).toHaveBeenCalledTimes(2);
        await click(dec());
        expect(onStep).toHaveBeenCalledTimes(3);
    });

    it('the swallow window lasts 350ms after release (a later keyboard click still steps)', async () => {
        await render();
        await down(inc());
        await advance(400);
        await advance(1000); // 手指仍按著：旗標不會先過期
        await fire(inc(), 'onPointerUp');
        await advance(STEPPER_TIMING.clickSwallow);
        const n = onStep.mock.calls.length;
        await click(inc());
        expect(onStep).toHaveBeenCalledTimes(n + 1);
    });

    it('a short press (released before 400ms) steps once via click', async () => {
        await render();
        await down(inc());
        await advance(200);
        await fire(inc(), 'onPointerUp');
        await click(inc());
        await advance(2000);
        expect(onStep).toHaveBeenCalledTimes(1);
    });

    it.each(['onPointerUp', 'onPointerCancel', 'onPointerLeave', 'onLostPointerCapture'])('%s stops repeating', async handler => {
        await render();
        await down(inc());
        await advance(400);
        expect(onStep).toHaveBeenCalledTimes(1);
        await fire(inc(), handler);
        await advance(3000);
        expect(onStep).toHaveBeenCalledTimes(1);
    });

    it('window blur and visibilitychange stop repeating', async () => {
        const win = new EventTarget();
        const doc = new EventTarget();
        vi.stubGlobal('window', win);
        vi.stubGlobal('document', doc);
        await render();
        await down(inc());
        await advance(400);
        await act(async () => { win.dispatchEvent(new Event('blur')); });
        await advance(3000);
        expect(onStep).toHaveBeenCalledTimes(1);

        await down(inc());
        await advance(400);
        await act(async () => { doc.dispatchEvent(new Event('visibilitychange')); });
        await advance(3000);
        expect(onStep).toHaveBeenCalledTimes(2);
    });

    it('becoming disabled stops repeating', async () => {
        await render();
        await down(inc());
        await advance(525);
        expect(onStep).toHaveBeenCalledTimes(2);
        await render({ disabled: true });
        await advance(3000);
        expect(onStep).toHaveBeenCalledTimes(2);
    });

    it('ignores non-primary pointers and secondary mouse buttons', async () => {
        await render();
        await down(inc(), { ...touch, isPrimary: false });
        await down(inc(), { pointerId: 2, pointerType: 'mouse', button: 2 });
        await advance(2000);
        expect(onStep).not.toHaveBeenCalled();
    });
});

describe('Stepper bounds', () => {
    it('atMax: ＋ does not call onStep, shows maxText as status for 2s and fires the bound haptic; － still works', async () => {
        await render({ atMax: true });
        expect(text(note())).toBe('');
        expect(note().props.role).toBe('status');
        await click(inc());
        expect(onStep).not.toHaveBeenCalled();
        expect(text(note())).toBe('已到漲停');
        expect(input().props['aria-describedby']).toBe(note().props.id);
        expect(h.haptic).toHaveBeenCalledWith('bound');
        await advance(STEPPER_TIMING.boundNote);
        expect(text(note())).toBe('');
        await click(dec());
        expect(onStep).toHaveBeenCalledWith(-1);
    });

    it('atMin: － does not call onStep and shows minText', async () => {
        await render({ atMin: true });
        await click(dec());
        expect(onStep).not.toHaveBeenCalled();
        expect(text(note())).toBe('已到跌停');
    });

    it('holding at the bound never steps', async () => {
        await render({ atMax: true });
        await down(inc());
        await advance(1000); // t=400 撞界：停止並顯示說明（2 秒）
        expect(onStep).not.toHaveBeenCalled();
        expect(text(note())).toBe('已到漲停');
        await advance(2000);
        expect(onStep).not.toHaveBeenCalled();
        await fire(inc(), 'onPointerUp');
        await click(inc()); // 收尾 click 被吞，不再重複回饋
        expect(h.haptic).toHaveBeenCalledTimes(1);
    });

    it('reaching the bound while repeating stops immediately', async () => {
        await render();
        await down(inc());
        await advance(525);
        expect(onStep).toHaveBeenCalledTimes(2);
        await render({ atMax: true }); // 父層依新值算出已到上限
        expect(text(note())).toBe('已到漲停');
        await advance(3000);
        expect(onStep).toHaveBeenCalledTimes(2);
    });

    it('bump spring peaks at about 4px', () => {
        let peak = 0;
        for (let t = 0; t <= 0.4; t += 0.001) peak = Math.max(peak, Math.abs(springAt(SPRINGS.bump, 0, BUMP_VELOCITY, t).x));
        expect(peak).toBeGreaterThan(3.8);
        expect(peak).toBeLessThan(4.2);
    });
});

describe('Stepper flashKey', () => {
    it('does not flash on first render; flashes the outline with WAAPI opacity when the key changes', async () => {
        await render({ flashKey: 1 });
        expect(animate).not.toHaveBeenCalled();
        await render({ flashKey: 1 });
        expect(animate).not.toHaveBeenCalled();
        await render({ flashKey: 2 });
        expect(animate).toHaveBeenCalledTimes(1);
        expect(animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0 }], { duration: STEPPER_TIMING.flash, easing: 'ease-out' });
    });

    it('reduced motion: static outline for 600ms instead of animating', async () => {
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduced-motion'), addEventListener() {}, removeEventListener() {} }));
        await render({ flashKey: 'a' });
        await render({ flashKey: 'b' });
        expect(animate).not.toHaveBeenCalled();
        expect(flashEl().props['data-static']).toBe('true');
        await advance(STEPPER_TIMING.flashStatic);
        expect(flashEl().props['data-static']).toBeUndefined();
    });
});
