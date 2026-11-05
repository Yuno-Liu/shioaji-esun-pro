// 面板 context 預設值：沒有 provider 時原地渲染、已開啟且就緒、沒有 footer 目標
import { createElement, useContext } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SheetFooterTargetContext, SheetPresenceContext, SheetRootContext } from './sheet-context';

let view: ReactTestRenderer | undefined;
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('sheet-context 預設值', () => {
    it("SheetRootContext 預設 'inline'；Presence 預設 open／settled；footer 目標 null", async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        let seen: unknown[] = [];
        const Probe = () => {
            const presence = useContext(SheetPresenceContext);
            seen = [useContext(SheetRootContext), presence.phase, presence.settled, presence.shownAt, presence.isExiting(), useContext(SheetFooterTargetContext)];
            return null;
        };
        await act(async () => { view = create(createElement(Probe)); });
        expect(seen).toEqual(['inline', 'open', true, 0, false, null]);
    });
});
