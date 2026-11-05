// 通知：「結果未知」錯誤用琥珀色（規格 §7.2），確定未送出的錯誤仍是紅色；lib 以 vi.mock 隔離
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotice } from '../../lib/trade';

const h = vi.hoisted(() => ({ notice: null as ((n: AppNotice) => void) | null }));

vi.mock('../../lib/trade', () => ({
    onNotice: (l: (n: AppNotice) => void) => {
        h.notice = l;
        return () => { h.notice = null; };
    },
}));
vi.mock('../../lib/stream', () => ({ onOrderEvent: () => () => undefined }));
vi.mock('../../lib/order-report', () => ({ describeOrderReport: () => ({ kind: 'info', title: '', lines: [] }) }));
vi.mock('../../lib/privacy-text', () => ({ useRevealText: () => (s: string) => s }));

import * as styles from '../styles/toast.css';
import { noticeToastKind, ToastHost } from './toast-host';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const toasts = () => view!.root.findAll(n => n.type === 'button');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
});

describe('noticeToastKind', () => {
    it('err 且標題含「結果未知」→ warn；其餘照原 kind', () => {
        expect(noticeToastKind({ kind: 'err', title: '結果未知：請到委託頁按『更新』核對，勿重送' })).toBe('warn');
        expect(noticeToastKind({ kind: 'err', title: '刪單失敗或結果未知' })).toBe('warn');
        expect(noticeToastKind({ kind: 'err', title: '刪單未送出' })).toBe('err');
        expect(noticeToastKind({ kind: 'ok', title: '委託已送出' })).toBe('ok');
        expect(noticeToastKind({ kind: 'info', title: '結果未知' })).toBe('info');
    });
});

describe('ToastHost', () => {
    it('結果未知用琥珀色樣式（alert），確定未送出仍為紅色', async () => {
        await act(async () => { view = create(createElement(ToastHost)); });
        await act(async () => { h.notice!({ kind: 'err', title: '結果未知：請到委託頁按『更新』核對，勿重送', body: 'timeout' }); });
        await act(async () => { h.notice!({ kind: 'err', title: '改價未送出', body: '風控鎖' }); });
        const [unknown, notSent] = toasts();
        expect(unknown!.props.className).toBe(styles.toast.warn);
        expect(unknown!.props.role).toBe('alert');
        expect(unknown!.findAll(n => n.type === 'span')[0]!.props.className).toBe(styles.titleWarn);
        expect(text(unknown!)).toContain('timeout');
        expect(notSent!.props.className).toBe(styles.toast.err);
        expect(styles.toast.warn).not.toBe(styles.toast.err);
    });
});
