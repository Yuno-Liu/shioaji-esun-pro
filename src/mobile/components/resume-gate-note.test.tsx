// ResumeGateNote（A-1）：只在 stale-data 顯示；勾選呼叫 acknowledgeStaleData、「重試同步」呼叫 retryResume；
// 已勾選或停用時不可再勾；不送出任何委託。以 vi.mock 隔離 ResumeGate 執行期。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ acknowledgeStaleData: vi.fn(), retryResume: vi.fn() }));
vi.mock('../lib/resume-gate-runtime', () => ({ acknowledgeStaleData: m.acknowledgeStaleData, retryResume: m.retryResume }));

import { RESUME_NOTE_TEXT, ResumeGateNote, type ResumeGateNoteProps } from './resume-gate-note';

let view: ReactTestRenderer | undefined;
async function render(props: ResumeGateNoteProps) {
    await act(async () => { view = create(createElement(ResumeGateNote, props)); });
}
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => all(id)[0]!;
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.acknowledgeStaleData.mockReset();
    m.retryResume.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('ResumeGateNote', () => {
    it('ready／resyncing／failed 不顯示', async () => {
        for (const state of ['ready', 'resyncing', 'failed'] as const) {
            await render({ gate: { state, staleAcknowledged: false, message: 'x' } });
            expect(view!.toJSON()).toBeNull();
            await act(async () => view?.unmount());
        }
    });

    it('stale-data：顯示原因、勾選框與「重試同步」；勾選呼叫 acknowledgeStaleData，重試呼叫 retryResume', async () => {
        await render({ gate: { state: 'stale-data', staleAcknowledged: false, message: '委託讀取失敗' }, testId: 'n' });
        expect(textOf(one('n-reason'))).toContain('委託讀取失敗');
        const ack = one('n-ack');
        expect(ack.props.type).toBe('checkbox');
        expect(ack.props.checked).toBe(false);
        expect(ack.props.disabled).toBe(false);
        expect(textOf(one('n'))).toContain(RESUME_NOTE_TEXT.acknowledge);
        await act(async () => { ack.props.onChange(); });
        expect(m.acknowledgeStaleData).toHaveBeenCalledTimes(1);
        expect(textOf(one('n-retry'))).toBe(RESUME_NOTE_TEXT.retry);
        await act(async () => { one('n-retry').props.onClick(); });
        expect(m.retryResume).toHaveBeenCalledTimes(1);
    });

    it('已勾選：勾選框打勾且停用；showReason=false 不重複顯示原因；disabled 時重試也停用', async () => {
        await render({ gate: { state: 'stale-data', staleAcknowledged: true, message: 'm' }, showReason: false, disabled: true, testId: 'n' });
        expect(one('n-ack').props.checked).toBe(true);
        expect(one('n-ack').props.disabled).toBe(true);
        expect(all('n-reason')).toHaveLength(0);
        expect(one('n-retry').props.disabled).toBe(true);
    });
});
