// 搜尋面板（規格 §6.1）：searchProducts(query, 10) 以 debounce 查詢、新輸入取消前一次（signal）、
// 舊結果不覆蓋新結果；加入自選與開交易頁。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ searchProducts: vi.fn() }));
vi.mock('../../lib/product-search', () => ({ searchProducts: m.searchProducts }));

import * as wlStyles from '../styles/watchlist.css';
import { InlineNote } from '../ui/inline-note';
import { BottomSheet } from './bottom-sheet';
import { SEARCH_DEBOUNCE_MS, SEARCH_LIMIT, SearchSheet, type SearchSheetProps } from './search-sheet';

const tsmc = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', detail: '上市' };
const hon = { code: '2317', name: '鴻海', security_type: 'STK', exchange: 'TSE', detail: '上市' };

let view: ReactTestRenderer | undefined;
const onAdd = vi.fn(async () => undefined);
const onOpenTrade = vi.fn();
const onClose = vi.fn();

function props(over: Partial<SearchSheetProps> = {}): SearchSheetProps {
    return { open: true, onClose, watchedCodes: new Set(['2317']), canAdd: true, onAdd, onOpenTrade, ...over };
}
async function render(over: Partial<SearchSheetProps> = {}) {
    await act(async () => { view = create(createElement(SearchSheet, props(over))); });
}
const input = () => view!.root.find(n => n.props['data-testid'] === 'search-input');
async function type(text: string) {
    await act(async () => { input().props.onChange({ target: { value: text } }); });
}
const results = () => view!.root.findAll(n => n.props['data-testid'] === 'search-result');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    m.searchProducts.mockReset();
    onAdd.mockClear();
    onOpenTrade.mockClear();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('SearchSheet', () => {
    it('debounces typing and queries once with limit 10', async () => {
        m.searchProducts.mockResolvedValue([tsmc]);
        await render();
        await type('2');
        await type('23');
        await type('233');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1); });
        expect(m.searchProducts).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(m.searchProducts).toHaveBeenCalledTimes(1);
        expect(m.searchProducts.mock.calls[0]![0]).toBe('233');
        expect(m.searchProducts.mock.calls[0]![1]).toBe(SEARCH_LIMIT);
        expect(results()).toHaveLength(1);
    });

    it('aborts the in-flight query when the input changes; stale results never land', async () => {
        let resolveFirst: (v: unknown) => void = () => undefined;
        m.searchProducts
            .mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }))
            .mockResolvedValueOnce([hon]);
        await render();
        await type('23');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        const firstSignal = (m.searchProducts.mock.calls[0]![2] as { signal: AbortSignal }).signal;
        expect(firstSignal.aborted).toBe(false);
        await type('231');
        expect(firstSignal.aborted).toBe(true);
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        await act(async () => { resolveFirst([tsmc]); });
        expect(results()).toHaveLength(1);
        const text = JSON.stringify(view!.toJSON());
        expect(text).toContain('"2317"');
        expect(text).not.toContain('"2330"');
    });

    it('adds to the watchlist and opens the trade page', async () => {
        m.searchProducts.mockResolvedValue([tsmc, hon]);
        await render();
        await type('2');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        const adds = view!.root.findAll(n => n.props['data-testid'] === 'search-add');
        expect(adds[1]!.props.disabled).toBe(true); // 2317 已在自選
        expect(adds[1]!.props.children).toBe('已在自選');
        await act(async () => { adds[0]!.props.onClick(); });
        expect(onAdd).toHaveBeenCalledWith(tsmc);
        await act(async () => { view!.root.findAll(n => n.props['data-testid'] === 'search-trade')[0]!.props.onClick(); });
        expect(onOpenTrade).toHaveBeenCalledWith('2330');
    });

    it('shows the add error on the row', async () => {
        m.searchProducts.mockResolvedValue([tsmc]);
        onAdd.mockRejectedValueOnce(new Error('組合商品暫不支援加入自選'));
        await render();
        await type('2330');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'search-add').props.onClick(); });
        expect(JSON.stringify(view!.toJSON())).toContain('組合商品暫不支援加入自選');
    });

    it('does not query while closed and clears the query on close', async () => {
        m.searchProducts.mockResolvedValue([tsmc]);
        await render();
        await type('2330');
        await act(async () => { view!.update(createElement(SearchSheet, props({ open: false }))); });
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2); });
        expect(m.searchProducts).not.toHaveBeenCalled();
        await act(async () => { view!.update(createElement(SearchSheet, props({ open: true }))); });
        expect(input().props.value).toBe('');
    });
});

// ---- B3c 搜尋面板現代化（設計規格 §7.2）----

describe('SearchSheet — v2 版面', () => {
    it('面板 large；搜尋框在 sticky 搜尋欄內（不模糊）', async () => {
        await render();
        expect(view!.root.find(n => n.type === BottomSheet).props.detent).toBe('large');
        const bar = view!.root.find(n => n.type === 'div' && n.props.className === wlStyles.searchBar);
        expect(bar.findAll(n => n.props['data-testid'] === 'search-input')).toHaveLength(1);
    });

    it('結果列：代碼為獨立文字節點；列尾晶片文字恰為標籤，aria-label 含代碼；加入失敗以 InlineNote（role=alert）顯示', async () => {
        m.searchProducts.mockResolvedValue([tsmc, hon]);
        onAdd.mockRejectedValueOnce(new Error('自選清單更新中'));
        await render();
        await type('2');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        const adds = view!.root.findAll(n => n.props['data-testid'] === 'search-add');
        expect(adds.map(a => a.props.children)).toEqual(['加入自選', '已在自選']);
        expect(adds.map(a => a.props['aria-label'])).toEqual(['2330 加入自選', '2317 已在自選']);
        expect(view!.root.findAll(n => n.props['data-testid'] === 'search-trade')[0]!.props.children).toBe('交易');
        await act(async () => { adds[0]!.props.onClick(); });
        const note = view!.root.findAll(n => n.type === InlineNote);
        expect(note).toHaveLength(1);
        expect(note[0]!.props.role).toBe('alert');
        expect(JSON.stringify(view!.toJSON())).toContain('自選清單更新中');
    });
});
