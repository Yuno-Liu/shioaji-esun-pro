// PageHeader：h1 文字不變、右側動作
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageHeader } from './page-header';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('PageHeader', () => {
    it('renders the title as h1 and optional actions', async () => {
        await act(async () => {
            view = create(createElement(PageHeader, { title: '委託', testId: 'orders-header', actions: createElement('button', { type: 'button' }, '更新') }));
        });
        expect(text(view!.root.findByType('h1'))).toBe('委託');
        expect(view!.root.findByProps({ 'data-testid': 'orders-header' }).type).toBe('header');
        expect(text(view!.root.findByType('button'))).toBe('更新');
    });

    it('omits the actions container when there are none', async () => {
        await act(async () => { view = create(createElement(PageHeader, { title: '持倉' })); });
        expect(view!.root.findAll(n => n.type === 'div')).toHaveLength(0);
    });
});
