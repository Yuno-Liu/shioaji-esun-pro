// GroupedSection／ListRow／ValueRow：按鈕內只放 title（副標以 aria-describedby 關聯）、連結／靜態列、warn 圖示
import { createElement as h } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupedSection, ListRow, ValueRow } from './grouped';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const host = (pred: (n: ReactTestInstance) => boolean) => view!.root.findAll(n => typeof n.type === 'string' && pred(n));

async function render(el: ReturnType<typeof h>) {
    await act(async () => {
        if (view) view.update(el);
        else view = create(el);
    });
}

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('ListRow', () => {
    it('clickable row: the button holds only the title; subtitle is outside and linked', async () => {
        const onClick = vi.fn();
        await render(h(ListRow, { title: '改價', subtitle: '目前 100.5', trailing: h('span', null, '尾'), chevron: true, onClick, testId: 'row' }));
        const button = view!.root.findByType('button');
        expect(text(button)).toBe('改價');
        const sub = host(n => n.type === 'span' && text(n) === '目前 100.5')[0]!;
        expect(button.props['aria-describedby']).toBe(sub.props.id);
        expect(button.findAll(n => n === sub)).toHaveLength(0);
        await act(async () => { button.props.onClick(); });
        expect(onClick).toHaveBeenCalledTimes(1);
        // chevron 是 aria-hidden 的 svg
        expect(host(n => n.type === 'svg').every(n => n.props['aria-hidden'] === 'true')).toBe(true);
    });

    it('disabled row keeps the button but disables it', async () => {
        await render(h(ListRow, { title: '刪單', onClick: vi.fn(), disabled: true }));
        expect(view!.root.findByType('button').props.disabled).toBe(true);
    });

    it('href renders a link; no handler renders static text', async () => {
        await render(h(ListRow, { title: '說明', href: '#help' }));
        expect(view!.root.findByType('a').props.href).toBe('#help');
        await render(h(ListRow, { title: '帳號' }));
        expect(view!.root.findAllByType('button')).toHaveLength(0);
        expect(view!.root.findAllByType('a')).toHaveLength(0);
    });
});

describe('ValueRow', () => {
    it('testId sits on the value so its text is exactly the value; warn adds an amber icon only', async () => {
        await render(h(ValueRow, { label: '可用額度', value: '1,234', testId: 'limit' }));
        expect(text(host(n => n.props['data-testid'] === 'limit')[0]!)).toBe('1,234');
        expect(host(n => n.type === 'svg')).toHaveLength(0);
        await render(h(ValueRow, { label: '可用額度', value: '1,234', tone: 'warn', testId: 'limit' }));
        expect(host(n => n.type === 'svg')[0]!.props['aria-hidden']).toBe('true');
        expect(text(host(n => n.props['data-testid'] === 'limit')[0]!)).toBe('1,234');
    });
});

describe('GroupedSection', () => {
    it('renders header and footer outside the card', async () => {
        await render(h(GroupedSection, { header: '帳戶', footer: '資料每 6 秒更新', testId: 'grp', children: h(ValueRow, { label: 'a', value: '1' }) }));
        const section = host(n => n.props['data-testid'] === 'grp')[0]!;
        expect(section.type).toBe('section');
        expect(text(host(n => n.type === 'h2')[0]!)).toBe('帳戶');
        expect(text(host(n => n.type === 'p')[0]!)).toBe('資料每 6 秒更新');
    });
});
