// 滑動確認：滑過 80% 行程放開才觸發一次；停用、行程未知、拖曳中被停用都不觸發；鍵盤可操作
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLIDE_HANDLE_SPAN_PX, SlideToConfirm, slideProgress, slideReached, type SlideToConfirmProps } from './slide-to-confirm';
import { haptic } from '../motion/haptics';
import { setMotionClockForTest } from '../motion/spring';
import { SheetPresenceContext, type SheetPresence } from '../ui/sheet-context';
import { SLIDE_AT_FALLBACK } from './slide-to-confirm';

const TRAVEL = 300;
const nodeMock = () => ({ getBoundingClientRect: () => ({ width: TRAVEL + SLIDE_HANDLE_SPAN_PX }) });

let view: ReactTestRenderer | undefined;
const onConfirm = vi.fn();

async function render(props: Partial<SlideToConfirmProps> = {}, opts: { measured?: boolean } = { measured: true }) {
    const el = createElement(SlideToConfirm, { label: '滑動確認 買進 2330', onConfirm, ...props });
    await act(async () => {
        view = create(el, opts.measured ? { createNodeMock: nodeMock } : undefined);
    });
}
async function rerender(props: Partial<SlideToConfirmProps>) {
    await act(async () => { view!.update(createElement(SlideToConfirm, { label: '滑動確認 買進 2330', onConfirm, ...props })); });
}
const handle = (): ReactTestInstance => view!.root.find(n => n.type === 'div' && n.props.role === 'slider');
const ptr = (clientX: number) => ({ pointerId: 1, clientX, currentTarget: { setPointerCapture: vi.fn() } });

async function swipe(toX: number) {
    await act(async () => { handle().props.onPointerDown(ptr(0)); });
    await act(async () => { handle().props.onPointerMove(ptr(toX)); });
    await act(async () => { handle().props.onPointerUp(ptr(toX)); });
}
async function key(k: string) {
    await act(async () => { handle().props.onKeyDown({ key: k, preventDefault: vi.fn() }); });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    onConfirm.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('slideProgress', () => {
    it('clamps to 0–1 and is 0 when the travel is unknown', () => {
        expect(slideProgress(0, 150, 300)).toBe(0.5);
        expect(slideProgress(0, 900, 300)).toBe(1);
        expect(slideProgress(0, -50, 300)).toBe(0);
        expect(slideProgress(0, 900, 0)).toBe(0);
        expect(slideReached(0.79)).toBe(false);
        expect(slideReached(0.8)).toBe(true);
    });
});

describe('SlideToConfirm', () => {
    it('does not confirm below 80% and snaps back', async () => {
        await render();
        await swipe(TRAVEL * 0.7);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(handle().props['aria-valuenow']).toBe(0);
    });

    it('confirms once after sliding past 80%', async () => {
        await render();
        await swipe(TRAVEL * 0.85);
        expect(onConfirm).toHaveBeenCalledOnce();
        expect(handle().props['aria-disabled']).toBe(true);
        await swipe(TRAVEL);
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('re-arms when resetKey changes', async () => {
        await render({ resetKey: 1 });
        await swipe(TRAVEL);
        await rerender({ resetKey: 2 });
        await swipe(TRAVEL);
        expect(onConfirm).toHaveBeenCalledTimes(2);
    });

    it('ignores gestures and keys while disabled and shows the reason', async () => {
        await render({ disabled: true, disabledReason: '伺服器或模式已變更' });
        await swipe(TRAVEL);
        await key('End');
        await key('Enter');
        expect(onConfirm).not.toHaveBeenCalled();
        expect(handle().props.tabIndex).toBe(-1);
        expect(JSON.stringify(view!.toJSON())).toContain('伺服器或模式已變更');
    });

    it('does not confirm when disabled during the drag', async () => {
        await render();
        await act(async () => { handle().props.onPointerDown(ptr(0)); });
        await act(async () => { handle().props.onPointerMove(ptr(TRAVEL)); });
        await rerender({ disabled: true });
        await act(async () => { handle().props.onPointerUp(ptr(TRAVEL)); });
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('never confirms when the track cannot be measured', async () => {
        await render({}, { measured: false });
        await swipe(10_000);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('is keyboard accessible: Enter confirms only after moving past 80%', async () => {
        await render();
        expect(handle().props.tabIndex).toBe(0);
        await key('Enter');
        await key('ArrowRight');
        await key('ArrowRight');
        await key('ArrowRight');
        await key('Enter'); // 75%
        expect(onConfirm).not.toHaveBeenCalled();
        await key('ArrowRight');
        expect(handle().props['aria-valuenow']).toBe(100);
        await key('Enter');
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('Escape resets keyboard progress', async () => {
        await render();
        await key('End');
        await key('Escape');
        await key('Enter');
        expect(onConfirm).not.toHaveBeenCalled();
    });
});

// ---- v2（設計規格 §6.3、§10 S2）：門檻只看放手位置、armDelay、中止條件、AT 後備 ----

vi.mock('../motion/haptics', () => ({ haptic: vi.fn(() => true) }));

describe('SlideToConfirm v2 — S2', () => {
    let now = 0;
    const presence = (over: Partial<SheetPresence> = {}): SheetPresence => ({ phase: 'open', settled: true, shownAt: 0, isExiting: () => false, ...over });
    const slide = (props: Partial<SlideToConfirmProps>) => createElement(SlideToConfirm, { label: '滑動確認 買進 2330', onConfirm, ...props });
    const inSheet = (p: SheetPresence, props: Partial<SlideToConfirmProps> = {}) => createElement(SheetPresenceContext.Provider, { value: p }, slide(props));
    async function mount(el: ReturnType<typeof createElement>) {
        await act(async () => { view = create(el, { createNodeMock: nodeMock }); });
    }
    const at = (clientX: number, timeStamp?: number) => ({ pointerId: 1, clientX, timeStamp, currentTarget: { setPointerCapture: vi.fn() } });
    const down = async (x: number, ts?: number) => { await act(async () => { handle().props.onPointerDown(at(x, ts)); }); };
    const move = async (x: number, ts?: number) => { await act(async () => { handle().props.onPointerMove(at(x, ts)); }); };
    const up = async (x: number, ts?: number) => { await act(async () => { handle().props.onPointerUp(at(x, ts)); }); };
    const track = () => view!.root.find(n => n.type === 'div' && n.props['data-ready'] !== undefined);

    beforeEach(() => {
        now = 10_000;
        vi.mocked(haptic).mockClear();
        setMotionClockForTest({ now: () => now, frame: () => 0, cancel: () => undefined });
    });
    afterEach(() => setMotionClockForTest(null));

    it('0.7 高速甩動（帶 timeStamp）放手 → 不送出（速度不參與判定）', async () => {
        await render();
        await down(0, 1000);
        await move(TRAVEL * 0.5, 1008);
        await up(TRAVEL * 0.7, 1016); // 約 26,000 px/s
        expect(onConfirm).not.toHaveBeenCalled();
        expect(handle().props['aria-valuenow']).toBe(0);
    });

    it('越過 0.8 再退到 0.75 放手 → 不送出；就緒視覺與送出條件同為 p ≥ 0.8', async () => {
        await render();
        await down(0);
        await move(TRAVEL * 0.85);
        expect(track().props['data-ready']).toBe('true');
        expect(handle().props['aria-valuetext']).toBe('85%，按 Enter 確認');
        expect(JSON.stringify(view!.toJSON())).toContain('放開即送出，往回滑可取消');
        await move(TRAVEL * 0.79);
        expect(track().props['data-ready']).toBe('false');
        expect(handle().props['aria-valuenow']).toBe(75);
        await move(TRAVEL * 0.8);
        expect(track().props['data-ready']).toBe('true');
        await move(TRAVEL * 0.75);
        await up(TRAVEL * 0.75);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(handle().props['aria-valuenow']).toBe(0);
    });

    it('放手位置與最後一次 move 不同時，以放手位置判定', async () => {
        await render();
        await down(0);
        await move(TRAVEL * 0.95);
        await up(TRAVEL * 0.6);
        expect(onConfirm).not.toHaveBeenCalled();
        await down(0);
        await move(TRAVEL * 0.5);
        await up(TRAVEL * 0.9);
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('語意進度每跨 5% 才更新', async () => {
        await render();
        await down(0);
        await move(TRAVEL * 0.33);
        expect(handle().props['aria-valuenow']).toBe(30);
        await move(TRAVEL * 0.34);
        expect(handle().props['aria-valuenow']).toBe(30);
        await move(TRAVEL * 0.36);
        expect(handle().props['aria-valuenow']).toBe(35);
    });

    it('未就緒（面板未 settled 且開啟未滿 300ms）時 pointerdown 無效；滿 300ms 後可用；鍵盤不受影響', async () => {
        await mount(inSheet(presence({ phase: 'entering', settled: false, shownAt: now - 100 })));
        expect(track().props['data-armed']).toBe('false');
        await swipe(TRAVEL);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(handle().props['aria-valuenow']).toBe(0);
        now += 200;
        await swipe(TRAVEL);
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('鍵盤路徑不受進場保護影響', async () => {
        await mount(inSheet(presence({ phase: 'entering', settled: false, shownAt: now })));
        await key('End');
        await key('Enter');
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('面板 settled 後立即可用（settled 與 300ms 先到者）', async () => {
        await mount(inSheet(presence({ settled: true, shownAt: now })));
        expect(track().props['data-armed']).toBe('true');
        await swipe(TRAVEL);
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('resetKey 改變（面板未 settled）重新計時 armDelay', async () => {
        const p = presence({ phase: 'entering', settled: false, shownAt: now - 1000 });
        await mount(inSheet(p, { resetKey: 1 }));
        await act(async () => { view!.update(inSheet(p, { resetKey: 2 })); });
        await swipe(TRAVEL);
        expect(onConfirm).not.toHaveBeenCalled();
        now += 300;
        await swipe(TRAVEL);
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('armDelayMs 可調整', async () => {
        await mount(inSheet(presence({ phase: 'entering', settled: false, shownAt: now - 100 }), { armDelayMs: 50 }));
        await swipe(TRAVEL);
        expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('lostpointercapture 中止：歸零、放手不送出', async () => {
        await render();
        await down(0);
        await move(TRAVEL * 0.9);
        await act(async () => { handle().props.onLostPointerCapture(at(TRAVEL * 0.9)); });
        expect(handle().props['aria-valuenow']).toBe(0);
        await up(TRAVEL * 0.9);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('pointercancel 中止：歸零、放手不送出', async () => {
        await render();
        await down(0);
        await move(TRAVEL * 0.9);
        await act(async () => { handle().props.onPointerCancel(at(TRAVEL * 0.9)); });
        await up(TRAVEL * 0.9);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(handle().props['aria-valuenow']).toBe(0);
    });

    it('visibilitychange 為 hidden：歸零、放手不送出', async () => {
        const listeners: (() => void)[] = [];
        const doc = {
            visibilityState: 'visible',
            addEventListener: (type: string, cb: () => void) => { if (type === 'visibilitychange') listeners.push(cb); },
            removeEventListener: vi.fn(),
        };
        vi.stubGlobal('document', doc);
        await render();
        await down(0);
        await move(TRAVEL * 0.9);
        doc.visibilityState = 'hidden';
        await act(async () => { listeners.forEach(l => l()); });
        expect(handle().props['aria-valuenow']).toBe(0);
        await up(TRAVEL * 0.9);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('所在面板退場（presence 變 exiting）：歸零、停用、放手不送出', async () => {
        await mount(inSheet(presence()));
        await down(0);
        await move(TRAVEL * 0.9);
        await act(async () => { view!.update(inSheet(presence({ phase: 'exiting', settled: false, isExiting: () => true }))); });
        expect(handle().props['aria-valuenow']).toBe(0);
        expect(handle().props['aria-disabled']).toBe(true);
        await up(TRAVEL * 0.9);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('isExiting() 已為真（render 尚未更新）時放手也不送出', async () => {
        let exiting = false;
        await mount(inSheet(presence({ isExiting: () => exiting })));
        await down(0);
        await move(TRAVEL * 0.9);
        exiting = true;
        await up(TRAVEL * 0.9);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('觸覺：越過 0.8 震一次，退回 0.77 以下才會再震（不影響判定）', async () => {
        await render();
        await down(0);
        await move(TRAVEL * 0.85);
        expect(haptic).toHaveBeenCalledTimes(1);
        expect(haptic).toHaveBeenLastCalledWith('threshold');
        await move(TRAVEL * 0.78);
        await move(TRAVEL * 0.9);
        expect(haptic).toHaveBeenCalledTimes(1);
        await move(TRAVEL * 0.7);
        await move(TRAVEL * 0.95);
        expect(haptic).toHaveBeenCalledTimes(2);
        await move(TRAVEL * 0.78);
        await up(TRAVEL * 0.78);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('拖曳中不逐 move setState 寫位移：把手與填充的 React style 恆為 undefined', async () => {
        await render();
        await down(0);
        await move(TRAVEL * 0.5);
        expect(handle().props.style).toBeUndefined();
        expect(view!.root.find(n => n.props['data-testid'] === 'slide-to-confirm-fill').props.style).toBeUndefined();
    });

    describe('AT 後備（SLIDE_AT_FALLBACK）', () => {
        it('預設關閉', () => {
            expect(SLIDE_AT_FALLBACK).toBe('off');
        });

        it("'off'：click 不會送出（即使已到 100%）", async () => {
            await render();
            await key('End');
            await act(async () => { handle().props.onClick(); });
            expect(onConfirm).not.toHaveBeenCalled();
        });

        it("'click'：進度不足 80% 時 click 不送出（不是單擊送出）；≥ 80% 且靜止才送出", async () => {
            await render({ atFallback: 'click' });
            await act(async () => { handle().props.onClick(); });
            expect(onConfirm).not.toHaveBeenCalled();
            await key('ArrowRight');
            await key('ArrowRight');
            await key('ArrowRight');
            await act(async () => { handle().props.onClick(); }); // 75%
            expect(onConfirm).not.toHaveBeenCalled();
            await key('ArrowRight');
            await act(async () => { handle().props.onClick(); });
            expect(onConfirm).toHaveBeenCalledOnce();
        });

        it("'click'：最近 350ms 內有指標拖曳時不接受 click", async () => {
            await render({ atFallback: 'click' });
            await down(0);
            await up(0);
            await key('End');
            now += 100;
            await act(async () => { handle().props.onClick(); });
            expect(onConfirm).not.toHaveBeenCalled();
            now += 300;
            await act(async () => { handle().props.onClick(); });
            expect(onConfirm).toHaveBeenCalledOnce();
        });

        it("'click'：停用時不送出", async () => {
            await render({ atFallback: 'click' });
            await key('End');
            await rerender({ atFallback: 'click', disabled: true });
            await act(async () => { handle().props.onClick(); });
            expect(onConfirm).not.toHaveBeenCalled();
        });

        it("'range'：原生 range 只調整進度、不送出；≥ 80% 後再以 click 確認", async () => {
            await render({ atFallback: 'range' });
            const range = () => view!.root.find(n => n.type === 'input' && n.props.type === 'range');
            expect(range().props.step).toBe(25);
            await act(async () => { range().props.onChange({ target: { value: '50' } }); });
            expect(handle().props['aria-valuenow']).toBe(50);
            await act(async () => { handle().props.onClick(); });
            expect(onConfirm).not.toHaveBeenCalled();
            await act(async () => { range().props.onChange({ target: { value: '100' } }); });
            expect(onConfirm).not.toHaveBeenCalled();
            await act(async () => { handle().props.onClick(); });
            expect(onConfirm).toHaveBeenCalledOnce();
        });
    });
});

describe('SlideToConfirm v2 — 彈簧直接寫 style（createNodeMock＋假時鐘）', () => {
    let now = 0;
    let frames = new Map<number, (t: number) => void>();
    let nextId = 1;
    const styled = new Map<string, Record<string, string>>();
    const animMock = (el: ReturnType<typeof createElement>) => {
        const style: Record<string, string> = {};
        const p = el.props as Record<string, unknown>;
        const key = p.role === 'slider' ? 'handle' : p['data-testid'] === 'slide-to-confirm-fill' ? 'fill' : String(p.className ?? '');
        styled.set(key, style);
        return { style, isConnected: true, getBoundingClientRect: () => ({ width: TRAVEL + SLIDE_HANDLE_SPAN_PX }) };
    };
    const step = async () => {
        await act(async () => {
            now += 16;
            const fs = Array.from(frames.values());
            frames = new Map();
            fs.forEach(f => f(now));
        });
    };
    const at = (clientX: number, timeStamp: number) => ({ pointerId: 1, clientX, timeStamp, currentTarget: { setPointerCapture: vi.fn() } });

    beforeEach(() => {
        now = 1000;
        frames = new Map();
        nextId = 1;
        styled.clear();
        setMotionClockForTest({ now: () => now, frame: cb => { const id = nextId++; frames.set(id, cb); return id; }, cancel: id => { frames.delete(id); } });
    });
    afterEach(() => setMotionClockForTest(null));

    it('拖曳 1:1 寫 translateX；未達門檻放手以彈簧回 0，畫面值不小於 0（不過頭）', async () => {
        await act(async () => { view = create(createElement(SlideToConfirm, { label: 'x', onConfirm }), { createNodeMock: animMock }); });
        await act(async () => { handle().props.onPointerDown(at(0, 5000)); });
        await act(async () => { handle().props.onPointerMove(at(150, 5100)); });
        expect(styled.get('handle')!.transform).toBe('translateX(150px)');
        expect(styled.get('fill')!.transform).toBe(`translateX(${150 + SLIDE_HANDLE_SPAN_PX}px)`);
        // 往左快速甩回後放手：回彈初速朝 0，畫面值夾在 ≥ 0
        await act(async () => { handle().props.onPointerMove(at(120, 5110)); });
        await act(async () => { handle().props.onPointerUp(at(60, 5120)); });
        expect(onConfirm).not.toHaveBeenCalled();
        for (let i = 0; i < 80; i++) {
            await step();
            const t = styled.get('handle')!.transform ?? '';
            const x = t ? Number(/translateX\((-?[\d.]+)px\)/.exec(t)?.[1]) : 0;
            expect(x).toBeGreaterThanOrEqual(0);
        }
        expect(styled.get('handle')!.transform).toBe('');
        expect(handle().props['aria-valuenow']).toBe(0);
    });

    it('回彈中再抓住：從畫面上的位置接手（保留抓取偏移）', async () => {
        await act(async () => { view = create(createElement(SlideToConfirm, { label: 'x', onConfirm }), { createNodeMock: animMock }); });
        await act(async () => { handle().props.onPointerDown(at(0, 5000)); });
        await act(async () => { handle().props.onPointerMove(at(210, 5100)); });
        await act(async () => { handle().props.onPointerUp(at(210, 5200)); }); // 0.7 → 回彈
        await step();
        await step();
        const x = Number(/translateX\(([\d.]+)px\)/.exec(styled.get('handle')!.transform ?? '')?.[1]);
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(210);
        // 從 x 抓住，再往右 30px → 畫面在 x + 30
        await act(async () => { handle().props.onPointerDown(at(500, 6000)); });
        await act(async () => { handle().props.onPointerMove(at(530, 6100)); });
        const y = Number(/translateX\(([\d.]+)px\)/.exec(styled.get('handle')!.transform ?? '')?.[1]);
        expect(y).toBeCloseTo(x + 30, 5);
        await act(async () => { handle().props.onPointerUp(at(530, 6200)); });
        expect(onConfirm).toHaveBeenCalledTimes(x + 30 >= TRAVEL * 0.8 ? 1 : 0);
    });
});
