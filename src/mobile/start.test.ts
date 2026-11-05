// 手機入口啟動順序：initTheme → 字級預設（不論 secure）→ 強制下單確認 → （secure 才）bootstrap
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../lib/boot', () => ({ bootstrap: () => m.calls.push('bootstrap') }));
vi.mock('../lib/risk', () => ({
    getRiskSettings: () => ({ confirmManualOrders: true }),
    setRiskSettings: () => undefined,
    subscribeRiskSettings: () => () => undefined,
}));
vi.mock('../lib/theme-store', () => ({ initTheme: () => m.calls.push('initTheme') }));
vi.mock('./lib/font-default', () => ({ applyMobileFontDefault: () => m.calls.push('fontDefault') }));

import { startMobile } from './start';

beforeEach(() => {
    m.calls.length = 0;
});

describe('startMobile', () => {
    it('非 secure：套用主題與字級預設，不 bootstrap', () => {
        startMobile(false);
        expect(m.calls).toEqual(['initTheme', 'fontDefault']);
    });

    it('secure：字級預設在 initTheme 之後、bootstrap 之前', () => {
        startMobile(true);
        expect(m.calls).toEqual(['initTheme', 'fontDefault', 'bootstrap']);
    });
});
