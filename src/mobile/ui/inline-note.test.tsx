// InlineNote：tone 圖示、role 由呼叫端決定、可選動作鍵
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineNote, type InlineNoteProps } from './inline-note';
import * as styles from './inline-note.css';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;

async function render(props: Partial<InlineNoteProps> = {}) {
    const el = createElement(InlineNote, { tone: 'warn', children: '價格可能過期', testId: 'note', ...props });
    await act(async () => {
        if (view) view.update(el);
        else view = create(el);
    });
}
const root = () => view!.root.find(n => n.props['data-testid'] === 'note' && typeof n.type === 'string');

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('InlineNote', () => {
    it.each([
        ['warn', 'lucide-triangle-alert'],
        ['danger', 'lucide-circle-x'],
        ['info', 'lucide-info'],
    ] as const)('%s uses its icon and tone class', async (tone, iconClass) => {
        await render({ tone });
        expect(root().props.className).toBe(styles.note[tone]);
        const svg = root().findAll(n => n.type === 'svg')[0]!;
        expect(String(svg.props.className)).toContain(iconClass);
        expect(svg.props['aria-hidden']).toBe('true');
        expect(text(root())).toBe('價格可能過期');
    });

    it('role is up to the caller; action button is optional', async () => {
        await render();
        expect(root().props.role).toBeUndefined();
        expect(view!.root.findAllByType('button')).toHaveLength(0);
        const onClick = vi.fn();
        await render({ role: 'status', action: { label: '使用此價格', onClick, testId: 'note-act' } });
        expect(root().props.role).toBe('status');
        const btn = view!.root.findByType('button');
        expect(text(btn)).toBe('使用此價格');
        await act(async () => { btn.props.onClick(); });
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});
