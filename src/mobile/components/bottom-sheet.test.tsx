// 共用底部面板：下滑關閉依「放開當下」的 dismissible（拖曳開始後才進入送出中時不可關閉，T6）。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet, DISMISS_DRAG_PX } from './bottom-sheet';

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
