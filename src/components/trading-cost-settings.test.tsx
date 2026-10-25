// fork：設定 → 交易成本 的輸入驗證與還原預設。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_TRADING_COST_SETTINGS, getTradingCostSettings, TRADING_COST_SETTINGS_KEY } from '../lib/trading-cost-settings';
import { parseTradingCostField, TradingCostSection } from './trading-cost-settings';

let view!: ReactTestRenderer;
let store: Map<string, string>;
const textOf = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const field = (label: string) => view.root.find(n => n.type === 'input' && n.props['aria-label'] === label);
const button = (label: string) => view.root.find(n => n.type === 'button' && textOf(n).includes(label));
const alerts = () => view.root.findAll(n => n.type === 'span' && n.props.role === 'alert').map(textOf);
const type = async (label: string, value: string) => {
    await act(async () => { field(label).props.onChange({ target: { value } }); });
};

beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    await act(async () => { view = create(createElement(TradingCostSection)); });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('顯示預設值與說明', () => {
    expect(field('手續費折數').props.value).toBe('10');
    expect(field('融資年利率').props.value).toBe('');
    expect(field('借券費率').props.value).toBe('0.08');
    expect(button('月退').props['aria-pressed']).toBe(true);
    const text = textOf(view.root);
    for (const s of ['6 折填 6、2.8 折填 2.8、無折扣填 10', '交割時以牌告手續費收取，事後退回', '玉山實際交割資料顯示收取牌告手續費',
        '空白＝未設定，未設定時不估算融資利息', '融券賣出時收取，預設法定 0.08%', '鋪單面板另有獨立的手續費設定']) {
        expect(text).toContain(s);
    }
});

it('合法輸入寫入設定（折數 2.8 → 0.28、年利率 6.45% → 0.0645、借券費率 0.1% → 0.001）', async () => {
    await type('手續費折數', '2.8');
    await type('融資年利率', '6.45');
    await type('借券費率', '0.1');
    await act(async () => { button('成交即折').props.onClick(); });
    expect(alerts()).toEqual([]);
    expect(getTradingCostSettings()).toEqual({ feeDiscount: 0.28, rebateMode: 'instant', marginAnnualRate: 0.0645, shortFeeRate: 0.001 });
    expect(JSON.parse(store.get(TRADING_COST_SETTINGS_KEY)!)).toEqual(getTradingCostSettings());
    // 清空年利率＝未設定
    await type('融資年利率', '');
    expect(getTradingCostSettings().marginAnnualRate).toBeNull();
});

it('不合法輸入不寫入並提示；改回合法值後提示消失', async () => {
    await type('手續費折數', '6');
    expect(getTradingCostSettings().feeDiscount).toBe(0.6);
    for (const bad of ['0', '11', 'abc', '', '-1']) {
        await type('手續費折數', bad);
        expect(getTradingCostSettings().feeDiscount).toBe(0.6);
        expect(field('手續費折數').props.value).toBe(bad);
        expect(alerts()).toEqual(['手續費折數需大於 0 且不超過 10（無折扣填 10）']);
    }
    await type('融資年利率', '31');
    await type('借券費率', '1.5');
    expect(getTradingCostSettings()).toEqual({ ...DEFAULT_TRADING_COST_SETTINGS, feeDiscount: 0.6 });
    expect(alerts()).toEqual(['手續費折數需大於 0 且不超過 10（無折扣填 10）', '融資年利率需介於 0～30%，或留空表示未設定', '借券費率需介於 0～1%']);
    await type('手續費折數', '10');
    expect(getTradingCostSettings().feeDiscount).toBe(1);
    expect(alerts()).toHaveLength(2);
});

it('還原預設：設定、輸入框與提示一起重設', async () => {
    await type('手續費折數', '6');
    await type('融資年利率', '7');
    await type('借券費率', 'x');
    await act(async () => { button('成交即折').props.onClick(); });
    await act(async () => { button('還原預設').props.onClick(); });
    expect(getTradingCostSettings()).toEqual(DEFAULT_TRADING_COST_SETTINGS);
    expect(field('手續費折數').props.value).toBe('10');
    expect(field('融資年利率').props.value).toBe('');
    expect(field('借券費率').props.value).toBe('0.08');
    expect(button('月退').props['aria-pressed']).toBe(true);
    expect(alerts()).toEqual([]);
});

it('parseTradingCostField 邊界', () => {
    expect(parseTradingCostField('discount', '10')).toEqual({ patch: { feeDiscount: 1 } });
    expect(parseTradingCostField('discount', ' 0.1 ')).toEqual({ patch: { feeDiscount: 0.01 } });
    expect(parseTradingCostField('margin', '0')).toEqual({ patch: { marginAnnualRate: 0 } });
    expect(parseTradingCostField('margin', '30')).toEqual({ patch: { marginAnnualRate: 0.3 } });
    expect(parseTradingCostField('short', '0')).toEqual({ patch: { shortFeeRate: 0 } });
    expect(parseTradingCostField('short', '1')).toEqual({ patch: { shortFeeRate: 0.01 } });
    expect('error' in parseTradingCostField('short', '')).toBe(true);
});
