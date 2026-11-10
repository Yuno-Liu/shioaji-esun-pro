// 自選頁底部指數列的收合／展開（watch-index-strip.tsx）與展開面板（watch-index-panel.tsx，延遲載入）。
// - 預設收合（兩格＋切換鍵）；切換鍵 aria-expanded／aria-controls／名稱；狀態存 localStorage（讀寫失敗時退回收合）。
// - 收合時不掛載面板、不讀 K 線；展開後才載入面板 chunk（載入中顯示收合的兩格），每檔讀一次 1 分 K。
// - 面板：指數、漲跌點數與漲跌幅、成交金額（即時 amount_sum 優先、快照 total_amount 後備、空字串視為沒有）、
//   預估成交金額只在有值時顯示、點欄位只導頁、WatchSparkCell 收到的 contract／reference／tick。
// retryableLazy 是模組層狀態：第一次展開（本檔第一個展開的測試）才會看到載入中的收合兩格。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
    const quotes = new Map<string, unknown>();
    const listeners = new Set<() => void>();
    return {
        quotes,
        listeners,
        emit: () => listeners.forEach(l => l()),
        navigate: vi.fn(),
        fetchKbars: vi.fn((..._args: unknown[]) => new Promise<never>(() => {})),
        fetchSnapshots: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
    };
});

vi.mock('../../lib/stream', () => ({
    ensureStream: vi.fn(),
    getQuote: (code: string) => m.quotes.get(code),
    subscribeQuoteStore: (_code: string, l: () => void) => { m.listeners.add(l); return () => { m.listeners.delete(l); }; },
}));
vi.mock('../../lib/quote-ownership', () => ({ retainContractQuotes: () => () => {} }));
vi.mock('../../lib/shioaji', () => ({ fetchKbars: m.fetchKbars, fetchSnapshots: m.fetchSnapshots }));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));
vi.mock('../../lib/theme-store', async importOriginal => ({
    ...await importOriginal<typeof import('../../lib/theme-store')>(),
    useThemeSettings: () => ({ mode: 'dark', convention: 'tw', fontScale: 1.15 }),
}));

import { resetSparklinesForTest } from '../lib/watch-sparkline-data';
import { fmtYi } from './watch-index-panel';
import { INDEX_PANEL_KEY, resetIndexSnapshotsForTest, WATCH_INDICES, WatchIndexStrip } from './watch-index-strip';
import { WatchSparkCell } from './watch-sparkline';

let view: ReactTestRenderer | undefined;

function fakeStorage(init: Record<string, string> = {}) {
    const map = new Map(Object.entries(init));
    return {
        map,
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { map.set(k, v); },
        removeItem: (k: string) => { map.delete(k); },
    };
}

const byId = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => {
    const found = byId(id);
    expect(found, id).toHaveLength(1);
    return found[0]!;
};
const toggle = () => one('watch-index-toggle');
const column = (code: string) => one(`watch-index-panel-${code}`);
const inColumn = (code: string, id: string) => column(code).findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const settle = () => act(async () => { await vi.dynamicImportSettled(); for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function render() {
    await act(async () => { view = create(createElement(WatchIndexStrip)); });
    await flush();
}

async function expand() {
    await act(async () => { toggle().props.onClick(); });
    await settle();
}

/** 盤中（台北 2026-11-10 週二 10:00）：預估成交金額只在 09:00–13:30 時段內顯示 */
const IN_SESSION = new Date('2026-11-10T02:00:00Z');
/** 收盤後（台北 2026-11-10 14:00） */
const AFTER_CLOSE = new Date('2026-11-10T06:00:00Z');

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(IN_SESSION);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.quotes.clear();
    m.listeners.clear();
    m.navigate.mockClear();
    m.fetchKbars.mockClear();
    m.fetchSnapshots.mockReset();
    m.fetchSnapshots.mockResolvedValue([]);
    resetIndexSnapshotsForTest();
    resetSparklinesForTest();
});

afterEach(async () => {
    if (view) await act(async () => view!.unmount());
    view = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('指數列收合／展開', () => {
    it('預設收合：兩格＋切換鍵（aria-expanded false、aria-controls 指向內容）；不掛載面板、不讀 K 線', async () => {
        vi.stubGlobal('localStorage', fakeStorage());
        await render();
        expect(byId('watch-index-IX0001')).toHaveLength(1);
        expect(byId('watch-index-IX0043')).toHaveLength(1);
        expect(byId('watch-index-panel')).toHaveLength(0);
        const t = toggle();
        expect(t.type).toBe('button');
        expect(t.props['aria-expanded']).toBe(false);
        expect(t.props['aria-label']).toBe('展開大盤走勢');
        const controlled = view!.root.findAll(n => typeof n.type === 'string' && n.props.id === t.props['aria-controls']);
        expect(controlled).toHaveLength(1);
        expect(controlled[0]!.findAll(n => n.props['data-testid'] === 'watch-index-IX0001' && typeof n.type === 'string')).toHaveLength(1);
        expect(view!.root.findAllByType(WatchSparkCell)).toHaveLength(0);
        expect(m.fetchKbars).not.toHaveBeenCalled();
    });

    it('按切換鍵展開：存 \'1\'、載入中顯示收合的兩格、載入後出現兩欄面板與走勢（每檔讀一次 K 線）；再按收合：存 \'0\'、卸載面板', async () => {
        const storage = fakeStorage();
        vi.stubGlobal('localStorage', storage);
        await render();
        // 同步 act：只提交這次渲染，lazy 尚未 resolve
        act(() => { toggle().props.onClick(); });
        expect(storage.map.get(INDEX_PANEL_KEY)).toBe('1');
        expect(toggle().props['aria-expanded']).toBe(true);
        expect(toggle().props['aria-label']).toBe('收合大盤走勢');
        // 本檔第一次展開：chunk 載入中 → 收合的兩格
        expect(byId('watch-index-panel')).toHaveLength(0);
        expect(byId('watch-index-IX0001')).toHaveLength(1);
        await settle();
        expect(byId('watch-index-panel')).toHaveLength(1);
        expect(byId('watch-index-panel-IX0001')).toHaveLength(1);
        expect(byId('watch-index-panel-IX0043')).toHaveLength(1);
        expect(byId('watch-index-IX0001')).toHaveLength(0);
        expect(view!.root.findAllByType(WatchSparkCell)).toHaveLength(2);
        expect(m.fetchKbars.mock.calls.map(c => (c[0] as { code: string }).code).sort()).toEqual(['IX0001', 'IX0043']);
        // 收合
        await act(async () => { toggle().props.onClick(); });
        expect(storage.map.get(INDEX_PANEL_KEY)).toBe('0');
        expect(toggle().props['aria-expanded']).toBe(false);
        expect(byId('watch-index-panel')).toHaveLength(0);
        expect(view!.root.findAllByType(WatchSparkCell)).toHaveLength(0);
        expect(byId('watch-index-IX0001')).toHaveLength(1);
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
    });

    it('讀回 \'1\'：啟動即展開；其他值收合', async () => {
        vi.stubGlobal('localStorage', fakeStorage({ [INDEX_PANEL_KEY]: '1' }));
        await render();
        await settle();
        expect(toggle().props['aria-expanded']).toBe(true);
        expect(byId('watch-index-panel')).toHaveLength(1);
        await act(async () => view!.unmount());
        view = undefined;
        vi.stubGlobal('localStorage', fakeStorage({ [INDEX_PANEL_KEY]: 'true' }));
        await render();
        expect(toggle().props['aria-expanded']).toBe(false);
        expect(byId('watch-index-panel')).toHaveLength(0);
    });

    it('localStorage 讀寫失敗：收合，切換照常（只影響本次）', async () => {
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
        await render();
        expect(toggle().props['aria-expanded']).toBe(false);
        await expand();
        expect(toggle().props['aria-expanded']).toBe(true);
        expect(byId('watch-index-panel')).toHaveLength(1);
    });

    it('沒有 localStorage（node 環境）：收合', async () => {
        await render();
        expect(toggle().props['aria-expanded']).toBe(false);
    });
});

describe('展開面板', () => {
    const live = (code: string, close: string, reference: string, extra: Record<string, unknown> = {}) =>
        m.quotes.set(code, { tick: undefined, index: { code, date: '2026/11/10', time: '10:30:00', close, reference, ...extra } });
    const snap = (code: string, close: number, change: number, totalAmount: number) =>
        ({ code, close, change_price: change, change_rate: 0, total_amount: totalAmount, datetime: '2026-11-10 13:30:00' });
    const sparkProps = (code: string) => view!.root.findAllByType(WatchSparkCell).find(n => n.props.contract.code === code)!.props;

    beforeEach(async () => {
        vi.stubGlobal('localStorage', fakeStorage({ [INDEX_PANEL_KEY]: '1' }));
    });

    it('即時：指數、漲跌點數＋漲跌幅、成交金額（amount_sum 億）、預估；aria-label 含數值、漲跌與成交金額；走勢收到 contract／reference／tick', async () => {
        await render();
        await settle();
        live('IX0001', '23000', '22770', { amount_sum: '1003349999999', estimate_amount_sum: '1125000000000' });
        live('IX0043', '250', '260', { amount_sum: '183456000000' });
        await act(async () => { m.emit(); });
        expect(textOf(inColumn('IX0001', 'watch-index-panel-value')[0]!)).toBe('23,000.00');
        expect(textOf(inColumn('IX0001', 'watch-index-panel-change')[0]!)).toBe('+230.00+1.01%');
        expect(textOf(inColumn('IX0001', 'watch-index-amount')[0]!)).toBe('成交金額10,033 億');
        expect(textOf(inColumn('IX0001', 'watch-index-estimate')[0]!)).toBe('預估 11,250 億');
        expect(column('IX0001').props['aria-label']).toBe('加權指數 23,000.00，漲 +230.00 點 +1.01%，成交金額 10,033 億，預估 11,250 億，開啟交易頁');
        expect(column('IX0001').props['data-source']).toBe('live');
        expect(column('IX0001').find(n => n.type === 'svg').props['data-dir']).toBe('up');
        // 櫃買：跌、沒有預估
        expect(textOf(inColumn('IX0043', 'watch-index-panel-change')[0]!)).toBe('-10.00-3.85%');
        expect(textOf(inColumn('IX0043', 'watch-index-amount')[0]!)).toBe('成交金額1,835 億');
        expect(inColumn('IX0043', 'watch-index-estimate')).toHaveLength(0);
        expect(column('IX0043').props['aria-label']).toBe('櫃買指數 250.00，跌 -10.00 點 -3.85%，成交金額 1,835 億，開啟交易頁');
        expect(column('IX0043').find(n => n.type === 'svg').props['data-dir']).toBe('down');
        // 走勢
        const p1 = sparkProps('IX0001');
        expect(p1.contract).toBe(WATCH_INDICES[0]!.contract);
        expect(p1.reference).toBe(22770);
        expect(p1.tick).toBe((m.quotes.get('IX0001') as { index: unknown }).index);
        expect(typeof p1.className).toBe('string');
        expect(sparkProps('IX0043').contract).toBe(WATCH_INDICES[1]!.contract);
        expect(sparkProps('IX0043').reference).toBe(260);
    });

    it('成交金額：amount_sum 空字串或沒有時用快照 total_amount；兩者都沒有顯示「—」；預估空字串不顯示', async () => {
        m.fetchSnapshots.mockResolvedValue([snap('IX0001', 23000, 230, 987_654_321_098)]);
        await render();
        await settle();
        live('IX0001', '23100', '22770', { amount_sum: '', estimate_amount_sum: '' });
        live('IX0043', '250', '260');
        await act(async () => { m.emit(); });
        expect(textOf(inColumn('IX0001', 'watch-index-amount')[0]!)).toBe('成交金額9,877 億');
        expect(inColumn('IX0001', 'watch-index-estimate')).toHaveLength(0);
        expect(textOf(inColumn('IX0043', 'watch-index-amount')[0]!)).toBe('成交金額—');
        expect(column('IX0043').props['aria-label']).toContain('成交金額 —');
    });

    it('收盤後（或開盤前）即使最後一筆即時報價還帶著預估值，也不顯示預估；成交金額照常', async () => {
        vi.setSystemTime(AFTER_CLOSE);
        await render();
        await settle();
        live('IX0001', '23000', '22770', { amount_sum: '1003349999999', estimate_amount_sum: '1125000000000' });
        await act(async () => { m.emit(); });
        expect(inColumn('IX0001', 'watch-index-estimate')).toHaveLength(0);
        expect(column('IX0001').props['aria-label']).not.toContain('預估');
        expect(textOf(inColumn('IX0001', 'watch-index-amount')[0]!)).toBe('成交金額10,033 億');
    });

    it('只有快照：數值與漲跌來自快照、reference＝close − change_price、tick 不傳；點欄位只導頁', async () => {
        m.fetchSnapshots.mockResolvedValue([snap('IX0001', 23000, 230, 1_003_300_000_000), snap('IX0043', 250, -10, 0)]);
        await render();
        await settle();
        expect(column('IX0001').props['data-source']).toBe('snapshot');
        expect(textOf(inColumn('IX0001', 'watch-index-panel-value')[0]!)).toBe('23,000.00');
        expect(textOf(inColumn('IX0001', 'watch-index-panel-change')[0]!)).toBe('+230.00+1.01%');
        expect(textOf(inColumn('IX0001', 'watch-index-amount')[0]!)).toBe('成交金額10,033 億');
        expect(sparkProps('IX0001').reference).toBe(22770);
        expect(sparkProps('IX0001').tick).toBeUndefined();
        expect(sparkProps('IX0043').reference).toBe(260);
        await act(async () => { column('IX0043').props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: 'IX0043' });
        expect(m.navigate).toHaveBeenCalledTimes(1);
    });

    it('沒有任何資料：數值「—」、沒有漲跌行、成交金額「—」、reference 不傳', async () => {
        await render();
        await settle();
        expect(textOf(inColumn('IX0001', 'watch-index-panel-value')[0]!)).toBe('—');
        expect(inColumn('IX0001', 'watch-index-panel-change')).toHaveLength(0);
        expect(textOf(inColumn('IX0001', 'watch-index-amount')[0]!)).toBe('成交金額—');
        expect(column('IX0001').props['aria-label']).toBe('加權指數 — 沒有即時資料，成交金額 —，開啟交易頁');
        expect(sparkProps('IX0001').reference).toBeUndefined();
        expect(column('IX0001').props['data-source']).toBe('none');
    });
});

describe('fmtYi（元 → 億）', () => {
    it('四捨五入、千分位；空字串、非數字、負數視為沒有', () => {
        expect(fmtYi(1_003_349_999_999)).toBe('10,033');
        expect(fmtYi('1003350000000')).toBe('10,034');
        expect(fmtYi('0')).toBe('0');
        expect(fmtYi('')).toBeUndefined();
        expect(fmtYi(undefined)).toBeUndefined();
        expect(fmtYi(null)).toBeUndefined();
        expect(fmtYi('abc')).toBeUndefined();
        expect(fmtYi(-1)).toBeUndefined();
    });
});
