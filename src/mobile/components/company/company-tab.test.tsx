// 交易頁「公司」分頁（桌面 company-panel.tsx 的手機版）：以 lib/company-data/__fixtures__ 的假 shioaji-data 主機
// （真實 sha256 驗證路徑）驗證各子分頁、完整性對照、不支援商品、錯誤與重試、關聯公司導覽、外部連結屬性與 S1。
import { createElement, useSyncExternalStore } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../../lib/types/contract';

const m = vi.hoisted(() => ({
    quote: undefined as unknown,
    useQuote: vi.fn(),
    /** 模擬行情 store：tick() 改 quote 並通知訂閱者（同 useQuote 的 useSyncExternalStore 行為） */
    quoteListeners: new Set<() => void>(),
    /** 重繪計數：CompanyView（每次 render 呼叫一次 useCompanyEntities）、財務分頁（quarterMetrics(fin, 8)）、成員名單（tradableCodeOf） */
    viewRenders: 0,
    financialsRenders: 0,
    codeLookups: 0,
    navigate: vi.fn(),
    /** use-live-snapshots 替身：每次呼叫的合約（exchange:code）；liveData 是代碼 → 漲跌幅 */
    liveCalls: [] as string[][],
    liveData: new Map<string, number>(),
    fetchSnapshots: vi.fn(),
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    // S1：lib 的送單／改單／刪單函式（公司分頁任何入口都不得呼叫）
    send: {
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelOrders: vi.fn(),
        cancelVerifiedOrder: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
        submitMobileOrder: vi.fn(),
        placeQuickOrder: vi.fn(),
        cancelAllOrders: vi.fn(),
    },
}));
vi.mock('../../../hooks/use-stream', () => ({ useQuote: m.useQuote }));
vi.mock('../../../hooks/use-live-snapshots', () => ({
    useLiveSnapshots: (contracts: { code: string; exchange: string }[]) => {
        m.liveCalls.push(contracts.map(c => `${c.exchange}:${c.code}`));
        const snapshots = new Map<string, { code: string; change_rate: number }>();
        for (const c of contracts) {
            const rate = m.liveData.get(c.code);
            if (rate !== undefined) snapshots.set(c.code, { code: c.code, change_rate: rate });
        }
        return { snapshots, data: undefined, error: null, loading: false, updatedAt: null, refresh: async () => undefined };
    },
}));
vi.mock('../../../hooks/use-company-data', async importOriginal => {
    const mod = await importOriginal<typeof import('../../../hooks/use-company-data')>();
    return {
        ...mod,
        useCompanyEntities: (...args: Parameters<typeof mod.useCompanyEntities>) => {
            m.viewRenders += 1;
            return mod.useCompanyEntities(...args);
        },
    };
});
vi.mock('../../../lib/company-data', async importOriginal => {
    const mod = await importOriginal<typeof import('../../../lib/company-data')>();
    return {
        ...mod,
        quarterMetrics: (...args: Parameters<typeof mod.quarterMetrics>) => {
            if (args[1] === 8) m.financialsRenders += 1;
            return mod.quarterMetrics(...args);
        },
    };
});
vi.mock('./company-format', async importOriginal => {
    const mod = await importOriginal<typeof import('./company-format')>();
    return {
        ...mod,
        tradableCodeOf: (...args: Parameters<typeof mod.tradableCodeOf>) => {
            m.codeLookups += 1;
            return mod.tradableCodeOf(...args);
        },
    };
});
vi.mock('../../../lib/market-snapshot-store', () => ({ getMarketSnapshot: () => undefined, subscribeMarketSnapshots: () => () => undefined }));
vi.mock('../../lib/hash-router', async importOriginal => ({ ...(await importOriginal<typeof import('../../lib/hash-router')>()), navigate: m.navigate }));
vi.mock('../../lib/mobile-store', () => ({ openTicket: m.openTicket, openOrderAction: m.openOrderAction, setCurrentCode: vi.fn() }));
vi.mock('../../../lib/shioaji', () => ({
    fetchSnapshots: m.fetchSnapshots,
    placeStockOrder: m.send.placeStockOrder,
    placeFuturesOrder: m.send.placeFuturesOrder,
    placeComboOrder: m.send.placeComboOrder,
    cancelOrder: m.send.cancelOrder,
    cancelOrders: m.send.cancelOrders,
    cancelVerifiedOrder: m.send.cancelVerifiedOrder,
    updateOrderPrice: m.send.updateOrderPrice,
    updateOrderQty: m.send.updateOrderQty,
}));
vi.mock('../../lib/mobile-order', () => ({ submitMobileOrder: m.send.submitMobileOrder }));
vi.mock('../../../lib/trade', () => ({ placeQuickOrder: m.send.placeQuickOrder, cancelAllOrders: m.send.cancelAllOrders }));

import { BASE, createFakeHost, type FakeHost } from '../../../lib/company-data/__fixtures__/server';
import { createCompanyDataClient, type CompanyDataClient } from '../../../lib/company-data/client';
import { createMemoryStore } from '../../../lib/company-data/store';
import { fmtPct } from '../../../lib/utils/format';
import { CompanyTab, NO_COMPANY_TEXT, notCoveredText, UNSUPPORTED_DETAIL } from './company-tab';
import { THIRD_PARTY_NOTE } from './company-sections';
import { RELATION_LIVE_LIMIT } from './relation-quotes';

const stock = {
    exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 1070, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as ContractInfo;
const cement = { ...stock, code: '1108', name: '幸福' } as ContractInfo;
const etf = { ...stock, code: '0050', name: '元大台灣50' } as ContractInfo;
const stockFuture = { ...stock, exchange: 'TAIFEX', code: 'CDFR1', security_type: 'FUT', name: '台積電期貨', underlying_code: '2330', underlying_kind: 'S' } as ContractInfo;
const indexFuture = { ...stock, exchange: 'TAIFEX', code: 'TXFR1', security_type: 'FUT', name: '臺股期貨', underlying_code: '#001', underlying_kind: 'I' } as ContractInfo;
const index = { ...stock, exchange: 'TSE', code: '001', security_type: 'IND', name: '加權指數' } as ContractInfo;

let host: FakeHost;
let client: CompanyDataClient;
let view: ReactTestRenderer | undefined;

const text = (n: ReactTestInstance | string): string =>
    typeof n === 'string' ? n : n.children.map(k => text(k as ReactTestInstance | string)).join('');
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string): ReactTestInstance => {
    const hits = all(id);
    expect(hits, id).toHaveLength(1);
    return hits[0]!;
};
const buttons = (): ReactTestInstance[] => view!.root.findAll(n => n.type === 'button');
const press = (node: ReactTestInstance) => act(async () => { node.props.onClick(); });
const tab = (id: 'overview' | 'financials' | 'relations' | 'sources') => press(one(`company-tab-${id}`));
const fileRequests = () => host.requests.filter(u => !u.includes('manifest.json')).map(u => u.slice(BASE.length).split('?')[0]);

async function waitFor(pred: () => boolean, label: string) {
    for (let i = 0; i < 100 && !pred(); i += 1) {
        await act(async () => { await new Promise(r => setTimeout(r, 2)); });
    }
    expect(pred(), label).toBe(true);
}

async function render(contract: ContractInfo | undefined) {
    await act(async () => { view = create(createElement(CompanyTab, { contract, client })); });
}
async function renderReady(contract: ContractInfo) {
    await render(contract);
    await waitFor(() => all('company-tab').length === 1, 'company-tab ready');
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = createFakeHost();
    client = createCompanyDataClient({ baseUrl: BASE, fetch: host.fetch, store: createMemoryStore() });
    m.quote = undefined;
    m.useQuote.mockReset().mockImplementation(() => m.quote);
    m.quoteListeners.clear();
    m.viewRenders = 0;
    m.financialsRenders = 0;
    m.codeLookups = 0;
    m.liveCalls = [];
    m.liveData.clear();
    m.fetchSnapshots.mockReset();
    m.navigate.mockReset();
    m.openTicket.mockReset();
    m.openOrderAction.mockReset();
    Object.values(m.send).forEach(f => f.mockReset());
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('狀態：不支援、載入、不在收錄範圍、錯誤與重試', () => {
    it('指數、指數期貨：顯示「此商品沒有公司資料」，不讀任何資料', async () => {
        for (const c of [index, indexFuture]) {
            await render(c);
            expect(text(one('company-unsupported'))).toContain(NO_COMPANY_TEXT);
            expect(text(one('company-unsupported'))).toContain(UNSUPPORTED_DETAIL);
            await act(async () => view!.unmount());
            view = undefined;
        }
        expect(host.requests).toHaveLength(0);
    });

    it('合約尚未載入：骨架（role=status），不讀資料', async () => {
        await render(undefined);
        expect(one('company-loading').props.role).toBe('status');
        expect(host.requests).toHaveLength(0);
    });

    it('讀取中顯示骨架；完成後顯示公司資料', async () => {
        // 讓網路回應停在半路，才看得到讀取中
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        client = createCompanyDataClient({
            baseUrl: BASE,
            fetch: (async (input: RequestInfo | URL) => { await gate; return host.fetch(input); }) as typeof fetch,
            store: createMemoryStore(),
        });
        await render(stock);
        expect(all('company-loading')).toHaveLength(1);
        expect(all('company-loading')[0]!.props.role).toBe('status');
        expect(all('company-tab')).toHaveLength(0);
        release();
        await waitFor(() => all('company-tab').length === 1, 'ready');
        expect(all('company-loading')).toHaveLength(0);
    });

    it('ETF（不在收錄範圍）：「此商品沒有公司資料」＋桌面同樣的說明；不提供重試', async () => {
        await render(etf);
        await waitFor(() => all('company-not-found').length === 1, 'not found');
        const node = one('company-not-found');
        expect(text(node)).toContain(NO_COMPANY_TEXT);
        expect(text(node)).toContain(notCoveredText('0050'));
        expect(all('company-retry')).toHaveLength(0);
    });

    it('離線：錯誤提示（role=alert）＋重試；恢復連線後重試成功', async () => {
        host.offline = true;
        await render(stock);
        await waitFor(() => all('company-error').length === 1, 'error');
        expect(one('company-error').props.role).toBe('alert');
        host.offline = false;
        await press(one('company-retry'));
        await waitFor(() => all('company-tab').length === 1, 'ready after retry');
        expect(all('company-error')).toHaveLength(0);
    });

    it('資料格式不相容：錯誤提示但不提供重試（需更新 App，同桌面）', async () => {
        host.manifest.manifest_schema_version = '9.0.0';
        host.publish();
        await render(stock);
        await waitFor(() => all('company-error').length === 1, 'schema error');
        expect(all('company-retry')).toHaveLength(0);
    });
});

/**
 * 完整性對照：桌面 company-panel.tsx 的每個區塊 → 手機版 testid（依子分頁）。
 * 桌面沒有、手機另加的只有「統一編號」（資料集欄位 tax_id，使用者要求）。
 * 桌面有、手機刻意不同：上下游列的即時漲跌（桌面以快照查詢；手機不新增請求，顯示資料時點）。
 */
const DESKTOP_BLOCKS: { tab: 'head' | 'overview' | 'financials' | 'relations' | 'sources'; desktop: string; testId: string }[] = [
    { tab: 'head', desktop: 'Header 代碼／名稱／市場', testId: 'company-market' },
    { tab: 'head', desktop: 'Header 英文簡稱', testId: 'company-english' },
    { tab: 'head', desktop: 'Header 價格（即時或收盤日期）', testId: 'company-price' },
    { tab: 'head', desktop: 'Header 交易所產業別', testId: 'company-industry-official' },
    { tab: 'head', desktop: 'Header 研究分類 l1›l2›l3', testId: 'company-industry-research' },
    { tab: 'head', desktop: 'Kpis 市值', testId: 'company-kpi-cap' },
    { tab: 'head', desktop: 'Kpis 本益比（近四季 EPS）', testId: 'company-kpi-pe' },
    { tab: 'head', desktop: 'Kpis 月營收（年增）', testId: 'company-kpi-revenue' },
    { tab: 'head', desktop: 'Kpis 毛利率／淨利率', testId: 'company-kpi-margin' },
    { tab: 'overview', desktop: 'Overview 業務摘要＋第三方資料', testId: 'company-summary' },
    { tab: 'overview', desktop: 'ThirdPartyChip 說明（AI 整理提醒）', testId: 'company-third-party-note' },
    { tab: 'overview', desktop: '產業鏈位置 上游', testId: 'company-chain-upstream' },
    { tab: 'overview', desktop: '產業鏈位置 中游', testId: 'company-chain-midstream' },
    { tab: 'overview', desktop: '產業鏈位置 下游', testId: 'company-chain-downstream' },
    { tab: 'overview', desktop: '產業鏈 主要階段', testId: 'company-stage-own' },
    { tab: 'overview', desktop: '產業鏈 兼營階段', testId: 'company-stage-also' },
    { tab: 'overview', desktop: '產業鏈 理由', testId: 'company-chain-reason' },
    { tab: 'overview', desktop: 'RevenueMix 比例條', testId: 'company-mix-bar' },
    { tab: 'overview', desktop: 'RevenueMix 清單', testId: 'company-mix-item' },
    { tab: 'overview', desktop: '題材', testId: 'company-theme' },
    { tab: 'overview', desktop: '主題材（星號）', testId: 'company-theme-main' },
    { tab: 'overview', desktop: 'CompanyFacts 公司名稱', testId: 'company-fact-fullname' },
    { tab: 'overview', desktop: 'CompanyFacts 產業別', testId: 'company-fact-industry' },
    { tab: 'overview', desktop: 'CompanyFacts 上市／上櫃日期', testId: 'company-fact-listed' },
    { tab: 'overview', desktop: 'CompanyFacts 成立日期', testId: 'company-fact-incorporated' },
    { tab: 'overview', desktop: 'CompanyFacts 網站', testId: 'company-fact-website' },
    { tab: 'overview', desktop: 'CompanyFacts 官方資料日期', testId: 'company-facts-official' },
    { tab: 'overview', desktop: '（手機另加）統一編號', testId: 'company-fact-taxid' },
    { tab: 'financials', desktop: '月營收圖（近 36 個月＋年增率）', testId: 'company-revenue-chart' },
    { tab: 'financials', desktop: '月營收圖例', testId: 'company-revenue-legend' },
    { tab: 'financials', desktop: '月營收表', testId: 'company-revenue-table' },
    { tab: 'financials', desktop: '月營收官方資料日期', testId: 'company-revenue-official' },
    { tab: 'financials', desktop: '季度財報表', testId: 'company-quarter-table' },
    { tab: 'financials', desktop: '財報來源說明', testId: 'company-financials-source' },
    { tab: 'relations', desktop: '上下游與關係＋第三方資料', testId: 'company-relations' },
    { tab: 'relations', desktop: '供應商', testId: 'company-relations-suppliers' },
    { tab: 'relations', desktop: '客戶', testId: 'company-relations-customers' },
    { tab: 'relations', desktop: '合作夥伴', testId: 'company-relations-partners' },
    { tab: 'relations', desktop: '子公司', testId: 'company-relations-subsidiaries' },
    { tab: 'relations', desktop: '重大交易', testId: 'company-relations-transactions' },
    { tab: 'relations', desktop: 'RelationLine', testId: 'company-relation-row' },
    { tab: 'sources', desktop: '資料時點 研究資料', testId: 'company-asof-research' },
    { tab: 'sources', desktop: '資料時點 官方資料', testId: 'company-asof-official' },
    { tab: 'sources', desktop: '資料時點 月營收至', testId: 'company-asof-revenue' },
    { tab: 'sources', desktop: '資料時點 資料版本', testId: 'company-asof-release' },
    { tab: 'sources', desktop: '研究出處', testId: 'company-evidence-item' },
    { tab: 'sources', desktop: '官方資料來源', testId: 'company-official-source' },
    { tab: 'sources', desktop: '免責聲明（manifest disclaimer）', testId: 'company-disclaimer' },
    { tab: 'head', desktop: 'Footer 資料標示／官方日期／版本', testId: 'company-release' },
    { tab: 'head', desktop: 'Footer 重新檢查', testId: 'company-refresh' },
];

describe('2330（已研究）', () => {
    it('完整性對照：桌面每個區塊在手機版都有對應', async () => {
        await renderReady(stock);
        for (const t of ['head', 'overview', 'financials', 'relations', 'sources'] as const) {
            if (t !== 'head') await tab(t);
            for (const block of DESKTOP_BLOCKS.filter(b => b.tab === t || (b.tab === 'head' && t !== 'head'))) {
                expect(all(block.testId).length, `${block.desktop}（${block.testId}）`).toBeGreaterThan(0);
            }
        }
        // 桌面也只在有資料時顯示：競爭對手、母公司在 fixture 中沒有
        expect(all('company-relations-competitors')).toHaveLength(0);
        expect(all('company-relations-parents')).toHaveLength(0);
    });

    it('標頭與指標：每日收盤（沒有即時價時）、市值＝收盤×股數、本益比、月營收、毛利率', async () => {
        await renderReady(stock);
        expect(text(one('company-head'))).toContain('2330');
        expect(text(one('company-head'))).toContain('台積電');
        expect(text(one('company-market'))).toBe('上市');
        expect(text(one('company-english'))).toBe('TSMC');
        expect(text(one('company-price'))).toContain('收盤 2026-10-20');
        expect(text(one('company-industry-official'))).toContain('半導體業');
        expect(text(one('company-kpi-cap'))).toContain('62.37 兆');
        expect(text(one('company-kpi-cap'))).toContain('收盤 2026-10-20');
        expect(text(one('company-kpi-pe'))).toMatch(/近四季 EPS \d/);
        expect(text(one('company-kpi-revenue'))).toContain('2026-09 年增 +54.6%');
        expect(text(one('company-kpi-margin'))).toContain('毛利率');
        // 股票：報價用本頁同一檔（不另訂閱其他代碼）
        for (const [code] of m.useQuote.mock.calls) expect(code).toBe('2330');
    });

    it('有即時成交：價格與漲跌（▲、正負號）用即時價，市值＝即時價×股數', async () => {
        m.quote = { tick: { code: '2330', close: '1085', price_chg: '15' } };
        await renderReady(stock);
        const price = text(one('company-price'));
        expect(price).toContain('1,085');
        expect(price).toContain('▲+15.00');
        expect(price).not.toContain('收盤');
        expect(text(one('company-kpi-cap'))).toContain('即時價 × 股數');
        expect(text(one('company-kpi-cap'))).toContain('28.14 兆');
    });

    it('個股期貨：顯示標的公司與「CDFR1 標的」；同桌面訂閱標的（2330）報價；沒有成交時以收盤價計算', async () => {
        await renderReady(stockFuture);
        expect(text(one('company-underlying'))).toBe('CDFR1 標的');
        expect(text(one('company-head'))).toContain('台積電');
        expect(m.useQuote.mock.calls.length).toBeGreaterThan(0);
        for (const [code] of m.useQuote.mock.calls) expect(code).toBe('2330');
        expect(text(one('company-price'))).toContain('收盤 2026-10-20');
    });

    it('個股期貨：標的有即時成交時用即時價（漲跌幅以串流自身參考計算）；分頁隱藏（active=false）時不訂閱標的', async () => {
        m.quote = { tick: { code: '2330', close: '1085', price_chg: '15' } };
        await renderReady(stockFuture);
        const price = text(one('company-price'));
        expect(price).toContain('1,085');
        expect(price).toContain('▲+15.00');
        expect(price).toContain(fmtPct((15 / 1070) * 100));
        expect(text(one('company-kpi-cap'))).toContain('即時價 × 股數');
        await act(async () => { view!.update(createElement(CompanyTab, { contract: stockFuture, active: false, client })); });
        expect(m.useQuote.mock.calls.at(-1)![0]).toBeNull();
        await act(async () => { view!.update(createElement(CompanyTab, { contract: stockFuture, active: true, client })); });
        expect(m.useQuote.mock.calls.at(-1)![0]).toBe('2330');
        for (const [code] of m.useQuote.mock.calls) expect([null, '2330']).toContain(code);
    });

    it('子分頁標籤同桌面帶筆數：上下游＝所有關係列數、來源＝研究出處筆數', async () => {
        const company = JSON.parse(host.files.get('v1/tw/companies/json/2330.json')!) as {
            relations: Record<string, unknown[] | undefined>;
            evidence: Record<string, unknown>;
        };
        const relations = Object.values(company.relations).reduce((n, rows) => n + (rows?.length ?? 0), 0);
        const evidence = Object.keys(company.evidence).length;
        expect(relations).toBeGreaterThan(0);
        expect(evidence).toBeGreaterThan(0);
        await renderReady(stock);
        expect(text(one('company-tab-overview'))).toBe('概覽');
        expect(text(one('company-tab-financials'))).toBe('財務');
        expect(text(one('company-tab-relations'))).toBe(`上下游 ${relations}`);
        expect(text(one('company-tab-sources'))).toBe(`來源 ${evidence}`);
        // 分頁內容區的名稱不帶筆數
        await tab('relations');
        expect(one('company-panel-relations').props['aria-label']).toBe('上下游');
    });

    it('月營收圖：最大值刻度 aria-hidden（讀屏以 SVG 的 aria-label 為準）', async () => {
        await renderReady(stock);
        await tab('financials');
        expect(one('company-revenue-max').props['aria-hidden']).toBe('true');
        expect(text(one('company-revenue-max')).length).toBeGreaterThan(0);
    });

    it('上下游即時漲跌幅：只在上下游子分頁顯示且 active 時讀取；看得到的上市櫃列、去重、最多 40 檔；有資料的列顯示漲跌幅', async () => {
        await renderReady(stock);
        // 概覽、財務：不讀
        await tab('financials');
        expect(m.liveCalls.filter(c => c.length > 0)).toHaveLength(0);
        await tab('relations');
        await waitFor(() => m.liveCalls.some(c => c.length > 0), 'live contracts after entities');
        const contracts = m.liveCalls.at(-1)!;
        expect(contracts.length).toBeGreaterThan(0);
        expect(contracts.length).toBeLessThanOrEqual(RELATION_LIVE_LIMIT);
        expect(new Set(contracts).size).toBe(contracts.length);
        for (const c of contracts) expect(c).toMatch(/^(TSE|OTC):/);
        // 讀取對象都是畫面上的台股列
        const rowCodes = new Set(all('company-relation-row').map(r => r.props['data-code']).filter(Boolean));
        for (const c of contracts) expect(rowCodes.has(c.split(':')[1])).toBe(true);
        expect(m.fetchSnapshots).not.toHaveBeenCalled();
        // 有即時資料：顯示漲跌幅（取代資料時點）
        const code = contracts[0]!.split(':')[1]!;
        m.liveData.set(code, 2.5);
        await tab('overview');
        await tab('relations');
        const row = all('company-relation-row').find(r => r.props['data-code'] === code)!;
        const pct = row.findAll(n => n.props['data-testid'] === 'company-relation-pct' && typeof n.type === 'string');
        expect(pct).toHaveLength(1);
        expect(text(pct[0]!)).toContain(fmtPct(2.5));
        // 交易頁切走（active=false）：不讀不訂閱
        await act(async () => { view!.update(createElement(CompanyTab, { contract: stock, active: false, client })); });
        expect(m.liveCalls.at(-1)).toEqual([]);
        await act(async () => { view!.update(createElement(CompanyTab, { contract: stock, active: true, client })); });
        expect(m.liveCalls.at(-1)).toEqual(contracts);
        // 切到其他子分頁：上下游卸載（不再呼叫）
        const n = m.liveCalls.length;
        await tab('sources');
        expect(m.liveCalls.length).toBe(n);
    });

    it('概覽：業務摘要附第三方提醒、產業鏈主要／兼營階段、營收組成比例條、主題材', async () => {
        await renderReady(stock);
        expect(text(one('company-summary'))).toContain('第三方資料 · 2026-10-13');
        expect(text(one('company-third-party-note'))).toBe(THIRD_PARTY_NOTE);
        expect(text(one('company-stage-own'))).toContain('晶圓製造');
        expect(text(one('company-stage-own'))).toContain('主要階段');
        expect(text(one('company-stage-also'))).toContain('封裝測試');
        expect(text(one('company-chain-reason'))).toContain('晶圓製造占營收約86%');
        const bar = one('company-mix-bar');
        expect(bar.props.role).toBe('img');
        expect(bar.children.length).toBeGreaterThan(0);
        expect((bar.children[0] as ReactTestInstance).props.style.width).toBe('58%');
        expect(text(one('company-theme-main'))).toContain('主題材');
        expect(text(one('company-fact-taxid'))).toBe('22099131');
        expect(text(one('company-fact-fullname'))).toBe('台灣積體電路製造股份有限公司');
    });

    it('產業鏈名單：點階段展開成員（依市值），上市櫃代碼開該股交易頁（navigate），本身不可點；收合', async () => {
        await renderReady(stock);
        expect(fileRequests()).not.toContain('v1/global/entities/entities.json');
        await press(one('company-stage-own'));
        expect(one('company-stage-own').props['aria-pressed']).toBe(true);
        await waitFor(() => fileRequests().includes('v1/global/entities/entities.json'), 'entities loaded on focus');
        const rows = all('company-member-row');
        expect(rows.length).toBeGreaterThan(0);
        const self = rows.find(r => text(r).includes('2330'));
        if (self) expect(self.type).toBe('div');
        const other = rows.find(r => r.type === 'button')!;
        expect(other).toBeDefined();
        await press(other);
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: other.props['data-code'] });
        await press(one('company-members-close'));
        expect(all('company-members')).toHaveLength(0);
    });

    it('財務：36 根長條＋年增率折線（SVG）；月營收表 6 個月可展開全部；季報 8 季含毛利率、營益率', async () => {
        await renderReady(stock);
        await tab('financials');
        const svg = one('company-revenue-chart').findByType('svg');
        expect(svg.props.role).toBe('img');
        expect(svg.findAllByType('rect')).toHaveLength(36);
        expect(all('company-revenue-yoy')).toHaveLength(1);
        const rows = () => one('company-revenue-table').findAllByType('tr').length - 1;
        expect(rows()).toBe(6);
        await press(one('company-revenue-more'));
        expect(rows()).toBe(36);
        const quarter = one('company-quarter-table');
        expect(quarter.findAllByType('th').map(text)).toEqual(['季別', '營收', '毛利率', '營益率', '淨利率', 'EPS']);
        expect(quarter.findAllByType('tr')).toHaveLength(9);
    });

    it('財務頂部「估值與體質」：P/B（收盤）＋每股淨值、負債比、盈餘品質（比值＋文字）、累計 EPS 對照去年同期、近 8 季獲利金額（億元）', async () => {
        await renderReady(stock);
        expect(all('company-valuation')).toHaveLength(0);
        await tab('financials');
        // 放在財務子分頁的第一張卡
        const panel = one('company-panel-financials');
        const cards = panel.findAll(n => n.type === 'section');
        expect(cards[0]!.props['data-testid']).toBe('company-valuation');
        expect(text(one('company-valuation'))).toContain('估值與體質');
        expect(text(one('company-valuation-official'))).toContain('官方資料');
        // P/B＝收盤 2405 ÷ 248.05
        const pb = text(one('company-valuation-pb'));
        expect(pb).toContain('9.70 倍');
        expect(pb).toContain('每股淨值 248.05（2026Q2）');
        expect(pb).toContain('收盤 2026-10-20');
        expect(text(one('company-valuation-debt'))).toContain('30.9%');
        expect(text(one('company-valuation-debt'))).toContain('2026Q2');
        const quality = text(one('company-valuation-quality'));
        expect(quality).toContain('1.18 倍');
        expect(quality).toContain('營業現金流高於淨利');
        expect(text(one('company-valuation-quality-detail'))).toBe('近四季（2025Q3–2026Q2）營業現金流合計 26,347 億元，高於淨利合計 22,371 億元');
        const ytd = text(one('company-valuation-ytd-eps'));
        expect(ytd).toContain('49.33 元');
        expect(ytd).toContain('2026 年前 2 季');
        expect(ytd).toContain('去年同期 29.31，年增 +68.3%');
        const table = one('company-profit-table');
        expect(text(table.findByType('caption'))).toContain('億元');
        expect(table.findAllByType('th').map(text)).toEqual(['季別', '營收', '毛利', '營業利益', '淨利']);
        const rows = table.findAllByType('tr').slice(1).map(r => r.findAllByType('td').map(text));
        expect(rows).toHaveLength(8);
        expect(rows[0]).toEqual(['2026Q2', '12,704', '8,603', '7,666', '7,066']);
        expect(rows[7]![0]).toBe('2024Q3');
        expect(text(one('company-valuation-source'))).toContain('營業現金流合計 ÷ 近四季淨利合計');
        // 只顯示：卡內沒有按鈕
        expect(one('company-valuation').findAll(n => n.type === 'button')).toHaveLength(0);
    });

    it('估值卡：有即時成交時 P/B 用即時價（同標頭的同一檔報價）', async () => {
        m.quote = { tick: { code: '2330', close: '1085', price_chg: '15' } };
        await renderReady(stock);
        await tab('financials');
        const pb = text(one('company-valuation-pb'));
        expect(pb).toContain(`${(1085 / 248.05).toFixed(2)} 倍`);
        expect(pb).toContain('即時價');
        expect(pb).not.toContain('收盤');
        for (const [code] of m.useQuote.mock.calls) expect(code).toBe('2330');
    });

    it('上下游：分組與筆數；台股列點擊開交易頁（只導覽），非台股列不可點；實體索引在切到此分頁才讀', async () => {
        await renderReady(stock);
        expect(fileRequests()).not.toContain('v1/global/entities/entities.json');
        await tab('relations');
        await waitFor(() => fileRequests().includes('v1/global/entities/entities.json'), 'entities on relations');
        expect(text(one('company-relations'))).toContain(THIRD_PARTY_NOTE);
        const rows = all('company-relation-row');
        const tw = rows.filter(r => r.type === 'button');
        const foreign = rows.filter(r => r.type === 'div');
        expect(tw.length).toBeGreaterThan(0);
        expect(foreign.length).toBeGreaterThan(0);
        for (const r of foreign) expect(r.props.onClick).toBeUndefined();
        await press(tw[0]!);
        expect(m.navigate).toHaveBeenCalledTimes(1);
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: tw[0]!.props['data-code'] });
    });

    it('來源：資料時點、研究出處、官方來源、免責；外部連結都是 http(s)、新分頁、rel="noopener noreferrer"', async () => {
        await renderReady(stock);
        await tab('sources');
        expect(text(one('company-asof-research'))).toContain('2026-10-13（第三方，AI 整理並交叉核對）');
        expect(text(one('company-asof-release'))).toBe('2026.10.20.2220');
        expect(text(one('company-disclaimer'))).toContain('可能過時或有誤');
        const evidence = all('company-evidence-item');
        expect(evidence.length).toBeGreaterThan(0);
        for (const t of ['overview', 'sources'] as const) {
            await tab(t);
            const anchors = view!.root.findAllByType('a');
            expect(anchors.length).toBeGreaterThan(0);
            for (const a of anchors) {
                expect(a.props.href).toMatch(/^https?:\/\//);
                expect(a.props.target).toBe('_blank');
                expect(a.props.rel).toBe('noopener noreferrer');
            }
        }
    });

    it('研究出處的網址不是 http(s) 時只顯示文字（不產生連結）', async () => {
        const company = JSON.parse(host.files.get('v1/tw/companies/json/2330.json')!) as { evidence: Record<string, { url: string | null; title: string | null }> };
        const firstKey = Object.keys(company.evidence)[0]!;
        company.evidence[firstKey] = { ...company.evidence[firstKey]!, url: 'javascript:alert(1)', title: '惡意連結' };
        host.setFile('v1/tw/companies/json/2330.json', JSON.stringify(company), true);
        await renderReady(stock);
        await tab('sources');
        for (const a of view!.root.findAllByType('a')) expect(String(a.props.href)).not.toMatch(/^javascript:/i);
        expect(view!.root.findAll(n => n.type === 'span' && text(n) === '惡意連結').length).toBeGreaterThan(0);
    });
});

describe('重繪範圍：即時成交只重繪標頭與指標；分頁隱藏時不跟著成交重繪', () => {
    const subscribe = (listener: () => void) => {
        m.quoteListeners.add(listener);
        return () => { m.quoteListeners.delete(listener); };
    };
    /** 真的走 useSyncExternalStore：tick 只重繪呼叫 useQuote 的元件 */
    const reactiveQuote = () =>
        m.useQuote.mockImplementation((code: string | null) => useSyncExternalStore(subscribe, () => (code ? m.quote : undefined)));
    const tick = (close: number) =>
        act(async () => {
            m.quote = { tick: { code: '2330', close: String(close), price_chg: String(close - 1070) } };
            m.quoteListeners.forEach(l => l());
        });
    const rerender = (active: boolean) =>
        act(async () => { view!.update(createElement(CompanyTab, { contract: stock, active, client })); });

    it('財務分頁開著：連續成交只更新價格、市值、本益比，CompanyView 與財務分頁不重繪', async () => {
        reactiveQuote();
        m.quote = { tick: { code: '2330', close: '1080', price_chg: '10' } };
        await renderReady(stock);
        await tab('financials');
        const views = m.viewRenders;
        const fins = m.financialsRenders;
        expect(fins).toBeGreaterThan(0);
        const pe0 = text(one('company-kpi-pe'));
        for (const close of [1085, 1090, 1095]) await tick(close);
        expect(text(one('company-price'))).toContain('1,095');
        expect(text(one('company-price'))).toContain('▲+25.00');
        expect(text(one('company-kpi-cap'))).toContain('即時價 × 股數');
        expect(text(one('company-kpi-pe'))).not.toBe(pe0);
        expect(m.viewRenders).toBe(views);
        expect(m.financialsRenders).toBe(fins);
    });

    it('財務分頁開著：成交時估值卡只更新 P/B 一格（財報計算不重跑），其他格不變', async () => {
        reactiveQuote();
        m.quote = { tick: { code: '2330', close: '1080', price_chg: '10' } };
        await renderReady(stock);
        await tab('financials');
        const fins = m.financialsRenders;
        const others = ['debt', 'quality', 'ytd-eps'].map(id => text(one(`company-valuation-${id}`)));
        const table = text(one('company-profit-table'));
        expect(text(one('company-valuation-pb'))).toContain(`${(1080 / 248.05).toFixed(2)} 倍`);
        for (const close of [1085, 1090]) await tick(close);
        expect(text(one('company-valuation-pb'))).toContain(`${(1090 / 248.05).toFixed(2)} 倍`);
        expect(m.financialsRenders).toBe(fins);
        expect(['debt', 'quality', 'ytd-eps'].map(id => text(one(`company-valuation-${id}`)))).toEqual(others);
        expect(text(one('company-profit-table'))).toBe(table);
    });

    it('展開產業鏈名單後：成交不重排名單（不重跑代碼解析）', async () => {
        reactiveQuote();
        await renderReady(stock);
        await press(one('company-stage-own'));
        await waitFor(() => fileRequests().includes('v1/global/entities/entities.json'), 'entities loaded on focus');
        // 等實體索引讀完（之後 CompanyView 不再因讀取狀態重繪）
        let settled = -1;
        for (let i = 0; i < 50 && settled !== m.viewRenders; i += 1) {
            settled = m.viewRenders;
            await act(async () => { await new Promise(r => setTimeout(r, 5)); });
        }
        expect(all('company-member-row').length).toBeGreaterThan(0);
        const order = all('company-member-row').map(text);
        const lookups = m.codeLookups;
        const views = m.viewRenders;
        for (const close of [1085, 1090]) await tick(close);
        expect(text(one('company-price'))).toContain('1,090');
        expect(m.codeLookups).toBe(lookups);
        expect(m.viewRenders).toBe(views);
        expect(all('company-member-row').map(text)).toEqual(order);
    });

    it('active=false（交易頁切回五檔）：改呼叫 useQuote(null)，成交不重繪；切回時直接顯示最新價', async () => {
        reactiveQuote();
        m.quote = { tick: { code: '2330', close: '1080', price_chg: '10' } };
        await renderReady(stock);
        expect(m.useQuote.mock.calls.at(-1)![0]).toBe('2330');
        await rerender(false);
        expect(m.useQuote.mock.calls.at(-1)![0]).toBeNull();
        const quoteCalls = m.useQuote.mock.calls.length;
        const views = m.viewRenders;
        for (const close of [1085, 1090, 1095]) await tick(close);
        // 隱藏期間沒有任何元件跟著成交重繪
        expect(m.useQuote.mock.calls.length).toBe(quoteCalls);
        expect(m.viewRenders).toBe(views);
        // 子分頁狀態保留；切回後讀 store 的最新值
        await rerender(true);
        expect(m.useQuote.mock.calls.at(-1)![0]).toBe('2330');
        expect(text(one('company-price'))).toContain('1,095');
        expect(text(one('company-kpi-cap'))).toContain('即時價 × 股數');
        // 股票：只用本頁同一檔（或 null），不訂閱其他代碼
        for (const [code] of m.useQuote.mock.calls) expect([null, '2330']).toContain(code);
    });
});

describe('1108（只有官方資料）', () => {
    it('概覽與上下游顯示「只有官方資料」；沒有財報資料；基本資料仍完整', async () => {
        await renderReady(cement);
        expect(text(one('company-official-only'))).toContain('只有官方資料');
        expect(all('company-summary')).toHaveLength(0);
        expect(all('company-chain-midstream')).toHaveLength(0);
        expect(text(one('company-fact-fullname'))).toBe('幸福水泥股份有限公司');
        expect(text(one('company-fact-website'))).toContain('www.luckygrp.com.tw');
        const site = one('company-fact-website').findByType('a');
        expect(site.props.href).toBe('https://www.luckygrp.com.tw/');
        expect(site.props.rel).toBe('noopener noreferrer');
        expect(text(one('company-kpi-pe'))).toContain('近四季 EPS —');
        await tab('financials');
        expect(text(one('company-financials-empty'))).toContain('這家公司沒有財報資料');
        // 沒有財報檔：不顯示估值卡（不顯示一整張「—」）
        expect(all('company-valuation')).toHaveLength(0);
        await tab('relations');
        expect(text(one('company-official-only'))).toContain('沒有客戶、供應商與合作關係資料');
        // 未研究：上下游不讀即時漲跌、子分頁標籤不帶筆數（同桌面）
        expect(m.liveCalls.filter(c => c.length > 0)).toHaveLength(0);
        expect(text(one('company-tab-relations'))).toBe('上下游');
        await tab('sources');
        expect(text(one('company-asof-research'))).toBe('尚未研究，只有官方資料');
        expect(text(one('company-footer'))).toContain('官方資料');
    });
});

describe('S1：公司分頁只導覽與開外部連結', () => {
    it('按遍每個子分頁的每個按鈕：openTicket／openOrderAction 與 lib 送出函式 0 次', async () => {
        await renderReady(stock);
        for (const t of ['overview', 'financials', 'relations', 'sources'] as const) {
            await tab(t);
            await waitFor(() => all('company-tab').length === 1, 'still ready');
            // 每次重新查詢、按下一個還沒按過的按鈕（含階段、題材、名單列、展開全部、重新檢查）；展開後新出現的也會按到
            const keyOf = (b: ReactTestInstance) => `${String(b.props['data-testid'] ?? '')}|${String(b.props['data-code'] ?? '')}|${text(b)}`;
            const done = new Set<string>();
            for (let guard = 0; guard < 300; guard += 1) {
                const next = buttons().find(b =>
                    !b.props.disabled
                    && !done.has(keyOf(b))
                    // 子分頁切換鍵由外層迴圈處理
                    && !String(b.props['data-testid'] ?? '').startsWith('company-tab-'));
                if (!next) break;
                done.add(keyOf(next));
                await press(next);
                await waitFor(() => all('company-tab').length === 1, 'ready after press');
            }
        }
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
        // 導覽只到交易頁
        for (const [route] of m.navigate.mock.calls) expect((route as { name: string }).name).toBe('trade');
        expect(m.navigate.mock.calls.length).toBeGreaterThan(0);
    });
});
