// fork：下單面板成本列（trade-cost-summary）依交易成本設定組字：現股、融資、融券的預估應付／應收。測試資料全為合成值。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';
const h = vi.hoisted(() => {
    const account = { account_type: 'S', broker_id: 'BR', account_id: 'SYNTH001', signed: true, person_id: '', username: '' };
    return { account, accounts: [account] as unknown[] };
});
vi.mock('../lib/account-store', () => {
    const state = () => ({ accounts: h.accounts, selectedStock: h.account, selectedFutures: null, loaded: true });
    return { useAccounts: state, getAccountState: state, selectAccount: vi.fn() };
});
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: vi.fn(), accountConfirmLabel: () => 'synthetic' }));
vi.mock('../lib/risk', () => ({ checkOrderAllowed: vi.fn(), getRiskSettings: () => ({ confirmManualOrders: true }) }));
vi.mock('../lib/shioaji', () => ({ fetchInfo: () => new Promise(() => undefined), placeFuturesOrder: vi.fn(), placeStockOrder: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));
vi.mock('../lib/bracket', () => ({ ensureBracketHost: vi.fn(), registerBracket: vi.fn(), registrationFailureText: String, validateBracketRequest: () => null }));
vi.mock('./bracket-status', () => ({ BracketStatusList: () => null }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'sim' }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => ({ tick: { close: '100' } }), useTradingLive: () => true }));
vi.mock('../lib/price-sync', () => ({ usePickedPrice: () => null }));
vi.mock('../lib/allocation', () => ({ allocateByRatio: (t: number, w: number[]) => w.map(() => t), loadAllocPresets: () => [], saveAllocPreset: () => [], deleteAllocPreset: () => [] }));
import { OrderTicket } from './order-ticket';
import { setTradingCostSettings } from '../lib/trading-cost-settings';

// 一般股票（證交稅 0.3%）、上市，限價 100 × 1 張：金額 100,000、牌告手續費 round(142.5)=143、證交稅 300、借券費 80、融資 6 成 60,000
const contract = { code: '9999', name: '合成股', security_type: 'STK', exchange: 'TSE', reference: 100, day_trade: 'Yes' } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
let view!: ReactTestRenderer;
const btn = (label: string) => view.root.findAllByType('button').find(b => text(b) === label)!;
const costRow = () => {
    const spans = view.root.findAll(n => n.type === 'span' && text(n).startsWith('金額 ') && text(n).includes('估算'));
    return text(spans[spans.length - 1]!);
};

beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('現股買進（預設：月退、無折扣）：預估應付 ≈ 金額＋手續費', () => {
    expect(costRow()).toBe('金額 100,000 · 手續費 ≈ 143 · 預估應付 ≈ 100,143（估算）');
});

it('現股買進、月退 6 折：交割收牌告，另列退佣後手續費；應付以交割手續費計', async () => {
    await act(async () => { setTradingCostSettings({ feeDiscount: 0.6, rebateMode: 'monthly' }); });
    expect(costRow()).toBe('金額 100,000 · 手續費 交割 ≈ 143，退佣後 ≈ 86 · 預估應付 ≈ 100,143（估算）');
});

it('現股買進、成交即折 6 折：手續費與應付都以折後計', async () => {
    await act(async () => { setTradingCostSettings({ feeDiscount: 0.6, rebateMode: 'instant' }); });
    expect(costRow()).toBe('金額 100,000 · 手續費 ≈ 86（6 折） · 預估應付 ≈ 100,086（估算）');
});

it('現股賣出：預估應收 ≈ 金額−交割手續費−證交稅', async () => {
    await act(async () => { btn('賣出 Sell').props.onClick(); });
    expect(costRow()).toBe('金額 100,000 · 手續費 ≈ 143 · 證交稅 ≈ 300 · 預估應收 ≈ 99,557（估算）');
});

it('融券賣出：借券費依設定費率並計入應收，註明保證金未計', async () => {
    await act(async () => { btn('賣出 Sell').props.onClick(); });
    await act(async () => { btn('融券').props.onClick(); });
    expect(costRow()).toBe('金額 100,000 · 手續費 ≈ 143 · 證交稅 ≈ 300 · 借券費 ≈ 80 · 預估應收 ≈ 99,477（估算；另需繳融券保證金，未計）');
    await act(async () => { setTradingCostSettings({ shortFeeRate: 0.001 }); });
    expect(costRow()).toBe('金額 100,000 · 手續費 ≈ 143 · 證交稅 ≈ 300 · 借券費 ≈ 100 · 預估應收 ≈ 99,457（估算；另需繳融券保證金，未計）');
});

it('融資賣出：不計借券費，註明未扣融資本金與利息', async () => {
    await act(async () => { btn('賣出 Sell').props.onClick(); });
    await act(async () => { btn('融資').props.onClick(); });
    expect(costRow()).toBe('金額 100,000 · 手續費 ≈ 143 · 證交稅 ≈ 300 · 預估應收 ≈ 99,557（估算；未扣融資本金與利息）');
    expect(costRow()).not.toContain('借券費');
});

it('融資買進：列融資金額、自備款與應付，不再顯示全額應付；未設定年利率時提示設定', async () => {
    await act(async () => { btn('融資').props.onClick(); });
    expect(costRow()).toBe('金額 100,000 · 手續費 ≈ 143 · 融資金額 ≈ 60,000（上市 6 成估算） · 自備款 ≈ 40,000 · 預估應付 ≈ 40,143 · 設定融資年利率以估算利息（估算）');
    expect(costRow()).not.toContain('100,143');
    // 60,000 × 6.45% ÷ 365 = 10.60 → 11
    await act(async () => { setTradingCostSettings({ marginAnnualRate: 0.0645 }); });
    expect(costRow()).toBe('金額 100,000 · 手續費 ≈ 143 · 融資金額 ≈ 60,000（上市 6 成估算） · 自備款 ≈ 40,000 · 預估應付 ≈ 40,143 · 每日利息 ≈ 11（估算）');
});
