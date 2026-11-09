// 產業流向分頁（#/sector）：
// - 頁面掛載才訂閱群組指標（2 指數 × 2 投影＝4 筆），卸載釋放 4 筆；再次進入不重新建底（ADR 0001）。
// - 切換上市／上櫃不新增任何請求（兩個指數同時 retain）。
// - 盤後（market_phase closed）：以建底快照顯示加權漲跌與成交值，流向欄「—」並說明原因；說明「流向自開啟本頁起累計」。
// - 盤中串流：流向自開啟本頁起累計，顯示近 5 分／累計淨流入、摘要前 3 與淨流入橫條；排序五種。
// - 跨過收盤：收到 market_phase closed 的事件後，盤中已量到的流向仍顯示，並標示已收盤。
// - 429：降級顯示、不重試（時間經過、重新進入都不再查詢）、不提供重試鍵；一般錯誤提供重試（只重查、不多送訂閱）。
// - 說明面板的成分股：開啟時 retain 群組內成交值排行 1 條（subscribe 1）、關閉 release（unsubscribe 1），不重新建底；
//   預設成交值排序、可切漲跌幅；名稱與漲跌停只為可見列查合約（每代碼 1 次）；漲停列實心底＋小標；點列關面板並開交易頁；
//   建底錯誤冷卻中開啟面板不 retain。
// - S1：頁面與說明面板所有按鈕都不呼叫 lib 的送單、改單、刪單函式，POST 只有群組指標（含成分股排行）的訂閱與建底。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DATE = '2026-11-06';

type Group = { cat: string; name: string; pct: number; amount: number; ppm?: number };
type Member = { code: string; cat: string; price: number; ref: number; amount: number };

// 上市半導體（24）成分股：2330 收在漲停 1100（合約 limit_up 1100）；金融（28）一檔
const MEMBERS: Member[] = [
    { code: '2303', cat: '24', price: 45.5, ref: 46, amount: 5e9 },
    { code: '2330', cat: '24', price: 1100, ref: 1000, amount: 9e10 },
    { code: '2454', cat: '24', price: 1200, ref: 1180, amount: 2e10 },
    { code: '2881', cat: '28', price: 80, ref: 80, amount: 1e9 },
];
const LIMITS: Record<string, [number, number, string]> = {
    2303: [50.6, 41.4, '聯電'],
    2330: [1100, 900, '台積電'],
    2454: [1295, 1065, '聯發科'],
    2881: [88, 72, '富邦金'],
};

const TWSE: Group[] = [
    { cat: '24', name: '半導體業', pct: 1.5, amount: 3e11, ppm: 400_000 },
    { cat: '28', name: '金融保險業', pct: -0.8, amount: 5e10 },
    { cat: '13', name: '電子零組件業', pct: 0.3, amount: 8e10 },
];
const TPEX: Group[] = [
    { cat: '24', name: '半導體業', pct: -1.2, amount: 4e10 },
    { cat: '22', name: '生技醫療業', pct: 2.1, amount: 1e10 },
];

function snapshot(code: string, phase: string, time: string, groups: Group[]) {
    return {
        contract: { code },
        date: DATE,
        time,
        calculated_at: `${DATE}T${time}.000000+08:00`,
        reference_date: DATE,
        market_phase: phase,
        refresh_state: 'ready',
        simtrade: false,
        total_amount: 0,
        entries: (code === 'IX0001' ? MEMBERS : []).map(e => ({
            contract: { code: e.code },
            category: e.cat,
            price: String(e.price),
            reference: String(e.ref),
            price_chg: String(e.price - e.ref),
            pct_chg: ((e.price - e.ref) / e.ref * 100).toFixed(2),
            points: '0',
            reference_weight_ppm: 50_000,
            total_amount: e.amount,
            amount_share_bps: 0,
            price_source: 'regular',
            trading_status: 'active',
            data_status: 'live',
        })),
        groups: groups.map(g => ({
            category: g.cat,
            name: g.name,
            item_count: 10,
            equal_weight_pct_chg: '0',
            weighted_pct_chg: String(g.pct),
            points: '0',
            reference_weight_ppm: g.ppm ?? 10_000,
            total_amount: g.amount,
            amount_share_bps: 0,
            advance_count: 0,
            decline_count: 0,
            unchanged_count: 0,
            breadth_bps: 0,
        })),
    };
}

const m = vi.hoisted(() => ({
    /** 建底查詢的回應：回傳值或丟出錯誤 */
    bootstrap: (_code: string): unknown => {
        throw new Error('not set');
    },
    handlers: new Map<string, (raw: string) => void>(),
    post: vi.fn(),
    get: vi.fn(),
    navigate: vi.fn(),
    send: {
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelVerifiedOrder: vi.fn(),
        cancelOrders: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelComboOrder: vi.fn(),
    },
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
}));

vi.mock('../../lib/api', () => ({ apiPost: m.post, apiGet: m.get, apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../lib/hash-router', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), navigate: m.navigate }));
vi.mock('../../lib/stream', () => ({
    registerSubscription: vi.fn(),
    unregisterSubscription: vi.fn(),
    registerSubscriptionRaw: vi.fn(),
    registerCapabilitySubscription: vi.fn(),
    unregisterCapabilitySubscription: vi.fn(),
    registerCodeAlias: vi.fn(),
    onStreamEvent: (type: string, handler: (raw: string) => void) => {
        m.handlers.set(type, handler);
        return () => m.handlers.delete(type);
    },
    onAnyTick: () => () => undefined,
    ensureStream: () => undefined,
    streamConnectionEpoch: () => 0,
}));
vi.mock('../../lib/shioaji', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), ...m.send }));
vi.mock('../lib/mobile-store', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    openTicket: m.openTicket,
    openOrderAction: m.openOrderAction,
}));

let view: ReactTestRenderer | undefined;

const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const byTestId = (id: string) => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === id);
const one = (id: string) => byTestId(id)[0]!;
const rowNames = () => byTestId('sector-row-name').map(textOf);
const calls = (prefix: string) => m.post.mock.calls.filter(([path]) => String(path).startsWith(prefix));
const subscribes = () => calls('/api/v1/stream/subscribe/index_components');
const unsubscribes = () => calls('/api/v1/stream/unsubscribe/index_components');
const bootstraps = () => calls('/api/v1/data/index_components');
const indexOf = (call: unknown[]) => (JSON.stringify(call[1]).includes('IX0043') ? 'IX0043' : 'IX0001');

async function settle(ms = 0) {
    for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    if (ms > 0) await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function mount() {
    const { SectorPage } = await import('./sector-page');
    await act(async () => { view = create(createElement(SectorPage)); });
    await settle(1_000);
}

async function unmount() {
    await act(async () => view?.unmount());
    view = undefined;
    await settle();
}

const press = async (id: string) => act(async () => one(id).props.onClick());

function icEvent(code: string, metric: 'amount' | 'weighted_performance', time: string, groups: [string, string, number][], phase = 'continuous_trading') {
    return JSON.stringify({
        contract: { code },
        projection: { kind: 'group_metric', metric },
        date: DATE,
        time,
        calculated_at: `${DATE}T${time}.000000+08:00`,
        market_phase: phase,
        simtrade: false,
        groups: groups.map(([category, name, value]) => ({ category, name, item_count: 10, value: String(value) })),
    });
}

const closedSnapshots = (code: string) => snapshot(code, 'closed', '13:30:00', code === 'IX0043' ? TPEX : TWSE);

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(`${DATE}T10:00:40+08:00`));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.handlers.clear();
    m.post.mockReset();
    m.post.mockImplementation(async (path: string, body?: { contract?: { code?: string } }) => {
        if (path === '/api/v1/data/index_components') return m.bootstrap(body?.contract?.code ?? '');
        return { success: true, message: '' };
    });
    m.bootstrap = closedSnapshots;
    // 合約查詢（成分股名稱與漲跌停）：base → info
    m.get.mockReset();
    m.get.mockImplementation(async (path: string) => {
        const hit = /\/api\/v1\/data\/contracts\/(\w+)(\/info)?\?/.exec(path);
        const info = hit ? LIMITS[hit[1]!] : undefined;
        if (!hit || !info) throw new Error('404 Not Found');
        const base = { code: hit[1], security_type: 'STK', exchange: 'TSE', target_code: null };
        return hit[2] ? { ...base, name: info[2], reference: 0, limit_up: info[0], limit_down: info[1] } : base;
    });
    m.navigate.mockReset();
    for (const f of Object.values(m.send)) f.mockReset();
    m.openTicket.mockReset();
    m.openOrderAction.mockReset();
});

afterEach(async () => {
    await unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('訂閱生命週期（只在本頁掛載時持有）', () => {
    it('載入模組不訂閱；掛載訂閱 4 筆並各建底一次；卸載釋放 4 筆；再次進入不重新建底', async () => {
        await import('./sector-page');
        expect(m.post).not.toHaveBeenCalled();

        await mount();
        expect(subscribes().map(indexOf).sort()).toEqual(['IX0001', 'IX0001', 'IX0043', 'IX0043']);
        expect(bootstraps().map(indexOf).sort()).toEqual(['IX0001', 'IX0043']);
        expect(unsubscribes()).toHaveLength(0);

        await unmount();
        expect(unsubscribes().map(indexOf).sort()).toEqual(['IX0001', 'IX0001', 'IX0043', 'IX0043']);

        await mount();
        expect(subscribes()).toHaveLength(8);
        // ADR 0001：store 為 session 級，remount 不重查
        expect(bootstraps()).toHaveLength(2);
    }, 20_000); // 第一個測試承擔冷啟動的模組轉譯（lib/shioaji 整串依賴）

    it('切換上市／上櫃不新增請求', async () => {
        await mount();
        const before = m.post.mock.calls.length;
        await press('sector-sort-amount');
        expect(rowNames()).toEqual(['半導體業', '電子零組件業', '金融保險業']);
        await press('sector-market-tpex');
        await settle(1_000);
        expect(rowNames()).toEqual(['半導體業', '生技醫療業']);
        expect(textOf(one('sector-list'))).toContain('上櫃 2 個產業');
        expect(textOf(byTestId('sector-row-pct')[0]!)).toBe('▼−1.20%');
        expect(m.post.mock.calls.length).toBe(before);
    });

    it('建底回應前顯示載入骨架', async () => {
        m.bootstrap = () => new Promise(() => undefined);
        await mount();
        expect(byTestId('sector-loading')).toHaveLength(1);
        expect(byTestId('sector-row')).toHaveLength(0);
    });
});

describe('盤後／無即時資料', () => {
    it('以快照顯示加權漲跌與成交值；流向欄「—」並說明原因與「自開啟本頁起累計」', async () => {
        await mount();
        expect(byTestId('sector-row')).toHaveLength(3);
        expect(textOf(one('sector-flow-note'))).toContain('自開啟本頁起累計');
        expect(textOf(one('sector-flow-note'))).toContain('資料時間 13:30:00');
        expect(textOf(one('sector-flow-status'))).toContain('非交易時段');
        const semi = byTestId('sector-row').find(r => r.props['data-key'] === 'IX0001:24')!;
        expect(textOf(semi.findAll(n => n.props['data-testid'] === 'sector-row-pct')[0]!)).toBe('▲+1.50%');
        expect(textOf(semi.findAll(n => n.props['data-testid'] === 'sector-row-amount')[0]!)).toBe('3000 億');
        expect(byTestId('sector-row-flow5').map(textOf)).toEqual(['—', '—', '—']);
        expect(byTestId('sector-row-net').map(textOf)).toEqual(['—', '—', '—']);
        expect(byTestId('sector-flow-bar')).toHaveLength(0);
        expect(textOf(one('sector-top-inflow'))).toContain('—');
        expect(textOf(one('sector-top-outflow'))).toContain('—');
        expect(semi.props['aria-label']).toContain('資金流向 —');
    });

    it('排序：漲幅、跌幅、成交值；流向不可用時資金流入／流出依成交值排列', async () => {
        await mount();
        expect(rowNames()).toEqual(['半導體業', '電子零組件業', '金融保險業']);
        await press('sector-sort-gain');
        expect(rowNames()).toEqual(['半導體業', '電子零組件業', '金融保險業']);
        expect(one('sector-sort-gain').props['aria-pressed']).toBe(true);
        await press('sector-sort-loss');
        expect(rowNames()).toEqual(['金融保險業', '電子零組件業', '半導體業']);
        await press('sector-sort-amount');
        expect(rowNames()).toEqual(['半導體業', '電子零組件業', '金融保險業']);
        await press('sector-sort-outflow');
        expect(rowNames()).toEqual(['半導體業', '電子零組件業', '金融保險業']);
    });
});

describe('盤中串流：流向自開啟本頁起累計', () => {
    it('近 5 分／累計淨流入、摘要前 3、淨流入橫條與資金流入／流出排序', async () => {
        m.bootstrap = code => snapshot(code, 'continuous_trading', '10:00:00', code === 'IX0043' ? TPEX : TWSE);
        await mount();
        // 建底只當基準，尚未量到增量 → 等待中，流向「—」
        expect(textOf(one('sector-flow-status'))).toContain('尚未收到盤中即時資料');
        expect(byTestId('sector-row-net').map(textOf)).toEqual(['—', '—', '—']);

        const handler = m.handlers.get('index_components')!;
        await act(async () => {
            handler(icEvent('IX0001', 'weighted_performance', '10:00:30', [['24', '半導體業', 1.6], ['28', '金融保險業', -0.9], ['13', '電子零組件業', 0.3]]));
            handler(icEvent('IX0001', 'amount', '10:00:30', [['24', '半導體業', 3.01e11], ['28', '金融保險業', 5.05e10], ['13', '電子零組件業', 8e10]]));
        });
        await settle(3_000);

        expect(byTestId('sector-flow-status')).toHaveLength(0);
        const net = (key: string) => textOf(byTestId('sector-row').find(r => r.props['data-key'] === key)!.findAll(n => n.props['data-testid'] === 'sector-row-net')[0]!);
        const flow5 = (key: string) => textOf(byTestId('sector-row').find(r => r.props['data-key'] === key)!.findAll(n => n.props['data-testid'] === 'sector-row-flow5')[0]!);
        expect(net('IX0001:24')).toBe('+10.0 億');
        expect(flow5('IX0001:24')).toBe('+10.0 億');
        expect(net('IX0001:28')).toBe('−5.00 億');
        expect(net('IX0001:13')).toBe('0');
        expect(textOf(one('sector-top-inflow'))).toContain('半導體業');
        expect(textOf(one('sector-top-inflow'))).not.toContain('金融保險業');
        expect(textOf(one('sector-top-outflow'))).toContain('金融保險業');
        expect(byTestId('sector-flow-bar')).toHaveLength(3);

        // 預設依資金流入；流出最多的排第一
        expect(rowNames()).toEqual(['半導體業', '電子零組件業', '金融保險業']);
        await press('sector-sort-outflow');
        expect(rowNames()).toEqual(['金融保險業', '電子零組件業', '半導體業']);

        // 說明面板：完整數值
        await act(async () => byTestId('sector-row').find(r => r.props['data-key'] === 'IX0001:24')!.props.onClick());
        expect(textOf(one('sector-detail-net'))).toBe('+10.0 億');
        expect(textOf(one('sector-detail-turnover'))).toBe('10.0 億');
        expect(textOf(one('sector-detail-weight'))).toBe('40.00%');
        expect(textOf(one('sector-detail-rank'))).toBe('1 / 3');
        expect(textOf(one('sector-detail-count'))).toBe('10 檔');
    });
});

describe('跨過收盤：已量到的流向不被清掉', () => {
    it('盤中量到流向後收到 market_phase closed 的事件：流向、摘要、橫條仍顯示，說明改為已收盤', async () => {
        m.bootstrap = code => snapshot(code, 'continuous_trading', '13:28:00', code === 'IX0043' ? TPEX : TWSE);
        vi.setSystemTime(new Date(`${DATE}T13:28:40+08:00`));
        await mount();
        const handler = m.handlers.get('index_components')!;
        await act(async () => {
            handler(icEvent('IX0001', 'weighted_performance', '13:28:30', [['24', '半導體業', 1.6], ['28', '金融保險業', -0.9], ['13', '電子零組件業', 0.3]]));
            handler(icEvent('IX0001', 'amount', '13:28:30', [['24', '半導體業', 3.01e11], ['28', '金融保險業', 5.05e10], ['13', '電子零組件業', 8e10]]));
        });
        await settle(3_000);
        expect(byTestId('sector-flow-status')).toHaveLength(0);
        const net = (key: string) => textOf(byTestId('sector-row').find(r => r.props['data-key'] === key)!.findAll(n => n.props['data-testid'] === 'sector-row-net')[0]!);
        expect(net('IX0001:24')).toBe('+10.0 億');

        // 收盤集合競價那一包標示 closed（1.7.4 實測 13:30:00 為 closed）
        vi.setSystemTime(new Date(`${DATE}T13:30:05+08:00`));
        await act(async () => {
            handler(icEvent('IX0001', 'weighted_performance', '13:30:00', [['24', '半導體業', 1.7], ['28', '金融保險業', -0.9], ['13', '電子零組件業', 0.3]], 'closed'));
            handler(icEvent('IX0001', 'amount', '13:30:00', [['24', '半導體業', 3.03e11], ['28', '金融保險業', 5.05e10], ['13', '電子零組件業', 8e10]], 'closed'));
        });
        await settle(3_000);

        expect(textOf(one('sector-flow-note'))).toContain('資料時間 13:30:00');
        expect(textOf(one('sector-flow-status'))).toContain('已收盤');
        expect(textOf(one('sector-flow-status'))).not.toContain('非交易時段');
        // 收盤那一分鐘的增量也計入
        expect(net('IX0001:24')).toBe('+30.0 億');
        expect(net('IX0001:28')).toBe('−5.00 億');
        expect(textOf(one('sector-top-inflow'))).toContain('半導體業');
        expect(textOf(one('sector-top-outflow'))).toContain('金融保險業');
        expect(byTestId('sector-flow-bar')).toHaveLength(3);
        expect(rowNames()).toEqual(['半導體業', '電子零組件業', '金融保險業']);

        await act(async () => byTestId('sector-row').find(r => r.props['data-key'] === 'IX0001:24')!.props.onClick());
        expect(textOf(one('sector-detail-net'))).toBe('+30.0 億');
        expect(textOf(one('sector-detail-sheet'))).toContain('已收盤，以下為今日開啟本頁期間量到的流向');
        expect(textOf(one('sector-detail-sheet'))).not.toContain('非交易時段');
    });
});

describe('建底失敗（ADR 0001）', () => {
    it('429：顯示額度用盡、沒有重試鍵；時間經過與重新進入都不再查詢', async () => {
        m.bootstrap = () => { throw new Error('429 Too Many Requests'); };
        await mount();
        expect(bootstraps()).toHaveLength(2);
        expect(byTestId('sector-quota')).toHaveLength(1);
        expect(byTestId('sector-retry')).toHaveLength(0);
        await settle(120_000);
        expect(bootstraps()).toHaveLength(2);
        await unmount();
        await mount();
        expect(bootstraps()).toHaveLength(2);
        expect(byTestId('sector-quota')).toHaveLength(1);
    });

    it('一般錯誤：提供重試；重試只重查該指數一次、不多送訂閱，成功後顯示產業', async () => {
        m.bootstrap = () => { throw new Error('400 bad request'); };
        await mount();
        expect(bootstraps()).toHaveLength(2);
        expect(byTestId('sector-error')).toHaveLength(1);
        const subs = subscribes().length;
        m.bootstrap = closedSnapshots;
        await press('sector-retry');
        await settle(1_000);
        expect(bootstraps()).toHaveLength(3);
        expect(indexOf(bootstraps()[2]!)).toBe('IX0001');
        expect(subscribes()).toHaveLength(subs);
        expect(byTestId('sector-row')).toHaveLength(3);
    });
});

describe('重試（租約，不 retain 後立刻 release）', () => {
    const metricOf = (call: unknown[]) => (JSON.stringify(call[1]).includes('weighted_performance') ? 'wperf' : 'amount');
    const keyOf = (call: unknown[]) => `${indexOf(call)}:${metricOf(call)}`;
    /** 讓指定的 (指數:投影) 訂閱失敗（400：capability 層不重試） */
    function failSubscribe(keys: Set<string>) {
        m.post.mockImplementation(async (path: string, body?: { contract?: { code?: string } }) => {
            if (path === '/api/v1/data/index_components') return m.bootstrap(body?.contract?.code ?? '');
            if (path === '/api/v1/stream/subscribe/index_components' && keys.has(keyOf([path, body]))) throw new Error('400 subscribe rejected');
            return { success: true, message: '' };
        });
    }

    it('只有建底失敗：重試只重查該指數、subscribe／unsubscribe 0 筆；卸載時仍只退訂 4 筆', async () => {
        m.bootstrap = code => { if (code === 'IX0001') throw new Error('400 bad request'); return closedSnapshots(code); };
        await mount();
        expect(byTestId('sector-error')).toHaveLength(1);
        expect(subscribes()).toHaveLength(4);
        m.bootstrap = closedSnapshots;
        await press('sector-retry');
        await settle(1_000);
        expect(bootstraps().map(indexOf)).toEqual(expect.arrayContaining(['IX0001', 'IX0043']));
        expect(bootstraps()).toHaveLength(3);
        expect(indexOf(bootstraps()[2]!)).toBe('IX0001');
        expect(subscribes()).toHaveLength(4);
        expect(unsubscribes()).toHaveLength(0);
        expect(byTestId('sector-row')).toHaveLength(3);
        await unmount();
        expect(unsubscribes().map(keyOf).sort()).toEqual(['IX0001:amount', 'IX0001:wperf', 'IX0043:amount', 'IX0043:wperf']);
    });

    it('訂閱失敗：提示附重試；重試只重送失敗的那一條 subscribe、不送 unsubscribe；成功後提示消失，卸載時該條只退訂 1 次', async () => {
        const failing = new Set(['IX0001:amount']);
        failSubscribe(failing);
        await mount();
        expect(textOf(one('sector-sub-error'))).toContain('即時訂閱失敗');
        expect(byTestId('sector-row')).toHaveLength(3);
        expect(subscribes()).toHaveLength(4);
        failing.clear();
        await press('sector-sub-retry');
        await settle(1_000);
        expect(subscribes().slice(4).map(keyOf)).toEqual(['IX0001:amount']);
        expect(unsubscribes()).toHaveLength(0);
        expect(bootstraps()).toHaveLength(2);
        expect(byTestId('sector-sub-error')).toHaveLength(0);
        await unmount();
        // 每條實際訂閱各退訂 1 次（失敗過的那條：原本的 retain 與租約一起釋放，只送 1 次）
        expect(unsubscribes().map(keyOf).sort()).toEqual(['IX0001:amount', 'IX0001:wperf', 'IX0043:amount', 'IX0043:wperf']);
    });

    it('訂閱重試仍失敗：錯誤提示保留（不被清掉）', async () => {
        failSubscribe(new Set(['IX0001:amount']));
        await mount();
        await press('sector-sub-retry');
        await settle(1_000);
        expect(subscribes().slice(4).map(keyOf)).toEqual(['IX0001:amount']);
        expect(textOf(one('sector-sub-error'))).toContain('400 subscribe rejected');
        expect(unsubscribes()).toHaveLength(0);
    });

    it('建底重試不清掉其他仍存在的訂閱錯誤提示', async () => {
        failSubscribe(new Set(['IX0043:wperf']));
        m.bootstrap = code => { if (code === 'IX0001') throw new Error('400 bad request'); return closedSnapshots(code); };
        await mount();
        await press('sector-market-tpex');
        expect(textOf(one('sector-sub-error'))).toContain('即時訂閱失敗');
        await press('sector-market-twse');
        m.bootstrap = closedSnapshots;
        await press('sector-retry');
        await settle(1_000);
        expect(byTestId('sector-row')).toHaveLength(3);
        expect(subscribes()).toHaveLength(4);
        await press('sector-market-tpex');
        expect(textOf(one('sector-sub-error'))).toContain('即時訂閱失敗');
    });
});

describe('建底錯誤後 60 秒冷卻（手機層）', () => {
    const failTwse = (code: string) => {
        if (code === 'IX0001') throw new Error('400 bad request');
        return closedSnapshots(code);
    };

    it('60 秒內再進入：不訂閱、不自動重新建底；顯示錯誤、暫停提示與重試；手動重試照常', async () => {
        m.bootstrap = failTwse;
        await mount();
        expect(bootstraps()).toHaveLength(2);
        await unmount();
        expect(unsubscribes()).toHaveLength(4);

        vi.setSystemTime(Date.now() + 30_000);
        await mount();
        expect(bootstraps()).toHaveLength(2);
        expect(subscribes()).toHaveLength(4);
        expect(byTestId('sector-error')).toHaveLength(1);
        expect(byTestId('sector-retry')).toHaveLength(1);
        expect(byTestId('sector-paused')).toHaveLength(1);
        // 上櫃（建底正常）仍以 session 快取顯示
        await press('sector-market-tpex');
        expect(byTestId('sector-row')).toHaveLength(2);
        await press('sector-market-twse');

        m.bootstrap = closedSnapshots;
        await press('sector-retry');
        await settle(1_000);
        expect(bootstraps()).toHaveLength(3);
        expect(indexOf(bootstraps()[2]!)).toBe('IX0001');
        expect(subscribes()).toHaveLength(8);
        expect(byTestId('sector-paused')).toHaveLength(0);
        expect(byTestId('sector-row')).toHaveLength(3);
    });

    it('冷卻中停留在本頁：60 秒到才開始訂閱並重新建底一次', async () => {
        m.bootstrap = failTwse;
        await mount();
        await unmount();
        vi.setSystemTime(Date.now() + 10_000);
        await mount();
        expect(subscribes()).toHaveLength(4);
        await settle(45_000); // 錯誤後約 57 秒（第一次 mount 的 1 秒＋10 秒＋第二次 mount 的 1 秒＋45 秒）
        expect(bootstraps()).toHaveLength(2);
        expect(subscribes()).toHaveLength(4);
        await settle(5_000);
        expect(bootstraps()).toHaveLength(3);
        expect(subscribes()).toHaveLength(8);
        expect(byTestId('sector-paused')).toHaveLength(0);
    });

    it('超過 60 秒再進入：照常訂閱並重新建底一次', async () => {
        m.bootstrap = failTwse;
        await mount();
        await unmount();
        vi.setSystemTime(Date.now() + 61_000);
        await mount();
        expect(bootstraps()).toHaveLength(3);
        expect(subscribes()).toHaveLength(8);
        expect(byTestId('sector-paused')).toHaveLength(0);
    });

    it('離開本頁後才失敗（建底進行中離開）也記錄時間', async () => {
        let fail!: () => void;
        m.bootstrap = code => (code === 'IX0001'
            ? new Promise((_, reject) => { fail = () => reject(new Error('400 bad request')); })
            : closedSnapshots(code));
        await mount();
        await unmount();
        await act(async () => { fail(); });
        await settle();
        vi.setSystemTime(Date.now() + 5_000);
        await mount();
        expect(bootstraps()).toHaveLength(2);
        expect(byTestId('sector-paused')).toHaveLength(1);
    });

    it('429 不受影響：仍不重試、不顯示暫停提示', async () => {
        m.bootstrap = () => { throw new Error('429 Too Many Requests'); };
        await mount();
        await unmount();
        await mount();
        expect(bootstraps()).toHaveLength(2);
        expect(byTestId('sector-paused')).toHaveLength(0);
        expect(byTestId('sector-quota')).toHaveLength(1);
    });
});

describe('S1：產業頁不送單', () => {
    it('頁面與說明面板的每個按鈕都不呼叫送單、改單、刪單；請求只有群組指標訂閱與建底', async () => {
        await mount();
        await act(async () => byTestId('sector-row')[0]!.props.onClick());
        expect(byTestId('sector-detail-sheet')).toHaveLength(1);
        expect(byTestId('sector-member').length).toBeGreaterThan(0);
        const buttons = () => view!.root.findAll(n => n.type === 'button');
        const count = buttons().length;
        expect(count).toBeGreaterThan(8);
        for (let i = 0; i < count; i++) {
            const b = buttons()[i];
            if (!b || b.props.disabled) continue;
            await act(async () => b.props.onClick?.({ preventDefault: () => undefined, stopPropagation: () => undefined }));
        }
        for (const f of Object.values(m.send)) expect(f).not.toHaveBeenCalled();
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        const allowed = /^\/api\/v1\/(data\/index_components|stream\/(un)?subscribe\/index_components)$/;
        for (const [path] of m.post.mock.calls) expect(String(path)).toMatch(allowed);
        // GET 只有合約查詢；點成分股只導覽到交易頁
        for (const [path] of m.get.mock.calls) expect(String(path)).toMatch(/^\/api\/v1\/data\/contracts\//);
        for (const [route] of m.navigate.mock.calls) expect(route).toMatchObject({ name: 'trade' });
    });
});

describe('說明面板：成分股（群組內成交值排行）', () => {
    const rankingCalls = (calls: unknown[][]) => calls.filter(c => JSON.stringify(c[1]).includes('"ranking"'));
    const memberCodes = () => byTestId('sector-member').map(r => r.props['data-code'] as string);
    const member = (code: string) => byTestId('sector-member').find(r => r.props['data-code'] === code)!;
    const inMember = (code: string, id: string) => member(code).findAll(n => typeof n.type === 'string' && n.props['data-testid'] === id);
    const openSemi = () => act(async () => byTestId('sector-row').find(r => r.props['data-key'] === 'IX0001:24')!.props.onClick());
    const closeSheet = () => act(async () => view!.root.findAll(n => typeof n.type !== 'string' && n.props.testId === 'sector-detail-sheet')[0]!.props.onClose());
    const lookups = () => m.get.mock.calls.map(([p]) => String(p)).filter(p => /\/contracts\/\w+\?/.test(p));

    it('開啟時 retain 1 條（subscribe 1、不重新建底），關閉 release（unsubscribe 1）；再開啟再訂閱 1', async () => {
        await mount();
        expect(subscribes()).toHaveLength(4);
        expect(bootstraps()).toHaveLength(2);
        await openSemi();
        await settle();
        expect(subscribes()).toHaveLength(5);
        const sub = rankingCalls(subscribes());
        expect(sub).toHaveLength(1);
        expect(JSON.stringify(sub[0]![1])).toContain('IX0001');
        expect(JSON.stringify(sub[0]![1])).toContain('"group":"24"');
        expect(JSON.stringify(sub[0]![1])).toContain('"limit":10');
        expect(bootstraps()).toHaveLength(2);
        expect(unsubscribes()).toHaveLength(0);
        // 建底快照立即投出初始列（同類別 3 檔，預設成交值由大到小）
        expect(memberCodes()).toEqual(['2330', '2454', '2303']);
        expect(textOf(one('sector-members'))).toContain('成交值前 10 檔');

        await closeSheet();
        await settle();
        expect(byTestId('sector-member')).toHaveLength(0);
        expect(rankingCalls(unsubscribes())).toHaveLength(1);
        expect(unsubscribes()).toHaveLength(1);

        await openSemi();
        await settle();
        expect(rankingCalls(subscribes())).toHaveLength(2);
        expect(bootstraps()).toHaveLength(2);
        // 離開本頁：群組指標 4 筆＋成分股 1 筆
        await unmount();
        expect(rankingCalls(unsubscribes())).toHaveLength(2);
        expect(unsubscribes()).toHaveLength(6);
    });

    it('排序：預設成交值，切到漲跌幅只重排同一批、不送請求', async () => {
        await mount();
        await openSemi();
        await settle();
        expect(one('sector-members-sort-amount').props['aria-pressed']).toBe(true);
        await press('sector-members-sort-pct');
        expect(one('sector-members-sort-pct').props['aria-pressed']).toBe(true);
        expect(memberCodes()).toEqual(['2330', '2454', '2303']);
        expect(inMember('2303', 'sector-member-change').map(textOf)).toEqual(['-0.50 -1.09%']);
        await press('sector-members-sort-amount');
        expect(memberCodes()).toEqual(['2330', '2454', '2303']);
        expect(rankingCalls(subscribes())).toHaveLength(1);
    });

    it('名稱與漲跌停：每代碼查一次合約；「名稱 代碼」；漲停列實心 up 底＋「漲停」小標（limitPrice）與無障礙名稱', async () => {
        const { limitPrice } = await import('../styles/watchlist.css');
        await mount();
        await openSemi();
        await settle();
        // 沒有 IntersectionObserver 時前 20 列視為可見（本產業 3 檔）：每代碼 1 次 base GET
        expect(lookups().map(p => /contracts\/(\w+)/.exec(p)![1]).sort()).toEqual(['2303', '2330', '2454']);
        expect(textOf(inMember('2330', 'sector-member-name')[0]!)).toBe('台積電');
        expect(textOf(member('2330'))).toContain('台積電2330');
        const price = inMember('2330', 'sector-member-price')[0]!;
        expect(price.props.className).toContain(limitPrice.up);
        expect(price.props['data-limit']).toBe('up');
        expect(member('2330').props['aria-label']).toContain('台積電 2330，漲停 1,100，');
        expect(inMember('2454', 'sector-member-price')[0]!.props['data-limit']).toBeUndefined();
        expect(inMember('2454', 'sector-member-price')[0]!.props.className).not.toContain(limitPrice.up);
        // 關閉再開啟：已查過的代碼不再查
        await closeSheet();
        await openSemi();
        await settle();
        expect(lookups()).toHaveLength(3);
    });

    it('點成分股：關閉面板並開交易頁；不開下單面板、不送單', async () => {
        await mount();
        await openSemi();
        await settle();
        await act(async () => member('2454').props.onClick());
        await settle();
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2454' });
        expect(byTestId('sector-member')).toHaveLength(0);
        expect(rankingCalls(unsubscribes())).toHaveLength(1);
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        for (const f of Object.values(m.send)) expect(f).not.toHaveBeenCalled();
    });

    it('建底錯誤冷卻中開啟面板：不 retain（不訂閱、不重新建底），顯示暫無資料', async () => {
        m.bootstrap = code => {
            if (code === 'IX0001') throw new Error('400 bad request');
            return closedSnapshots(code);
        };
        await mount();
        await unmount();
        vi.setSystemTime(Date.now() + 30_000);
        await mount();
        expect(byTestId('sector-paused')).toHaveLength(1);
        const subs = subscribes().length;
        const boots = bootstraps().length;
        await press('sector-market-tpex');
        await act(async () => byTestId('sector-row')[0]!.props.onClick());
        await settle();
        expect(byTestId('sector-detail-sheet')).toHaveLength(1);
        expect(subscribes()).toHaveLength(subs);
        expect(bootstraps()).toHaveLength(boots);
        expect(textOf(one('sector-members-empty'))).toBe('暫無成分股資料。');
    });
});
