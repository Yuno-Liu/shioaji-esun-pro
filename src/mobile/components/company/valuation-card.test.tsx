// 「估值與體質」卡的缺資料與負值呈現：合成財報檔（同 v1 欄位名稱），驗證每格缺資料時顯示「—」＋簡短原因、
// 虧損與每股淨值為負時不算比值、金融業格式不顯示毛利與營業利益欄、離線快取標示。即時報價以替身控制。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyDataView } from '../../../hooks/use-company-data';
import type { DataMeta } from '../../../lib/company-data';
import type { Company, Financials, MarketDaily, StatementTable } from '../../../lib/company-data/types';
import type { ContractInfo } from '../../../lib/types/contract';

const m = vi.hoisted(() => ({ quote: undefined as unknown, useQuote: vi.fn() }));
vi.mock('../../../hooks/use-stream', () => ({ useQuote: m.useQuote }));
vi.mock('../../../lib/market-snapshot-store', () => ({ getMarketSnapshot: () => undefined, subscribeMarketSnapshots: () => () => undefined }));

import { ValuationCard } from './valuation-card';

const contract = {
    exchange: 'TSE', code: '9999', security_type: 'STK', target_code: null, name: '測試', currency: 'TWD',
    limit_up: 110, limit_down: 90, reference: 100, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as ContractInfo;

const PERIODS = ['2025Q1', '2025Q2', '2025Q3', '2025Q4', '2026Q1', '2026Q2'];
const series = (...values: (number | null)[]) => values;

function financials(over: {
    income?: StatementTable;
    ytd?: StatementTable;
    balance?: StatementTable;
    cash?: StatementTable;
    format?: string;
    periods?: string[];
} = {}): Financials {
    const periods = over.periods ?? PERIODS;
    return {
        code: '9999',
        name: '測試',
        market: 'twse',
        monthly_revenue: [],
        statements: {
            periods,
            format: periods.map(() => over.format ?? 'general'),
            income_quarter: over.income ?? {
                營業收入: series(1e6, 1e6, 1e6, 1e6, 1e6, 1e6),
                '營業毛利（毛損）淨額': series(3e5, 3e5, 3e5, 3e5, 3e5, 3e5),
                '營業利益（損失）': series(1e5, 1e5, 1e5, 1e5, 1e5, 1e5),
                '本期淨利（淨損）': series(5e4, 5e4, 5e4, 5e4, 5e4, 5e4),
            },
            income_ytd: over.ytd ?? { '基本每股盈餘（元）': series(0.5, 1, 1.5, 2, 0.6, 1.2) },
            balance: over.balance ?? {
                資產總計: series(1e7, 1e7, 1e7, 1e7, 1e7, 1e7),
                負債總計: series(4e6, 4e6, 4e6, 4e6, 4e6, 4e6),
                每股參考淨值: series(20, 20, 20, 20, 20, 25),
            },
            cash_flow_quarter: over.cash ?? { '營業活動之淨現金流入（流出）': series(4e4, 4e4, 4e4, 4e4, 4e4, 4e4) },
            cash_flow_ytd: {},
        },
    };
}

const meta = (stale = false) => ({ releaseId: 'r1', asOf: '2026-08-14', stale, officialFetchedAt: null }) as unknown as DataMeta;
const market = (close: number | null): MarketDaily =>
    ({ as_of: {}, quotes: close === null ? {} : { 9999: { close, date: '2026-10-20', market_cap_twd: 1, shares: 1 } } }) as unknown as MarketDaily;

function viewOf(fin: Financials | null, opts: { close?: number | null; stale?: boolean } = {}): CompanyDataView {
    return {
        code: '9999',
        company: { code: '9999', name: '測試' } as Company,
        meta: meta(),
        financials: fin,
        financialsMeta: fin ? meta(opts.stale) : null,
        financialsError: null,
        themes: null,
        themesMeta: null,
        market: market(opts.close === undefined ? 50 : opts.close),
        marketMeta: meta(),
        sources: null,
        sourcesMeta: null,
    };
}

let r: ReactTestRenderer | undefined;
const text = (n: ReactTestInstance | string): string =>
    typeof n === 'string' ? n : n.children.map(k => text(k as ReactTestInstance | string)).join('');
const all = (id: string) => r!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => {
    const hits = all(id);
    expect(hits, id).toHaveLength(1);
    return hits[0]!;
};
const value = (id: string) => text(one(`company-valuation-${id}`).findAllByType('dd')[0]!);
const sub = (id: string) => text(one(`company-valuation-${id}`).findAllByType('dd')[1]!);

async function render(view: CompanyDataView, active = true) {
    await act(async () => { r = create(createElement(ValuationCard, { view, contract, viaUnderlying: false, active })); });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.quote = undefined;
    m.useQuote.mockReset().mockImplementation(() => m.quote);
});
afterEach(async () => {
    await act(async () => r?.unmount());
    r = undefined;
    vi.unstubAllGlobals();
});

describe('估值與體質卡', () => {
    it('完整資料：P/B＝收盤 ÷ 最新一季每股淨值；負債比；盈餘品質低於淨利（文字）；累計 EPS 對照去年同期', async () => {
        await render(viewOf(financials()));
        expect(value('pb')).toBe('2.00 倍');
        expect(sub('pb')).toBe('每股淨值 25.00（2026Q2） · 收盤 2026-10-20');
        expect(value('debt')).toBe('40.0%');
        expect(value('quality')).toBe('0.80 倍');
        expect(sub('quality')).toBe('營業現金流低於淨利');
        expect(text(one('company-valuation-quality-detail'))).toBe('近四季（2025Q3–2026Q2）營業現金流合計 1.6 億元，低於淨利合計 2.0 億元');
        expect(value('ytd-eps')).toBe('1.20 元');
        expect(sub('ytd-eps')).toBe('2026 年前 2 季 · 去年同期 1.00，年增 +20.0%');
        expect(all('company-stale-tag')).toHaveLength(0);
    });

    it('缺資料：每格「—」＋原因；沒有季報時金額表顯示「沒有季報資料」', async () => {
        await render(viewOf(financials({ periods: [], income: {}, ytd: {}, balance: {}, cash: {} })));
        for (const id of ['pb', 'debt', 'quality', 'ytd-eps']) expect(value(id), id).toBe('—');
        expect(sub('pb')).toBe('沒有季報');
        expect(sub('debt')).toBe('沒有季報');
        expect(sub('quality')).toBe('季報不足四季');
        expect(sub('ytd-eps')).toBe('沒有季報');
        expect(all('company-valuation-quality-detail')).toHaveLength(0);
        expect(text(one('company-profit-empty'))).toBe('沒有季報資料');
        expect(all('company-profit-table')).toHaveLength(0);
    });

    it('欄位缺值：沒有每股淨值、沒有資產負債、某季沒有營業現金流、沒有去年同期', async () => {
        const fin = financials({
            balance: { 資產總計: series(1e7, 1e7, 1e7, 1e7, 1e7, null) },
            cash: { '營業活動之淨現金流入（流出）': series(4e4, 4e4, 4e4, null, 4e4, 4e4) },
            ytd: { '基本每股盈餘（元）': series(null, null, 1.5, 2, 0.6, 1.2) },
        });
        await render(viewOf(fin));
        expect(value('pb')).toBe('—');
        expect(sub('pb')).toBe('2026Q2 沒有每股淨值');
        expect(value('debt')).toBe('—');
        expect(sub('debt')).toBe('2026Q2 沒有資產或負債總計');
        expect(value('quality')).toBe('—');
        expect(sub('quality')).toBe('2025Q4 沒有營業現金流');
        expect(value('ytd-eps')).toBe('1.20 元');
        expect(sub('ytd-eps')).toBe('2026 年前 2 季 · 沒有去年同期資料');
    });

    it('沒有股價（沒有成交也沒有收盤）：P/B「—」但仍附每股淨值', async () => {
        await render(viewOf(financials(), { close: null }));
        expect(value('pb')).toBe('—');
        expect(sub('pb')).toBe('沒有股價 · 每股淨值 25.00（2026Q2）');
    });

    it('負值：每股淨值為負、近四季虧損、去年同期虧損；虧損金額帶負號', async () => {
        const fin = financials({
            income: {
                營業收入: series(1e6, 1e6, 1e6, 1e6, 1e6, 0),
                '營業毛利（毛損）淨額': series(3e5, 3e5, 3e5, 3e5, 3e5, -2e5),
                '營業利益（損失）': series(1e5, 1e5, 1e5, 1e5, 1e5, -3e5),
                '本期淨利（淨損）': series(5e4, 5e4, 5e4, -5e4, -5e4, -1.23e6),
            },
            balance: { 資產總計: series(1e7, 1e7, 1e7, 1e7, 1e7, 1e7), 負債總計: series(0, 0, 0, 0, 0, 0), 每股參考淨值: series(1, 1, 1, 1, 1, -0.5) },
            ytd: { '基本每股盈餘（元）': series(0.5, -0.2, 0.1, 0.3, -0.1, -0.4) },
        });
        await render(viewOf(fin));
        expect(value('pb')).toBe('—');
        expect(sub('pb')).toBe('每股淨值為負，不適用 · 每股淨值 -0.50（2026Q2）');
        expect(value('debt')).toBe('0.0%');
        expect(value('quality')).toBe('—');
        expect(sub('quality')).toBe('近四季淨利合計為虧損，比值不適用；營業現金流高於淨利');
        expect(text(one('company-valuation-quality-detail'))).toBe('近四季（2025Q3–2026Q2）營業現金流合計 1.6 億元，高於淨利合計 -12.8 億元');
        expect(value('ytd-eps')).toBe('-0.40 元');
        expect(sub('ytd-eps')).toBe('2026 年前 2 季 · 去年同期 -0.20 · 去年同期為虧損，不計成長率');
        const top = one('company-profit-table').findAllByType('tr')[1]!.findAllByType('td').map(text);
        expect(top).toEqual(['2026Q2', '0.00', '-2.0', '-3.0', '-12.3']);
    });

    it('金融業格式（沒有毛利、營業利益）：金額表不顯示那兩欄', async () => {
        const fin = financials({
            format: 'bank',
            income: { 淨收益: series(1e6, 1e6, 1e6, 1e6, 1e6, 1e6), '本期稅後淨利（淨損）': series(5e4, 5e4, 5e4, 5e4, 5e4, 5e4) },
        });
        await render(viewOf(fin));
        expect(one('company-profit-table').findAllByType('th').map(text)).toEqual(['季別', '營收', '淨利']);
    });

    it('財報來自離線快取：卡片標頭顯示「快取」；有即時成交時 P/B 改用即時價', async () => {
        m.quote = { tick: { code: '9999', close: '60', price_chg: '10' } };
        await render(viewOf(financials(), { stale: true }));
        expect(all('company-stale-tag')).toHaveLength(1);
        expect(value('pb')).toBe('2.40 倍');
        expect(sub('pb')).toContain('即時價');
        for (const [code] of m.useQuote.mock.calls) expect(code).toBe('9999');
    });

    it('分頁隱藏（active=false）：不訂閱報價，P/B 用收盤', async () => {
        m.quote = { tick: { code: '9999', close: '60', price_chg: '10' } };
        await render(viewOf(financials()), false);
        expect(m.useQuote.mock.calls.at(-1)![0]).toBeNull();
        expect(value('pb')).toBe('2.00 倍');
    });

    it('沒有財報檔：不渲染', async () => {
        await render(viewOf(null));
        expect(r!.toJSON()).toBeNull();
    });
});
