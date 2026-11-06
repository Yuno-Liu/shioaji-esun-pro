// 延遲載入模組的錯誤邊界（F2／M-PLAT-1）：載入失敗只換掉該區塊、邊界外的元件不卸載；
// ［重試］會真的再 import（React.lazy 本身會快取失敗）；重試仍失敗時多出［重新整理頁面］；resetKey 改變清除錯誤
import { createElement, Suspense, useEffect, useState, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODULE_LOAD_ERROR_TEXT, ModuleErrorBoundary, ModuleLoadError, retryableLazy } from './route-error-boundary';

let view: ReactTestRenderer | undefined;

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const byTestId = (id: string) => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === id);
const out = () => JSON.stringify(view!.toJSON());

function Loaded({ label }: { label: string }) {
    return createElement('p', { 'data-testid': 'loaded' }, label);
}

/** 可控制的 chunk 載入：fail=true 時 reject（模擬網路中斷／舊 chunk 404） */
function controllableLoader() {
    const state = { fail: true, calls: 0 };
    const load = vi.fn(() => {
        state.calls++;
        return state.fail ? Promise.reject(new TypeError('Failed to fetch dynamically imported module')) : Promise.resolve(Loaded);
    });
    return { state, load };
}

function tree(Lazy: (p: { label: string }) => ReactNode, onRetry: () => void, resetKey?: string) {
    return createElement('div', null,
        createElement('header', { 'data-testid': 'outside' }, '狀態列'),
        createElement(ModuleErrorBoundary, {
            onRetry,
            resetKey,
            fallback: props => createElement(ModuleLoadError, { ...props, testId: 'load-error' }),
        }, createElement(Suspense, { fallback: createElement('p', null, '載入中') }, createElement(Lazy, { label: 'OK' }))),
    );
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // React 會以 console.error 回報被錯誤邊界接住的錯誤；測試刻意製造失敗，不輸出雜訊
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('retryableLazy + ModuleErrorBoundary', () => {
    it('a failed chunk only replaces its own block; components outside the boundary stay mounted', async () => {
        const { load } = controllableLoader();
        const Lazy = retryableLazy(load);
        await act(async () => { view = create(tree(Lazy, () => Lazy.reset())); });
        await flush();
        expect(out()).toContain(MODULE_LOAD_ERROR_TEXT);
        expect(byTestId('load-error')).toHaveLength(1);
        expect(byTestId('load-error')[0]!.props.role).toBe('alert');
        expect(byTestId('outside')).toHaveLength(1);
        // 第一次失敗時還沒有重試過：只有［重試］，沒有［重新整理頁面］
        expect(byTestId('load-error-retry')).toHaveLength(1);
        expect(byTestId('load-error-reload')).toHaveLength(0);
    });

    it('［重試］ re-imports the module (React.lazy alone would rethrow the cached failure) and renders it', async () => {
        const { state, load } = controllableLoader();
        const Lazy = retryableLazy(load);
        await act(async () => { view = create(tree(Lazy, () => Lazy.reset())); });
        await flush();
        const callsAfterFailure = state.calls;
        state.fail = false;
        await act(async () => { byTestId('load-error-retry')[0]!.props.onClick(); });
        await flush();
        expect(state.calls).toBe(callsAfterFailure + 1);
        expect(byTestId('loaded')).toHaveLength(1);
        expect(out()).not.toContain(MODULE_LOAD_ERROR_TEXT);
        expect(byTestId('outside')).toHaveLength(1);
    });

    it('when the retry fails again, offers 重新整理頁面 (browsers may keep failed module fetches) which reloads only on tap', async () => {
        const reload = vi.fn();
        vi.stubGlobal('location', { reload });
        const { state, load } = controllableLoader();
        const Lazy = retryableLazy(load);
        await act(async () => { view = create(tree(Lazy, () => Lazy.reset())); });
        await flush();
        await act(async () => { byTestId('load-error-retry')[0]!.props.onClick(); });
        await flush();
        expect(state.calls).toBeGreaterThanOrEqual(2);
        expect(byTestId('load-error-reload')).toHaveLength(1);
        expect(reload).not.toHaveBeenCalled();
        await act(async () => { byTestId('load-error-reload')[0]!.props.onClick(); });
        expect(reload).toHaveBeenCalledOnce();
    });

    it('reset() is a no-op unless the last load failed (prefetch/in-flight loads are not restarted)', async () => {
        const { state, load } = controllableLoader();
        state.fail = false;
        const Lazy = retryableLazy(load);
        expect(Lazy.reset()).toBe(false);
        await act(async () => { view = create(tree(Lazy, () => Lazy.reset())); });
        await flush();
        expect(byTestId('loaded')).toHaveLength(1);
        expect(Lazy.reset()).toBe(false);
        expect(state.calls).toBe(1);
    });

    it('a resetKey change (switching tabs) clears the error state', async () => {
        const { load } = controllableLoader();
        const Failing = retryableLazy(load);
        const Fine = retryableLazy(() => Promise.resolve(Loaded));
        await act(async () => { view = create(tree(Failing, () => Failing.reset(), 'orders')); });
        await flush();
        expect(byTestId('load-error')).toHaveLength(1);
        await act(async () => { view!.update(tree(Fine, () => undefined, 'positions')); });
        await flush();
        expect(byTestId('load-error')).toHaveLength(0);
        expect(byTestId('loaded')).toHaveLength(1);
    });
});

describe('retryableLazy.preload（稽核 P3）', () => {
    /** 以計數的 fallback 判斷是否 suspend 過 */
    function countingTree(Lazy: (p: { label: string }) => ReactNode, fallbacks: { n: number }, onRetry: () => void = () => undefined) {
        function Fallback() {
            fallbacks.n += 1;
            return createElement('p', null, '載入中');
        }
        return createElement(ModuleErrorBoundary, {
            onRetry,
            fallback: props => createElement(ModuleLoadError, { ...props, testId: 'load-error' }),
        }, createElement(Suspense, { fallback: createElement(Fallback) }, createElement(Lazy, { label: 'OK' })));
    }

    it('預載完成後第一次渲染直接顯示內容、不出現 fallback，也不再呼叫 load()', async () => {
        const load = vi.fn(() => Promise.resolve(Loaded));
        const Lazy = retryableLazy(load);
        await Lazy.preload();
        expect(load).toHaveBeenCalledTimes(1);
        const fallbacks = { n: 0 };
        await act(async () => { view = create(countingTree(Lazy, fallbacks)); });
        expect(fallbacks.n).toBe(0);
        expect(byTestId('loaded')).toHaveLength(1);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('對照：沒有預載時第一次渲染會 suspend（顯示 fallback）', async () => {
        const Lazy = retryableLazy(() => Promise.resolve(Loaded));
        const fallbacks = { n: 0 };
        await act(async () => { view = create(countingTree(Lazy, fallbacks)); });
        await flush();
        expect(fallbacks.n).toBeGreaterThan(0);
        expect(byTestId('loaded')).toHaveLength(1);
    });

    it('preload 冪等：載入中重複呼叫共用同一次 load()；已載入後不再呼叫', async () => {
        let resolve!: (c: typeof Loaded) => void;
        const load = vi.fn(() => new Promise<typeof Loaded>(r => { resolve = r; }));
        const Lazy = retryableLazy(load);
        const a = Lazy.preload();
        const b = Lazy.preload();
        expect(load).toHaveBeenCalledTimes(1);
        resolve(Loaded);
        await Promise.all([a, b]);
        await Lazy.preload();
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('預載失敗：promise 仍 resolve、不標記失敗（reset() 為 false）；之後的 lazy 自己 import 並正常顯示', async () => {
        const { state, load } = controllableLoader();
        const Lazy = retryableLazy(load);
        await expect(Lazy.preload()).resolves.toBeUndefined();
        expect(state.calls).toBe(1);
        expect(Lazy.reset()).toBe(false);
        state.fail = false;
        await act(async () => { view = create(tree(Lazy, () => Lazy.reset())); });
        await flush();
        expect(state.calls).toBe(2);
        expect(byTestId('loaded')).toHaveLength(1);
        expect(byTestId('load-error')).toHaveLength(0);
    });

    it('預載失敗後 lazy 也失敗：［重試］語意不變（reset 換新的 lazy 重新 import）', async () => {
        const { state, load } = controllableLoader();
        const Lazy = retryableLazy(load);
        await Lazy.preload();
        await act(async () => { view = create(tree(Lazy, () => Lazy.reset())); });
        await flush();
        expect(byTestId('load-error')).toHaveLength(1);
        const calls = state.calls;
        state.fail = false;
        await act(async () => { byTestId('load-error-retry')[0]!.props.onClick(); });
        await flush();
        expect(state.calls).toBe(calls + 1);
        expect(byTestId('loaded')).toHaveLength(1);
    });

    it('預載失敗後可再預載；成功後新掛載的實例直接渲染', async () => {
        const { state, load } = controllableLoader();
        const Lazy = retryableLazy(load);
        await Lazy.preload();
        state.fail = false;
        await Lazy.preload();
        expect(state.calls).toBe(2);
        const fallbacks = { n: 0 };
        await act(async () => { view = create(countingTree(Lazy, fallbacks)); });
        expect(fallbacks.n).toBe(0);
        expect(byTestId('loaded')).toHaveLength(1);
    });

    it('已用 lazy 掛上的實例：之後 resolve 不換元件型別、不重新掛載（狀態保留）', async () => {
        let mounts = 0;
        function Stateful({ label }: { label: string }) {
            const [n, setN] = useState(0);
            useEffect(() => { mounts += 1; }, []);
            return createElement('button', { 'data-testid': 'stateful', onClick: () => setN(x => x + 1) }, `${label}${n}`);
        }
        let resolveLazy!: (c: typeof Stateful) => void;
        let first = true;
        const load = vi.fn(() => (first
            ? (first = false, new Promise<typeof Stateful>(r => { resolveLazy = r; }))
            : Promise.resolve(Stateful)));
        const Lazy = retryableLazy(load);
        const fallbacks = { n: 0 };
        await act(async () => { view = create(countingTree(Lazy, fallbacks)); });
        expect(fallbacks.n).toBeGreaterThan(0);
        await act(async () => { resolveLazy(Stateful); });
        await flush();
        expect(mounts).toBe(1);
        await act(async () => { byTestId('stateful')[0]!.props.onClick(); });
        // 預載（已 resolve：不呼叫 load）後父層重繪：同一個實例、狀態保留
        await Lazy.preload();
        await act(async () => { view!.update(countingTree(Lazy, fallbacks)); });
        expect(mounts).toBe(1);
        expect(byTestId('stateful')[0]!.children).toEqual(['OK1']);
        expect(load).toHaveBeenCalledTimes(1);
    });
});