// 交易成本設定：與桌面相同的驗證範圍（折數 0<n≤10、融資 0～30% 或空白、借券 0～1%）、合法才寫入、
// inputmode=decimal、折數與退佣方式永豐／玉山分開（手機版限定）、融資與借券共用、還原預設清掉兩家覆寫、標示只存在本裝置
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/esun', () => ({ isEsunAccount: () => false }));

import { DEFAULT_TRADING_COST_SETTINGS, getTradingCostSettings, resetTradingCostSettings, setTradingCostSettings } from '../../../lib/trading-cost-settings';
import { getBrokerCostOverrides, resetBrokerCostSettings, setBrokerFeeSettings } from '../../lib/broker-cost-settings';
import { TradingCostSection } from './trading-cost-section';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const byTestId = (id: string) => view!.root.find(n => n.props['data-testid'] === id && typeof n.type === 'string');
const queryTestId = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');

async function type(id: string, value: string) {
    await act(async () => { byTestId(id).props.onChange({ target: { value } }); });
}
async function pick(id: string, label: string) {
    const b = byTestId(id).findAll(n => n.type === 'button').find(n => text(n) === label)!;
    await act(async () => b.props.onClick());
    return b;
}
async function mount() {
    await act(async () => { view = create(createElement(TradingCostSection)); });
}

beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetTradingCostSettings();
    resetBrokerCostSettings();
    await mount();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    resetTradingCostSettings();
    resetBrokerCostSettings();
    vi.unstubAllGlobals();
});

describe('TradingCostSection', () => {
    it('renders decimal inputs with the current settings and the device-only / mobile-only notes', () => {
        for (const id of ['trading-cost-discount-sinopac', 'trading-cost-discount-esun', 'trading-cost-margin', 'trading-cost-short']) {
            expect(byTestId(id).props.inputMode).toBe('decimal');
        }
        expect(queryTestId('trading-cost-discount')).toHaveLength(0);
        expect(byTestId('trading-cost-discount-sinopac').props.value).toBe('10');
        expect(byTestId('trading-cost-discount-esun').props.value).toBe('10');
        expect(byTestId('trading-cost-margin').props.value).toBe('');
        expect(text(byTestId('trading-cost-device-only'))).toContain('只存在本裝置');
        expect(text(byTestId('trading-cost-broker-note'))).toBe('折數與退佣方式依券商分開，只套用在手機版；桌面版仍使用共用設定。');
        expect(text(byTestId('trading-cost-broker-sinopac'))).toContain('永豐');
        expect(text(byTestId('trading-cost-broker-esun'))).toContain('玉山');
    });

    it('未設定的券商沿用共用折數與退佣方式（例如桌面設定的 6 折月退）', async () => {
        await act(async () => view!.unmount());
        setTradingCostSettings({ feeDiscount: 0.6, rebateMode: 'instant' });
        setBrokerFeeSettings('esun', { feeDiscount: 0.28, rebateMode: 'monthly' });
        await mount();
        expect(byTestId('trading-cost-discount-sinopac').props.value).toBe('6');
        expect(byTestId('trading-cost-discount-esun').props.value).toBe('2.8');
        const pressed = (id: string) => text(byTestId(id).findAll(n => n.type === 'button').find(b => b.props['aria-pressed'] === true)!);
        expect(pressed('trading-cost-rebate-sinopac')).toBe('成交即折');
        expect(pressed('trading-cost-rebate-esun')).toBe('月退');
    });

    it('fee discount per broker: 6 → 永豐 0.6 only; 0 and 11 are rejected without writing; shared value unchanged', async () => {
        await type('trading-cost-discount-sinopac', '6');
        expect(getBrokerCostOverrides().sinopac?.feeDiscount).toBe(0.6);
        expect(getBrokerCostOverrides().esun).toBeUndefined();
        expect(getTradingCostSettings().feeDiscount).toBe(1);
        expect(queryTestId('trading-cost-discount-sinopac-error')).toHaveLength(0);

        await type('trading-cost-discount-sinopac', '0');
        expect(text(byTestId('trading-cost-discount-sinopac-error'))).toContain('大於 0');
        expect(byTestId('trading-cost-discount-sinopac').props['aria-invalid']).toBe(true);
        expect(getBrokerCostOverrides().sinopac?.feeDiscount).toBe(0.6);

        await type('trading-cost-discount-sinopac', '11');
        expect(getBrokerCostOverrides().sinopac?.feeDiscount).toBe(0.6);

        await type('trading-cost-discount-esun', '2.8');
        expect(getBrokerCostOverrides().esun?.feeDiscount).toBe(0.28);
        expect(getBrokerCostOverrides().sinopac?.feeDiscount).toBe(0.6);
        expect(queryTestId('trading-cost-discount-esun-error')).toHaveLength(0);
        // 另一家的錯誤不受影響
        expect(queryTestId('trading-cost-discount-sinopac-error')).toHaveLength(1);
        await type('trading-cost-discount-sinopac', '2.8');
        expect(queryTestId('trading-cost-discount-sinopac-error')).toHaveLength(0);
    });

    it('margin rate: blank = not set, 6.45 → 0.0645, 31 rejected (shared)', async () => {
        await type('trading-cost-margin', '6.45');
        expect(getTradingCostSettings().marginAnnualRate).toBe(0.0645);
        await type('trading-cost-margin', '31');
        expect(text(byTestId('trading-cost-margin-error'))).toContain('0～30%');
        expect(getTradingCostSettings().marginAnnualRate).toBe(0.0645);
        await type('trading-cost-margin', '');
        expect(getTradingCostSettings().marginAnnualRate).toBeNull();
        expect(getBrokerCostOverrides()).toEqual({});
    });

    it('short fee: 0.1 → 0.001, 2 and text rejected (shared)', async () => {
        await type('trading-cost-short', '0.1');
        expect(getTradingCostSettings().shortFeeRate).toBe(0.001);
        await type('trading-cost-short', '2');
        expect(getTradingCostSettings().shortFeeRate).toBe(0.001);
        await type('trading-cost-short', 'abc');
        expect(text(byTestId('trading-cost-short-error'))).toContain('0～1%');
    });

    it('rebate mode per broker: 玉山成交即折不影響永豐與共用設定', async () => {
        const instant = await pick('trading-cost-rebate-esun', '成交即折');
        expect(getBrokerCostOverrides().esun).toEqual({ feeDiscount: 1, rebateMode: 'instant' });
        expect(getBrokerCostOverrides().sinopac).toBeUndefined();
        expect(getTradingCostSettings().rebateMode).toBe('monthly');
        expect(instant.props['aria-pressed']).toBe(true);
        const sinoMonthly = byTestId('trading-cost-rebate-sinopac').findAll(n => n.type === 'button').find(b => text(b) === '月退')!;
        expect(sinoMonthly.props['aria-pressed']).toBe(true);
    });

    it('reset restores shared defaults, clears both broker overrides and errors', async () => {
        await type('trading-cost-discount-sinopac', '6');
        await type('trading-cost-discount-esun', '2.8');
        await pick('trading-cost-rebate-esun', '成交即折');
        await type('trading-cost-short', '9');
        await type('trading-cost-margin', '6.45');
        await act(async () => byTestId('trading-cost-reset').props.onClick());
        expect(getTradingCostSettings()).toEqual(DEFAULT_TRADING_COST_SETTINGS);
        expect(getBrokerCostOverrides()).toEqual({});
        expect(byTestId('trading-cost-discount-sinopac').props.value).toBe('10');
        expect(byTestId('trading-cost-discount-esun').props.value).toBe('10');
        expect(byTestId('trading-cost-margin').props.value).toBe('');
        expect(queryTestId('trading-cost-short-error')).toHaveLength(0);
    });
});
