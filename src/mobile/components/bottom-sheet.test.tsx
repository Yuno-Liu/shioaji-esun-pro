// 共用底部面板：下滑關閉依「放開當下」的 dismissible（拖曳開始後才進入送出中時不可關閉，T6）。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet, DISMISS_DRAG_PX } from './bottom-sheet';
import { useContext, type ReactElement } from 'react';
import { resetSheetStackForTest } from '../lib/sheet-stack';
import { DRAG_EXCLUDE_SELECTOR } from '../motion/gesture';
import { setMotionClockForTest } from '../motion/spring';
import { SheetPresenceContext, SheetRootContext, type SheetPresence } from '../ui/sheet-context';
import { SheetFooter, sheetReleaseDecision, SHEET_BUMP_PX, type BottomSheetProps } from './bottom-sheet';
import * as sheetStyles from '../styles/sheet.css';
import { GESTURE, REDUCED_MOTION } from '../styles/tokens';

let view: ReactTestRenderer | undefined;
const onClose = vi.fn();

function sheet(dismissible: boolean) {
    return createElement(BottomSheet, { open: true, onClose, dismissible, title: '下單', testId: 's', children: createElement('p', null, 'body') });
}
const grab = () => view!.root.find(n => n.props['data-testid'] === 's-grab' && typeof n.type === 'string');
const panel = () => view!.root.find(n => n.props['data-testid'] === 's' && typeof n.type === 'string');
const pointer = (pointerId: number, clientY: number) => ({
    pointerId, clientY, target: { closest: () => null }, currentTarget: { setPointerCapture: () => undefined },
});

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    onClose.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('BottomSheet — 下滑關閉', () => {
    it('可關閉時：下滑超過門檻放開即關閉', async () => {
        await act(async () => { view = create(sheet(true)); });
        await act(async () => { grab().props.onPointerDown(pointer(1, 100)); });
        await act(async () => { grab().props.onPointerMove(pointer(1, 100 + DISMISS_DRAG_PX + 10)); });
        expect(panel().props.style).toEqual({ transform: `translateY(${DISMISS_DRAG_PX + 10}px)` });
        await act(async () => { grab().props.onPointerUp(pointer(1, 100 + DISMISS_DRAG_PX + 10)); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('拖曳開始後才變成不可關閉（送出中）：放開時不關閉，面板回原位', async () => {
        await act(async () => { view = create(sheet(true)); });
        await act(async () => { grab().props.onPointerDown(pointer(1, 100)); });
        await act(async () => { grab().props.onPointerMove(pointer(1, 150)); });
        await act(async () => { view!.update(sheet(false)); });
        await act(async () => { grab().props.onPointerUp(pointer(1, 100 + DISMISS_DRAG_PX + 40)); });
        expect(onClose).not.toHaveBeenCalled();
        expect(panel().props.style).toBeUndefined();
    });

    it('拖曳中變成不可關閉：移動時取消拖曳（不再位移），之後恢復可關閉也不會因舊拖曳而關閉', async () => {
        await act(async () => { view = create(sheet(true)); });
        await act(async () => { grab().props.onPointerDown(pointer(1, 100)); });
        await act(async () => { view!.update(sheet(false)); });
        await act(async () => { grab().props.onPointerMove(pointer(1, 300)); });
        expect(panel().props.style).toBeUndefined();
        await act(async () => { view!.update(sheet(true)); });
        await act(async () => { grab().props.onPointerUp(pointer(1, 300)); });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('不可關閉時按下不開始拖曳', async () => {
        await act(async () => { view = create(sheet(false)); });
        await act(async () => { grab().props.onPointerDown(pointer(1, 100)); });
        await act(async () => { grab().props.onPointerUp(pointer(1, 100 + DISMISS_DRAG_PX + 10)); });
        expect(onClose).not.toHaveBeenCalled();
    });
});

// ---- v2（設計規格 §6.1、§6.2、§10 S3／S4／S5） ----

describe('sheetReleaseDecision', () => {
    it('不可關閉或沒有往下：一律 stay', () => {
        expect(sheetReleaseDecision({ y: 500, vy: 5000, height: 400, dismissible: false })).toBe('stay');
        expect(sheetReleaseDecision({ y: 0, vy: 5000, height: 400, dismissible: true })).toBe('stay');
        expect(sheetReleaseDecision({ y: -20, vy: 5000, height: 400, dismissible: true })).toBe('stay');
    });

    it('快速下甩 ≥1000px/s 且超過 10px：dismiss', () => {
        expect(sheetReleaseDecision({ y: 11, vy: 1000, height: 600, dismissible: true })).toBe('dismiss');
        expect(sheetReleaseDecision({ y: 10, vy: 1000, height: 600, dismissible: true })).toBe('stay');
    });

    it('量不到高度：沿用 80px 舊規則（不投射）', () => {
        expect(sheetReleaseDecision({ y: DISMISS_DRAG_PX, vy: 0, height: 0, dismissible: true })).toBe('dismiss');
        expect(sheetReleaseDecision({ y: DISMISS_DRAG_PX - 1, vy: 900, height: 0, dismissible: true })).toBe('stay');
    });

    it('量得到高度：投射 vy × 0.099 後與 max(80, 高度一半) 比較', () => {
        // 高度 400 → 門檻 200；y 150 + 600 × 0.099 = 209.4 → dismiss
        expect(sheetReleaseDecision({ y: 150, vy: 600, height: 400, dismissible: true })).toBe('dismiss');
        expect(sheetReleaseDecision({ y: 150, vy: 400, height: 400, dismissible: true })).toBe('stay');
        // 往上甩的投射會把位置拉回
        expect(sheetReleaseDecision({ y: 200, vy: -500, height: 400, dismissible: true })).toBe('stay');
        // 矮面板門檻至少 80px
        expect(sheetReleaseDecision({ y: 70, vy: 0, height: 100, dismissible: true })).toBe('stay');
    });
});

const onExited = vi.fn();
const props = (over: Partial<BottomSheetProps> = {}): BottomSheetProps => ({
    open: true, onClose, onExited, title: '下單', testId: 's', children: createElement('p', null, 'body'), ...over,
});
const node = (id: string) => view!.root.find(n => n.props['data-testid'] === id && typeof n.type === 'string');
const maybe = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string')[0];
const texts = () => JSON.stringify(view!.toJSON());
const closeButtons = () => view!.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '關閉');

describe('BottomSheet v2 — 同步模式（測試、無 DOM）', () => {
    beforeEach(() => onExited.mockReset());

    it('關閉立即卸載並呼叫 onExited；沒有退場殘留', async () => {
        await act(async () => { view = create(createElement(BottomSheet, props())); });
        expect(node('s').props['data-phase']).toBe('open');
        await act(async () => { view!.update(createElement(BottomSheet, props({ open: false }))); });
        expect(view!.toJSON()).toBeNull();
        expect(onExited).toHaveBeenCalledOnce();
    });

    it('預設 inline 原地渲染；SheetRootContext 為 null（殼層節點尚未掛上）時該幀不渲染', async () => {
        await act(async () => {
            view = create(createElement(SheetRootContext.Provider, { value: null }, createElement(BottomSheet, props())));
        });
        expect(view!.toJSON()).toBeNull();
    });

    it('footer prop 渲染在固定 footer；SheetFooter 沒有 footer 目標時原地渲染', async () => {
        await act(async () => {
            view = create(createElement(BottomSheet, props({
                footer: createElement('span', null, 'F1'),
                children: createElement(SheetFooter, null, createElement('span', null, 'F2')),
            })));
        });
        const footerEl = view!.root.find(n => n.props['data-sheet-footer'] === '' && typeof n.type === 'string');
        const bodyEl = view!.root.find(n => n.props['data-sheet-body'] === '' && typeof n.type === 'string');
        expect(footerEl.findAll(n => n.type === 'span' && n.children.includes('F1'))).toHaveLength(1);
        expect(bodyEl.findAll(n => n.type === 'span' && n.children.includes('F2'))).toHaveLength(1);
    });

    it('pinned：渲染在 body 之外的固定區（panel 直接子元素、在 body 之前）；沒有 pinned 時不渲染該區', async () => {
        await act(async () => { view = create(createElement(BottomSheet, props({ pinned: createElement('strong', { 'data-testid': 'pin' }, 'ENV') }))); });
        const isHost = (n: { type: unknown }) => typeof n.type === 'string';
        const pinnedEl = view!.root.find(n => n.props['data-sheet-pinned'] === '' && isHost(n));
        const bodyEl = view!.root.find(n => n.props['data-sheet-body'] === '' && isHost(n));
        expect(pinnedEl.findAll(n => n.props['data-testid'] === 'pin' && isHost(n))).toHaveLength(1);
        expect(bodyEl.findAll(n => n.props['data-testid'] === 'pin')).toHaveLength(0);
        expect(pinnedEl.parent!.props.role).toBe('dialog');
        expect(node('s').findAll(n => isHost(n) && (n.props['data-sheet-pinned'] === '' || n.props['data-sheet-body'] === ''))).toEqual([pinnedEl, bodyEl]);
        await act(async () => { view!.update(createElement(BottomSheet, props())); });
        expect(view!.root.findAll(n => n.props['data-sheet-pinned'] !== undefined && isHost(n))).toHaveLength(0);
    });

    it('backdrop 攔下 React click／pointerdown 冒泡（portal 不冒泡到頁面祖先）', async () => {
        await act(async () => { view = create(createElement(BottomSheet, props())); });
        const stopClick = vi.fn();
        const stopDown = vi.fn();
        await act(async () => { node('s-backdrop').props.onClick({ target: 1, currentTarget: 2, stopPropagation: stopClick }); });
        await act(async () => { node('s-backdrop').props.onPointerDown({ stopPropagation: stopDown }); });
        expect(stopClick).toHaveBeenCalledOnce();
        expect(stopDown).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled(); // 點在面板內（target ≠ currentTarget）不關閉
    });

    it('堆疊：確認面板疊在一般面板上 → data-stacked 與 z-index（層級基準＋10×堆疊序）', async () => {
        await act(async () => {
            view = create(createElement('div', null,
                createElement(BottomSheet, props({ testId: 'a' })),
                createElement(BottomSheet, props({ testId: 'b', layer: 'confirm' }))));
        });
        expect(node('a-backdrop').props['data-stacked']).toBe('false');
        expect(node('b-backdrop').props['data-stacked']).toBe('true');
        expect(node('b-backdrop').props.style).toEqual({ zIndex: 210 });
    });
});

describe('BottomSheet v2 — S3 手勢互不干擾', () => {
    it('grabArea 起點為 [role=slider]、input、button 時不拖曳', async () => {
        await act(async () => { view = create(createElement(BottomSheet, props())); });
        const fromSlider = (pointerId: number, clientY: number) => ({
            ...pointer(pointerId, clientY),
            target: { closest: (sel: string) => (sel === DRAG_EXCLUDE_SELECTOR ? { role: 'slider' } : null) },
        });
        await act(async () => { grab().props.onPointerDown(fromSlider(1, 100)); });
        await act(async () => { grab().props.onPointerMove(fromSlider(1, 300)); });
        expect(panel().props.style).toBeUndefined();
        await act(async () => { grab().props.onPointerUp(fromSlider(1, 300)); });
        expect(onClose).not.toHaveBeenCalled();
        expect(DRAG_EXCLUDE_SELECTOR).toContain('[role="slider"]');
        expect(DRAG_EXCLUDE_SELECTOR).toContain('input');
        expect(DRAG_EXCLUDE_SELECTOR).toContain('button');
    });

    it('拖曳後 350ms 內 click 被攔下（capture 階段 stopPropagation＋preventDefault）', async () => {
        vi.useFakeTimers();
        try {
            await act(async () => { view = create(createElement(BottomSheet, props())); });
            const listeners: { type: string; fn: (e: unknown) => void; capture: boolean }[] = [];
            const currentTarget = {
                setPointerCapture: () => undefined,
                addEventListener: (type: string, fn: (e: unknown) => void, capture: boolean) => { listeners.push({ type, fn, capture }); },
                removeEventListener: vi.fn(),
            };
            const ev = (clientY: number) => ({ ...pointer(1, clientY), currentTarget });
            await act(async () => { grab().props.onPointerDown(ev(100)); });
            await act(async () => { grab().props.onPointerMove(ev(130)); });
            await act(async () => { grab().props.onPointerUp(ev(130)); });
            expect(onClose).not.toHaveBeenCalled();
            expect(listeners).toHaveLength(1);
            expect(listeners[0]).toMatchObject({ type: 'click', capture: true });
            const click = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
            listeners[0]!.fn(click);
            expect(click.stopPropagation).toHaveBeenCalled();
            expect(click.preventDefault).toHaveBeenCalled();
            vi.advanceTimersByTime(350);
            expect(currentTarget.removeEventListener).toHaveBeenCalledWith('click', listeners[0]!.fn, true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('BottomSheet v2 — S5 不可關閉就真的關不掉', () => {
    type Listener = (e: KeyboardEvent) => void;
    let keyListeners: Listener[] = [];
    const escape = () => {
        const e = { key: 'Escape', defaultPrevented: false, isComposing: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        keyListeners.forEach(l => l(e as unknown as KeyboardEvent));
    };
    beforeEach(() => {
        keyListeners = [];
        vi.stubGlobal('document', {
            activeElement: null,
            body: null,
            addEventListener: (type: string, fn: Listener) => { if (type === 'keydown') keyListeners.push(fn); },
            removeEventListener: (type: string, fn: Listener) => { keyListeners = keyListeners.filter(l => l !== fn); },
        });
    });
    afterEach(async () => {
        await act(async () => view?.unmount());
        view = undefined;
        resetSheetStackForTest();
    });

    it('dismissible=false：把手按放、點暗化幕、Esc 皆不呼叫 onClose，且沒有關閉鈕', async () => {
        await act(async () => { view = create(sheet(false)); });
        await act(async () => { grab().props.onPointerDown(pointer(1, 100)); });
        await act(async () => { grab().props.onPointerUp(pointer(1, 100)); });
        await act(async () => { node('s-backdrop').props.onClick({ target: 1, currentTarget: 1 }); });
        expect(keyListeners).toHaveLength(1); // sheet-stack 已安裝 document keydown
        await act(async () => { escape(); });
        expect(onClose).not.toHaveBeenCalled();
        expect(closeButtons()).toHaveLength(0);
    });

    it('對照：可關閉時 Esc 與點暗化幕都會要求關閉', async () => {
        await act(async () => { view = create(sheet(true)); });
        await act(async () => { escape(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        await act(async () => { node('s-backdrop').props.onClick({ target: 1, currentTarget: 1 }); });
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(closeButtons()).toHaveLength(1);
    });
});

describe('BottomSheet v2 — 可動畫（createNodeMock＋假時鐘）', () => {
    type Mock = { style: Record<string, string>; isConnected: true; getBoundingClientRect: () => { height: number; width: number }; focus: () => void; contains: () => boolean };
    let now = 0;
    let frames = new Map<number, (t: number) => void>();
    let nextId = 1;
    let mocks: { props: Record<string, unknown>; node: Mock }[] = [];
    const createNodeMock = (el: ReactElement) => {
        const n: Mock = { style: {}, isConnected: true, getBoundingClientRect: () => ({ height: 400, width: 390 }), focus: vi.fn(), contains: () => false };
        mocks.push({ props: el.props as Record<string, unknown>, node: n });
        return n;
    };
    const panelNode = (testId = 's') => mocks.find(m => m.props.role === 'dialog' && String(m.props['data-testid']).startsWith(testId))!.node;
    const yOf = (testId = 's') => Number(/translateY\((-?[\d.]+)px\)/.exec(panelNode(testId).style.transform ?? '')?.[1] ?? 0);
    const step = async (ms = 16) => {
        await act(async () => {
            now += ms;
            const fs = Array.from(frames.values());
            frames = new Map();
            fs.forEach(f => f(now));
        });
    };
    const settle = async (ms = 1500) => { for (let t = 0; t < ms; t += 16) await step(); };
    const render = async (el: ReactElement) => { await act(async () => { view = create(el, { createNodeMock }); }); };

    beforeEach(() => {
        now = 1000;
        frames = new Map();
        nextId = 1;
        mocks = [];
        onExited.mockReset();
        setMotionClockForTest({
            now: () => now,
            frame: cb => { const id = nextId++; frames.set(id, cb); return id; },
            cancel: id => { frames.delete(id); },
        });
    });
    afterEach(async () => {
        await act(async () => view?.unmount());
        view = undefined;
        setMotionClockForTest(null);
    });

    it('進場：從面板高度以彈簧到 0；React style 恆為 undefined（位移直接寫 element.style）', async () => {
        await render(createElement(BottomSheet, props()));
        expect(node('s').props['data-phase']).toBe('entering');
        expect(panelNode().style.transform).toBe('translateY(400px)');
        expect(node('s').props.style).toBeUndefined();
        await step(100);
        expect(yOf()).toBeGreaterThan(0);
        expect(yOf()).toBeLessThan(400);
        await settle();
        expect(node('s').props['data-phase']).toBe('open');
        expect(panelNode().style.transform).toBe('none');
    });

    it('S4 退場凍結：testId 改 -closing、inert＋aria-hidden、凍結內容與 presence，結束後卸載並呼叫 onExited', async () => {
        let seen: SheetPresence | null = null;
        const Probe = ({ label }: { label: string }) => { seen = useContext(SheetPresenceContext); return createElement('p', null, label); };
        await render(createElement(BottomSheet, props({ children: createElement(Probe, { label: 'v1' }), tone: 'buy' })));
        await settle();
        expect(seen!.settled).toBe(true);
        expect(seen!.isExiting()).toBe(false);

        await act(async () => {
            view!.update(createElement(BottomSheet, props({ open: false, children: createElement(Probe, { label: 'v2' }), tone: 'sell', title: '別的標題' })));
        });
        expect(maybe('s')).toBeUndefined();
        const closing = node('s-closing');
        expect(closing.props.inert).toBe(true);
        expect(closing.props['aria-hidden']).toBe('true');
        expect(closing.props['data-phase']).toBe('exiting');
        expect(closing.props['data-tone']).toBe('buy');
        expect(node('s-closing-backdrop').props['data-phase']).toBe('exiting');
        expect(texts()).toContain('v1');
        expect(texts()).not.toContain('v2');
        expect(texts()).not.toContain('別的標題');
        expect(seen!.phase).toBe('exiting');
        expect(seen!.isExiting()).toBe(true);
        expect(onExited).not.toHaveBeenCalled();

        // 退場中按暗化幕、拖曳把手都無效
        await act(async () => { node('s-closing-backdrop').props.onClick({ target: 1, currentTarget: 1 }); });
        await act(async () => { grab().props.onPointerDown(pointer(1, 100)); });
        await act(async () => { grab().props.onPointerUp(pointer(1, 400)); });
        expect(onClose).not.toHaveBeenCalled();

        await step(64);
        expect(yOf()).toBeGreaterThan(0);
        await settle();
        expect(view!.toJSON()).toBeNull();
        expect(onExited).toHaveBeenCalledOnce();
    });

    it('退場中又 open=true：反向進場、testId 還原、shownAt 重設，不呼叫 onExited', async () => {
        let seen: SheetPresence | null = null;
        const Probe = () => { seen = useContext(SheetPresenceContext); return null; };
        await render(createElement(BottomSheet, props({ children: createElement(Probe) })));
        await settle();
        const firstShownAt = seen!.shownAt;
        await act(async () => { view!.update(createElement(BottomSheet, props({ open: false, children: createElement(Probe) }))); });
        await step(48);
        await act(async () => { view!.update(createElement(BottomSheet, props({ children: createElement(Probe) }))); });
        expect(node('s').props['data-phase']).toBe('entering');
        expect(node('s').props.inert).toBeUndefined();
        expect(seen!.isExiting()).toBe(false);
        expect(seen!.settled).toBe(false);
        expect(seen!.shownAt).toBeGreaterThan(firstShownAt);
        await settle();
        expect(node('s').props['data-phase']).toBe('open');
        expect(onExited).not.toHaveBeenCalled();
    });

    it('拖曳 1:1 跟手；放手依投射判定（慢速未達一半回 0；超過一半關閉）', async () => {
        await render(createElement(BottomSheet, props()));
        await settle();
        const ev = (clientY: number, timeStamp: number) => ({ ...pointer(1, clientY), timeStamp });
        await act(async () => { grab().props.onPointerDown(ev(100, 5000)); });
        await act(async () => { grab().props.onPointerMove(ev(150, 5100)); });
        expect(panelNode().style.transform).toBe('translateY(50px)');
        expect(node('s').props.style).toBeUndefined();
        await act(async () => { grab().props.onPointerUp(ev(150, 5200)); });
        expect(onClose).not.toHaveBeenCalled();
        await settle();
        expect(panelNode().style.transform).toBe('none');

        await act(async () => { grab().props.onPointerDown(ev(100, 6000)); });
        await act(async () => { grab().props.onPointerMove(ev(320, 6100)); });
        await act(async () => { grab().props.onPointerUp(ev(320, 6200)); });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('往上拖曳顯示橡皮筋（位移小於手指位移），放手不關閉', async () => {
        await render(createElement(BottomSheet, props()));
        await settle();
        await act(async () => { grab().props.onPointerDown(pointer(1, 300)); });
        await act(async () => { grab().props.onPointerMove(pointer(1, 200)); });
        expect(yOf()).toBeLessThan(0);
        expect(yOf()).toBeGreaterThan(-100);
        await act(async () => { grab().props.onPointerUp(pointer(1, 200)); });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('不可關閉：按把手只輕彈約 6px 再回原位，不呼叫 onClose', async () => {
        await render(createElement(BottomSheet, props({ dismissible: false })));
        await settle();
        await act(async () => { grab().props.onPointerDown(pointer(1, 100)); });
        let peak = 0;
        for (let i = 0; i < 40; i++) {
            await step();
            peak = Math.max(peak, yOf());
        }
        expect(peak).toBeGreaterThan(SHEET_BUMP_PX - 1.5);
        expect(peak).toBeLessThan(SHEET_BUMP_PX + 0.5);
        await act(async () => { grab().props.onPointerUp(pointer(1, 400)); });
        await settle();
        expect(panelNode().style.transform).toBe('none');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('T6：拖曳中變成不可關閉 → 立即取消並回到 0，放手不關閉', async () => {
        await render(createElement(BottomSheet, props()));
        await settle();
        await act(async () => { grab().props.onPointerDown(pointer(1, 100)); });
        await act(async () => { grab().props.onPointerMove(pointer(1, 250)); });
        expect(panelNode().style.transform).toBe('translateY(150px)');
        await act(async () => { view!.update(createElement(BottomSheet, props({ dismissible: false }))); });
        await act(async () => { grab().props.onPointerMove(pointer(1, 300)); });
        await act(async () => { grab().props.onPointerUp(pointer(1, 300)); });
        await settle();
        expect(panelNode().style.transform).toBe('none');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('進場途中單點把手（沒有位移）：不停住進場彈簧、不關閉；位移未超過 lockSlop 也不進入拖曳', async () => {
        await render(createElement(BottomSheet, props()));
        await step();
        const y0 = yOf();
        // 舊行為（slop 0）：按下即停住彈簧，放手以 vy=0、y≥max(80, 高度/2) 判定 dismiss
        expect(y0).toBeGreaterThan(Math.max(DISMISS_DRAG_PX, 400 / 2));
        await act(async () => { grab().props.onPointerDown(pointer(1, 100)); });
        await act(async () => { grab().props.onPointerUp(pointer(1, 100)); });
        expect(onClose).not.toHaveBeenCalled();
        expect(node('s').props['data-phase']).toBe('entering');
        await step();
        const y1 = yOf();
        expect(y1).toBeLessThan(y0); // 進場彈簧仍在跑

        // 抖動恰為 lockSlop（未超過）：仍不是拖曳
        await act(async () => { grab().props.onPointerDown(pointer(2, 100)); });
        await act(async () => { grab().props.onPointerMove(pointer(2, 100 + GESTURE.lockSlop)); });
        await act(async () => { grab().props.onPointerUp(pointer(2, 100 + GESTURE.lockSlop)); });
        expect(onClose).not.toHaveBeenCalled();
        expect(node('s').props['data-phase']).toBe('entering');
        await step();
        expect(yOf()).toBeLessThan(y1);

        await settle();
        expect(node('s').props['data-phase']).toBe('open');
        expect(panelNode().style.transform).toBe('none');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('§9 減少動態：進場淡入途中開始拖曳 → 面板與暗化幕的不透明度回到 1（不停在半透明）', async () => {
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === REDUCED_MOTION, addEventListener: () => undefined, removeEventListener: () => undefined }));
        const scrimNode = () => mocks.find(m => m.props.className === sheetStyles.scrim)!.node;
        await render(createElement(BottomSheet, props()));
        expect(yOf()).toBe(0); // 減少動態：不從底部滑入，只淡入
        await step(48);
        const mid = Number(panelNode().style.opacity);
        expect(mid).toBeGreaterThan(0);
        expect(mid).toBeLessThan(1);
        expect(Number(scrimNode().style.opacity)).toBeLessThan(1);

        await act(async () => { grab().props.onPointerDown(pointer(1, 100)); });
        await act(async () => { grab().props.onPointerMove(pointer(1, 140)); });
        expect(panelNode().style.opacity).toBe(''); // 1＝清除 inline opacity
        expect(Number(scrimNode().style.opacity)).toBeCloseTo(1 - 40 / 400, 5);
        await step(300); // 淡入已停止：不會再寫回半透明
        expect(panelNode().style.opacity).toBe('');

        await act(async () => { grab().props.onPointerUp(pointer(1, 140)); });
        await settle();
        expect(onClose).not.toHaveBeenCalled();
        expect(panelNode().style.opacity).toBe('');
        expect(scrimNode().style.opacity).toBe('1');
        expect(panelNode().style.transform).toBe('none');
    });

    it('堆疊後退：下層面板縮小並上移，上層關閉後回原狀', async () => {
        const two = (confirmOpen: boolean) => createElement('div', null,
            createElement(BottomSheet, props({ testId: 'a' })),
            createElement(BottomSheet, props({ testId: 'b', layer: 'confirm', open: confirmOpen })));
        await render(two(false));
        await settle();
        expect(panelNode('a').style.transform).toBe('none');
        await act(async () => { view!.update(two(true)); });
        await settle();
        expect(panelNode('a').style.transform).toBe('translateY(-6px) scale(0.94)');
        await act(async () => { view!.update(two(false)); });
        await settle();
        expect(panelNode('a').style.transform).toBe('none');
    });
});
