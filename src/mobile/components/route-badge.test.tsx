// RouteBadge 新外觀（設計規格 §6.5）：外框膠囊＋「送往 {券商} 」＋環境實心小膠囊；
// 可見文字串接後仍恰為 routeBadgeText()（「送往 永豐 模擬」），沒有帳戶時「未選擇下單帳戶」。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ esunEnvironment: 'simulation', sinopacSimulation: true as boolean | undefined }));

vi.mock('../../lib/esun', () => ({ useEsunEnvironment: () => ({ environment: m.esunEnvironment }) }));
vi.mock('../../lib/server-info-store', () => ({ useServerInfo: () => ({ simulation: m.sinopacSimulation }) }));
vi.mock('../../lib/order-route', () => ({
    orderRouteOf: (a: { broker_id: string }, live: { sinopacSimulation: boolean | undefined }) =>
        ({ esun: a.broker_id === 'ESUN', broker: a.broker_id === 'ESUN' ? '玉山' : '永豐', simulation: live.sinopacSimulation }),
    routeEnvText: (s: boolean | undefined) => (s === true ? '模擬' : s === false ? '正式' : '環境未確認'),
}));

import { RouteBadge, routeBadgeText, routeTone } from './route-badge';

let view: ReactTestRenderer | undefined;
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const badge = () => view!.root.find(n => n.props['data-testid'] === 'mobile-route-badge' && typeof n.type === 'string');

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('RouteBadge', () => {
    it.each([
        [true, '送往 永豐 模擬', 'simulation'],
        [false, '送往 永豐 正式', 'production'],
        [undefined, '送往 永豐 環境未確認', 'unknown'],
    ] as const)('simulation=%s：可見文字串接為「%s」且等於 routeBadgeText', async (sim, text, env) => {
        m.sinopacSimulation = sim;
        await act(async () => { view = create(createElement(RouteBadge, { account: { broker_id: '9A95' } as never })); });
        expect(textOf(badge())).toBe(text);
        expect(textOf(badge())).toBe(routeBadgeText({ esun: false, broker: '永豐', simulation: sim }));
        expect(badge().props['data-env']).toBe(env);
        // 環境字在獨立的實心小膠囊內
        const pill = badge().findAll(n => typeof n.type === 'string' && n !== badge());
        expect(pill.map(textOf)).toContain(text.split(' ').pop());
    });

    it('沒有帳戶：只顯示「未選擇下單帳戶」', async () => {
        await act(async () => { view = create(createElement(RouteBadge, { account: null })); });
        expect(textOf(badge())).toBe('未選擇下單帳戶');
        expect(badge().props['data-env']).toBe('unknown');
    });

    it('size=lg 仍輸出同一段文字', async () => {
        m.sinopacSimulation = true;
        await act(async () => { view = create(createElement(RouteBadge, { account: { broker_id: '9A95' } as never, size: 'lg' })); });
        expect(textOf(badge())).toBe('送往 永豐 模擬');
    });

    it('routeTone 不變', () => {
        expect(routeTone(null)).toBe('unknown');
        expect(routeTone({ esun: false, broker: '永豐', simulation: true })).toBe('simulation');
        expect(routeTone({ esun: false, broker: '永豐', simulation: false })).toBe('production');
    });
});
