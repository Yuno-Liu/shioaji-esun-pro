// fork：已實現損益明細的退佣列、今日預估退佣與牌告手續費提示。帳號、委託書號、金額皆為合成值。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEsunTransactionDetails, parseEsunTransactionDetail, setEsunTransactionDetails } from '../lib/esun/account-details';
import { setPrivacyMoney } from '../lib/privacy';
import { setTradingCostSettings, type TradingCostSettings } from '../lib/trading-cost-settings';
import { todayStr } from '../lib/utils/date';
import { EsunPnlCostTotal, EsunTransactionDetailView, esunFeesLookListRate, esunFillRebate, type EsunPnlRow } from './esun-pnl-details';

const account = { broker_id: '8840', account_id: 'TEST001' };
const fill = (over: Record<string, unknown>) => ({
    stk_no: '9901', buy_sell: 'S', trade: '0', s_type: 'H', order_no: 'Z0001', t_date: '20261026', t_time: '101530', c_date: '20261028',
    price: '100', qty: '500', price_qty: '50000', fee: '71', db_fee: '0', tax: '150', tax_g: '0', pay_n: '49779', make: '2500', make_per: '5.26',
    ...over,
});
// 價金 100,000：手續費 71 ＋ 72 ＝ 143 ≈ 100,000 × 0.1425%（牌告）
const detailOf = (fees: [string, string] = ['71', '72'], rowId = 1, make = '5000') => parseEsunTransactionDetail({
    stk_no: '9901', stk_na: '測試股', buy_sell: 'S', trade: '0', s_type: 'H', t_date: '20261026', c_date: '20261028',
    qty: '1000', price_avg: '100', price_qty: '100000', cost: '-95143', recv: '99557', make, make_per: '5.26',
    mat_dats: [fill({ fee: fees[0] }), fill({ order_no: 'Z0002', fee: fees[1], t_time: '102000' })],
}, rowId);

let view: ReactTestRenderer | undefined;
const textOf = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const allText = () => textOf(view!.root);
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    setPrivacyMoney(false);
    clearEsunTransactionDetails();
    vi.unstubAllGlobals();
});
const settings = async (patch: Partial<TradingCostSettings>) => {
    await act(async () => { expect(setTradingCostSettings(patch)).toBe(true); });
};

describe('EsunTransactionDetailView', () => {
    it('預設（月退、無折扣）不顯示退佣與提示', async () => {
        await act(async () => { view = create(createElement(EsunTransactionDetailView, { detail: detailOf() })); });
        expect(allText()).not.toContain('退佣');
        expect(allText()).not.toContain('牌告手續費');
    });

    it('月退 6 折：預估退佣＝143 − round(85.8)＝57，含退佣損益＝5,000 ＋ 57', async () => {
        await settings({ feeDiscount: 0.6 });
        await act(async () => { view = create(createElement(EsunTransactionDetailView, { detail: detailOf() })); });
        const text = allText();
        expect(text).toContain('預估退佣（月退 6 折）≈ $57');
        expect(text).toContain('含退佣損益≈ +5,057');
        // 原本的已實現損益不變
        expect(text).toContain('已實現損益+5,000');
        expect(text).not.toContain('券商實際收取牌告手續費');
    });

    it('即折：不調整數字；手續費接近牌告時提示改用月退', async () => {
        await settings({ feeDiscount: 0.6, rebateMode: 'instant' });
        await act(async () => { view = create(createElement(EsunTransactionDetailView, { detail: detailOf() })); });
        expect(allText()).not.toContain('預估退佣');
        expect(allText()).toContain('券商實際收取牌告手續費，若為事後退佣請將退佣方式設為月退');
    });

    it('即折且資料手續費已打折時不提示', async () => {
        await settings({ feeDiscount: 0.6, rebateMode: 'instant' });
        await act(async () => { view = create(createElement(EsunTransactionDetailView, { detail: detailOf(['43', '43']) })); });
        expect(allText()).not.toContain('牌告手續費');
    });

    it('金額遮蔽也蓋住退佣', async () => {
        await settings({ feeDiscount: 0.6 });
        setPrivacyMoney(true);
        await act(async () => { view = create(createElement(EsunTransactionDetailView, { detail: detailOf() })); });
        expect(allText()).toContain('預估退佣（月退 6 折）');
        expect(allText()).not.toContain('5,057');
    });
});

describe('純函式', () => {
    it('esunFillRebate 只在月退且折數 < 1 時有值', () => {
        const d = detailOf();
        const S = (over: Partial<TradingCostSettings>): TradingCostSettings => ({ feeDiscount: 1, rebateMode: 'monthly', marginAnnualRate: null, shortFeeRate: 0.0008, ...over });
        expect(esunFillRebate(d.fills, S({}))).toBeNull();
        expect(esunFillRebate(d.fills, S({ feeDiscount: 0.6, rebateMode: 'instant' }))).toBeNull();
        expect(esunFillRebate(d.fills, S({ feeDiscount: 0.6 }))).toBe(57);
        expect(esunFillRebate(parseEsunTransactionDetail({ mat_dats: [{ fee: '' }] }, 1).fills, S({ feeDiscount: 0.6 }))).toBeNull();
    });
    it('esunFeesLookListRate：誤差 2 元內', () => {
        expect(esunFeesLookListRate(detailOf(['71', '72']).fills)).toBe(true);
        expect(esunFeesLookListRate(detailOf(['70', '71']).fills)).toBe(true);
        expect(esunFeesLookListRate(detailOf(['70', '70']).fills)).toBe(false);
        expect(esunFeesLookListRate([])).toBe(false);
    });
});

describe('EsunPnlCostTotal', () => {
    const rowOf = (id: number): EsunPnlRow => ({ id, code: '9901', date: '20261026', market: 'S', accountKey: `${account.broker_id}:${account.account_id}` }) as unknown as EsunPnlRow;
    const seed = () => {
        const today = todayStr();
        act(() => { setEsunTransactionDetails(account, today, today, [detailOf(['71', '72'], 1), detailOf(['200', '200'], 2)]); });
    };

    it('月退時加列今日預估退佣（逐列合計）', async () => {
        seed();
        await settings({ feeDiscount: 0.6 });
        await act(async () => { view = create(createElement(EsunPnlCostTotal, { rows: [rowOf(1), rowOf(2)] })); });
        // 列 1：143 → 57；列 2：400 − 240 = 160；合計 217
        expect(allText()).toContain('今日預估退佣（月退 6 折）≈ $217');
        // 交易成本合計不變：(143 + 300) ＋ (400 + 300)
        expect(allText()).toContain('今日交易成本合計（玉山）$1,143');
    });

    it('即折或無折扣時不顯示今日預估退佣', async () => {
        seed();
        await act(async () => { view = create(createElement(EsunPnlCostTotal, { rows: [rowOf(1), rowOf(2)] })); });
        expect(allText()).not.toContain('預估退佣');
        await settings({ feeDiscount: 0.6, rebateMode: 'instant' });
        expect(allText()).not.toContain('預估退佣');
        await settings({ rebateMode: 'monthly' });
        expect(allText()).toContain('今日預估退佣（月退 6 折）≈ $217');
    });
});
