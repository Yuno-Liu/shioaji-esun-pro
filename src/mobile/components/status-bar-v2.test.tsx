// 狀態列 v2（設計規格 §6.5、§11）：
// - 整條淡染以 data-tone 表達（非 LIVE／ResumeGate 非 ready）；正式環境 data-env="production"（下緣 2px danger）。
// - 路由膠囊：券商＋環境小膠囊＋帳號，文字串接不變；不再用 ▾ 字元與鎖頭 emoji（改 lucide 圖示）。
// - aria-live：鎖單「改變」時宣告（首次不宣告）；連線狀態維持 2 秒以上才宣告，閃斷回復不宣告。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Acc = { account_type: string; broker_id: string; account_id: string };
const m = vi.hoisted(() => ({
    locked: false,
    stream: 'live' as 'live' | 'connecting' | 'down' | 'stale',
    simulation: true as boolean | undefined,
    accounts: { loaded: true, selectedStock: null, selectedFutures: null } as { loaded: boolean; selectedStock: unknown; selectedFutures: unknown },
    gateState: 'ready' as 'ready' | 'resyncing' | 'stale-data' | 'failed',
}));

vi.mock('../../lib/account-store', () => ({ useAccounts: () => m.accounts }));
vi.mock('../../lib/contracts-cache', () => ({ useContract: () => undefined }));
vi.mock('../../lib/esun/stream', () => ({ getEsunStreamStatus: () => 'idle' }));
vi.mock('../../lib/order-route', () => ({ routeEnvText: (s: boolean | undefined) => (s === true ? '模擬' : s === false ? '正式' : '環境未確認') }));
vi.mock('../../lib/risk', () => ({ setRiskSettings: vi.fn(), useRiskSettings: () => ({ locked: m.locked }) }));
vi.mock('../../lib/stream', () => ({ getLastHeartbeat: () => 0, streamConnectionEpoch: () => 1 }));
const NO_NOTICES: never[] = [];
vi.mock('../../lib/trade', () => ({ isFuturesContract: () => false, getNoticeLog: () => NO_NOTICES, subscribeNoticeLog: () => () => undefined }));
vi.mock('../../lib/privacy', () => ({ usePrivacyMode: () => false }));
vi.mock('../../hooks/use-stream', () => ({ useStreamStatus: () => m.stream }));
vi.mock('../hooks/use-resume-gate', () => ({
    useResumeGate: () => ({ state: m.gateState, since: 0, checks: null, staleAcknowledged: false, resumeSeq: 0, message: null }),
}));
vi.mock('../lib/resume-gate-runtime', () => ({ acknowledgeStaleData: vi.fn(), retryResume: vi.fn() }));
vi.mock('../lib/mobile-store', () => ({ useMobileUi: () => ({ currentCode: null }) }));
vi.mock('./account-switch-sheet', () => ({
    AccountSwitchSheet: () => null,
    mobileAccountLabel: (a: Acc) => `${a.broker_id}-***${a.account_id.slice(-4)}`,
}));
vi.mock('./route-badge', () => ({
    useOrderRoute: (a: Acc | null) => (a ? { broker: '永豐', simulation: m.simulation, esun: false } : null),
    routeTone: (r: { simulation: boolean | undefined } | null) =>
        (!r ? 'unknown' : r.simulation === true ? 'simulation' : r.simulation === false ? 'production' : 'unknown'),
}));
vi.mock('./bottom-sheet', () => ({ BottomSheet: () => null }));
vi.mock('./slide-to-confirm', () => ({ SlideToConfirm: () => null }));

import { CONNECTION_ANNOUNCE_DELAY_MS, LOCK_ANNOUNCE_DELAY_MS, LOCK_ANNOUNCE_TEXT, StatusBar } from './status-bar';

const stockAcc: Acc = { account_type: 'S', broker_id: '9A95', account_id: '1234567' };

let view: ReactTestRenderer | undefined;
const render = () => act(async () => { view = create(createElement(StatusBar)); });
const rerender = () => act(async () => { view!.update(createElement(StatusBar)); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => all(id)[0]!;
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const hasSvg = (node: ReactTestInstance) => node.findAll(n => n.type === 'svg').length > 0;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.locked = false;
    m.stream = 'live';
    m.simulation = true;
    m.gateState = 'ready';
    m.accounts = { loaded: true, selectedStock: stockAcc, selectedFutures: null };
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('狀態列外觀狀態', () => {
    it('LIVE＋模擬：data-tone=live、data-env=simulation；路由文字串接為「永豐 模擬 · 帳號」，以 svg 取代 ▾', async () => {
        await render();
        const bar = one('mobile-status-bar');
        expect(bar.props['data-tone']).toBe('live');
        expect(bar.props['data-env']).toBe('simulation');
        const route = textOf(one('status-route'));
        expect(route).toContain('永豐 模擬 · 9A95-***4567');
        expect(route).not.toContain('▾');
        expect(hasSvg(one('status-route'))).toBe(true);
    });

    it('正式環境：data-env=production（下緣 2px danger）', async () => {
        m.simulation = false;
        await render();
        expect(one('mobile-status-bar').props['data-env']).toBe('production');
        expect(textOf(one('status-route'))).toContain('永豐 正式 · ');
    });

    it('環境未確認：data-env=unknown；沒有帳戶時不標示環境', async () => {
        m.simulation = undefined;
        await render();
        expect(one('mobile-status-bar').props['data-env']).toBe('unknown');
        expect(textOf(one('status-route'))).toContain('環境未確認');
        m.accounts = { loaded: true, selectedStock: null, selectedFutures: null };
        await rerender();
        expect(one('mobile-status-bar').props['data-env']).toBeUndefined();
        expect(textOf(one('status-route-empty'))).toBe('未選擇帳戶');
    });

    it('非 LIVE 與 ResumeGate 非 ready：整條以 data-tone 淡染（連線中／中斷／同步中／資料過期）', async () => {
        const cases: [typeof m.stream, typeof m.gateState, string, string][] = [
            ['connecting', 'ready', 'connecting', '連線中'],
            ['down', 'ready', 'down', '中斷'],
            ['live', 'resyncing', 'syncing', '同步中'],
            ['live', 'stale-data', 'connecting', '資料過期'],
            ['live', 'failed', 'down', '未恢復'],
        ];
        await render();
        for (const [stream, gate, tone, label] of cases) {
            m.stream = stream;
            m.gateState = gate;
            await rerender();
            expect(one('mobile-status-bar').props['data-tone']).toBe(tone);
            expect(one('status-connection').props['aria-label']).toBe(`連線狀態：${label}`);
            expect(textOf(one('status-connection'))).toBe(label);
        }
    });

    it('鎖單：文字「已鎖單」＋lucide 鎖頭（不用 emoji）；未鎖：「風控」', async () => {
        await render();
        expect(textOf(one('status-risk'))).toBe('風控');
        expect(hasSvg(one('status-risk'))).toBe(true);
        m.locked = true;
        await rerender();
        expect(textOf(one('status-risk'))).toBe('已鎖單');
        expect(textOf(one('status-risk'))).not.toMatch(/🔒|🔓/);
        expect(one('status-risk').props['aria-label']).toBe('已鎖單，點擊解除');
        expect(one('status-risk').props['data-locked']).toBe('true');
    });
});

describe('aria-live 宣告', () => {
    it('首次渲染不宣告；鎖單改變時稍後宣告，解除時宣告「已解除鎖單」', async () => {
        await render();
        expect(one('status-lock-live').props['aria-live']).toBe('polite');
        expect(textOf(one('status-lock-live'))).toBe('');
        m.locked = true;
        await rerender();
        expect(textOf(one('status-lock-live'))).toBe('');
        await advance(LOCK_ANNOUNCE_DELAY_MS);
        expect(textOf(one('status-lock-live'))).toBe(LOCK_ANNOUNCE_TEXT.locked);
        m.locked = false;
        await rerender();
        await advance(LOCK_ANNOUNCE_DELAY_MS);
        expect(textOf(one('status-lock-live'))).toBe(LOCK_ANNOUNCE_TEXT.unlocked);
    });

    it('連線狀態維持 2 秒以上才宣告；閃斷在 2 秒內回復則不宣告', async () => {
        await render();
        expect(textOf(one('status-connection-live'))).toBe('');
        m.stream = 'connecting';
        await rerender();
        await advance(CONNECTION_ANNOUNCE_DELAY_MS - 1);
        m.stream = 'live';
        await rerender();
        await advance(CONNECTION_ANNOUNCE_DELAY_MS * 2);
        expect(textOf(one('status-connection-live'))).toBe('');

        m.stream = 'down';
        await rerender();
        await advance(CONNECTION_ANNOUNCE_DELAY_MS - 1);
        expect(textOf(one('status-connection-live'))).toBe('');
        await advance(1);
        expect(textOf(one('status-connection-live'))).toBe('連線狀態：中斷');
    });
});
