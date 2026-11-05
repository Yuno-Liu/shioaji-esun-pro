// PopUpButton：testId、aria-label、value、onChange 都在原生 select 上；可見文字與圖示 aria-hidden
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PopUpButton, type PopUpButtonProps } from './pop-up-button';

type PT = 'LMT' | 'MKT' | 'MKP';
const OPTIONS = [
    { value: 'LMT', label: '限價' },
    { value: 'MKT', label: '市價（零股不可）', disabled: true },
    { value: 'MKP', label: '範圍市價' },
] as const;

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const onChange = vi.fn();
const byTestId = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');

async function render(props: Partial<PopUpButtonProps<PT>> = {}) {
    const el = createElement(PopUpButton<PT>, { value: 'LMT', options: OPTIONS, onChange, ariaLabel: '價別', testId: 'ticket-price-type', ...props });
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

describe('PopUpButton', () => {
    it('puts testid, aria-label, value and onChange on the native select', async () => {
        await render();
        const found = byTestId('ticket-price-type');
        expect(found).toHaveLength(1);
        const select = found[0]!;
        expect(select.type).toBe('select');
        expect(select.props['aria-label']).toBe('價別');
        expect(select.props.value).toBe('LMT');
        await act(async () => { select.props.onChange({ target: { value: 'MKP' } }); });
        expect(onChange).toHaveBeenCalledWith('MKP');
    });

    it('renders options with native disabled', async () => {
        await render();
        const opt = (v: string) => byTestId('ticket-price-type')[0]!.findAll(n => n.type === 'option' && n.props.value === v)[0]!;
        expect(opt('MKT').props.disabled).toBe(true);
        expect(opt('LMT').props.disabled).toBeFalsy();
        expect(text(opt('MKT'))).toBe('市價（零股不可）');
    });

    it('visible part is the current label plus an icon, both hidden from AT', async () => {
        await render({ value: 'MKP' });
        const visible = view!.root.findAll(n => n.type === 'span' && n.props['aria-hidden'] === 'true');
        expect(visible.map(n => text(n))).toEqual(['範圍市價']);
        expect(view!.root.findAll(n => n.type === 'svg')[0]!.props['aria-hidden']).toBe('true');
        await render({ displayLabel: '自訂' });
        expect(view!.root.findAll(n => n.type === 'span' && n.props['aria-hidden'] === 'true').map(n => text(n))).toEqual(['自訂']);
    });

    it('disabled goes on the select', async () => {
        await render({ disabled: true });
        expect(byTestId('ticket-price-type')[0]!.props.disabled).toBe(true);
    });
});
