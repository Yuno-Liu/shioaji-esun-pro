// 滑動確認：滑過 80% 行程放開才觸發一次；停用、行程未知、拖曳中被停用都不觸發；鍵盤可操作
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLIDE_HANDLE_SPAN_PX, SlideToConfirm, slideProgress, slideReached, type SlideToConfirmProps } from './slide-to-confirm';

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
