// QuickChips：價格 6 欄／數量 4 欄版面、每格為 Chip、只回報 key（不送單）
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as styles from './quick-chips.css';
import { QuickChips, type QuickChipsProps } from './quick-chips';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const onPick = vi.fn();
const buttons = () => view!.root.findAllByType('button');
const group = () => view!.root.find(n => n.type === 'div' && n.props.role === 'group');

const PRICE_ITEMS = [
    { key: 'last', label: '成交', dataPrice: '1,085' },
    { key: 'bid', label: '買一', dataPrice: '1,080' },
    { key: 'ask', label: '賣一', dataPrice: null, disabled: true, disabledReason: '無資料' },
];

async function render(props: Partial<QuickChipsProps> = {}) {
    const el = createElement(QuickChips, { variant: 'price', ariaLabel: '快捷價（送限價）', items: PRICE_ITEMS, onPick, ...props });
    await act(async () => {
        if (view) view.update(el);
        else view = create(el);
    });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    onPick.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('QuickChips', () => {
    it('price variant: labelled group on the 6-column grid; chips keep label-only text', async () => {
        await render();
        expect(group().props['aria-label']).toBe('快捷價（送限價）');
        expect(group().props.className).toBe(styles.grid.price);
        expect(buttons().map(b => text(b))).toEqual(['成交', '買一', '賣一']);
        expect(buttons()[0]!.props['data-price']).toBe('1,085');
        expect(buttons()[2]!.props.disabled).toBe(true);
        expect(buttons()[2]!.props['aria-label']).toBe('賣一（無資料）');
    });

    it('qty variant: 4-column grid and never shows a price line', async () => {
        await render({ variant: 'qty', ariaLabel: '快捷數量', items: [{ key: '10', label: '10', dataPrice: 'x' }] });
        expect(group().props.className).toBe(styles.grid.qty);
        expect(buttons()[0]!.props['data-price']).toBeUndefined();
    });

    it('reports the picked key only; group disabled disables every chip', async () => {
        await render();
        await act(async () => { buttons()[1]!.props.onClick(); });
        expect(onPick).toHaveBeenCalledWith('bid');
        await render({ disabled: true });
        expect(buttons().every(b => b.props.disabled === true)).toBe(true);
    });
});
