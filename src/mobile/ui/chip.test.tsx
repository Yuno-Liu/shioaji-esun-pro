// Chip：文字節點只有標籤、價格放 data-price（CSS ::after 顯示）、aria-label 含價格／停用原因、aria-pressed 只給切換型
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chip, chipAriaLabel, type ChipProps } from './chip';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const onClick = vi.fn();
const button = () => view!.root.findByType('button');

async function render(props: Partial<ChipProps> = {}) {
    const el = createElement(Chip, { label: '成交', onClick, ...props });
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

describe('Chip', () => {
    it('renders only the label as text; the price lives in data-price and aria-label', async () => {
        await render({ dataPrice: '1,085' });
        expect(text(button())).toBe('成交');
        expect(button().props['data-price']).toBe('1,085');
        expect(button().props['aria-label']).toBe('成交 1,085');
        expect(button().props.type).toBe('button');
    });

    it('without a price: no data-price and no aria-label override', async () => {
        await render({ dataPrice: null });
        expect(button().props['data-price']).toBeUndefined();
        expect(button().props['aria-label']).toBeUndefined();
    });

    it('disabled: native disabled and the reason in aria-label', async () => {
        await render({ label: '買一', disabled: true, disabledReason: '無資料' });
        expect(button().props.disabled).toBe(true);
        expect(button().props['aria-label']).toBe('買一（無資料）');
        expect(text(button())).toBe('買一');
    });

    it('aria-pressed only for toggle chips', async () => {
        await render();
        expect(button().props['aria-pressed']).toBeUndefined();
        await render({ selected: false });
        expect(button().props['aria-pressed']).toBe(false);
        await render({ selected: true });
        expect(button().props['aria-pressed']).toBe(true);
    });

    it('click calls onClick (works without an event, like the existing tests)', async () => {
        await render();
        await act(async () => { button().props.onClick(); });
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('chipAriaLabel: explicit label wins', () => {
        expect(chipAriaLabel({ label: '成交', ariaLabel: '成交價 100', dataPrice: '100' })).toBe('成交價 100');
    });
});
