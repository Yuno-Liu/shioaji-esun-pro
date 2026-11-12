// 「市場 → 盤中異動」（以真的 lib/shioaji 與 lib/market-pulse，只替換 HTTP 與 SSE）：
// - 掛載且在前景才訂閱：預設急漲跌 4 規則 × 上市上櫃＝8 筆 subscribe；卸載退訂 8 筆。
// - 退到背景全部退訂、回前景重新訂閱（各 8 筆）；背景期間不監聽 SSE。
// - 篩選只送差異，並存 localStorage。
// - 部分失敗：顯示覆蓋率與錯誤，時間經過不重送；［重試］只重送失敗的鍵。
// - 列：最新在前、最多 100 列；時間、名稱＋代碼、訊號文字、價格／漲跌；試撮徽章；遺漏提示。
// - 名稱：先讀記憶體（合約快取、名稱目錄；目錄每次顯示呼叫 1 次 ensureEquityNamesFresh）；仍沒有名稱的「可見」列才向永豐
//   查一次合約（每代碼 session 1 次、同時 ≤2、失敗不重試、不可見時取消未開始的查詢）；名稱到達後列顯示「名稱 代碼」。
// - S1：按遍所有按鈕，openTicket／openOrderAction 與 lib 送單、改單、刪單 0 次；點列只 navigate 到交易頁。
import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    handlers: new Map<string, (raw: string) => void>(),
    post: vi.fn(),
    get: vi.fn(),
    navigate: vi.fn(),
    ensureNames: vi.fn(),
    equity: new Map<string, { name: string; aliases: string[] }>(),
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
    /** SignalRow 渲染次數，依訊號時間分列（每次渲染呼叫一次 fmtSignalTime；測試中每筆訊號時間不同） */
    rowRenders: new Map<string, number>(),
    /** 名稱目錄更新通知（subscribeEquityNames 的監聽者） */
    namesListeners: new Set<() => void>(),
}));

vi.mock('../../../lib/api', () => ({ apiPost: m.post, apiGet: m.get, apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../../../lib/stream', () => ({
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
vi.mock('../../../lib/shioaji', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), ...m.send }));
vi.mock('../../../lib/stock-runtime-catalog', () => ({
    ensureEquityNamesFresh: m.ensureNames,
    equityNameForLive: (ex: string, code: string) => m.equity.get(`${ex}:${code}`),
    subscribeEquityNames: (l: () => void) => {
        m.namesListeners.add(l);
        return () => { m.namesListeners.delete(l); };
    },
}));
vi.mock('./signal-model', async importOriginal => {
    const actual = await importOriginal<typeof import('./signal-model')>();
    return {
        ...actual,
        fmtSignalTime: (time: string | undefined) => {
            const text = actual.fmtSignalTime(time);
            m.rowRenders.set(text, (m.rowRenders.get(text) ?? 0) + 1);
            return text;
        },
    };
});
vi.mock('../../../lib/etf-runtime-catalog', () => ({ etfNameForLive: () => undefined, subscribeEtfNames: () => () => undefined }));
vi.mock('../../lib/hash-router', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), navigate: m.navigate }));
vi.mock('../../lib/mobile-store', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    openTicket: m.openTicket,
    openOrderAction: m.openOrderAction,
}));

let view: ReactTestRenderer | undefined;
let doc: EventTarget & { visibilityState: string };
let storage: Map<string, string>;

const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const byTestId = (id: string) => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === id);
const one = (id: string) => byTestId(id)[0]!;
const calls = (prefix: string) => m.post.mock.calls.filter(([path]) => String(path).startsWith(prefix));
const subscribes = () => calls('/api/v1/stream/subscribe/scanner');
const unsubscribes = () => calls('/api/v1/stream/unsubscribe/scanner');
const keyOf = (call: unknown[]) => {
    const body = call[1] as { exchange: string; scanner: string | { id: string } };
    return `${body.exchange}:${typeof body.scanner === 'string' ? body.scanner : body.scanner.id}`;
};

async function settle(ms = 0) {
    for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    if (ms > 0) await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function mount() {
    const { MarketSignals } = await import('./market-signals');
    // 列按鈕的 ref 給一個帶代碼的假節點，假 IntersectionObserver 依代碼切換可見度
    const createNodeMock = (el: ReactElement) => ({ code: (el.props as Record<string, unknown>)['data-code'] });
    await act(async () => { view = create(createElement(MarketSignals), { createNodeMock }); });
    await settle(600);
}

/** 假 IntersectionObserver：記錄觀察中的節點，show/hide 依代碼送出可見度 */
class FakeIO {
    static current: FakeIO | null = null;
    readonly els = new Set<{ code?: string }>();
    constructor(readonly cb: (entries: { target: unknown; isIntersecting: boolean }[]) => void) { FakeIO.current = this; }
    observe(el: { code?: string }) { this.els.add(el); }
    unobserve(el: { code?: string }) { this.els.delete(el); }
    disconnect() { this.els.clear(); }
}
async function visibility(codes: string[], visible: boolean) {
    const io = FakeIO.current!;
    await act(async () => { io.cb([...io.els].filter(e => codes.includes(String(e.code))).map(target => ({ target, isIntersecting: visible }))); });
    await settle();
}

async function unmount() {
    await act(async () => view?.unmount());
    view = undefined;
    await settle();
}

const press = async (id: string) => act(async () => one(id).props.onClick());

/** 退訂在釋放寬限之後才送（signal-subscriptions RELEASE_GRACE_MS 1.5 秒） */
const GRACE = 1_500;

async function setVisibility(state: 'visible' | 'hidden') {
    doc.visibilityState = state;
    await act(async () => { doc.dispatchEvent(new Event('visibilitychange')); });
    await settle(600);
}

let seq = 0;
function scanner(code: string, opts: { rule?: string; exchange?: string; close?: string; diff?: string; sim?: boolean; extra?: object } = {}) {
    seq += 1;
    const t = `09:${String(Math.floor(seq / 60) % 60).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.000000`;
    return JSON.stringify({
        scanner: opts.rule ?? 'trade_price_surge',
        region: 'TW',
        security_type: 'STK',
        exchange: opts.exchange ?? 'TSE',
        quote: { code, date: '2026-11-06', time: t, close: opts.close ?? '100', diff_price: opts.diff ?? '1.5', simtrade: opts.sim ?? false },
        extra: opts.extra ?? { change_percent: '1.2' },
    });
}

async function emit(raw: string) {
    await act(async () => { m.handlers.get('scanner')?.(raw); });
    await settle(600);
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-06T10:00:00+08:00'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    storage = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } });
    m.handlers.clear();
    m.post.mockReset();
    m.post.mockImplementation(async () => ({ success: true, message: 'Subscription successful' }));
    m.get.mockReset();
    m.navigate.mockReset();
    m.ensureNames.mockReset();
    m.equity.clear();
    for (const f of Object.values(m.send)) f.mockReset();
    m.openTicket.mockReset();
    m.openOrderAction.mockReset();
    seq = 0;
    m.rowRenders.clear();
    m.namesListeners.clear();
});

afterEach(async () => {
    await unmount();
    // 釋放寬限結束才真的退訂：lib/shioaji 的 capability ref-count 是跨測試共用的模組狀態，不放掉會讓下一個測試的 subscribe 被當成「沿用」而不送出
    await settle(GRACE);
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('訂閱生命週期', () => {
    it('載入模組不訂閱；掛載訂閱 8 筆（急漲跌 × 上市上櫃）；卸載退訂 8 筆', async () => {
        await import('./market-signals');
        expect(m.post).not.toHaveBeenCalled();
        await mount();
        expect(subscribes().map(keyOf).sort()).toEqual([
            'OTC:ask_price_drop', 'OTC:bid_price_surge', 'OTC:trade_price_drop', 'OTC:trade_price_surge',
            'TSE:ask_price_drop', 'TSE:bid_price_surge', 'TSE:trade_price_drop', 'TSE:trade_price_surge',
        ]);
        expect(textOf(one('signal-coverage'))).toBe('已訂閱 8/8');
        expect(m.handlers.has('scanner')).toBe(true);
        expect(m.ensureNames).toHaveBeenCalledTimes(1);
        await unmount();
        expect(unsubscribes()).toHaveLength(0); // 釋放寬限內
        await settle(GRACE);
        expect(unsubscribes().map(keyOf).sort()).toEqual(subscribes().map(keyOf).sort());
        expect(m.handlers.has('scanner')).toBe(false);
        expect(m.post).toHaveBeenCalledTimes(16);
    }, 20_000); // 第一個測試承擔冷啟動的模組轉譯（lib/shioaji 整串依賴）

    it('退到背景：全部退訂並停止監聽；回前景：重新訂閱 8 筆、名稱目錄再確認 1 次', async () => {
        await mount();
        await setVisibility('hidden');
        await settle(GRACE);
        expect(unsubscribes()).toHaveLength(8);
        expect(m.handlers.has('scanner')).toBe(false);
        await setVisibility('visible');
        expect(subscribes()).toHaveLength(16);
        expect(m.handlers.has('scanner')).toBe(true);
        expect(m.ensureNames).toHaveBeenCalledTimes(2);
        expect(textOf(one('signal-coverage'))).toBe('已訂閱 8/8');
    });

    it('篩選只送差異，並記在 localStorage', async () => {
        await mount();
        await press('signal-family-volume');
        await settle();
        expect(subscribes().slice(8).map(keyOf).sort()).toEqual(['OTC:volume_burst', 'TSE:volume_burst']);
        expect(unsubscribes()).toHaveLength(0);
        expect(one('signal-family-volume').props['aria-pressed']).toBe(true);

        await press('signal-exchange-OTC');
        await settle(GRACE);
        expect(subscribes()).toHaveLength(10);
        expect(unsubscribes().map(keyOf).sort()).toEqual([
            'OTC:ask_price_drop', 'OTC:bid_price_surge', 'OTC:trade_price_drop', 'OTC:trade_price_surge', 'OTC:volume_burst',
        ]);
        expect(textOf(one('signal-coverage'))).toBe('已訂閱 5/5');
        expect(JSON.parse(storage.get('sj-mobile-signal-filters-v1')!)).toEqual({ families: ['move', 'volume'], exchanges: ['TSE'] });

        // 重新進入（寬限之後）：沿用存下的篩選
        await unmount();
        await settle(GRACE);
        const before = subscribes().length;
        await mount();
        expect(subscribes().slice(before).map(keyOf).sort()).toEqual([
            'TSE:ask_price_drop', 'TSE:bid_price_surge', 'TSE:trade_price_drop', 'TSE:trade_price_surge', 'TSE:volume_burst',
        ]);
    });

    it('取消全部篩選：退訂全部、說明需選擇', async () => {
        await mount();
        await press('signal-family-move');
        await settle(GRACE);
        expect(unsubscribes()).toHaveLength(8);
        expect(byTestId('signal-no-filter')).toHaveLength(1);
        expect(textOf(one('signal-coverage'))).toBe('目前沒有訂閱任何訊號。');
    });

    it('部分失敗：顯示覆蓋率與錯誤，不自動重試；［重試］只重送失敗的鍵', async () => {
        let otcFails = true;
        m.post.mockImplementation(async (_path: string, body: { exchange?: string }) =>
            (otcFails && body?.exchange === 'OTC' ? { success: false, message: 'scanner unavailable' } : { success: true, message: '' }));
        await mount();
        expect(subscribes()).toHaveLength(8);
        expect(textOf(one('signal-coverage'))).toBe('已訂閱 4/8');
        expect(textOf(one('signal-sub-error'))).toContain('4 個訊號訂閱失敗');
        await settle(120_000);
        expect(subscribes()).toHaveLength(8);

        otcFails = false;
        await press('signal-retry');
        await settle();
        expect(subscribes().slice(8).map(keyOf).sort()).toEqual([
            'OTC:ask_price_drop', 'OTC:bid_price_surge', 'OTC:trade_price_drop', 'OTC:trade_price_surge',
        ]);
        expect(textOf(one('signal-coverage'))).toBe('已訂閱 8/8');
        expect(byTestId('signal-sub-error')).toHaveLength(0);

        // 失敗過的鍵在重試成功後才會被退訂：卸載退訂 8 筆
        await unmount();
        await settle(GRACE);
        expect(unsubscribes()).toHaveLength(8);
    });
});

describe('釋放寬限', () => {
    it('短暫切到背景、篩選來回切換：寬限內不送退訂與重新訂閱', async () => {
        await mount();
        expect(subscribes()).toHaveLength(8);
        await setVisibility('hidden');
        await setVisibility('visible');
        await press('signal-family-move');
        await settle();
        await press('signal-family-move');
        await settle(GRACE * 2);
        expect(subscribes()).toHaveLength(8);
        expect(unsubscribes()).toHaveLength(0);
        expect(textOf(one('signal-coverage'))).toBe('已訂閱 8/8');
    });
});

describe('清單', () => {
    it('沒有訊號時說明只在交易時段推送', async () => {
        await mount();
        expect(byTestId('signal-empty')).toHaveLength(1);
        expect(view!.root.findAll(n => typeof n.type === 'string' && textOf(n).includes('交易時段')).length).toBeGreaterThan(0);
    });

    it('列：最新在前；時間、名稱＋代碼、訊號文字、價格與漲跌；試撮徽章；篩選外的不列', async () => {
        m.equity.set('TSE:2330', { name: '台積電', aliases: [] });
        await mount();
        await emit(scanner('2330', { close: '1050', diff: '25', extra: { change_percent: '2.44' } }));
        await emit(scanner('6488', { exchange: 'OTC', rule: 'trade_price_drop', close: '400', diff: '-12', sim: true, extra: { change_percent: '-1.5' } }));
        await emit(scanner('2317', { rule: 'volume_burst' })); // 篩選外（爆量未選）
        const rows = byTestId('signal-row');
        expect(rows.map(r => r.props['data-code'])).toEqual(['6488', '2330']);
        expect(byTestId('signal-row-name').map(textOf)).toEqual(['6488', '台積電']);
        expect(byTestId('signal-row-label').map(textOf)).toEqual(['成交急跌', '成交急漲']);
        expect(byTestId('signal-row-detail').map(textOf)).toEqual(['-1.50%', '+2.44%']);
        expect(byTestId('signal-row-price').map(textOf)).toEqual(['400', '1050']);
        expect(byTestId('signal-row-change').map(textOf)).toEqual(['−12 (−2.91%)', '+25 (+2.44%)']);
        expect(byTestId('signal-row-time').map(textOf)).toEqual(['09:00:02', '09:00:01']);
        expect(byTestId('signal-row-sim')).toHaveLength(1);
        expect(rows[0]!.props['aria-label']).toContain('試撮價 400');
        expect(rows[1]!.props['aria-label']).toContain('台積電 2330');
        expect(rows[1]!.props['aria-label']).toContain('成交價 1050');
    });

    it('最多 100 列；沒有名稱的列只在可見時查一次合約（每代碼 1 次、同時 ≤2、失敗與重複出現都不再查）', async () => {
        vi.stubGlobal('IntersectionObserver', FakeIO);
        // 合約 GET 先掛起，由 drain() 依序放行：觀察同時進行中的查詢數
        const held: (() => void)[] = [];
        let maxHeld = 0;
        const failing = new Set(['3170']);
        m.get.mockImplementation((path: string) => new Promise((resolve, reject) => {
            const hit = /\/api\/v1\/data\/contracts\/(\w+)(\/info)?\?/.exec(path);
            held.push(() => {
                if (!hit || failing.has(hit[1]!)) reject(new Error('404 Not Found'));
                else if (!hit[2]) resolve({ code: hit[1], security_type: 'STK', exchange: 'TSE', target_code: null });
                else resolve({ code: hit[1], security_type: 'STK', exchange: 'TSE', target_code: null, name: `名${hit[1]}`, reference: 100, limit_up: 110, limit_down: 90 });
            });
            maxHeld = Math.max(maxHeld, held.length);
        }));
        const drain = async () => {
            while (held.length > 0) {
                // 合約查詢是 base → info 兩段 GET 再寫入快取：在 act 內多讓出幾次微任務，讓快取更新在 act 內送達
                await act(async () => {
                    held.shift()!();
                    for (let i = 0; i < 20; i++) await Promise.resolve();
                });
                await settle();
            }
        };
        const lookups = () => m.get.mock.calls.map(([path]) => String(path)).filter(p => /\/contracts\/\w+\?/.test(p)).map(p => /contracts\/(\w+)/.exec(p)![1]);
        const nameOf = (code: string) => {
            const row = byTestId('signal-row').find(r => r.props['data-code'] === code)!;
            return textOf(row.findAll(n => n.props['data-testid'] === 'signal-row-name')[0]!);
        };

        await mount();
        await act(async () => {
            for (let i = 0; i < 180; i++) m.handlers.get('scanner')?.(scanner(String(3000 + i)));
        });
        await settle(600);
        expect(byTestId('signal-row')).toHaveLength(100);
        expect(byTestId('signal-row')[0]!.props['data-code']).toBe('3179');
        // 還沒有任何列可見：0 個合約查詢
        expect(m.get).not.toHaveBeenCalled();

        // 5 列可見：同時最多 2 個查詢，其餘排隊；名稱到達前只顯示代碼
        await visibility(['3179', '3178', '3177', '3176', '3175'], true);
        expect(lookups()).toEqual(['3179', '3178']);
        expect(nameOf('3179')).toBe('3179');
        await drain();
        expect(maxHeld).toBeLessThanOrEqual(2);
        expect(lookups().sort()).toEqual(['3175', '3176', '3177', '3178', '3179']);
        // 名稱到達：「名稱 代碼」
        expect(nameOf('3179')).toBe('名3179');
        const row = byTestId('signal-row').find(r => r.props['data-code'] === '3179')!;
        expect(textOf(row)).toContain('名31793179');
        expect(row.props['aria-label']).toContain('名3179 3179');

        // 排隊中就變不可見：取消，不查；之後再可見才查（仍只 1 次）
        await visibility(['3174', '3173', '3172'], true);
        expect(lookups().slice(5)).toEqual(['3174', '3173']);
        await visibility(['3172'], false);
        await drain();
        expect(lookups()).not.toContain('3172');
        await visibility(['3172'], true);
        await drain();
        expect(lookups().filter(c => c === '3172')).toHaveLength(1);

        // 查詢失敗：只顯示代碼，不可見再可見、或再收到同代碼的訊號都不重查
        await visibility(['3170'], true);
        await drain();
        expect(lookups().filter(c => c === '3170')).toHaveLength(1);
        expect(nameOf('3170')).toBe('3170');
        await visibility(['3170'], false);
        await visibility(['3170'], true);
        await emit(scanner('3170'));
        await emit(scanner('3179'));
        await visibility(['3170', '3179'], true);
        await drain();
        expect(lookups().filter(c => c === '3170')).toHaveLength(1);
        expect(lookups().filter(c => c === '3179')).toHaveLength(1);
        expect(maxHeld).toBeLessThanOrEqual(2);
        // 只有合約 GET；POST 只有 scanner 訂閱
        expect(m.get.mock.calls.every(([path]) => String(path).startsWith('/api/v1/data/contracts/'))).toBe(true);
        expect(m.post.mock.calls.every(([path]) => String(path).startsWith('/api/v1/stream/'))).toBe(true);
        expect(m.ensureNames).toHaveBeenCalledTimes(1);
    });

    it('串流遺漏：顯示筆數與時間範圍', async () => {
        await mount();
        await emit(JSON.stringify({ dropped_count: 7, first_time: '09:10:00.1', last_time: '09:12:30.9', subscriptions: [] }));
        expect(textOf(one('signal-gap'))).toContain('遺漏 7 筆訊號（09:10:00–09:12:30）');
    });
});

describe('S1：只導覽，不下單', () => {
    it('按遍所有按鈕（篩選、重試、訊號列）：openTicket／openOrderAction 與 lib 送單、改單、刪單 0 次；點列只 navigate 到交易頁', async () => {
        m.post.mockImplementation(async (_path: string, body: { exchange?: string }) =>
            (body?.exchange === 'OTC' ? { success: false, message: 'x' } : { success: true, message: '' }));
        await mount();
        await emit(scanner('2330'));
        await emit(scanner('2603', { rule: 'bid_price_surge' }));
        expect(byTestId('signal-retry')).toHaveLength(1);
        const buttons = view!.root.findAll(n => n.type === 'button');
        expect(buttons.length).toBeGreaterThanOrEqual(9); // 4 種訊號＋2 市場＋重試＋2 列
        // 先取出全部按鈕的文字與處理函式（按篩選會讓列卸載），再逐一按下
        const handlers = buttons.map(b => {
            expect(textOf(b)).not.toMatch(/買進|賣出|下單|送出|刪單|改價/);
            return b.props.onClick as ((e: unknown) => void) | undefined;
        });
        for (const onClick of handlers) {
            await act(async () => { onClick?.({ preventDefault() {}, stopPropagation() {} }); });
        }
        await settle();
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
        expect(m.navigate.mock.calls).toEqual([[{ name: 'trade', code: '2603' }], [{ name: 'trade', code: '2330' }]]);
        expect(m.post.mock.calls.every(([path]) => /^\/api\/v1\/stream\/(un)?subscribe\/scanner$/.test(String(path)))).toBe(true);
    });
});

describe('重繪範圍（效能）', () => {
    const renders = () => Object.fromEntries(m.rowRenders);
    const rowTimes = () => byTestId('signal-row-time').map(textOf);

    it('新訊號插在最上面：既有列不重繪（修正前 index 改變使每列都重繪）', async () => {
        await mount();
        await emit(scanner('2330'));
        await emit(scanner('2317'));
        await emit(scanner('2454'));
        const old = rowTimes();
        expect(old).toHaveLength(3);
        const before = renders();
        await emit(scanner('2603'));
        expect(byTestId('signal-row').map(r => r.props['data-code'])).toEqual(['2603', '2454', '2317', '2330']);
        const after = renders();
        expect(old.map(t => (after[t] ?? 0) - (before[t] ?? 0))).toEqual([0, 0, 0]);
    });

    it('名稱目錄更新：只有名稱改變的列重繪並顯示「名稱 代碼」', async () => {
        await mount();
        await emit(scanner('2330'));
        await emit(scanner('2317'));
        expect(byTestId('signal-row-name').map(textOf)).toEqual(['2317', '2330']);
        const times = rowTimes();
        const before = renders();
        m.equity.set('TSE:2330', { name: '台積電', aliases: [] });
        await act(async () => { m.namesListeners.forEach(l => l()); });
        await settle();
        expect(byTestId('signal-row-name').map(textOf)).toEqual(['2317', '台積電']);
        const after = renders();
        expect(times.map(t => (after[t] ?? 0) - (before[t] ?? 0))).toEqual([0, 1]);
    });
});
