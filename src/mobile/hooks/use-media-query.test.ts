// useMediaQuery：matchMedia 不存在／丟例外時 false 且不訂閱；change 時更新；舊版 addListener 後備；卸載解除監聽
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesMediaQuery, subscribeMediaQuery, useMediaQuery } from './use-media-query';

const Q = '(max-width: 400px)';

function fakeMql(initial: boolean, legacy = false) {
    const state = { matches: initial, listeners: new Set<() => void>() };
    const mql = legacy
        ? {
            get matches() { return state.matches; },
            addListener: (cb: () => void) => { state.listeners.add(cb); },
            removeListener: (cb: () => void) => { state.listeners.delete(cb); },
        }
        : {
            get matches() { return state.matches; },
            addEventListener: (_type: 'change', cb: () => void) => { state.listeners.add(cb); },
            removeEventListener: (_type: 'change', cb: () => void) => { state.listeners.delete(cb); },
        };
    const matchMedia = vi.fn((_q: string) => mql);
    vi.stubGlobal('matchMedia', matchMedia);
    return { state, matchMedia, change: (v: boolean) => { state.matches = v; state.listeners.forEach(l => l()); } };
}

let seen: boolean[] = [];
function Probe({ query }: { query: string }) {
    seen.push(useMediaQuery(query));
    return null;
}
let view: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    seen = [];
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('useMediaQuery', () => {
    it('沒有 matchMedia：false，訂閱為 no-op', async () => {
        vi.stubGlobal('matchMedia', undefined);
        expect(matchesMediaQuery(Q)).toBe(false);
        const off = subscribeMediaQuery(Q, () => undefined);
        expect(() => off()).not.toThrow();
        await act(async () => { view = create(createElement(Probe, { query: Q })); });
        expect(seen.at(-1)).toBe(false);
    });

    it('matchMedia 丟例外：false', () => {
        vi.stubGlobal('matchMedia', () => { throw new Error('bad query'); });
        expect(matchesMediaQuery(Q)).toBe(false);
        expect(() => subscribeMediaQuery(Q, () => undefined)()).not.toThrow();
    });

    it('反映目前結果並在 change 時更新；卸載時解除監聽', async () => {
        const mq = fakeMql(true);
        await act(async () => { view = create(createElement(Probe, { query: Q })); });
        expect(seen.at(-1)).toBe(true);
        expect(mq.matchMedia).toHaveBeenCalledWith(Q);
        expect(mq.state.listeners.size).toBe(1);
        await act(async () => { mq.change(false); });
        expect(seen.at(-1)).toBe(false);
        await act(async () => { mq.change(true); });
        expect(seen.at(-1)).toBe(true);
        await act(async () => view!.unmount());
        view = undefined;
        expect(mq.state.listeners.size).toBe(0);
    });

    it('只有舊版 addListener／removeListener 時仍可訂閱與解除', async () => {
        const mq = fakeMql(false, true);
        await act(async () => { view = create(createElement(Probe, { query: Q })); });
        expect(seen.at(-1)).toBe(false);
        await act(async () => { mq.change(true); });
        expect(seen.at(-1)).toBe(true);
        await act(async () => view!.unmount());
        view = undefined;
        expect(mq.state.listeners.size).toBe(0);
    });
});
