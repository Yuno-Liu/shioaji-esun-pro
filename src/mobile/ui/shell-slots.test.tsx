// ShellSlot（設計規格 §6.6）：沒有 provider（'inline'）時原地渲染、testId 不變；provider 已存在但目標節點尚未掛上時不渲染。
// （portal 到真實節點需要 react-dom，由殼層整合與實機驗證。）
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellSlot, ShellSlotsContext } from './shell-slots';

let view: ReactTestRenderer | undefined;
const child = () => createElement('div', { 'data-testid': 'trade-bar' }, '買進');
const count = () => view!.root.findAll(n => n.props['data-testid'] === 'trade-bar' && typeof n.type === 'string').length;

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('ShellSlot', () => {
    it('沒有 provider：原地渲染', async () => {
        await act(async () => { view = create(createElement(ShellSlot, { slot: 'bottom', children: child() })); });
        expect(count()).toBe(1);
    });

    it("provider 為 'inline'：原地渲染", async () => {
        await act(async () => {
            view = create(createElement(ShellSlotsContext.Provider, { value: 'inline' }, createElement(ShellSlot, { slot: 'top', children: child() })));
        });
        expect(count()).toBe(1);
    });

    it('目標節點尚未掛上（null）：該幀不渲染', async () => {
        await act(async () => {
            view = create(createElement(ShellSlotsContext.Provider, { value: { top: null, bottom: null } }, createElement(ShellSlot, { slot: 'bottom', children: child() })));
        });
        expect(count()).toBe(0);
    });
});
