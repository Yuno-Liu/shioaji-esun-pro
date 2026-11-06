// EmptyState：testId 在標題（文字恰為既有常數）、圖示 aria-hidden、一個主要動作
import { Search } from 'lucide-react';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmptyState } from './empty-state';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('EmptyState', () => {
    it('title carries the testId; description and action are separate', async () => {
        const onClick = vi.fn();
        await act(async () => {
            view = create(createElement(EmptyState, {
                icon: Search, title: '自選清單是空的', description: '用搜尋加入股票或期貨', testId: 'watchlist-empty',
                action: { label: '搜尋並加入', onClick, testId: 'watchlist-empty-search' },
            }));
        });
        expect(text(view!.root.find(n => n.props['data-testid'] === 'watchlist-empty' && typeof n.type === 'string'))).toBe('自選清單是空的');
        expect(view!.root.findAll(n => n.type === 'svg')[0]!.props['aria-hidden']).toBe('true');
        const btn = view!.root.findByType('button');
        expect(text(btn)).toBe('搜尋並加入');
        await act(async () => { btn.props.onClick(); });
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('icon, description and action are optional', async () => {
        await act(async () => { view = create(createElement(EmptyState, { title: '沒有委託' })); });
        expect(view!.root.findAll(n => n.type === 'svg')).toHaveLength(0);
        expect(view!.root.findAllByType('button')).toHaveLength(0);
        expect(view!.root.findAllByType('p')).toHaveLength(1);
    });
});
