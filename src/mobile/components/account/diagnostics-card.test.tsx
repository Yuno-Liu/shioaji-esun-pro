// 帳戶頁「診斷」：來源、UA、建置版本可長按選取複製（M-PLAT-6：全域 user-select: none 的例外 .selectable）
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELECTABLE } from '../../styles/layout.css';
import { DiagnosticsCard } from './diagnostics-card';

let view: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' });
    vi.stubGlobal('location', { origin: 'https://trade.example.ts.net' });
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

const classesOf = (testId: string) => {
    const node = view!.root.find(n => typeof n.type === 'string' && n.props['data-testid'] === testId);
    return String(node.props.className).split(' ');
};

describe('DiagnosticsCard', () => {
    it('origin, build version and UA values carry the selectable class', async () => {
        await act(async () => { view = create(createElement(DiagnosticsCard)); });
        const out = JSON.stringify(view!.toJSON());
        expect(out).toContain('https://trade.example.ts.net');
        expect(out).toContain('iPhone OS 17_5');
        for (const id of ['diag-origin', 'diag-build', 'diag-ua']) expect(classesOf(id)).toContain(SELECTABLE);
    });
});
