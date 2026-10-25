import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 測試資料全部為合成值（帳號、委託書號、金額皆非真實資料）
const fixture = vi.hoisted(() => ({
    accounts: [] as { account_type: string; broker_id: string; account_id: string; signed: boolean; person_id: string; username: string }[],
    sinopacSim: false, esunSim: false,
    pnl: vi.fn(), summary: vi.fn(), settlements: vi.fn(), limits: vi.fn(), reserve: vi.fn(),
}));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: fixture.accounts }), getAccountState: () => ({ accounts: fixture.accounts }) }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => 'http://esun-overview-fixture.invalid' }));
vi.mock('../lib/shioaji', () => ({ fetchInfo: async () => ({ simulation: fixture.sinopacSim }), fetchProfitLoss: fixture.pnl, fetchProfitLossSummary: fixture.summary,
    fetchSettlements: fixture.settlements, fetchTradingLimits: fixture.limits, fetchStockReserveSummary: fixture.reserve, fetchStockReserveDetail: fixture.reserve,
    fetchEarmarkingDetail: fixture.reserve, resolveContract: vi.fn(async (code: string) => ({ code, name: '' })), fetchFuturesRoots: vi.fn(async () => []) }));
vi.mock('../lib/esun', async original => ({
    ...await original<object>(),
    useEsunEnvironment: () => ({ environment: fixture.esunSim ? 'SIMULATION' : 'PRODUCTION', isSimulation: fixture.esunSim }),
}));
import { AccountPane, type AccountRefreshControls } from './bottom-dock-account';
import { esunScopedSimulation, taipeiDateTime } from './esun-account-overview';
import { esunFillCosts } from './esun-pnl-details';
import { clearEsunTransactionDetails, esunTradeService, fromEsunSettlements, isEstimatedEsunSettlement, parseEsunTransactionDetail, setEsunTransactionDetails, type EsunAccountOverview } from '../lib/esun';
import { setPrivacyMode, setPrivacyMoney } from '../lib/privacy';
import { todayStr } from '../lib/utils/date';

const account = (broker_id: string, account_id: string) => ({ account_type: 'S', broker_id, account_id, signed: true, person_id: '', username: '' });
const overview = (over: Partial<EsunAccountOverview['balance']> = {}): EsunAccountOverview => ({
    balance: { availableBalance: 123456, exchangeBalance: 7890, preSaveAmount: 22222, isLatestData: false,
        updatedAt: '2026-10-26T01:02:03.000Z', cached: true, cacheAgeSec: 12, ...over },
    tradeStatus: { tradeLimit: 5000000, marginLimit: 3000000, shortLimit: 1000000, dayTradeCode: 'X', dayTradeLabel: '已啟用',
        marginCode: '1', marginLabel: '可買', shortCode: '9', shortLabel: '不可買賣' },
    marketStatus: { isTradingDay: true, lastTradingDay: '2026-10-23', nextTradingDay: '2026-10-27' },
});

let view: ReactTestRenderer | undefined;
const json = () => JSON.stringify(view!.toJSON());
type Node = ReturnType<ReactTestRenderer['toJSON']>;
const textOf = (node: Node | string | Node[]): string => {
    if (node === null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join('');
    return (node.children ?? []).map(c => textOf(c as Node | string)).join('');
};
/** 標題以 title 開頭的帳務區塊（section）的純文字；找不到回 '' */
const sectionText = (title: string): string => {
    const found: string[] = [];
    const walk = (node: Node | string | Node[]) => {
        if (!node || typeof node === 'string') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const text = textOf(node);
        if (node.type === 'section' && text.startsWith(title)) found.push(text);
        (node.children ?? []).forEach(c => walk(c as Node | string));
    };
    walk(view!.toJSON());
    return found.join('\n');
};
function setup() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    fixture.pnl.mockReset().mockResolvedValue([]);
    fixture.summary.mockReset().mockResolvedValue({ total: { pnl: 0 }, profitloss_sum: [] });
    fixture.settlements.mockReset().mockResolvedValue([]);
    fixture.limits.mockReset().mockResolvedValue({ trading_limit: 0, trading_used: 0, trading_available: 0, margin_limit: 0, margin_used: 0, margin_available: 0, short_limit: 0, short_used: 0, short_available: 0 });
    fixture.reserve.mockReset().mockResolvedValue({ stocks: [] });
}
async function mount(props: Record<string, unknown> = {}) {
    await act(async () => { view = create(createElement(AccountPane, { positions: [], market: 'S', scopeAccount: null, ...props })); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
}
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    fixture.sinopacSim = false; fixture.esunSim = false;
    setPrivacyMoney(false); setPrivacyMode(false);
    clearEsunTransactionDetails();
});

describe('esunScopedSimulation', () => {
    it('依券商決定模擬旗標，兩家並存時兩家都模擬才算模擬', () => {
        const esun = { broker_id: '8840' };
        const sinopac = { broker_id: '9A95' };
        expect(esunScopedSimulation([esun], false, true)).toBe(true);
        expect(esunScopedSimulation([esun], true, false)).toBe(false);
        expect(esunScopedSimulation([sinopac], true, false)).toBe(true);
        expect(esunScopedSimulation([esun, sinopac], true, false)).toBe(false);
        expect(esunScopedSimulation([esun, sinopac], false, true)).toBe(false);
        expect(esunScopedSimulation([esun, sinopac], true, true)).toBe(true);
        expect(esunScopedSimulation([], true, false)).toBe(true);
    });
    it('資料時間以台北時間顯示', () => {
        expect(taipeiDateTime('2026-10-26T13:30:05.000Z')).toBe('2026-10-26 21:30:05');
        expect(taipeiDateTime('')).toBe('');
    });
    it('交易成本加總不把缺值當 0', () => {
        const d = parseEsunTransactionDetail({ mat_dats: [{ fee: '10', tax: '', tax_g: null }, { fee: 5, db_fee: '3' }] }, 1);
        expect(esunFillCosts(d.fills)).toEqual({ fee: 15, tax: null, capitalGainsTax: null, shortFee: 3, total: 18 });
    });
});

it('玉山帳戶顯示概覽區塊與標籤，交易額度不與永豐合計，refresh／error 併入帳務控制', async () => {
    setup();
    vi.useFakeTimers();
    fixture.accounts = [account('8840', 'EA1'), account('9A95', 'SA1')];
    fixture.limits.mockResolvedValue({ trading_limit: 1000, trading_used: 300, trading_available: 700, margin_limit: 0, margin_used: 0, margin_available: 0, short_limit: 0, short_used: 0, short_available: 0 });
    const spy = vi.spyOn(esunTradeService, 'fetchAccountOverview').mockResolvedValue(overview());
    let controls: AccountRefreshControls | null = null;
    await mount({ onRefreshControls: (c: AccountRefreshControls | null) => { controls = c; } });
    // 上游額度查詢只查永豐帳戶
    expect(fixture.limits.mock.calls.map(c => c[0].account_id)).toEqual(['SA1']);
    expect(fixture.reserve.mock.calls.every(c => c[0].account_id === 'SA1')).toBe(true);
    expect(spy.mock.calls.map(c => c[0].account_id)).toEqual(['EA1']);
    const out = json();
    expect(out).toContain('$700');
    expect(out).toContain('$1,000');
    expect(out).toContain('$5,000,000');
    expect(out).not.toContain('5,000,700');
    expect(out).not.toContain('5,001,000');
    // 銀行餘額
    for (const text of ['可用銀行餘額', '$123,456', '今日票據交換金額', '$7,890', '圈存金額', '$22,222', '2026-10-26 09:02:03', '非最新資料', '快取 12 秒前']) {
        expect(out).toContain(text);
    }
    // 交易額度及權限
    for (const text of ['交易額度及權限', '融資額度', '$3,000,000', '融券額度', '券商提供之額度，未提供已用／剩餘', '現股當沖', '已啟用', '可買', '不可買賣']) {
        expect(out).toContain(text);
    }
    // 市場狀態與交割提示
    for (const text of ['今日是否開盤', '開盤', '上個交易日', '2026-10-23', '下個交易日', '2026-10-27', '盤中交割款為試算，21:00 帳務更新後為正確 T+2 金額']) {
        expect(out).toContain(text);
    }
    spy.mockRejectedValue(new Error('玉山銀行餘額查詢失敗：合成錯誤'));
    await act(async () => { vi.advanceTimersByTime(1600); await controls!.refresh(); });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(controls!.error).toContain('合成錯誤');
    // 失敗的重新整理保留上一份快照
    expect(json()).toContain('$123,456');
});

it('玉山帳戶以圈存金額取代預收查詢，模擬環境也不顯示「模擬模式不支援預收券款」', async () => {
    setup();
    fixture.esunSim = true;
    fixture.accounts = [account('8840', 'EA2')];
    vi.spyOn(esunTradeService, 'fetchAccountOverview').mockResolvedValue(overview({ cached: false, isLatestData: true }));
    await mount();
    const out = json();
    expect(fixture.reserve).not.toHaveBeenCalled();
    expect(fixture.limits).not.toHaveBeenCalled();
    expect(out).toContain('玉山未提供逐檔預收明細');
    expect(out).toContain('$22,222');
    expect(out).not.toContain('模擬模式不支援預收券款');
    expect(out).not.toContain('目前無可預收股票與預收紀錄');
    expect(out).not.toContain('非交易時段無額度資料');
    expect(out).not.toContain('非最新資料');
    expect(out).not.toContain('快取');
});

it('模擬提示依券商：玉山帳戶看玉山環境，兩家並存時兩家都模擬才提示', async () => {
    setup();
    const esun = account('8840', 'EA3');
    const sinopac = account('9A95', 'SA3');
    vi.spyOn(esunTradeService, 'fetchAccountOverview').mockResolvedValue(overview());
    const funds = (rows: ReturnType<typeof account>[]) => rows.map(a => ({ account: a, balance: { acc_balance: 0, date: '', errmsg: '' } }));

    // 只有玉山：永豐模擬、玉山正式 → 不提示
    fixture.accounts = [esun];
    fixture.sinopacSim = true; fixture.esunSim = false;
    await mount({ funds: funds([esun]) });
    expect(json()).not.toContain('模擬模式無法查詢');
    await act(async () => view!.unmount()); view = undefined;

    // 只有玉山：玉山模擬 → 提示
    fixture.sinopacSim = false; fixture.esunSim = true;
    await mount({ funds: funds([esun]) });
    expect(json()).toContain('模擬模式無法查詢');
    await act(async () => view!.unmount()); view = undefined;

    // 兩家並存：永豐模擬、玉山正式 → 證券交割帳戶（含玉山）不提示；
    // 交易額度與預收只含永豐資料 → 依永豐旗標提示模擬
    fixture.accounts = [esun, sinopac];
    fixture.sinopacSim = true; fixture.esunSim = false;
    await mount({ funds: funds([esun, sinopac]) });
    expect(sectionText('資金狀態')).not.toContain('模擬模式');
    expect(sectionText('交易額度 Trading Limits')).toContain('模擬模式無法查詢');
    expect(sectionText('預收券款/圈存 Reserve')).toContain('模擬模式不支援預收券款');
    await act(async () => view!.unmount()); view = undefined;

    // 兩家並存：永豐正式、玉山模擬 → 證券交割帳戶不提示，額度與預收也不提示
    fixture.sinopacSim = false; fixture.esunSim = true;
    await mount({ funds: funds([esun, sinopac]) });
    expect(sectionText('資金狀態')).not.toContain('模擬模式');
    expect(sectionText('交易額度 Trading Limits')).toContain('非交易時段無額度資料');
    expect(sectionText('交易額度 Trading Limits')).not.toContain('模擬模式');
    expect(sectionText('預收券款/圈存 Reserve')).not.toContain('模擬模式');
    await act(async () => view!.unmount()); view = undefined;

    // 兩家都模擬 → 提示
    fixture.sinopacSim = true; fixture.esunSim = true;
    await mount({ funds: funds([esun, sinopac]) });
    expect(sectionText('資金狀態')).toContain('模擬模式無法查詢');
    expect(sectionText('交易額度 Trading Limits')).toContain('模擬模式無法查詢');
    expect(sectionText('預收券款/圈存 Reserve')).toContain('模擬模式不支援預收券款');
});

it('期貨保證金提示只看永豐旗標，不受玉山環境影響', async () => {
    setup();
    const esun = account('8840', 'EA6');
    const future = { ...account('9A95', 'FA6'), account_type: 'F' };
    fixture.accounts = [esun, future];
    vi.spyOn(esunTradeService, 'fetchAccountOverview').mockResolvedValue(overview());
    const margin = { equity: 0, initial_margin: 0, available_margin: 0, today_balance: 0, maintenance_margin: 0, risk_indicator: 0,
        future_settle_profitloss: 0, future_open_position: 0, plus_margin_indicator: 0 };
    const funds = [{ account: esun, balance: { acc_balance: 0, date: '', errmsg: '' } }, { account: future, margin }];

    // 永豐正式、玉山模擬：證券（只有玉山）提示，期貨不提示
    fixture.sinopacSim = false; fixture.esunSim = true;
    await mount({ funds, market: 'all' });
    const fundsText = sectionText('資金狀態');
    expect(fundsText).toContain('證券交割帳戶 Balance模擬模式無法查詢');
    expect(fundsText).not.toContain('期貨帳務 Margin模擬模式無法查詢');
    await act(async () => view!.unmount()); view = undefined;

    // 永豐模擬、玉山正式：證券不提示，期貨提示
    fixture.sinopacSim = true; fixture.esunSim = false;
    await mount({ funds, market: 'all' });
    expect(sectionText('資金狀態')).not.toContain('證券交割帳戶 Balance模擬模式無法查詢');
    expect(sectionText('資金狀態')).toContain('期貨帳務 Margin模擬模式無法查詢');
});

function seedTransactions(accountId: string) {
    const today = todayStr();
    const ymd = today.replace(/-/g, '');
    const detail = parseEsunTransactionDetail({
        stk_no: '2330', stk_na: '測試股', buy_sell: 'S', trade: '0', s_type: 'H', t_date: ymd, c_date: ymd,
        qty: '1000', price_avg: '612.5', price_qty: '612500', cost: '-600855', recv: '610300', make: '9445', make_per: '1.57',
        mat_dats: [{ order_no: 'Z9001', t_date: ymd, t_time: '101530', c_date: ymd, price: '612.5', qty: '1000', price_qty: '612500',
            fee: '872', db_fee: '0', tax: '1837', tax_g: '0', pay_n: '609791', make: '9445', make_per: '1.57' }],
    }, 1);
    // 與 fetchProfitLoss 的預設區間相同：begin／end 皆為 todayStr()
    setEsunTransactionDetails({ broker_id: '8840', account_id: accountId }, today, today, [detail]);
    fixture.pnl.mockImplementation(async (_m: string, a: { account_id: string }) => a.account_id === accountId
        ? [{ id: 1, code: '2330', quantity: 1, pnl: 9445, date: ymd, dseq: '', price: 612.5, pr_ratio: 1.57, cond: 'Cash', seqno: '' }] : []);
    fixture.summary.mockResolvedValue({ total: { pnl: 9445 }, profitloss_sum: [] });
}

async function expandEsunRow() {
    const toggle = view!.root.findAll(n => n.type === 'button' && n.props.title === '展開明細')[0]!;
    await act(async () => { toggle.props.onClick(); });
    const rowToggle = view!.root.findAll(n => n.type === 'button' && n.props.title === '展開交易成本明細')[0]!;
    await act(async () => { rowToggle.props.onClick(); });
}

it('已實現損益玉山列展開後顯示交易成本與逐筆成交，區塊顯示今日交易成本合計', async () => {
    setup();
    fixture.accounts = [account('8840', 'EA4')];
    vi.spyOn(esunTradeService, 'fetchAccountOverview').mockResolvedValue(overview());
    seedTransactions('EA4');
    await mount();
    expect(json()).toContain('今日交易成本合計（玉山）');
    expect(json()).toContain('$2,709');
    await expandEsunRow();
    const out = json();
    for (const text of ['交易類別', '現股', '成交均價', '612.5', '股數', '1,000 股', '價金小計', '$612,500', '成本', '$-600,855', '收入', '$610,300',
        '已實現損益', '+9,445', '獲利率', '+1.57%', '手續費', '$872', '交易稅', '$1,837', '證所稅', '融券手續費', '成本合計',
        '成交日期 時間', ' 10:15:30', '委託書號', 'Z9001', '淨收付', '+609,791']) {
        expect(out).toContain(text);
    }
});

it('隱私模式遮蔽玉山概覽金額、成本明細與委託書號', async () => {
    setup();
    fixture.accounts = [account('8840', 'EA5')];
    vi.spyOn(esunTradeService, 'fetchAccountOverview').mockResolvedValue(overview());
    seedTransactions('EA5');
    setPrivacyMoney(true);
    setPrivacyMode(true);
    await mount();
    await expandEsunRow();
    const out = json();
    expect(out).toContain('可用銀行餘額');
    expect(out).toContain('手續費');
    for (const secret of ['123,456', '22,222', '5,000,000', '2,709', '612,500', '600,855', '9,445', 'Z9001', '1,837']) {
        expect(out).not.toContain(secret);
    }
    expect(out).toContain('•••01');
    expect(out).toContain('•••••');
});

describe('交割行事曆：玉山與永豐帳戶合計', () => {
    // 合成情境：10/29 假設為休市日，永豐真實列 T+1 為 10/30；玉山無 market_status，T+1／T+2 為只跳週末的推算格
    const now = Date.UTC(2026, 9, 28, 4); // 台北 2026-10-28 12:00
    const sinopacRows = [
        { T: 0, date: '2026-10-28', amount: 100 },
        { T: 1, date: '2026-10-30', amount: -50 },
        { T: 2, date: '2026-11-02', amount: 20 },
    ];

    it('玉山推算的 0 元格讓位給永豐真實列的日期，金額加總不報錯', async () => {
        setup();
        const esun = account('8840', 'EA7');
        const sinopac = account('9A95', 'SA7');
        fixture.accounts = [esun, sinopac];
        vi.spyOn(esunTradeService, 'fetchAccountOverview').mockResolvedValue(overview());
        const esunRows = fromEsunSettlements([{ c_date: '20261028', price: '300' }], null, now);
        expect(esunRows.map(r => [r.date, isEstimatedEsunSettlement(r)])).toEqual([
            ['2026-10-28', false], ['2026-10-29', true], ['2026-10-30', true],
        ]);
        fixture.settlements.mockImplementation(async (a: { account_id: string }) => a.account_id === 'EA7' ? esunRows : sinopacRows);
        let controls: AccountRefreshControls | null = null;
        await mount({ onRefreshControls: (c: AccountRefreshControls | null) => { controls = c; } });
        const text = sectionText('交割行事曆');
        expect(text).toContain('T+010/28 (三)+400');
        expect(text).toContain('T+110/30 (五)-50');
        expect(text).toContain('T+211/02 (一)+20');
        expect(text).not.toContain('載入交割資訊');
        expect(controls!.error ?? '').not.toContain('交割日期不一致');
    });

    it('兩邊都是真實列且日期不同時仍報錯，交割區塊顯示錯誤而不是一直載入', async () => {
        setup();
        const esun = account('8840', 'EA8');
        const sinopac = account('9A95', 'SA8');
        fixture.accounts = [esun, sinopac];
        vi.spyOn(esunTradeService, 'fetchAccountOverview').mockResolvedValue(overview());
        // 玉山 T+1 有真實款項（10/29），永豐 T+1 為 10/30
        const esunRows = fromEsunSettlements([{ c_date: '20261029', price: '70' }], null, now);
        expect(isEstimatedEsunSettlement(esunRows[1]!)).toBe(false);
        fixture.settlements.mockImplementation(async (a: { account_id: string }) => a.account_id === 'EA8' ? esunRows : sinopacRows);
        let controls: AccountRefreshControls | null = null;
        await mount({ onRefreshControls: (c: AccountRefreshControls | null) => { controls = c; } });
        expect(controls!.error).toContain('帳戶交割日期不一致，合計待確認');
        const text = sectionText('交割行事曆');
        expect(text).toContain('交割資訊查詢失敗：帳戶交割日期不一致，合計待確認');
        expect(text).not.toContain('載入交割資訊');
    });
});
