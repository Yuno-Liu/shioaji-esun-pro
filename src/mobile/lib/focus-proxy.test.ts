// 代理輸入框（交易頁切換商品：開面板即可打字）：建立、聚焦、轉移焦點、清理；輸入法組字中延後轉移
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPOSITION_WAIT_MS, createFocusProxy, FOCUS_PROXY_ATTR } from './focus-proxy';

interface FakeEl {
    tag: string;
    type: string;
    tabIndex: number;
    style: Record<string, string>;
    attrs: Record<string, string>;
    setAttribute(k: string, v: string): void;
    focus: ReturnType<typeof vi.fn>;
    blur: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    listeners: Map<string, Set<() => void>>;
    addEventListener(type: string, fn: () => void): void;
    removeEventListener(type: string, fn: () => void): void;
}

/** 觸發假節點上的事件（組字） */
function fire(el: FakeEl, type: string) {
    Array.from(el.listeners.get(type) ?? []).forEach(fn => fn());
}
const listenerCount = (el: FakeEl) => Array.from(el.listeners.values()).reduce((n, s) => n + s.size, 0);

function fakeDocument() {
    const children: FakeEl[] = [];
    const doc = {
        activeElement: null as unknown,
        body: { appendChild: (el: FakeEl) => { children.push(el); return el; } },
        createElement: (tag: string) => {
            const el: FakeEl = {
                tag,
                type: '',
                tabIndex: 0,
                style: {},
                attrs: {},
                setAttribute(k, v) { this.attrs[k] = v; },
                focus: vi.fn(() => { doc.activeElement = el; }),
                blur: vi.fn(() => { if (doc.activeElement === el) doc.activeElement = null; }),
                remove: vi.fn(() => { const i = children.indexOf(el); if (i >= 0) children.splice(i, 1); }),
                listeners: new Map(),
                addEventListener(type, fn) {
                    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
                    this.listeners.get(type)!.add(fn);
                },
                removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); },
            };
            return el;
        },
    };
    return { doc, children };
}

const target = (doc: { activeElement: unknown }) => {
    const t = { focus: vi.fn(() => { doc.activeElement = t; }) };
    return t;
};

describe('createFocusProxy', () => {
    it('沒有 document（測試、SSR）時回傳 null', () => {
        expect(createFocusProxy(undefined)).toBeNull();
        expect(createFocusProxy({ createElement: undefined, body: null, activeElement: null } as never)).toBeNull();
    });

    it('engage：在 body 末端建立看不見的 input 並聚焦（fixed top 0、opacity 0、16px、aria-hidden、tabIndex -1）', () => {
        const { doc, children } = fakeDocument();
        const proxy = createFocusProxy(doc as never)!;
        expect(children).toHaveLength(0); // 建立時還不碰 DOM
        proxy.engage();
        expect(children).toHaveLength(1);
        const el = children[0]!;
        expect(el.tag).toBe('input');
        expect(el.tabIndex).toBe(-1);
        expect(el.attrs['aria-hidden']).toBe('true');
        expect(el.attrs[FOCUS_PROXY_ATTR]).toBe('');
        expect(el.style).toMatchObject({ position: 'fixed', top: '0', opacity: '0', fontSize: '16px', pointerEvents: 'none' });
        expect(el.focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(doc.activeElement).toBe(el);
        proxy.engage(); // 重複呼叫不再建立
        expect(children).toHaveLength(1);
    });

    it('release(target)：暫時 input 仍持有焦點時把焦點移到 target，並移除暫時 input', () => {
        const { doc, children } = fakeDocument();
        const proxy = createFocusProxy(doc as never)!;
        proxy.engage();
        const t = target(doc);
        proxy.release(t);
        expect(t.focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(doc.activeElement).toBe(t);
        expect(children).toHaveLength(0);
        proxy.release(t); // 冪等
        expect(t.focus).toHaveBeenCalledTimes(1);
    });

    it('release 回傳轉移前已打進暫時 input 的文字（之後再 release 為空字串）', () => {
        const { doc, children } = fakeDocument();
        const proxy = createFocusProxy(doc as never)!;
        proxy.engage();
        (children[0] as unknown as { value: string }).value = '台積';
        expect(proxy.release(target(doc))).toBe('台積');
        expect(proxy.release(target(doc))).toBe('');
        const p2 = createFocusProxy(doc as never)!;
        expect(p2.release()).toBe(''); // 沒 engage 過
    });

    it('release()（關閉、卸載）：暫時 input 失焦並移除，不留節點', () => {
        const { doc, children } = fakeDocument();
        const proxy = createFocusProxy(doc as never)!;
        proxy.engage();
        const el = children[0]!;
        proxy.release();
        expect(el.blur).toHaveBeenCalled();
        expect(el.remove).toHaveBeenCalled();
        expect(children).toHaveLength(0);
        expect(doc.activeElement).toBeNull();
        proxy.engage(); // release 之後不再建立
        expect(children).toHaveLength(0);
    });

    it('使用者已把焦點移到別處：release(target) 不搶焦點，只移除暫時 input', () => {
        const { doc, children } = fakeDocument();
        const proxy = createFocusProxy(doc as never)!;
        proxy.engage();
        const other = {};
        doc.activeElement = other;
        const t = target(doc);
        proxy.release(t);
        expect(t.focus).not.toHaveBeenCalled();
        expect(doc.activeElement).toBe(other);
        expect(children).toHaveLength(0);
    });

    it('還沒 engage 就已就緒（同一個手勢內）：release(target) 直接聚焦 target，之後 engage 無作用', () => {
        const { doc, children } = fakeDocument();
        const proxy = createFocusProxy(doc as never)!;
        const t = target(doc);
        proxy.release(t);
        expect(t.focus).toHaveBeenCalledTimes(1);
        proxy.engage();
        expect(children).toHaveLength(0);
        expect(doc.activeElement).toBe(t);
    });
});

describe('createFocusProxy 輸入法組字', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
    afterEach(() => { vi.useRealTimers(); });

    function composing() {
        const { doc, children } = fakeDocument();
        const proxy = createFocusProxy(doc as never)!;
        proxy.engage();
        const el = children[0]!;
        const value = (v: string) => { (el as unknown as { value: string }).value = v; };
        fire(el, 'compositionstart');
        value('ㄊㄞˊ');
        return { doc, children, proxy, el, value };
    }

    it('engage 時在暫時 input 監聽 compositionstart／compositionend', () => {
        const { el } = composing();
        expect(el.listeners.get('compositionstart')?.size).toBe(1);
        expect(el.listeners.get('compositionend')?.size).toBe(1);
    });

    it('組字中 release(target)：回傳 null、不轉移；compositionend 後轉移並以 onDeferred 帶入確定的文字，清掉監聽與節點', () => {
        const { doc, children, proxy, el, value } = composing();
        const t = target(doc);
        const late = vi.fn();
        expect(proxy.release(t)).toBeNull();
        proxy.onDeferred!(late);
        expect(t.focus).not.toHaveBeenCalled();
        expect(doc.activeElement).toBe(el);
        expect(children).toHaveLength(1);
        value('台');
        fire(el, 'compositionend');
        expect(t.focus).not.toHaveBeenCalled(); // 等下一個 task 再讀值（WebKit 的 compositionend 可能先於最後一次 input）
        vi.advanceTimersByTime(0);
        expect(t.focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(doc.activeElement).toBe(t);
        expect(late).toHaveBeenCalledTimes(1);
        expect(late).toHaveBeenCalledWith('台');
        expect(children).toHaveLength(0);
        expect(listenerCount(el)).toBe(0);
        vi.advanceTimersByTime(COMPOSITION_WAIT_MS * 2);
        expect(late).toHaveBeenCalledTimes(1);
        expect(t.focus).toHaveBeenCalledTimes(1);
    });

    it('逾時（COMPOSITION_WAIT_MS）仍在組字：只轉移焦點、不帶標記文字', () => {
        const { doc, children, proxy, el } = composing();
        const t = target(doc);
        const late = vi.fn();
        expect(proxy.release(t)).toBeNull();
        proxy.onDeferred!(late);
        vi.advanceTimersByTime(COMPOSITION_WAIT_MS - 1);
        expect(t.focus).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(t.focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(late).toHaveBeenCalledWith('');
        expect(children).toHaveLength(0);
        expect(listenerCount(el)).toBe(0);
    });

    it('延後中 release()（關閉、卸載）：取消，不轉移、不回報；監聽與節點移除', () => {
        const { doc, children, proxy, el } = composing();
        const t = target(doc);
        const late = vi.fn();
        expect(proxy.release(t)).toBeNull();
        proxy.onDeferred!(late);
        expect(proxy.release()).toBe('');
        expect(el.blur).toHaveBeenCalled();
        expect(children).toHaveLength(0);
        expect(listenerCount(el)).toBe(0);
        fire(el, 'compositionend');
        vi.advanceTimersByTime(COMPOSITION_WAIT_MS * 2);
        expect(t.focus).not.toHaveBeenCalled();
        expect(late).not.toHaveBeenCalled();
    });

    it('組字中直接 release()（沒有 target）：立即移除，不回傳標記文字', () => {
        const { children, proxy, el } = composing();
        expect(proxy.release()).toBe('');
        expect(children).toHaveLength(0);
        expect(listenerCount(el)).toBe(0);
    });

    it('組字已結束才 release：照常同步轉移並回傳文字', () => {
        const { doc, proxy, el, value } = composing();
        value('台積');
        fire(el, 'compositionend');
        const t = target(doc);
        expect(proxy.release(t)).toBe('台積');
        expect(t.focus).toHaveBeenCalledTimes(1);
        expect(listenerCount(el)).toBe(0);
    });

    it('release 先於 engage：之後 engage 不建立節點也不留監聽', () => {
        const { doc, children } = fakeDocument();
        const proxy = createFocusProxy(doc as never)!;
        proxy.release();
        proxy.engage();
        expect(children).toHaveLength(0);
        proxy.onDeferred!(vi.fn()); // 沒有延後中的轉移：無作用
    });
});
