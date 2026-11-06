// Segmented：tabs／toggle 兩種語意、可見文字恰為 label、原生 disabled、拇指位置與停用原因關聯
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Segmented, thumbStyle, type SegmentedProps } from './segmented';

type V = 'ROD' | 'IOC' | 'FOK';
const ITEMS = [
    { value: 'ROD', label: 'ROD' },
    { value: 'IOC', label: 'IOC' },
    { value: 'FOK', label: 'FOK', disabled: true },
] as const;

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const onChange = vi.fn();
const buttons = () => view!.root.findAllByType('button');
const btn = (label: string) => buttons().find(b => text(b).trim() === label)!;
const hosts = (pred: (n: ReactTestInstance) => boolean) => view!.root.findAll(n => typeof n.type === 'string' && pred(n));

async function render(props: Partial<SegmentedProps<V>> = {}) {
    const el = createElement(Segmented<V>, { items: ITEMS, value: 'ROD', onChange, semantics: 'toggle', ariaLabel: '效期', ...props });
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

describe('Segmented', () => {
    it('toggle semantics: role=group with aria-pressed and exact visible labels', async () => {
        await render();
        const group = hosts(n => n.props.role === 'group')[0]!;
        expect(group.props['aria-label']).toBe('效期');
        expect(buttons().map(b => text(b))).toEqual(['ROD', 'IOC', 'FOK']);
        expect(btn('ROD').props['aria-pressed']).toBe(true);
        expect(btn('IOC').props['aria-pressed']).toBe(false);
        expect(btn('ROD').props['aria-selected']).toBeUndefined();
        expect(btn('ROD').props.role).toBeUndefined();
        expect(btn('ROD').props.type).toBe('button');
    });

    it('tabs semantics: role=tablist／tab with aria-selected and no aria-pressed', async () => {
        await render({ semantics: 'tabs', value: 'IOC' });
        expect(hosts(n => n.props.role === 'tablist')).toHaveLength(1);
        expect(buttons().every(b => b.props.role === 'tab')).toBe(true);
        expect(btn('IOC').props['aria-selected']).toBe(true);
        expect(btn('ROD').props['aria-selected']).toBe(false);
        expect(btn('IOC').props['aria-pressed']).toBeUndefined();
    });

    it('uses native disabled per item and for the whole group', async () => {
        await render();
        expect(btn('FOK').props.disabled).toBe(true);
        expect(btn('IOC').props.disabled).toBe(false);
        await render({ disabled: true });
        expect(buttons().every(b => b.props.disabled === true)).toBe(true);
    });

    it('reports the clicked value (also for the already-selected segment)', async () => {
        await render();
        await act(async () => { btn('IOC').props.onClick(); });
        expect(onChange).toHaveBeenLastCalledWith('IOC');
        await act(async () => { btn('ROD').props.onClick(); });
        expect(onChange).toHaveBeenLastCalledWith('ROD');
    });

    it('thumb is an aria-hidden span outside the buttons; moves by transform; hidden when nothing is selected', async () => {
        await render({ value: 'IOC' });
        const thumb = hosts(n => n.type === 'span' && n.props['aria-hidden'] === 'true')[0]!;
        expect(buttons().some(b => b.findAll(n => n === thumb).length > 0)).toBe(false);
        expect(thumb.props.style).toEqual({ width: 'calc((100% - 4px) / 3)', transform: 'translateX(100%)', opacity: 1 });
        await render({ value: null });
        expect(hosts(n => n.type === 'span' && n.props['aria-hidden'] === 'true')[0]!.props.style.opacity).toBe(0);
        expect(buttons().every(b => b.props['aria-pressed'] === false)).toBe(true);
    });

    it('thumbStyle is a pure function of count and index', () => {
        expect(thumbStyle(6, 5).transform).toBe('translateX(500%)');
        expect(thumbStyle(2, -1)).toEqual({ width: 'calc((100% - 4px) / 2)', transform: 'translateX(0%)', opacity: 0 });
    });

    it('scroll variant renders pills without a thumb', async () => {
        await render({ variant: 'scroll', semantics: 'tabs' });
        expect(hosts(n => n.type === 'span' && n.props['aria-hidden'] === 'true')).toHaveLength(0);
        expect(btn('ROD').props['aria-selected']).toBe(true);
    });

    it('disabled reason: footnote below the group linked by aria-describedby (plus an external id)', async () => {
        await render({ note: '零股只能 ROD', describedBy: 'ext-reason' });
        const note = hosts(n => n.type === 'p')[0]!;
        expect(text(note)).toBe('零股只能 ROD');
        const ids = String(hosts(n => n.props.role === 'group')[0]!.props['aria-describedby']).split(' ');
        expect(ids).toEqual(['ext-reason', note.props.id]);
        // 停用原因不在按鈕文字內
        expect(buttons().map(b => text(b))).toEqual(['ROD', 'IOC', 'FOK']);
    });

    it('per-item aria-label and testId', async () => {
        await render({ items: [{ value: 'ROD', label: 'ROD', ariaLabel: '當日有效', testId: 'seg-rod' }, { value: 'IOC', label: 'IOC' }] });
        expect(btn('ROD').props['aria-label']).toBe('當日有效');
        expect(btn('ROD').props['data-testid']).toBe('seg-rod');
    });
});
