// 系統偏好：減少動態（matchMedia＋change 監聽、沒有 matchMedia 為 false）、降低透明度（html 屬性優先、其次系統查詢）
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion, subscribeReducedMotion, transparencyReduced, useReducedMotion } from './prefs';

function media(initial: Record<string, boolean>, legacy = false) {
    const state = { ...initial };
    const cbs = new Set<() => void>();
    const mql = (q: string) => {
        const base = {
            get matches() { return !!state[q]; },
            ...(legacy
                ? { addListener: vi.fn((cb: () => void) => cbs.add(cb)), removeListener: vi.fn((cb: () => void) => cbs.delete(cb)) }
                : {
                    addEventListener: vi.fn((_t: string, cb: () => void) => cbs.add(cb)),
                    removeEventListener: vi.fn((_t: string, cb: () => void) => cbs.delete(cb)),
                }),
        };
        return base;
    };
    return {
        mql,
        set(q: string, v: boolean) { state[q] = v; cbs.forEach(cb => cb()); },
        count: () => cbs.size,
    };
}
const RM = '(prefers-reduced-motion: reduce)';
const RT = '(prefers-reduced-transparency: reduce)';

afterEach(() => vi.unstubAllGlobals());

describe('減少動態', () => {
    it('沒有 matchMedia 時為 false，subscribe 回傳可呼叫的解除函式', () => {
        expect(prefersReducedMotion()).toBe(false);
        const off = subscribeReducedMotion(() => undefined);
        expect(() => off()).not.toThrow();
    });

    it('matchMedia 結果與 change 監聽（addEventListener）', () => {
        const m = media({ [RM]: true });
        vi.stubGlobal('matchMedia', m.mql);
        expect(prefersReducedMotion()).toBe(true);
        const cb = vi.fn();
        const off = subscribeReducedMotion(cb);
        m.set(RM, false);
        expect(cb).toHaveBeenCalledOnce();
        expect(prefersReducedMotion()).toBe(false);
        off();
        expect(m.count()).toBe(0);
    });

    it('舊式 addListener 後備', () => {
        const m = media({}, true);
        vi.stubGlobal('matchMedia', m.mql);
        const cb = vi.fn();
        const off = subscribeReducedMotion(cb);
        m.set(RM, true);
        expect(cb).toHaveBeenCalledOnce();
        off();
        expect(m.count()).toBe(0);
    });

    it('matchMedia 丟例外時為 false', () => {
        vi.stubGlobal('matchMedia', () => { throw new Error('nope'); });
        expect(prefersReducedMotion()).toBe(false);
    });

    describe('useReducedMotion', () => {
        let view: ReactTestRenderer | undefined;
        beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
        afterEach(async () => {
            await act(async () => view?.unmount());
            view = undefined;
        });

        it('系統設定改變時重新 render', async () => {
            const m = media({ [RM]: false });
            vi.stubGlobal('matchMedia', m.mql);
            const Probe = () => createElement('span', null, useReducedMotion() ? 'reduce' : 'full');
            await act(async () => { view = create(createElement(Probe)); });
            expect(view!.toJSON()).toMatchObject({ children: ['full'] });
            await act(async () => { m.set(RM, true); });
            expect(view!.toJSON()).toMatchObject({ children: ['reduce'] });
        });
    });
});

describe('降低透明度', () => {
    const html = (attr: string | null) => vi.stubGlobal('document', { documentElement: { getAttribute: (n: string) => (n === 'data-sj-transparency' ? attr : null) } });

    it('html 屬性 reduced → true（即使系統未要求）', () => {
        html('reduced');
        vi.stubGlobal('matchMedia', media({ [RT]: false }).mql);
        expect(transparencyReduced()).toBe(true);
    });

    it('html 屬性 full → false（即使系統要求降低）', () => {
        html('full');
        vi.stubGlobal('matchMedia', media({ [RT]: true }).mql);
        expect(transparencyReduced()).toBe(false);
    });

    it('屬性不存在或 system → 跟系統查詢', () => {
        for (const attr of [null, 'system']) {
            html(attr);
            vi.stubGlobal('matchMedia', media({ [RT]: true }).mql);
            expect(transparencyReduced()).toBe(true);
            vi.stubGlobal('matchMedia', media({ [RT]: false }).mql);
            expect(transparencyReduced()).toBe(false);
        }
    });

    it('沒有 document／matchMedia 時為 false', () => {
        expect(transparencyReduced()).toBe(false);
    });
});
