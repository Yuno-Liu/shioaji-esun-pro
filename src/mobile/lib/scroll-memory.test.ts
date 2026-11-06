// 捲動記憶（設計規格 §6.6）：pending 期間不記錄（切頁後內容變短所觸發的 scroll 不可覆寫上一頁）、
// 同一次提交已還原則不再標記 pending、Suspense 載入中先標記 pending 再由 ScrollRestorer 還原、
// rAF 合併並以事件當下的路由記錄、上限淘汰最久未用。
import { createElement, Suspense, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    attachScrollRecorder,
    createScrollMemory,
    ScrollRestorer,
    useScrollNavigation,
    type ScrollMemory,
    type ScrollTarget,
} from './scroll-memory';

class FakeScroller implements ScrollTarget {
    scrollTop = 0;
    private listeners = new Set<() => void>();
    addEventListener = vi.fn((_type: 'scroll', cb: () => void) => { this.listeners.add(cb); });
    removeEventListener = vi.fn((_type: 'scroll', cb: () => void) => { this.listeners.delete(cb); });
    scroll(top: number) {
        this.scrollTop = top;
        this.listeners.forEach(l => l());
    }
    get listenerCount() { return this.listeners.size; }
}

describe('createScrollMemory', () => {
    it('restore：沒有紀錄回 0、有紀錄回原位，並設為目前路由、清除 pending', () => {
        const mem = createScrollMemory();
        const el = new FakeScroller();
        el.scrollTop = 300;
        mem.restore('#/watchlist', el);
        expect(el.scrollTop).toBe(0);
        expect(mem.activeKey).toBe('#/watchlist');
        expect(mem.record('#/watchlist', 420)).toBe(true);
        mem.beginNavigation('#/orders');
        expect(mem.pending).toBe('#/orders');
        mem.restore('#/orders', el);
        expect(mem.pending).toBeNull();
        expect(el.scrollTop).toBe(0);
        mem.restore('#/watchlist', el);
        expect(el.scrollTop).toBe(420);
    });

    it('pending 期間不記錄；只記錄目前已還原的路由', () => {
        const mem = createScrollMemory();
        mem.restore('#/watchlist', null);
        mem.record('#/watchlist', 500);
        mem.beginNavigation('#/orders');
        // 切頁後內容變短，瀏覽器把 scrollTop 夾到 0：不可覆寫自選的 500
        expect(mem.record('#/watchlist', 0)).toBe(false);
        expect(mem.record('#/orders', 0)).toBe(false);
        expect(mem.get('#/watchlist')).toBe(500);
        mem.restore('#/orders', null);
        expect(mem.record('#/watchlist', 0)).toBe(false);
        expect(mem.record('#/orders', 80)).toBe(true);
        expect(mem.get('#/orders')).toBe(80);
    });

    it('beginNavigation：同一次提交已還原同一路由時不標記 pending；導回目前路由時清除 pending', () => {
        const mem = createScrollMemory();
        mem.restore('#/trade/2330', null);
        mem.beginNavigation('#/trade/2330');
        expect(mem.pending).toBeNull();
        mem.beginNavigation('#/orders');
        expect(mem.pending).toBe('#/orders');
        mem.beginNavigation('#/trade/2330');
        expect(mem.pending).toBeNull();
    });

    it('交易頁依代碼分開記憶；忽略負值與非數字', () => {
        const mem = createScrollMemory();
        mem.restore('#/trade/2330', null);
        mem.record('#/trade/2330', 120);
        mem.restore('#/trade/2317', null);
        expect(mem.record('#/trade/2317', -5)).toBe(false);
        expect(mem.record('#/trade/2317', Number.NaN)).toBe(false);
        mem.record('#/trade/2317', 40);
        expect(mem.get('#/trade/2330')).toBe(120);
        expect(mem.get('#/trade/2317')).toBe(40);
    });

    it('超過上限時淘汰最久未用的路由', () => {
        const mem = createScrollMemory(2);
        for (const key of ['#/a', '#/b', '#/c']) {
            mem.restore(key, null);
            mem.record(key, 10);
        }
        expect(mem.get('#/a')).toBeUndefined();
        expect(mem.get('#/b')).toBe(10);
        expect(mem.get('#/c')).toBe(10);
    });
});

describe('attachScrollRecorder', () => {
    let frames: (() => void)[];
    beforeEach(() => {
        frames = [];
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });
    afterEach(() => { vi.unstubAllGlobals(); });
    const flushFrames = () => { const list = frames; frames = []; list.forEach(f => f()); };

    it('被動監聽、rAF 合併：一幀內多次 scroll 只記錄最後位置', () => {
        const mem = createScrollMemory();
        const el = new FakeScroller();
        mem.restore('#/watchlist', el);
        const detach = attachScrollRecorder(el, mem);
        expect(el.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
        el.scroll(10);
        el.scroll(20);
        el.scroll(35);
        expect(frames).toHaveLength(1);
        flushFrames();
        expect(mem.get('#/watchlist')).toBe(35);
        detach();
        expect(el.listenerCount).toBe(0);
    });

    it('事件後才切頁：該幀放棄，不把新頁位置記到舊路由', () => {
        const mem = createScrollMemory();
        const el = new FakeScroller();
        mem.restore('#/watchlist', el);
        attachScrollRecorder(el, mem);
        el.scroll(200);
        flushFrames();
        el.scroll(260);
        mem.beginNavigation('#/orders');
        mem.restore('#/orders', el);
        flushFrames();
        expect(mem.get('#/watchlist')).toBe(200);
        expect(mem.get('#/orders')).toBeUndefined();
    });

    it('pending 期間的 scroll 不排程記錄', () => {
        const mem = createScrollMemory();
        const el = new FakeScroller();
        mem.restore('#/watchlist', el);
        attachScrollRecorder(el, mem);
        mem.beginNavigation('#/orders');
        el.scroll(0);
        expect(frames).toHaveLength(0);
    });

    it('沒有真實節點時不做事', () => {
        expect(() => attachScrollRecorder(null, createScrollMemory())()).not.toThrow();
    });
});

describe('ScrollRestorer＋useScrollNavigation（layout effect 由子到父）', () => {
    let view: ReactTestRenderer | undefined;
    beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
    afterEach(async () => {
        await act(async () => view?.unmount());
        view = undefined;
        vi.unstubAllGlobals();
    });

    function Shell({ memory, routeKey, target, children }: { memory: ScrollMemory; routeKey: string; target: ScrollTarget; children?: ReactNode }) {
        useScrollNavigation(memory, routeKey);
        return createElement(Suspense, { fallback: null }, children, createElement(ScrollRestorer, { routeKey, memory, getTarget: () => target }));
    }

    it('頁面已載入（同一次提交）：還原位置且不殘留 pending', async () => {
        const mem = createScrollMemory();
        const el = new FakeScroller();
        await act(async () => { view = create(createElement(Shell, { memory: mem, routeKey: '#/watchlist', target: el })); });
        expect(mem.activeKey).toBe('#/watchlist');
        expect(mem.pending).toBeNull();
        mem.record('#/watchlist', 640);
        el.scrollTop = 640;
        await act(async () => { view!.update(createElement(Shell, { memory: mem, routeKey: '#/orders', target: el })); });
        expect(mem.pending).toBeNull();
        expect(el.scrollTop).toBe(0);
        await act(async () => { view!.update(createElement(Shell, { memory: mem, routeKey: '#/watchlist', target: el })); });
        expect(el.scrollTop).toBe(640);
        expect(mem.pending).toBeNull();
    });

    it('頁面載入中（Suspense fallback）：先標記 pending、不還原；載入完成才還原並清除 pending', async () => {
        const mem = createScrollMemory();
        const el = new FakeScroller();
        await act(async () => { view = create(createElement(Shell, { memory: mem, routeKey: '#/watchlist', target: el })); });
        mem.record('#/watchlist', 300);

        let resolve!: () => void;
        const gate = new Promise<void>(r => { resolve = r; });
        let ready = false;
        function SlowPage() {
            if (!ready) throw gate;
            return null;
        }
        await act(async () => { view!.update(createElement(Shell, { memory: mem, routeKey: '#/orders', target: el }, createElement(SlowPage))); });
        expect(mem.pending).toBe('#/orders');
        // 載入中：fallback 讓內容變短觸發的 scroll 不覆寫自選
        expect(mem.record('#/watchlist', 0)).toBe(false);
        expect(mem.get('#/watchlist')).toBe(300);

        await act(async () => { ready = true; resolve(); await gate; });
        expect(mem.pending).toBeNull();
        expect(mem.activeKey).toBe('#/orders');
    });
});
