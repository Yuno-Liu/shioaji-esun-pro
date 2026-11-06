// 玉山庫存明細（手機持倉展開區）：沒有快照／對不上時提示更新；現股成本推導、分批明細、預估退佣；
// 融資利息（估）、借券費（估）；遮蔽金額。使用真實的庫存明細 store 與交易成本設定（不打任何 API）。
// 測試資料全部合成：帳號、委託書號、金額皆為虛構。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEsunInventoryDetails, parseEsunInventoryDetails, setEsunInventoryDetails } from '../../lib/esun/account-details';
import { setPrivacyMoney } from '../../lib/privacy';
import { resetTradingCostSettings, setTradingCostSettings } from '../../lib/trading-cost-settings';
import type { Account, StockPosition } from '../../lib/types/portfolio';
import { ESUN_DETAIL_TEXT, PositionEsunDetails } from './position-esun-details';

const esunAccount: Account = { account_type: 'S', broker_id: '8840', account_id: 'TEST001', signed: true, person_id: '', username: '' };
const position = (over: Partial<StockPosition> = {}): StockPosition & { account: Account } => ({
    account: esunAccount, id: 1, code: '9901', direction: 'Buy', quantity: 9000, price: 54.9, last_price: 55.2, pnl: -201, yd_quantity: 9000, cond: 'Cash', ...over,
});

const lot = (over: Record<string, unknown> = {}) => ({
    buy_sell: 'B', trade: '0', t_date: '20261020', t_time: '093015', price: '54.90', qty: '5000',
    qty_c: '0', qty_h: '0', qty_r: '0', cost_r: '0', fee: '391', tax: '0', tax_g: '0', pay_n: '-274891',
    price_evn: '55.18', make_a: '-111', make_a_per: '-0.04', value_mkt: '276000', value_now: '276000', ord_no: 'Z0001', user_def: '',
    ...over,
});
// 價金 494,100 ＋ 買進手續費 703 ＝ 成本 494,803；市值 496,800 − 預估賣出費稅 2,197 ＝ 未實現收入 494,603；494,603 − 494,803 ＝ −200
const inventory = (over: Record<string, unknown> = {}, lots: unknown[] = [lot(), lot({ ord_no: 'Z0002', qty: '4000', fee: '312', pay_n: '-219912', make_a: '-89', value_mkt: '220800', value_now: '220800', t_time: '101500' })]) => ({
    stk_no: '9901', stk_na: '測試股', trade: '0', s_type: 'H', ap_code: '', cost_qty: '9000', cost_sum: '-494803', price_avg: '54.90',
    price_evn: '55.18', price_mkt: '55.20', price_now: '55.20', price_qty_sum: '494100', qty_l: '9000', qty_b: '1000', qty_bm: '0',
    qty_s: '0', qty_sm: '0', qty_c: '0', rec_va_sum: '494603', value_mkt: '496800', value_now: '496800', make_a_sum: '-200', make_a_per: '-0.04',
    stk_dats: lots, ...over,
});

let view: ReactTestRenderer | undefined;
async function render(p = position()) {
    await act(async () => { view = create(createElement(PositionEsunDetails, { position: p })); });
}
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const all = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => view!.root.find(n => n.props['data-testid'] === id && typeof n.type === 'string');
const store = (rows: unknown[]) => setEsunInventoryDetails(esunAccount, parseEsunInventoryDetails(rows), new Date(2026, 10, 6, 9, 30, 0).getTime());

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 6, 10, 0, 0));
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    clearEsunInventoryDetails();
    resetTradingCostSettings();
    setPrivacyMoney(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('PositionEsunDetails', () => {
    it('沒有庫存快照：提示按「⟳」更新持倉（帳務）', async () => {
        await render();
        expect(textOf(one('esun-detail-empty'))).toBe(ESUN_DETAIL_TEXT.noSnapshot);
    });

    it('有快照但對不上這筆持倉：提示更新，不顯示錯列的明細', async () => {
        store([inventory({ stk_no: '9902' })]);
        await render();
        expect(textOf(one('esun-detail-empty'))).toBe(ESUN_DETAIL_TEXT.noMatch);
        expect(all('esun-detail')).toHaveLength(0);
    });

    it('現股：成本推導三式、損益平衡價、分批明細（日期、股數、價格、手續費、稅、損益平衡價）、快照時間', async () => {
        store([inventory()]);
        await render();
        const formula = textOf(one('esun-detail-formula'));
        expect(formula).toContain('價金 494,100 ＋ 買進手續費 703 ＝ 成本 494,803');
        expect(formula).toContain('市值 496,800 − 預估賣出費稅 2,197 ＝ 未實現收入 494,603');
        expect(formula).toContain('未實現損益 -200');
        expect(textOf(one('esun-detail-breakeven'))).toBe('55.18');
        const lots = all('esun-detail-lot').map(textOf);
        expect(lots).toHaveLength(2);
        expect(lots[0]).toContain('2026-10-20 09:30:15');
        expect(lots[0]).toContain('買進');
        expect(lots[0]).toContain('5,000');
        expect(lots[0]).toContain('54.90');
        expect(lots[0]).toContain('391');
        expect(lots[0]).toContain('交易稅');
        expect(lots[1]).toContain('4,000');
        expect(textOf(one('esun-detail'))).toContain('券商快照 09:30:00');
        // 預設設定（無折扣）沒有退佣
        expect(all('esun-detail-rebate')).toHaveLength(0);
    });

    it('現股月退折扣：顯示預估退佣（估）', async () => {
        setTradingCostSettings({ feeDiscount: 0.6, rebateMode: 'monthly' });
        store([inventory()]);
        await render();
        expect(textOf(one('esun-detail-rebate'))).toMatch(/^≈ \d/);
        expect(textOf(one('esun-detail'))).toContain('預估退佣（月退 6 折）');
    });

    it('推導與券商數字不一致：只列各欄位並說明', async () => {
        store([inventory({ cost_sum: '-500000' })]);
        await render();
        expect(all('esun-detail-formula')).toHaveLength(0);
        expect(textOf(one('esun-detail'))).toContain('券商數字與推導相差超過 1 元');
    });

    it('融資：融資利息（估）；未設定年利率時說明無法估算', async () => {
        const marginLot = lot({ trade: '3' });
        store([inventory({ trade: '3', cost_qty: '5000', price_qty_sum: '274500', cost_sum: '-110391' }, [marginLot])]);
        const p = position({ cond: 'MarginTrading', quantity: 5000 });
        await render(p);
        expect(textOf(one('esun-detail-interest'))).toBe('—');
        expect(textOf(one('esun-detail'))).toContain('未設定融資年利率');
        await act(async () => view?.unmount());

        setTradingCostSettings({ marginAnnualRate: 0.065 });
        await render(p);
        expect(textOf(one('esun-detail-interest'))).toMatch(/^≈ \d/);
        expect(textOf(one('esun-detail'))).toContain('融資金額合計（估）');
        expect(textOf(one('esun-detail-lots'))).toContain('融資利息（估）');
    });

    it('融券：借券費（估）＝價金 × 借券費率（預設 0.08%）', async () => {
        store([inventory({ trade: '4', cost_qty: '5000', price_qty_sum: '274500' }, [lot({ trade: '4', buy_sell: 'S' })])]);
        await render(position({ cond: 'ShortSelling', direction: 'Sell', quantity: 5000 }));
        expect(textOf(one('esun-detail-short-fee'))).toBe('≈ 220'); // 274,500 × 0.08% = 219.6
        expect(textOf(one('esun-detail'))).toContain('借券費率 0.08%');
    });

    it('遮蔽金額：價金、成本、股數、退佣都遮蔽', async () => {
        setTradingCostSettings({ feeDiscount: 0.6, rebateMode: 'monthly' });
        setPrivacyMoney(true);
        store([inventory()]);
        await render();
        const text = textOf(one('esun-detail'));
        expect(text).not.toContain('494,100');
        expect(text).not.toContain('5,000');
        expect(text).not.toContain('55.18');
        expect(textOf(one('esun-detail-rebate'))).toBe('•••••');
    });
});
