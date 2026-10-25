import '../test/mock-order-reconciliation';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
// 測試資料全部合成：帳號、委託書號、金額皆為虛構
const mocks = vi.hoisted(() => ({ width: 1400, notice: '昨餘單位待確認（測試）' as string | undefined }));
vi.mock('../lib/trade', () => ({ placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn(), notify: vi.fn() }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../lib/contracts-cache', () => ({ ensureContract: async (code: string) => ({ code, name: code, security_type: code === 'TMF' ? 'FUT' : 'STK' }) }));
vi.mock('../lib/server-info-store', () => ({ useServerInfo: () => null, yesterdayQuantityNotice: () => mocks.notice, knownServerInfo: () => ({ simulation: true }) }));
vi.mock('./bottom-dock-shared', async original => ({ ...await original<object>(), useMeasuredWidth: () => ({ ref: { current: null }, width: mocks.width }) }));
import { clearEsunInventoryDetails, parseEsunInventoryDetails, setEsunInventoryDetails } from '../lib/esun/account-details';
import { setPrivacyMode, setPrivacyMoney } from '../lib/privacy';
import { setTradingCostSettings, type TradingCostSettings } from '../lib/trading-cost-settings';
import { PositionsPane } from './bottom-dock-positions';

const esunAccount: Account = { account_type: 'S', broker_id: '8840', account_id: 'TEST001', signed: true, person_id: '', username: '' };
const sinoAccount: Account = { account_type: 'S', broker_id: 'BR', account_id: 'SINO001', signed: true, person_id: '', username: '' };
const futAccount: Account = { account_type: 'F', broker_id: 'BRF', account_id: 'FUT001', signed: true, person_id: '', username: '' };

// 均價 54.90、現價 55.20、9000 股、損益含費稅 −201：舊公式 +0.55%，新公式 −0.04%
const esunRow: AccountedPosition = { account: esunAccount, id: 1, code: '9901', direction: 'Buy', quantity: 9000, price: 54.9, last_price: 55.2, pnl: -201, yd_quantity: 9000, cond: 'Cash' };
// 損益不含費用：兩個公式相等（10.00%）
const sinoRow: AccountedPosition = { account: sinoAccount, id: 1, code: '9902', direction: 'Buy', quantity: 1000, price: 100, last_price: 110, pnl: 10000, yd_quantity: 1000, cond: 'Cash' };
const futRow: AccountedPosition = { account: futAccount, id: 1, code: 'TMF', direction: 'Sell', quantity: 2, price: 100, last_price: 105, pnl: -500 };

const lot = (over: Record<string, unknown>) => ({
    buy_sell: 'B', trade: '0', t_date: '20261020', t_time: '093015', price: '54.90', qty: '5000',
    qty_c: '0', qty_h: '0', qty_r: '0', cost_r: '0', fee: '391', tax: '0', tax_g: '0', pay_n: '-274891',
    price_evn: '55.18', make_a: '-111', make_a_per: '-0.04', value_mkt: '276000', value_now: '276000', ord_no: 'Z0001', user_def: '',
    ...over,
});
// 價金 494,100 ＋ 買進手續費 703 ＝ 成本 494,803；市值 496,800 − 預估賣出費稅 2,197 ＝ 未實現收入 494,603；494,603 − 494,803 ＝ −200
const inventory = (over: Record<string, unknown> = {}, lots = [lot({}), lot({ ord_no: 'Z0002', qty: '4000', fee: '312', pay_n: '-219912', make_a: '-89', value_mkt: '220800', value_now: '220800', t_time: '101500' })]) => ({
    stk_no: '9901', stk_na: '測試股', trade: '0', s_type: 'H', ap_code: '', cost_qty: '9000', cost_sum: '-494803', price_avg: '54.90',
    price_evn: '55.18', price_mkt: '55.20', price_now: '55.20', price_qty_sum: '494100', qty_l: '9000', qty_b: '1000', qty_bm: '0',
    qty_s: '0', qty_sm: '0', qty_c: '0', rec_va_sum: '494603', value_mkt: '496800', value_now: '496800', make_a_sum: '-200', make_a_per: '-0.04',
    stk_dats: lots, ...over,
});
const fetchedAt = new Date(2026, 9, 26, 10, 15, 30).getTime();

let view: ReactTestRenderer | undefined;
const onSelectCode = vi.fn();
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    setPrivacyMode(false); setPrivacyMoney(false);
    clearEsunInventoryDetails();
    vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers();
    mocks.width = 1400; mocks.notice = '昨餘單位待確認（測試）';
});
/** 交易成本設定：換成可讀寫的 localStorage 再寫入（mount 的 stub 讀不回值） */
async function costSettings(patch: Partial<TradingCostSettings>) {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    await act(async () => { expect(setTradingCostSettings(patch)).toBe(true); });
}
async function mount(rows: AccountedPosition[]) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    await act(async () => {
        view = create(createElement(PositionsPane, { positions: rows, initialStatus: 'ready', mode: 'merged', market: 'all', scopeKey: '', fallback: { stock: null, futures: null }, onChanged: vi.fn(), onSelectCode }));
    });
}
const textOf = (node: ReactTestInstance | string): string =>
    typeof node === 'string' ? node : node.children.map(textOf).join('');
const allText = () => textOf(view!.root);
const toggles = () => view!.root.findAll(n => n.type === 'button' && n.props.title === '玉山庫存明細');
const rowOf = (code: string) => view!.root.findAllByType('tr').find(tr => textOf(tr.findAllByType('td')[1] ?? tr).startsWith(code))!;
async function expand(index = 0) {
    await act(async () => { toggles()[index]!.props.onClick({ stopPropagation: vi.fn() }); });
}
function seed(rows = [inventory()]) {
    act(() => { setEsunInventoryDetails(esunAccount, parseEsunInventoryDetails(rows), fetchedAt); });
}

it('stock return % is pnl over cost (sign follows pnl); futures keep the price formula', async () => {
    await mount([esunRow, sinoRow, futRow]);
    const cells = (code: string) => rowOf(code).findAllByType('td').map(textOf);
    expect(cells('9901')).toContain('-0.04%');
    expect(cells('9901')).not.toContain('+0.55%');
    expect(cells('9902')).toContain('+10.00%');
    expect(cells('TMF')).toContain('-5.00%');
});

it('only E.SUN stock rows get the expand button; Sinopac rows keep the yesterday notice, E.SUN rows do not', async () => {
    await mount([esunRow, sinoRow, futRow]);
    expect(toggles()).toHaveLength(1);
    expect(toggles()[0]!.props['aria-expanded']).toBe(false);
    const esunCells = rowOf('9901').findAllByType('td');
    const sinoCells = rowOf('9902').findAllByType('td');
    // wide 欄位：0 勾選、1 代碼、2 名稱、3 方向、4 數量、5 昨餘
    expect(textOf(esunCells[5]!)).toBe('9張');
    expect(esunCells[5]!.props.title).toBeUndefined();
    expect(textOf(sinoCells[5]!)).toBe('待確認');
    expect(sinoCells[5]!.props.title).toBe(mocks.notice);
    expect(view!.root.findAllByType('tr')).toHaveLength(4);
});

it('expands an E.SUN row into the broker snapshot with break-even, cost derivation and lots', async () => {
    seed();
    await mount([esunRow, sinoRow]);
    await expand();
    expect(onSelectCode).not.toHaveBeenCalled();
    expect(toggles()[0]!.props['aria-expanded']).toBe(true);
    const detailCell = view!.root.findAll(n => n.type === 'td' && n.props.colSpan === 12);
    expect(detailCell).toHaveLength(1);
    const text = allText();
    for (const s of ['上市', '現股', '整股', '券商快照 10:15:30', '即時行情', '成本股數', '9,000 股', '昨餘股數', '1,000 / 0 股',
        '損益平衡價', '55.18', '即時價（無假除權息）']) expect(text).toContain(s);
    expect(text).not.toContain('有假除權息');
    expect(text).not.toContain('調整股數');
    // 成本算式
    expect(text).toContain('價金總計494,100＋買進手續費703＝成本總計494,803');
    expect(text).toContain('市值496,800−預估賣出手續費及交易稅2,197＝未實現收入494,603');
    expect(text).toContain('未實現收入494,603−成本總計494,803＝未實現損益-200');
    expect(text).toContain('交易成本合計（已付手續費＋預估賣出費稅）2,900');
    expect(text).toContain('券商未實現獲利率-0.04%');
    // 明細表
    const lotsTable = view!.root.findAllByType('table')[1]!;
    const heads = lotsTable.findAllByType('th').map(textOf);
    expect(heads).toEqual(['成交日期 時間', '買賣', '委託書號', '成交價', '股數', '手續費', '交易稅', '證所稅', '淨收付', '損益平衡價', '市值', '未實現損益', '獲利率']);
    const body = lotsTable.findAllByType('tr').slice(1).map(tr => tr.findAllByType('td').map(textOf));
    expect(body[0]).toEqual(['2026-10-20 09:30:15', '買', 'Z0001', '54.90', '5,000', '391', '0', '0', '-274,891', '55.18', '276,000', '-111', '-0.04%']);
    expect(body[1]![2]).toBe('Z0002');
    // 收合
    await expand();
    expect(view!.root.findAll(n => n.type === 'td' && n.props.colSpan === 12)).toHaveLength(0);
});

it('shows optional lot columns, adjusted price and adjust shares only when present', async () => {
    seed([inventory({ price_now: '54.00', qty_c: '-1000' }, [lot({ cost_r: '1200', qty_r: '0' }), lot({ ord_no: 'Z0002' })])]);
    await mount([esunRow]);
    await expand();
    const heads = view!.root.findAllByType('table')[1]!.findAllByType('th').map(textOf);
    expect(heads).toContain('已分攤成本');
    expect(heads).not.toContain('已分攤股數');
    expect(heads).not.toContain('實高權值');
    const text = allText();
    expect(text).toContain('即時價（有假除權息）54.00');
    expect(text).toContain('調整股數-1,000 股');
});

it('lists cash fields without the derivation when broker numbers disagree by more than 1', async () => {
    seed([inventory({ cost_sum: '-494900' })]);
    await mount([esunRow]);
    await expand();
    const text = allText();
    expect(text).not.toContain('＝');
    expect(text).toContain('成本總計494,900');
    expect(text).toContain('相差超過 1 元');
});

it('does not derive margin rows', async () => {
    seed([inventory({ trade: '3' })]);
    await mount([{ ...esunRow, cond: 'MarginTrading' }]);
    await expand();
    const text = allText();
    expect(text).toContain('融資');
    expect(text).not.toContain('＝');
    expect(text).toContain('成本總計-494,803');
    expect(text).toContain('定義和現股不同');
});

it('shows the empty hint when no inventory detail matches', async () => {
    await mount([esunRow]);
    await expand();
    expect(allText()).toContain('尚無玉山庫存明細，請更新帳務');
});

it('masks amounts and order numbers in privacy mode', async () => {
    seed();
    await mount([esunRow]);
    await expand();
    expect(allText()).toContain('Z0001');
    await act(async () => { setPrivacyMoney(true); setPrivacyMode(true); });
    const text = allText();
    for (const s of ['494,100', '494,803', '2,197', '2,900', '55.18', '54.90', '9,000 股', '-274,891', 'Z0001', 'Z0002']) {
        expect(text).not.toContain(s);
    }
    expect(text).toContain('•••01');
    expect(text).toContain('•••••');
});

it('narrow cards expand below the card without selecting the code', async () => {
    mocks.width = 400;
    seed();
    await mount([esunRow, sinoRow]);
    expect(toggles()).toHaveLength(1);
    await expand();
    expect(onSelectCode).not.toHaveBeenCalled();
    expect(allText()).toContain('損益平衡價');
    expect(allText()).toContain('(-0.04%)');
    const cardDetail = view!.root.findAll(n => n.type === 'div' && typeof n.props.onClick === 'function' && textOf(n).startsWith('上市'));
    expect(cardDetail.length).toBeGreaterThan(0);
    const stop = vi.fn();
    cardDetail[0]!.props.onClick({ stopPropagation: stop });
    expect(stop).toHaveBeenCalled();
});

// ---- 交易成本設定（fork）：退佣、融資利息、借券費 ----

it('cash rows under monthly rebate with a discount show the estimated rebate and rebate-adjusted pnl', async () => {
    seed();
    await mount([esunRow]);
    await expand();
    // 預設（月退、無折扣）不顯示退佣
    expect(allText()).not.toContain('預估退佣');
    await costSettings({ feeDiscount: 0.6, rebateMode: 'monthly' });
    // 買進手續費 703：703 − round(421.8) = 281；預估賣出手續費 round(496,800 × 0.1425%) = 708：708 − round(424.8) = 283
    const text = allText();
    expect(text).toContain('預估退佣（月退 6 折）≈ 564');
    expect(text).toContain('含退佣未實現損益≈ +364');
    expect(text).toContain('買進手續費 703 與預估賣出手續費 708');
    expect(text).toContain('≈ 281 ＋ 283');
    // 原有算式不變
    expect(text).toContain('未實現收入494,603−成本總計494,803＝未實現損益-200');
});

it('instant rebate mode does not adjust cash rows', async () => {
    seed();
    await mount([esunRow]);
    await expand();
    await costSettings({ feeDiscount: 0.6, rebateMode: 'instant' });
    expect(allText()).not.toContain('預估退佣');
    expect(allText()).not.toContain('含退佣');
});

it('margin rows estimate financed amount, interest days and interest per lot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00+08:00'));
    seed([inventory({ trade: '3' })]);
    await mount([{ ...esunRow, cond: 'MarginTrading' }]);
    await expand();
    const lotsTable = () => view!.root.findAllByType('table')[1]!;
    const heads = lotsTable().findAllByType('th').map(textOf);
    expect(heads.slice(-3)).toEqual(['融資金額（估）', '計息天數（估）', '預估融資利息']);
    const body = () => lotsTable().findAllByType('tr').slice(1).map(tr => tr.findAllByType('td').map(textOf).slice(-3));
    // 上市 6 成：274,500 → 164,000；219,600 → 131,000。成交 10-20（二）→ 交割 10-22（四）→ 到 10-26 共 4 天
    expect(body()).toEqual([['164,000', '4 天', '—'], ['131,000', '4 天', '—']]);
    expect(allText()).toContain('融資金額合計（估）≈ 295,000');
    expect(allText()).toContain('預估融資利息合計—');
    expect(allText()).toContain('未設定融資年利率');
    expect(allText()).not.toContain('＝');
    await costSettings({ marginAnnualRate: 0.0645 });
    // 164,000 × 6.45% × 4 ÷ 365 = 115.9 → 116；131,000 → 92.6 → 93
    expect(body()).toEqual([['164,000', '4 天', '116'], ['131,000', '4 天', '93']]);
    expect(allText()).toContain('預估融資利息合計≈ 209');
    expect(allText()).toContain('年利率 6.45%');
    expect(allText()).not.toContain('未設定融資年利率');
});

it('OTC margin rows use the 50% ratio', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00+08:00'));
    seed([inventory({ trade: '3', s_type: 'O' })]);
    await mount([{ ...esunRow, cond: 'MarginTrading' }]);
    await expand();
    // 274,500 × 0.5 = 137,250 → 137,000；219,600 × 0.5 = 109,800 → 109,000
    expect(allText()).toContain('融資金額合計（估）≈ 246,000');
});

it('short rows show the estimated borrow fee from the configured rate', async () => {
    seed([inventory({ trade: '4' })]);
    await mount([{ ...esunRow, cond: 'ShortSelling' }]);
    await expand();
    // 494,100 × 0.08% = 395.28 → 395
    expect(allText()).toContain('借券費（估）≈ 395');
    expect(allText()).toContain('借券費率 0.08%');
    await costSettings({ shortFeeRate: 0.001 });
    expect(allText()).toContain('借券費（估）≈ 494');
});
