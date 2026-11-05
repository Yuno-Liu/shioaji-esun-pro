// src/mobile/hooks/use-html-attributes.ts — 在 <html> 寫入手機介面屬性（設計規格 §6.6、§4.7、§9）
//
// - data-sj-font-scale：useThemeSettings().fontScale（1／1.15／1.3）；字級「大」的版面切換以
//   html[data-sj-font-scale="1.3"] 撰寫（不用容器查詢、:has()）。
// - data-sj-transparency：ui-settings 的 transparency 為 reduced／full 時寫入；system 時移除（跟系統
//   prefers-reduced-transparency；iOS Safari 不支援該查詢，只能靠 App 內開關）。
// - 沒有 document（測試、SSR）時不做事；卸載時移除兩個屬性。

import { useLayoutEffect } from 'react';
import { useThemeSettings } from '../../lib/theme-store';
import { useMobileUiSettings } from '../lib/ui-settings';
import { TRANSPARENCY_ATTR } from '../motion/prefs';

export const FONT_SCALE_ATTR = 'data-sj-font-scale';

type AttrTarget = Pick<Element, 'setAttribute' | 'removeAttribute'>;

function htmlElement(): AttrTarget | null {
    if (typeof document === 'undefined') return null;
    const el = document.documentElement as AttrTarget | null | undefined;
    return el && typeof el.setAttribute === 'function' && typeof el.removeAttribute === 'function' ? el : null;
}

/** 純函式：依設定寫入／移除屬性（便於測試） */
export function applyHtmlAttributes(el: AttrTarget, fontScale: number, transparency: 'system' | 'reduced' | 'full'): void {
    el.setAttribute(FONT_SCALE_ATTR, String(fontScale));
    if (transparency === 'system') el.removeAttribute(TRANSPARENCY_ATTR);
    else el.setAttribute(TRANSPARENCY_ATTR, transparency);
}

export function useHtmlAttributes(): void {
    const { fontScale } = useThemeSettings();
    const { transparency } = useMobileUiSettings();

    // layout effect：在第一次繪製前寫入，字級「大」的版面不閃一幀
    useLayoutEffect(() => {
        const el = htmlElement();
        if (el) applyHtmlAttributes(el, fontScale, transparency);
    }, [fontScale, transparency]);

    useLayoutEffect(() => () => {
        const el = htmlElement();
        el?.removeAttribute(FONT_SCALE_ATTR);
        el?.removeAttribute(TRANSPARENCY_ATTR);
    }, []);
}
