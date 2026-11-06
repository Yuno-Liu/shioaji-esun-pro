// DirectionToggle：群組語意、可見文字恰為「買進」「賣出」、aria-pressed、Check 為 svg（不產生文字）、買賣色只用 up／down
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fill } from '../styles/primitives.css';
import { DirectionToggle, type DirectionToggleProps } from './direction-toggle';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const onChange = vi.fn();
const buttons = () => view!.root.findAllByType('button');
const btn = (label: string) => buttons().find(b => text(b).trim() === label)!;

async function render(props: Partial<DirectionToggleProps> = {}) {
    const el = createElement(DirectionToggle, { value: null, onChange, ...props });
    await act(async () => {
        if (view) view.update(el);
        else view = create(el);
    });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    onChange.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('DirectionToggle', () => {
    it('is a labelled group of two native buttons with exact text', async () => {
        await render();
        const group = view!.root.find(n => n.type === 'div' && n.props.role === 'group');
        expect(group.props['aria-label']).toBe('買賣方向');
        expect(buttons().map(b => text(b))).toEqual(['買進', '賣出']);
        expect(buttons().every(b => b.props.type === 'button' && b.props['aria-pressed'] === false)).toBe(true);
    });

    it('selected key shows an svg Check without adding text, and uses the up/down solid fill', async () => {
        await render({ value: 'Buy' });
        expect(btn('買進').props['aria-pressed']).toBe(true);
        expect(btn('賣出').props['aria-pressed']).toBe(false);
        const svg = btn('買進').findAll(n => n.type === 'svg');
        expect(svg).toHaveLength(1);
        expect(svg[0]!.props['aria-hidden']).toBe('true');
        expect(text(btn('買進'))).toBe('買進');
        expect(btn('買進').props.className).toContain(fill.up.large);
        expect(btn('賣出').findAll(n => n.type === 'svg')).toHaveLength(0);

        await render({ value: 'Sell' });
        expect(btn('賣出').props.className).toContain(fill.down.large);
        expect(btn('買進').props.className).not.toContain(fill.up.large);
    });

    it('only reports the direction (never submits) and honours disabled', async () => {
        await render({ value: 'Buy' });
        await act(async () => { btn('賣出').props.onClick(); });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith('Sell');
        await render({ value: 'Buy', disabled: true });
        expect(buttons().every(b => b.props.disabled === true)).toBe(true);
    });
});
