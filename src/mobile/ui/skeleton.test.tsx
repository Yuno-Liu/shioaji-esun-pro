// Skeleton：role=status、保留原載入文字（視覺隱藏）、色塊 aria-hidden
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { srOnly } from '../styles/primitives.css';
import { Skeleton } from './skeleton';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('Skeleton', () => {
    it('keeps the original loading text for AT and existing text assertions', async () => {
        await act(async () => { view = create(createElement(Skeleton, { label: '委託載入中…', rows: 4, testId: 'orders-loading' })); });
        const root = view!.root.find(n => n.props['data-testid'] === 'orders-loading' && typeof n.type === 'string');
        expect(root.props.role).toBe('status');
        expect(text(root)).toBe('委託載入中…');
        expect(root.findAll(n => n.type === 'span' && n.props.className === srOnly)).toHaveLength(1);
        const rows = root.findAll(n => n.type === 'div' && n.props['aria-hidden'] === 'true');
        expect(rows).toHaveLength(4);
    });
});
