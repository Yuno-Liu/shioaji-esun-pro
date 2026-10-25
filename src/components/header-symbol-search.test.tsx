// src/components/header-symbol-search.test.tsx — 頂欄快速商品搜尋與連動切換測試

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';

const mocks = vi.hoisted(() => ({
    searchProducts: vi.fn(),
    loadStockCatalog: vi.fn(),
    primeContract: vi.fn(),
    notify: vi.fn(),
}));

vi.mock('../lib/product-search', () => ({
    searchProducts: mocks.searchProducts,
}));

vi.mock('../lib/stock-index', () => ({
    loadStockCatalog: mocks.loadStockCatalog,
}));

vi.mock('../lib/contracts-cache', () => ({
    primeContract: mocks.primeContract,
}));

vi.mock('../lib/trade', () => ({
    notify: mocks.notify,
}));

import { HeaderSymbolSearch } from './header-symbol-search';

const tsmc: ContractInfo = {
    code: '2330',
    name: '台積電',
    exchange: 'TSE',
    security_type: 'STK',
    target_code: null,
    currency: 'TWD',
    reference: 1000,
    limit_up: 1100,
    limit_down: 900,
    day_trade: 'Yes',
    update_date: '2026-10-23',
    category: '24',
    margin_trading_balance: 0,
    short_selling_balance: 0,
};

const honHai: ContractInfo = {
    code: '2317',
    name: '鴻海',
    exchange: 'TSE',
    security_type: 'STK',
    target_code: null,
    currency: 'TWD',
    reference: 200,
    limit_up: 220,
    limit_down: 180,
    day_trade: 'Yes',
    update_date: '2026-10-23',
    category: '31',
    margin_trading_balance: 0,
    short_selling_balance: 0,
};

describe('HeaderSymbolSearch', () => {
    let view: ReactTestRenderer | null = null;

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.loadStockCatalog.mockResolvedValue([]);
        mocks.searchProducts.mockResolvedValue([
            {
                code: '2317',
                name: '鴻海',
                security_type: 'STK',
                exchange: 'TSE',
                detail: '股票 · 其他電子',
                contract: honHai,
            },
            {
                code: '0050',
                name: '元大台灣50',
                security_type: 'STK',
                exchange: 'TSE',
                detail: '股票',
            },
        ]);
    });

    afterEach(async () => {
        if (view) {
            await act(async () => view!.unmount());
            view = null;
        }
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('shows the currently linked symbol when idle and opens watchlist quick-picks on focus', async () => {
        const onSelectCode = vi.fn();
        await act(async () => {
            view = create(
                createElement(HeaderSymbolSearch, {
                    selected: tsmc,
                    watchlistItems: [{ contract: tsmc }, { contract: honHai }],
                    onSelectCode,
                }),
            );
        });
        const input = view!.root.findByType('input');
        expect(input.props.value).toBe('2330 台積電');

        await act(async () => {
            input.props.onFocus();
        });
        expect(input.props.value).toBe('');
        expect(mocks.loadStockCatalog).toHaveBeenCalledOnce();

        const options = view!.root.findAll(
            (n) => n.type === 'div' && n.props.role === 'option',
        );
        expect(options).toHaveLength(2);

        // Click second watchlist item to link workspace
        await act(async () => {
            options[1]!.props.onClick();
        });
        expect(onSelectCode).toHaveBeenCalledWith('2317', 'STK');
    });

    it('searches products with fuzzy query, supports keyboard navigation and Enter to link', async () => {
        const onSelectCode = vi.fn();
        await act(async () => {
            view = create(
                createElement(HeaderSymbolSearch, {
                    selected: tsmc,
                    watchlistItems: [{ contract: tsmc }],
                    onSelectCode,
                }),
            );
        });
        const input = view!.root.findByType('input');
        await act(async () => {
            input.props.onFocus();
            input.props.onChange({ target: { value: '元大50' } });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(120);
        });
        expect(mocks.searchProducts).toHaveBeenCalledWith(
            '元大50',
            10,
            expect.objectContaining({ signal: expect.anything() }),
        );

        // Move down to second suggestion (0050) and press Enter
        await act(async () => {
            input.props.onKeyDown({ key: 'ArrowDown' });
        });
        await act(async () => {
            input.props.onKeyDown({ key: 'Enter' });
        });
        expect(onSelectCode).toHaveBeenCalledWith('0050', 'STK');
    });

    it('allows adding a searched symbol to the active watchlist via the ＋自選 button', async () => {
        const onSelectCode = vi.fn();
        const onAddWatchlist = vi.fn().mockResolvedValue(honHai);
        await act(async () => {
            view = create(
                createElement(HeaderSymbolSearch, {
                    selected: tsmc,
                    watchlistItems: [{ contract: tsmc }],
                    onSelectCode,
                    onAddWatchlist,
                }),
            );
        });
        const input = view!.root.findByType('input');
        await act(async () => {
            input.props.onFocus();
            input.props.onChange({ target: { value: '鴻海' } });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(120);
        });

        const addBtn = view!.root.find(
            (n) =>
                n.type === 'button' &&
                n.props['aria-label'] === '將 2317 加入自選',
        );
        await act(async () => {
            addBtn.props.onClick({ stopPropagation: () => undefined });
        });
        expect(onAddWatchlist).toHaveBeenCalledWith('2317', 'STK', honHai);
        expect(mocks.notify).toHaveBeenCalledWith(
            expect.objectContaining({ title: '已加入自選' }),
        );
        // ＋自選 不在 Tab 順序中（listbox 內不放可聚焦控制項）
        expect(addBtn.props.tabIndex).toBe(-1);
    });

    const openWithQuery = async (value: string) => {
        await act(async () => {
            view = create(
                createElement(HeaderSymbolSearch, {
                    selected: tsmc,
                    watchlistItems: [{ contract: tsmc }],
                    onSelectCode: vi.fn(),
                }),
            );
        });
        const input = view!.root.findByType('input');
        await act(async () => {
            input.props.onFocus();
            input.props.onChange({ target: { value } });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(120);
        });
        return () => view!.root.findByType('input');
    };

    it('combobox 以 aria-activedescendant 指向目前選項，option 都有 id', async () => {
        const input = await openWithQuery('鴻海');
        const options = view!.root.findAll(
            (n) => n.type === 'div' && n.props.role === 'option',
        );
        expect(options.map((o) => o.props.id)).toEqual([
            'header-symbol-search-opt-0',
            'header-symbol-search-opt-1',
        ]);
        expect(input().props['aria-activedescendant']).toBe(
            'header-symbol-search-opt-0',
        );
        await act(async () => {
            input().props.onKeyDown({ key: 'ArrowDown' });
        });
        expect(input().props['aria-activedescendant']).toBe(
            'header-symbol-search-opt-1',
        );
        // listbox 只包含 option
        const listbox = view!.root.find(
            (n) => n.type === 'div' && n.props.role === 'listbox',
        );
        expect(
            listbox.children.every(
                (c) => typeof c !== 'string' && c.props.role === 'option',
            ),
        ).toBe(true);
    });

    it('Tab 讓焦點離開元件時收起下拉選單', async () => {
        const input = await openWithQuery('鴻海');
        expect(input().props['aria-expanded']).toBe(true);
        await act(async () => {
            input().props.onBlur({ relatedTarget: null });
        });
        expect(input().props['aria-expanded']).toBe(false);
        expect(
            view!.root.findAll((n) => n.props.role === 'listbox'),
        ).toHaveLength(0);
    });

    it('IME 組字中不搜尋也不以 Enter 選取，組字結束後才搜尋', async () => {
        const onSelectCode = vi.fn();
        await act(async () => {
            view = create(
                createElement(HeaderSymbolSearch, {
                    selected: tsmc,
                    watchlistItems: [{ contract: tsmc }],
                    onSelectCode,
                }),
            );
        });
        const input = () => view!.root.findByType('input');
        await act(async () => {
            input().props.onFocus();
            input().props.onCompositionStart();
            input().props.onChange({ target: { value: 'ㄊㄞ' } });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(200);
        });
        expect(mocks.searchProducts).not.toHaveBeenCalled();
        const text = JSON.stringify(view!.toJSON());
        expect(text).not.toContain('找不到相符商品');
        await act(async () => {
            input().props.onKeyDown({ key: 'Enter', nativeEvent: {} });
        });
        expect(onSelectCode).not.toHaveBeenCalled();

        await act(async () => {
            input().props.onCompositionEnd({ currentTarget: { value: '台積' } });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(120);
        });
        expect(mocks.searchProducts).toHaveBeenCalledTimes(1);
        expect(mocks.searchProducts.mock.calls[0]?.[0]).toBe('台積');
    });

    it('輸入變更時取消上一筆尚未完成的搜尋', async () => {
        const signals: AbortSignal[] = [];
        mocks.searchProducts.mockImplementation(
            (_q: string, _l: number, opts?: { signal?: AbortSignal }) => {
                if (opts?.signal) signals.push(opts.signal);
                return new Promise(() => undefined);
            },
        );
        const input = await openWithQuery('23');
        await act(async () => {
            input().props.onChange({ target: { value: '233' } });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(120);
        });
        expect(signals).toHaveLength(2);
        expect(signals[0]!.aborted).toBe(true);
        expect(signals[1]!.aborted).toBe(false);
    });
});
