// 狀態列（規格 §5.2）：
// - B7：目前商品市場已知時只顯示對應槽位的帳戶（股票 selectedStock、期權 selectedFutures），未選擇時顯示「未選擇證券／期貨帳戶」；
//   商品未知時才先證券後期貨。
// - A-1：連線面板在 stale-data 時提供勾選「我了解委託／持倉資料可能過期」（acknowledgeStaleData）與「重試同步」（retryResume）。
// 以 vi.mock 隔離 src/lib。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Acc = { account_type: string; broker_id: string; account_id: string };
const m = vi.hoisted(() => ({
    accounts: { loaded: true, selectedStock: null, selectedFutures: null } as { loaded: boolean; selectedStock: unknown; selectedFutures: unknown },
    contract: undefined as { code: string; security_type: string } | undefined,
    gate: { state: 'ready', since: 0, checks: null, staleAcknowledged: false, resumeSeq: 0, message: null } as {
        state: 'ready' | 'resyncing' | 'stale-data' | 'failed'; since: number; checks: null; staleAcknowledged: boolean; resumeSeq: number; message: string | null;
    },
    acknowledgeStaleData: vi.fn(),
    retryResume: vi.fn(),
}));

vi.mock('../../lib/account-store', () => ({ useAccounts: () => m.accounts }));
vi.mock('../../lib/contracts-cache', () => ({ useContract: () => m.contract }));
vi.mock('../../lib/esun/stream', () => ({ getEsunStreamStatus: () => 'idle' }));
vi.mock('../../lib/order-route', () => ({ routeEnvText: (s: boolean | undefined) => (s === true ? '模擬' : s === false ? '正式' : '環境未確認') }));
vi.mock('../../lib/risk', () => ({ setRiskSettings: vi.fn(), useRiskSettings: () => ({ locked: false }) }));
vi.mock('../../lib/stream', () => ({ getLastHeartbeat: () => 0, streamConnectionEpoch: () => 3 }));
vi.mock('../../lib/trade', () => ({ isFuturesContract: (c: { security_type: string }) => c.security_type === 'FUT' || c.security_type === 'OPT' }));
vi.mock('../../lib/privacy', () => ({ usePrivacyMode: () => false }));
vi.mock('../../hooks/use-stream', () => ({ useStreamStatus: () => 'live' }));
vi.mock('../hooks/use-resume-gate', () => ({ useResumeGate: () => m.gate }));
vi.mock('../lib/resume-gate-runtime', () => ({
    acknowledgeStaleData: () => {
        m.acknowledgeStaleData();
        if (m.gate.state === 'stale-data') m.gate = { ...m.gate, staleAcknowledged: true };
    },
    retryResume: m.retryResume,
}));
vi.mock('../lib/mobile-store', () => ({ useMobileUi: () => ({ currentCode: m.contract?.code ?? null }) }));
vi.mock('./account-switch-sheet', () => ({
    AccountSwitchSheet: () => null,
    mobileAccountLabel: (a: Acc) => `${a.broker_id}-***${a.account_id.slice(-4)}`,
}));
vi.mock('./route-badge', () => ({
    useOrderRoute: (a: Acc | null) => (a ? { broker: '永豐', simulation: true, esun: false } : null),
    routeTone: (r: unknown) => (r ? 'simulation' : 'unknown'),
}));
vi.mock('./slide-to-confirm', () => ({ SlideToConfirm: () => null }));

import { StatusBar, statusBarAccount } from './status-bar';

const stockAcc: Acc = { account_type: 'S', broker_id: '9A95', account_id: '1234567' };
const futAcc: Acc = { account_type: 'F', broker_id: 'F002000', account_id: '7654321' };

let view: ReactTestRenderer | undefined;
async function render() {
    await act(async () => { view = create(createElement(StatusBar)); });
}
async function rerender() {
    await act(async () => { view!.update(createElement(StatusBar)); });
}
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => all(id)[0]!;
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.accounts = { loaded: true, selectedStock: stockAcc, selectedFutures: futAcc };
    m.contract = undefined;
    m.gate = { state: 'ready', since: 0, checks: null, staleAcknowledged: false, resumeSeq: 0, message: null };
    m.acknowledgeStaleData.mockReset();
    m.retryResume.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('B7：狀態列帳戶依目前商品市場', () => {
    it('statusBarAccount：市場已知只看對應槽位，不借用另一市場；未知才先證券後期貨', () => {
        expect(statusBarAccount('stock', { selectedStock: null, selectedFutures: futAcc })).toEqual({ account: null, emptyText: '未選擇證券帳戶' });
        expect(statusBarAccount('futures', { selectedStock: stockAcc, selectedFutures: null })).toEqual({ account: null, emptyText: '未選擇期貨帳戶' });
        expect(statusBarAccount('stock', { selectedStock: stockAcc, selectedFutures: futAcc }).account).toBe(stockAcc);
        expect(statusBarAccount('futures', { selectedStock: stockAcc, selectedFutures: futAcc }).account).toBe(futAcc);
        expect(statusBarAccount(null, { selectedStock: null, selectedFutures: futAcc }).account).toBe(futAcc);
        expect(statusBarAccount(null, { selectedStock: stockAcc, selectedFutures: futAcc }).account).toBe(stockAcc);
        expect(statusBarAccount(null, { selectedStock: null, selectedFutures: null })).toEqual({ account: null, emptyText: '未選擇帳戶' });
    });

    it('目前商品是股票、沒有證券帳戶：顯示「未選擇證券帳戶」而不是期貨帳戶', async () => {
        m.accounts = { loaded: true, selectedStock: null, selectedFutures: futAcc };
        m.contract = { code: '2330', security_type: 'STK' };
        await render();
        const route = textOf(one('status-route'));
        expect(route).toContain('未選擇證券帳戶');
        expect(route).not.toContain('7654321'.slice(-4));
    });

    it('目前商品是選擇權、沒有期貨帳戶：顯示「未選擇期貨帳戶」', async () => {
        m.accounts = { loaded: true, selectedStock: stockAcc, selectedFutures: null };
        m.contract = { code: 'TXO', security_type: 'OPT' };
        await render();
        expect(textOf(one('status-route'))).toContain('未選擇期貨帳戶');
    });

    it('商品已知且有帳戶：顯示該市場的帳戶；商品未知時 fallback 到期貨', async () => {
        m.contract = { code: 'TXFL6', security_type: 'FUT' };
        await render();
        expect(textOf(one('status-route'))).toContain('F002000-***4321');
        m.contract = undefined;
        m.accounts = { loaded: true, selectedStock: null, selectedFutures: futAcc };
        await rerender();
        expect(textOf(one('status-route'))).toContain('F002000-***4321');
    });
});

describe('A-1：連線面板 stale-data 可勾選了解並重試', () => {
    it('stale-data：面板顯示原因、勾選框與「重試同步」；勾選呼叫 acknowledgeStaleData', async () => {
        m.gate = { ...m.gate, state: 'stale-data', message: '委託／持倉或報價資料可能過期：持倉讀取失敗' };
        await render();
        await act(async () => { one('status-connection').props.onClick(); });
        const sheet = one('connection-sheet');
        expect(textOf(sheet)).toContain('持倉讀取失敗');
        expect(textOf(sheet)).toContain('我了解委託／持倉資料可能過期');
        const ack = one('connection-stale-ack');
        expect(ack.props.checked).toBe(false);
        await act(async () => { ack.props.onChange(); });
        expect(m.acknowledgeStaleData).toHaveBeenCalledTimes(1);
        await rerender();
        expect(one('connection-stale-ack').props.checked).toBe(true);
        await act(async () => { one('connection-stale-retry').props.onClick(); });
        expect(m.retryResume).toHaveBeenCalledTimes(1);
    });

    it('ready 時不顯示勾選框', async () => {
        await render();
        await act(async () => { one('status-connection').props.onClick(); });
        expect(all('connection-stale-ack')).toHaveLength(0);
    });
});
