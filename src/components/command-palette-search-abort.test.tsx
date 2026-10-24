// src/components/command-palette-search-abort.test.tsx — Ctrl+K 輸入變更時取消上一筆搜尋

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    searchProducts: vi.fn(),
}));

vi.mock('../lib/product-search', () => ({
    searchProducts: mocks.searchProducts,
}));
vi.mock('../lib/contracts-cache', () => ({
    primeContract: vi.fn(),
}));

import { CommandPalette } from './command-palette';

describe('CommandPalette search cancellation', () => {
    let view: ReactTestRenderer | null = null;

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.useFakeTimers();
        mocks.searchProducts.mockReset();
    });

    afterEach(async () => {
        if (view) {
            await act(async () => view!.unmount());
            view = null;
        }
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('aborts the in-flight search when the query changes', async () => {
        const signals: AbortSignal[] = [];
        mocks.searchProducts.mockImplementation(
            (_q: string, _l: number, opts?: { signal?: AbortSignal }) => {
                if (opts?.signal) signals.push(opts.signal);
                return new Promise(() => undefined);
            },
        );
        await act(async () => {
            view = create(
                createElement(CommandPalette, {
                    open: true,
                    onClose: vi.fn(),
                    onJump: vi.fn(async () => undefined),
                }),
            );
        });
        const input = () => view!.root.findByType('input');
        await act(async () => {
            input().props.onChange({ target: { value: '23' } });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        await act(async () => {
            input().props.onChange({ target: { value: '233' } });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(150);
        });
        expect(signals).toHaveLength(2);
        expect(signals[0]!.aborted).toBe(true);
        expect(signals[1]!.aborted).toBe(false);
    });
});
