// 面板堆疊：confirm 在上、同層依註冊先後；document capture 監聽只在 depth>0 時存在；
// Esc 只給最上層且可關閉者（不可關閉就關不掉，§10 S5）；Tab 在最上層面板內循環
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSheetStackSnapshot, registerSheet, resetSheetStackForTest, useSheetStack, type SheetStackEntry } from './sheet-stack';

type Listener = (e: KeyboardEvent) => void;

function fakeDocument() {
    const listeners: { type: string; fn: Listener; capture: unknown }[] = [];
    const doc = {
        activeElement: null as unknown,
        addEventListener: vi.fn((type: string, fn: Listener, capture: unknown) => { listeners.push({ type, fn, capture }); }),
        removeEventListener: vi.fn((type: string, fn: Listener, capture: unknown) => {
            const i = listeners.findIndex(l => l.type === type && l.fn === fn && l.capture === capture);
            if (i >= 0) listeners.splice(i, 1);
        }),
        listeners,
        key(key: string, extra: Partial<KeyboardEvent> = {}) {
            const e = { key, shiftKey: false, defaultPrevented: false, isComposing: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
            listeners.filter(l => l.type === 'keydown').forEach(l => l.fn(e as unknown as KeyboardEvent));
            return e;
        },
    };
    return doc;
}

type FakeEl = {
    i: number; disabled?: boolean; hidden?: boolean; inert?: boolean; tabindex?: string | null;
    focus: () => void;
    getAttribute(n: string): string | null;
    closest(s: string): unknown;
    getClientRects(): unknown[];
    compareDocumentPosition(o: { i: number }): number;
};

/** 面板（i=0）與 n 個依文件順序排列的子元素（i=1..n） */
function fakePanel(doc: ReturnType<typeof fakeDocument>, n: number, tweak: (el: FakeEl) => void = () => undefined) {
    const mk = (i: number): FakeEl => {
        const el: FakeEl = {
            i,
            tabindex: null,
            focus: vi.fn(() => { doc.activeElement = el; }),
            getAttribute: (name: string) => (name === 'tabindex' ? el.tabindex ?? null : null),
            closest: () => (el.inert ? {} : null),
            getClientRects: () => (el.hidden ? [] : [{}]),
            // 面板包含所有子元素（CONTAINED_BY|FOLLOWING＝20）；子元素之間依 i 比較
            compareDocumentPosition: (o: { i: number }) => (i === 0 ? 20 : o.i > i ? 4 : 2),
        };
        return el;
    };
    const children = Array.from({ length: n }, (_, k) => mk(k + 1));
    children.forEach(tweak);
    const panel = Object.assign(mk(0), {
        ownerDocument: doc,
        querySelectorAll: () => children,
        contains: (x: unknown) => x === panel || children.includes(x as FakeEl),
    });
    return { panel, children };
}

function entry(over: Partial<SheetStackEntry> = {}): SheetStackEntry & { requestClose: ReturnType<typeof vi.fn> } {
    return { layer: 'sheet', getPanel: () => null, isDismissible: () => true, requestClose: vi.fn(), ...over } as SheetStackEntry & { requestClose: ReturnType<typeof vi.fn> };
}

let doc: ReturnType<typeof fakeDocument>;
beforeEach(() => {
    doc = fakeDocument();
    vi.stubGlobal('document', doc);
    resetSheetStackForTest();
});
afterEach(() => {
    resetSheetStackForTest();
    vi.unstubAllGlobals();
});

describe('排序', () => {
    it('confirm 層永遠在 sheet 層之上；同層依註冊先後', () => {
        const c1 = registerSheet(entry({ layer: 'confirm' }));
        const s1 = registerSheet(entry());
        const s2 = registerSheet(entry());
        const snap = getSheetStackSnapshot();
        expect(snap.depth).toBe(3);
        expect(snap.topId).toBe(c1.id);
        expect([s1.id, s2.id, c1.id].map(id => snap.indexOf(id))).toEqual([0, 1, 2]);
        expect(snap.indexOf(999)).toBe(-1);
    });

    it('重新註冊取得新 id、排到同層最上面；unregister 冪等', () => {
        const a = registerSheet(entry());
        const b = registerSheet(entry());
        a.unregister();
        a.unregister();
        const a2 = registerSheet(entry());
        expect(a2.id).not.toBe(a.id);
        expect(getSheetStackSnapshot().topId).toBe(a2.id);
        expect(getSheetStackSnapshot().indexOf(b.id)).toBe(0);
        expect(getSheetStackSnapshot().depth).toBe(2);
    });

    it('snapshot 在沒有變化時參照不變（useSyncExternalStore 需求）', () => {
        const s = getSheetStackSnapshot();
        expect(getSheetStackSnapshot()).toBe(s);
        registerSheet(entry());
        expect(getSheetStackSnapshot()).not.toBe(s);
    });
});

describe('document 監聽', () => {
    it('depth 0→1 安裝一組 capture keydown，回到 0 移除', () => {
        const a = registerSheet(entry());
        const b = registerSheet(entry());
        expect(doc.addEventListener).toHaveBeenCalledOnce();
        expect(doc.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
        a.unregister();
        expect(doc.removeEventListener).not.toHaveBeenCalled();
        b.unregister();
        expect(doc.removeEventListener).toHaveBeenCalledOnce();
        expect(doc.listeners).toHaveLength(0);
        registerSheet(entry());
        expect(doc.addEventListener).toHaveBeenCalledTimes(2);
    });

    it('沒有 document（node）時註冊仍可用', () => {
        resetSheetStackForTest();
        vi.stubGlobal('document', undefined);
        const a = registerSheet(entry());
        expect(getSheetStackSnapshot().topId).toBe(a.id);
        a.unregister();
        expect(getSheetStackSnapshot().depth).toBe(0);
    });
});

describe('Escape', () => {
    it('只交給最上層（confirm 在上）', () => {
        const lower = entry();
        const top = entry({ layer: 'confirm' });
        registerSheet(top);
        registerSheet(lower);
        const e = doc.key('Escape');
        expect(top.requestClose).toHaveBeenCalledOnce();
        expect(lower.requestClose).not.toHaveBeenCalled();
        expect(e.stopPropagation).not.toHaveBeenCalled(); // 焦點所在元件（滑塊）仍收得到 Escape
    });

    it('最上層不可關閉：誰都不關（不會落到下層）', () => {
        const lower = entry();
        const top = entry({ layer: 'confirm', isDismissible: () => false });
        registerSheet(lower);
        registerSheet(top);
        doc.key('Escape');
        doc.key('Esc');
        expect(top.requestClose).not.toHaveBeenCalled();
        expect(lower.requestClose).not.toHaveBeenCalled();
    });

    it('依「當下」的 isDismissible 判斷', () => {
        let dismissible = false;
        const top = entry({ isDismissible: () => dismissible });
        registerSheet(top);
        doc.key('Escape');
        expect(top.requestClose).not.toHaveBeenCalled();
        dismissible = true;
        doc.key('Escape');
        expect(top.requestClose).toHaveBeenCalledOnce();
    });

    it('IME 組字中、已被處理的事件、解除註冊後都不關閉', () => {
        const top = entry();
        const reg = registerSheet(top);
        doc.key('Escape', { isComposing: true });
        doc.key('Escape', { defaultPrevented: true });
        reg.unregister();
        doc.key('Escape');
        expect(top.requestClose).not.toHaveBeenCalled();
    });
});

describe('Tab 循環', () => {
    it('最後一個往後 → 第一個；第一個往前 → 最後一個；中間交給瀏覽器', () => {
        const { panel, children } = fakePanel(doc, 3);
        registerSheet(entry({ getPanel: () => panel as unknown as HTMLElement }));
        children[2]!.focus();
        let e = doc.key('Tab');
        expect(e.preventDefault).toHaveBeenCalled();
        expect(doc.activeElement).toBe(children[0]);
        e = doc.key('Tab', { shiftKey: true });
        expect(e.preventDefault).toHaveBeenCalled();
        expect(doc.activeElement).toBe(children[2]);
        children[1]!.focus();
        e = doc.key('Tab');
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('焦點在面板外 → 拉回第一個（Shift 則最後一個）', () => {
        const { panel, children } = fakePanel(doc, 2);
        registerSheet(entry({ getPanel: () => panel as unknown as HTMLElement }));
        doc.activeElement = { outside: true };
        doc.key('Tab');
        expect(doc.activeElement).toBe(children[0]);
        doc.activeElement = null;
        doc.key('Tab', { shiftKey: true });
        expect(doc.activeElement).toBe(children[1]);
    });

    it('焦點在面板本身（或 tabIndex=-1 的標題）：Shift+Tab → 最後一個；Tab 交給瀏覽器到第一個', () => {
        const { panel, children } = fakePanel(doc, 2);
        registerSheet(entry({ getPanel: () => panel as unknown as HTMLElement }));
        panel.focus();
        const fwd = doc.key('Tab');
        expect(fwd.preventDefault).not.toHaveBeenCalled();
        const back = doc.key('Tab', { shiftKey: true });
        expect(back.preventDefault).toHaveBeenCalled();
        expect(doc.activeElement).toBe(children[1]);
    });

    it('略過 disabled、tabindex=-1、隱藏、inert 內的元素', () => {
        const { panel, children } = fakePanel(doc, 5, el => {
            if (el.i === 2) el.disabled = true;
            if (el.i === 3) el.tabindex = '-1';
            if (el.i === 4) el.hidden = true;
            if (el.i === 5) el.inert = true;
        });
        registerSheet(entry({ getPanel: () => panel as unknown as HTMLElement }));
        children[0]!.focus();
        const e = doc.key('Tab');
        expect(e.preventDefault).toHaveBeenCalled(); // 唯一可聚焦者也是最後一個
        expect(doc.activeElement).toBe(children[0]);
    });

    it('沒有可聚焦元素 → 焦點留在面板', () => {
        const { panel } = fakePanel(doc, 0);
        registerSheet(entry({ getPanel: () => panel as unknown as HTMLElement }));
        const e = doc.key('Tab');
        expect(e.preventDefault).toHaveBeenCalled();
        expect(doc.activeElement).toBe(panel);
    });

    it('只在最上層循環；getPanel 為 null 時不處理', () => {
        const low = fakePanel(doc, 2);
        registerSheet(entry({ getPanel: () => low.panel as unknown as HTMLElement }));
        registerSheet(entry({ layer: 'confirm', getPanel: () => null }));
        low.children[1]!.focus();
        const e = doc.key('Tab');
        expect(e.preventDefault).not.toHaveBeenCalled();
    });
});

describe('useSheetStack', () => {
    let view: ReactTestRenderer | undefined;
    beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
    afterEach(async () => {
        await act(async () => view?.unmount());
        view = undefined;
    });

    it('註冊與解除時重新 render，提供 depth／topId／indexOf', async () => {
        let latest = getSheetStackSnapshot();
        const Probe = () => { latest = useSheetStack(); return null; };
        await act(async () => { view = create(createElement(Probe)); });
        expect(latest.depth).toBe(0);
        expect(latest.topId).toBeNull();
        let a!: ReturnType<typeof registerSheet>;
        let c!: ReturnType<typeof registerSheet>;
        await act(async () => {
            c = registerSheet(entry({ layer: 'confirm' }));
            a = registerSheet(entry());
        });
        expect(latest.depth).toBe(2);
        expect(latest.topId).toBe(c.id);
        expect(latest.indexOf(a.id)).toBe(0);
        await act(async () => { c.unregister(); });
        expect(latest.topId).toBe(a.id);
    });
});
