// <html> 屬性（設計規格 §6.6）：data-sj-font-scale 跟隨字級；data-sj-transparency 在 reduced／full 時寫入、system 時移除；
// 沒有 document 時不做事；卸載時移除。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ fontScale: 1 as number, transparency: 'system' as 'system' | 'reduced' | 'full' }));
vi.mock('../../lib/theme-store', () => ({ useThemeSettings: () => ({ mode: 'dark', convention: 'tw', fontScale: m.fontScale }) }));
vi.mock('../lib/ui-settings', () => ({ useMobileUiSettings: () => ({ transparency: m.transparency, uiHaptics: true }) }));

import { applyHtmlAttributes, FONT_SCALE_ATTR, useHtmlAttributes } from './use-html-attributes';

class FakeHtml {
    attrs = new Map<string, string>();
    setAttribute = (k: string, v: string) => { this.attrs.set(k, v); };
    removeAttribute = (k: string) => { this.attrs.delete(k); };
}

function Probe() {
    useHtmlAttributes();
    return null;
}

let view: ReactTestRenderer | undefined;
let html: FakeHtml;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    html = new FakeHtml();
    m.fontScale = 1;
    m.transparency = 'system';
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('applyHtmlAttributes', () => {
    it('寫入字級；transparency system 移除、reduced／full 寫入', () => {
        applyHtmlAttributes(html as unknown as Element, 1.3, 'reduced');
        expect(html.attrs.get(FONT_SCALE_ATTR)).toBe('1.3');
        expect(html.attrs.get('data-sj-transparency')).toBe('reduced');
        applyHtmlAttributes(html as unknown as Element, 1.15, 'full');
        expect(html.attrs.get(FONT_SCALE_ATTR)).toBe('1.15');
        expect(html.attrs.get('data-sj-transparency')).toBe('full');
        applyHtmlAttributes(html as unknown as Element, 1, 'system');
        expect(html.attrs.has('data-sj-transparency')).toBe(false);
    });
});

describe('useHtmlAttributes', () => {
    it('掛載寫入、設定改變更新、卸載移除', async () => {
        vi.stubGlobal('document', { documentElement: html });
        m.transparency = 'reduced';
        await act(async () => { view = create(createElement(Probe)); });
        expect(html.attrs.get(FONT_SCALE_ATTR)).toBe('1');
        expect(html.attrs.get('data-sj-transparency')).toBe('reduced');
        m.fontScale = 1.3;
        m.transparency = 'system';
        await act(async () => { view!.update(createElement(Probe)); });
        expect(html.attrs.get(FONT_SCALE_ATTR)).toBe('1.3');
        expect(html.attrs.has('data-sj-transparency')).toBe(false);
        await act(async () => view!.unmount());
        view = undefined;
        expect(html.attrs.size).toBe(0);
    });

    it('沒有 document 時不丟錯', async () => {
        vi.stubGlobal('document', undefined);
        await act(async () => { view = create(createElement(Probe)); });
        expect(html.attrs.size).toBe(0);
    });
});
