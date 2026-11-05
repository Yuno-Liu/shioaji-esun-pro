// 帳戶頁共用元件（設計規格 §7.8）：GroupedSection 外觀下 props、testId、語意不變；
// 開關拇指改 transform（不再轉場 left）、可展開卡片 chevron 旋轉＋內容淡入（只動畫 transform／opacity）。
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/esun', () => ({ isEsunAccount: () => false }));

import * as styles from '../../styles/account.css';
import { Card, CollapsibleCard, Item, Segmented, Switch } from './account-ui';

let view: ReactTestRenderer | undefined;
const textOf = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const host = (pred: (n: ReactTestInstance) => boolean) => view!.root.findAll(n => typeof n.type === 'string' && pred(n));
const byTestId = (id: string) => view!.root.find(n => typeof n.type === 'string' && n.props['data-testid'] === id);

async function mount(el: ReturnType<typeof createElement>) {
    await act(async () => { view = create(el); });
}

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('Card', () => {
    it('puts the title (h2) and extra outside the grouped body; section keeps testId and aria-label', async () => {
        await mount(createElement(Card, {
            title: '帳號',
            testId: 'account-accounts',
            extra: createElement('button', { type: 'button', 'data-testid': 'extra' }, '切換帳戶'),
            children: createElement('p', { 'data-testid': 'child' }, '內容'),
        }));
        const section = byTestId('account-accounts');
        expect(section.type).toBe('section');
        expect(section.props['aria-label']).toBe('帳號');
        const [header, body] = section.children as ReactTestInstance[];
        expect(header!.props.className).toBe(styles.cardHeader);
        expect(textOf(header!.findByType('h2'))).toBe('帳號');
        expect(header!.findAll(n => n.props['data-testid'] === 'extra')).toHaveLength(1);
        expect(body!.props.className).toBe(styles.cardBody);
        expect(body!.findAll(n => n.props['data-testid'] === 'child')).toHaveLength(1);
    });
});

describe('CollapsibleCard', () => {
    it('toggle button keeps aria-expanded, testId and exact title text; content mounts only when open', async () => {
        const onToggle = vi.fn();
        const el = (open: boolean) => createElement(CollapsibleCard, {
            title: '已實現損益', open, onToggle, testId: 'account-pnl',
            extra: createElement('span', { 'data-testid': 'extra' }),
            children: createElement('div', { 'data-testid': 'pnl-body' }),
        });
        await mount(el(false));
        const toggle = () => byTestId('account-pnl-toggle');
        expect(toggle().type).toBe('button');
        expect(toggle().props['aria-expanded']).toBe(false);
        expect(textOf(toggle())).toBe('已實現損益');
        expect(host(n => n.props['data-testid'] === 'pnl-body')).toHaveLength(0);
        expect(host(n => n.props['data-testid'] === 'extra')).toHaveLength(0);
        await act(async () => toggle().props.onClick());
        expect(onToggle).toHaveBeenCalledOnce();

        await act(async () => { view!.update(el(true)); });
        expect(toggle().props['aria-expanded']).toBe(true);
        const body = byTestId('pnl-body');
        expect(body.parent!.props.className).toBe(styles.collapsibleContent);
        expect(host(n => n.props['data-testid'] === 'extra')).toHaveLength(1);
        // chevron 只有一個（以 CSS 旋轉），裝飾用
        const chevrons = toggle().findAll(n => n.type === 'svg');
        expect(chevrons).toHaveLength(1);
        expect(chevrons[0]!.props['aria-hidden']).toBe('true');
    });
});

describe('Item', () => {
    it('warn tone adds an amber icon but keeps the exact value text on the dd testId', async () => {
        await mount(createElement('dl', null,
            createElement(Item, { term: '總資產', tone: 'warn', testId: 'v-warn', children: '待確認' }),
            createElement(Item, { term: '餘額', testId: 'v-normal', children: '$1,000' })));
        const warn = byTestId('v-warn');
        expect(warn.type).toBe('dd');
        expect(textOf(warn)).toBe('待確認');
        expect(warn.findAll(n => n.type === 'svg')).toHaveLength(1);
        expect(String(warn.props.className).split(' ')).toContain(styles.value);
        expect(byTestId('v-normal').findAll(n => n.type === 'svg')).toHaveLength(0);
        expect(host(n => n.type === 'dt').map(textOf)).toEqual(['總資產', '餘額']);
    });
});

describe('Switch', () => {
    it('role=switch, aria-checked, label; disabled never calls onChange', async () => {
        const onChange = vi.fn();
        await mount(createElement('div', null,
            createElement(Switch, { checked: false, onChange, label: '遮蔽金額', testId: 'sw' }),
            createElement(Switch, { checked: true, onChange, label: '鎖定', disabled: true, testId: 'sw-locked' })));
        const sw = byTestId('sw');
        expect(sw.props.role).toBe('switch');
        expect(sw.props['aria-checked']).toBe(false);
        expect(sw.props['aria-label']).toBe('遮蔽金額');
        await act(async () => sw.props.onClick());
        expect(onChange).toHaveBeenCalledWith(true);
        onChange.mockClear();
        await act(async () => byTestId('sw-locked').props.onClick());
        expect(onChange).not.toHaveBeenCalled();
        expect(byTestId('sw-locked').props.disabled).toBe(true);
    });
});

describe('Segmented (account wrapper over ui/segmented)', () => {
    it('keeps role=group + aria-label + testId, button text is the option text, aria-pressed follows value', async () => {
        const onChange = vi.fn();
        const opts = [{ value: 'a', text: '今日' }, { value: 'b', text: '近一週' }] as const;
        await mount(createElement(Segmented<'a' | 'b'>, { label: '區間', value: 'a', options: opts, onChange, testId: 'seg' }));
        const group = byTestId('seg');
        expect(group.props.role).toBe('group');
        expect(group.props['aria-label']).toBe('區間');
        const buttons = group.findAll(n => n.type === 'button');
        expect(buttons.map(textOf)).toEqual(['今日', '近一週']);
        expect(buttons.map(b => b.props['aria-pressed'])).toEqual([true, false]);
        await act(async () => buttons[1]!.props.onClick());
        expect(onChange).toHaveBeenCalledWith('b');
    });
});

describe('account styles (static)', () => {
    // 去掉註解再檢查（註解裡會提到禁用語法）
    const src = readFileSync(new URL('../../styles/account.css.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    it('switch thumb moves with transform, not a left / width / background transition', () => {
        expect(src).toContain("transform: 'translateX(20px)'");
        expect(src).not.toMatch(/transition:\s*`?'?(left|width|background)\b/);
        expect(src).not.toMatch(/transition: `(left|width|background) /);
    });

    it('no iOS 15.4-incompatible CSS, no weight 800, no amber small text', () => {
        expect(src).not.toMatch(/color-mix\(|:has\(|fontWeight: 800/);
        // amber 文字色只出現在 warn 圖示（warnIcon）；其餘警示是框線／左側條
        expect(src.match(/[\s{]color: vars\.color\.amber/g)).toHaveLength(1);
        expect(src).toMatch(/export const warnIcon = style\(\{[^}]*color: vars\.color\.amber/);
    });
});
