// fork：帳務 FundsSection「股票市值」＝Σ|股數|×現價；「資產市值 Total Assets」＝交割戶＋未交割款＋Σ清算價值＋期貨權益。
// 融券以保證金＋損益、融資以自備款（或市值扣融資金額）計；任一列或交割資料未知時不顯示合計。
// 全部為合成資料（帳號、代號、金額皆非真實）；fetch 一律拒絕，測試不打任何端點。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account, AccountFunds, AccountedPosition } from '../lib/types/portfolio';

const fixture = vi.hoisted(() => ({ accounts: [] as Account[], settlements: vi.fn() }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: fixture.accounts }), getAccountState: () => ({ accounts: fixture.accounts }) }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => 'http://account-value-fixture.invalid' }));
vi.mock('../lib/shioaji', () => ({
    fetchInfo: async () => ({ simulation: false }),
    fetchProfitLoss: async () => [],
    fetchProfitLossSummary: async () => ({ total: { pnl: 0 }, profitloss_sum: [] }),
    fetchSettlements: fixture.settlements,
    fetchTradingLimits: async () => ({}),
    fetchStockReserveSummary: async () => ({ stocks: [] }),
    fetchStockReserveDetail: async () => ({ stocks: [] }),
    fetchEarmarkingDetail: async () => ({ stocks: [] }),
    resolveContract: vi.fn(),
    fetchFuturesRoots: vi.fn(async () => []),
}));
vi.mock('./esun-account-overview', () => ({
    EsunAccountOverview: () => null,
    EsunPnlCostTotal: () => null,
    EsunPnlRowDetail: () => null,
    useEsunAccountPane: () => ({ sim: false, stockSim: false, sinopacStock: [], overview: { refresh: async () => undefined, loading: false, error: null } }),
}));
import { clearEsunInventoryDetails, parseEsunInventoryDetails, setEsunInventoryDetails } from '../lib/esun';
import { AccountPane, type AccountRefreshControls } from './bottom-dock-account';

let seq = 0;
let view: ReactTestRenderer | undefined;
const mkAccount = (broker_id: string): Account => ({ account_type: 'S', broker_id, account_id: `V${++seq}`, person_id: '', signed: true, username: '' });
const pos = (account: Account, extra: Partial<AccountedPosition> & Record<string, unknown> = {}): AccountedPosition => ({
    id: 1, code: '2603', direction: 'Buy', quantity: 2000, price: 200, last_price: 500, pnl: 0, yd_quantity: 2000, cond: 'Cash', account, ...extra,
} as AccountedPosition);
const short = (account: Account, extra: Partial<AccountedPosition> & Record<string, unknown> = {}) =>
    pos(account, { id: 2, code: '1234', direction: 'Sell', cond: 'ShortSelling', price: 380.5, last_price: 392, pnl: -28537, ...extra });
// rowId 依列序：1＝2603 現股、2＝1234 融券（與 pos／short 的 id 相同，同一批查詢）
const shortDetail = (costQty = '2000') => parseEsunInventoryDetails([
    { stk_no: '2603', trade: '0', s_type: 'H', cost_qty: '2000', cost_sum: '400000', price_avg: '200' },
    { stk_no: '1234', trade: '4', s_type: 'O', cost_qty: costQty, cost_sum: '-685000', make_a_sum: '-28537', price_avg: '380.50', value_mkt: '784000' },
]);
const PAST = [{ T: 0, date: '2000-01-03', amount: 0 }];
const funds = (account: Account, updatedAt = Date.now()): AccountFunds[] => [{ account, balance: { acc_balance: 500000, date: '', errmsg: '' }, updatedAt }];

async function render(account: Account, positions: AccountedPosition[], extra: { fundsAt?: number; onRefreshControls?: (c: AccountRefreshControls | null) => void } = {}) {
    fixture.accounts = [account];
    const props = { positions, market: 'S' as const, scopeAccount: null, funds: funds(account, extra.fundsAt), onRefreshControls: extra.onRefreshControls };
    if (view) await act(async () => { view!.update(createElement(AccountPane, props)); });
    else await act(async () => { view = create(createElement(AccountPane, props)); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
    return JSON.stringify(view!.toJSON());
}
const total = (json: string) => /"資產市值 Total Assets"\][\s\S]*?"children":\["([^"]*)"/.exec(json)?.[1] ?? null;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled in tests'); }));
    fixture.settlements.mockReset().mockResolvedValue(PAST);
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    clearEsunInventoryDetails();
    vi.unstubAllGlobals();
});

it('E.SUN short counts margin + P&L, the market value row is positive and the total follows live pnl', async () => {
    const esun = mkAccount('8840');
    setEsunInventoryDetails(esun, shortDetail());
    let json = await render(esun, [pos(esun), short(esun)]);
    expect(json).toContain('股票市值 Market Value');
    expect(json).toContain('$1,784,000');
    // 500,000 + 995,575（現股扣費稅）+ 656,463（保證金 685,000 − 28,537）
    expect(total(json)).toBe('$2,152,038');
    expect(json).toContain('含未交割款；信用部位以清算價值計');
    // tick 392 → 396：pnl 再減 8,000
    json = await render(esun, [pos(esun), short(esun, { last_price: 396, pnl: -36537 })]);
    expect(total(json)).toBe('$2,144,038');
});

it('pending settlements are included: a same-day short only contributes its P&L', async () => {
    const esun = mkAccount('8840');
    setEsunInventoryDetails(esun, shortDetail());
    fixture.settlements.mockResolvedValue([{ T: 0, date: '2000-01-03', amount: 999 }, { T: 2, date: '2999-01-02', amount: -685000 }]);
    const json = await render(esun, [pos(esun), short(esun)]);
    expect(total(json)).toBe('$1,467,038');
});

it('E.SUN credit rows never use a stale detail whose cost_qty differs from the position', async () => {
    const esun = mkAccount('8840');
    setEsunInventoryDetails(esun, shortDetail('3000'));
    const json = await render(esun, [pos(esun), short(esun)]);
    expect(total(json)).toBeNull();
    expect(json).toContain('合計待確認');
});

it('Sinopac short without a margin field withholds the total instead of showing cash − market value', async () => {
    const sinopac = mkAccount('9A95');
    let json = await render(sinopac, [pos(sinopac), short(sinopac)]);
    expect(total(json)).toBeNull();
    expect(json).toContain('合計待確認');
    expect(json).not.toContain('715,044');
    json = await render(sinopac, [pos(sinopac), short(sinopac, { short_sale_margin: 685000 })]);
    expect(total(json)).toBe('$2,152,038');
});

it('margin purchases deduct the loan (Sinopac) / use own funds (E.SUN), never the full market value', async () => {
    const sinopac = mkAccount('9A95');
    const margin = (account: Account, extra: Record<string, unknown> = {}) =>
        pos(account, { id: 3, code: '2330', cond: 'MarginTrading', quantity: 2000, price: 100, last_price: 100, ...extra });
    let json = await render(sinopac, [margin(sinopac, { margin_purchase_amount: 120000, interest: 50 })]);
    // 500,000 + 200,000 × (1 − 0.1425% − 0.3%) − 120,000 − 50
    expect(total(json)).toBe('$579,065');
    json = await render(sinopac, [margin(sinopac)]);
    expect(total(json)).toBeNull();
    await act(async () => view?.unmount());
    view = undefined;
    const esun = mkAccount('8840');
    setEsunInventoryDetails(esun, parseEsunInventoryDetails([{ stk_no: '2330', trade: '3', s_type: 'H', cost_qty: '2000', cost_sum: '-80285', price_avg: '100' }]));
    json = await render(esun, [margin(esun, { id: 1, pnl: 1000 })]);
    expect(total(json)).toBe('$581,285');
});

it('cash-only accounts keep the upstream number (regression, both brokers)', async () => {
    for (const broker of ['9A95', '8840']) {
        const account = mkAccount(broker);
        const json = await render(account, [pos(account)]);
        expect(total(json)).toBe('$1,495,575');
        expect(json).toContain('$1,000,000');
        await act(async () => view?.unmount());
        view = undefined;
    }
});

it('a NaN price or unknown settlements never produce a NaN or partial total', async () => {
    const sinopac = mkAccount('9A95');
    let json = await render(sinopac, [pos(sinopac), pos(sinopac, { id: 4, code: '6446', last_price: NaN })]);
    expect(json).not.toContain('NaN');
    expect(total(json)).toBeNull();
    await act(async () => view?.unmount());
    view = undefined;
    const other = mkAccount('9A95');
    fixture.settlements.mockRejectedValue(new Error('settlements offline'));
    json = await render(other, [pos(other)]);
    expect(total(json)).toBeNull();
    expect(json).toContain('合計待確認');
});

it('a fill after the settlements snapshot (credit row closed by projection) withholds the total until 更新帳務', async () => {
    const esun = mkAccount('8840');
    setEsunInventoryDetails(esun, shortDetail());
    fixture.settlements.mockResolvedValue([{ T: 1, date: '2999-01-02', amount: -685000 }]);
    let controls: AccountRefreshControls | null = null;
    const onRefreshControls = (c: AccountRefreshControls | null) => { controls = c; };
    let json = await render(esun, [pos(esun), short(esun)], { onRefreshControls });
    expect(total(json)).toBe('$1,467,038');
    // 回補成交：投影移除融券列，交割款仍是成交前快照（少了回補應收款）
    json = await render(esun, [pos(esun)], { onRefreshControls });
    expect(total(json)).toBeNull();
    expect(json).toContain('成交後交割款尚未更新，請按更新帳務');
    expect(json).toContain('合計待確認');
    expect(json).not.toContain('$810,575');
    // 反方向：新的融券賣出成交後同樣待確認（不得把保證金應付再扣一次或漏算）
    json = await render(esun, [pos(esun), short(esun), short(esun, { id: -1, code: '2603' })], { onRefreshControls });
    expect(total(json)).toBeNull();
    // 按更新帳務（交割款重查）後以新快照為基準，合計恢復
    json = await render(esun, [pos(esun)], { onRefreshControls });
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 5000);
    try {
        fixture.settlements.mockResolvedValue([{ T: 1, date: '2999-01-02', amount: -28537 }]);
        await act(async () => { await controls!.refresh(); });
        json = await render(esun, [pos(esun)], { onRefreshControls });
    } finally { clock.mockRestore(); }
    expect(json).not.toContain('成交後交割款尚未更新');
    expect(total(json)).toBe('$1,467,038');
});

it('a balance snapshot from a prior Taipei day withholds the total and asks to refresh', async () => {
    const account = mkAccount('9A95');
    let json = await render(account, [pos(account)], { fundsAt: Date.now() - 86_400_000 });
    expect(total(json)).toBeNull();
    expect(json).toContain('交割戶餘額或交割款為前一日資料，請按更新帳務');
    json = await render(account, [pos(account)]);
    expect(total(json)).toBe('$1,495,575');
});

it('zero margin / loan / cost_sum on credit rows are unknown, never counted as 0', async () => {
    const sinopac = mkAccount('9A95');
    let json = await render(sinopac, [pos(sinopac), short(sinopac, { short_sale_margin: 0 })]);
    expect(total(json)).toBeNull();
    json = await render(sinopac, [pos(sinopac, { id: 3, code: '2330', cond: 'MarginTrading', margin_purchase_amount: 0, interest: 0 })]);
    expect(total(json)).toBeNull();
    await act(async () => view?.unmount());
    view = undefined;
    const esun = mkAccount('8840');
    setEsunInventoryDetails(esun, parseEsunInventoryDetails([
        { stk_no: '2603', trade: '0', cost_qty: '2000', price_avg: '200' },
        { stk_no: '1234', trade: '4', cost_qty: '2000', cost_sum: '0', price_avg: '380.50' },
    ]));
    json = await render(esun, [pos(esun), short(esun)]);
    expect(total(json)).toBeNull();
});

it('the expandable breakdown lists balance, pending settlements and each row\'s liquidation value', async () => {
    const esun = mkAccount('8840');
    setEsunInventoryDetails(esun, shortDetail());
    fixture.settlements.mockResolvedValue([{ T: 1, date: '2999-01-02', amount: -685000 }]);
    let json = await render(esun, [pos(esun), short(esun), pos(esun, { id: 9, code: '6446', last_price: NaN })]);
    expect(json).not.toContain('交割戶餘額');
    const toggle = view!.root.find(n => n.type === 'button' && n.props.title === '展開組成');
    await act(async () => { toggle.props.onClick(); });
    json = JSON.stringify(view!.toJSON());
    expect(json).toContain('交割戶餘額');
    expect(json).toContain('$500,000');
    expect(json).toContain('-685,000');
    expect(json).toContain('1234 融券 2,000股 清算價值');
    expect(json).toContain('$656,463');
    expect(json).toContain('$995,575');
    expect(json).toMatch(/6446 現股 2,000股 清算價值[\s\S]*?待確認/);
    expect(json).not.toContain('NaN');
});
