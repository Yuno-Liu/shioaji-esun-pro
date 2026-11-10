// 手機版依券商的手續費折數與退佣方式：sanitize、沿用共用設定、第一次寫入補齊、物件身分、還原。
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/esun', async () => {
    const om = await vi.importActual<typeof import('../../lib/esun/order-mapping')>('../../lib/esun/order-mapping');
    return { isEsunAccount: om.isEsunAccount };
});

import {
    DEFAULT_TRADING_COST_SETTINGS,
    resetTradingCostSettings,
    setTradingCostSettings,
    type TradingCostSettings,
} from '../../lib/trading-cost-settings';
import {
    BROKER_COST_SETTINGS_KEY,
    brokerOfAccount,
    brokerOfAccountKey,
    costSettingsFor,
    getBrokerCostOverrides,
    resetBrokerCostSettings,
    sanitizeBrokerCostOverrides,
    setBrokerFeeSettings,
    subscribeBrokerCostOverrides,
    useBrokerCostSettings,
} from './broker-cost-settings';

let store: Map<string, string>;
beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => { vi.unstubAllGlobals(); });

const base = (over: Partial<TradingCostSettings> = {}): TradingCostSettings => ({ ...DEFAULT_TRADING_COST_SETTINGS, ...over });

describe('券商判斷', () => {
    it('玉山帳戶（884x、-SIM）→ esun；永豐、帳戶不明 → sinopac', () => {
        expect(brokerOfAccount({ broker_id: '8840' })).toBe('esun');
        expect(brokerOfAccount({ broker_id: '884A-SIM' })).toBe('esun');
        expect(brokerOfAccount({ broker_id: '9A95' })).toBe('sinopac');
        expect(brokerOfAccount(null)).toBe('sinopac');
        expect(brokerOfAccount(undefined)).toBe('sinopac');
    });
    it('accountKey 以最後一個冒號切開', () => {
        expect(brokerOfAccountKey('8840:0011223')).toBe('esun');
        expect(brokerOfAccountKey('884A-SIM:0011223')).toBe('esun');
        expect(brokerOfAccountKey('9A95:1234567')).toBe('sinopac');
        expect(brokerOfAccountKey('')).toBe('sinopac');
    });
});

describe('sanitizeBrokerCostOverrides', () => {
    it('折數 (0, 1]、退佣方式只接受 monthly／instant；不合法的券商整筆忽略', () => {
        expect(sanitizeBrokerCostOverrides({
            sinopac: { feeDiscount: 0.6, rebateMode: 'monthly' },
            esun: { feeDiscount: 0.28, rebateMode: 'instant' },
        })).toEqual({ sinopac: { feeDiscount: 0.6, rebateMode: 'monthly' }, esun: { feeDiscount: 0.28, rebateMode: 'instant' } });
        expect(sanitizeBrokerCostOverrides({ sinopac: { feeDiscount: 0, rebateMode: 'monthly' }, esun: { feeDiscount: 0.5, rebateMode: 'x' } })).toEqual({});
        expect(sanitizeBrokerCostOverrides({ esun: { feeDiscount: 1.01, rebateMode: 'monthly' }, other: { feeDiscount: 0.5, rebateMode: 'monthly' } })).toEqual({});
        expect(sanitizeBrokerCostOverrides({ esun: { feeDiscount: 1, rebateMode: 'monthly' } })).toEqual({ esun: { feeDiscount: 1, rebateMode: 'monthly' } });
        expect(sanitizeBrokerCostOverrides(null)).toEqual({});
        expect(sanitizeBrokerCostOverrides([1, 2])).toEqual({});
        expect(sanitizeBrokerCostOverrides({ esun: { feeDiscount: NaN, rebateMode: 'monthly' } })).toEqual({});
    });
    it('壞掉的 JSON 當成沒有覆寫', () => {
        store.set(BROKER_COST_SETTINGS_KEY, '{oops');
        expect(getBrokerCostOverrides()).toEqual({});
    });
});

describe('costSettingsFor', () => {
    it('沒有覆寫時回傳 base 本身；有覆寫只換折數與退佣方式，融資年利率、借券費率沿用共用', () => {
        const b = base({ feeDiscount: 0.6, marginAnnualRate: 0.0645, shortFeeRate: 0.001 });
        expect(costSettingsFor(b, {}, 'esun')).toBe(b);
        const e = costSettingsFor(b, { esun: { feeDiscount: 0.28, rebateMode: 'instant' } }, 'esun');
        expect(e).toEqual({ feeDiscount: 0.28, rebateMode: 'instant', marginAnnualRate: 0.0645, shortFeeRate: 0.001 });
        expect(costSettingsFor(b, { esun: { feeDiscount: 0.28, rebateMode: 'instant' } }, 'sinopac')).toBe(b);
    });
});

describe('setBrokerFeeSettings／resetBrokerCostSettings', () => {
    beforeEach(() => {
        resetTradingCostSettings();
        resetBrokerCostSettings();
    });

    it('第一次寫入以目前共用設定補齊另一個欄位；兩家互不影響', () => {
        setTradingCostSettings({ feeDiscount: 0.6, rebateMode: 'monthly' });
        expect(setBrokerFeeSettings('esun', { feeDiscount: 0.28 })).toBe(true);
        expect(getBrokerCostOverrides()).toEqual({ esun: { feeDiscount: 0.28, rebateMode: 'monthly' } });
        expect(setBrokerFeeSettings('sinopac', { rebateMode: 'instant' })).toBe(true);
        expect(getBrokerCostOverrides()).toEqual({
            esun: { feeDiscount: 0.28, rebateMode: 'monthly' },
            sinopac: { feeDiscount: 0.6, rebateMode: 'instant' },
        });
        // 之後再改共用設定不影響已覆寫的券商
        setTradingCostSettings({ feeDiscount: 0.5 });
        expect(getBrokerCostOverrides().esun).toEqual({ feeDiscount: 0.28, rebateMode: 'monthly' });
        expect(JSON.parse(store.get(BROKER_COST_SETTINGS_KEY)!)).toEqual(getBrokerCostOverrides());
    });

    it('不合法的 patch 不寫入並回 false', () => {
        const calls = vi.fn();
        const off = subscribeBrokerCostOverrides(calls);
        expect(setBrokerFeeSettings('esun', { feeDiscount: 0 })).toBe(false);
        expect(setBrokerFeeSettings('esun', { feeDiscount: 1.5 })).toBe(false);
        expect(setBrokerFeeSettings('esun', { rebateMode: 'weekly' as never })).toBe(false);
        expect(getBrokerCostOverrides()).toEqual({});
        expect(calls).not.toHaveBeenCalled();
        expect(setBrokerFeeSettings('esun', { feeDiscount: 0.3 })).toBe(true);
        expect(calls).toHaveBeenCalledTimes(1);
        off();
    });

    it('同一份儲存內容回傳同一個物件；還原清掉兩家覆寫', () => {
        setBrokerFeeSettings('esun', { feeDiscount: 0.28 });
        setBrokerFeeSettings('sinopac', { feeDiscount: 0.6 });
        const a = getBrokerCostOverrides();
        expect(getBrokerCostOverrides()).toBe(a);
        resetBrokerCostSettings();
        expect(getBrokerCostOverrides()).toEqual({});
    });

    it('localStorage 不可用時只在本次有效（記憶體後備）', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('denied'); },
            setItem: () => { throw new Error('denied'); },
        });
        expect(setBrokerFeeSettings('esun', { feeDiscount: 0.28 })).toBe(true);
        expect(getBrokerCostOverrides().esun?.feeDiscount).toBe(0.28);
        resetBrokerCostSettings();
    });
});

describe('useBrokerCostSettings', () => {
    beforeEach(() => {
        resetTradingCostSettings();
        resetBrokerCostSettings();
    });

    it('輸入不變時物件身分不變；覆寫或共用設定改變時更新', async () => {
        const seen: ReturnType<typeof useBrokerCostSettings>[] = [];
        function Probe() {
            seen.push(useBrokerCostSettings());
            return null;
        }
        let view: ReturnType<typeof create> | undefined;
        await act(async () => { view = create(createElement(Probe)); });
        await act(async () => { view!.update(createElement(Probe)); });
        expect(seen.length).toBeGreaterThanOrEqual(2);
        expect(seen[seen.length - 1]).toBe(seen[0]);
        expect(seen[0]!.sinopac).toBe(seen[0]!.esun); // 都沒覆寫：同一個共用設定物件

        await act(async () => { setBrokerFeeSettings('esun', { feeDiscount: 0.28 }); });
        const after = seen[seen.length - 1]!;
        expect(after).not.toBe(seen[0]);
        expect(after.esun.feeDiscount).toBe(0.28);
        expect(after.sinopac.feeDiscount).toBe(1);

        await act(async () => { setTradingCostSettings({ marginAnnualRate: 0.07 }); });
        const last = seen[seen.length - 1]!;
        expect(last.esun.marginAnnualRate).toBe(0.07);
        expect(last.sinopac.marginAnnualRate).toBe(0.07);
        expect(last.esun.feeDiscount).toBe(0.28);
        await act(async () => view!.unmount());
    });
});
