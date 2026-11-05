// IconButton：aria-label 必填、圖示 svg aria-hidden（無文字）、pressed 只給切換型、close 變體預設 X
import { Search } from 'lucide-react';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IconButton, type IconButtonProps } from './icon-button';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const onClick = vi.fn();
const button = () => view!.root.findByType('button');

async function render(props: Partial<IconButtonProps> = {}) {
    const el = createElement(IconButton, { ariaLabel: '搜尋', icon: Search, onClick, ...props });
    await act(async () => {
        if (view) view.update(el);
        else view = create(el);
    });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    onClick.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('IconButton', () => {
    it('is labelled by aria-label only; the icon is a hidden svg', async () => {
        await render();
        expect(button().props['aria-label']).toBe('搜尋');
        expect(text(button())).toBe('');
        const svg = button().findAll(n => n.type === 'svg');
        expect(svg).toHaveLength(1);
        expect(svg[0]!.props['aria-hidden']).toBe('true');
        expect(button().props['aria-pressed']).toBeUndefined();
        await act(async () => { button().props.onClick(); });
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('pressed state for toggles and native disabled', async () => {
        await render({ pressed: true, disabled: true });
        expect(button().props['aria-pressed']).toBe(true);
        expect(button().props.disabled).toBe(true);
    });

    it('close variant defaults to an 18px X', async () => {
        await render({ variant: 'close', icon: undefined, ariaLabel: '關閉' });
        const svg = button().findAll(n => n.type === 'svg')[0]!;
        expect(svg.props.width).toBe(18);
        expect(String(svg.props.className)).toContain('lucide-x');
    });
});
