// src/mobile/lib/sheet-stack.ts — 面板堆疊：排序、Esc、Tab 循環（設計規格 §5.4、§6.1、§11）
//
// - 排序：confirm 層永遠在 sheet 層之上；同層依註冊先後（重新註冊取得新 id，排到同層最上面）。
// - depth 由 0→1 時在 document 安裝一個 capture 的 keydown 監聽，回到 0 時移除；各面板不再自掛 document keydown。
//   · Escape 只交給最上層，且只在 isDismissible() 為真時呼叫 requestClose()（不可關閉就真的關不掉，§10 S5）；
//     不 stopPropagation（焦點所在元件，例如滑塊，仍會收到 Escape 並自行歸零）。
//   · Tab 在最上層面板內循環（iOS 15.4 沒有 inert，靠這裡把焦點留在面板內）。
// - 面板在 open 變 false 時就應解除註冊（退場動畫期間已不是堆疊的一員，不會收到 Esc／Tab）。

import { useSyncExternalStore } from 'react';

export interface SheetStackEntry {
    layer: 'sheet' | 'confirm';
    getPanel(): HTMLElement | null;
    isDismissible(): boolean;
    requestClose(): void;
}

export interface SheetStackSnapshot {
    /** 已註冊的面板數 */
    depth: number;
    /** 最上層面板 id；沒有面板時 null */
    topId: number | null;
    /** 由下往上的堆疊序（0＝最下層）；未註冊為 -1 */
    indexOf(id: number): number;
}

const LAYER_RANK: Record<SheetStackEntry['layer'], number> = { sheet: 0, confirm: 1 };

let nextId = 1;
const entries = new Map<number, SheetStackEntry>();
let order: readonly number[] = [];
let snapshot: SheetStackSnapshot = makeSnapshot(order);
const listeners = new Set<() => void>();
let installedOn: Document | null = null;

function makeSnapshot(ids: readonly number[]): SheetStackSnapshot {
    return {
        depth: ids.length,
        topId: ids.length > 0 ? ids[ids.length - 1]! : null,
        indexOf: (id: number) => ids.indexOf(id),
    };
}

function rank(id: number): number {
    const e = entries.get(id);
    return e ? LAYER_RANK[e.layer] ?? 0 : 0;
}

function changed(): void {
    order = Array.from(entries.keys()).sort((a, b) => rank(a) - rank(b) || a - b);
    snapshot = makeSnapshot(order);
    syncDocumentListener();
    listeners.forEach(l => l());
}

function topEntry(): SheetStackEntry | null {
    const id = order[order.length - 1];
    return id === undefined ? null : entries.get(id) ?? null;
}

// ---- 鍵盤 ----

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
].join(', ');

/** Node.DOCUMENT_POSITION_FOLLOWING（不引用 Node 全域，node 測試環境沒有） */
const FOLLOWING = 4;

type FocusableLike = HTMLElement & { disabled?: boolean };

function focusables(panel: HTMLElement): FocusableLike[] {
    const list = Array.from(panel.querySelectorAll?.(FOCUSABLE) ?? []) as FocusableLike[];
    return list.filter(el => {
        if (el.disabled) return false;
        if (el.getAttribute?.('tabindex') === '-1') return false;
        if (el.closest?.('[inert], [aria-hidden="true"]')) return false;
        // display:none／未渲染（沒有 getClientRects 的節點視為可見）
        if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
        return true;
    });
}

function focus(el: { focus?: (o?: FocusOptions) => void } | null | undefined): void {
    try {
        el?.focus?.({ preventScroll: true });
    } catch {
        // 忽略
    }
}

function trapTab(e: KeyboardEvent, panel: HTMLElement | null): void {
    if (!panel) return;
    const items = focusables(panel);
    const doc = panel.ownerDocument ?? (typeof document === 'undefined' ? null : document);
    const active = (doc?.activeElement ?? null) as HTMLElement | null;
    if (items.length === 0) {
        e.preventDefault();
        focus(panel);
        return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const inside = !!active && (active === panel || !!panel.contains?.(active));
    if (!inside) {
        e.preventDefault();
        focus(e.shiftKey ? last : first);
        return;
    }
    const idx = items.indexOf(active as FocusableLike);
    if (idx >= 0) {
        if (e.shiftKey && idx === 0) { e.preventDefault(); focus(last); }
        else if (!e.shiftKey && idx === items.length - 1) { e.preventDefault(); focus(first); }
        return;
    }
    // 焦點在面板本身或不可 Tab 的節點（例如 tabIndex=-1 的標題）：看前後是否還有可聚焦元素
    const following = items.filter(el => (active!.compareDocumentPosition?.(el) ?? 0) & FOLLOWING).length;
    if (e.shiftKey && following === items.length) { e.preventDefault(); focus(last); }
    else if (!e.shiftKey && following === 0) { e.preventDefault(); focus(first); }
}

function onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const top = topEntry();
    if (!top) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
        if (e.isComposing) return;
        if (top.isDismissible()) top.requestClose();
        return;
    }
    if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) trapTab(e, top.getPanel());
}

function syncDocumentListener(): void {
    const want = order.length > 0;
    if (want && !installedOn) {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
        document.addEventListener('keydown', onKeyDown, true);
        installedOn = document;
    } else if (!want && installedOn) {
        installedOn.removeEventListener('keydown', onKeyDown, true);
        installedOn = null;
    }
}

// ---- API ----

export function registerSheet(e: SheetStackEntry): { id: number; unregister(): void } {
    const id = nextId++;
    entries.set(id, e);
    changed();
    return {
        id,
        unregister() {
            if (entries.delete(id)) changed();
        },
    };
}

export function subscribeSheetStack(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getSheetStackSnapshot(): SheetStackSnapshot {
    return snapshot;
}

export function useSheetStack(): SheetStackSnapshot {
    return useSyncExternalStore(subscribeSheetStack, getSheetStackSnapshot, getSheetStackSnapshot);
}

/** 測試用：清空堆疊與監聽，移除 document 監聽 */
export function resetSheetStackForTest(): void {
    entries.clear();
    listeners.clear();
    changed();
    nextId = 1;
}
