// 螢幕鍵盤高度（設計規格 §6.1「鍵盤」）：inset = max(0, innerHeight − vv.height − vv.offsetTop)，寫入 backdrop 的 --sj-kb
import { createElement, useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyboardInset, useKeyboardInset } from './use-keyboard-inset';

describe('keyboardInset', () => {
    it('扣掉可視區高度與捲動偏移，不為負、量不到為 0', () => {
        expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toBe(336);
        expect(keyboardInset(844, { height: 508, offsetTop: 36 })).toBe(300);
        expect(keyboardInset(844, { height: 844, offsetTop: 0 })).toBe(0);
        expect(keyboardInset(844, { height: 900, offsetTop: 0 })).toBe(0);
        expect(keyboardInset(844, null)).toBe(0);
        expect(keyboardInset(Number.NaN, { height: 500, offsetTop: 0 })).toBe(0);
        expect(keyboardInset(844, { height: 508, offsetTop: Number.NaN })).toBe(336);
    });
});

describe('useKeyboardInset', () => {
    let view: ReactTestRenderer | undefined;
    const listeners = new Map<string, () => void>();
    const vv = {
        height: 844,
        offsetTop: 0,
        addEventListener: (type: string, cb: () => void) => { listeners.set(type, cb); },
        removeEventListener: vi.fn((type: string) => { listeners.delete(type); }),
    };
    const setProperty = vi.fn();
    const Probe = ({ enabled }: { enabled: boolean }) => {
        const ref = useRef<HTMLElement | null>({ style: { setProperty } } as unknown as HTMLElement);
        useKeyboardInset(ref, enabled);
        return null;
    };

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('window', { innerHeight: 844, visualViewport: vv });
        listeners.clear();
        setProperty.mockReset();
        vv.height = 844;
    });
    afterEach(async () => {
        await act(async () => view?.unmount());
        view = undefined;
        vi.unstubAllGlobals();
    });

    it('開啟時寫入 --sj-kb，鍵盤升起與收起時更新，卸載時歸零並移除監聽', async () => {
        await act(async () => { view = create(createElement(Probe, { enabled: true })); });
        expect(setProperty).toHaveBeenLastCalledWith('--sj-kb', '0px');
        vv.height = 508;
        listeners.get('resize')!();
        expect(setProperty).toHaveBeenLastCalledWith('--sj-kb', '336px');
        const calls = setProperty.mock.calls.length;
        listeners.get('scroll')!(); // 沒變化不重寫
        expect(setProperty.mock.calls.length).toBe(calls);
        await act(async () => view!.unmount());
        view = undefined;
        expect(setProperty).toHaveBeenLastCalledWith('--sj-kb', '0px');
        expect(vv.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
        expect(vv.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    });

    it('停用時不監聽、不寫入', async () => {
        await act(async () => { view = create(createElement(Probe, { enabled: false })); });
        expect(listeners.size).toBe(0);
        expect(setProperty).not.toHaveBeenCalled();
    });
});
