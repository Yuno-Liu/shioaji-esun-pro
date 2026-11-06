// 交易成本設定：與桌面相同的驗證範圍（折數 0<n≤10、融資 0～30% 或空白、借券 0～1%）、合法才寫入、
// inputmode=decimal、退佣方式、還原預設、標示只存在本裝置
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/esun', () => ({ isEsunAccount: () => false }));

import { DEFAULT_TRADING_COST_SETTINGS, getTradingCostSettings, resetTradingCostSettings } from '../../../lib/trading-cost-settings';
import { TradingCostSection } from './trading-cost-section';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const byTestId = (id: string) => view!.root.find(n => n.props['data-testid'] === id && typeof n.type === 'string');
const queryTestId = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');

async function type(id: string, value: string) {
    await act(async () => { byTestId(id).props.onChange({ target: { value } }); });
}

beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetTradingCostSettings();
    await act(async () => { view = create(createElement(TradingCostSection)); });
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    resetTradingCostSettings();
    vi.unstubAllGlobals();
});

describe('TradingCostSection', () => {
    it('renders decimal inputs with the current settings and the device-only note', () => {
        for (const id of ['trading-cost-discount', 'trading-cost-margin', 'trading-cost-short']) {
            expect(byTestId(id).props.inputMode).toBe('decimal');
        }
        expect(byTestId('trading-cost-discount').props.value).toBe('10');
        expect(byTestId('trading-cost-margin').props.value).toBe('');
        expect(text(byTestId('trading-cost-device-only'))).toContain('只存在本裝置');
    });

    it('fee discount: 6 → 0.6; 0 and 11 are rejected without writing', async () => {
        await type('trading-cost-discount', '6');
        expect(getTradingCostSettings().feeDiscount).toBe(0.6);
        expect(queryTestId('trading-cost-discount-error')).toHaveLength(0);

        await type('trading-cost-discount', '0');
        expect(text(byTestId('trading-cost-discount-error'))).toContain('大於 0');
        expect(byTestId('trading-cost-discount').props['aria-invalid']).toBe(true);
        expect(getTradingCostSettings().feeDiscount).toBe(0.6);

        await type('trading-cost-discount', '11');
        expect(getTradingCostSettings().feeDiscount).toBe(0.6);
        await type('trading-cost-discount', '2.8');
        expect(getTradingCostSettings().feeDiscount).toBe(0.28);
        expect(queryTestId('trading-cost-discount-error')).toHaveLength(0);
    });

    it('margin rate: blank = not set, 6.45 → 0.0645, 31 rejected', async () => {
        await type('trading-cost-margin', '6.45');
        expect(getTradingCostSettings().marginAnnualRate).toBe(0.0645);
        await type('trading-cost-margin', '31');
        expect(text(byTestId('trading-cost-margin-error'))).toContain('0～30%');
        expect(getTradingCostSettings().marginAnnualRate).toBe(0.0645);
        await type('trading-cost-margin', '');
        expect(getTradingCostSettings().marginAnnualRate).toBeNull();
    });

    it('short fee: 0.1 → 0.001, 2 and text rejected', async () => {
        await type('trading-cost-short', '0.1');
        expect(getTradingCostSettings().shortFeeRate).toBe(0.001);
        await type('trading-cost-short', '2');
        expect(getTradingCostSettings().shortFeeRate).toBe(0.001);
        await type('trading-cost-short', 'abc');
        expect(text(byTestId('trading-cost-short-error'))).toContain('0～1%');
    });

    it('rebate mode segmented control writes monthly / instant', async () => {
        const instant = byTestId('trading-cost-rebate').findAll(n => n.type === 'button').find(b => text(b) === '成交即折')!;
        await act(async () => instant.props.onClick());
        expect(getTradingCostSettings().rebateMode).toBe('instant');
        expect(instant.props['aria-pressed']).toBe(true);
    });

    it('reset restores defaults and clears errors', async () => {
        await type('trading-cost-discount', '6');
        await type('trading-cost-short', '9');
        await act(async () => byTestId('trading-cost-reset').props.onClick());
        expect(getTradingCostSettings()).toEqual(DEFAULT_TRADING_COST_SETTINGS);
        expect(byTestId('trading-cost-discount').props.value).toBe('10');
        expect(queryTestId('trading-cost-short-error')).toHaveLength(0);
    });
});
