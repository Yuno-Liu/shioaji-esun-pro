// 自選清單的固定清單「股期近月」「股期遠月」（components/futures-list.tsx）：
// - 資料：fetchFutures({}) 每個台北日 1 次（兩個分頁、重新掛載共用）；讀取中 Skeleton、失敗 InlineNote＋［重試］。
// - 列：實際月份代碼（CDFK6，不是 CDFR1）、名稱去掉月份、市場標記「期」、標的代號；順序為標的代號、一般在小型前。
// - 請求：開啟時 1 次批次快照；每列 0 個合約請求（不呼叫 ensureContract／resolveContract／useQuote）；
//   只有可見列訂閱 Tick（retainQuote），離開可見範圍即釋放。
// - 不能編輯：沒有新增、移除、握把、多選；長按只有「開啟交易頁」「買進…」「賣出…」。
// - 下單路徑都開實際月份合約：點列 → onOpen('CDFK6')、快速下單鍵與買進／賣出 → openTicket({ code: 'CDFK6' …})；
//   開之前把實際月份那一筆（target_code null）放進合約快取（已有時不覆寫）。
// - 排序（固定清單）：預設股票代號；股價類依開啟時的批次快照（5 秒內不重取）、［⟳］間隔 5 秒。
// - S1：送單、改單、刪單與 openOrderAction 0 次；openTicket 只開面板（之後仍需預覽與滑動確認）。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';

const m = vi.hoisted(() => ({
    cache: new Map<string, unknown>(),
    primeContract: vi.fn(),
    ensureContract: vi.fn(),
    useQuote: vi.fn(() => undefined),
    retainQuote: vi.fn(),
    releases: [] as ReturnType<typeof vi.fn>[],
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    io: null as null | { cb: (entries: { target: unknown; isIntersecting: boolean }[]) => void; els: unknown[] },
    shioaji: {
        fetchFutures: vi.fn(),
        fetchSnapshots: vi.fn(),
        fetchKbars: vi.fn(),
        resolveContract: vi.fn(),
        fetchContractInfo: vi.fn(),
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelOrders: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
    },
}));

vi.mock('../../lib/shioaji', () => m.shioaji);
vi.mock('../../lib/contracts-cache', () => ({
    getCachedContract: (code: string) => m.cache.get(code),
    primeContract: m.primeContract,
    ensureContract: m.ensureContract,
    useContract: () => undefined,
}));
vi.mock('../../hooks/use-stream', () => ({ useQuote: m.useQuote }));
vi.mock('../../lib/quote-ownership', () => ({ retainQuote: m.retainQuote, retainContractQuotes: m.retainQuote }));
vi.mock('../../lib/stream', () => ({ ensureStream: () => undefined, getQuote: () => undefined, subscribeQuoteStore: () => () => undefined, onContractEvent: () => () => undefined }));
vi.mock('../lib/mobile-store', () => ({ openTicket: m.openTicket, openOrderAction: m.openOrderAction }));
vi.mock('../motion/haptics', () => ({ haptic: vi.fn(() => false) }));

import { resetFuturesListsForTest } from '../lib/futures-lists';
import { resetSortBasisForTest } from '../lib/watch-sort';
import { resetWatchPrefsForTest, setWatchSparklineEnabled } from '../lib/watch-prefs';
import { BottomSheet } from './bottom-sheet';
import { createSettledTracker, FuturesList, SCROLL_SETTLE_MS } from './futures-list';

class ControlledIO {
    els: unknown[] = [];
    constructor(public cb: (entries: { target: unknown; isIntersecting: boolean }[]) => void) {
        m.io = this;
    }
    observe(el: unknown) { this.els.push(el); }
    unobserve(el: unknown) { this.els = this.els.filter(e => e !== el); }
    disconnect() { this.els = []; }
}

class MemoryStorage {
    data = new Map<string, string>();
    getItem(k: string) { return this.data.get(k) ?? null; }
    setItem(k: string, v: string) { this.data.set(k, v); }
    removeItem(k: string) { this.data.delete(k); }
}

const base = (code: string, over: Partial<ContractInfo>): ContractInfo => ({
    code, name: code, security_type: 'FUT', exchange: 'TAIFEX', target_code: null, currency: 'TWD',
    reference: 100, limit_up: 110, limit_down: 90, day_trade: '', update_date: '2026-11-09', category: '',
    margin_trading_balance: 0, short_selling_balance: 0, spec_kind: 'stock_fut', underlying_kind: 'S',
    multiplier: 2000, last_trading_date: '2099-12-31', ...over,
});
function family(root: string, under: string, name: string, mult: number, ref: number): ContractInfo[] {
    const c = { root, underlying_code: under, multiplier: mult, reference: ref };
    return [
        base(`${root}R1`, { ...c, name: `${name} 近月`, target_code: `${root}K6` }),
        base(`${root}K6`, { ...c, name: `${name} 202611` }),
        base(`${root}R2`, { ...c, name: `${name} 次月`, target_code: `${root}L6` }),
        base(`${root}L6`, { ...c, name: `${name} 202612` }),
    ];
}
const ALL = [
    ...family('QFF', '2330', '小型台積電期貨', 100, 2100),
    ...family('CDF', '2330', '台積電期貨', 2000, 2100),
    ...family('DHF', '2317', '鴻海期貨', 2000, 200),
    // 調整型、指數期貨：不列
    ...family('CD1', '2330', '台積電期貨（調整）', 2020, 2100),
    base('TXFR1', { root: 'TXF', spec_kind: 'index_fut', underlying_kind: 'I', multiplier: 200, target_code: 'TXFK6' }),
];
const SNAPS: Record<string, { close: number; change_price: number; change_rate: number }> = {
    QFFK6: { close: 2150, change_price: 50, change_rate: 2.38 },
    CDFK6: { close: 2150, change_price: 50, change_rate: 2.38 },
    DHFK6: { close: 210, change_price: 10, change_rate: 5 },
};

let view: ReactTestRenderer | undefined;
const onOpen = vi.fn();
const onCycleMetric = vi.fn();
const render = (listId: 'fut:near' | 'fut:next' = 'fut:near') => act(async () => {
    view = create(createElement(FuturesList, { listId, metric: 'pct', onCycleMetric, onOpen }), {
        createNodeMock: el => ({ testid: (el.props as Record<string, unknown>)['data-testid'], code: (el.props as Record<string, unknown>)['data-code'] }),
    });
});
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const rowCodes = () => all('futures-row').map(r => r.props['data-code'] as string);
const rowOf = (code: string) => all('futures-row').find(r => r.props['data-code'] === code)!;
const inRow = (code: string, id: string) => rowOf(code).findAll(n => n.props['data-testid'] === id && typeof n.type === 'string')[0]!;
/** 長按（Android 的 contextmenu）；先 pointerdown 清掉上一次長按的狀態 */
const longPress = (code: string) => act(async () => {
    const button = inRow(code, 'futures-row-button');
    button.props.onPointerDown({ pointerType: 'touch', button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    button.props.onPointerUp();
    button.props.onContextMenu({ preventDefault: vi.fn() });
});
const sheet = (id: string) => view!.root.findAll(n => n.type === BottomSheet && n.props.testId === id)[0]!;
const setVisible = (codes: string[], visible: boolean) => act(async () => {
    const els = m.io!.els.filter(e => codes.includes((e as { code: string }).code));
    m.io!.cb(els.map(target => ({ target, isIntersecting: visible })));
});

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', ControlledIO);
    vi.stubGlobal('localStorage', new MemoryStorage());
    resetWatchPrefsForTest();
    setWatchSparklineEnabled(false);
    resetFuturesListsForTest();
    resetSortBasisForTest();
    m.cache.clear();
    m.releases = [];
    m.retainQuote.mockReset();
    m.retainQuote.mockImplementation(() => {
        const release = vi.fn();
        m.releases.push(release);
        return release;
    });
    for (const f of [m.primeContract, m.ensureContract, m.useQuote, m.openTicket, m.openOrderAction, onOpen, onCycleMetric]) f.mockClear();
    for (const f of Object.values(m.shioaji)) f.mockReset();
    m.shioaji.fetchFutures.mockResolvedValue(ALL);
    m.shioaji.fetchSnapshots.mockImplementation(async (cs: ContractInfo[]) => cs.filter(c => SNAPS[c.code]).map(c => ({ code: c.code, ...SNAPS[c.code] })));
});
afterEach(async () => {
    // 每列 0 個合約請求；S1：送單、改單、刪單、委託操作面板 0 次
    expect(m.ensureContract).not.toHaveBeenCalled();
    expect(m.useQuote).not.toHaveBeenCalled();
    for (const k of ['resolveContract', 'fetchContractInfo', 'fetchKbars', 'placeStockOrder', 'placeFuturesOrder', 'placeComboOrder', 'cancelOrder', 'cancelOrders', 'updateOrderPrice', 'updateOrderQty'] as const) {
        expect(m.shioaji[k], k).not.toHaveBeenCalled();
    }
    expect(m.openOrderAction).not.toHaveBeenCalled();
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('FuturesList：資料與列', () => {
    it('讀取中 → 列：實際月份代碼、名稱去掉月份、期、標的；一般在小型前；1 次清單請求＋1 次批次快照', async () => {
        await act(async () => {
            view = create(createElement(FuturesList, { listId: 'fut:near', metric: 'pct', onCycleMetric, onOpen }));
        });
        expect(all('futures-loading').length + all('futures-list').length).toBe(1);
        await settle();
        expect(rowCodes()).toEqual(['DHFK6', 'CDFK6', 'QFFK6']);
        expect(textOf(inRow('CDFK6', 'futures-name'))).toBe('台積電期貨');
        expect(textOf(inRow('QFFK6', 'futures-name'))).toBe('小型台積電期貨');
        expect(textOf(inRow('CDFK6', 'futures-market'))).toBe('期');
        expect(textOf(inRow('CDFK6', 'futures-under'))).toBe('2330');
        expect(String(inRow('QFFK6', 'futures-row-button').props['aria-label'])).toContain('，標的 2330，小型');
        expect(m.shioaji.fetchFutures).toHaveBeenCalledTimes(1);
        expect(m.shioaji.fetchFutures).toHaveBeenCalledWith({});
        expect(m.shioaji.fetchSnapshots).toHaveBeenCalledTimes(1);
        expect((m.shioaji.fetchSnapshots.mock.calls[0]![0] as ContractInfo[]).map(c => c.code)).toEqual(['DHFK6', 'CDFK6', 'QFFK6']);
        // 快照當列的價格備援
        expect(textOf(inRow('DHFK6', 'futures-price'))).toBe('210.00');
        // 沒有任何編輯入口
        for (const id of ['watch-row-remove', 'watch-row-grip', 'watch-more', 'watch-edit', 'watch-multi', 'watch-list-add', 'watch-add-symbol']) expect(all(id), id).toHaveLength(0);
        // 表頭：排序鍵（預設股票代號）＋指標切換
        expect(all('watch-sort')[0]!.props['data-sort']).toBe('code:asc');
        await act(async () => { all('futures-metric-toggle')[0]!.props.onClick(); });
        expect(onCycleMetric).toHaveBeenCalledTimes(1);
    });

    it('遠月分頁與重新掛載：同一個台北日共用 1 次清單請求', async () => {
        await render('fut:near');
        await settle();
        await act(async () => view!.unmount());
        await render('fut:next');
        await settle();
        expect(rowCodes()).toEqual(['DHFL6', 'CDFL6', 'QFFL6']);
        await act(async () => view!.unmount());
        await render('fut:near');
        await settle();
        expect(m.shioaji.fetchFutures).toHaveBeenCalledTimes(1);
    });

    it('讀取失敗：InlineNote＋［重試］；重試成功後顯示', async () => {
        m.shioaji.fetchFutures.mockRejectedValueOnce(new Error('503'));
        await render();
        await settle();
        expect(textOf(all('futures-error')[0]!)).toContain('股期近月清單載入失敗');
        expect(all('futures-list')).toHaveLength(0);
        await act(async () => { all('futures-retry')[0]!.props.onClick(); });
        await settle();
        expect(rowCodes()).toEqual(['DHFK6', 'CDFK6', 'QFFK6']);
        expect(m.shioaji.fetchFutures).toHaveBeenCalledTimes(2);
    });

    it('只有可見列訂閱 Tick（retainQuote，以清單資料的實際月份合約）；離開可見範圍釋放', async () => {
        await render();
        await settle();
        expect(m.retainQuote).not.toHaveBeenCalled();
        await setVisible(['DHFK6', 'CDFK6'], true);
        expect(m.retainQuote).toHaveBeenCalledTimes(2);
        const subscribed = m.retainQuote.mock.calls.map(c => [(c[0] as ContractInfo).code, (c[0] as ContractInfo).target_code, c[1]]);
        expect(subscribed).toEqual([['DHFK6', null, 'Tick'], ['CDFK6', null, 'Tick']]);
        await setVisible(['CDFK6'], false);
        expect(m.releases[1]).toHaveBeenCalledTimes(1);
        expect(m.releases[0]).not.toHaveBeenCalled();
    });
});

describe('FuturesList：下單路徑開實際月份合約（S1）', () => {
    it('點列：放入實際月份合約（target_code null）後 onOpen("CDFK6")；快取已有時不覆寫', async () => {
        await render();
        await settle();
        await act(async () => { inRow('CDFK6', 'futures-row-button').props.onClick(); });
        expect(onOpen).toHaveBeenCalledWith('CDFK6');
        expect(m.primeContract).toHaveBeenCalledTimes(1);
        const primed = m.primeContract.mock.calls[0]![0] as ContractInfo;
        expect(primed.code).toBe('CDFK6');
        expect(primed.target_code).toBeNull();
        expect(primed.name).toBe('台積電期貨 202611');
        m.cache.set('DHFK6', { code: 'DHFK6' });
        await act(async () => { inRow('DHFK6', 'futures-row-button').props.onClick(); });
        expect(onOpen).toHaveBeenLastCalledWith('DHFK6');
        expect(m.primeContract).toHaveBeenCalledTimes(1);
        expect(m.openTicket).not.toHaveBeenCalled();
    });

    it('快速下單鍵：只開下單面板（不帶方向），代碼為實際月份', async () => {
        await render();
        await settle();
        await act(async () => { inRow('QFFK6', 'futures-row-ticket').props.onClick(); });
        expect(m.openTicket).toHaveBeenCalledTimes(1);
        expect(m.openTicket).toHaveBeenCalledWith({ code: 'QFFK6', source: 'other' });
        expect((m.primeContract.mock.calls[0]![0] as ContractInfo).code).toBe('QFFK6');
        expect(onOpen).not.toHaveBeenCalled();
    });

    it('長按：面板只有開啟交易頁、買進…、賣出…；買賣只開下單面板（實際月份）', async () => {
        await render();
        await settle();
        await longPress('CDFK6');
        expect(sheet('futures-actions').props.open).toBe(true);
        expect(sheet('futures-actions').props.title).toBe('CDFK6 台積電期貨 202611');
        const rows = sheet('futures-actions').findAll(n => typeof n.type === 'string' && String(n.props['data-testid'] ?? '').startsWith('futures-action-'));
        expect(rows.map(r => r.props['data-testid'])).toEqual(['futures-action-open', 'futures-action-buy', 'futures-action-sell']);
        const press = (id: string) => act(async () => { all(id)[0]!.findByType('button').props.onClick(); });
        await press('futures-action-buy');
        expect(m.openTicket).toHaveBeenLastCalledWith({ code: 'CDFK6', action: 'Buy', source: 'other' });
        expect(sheet('futures-actions').props.open).toBe(false);
        await longPress('CDFK6');
        await press('futures-action-sell');
        expect(m.openTicket).toHaveBeenLastCalledWith({ code: 'CDFK6', action: 'Sell', source: 'other' });
        await longPress('CDFK6');
        await press('futures-action-open');
        expect(onOpen).toHaveBeenCalledWith('CDFK6');
        expect(m.openTicket).toHaveBeenCalledTimes(2);
        for (const call of m.openTicket.mock.calls) expect(String((call[0] as { code: string }).code)).not.toMatch(/R[12]$/);
    });
});

describe('FuturesList：排序', () => {
    it('股價類：沿用開啟時的批次快照（5 秒內不重取）、顯示排序依據；［⟳］5 秒後才可按、再取 1 次；偏好存在本裝置', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.parse('2026-11-09T02:00:00Z'));
        await render();
        await settle();
        expect(m.shioaji.fetchSnapshots).toHaveBeenCalledTimes(1);
        await act(async () => { all('watch-sort')[0]!.props.onClick(); });
        expect(sheet('watch-sort-sheet').props.open).toBe(true);
        const options = sheet('watch-sort-sheet').findAll(n => typeof n.type === 'string' && String(n.props['data-testid'] ?? '').startsWith('watch-sort-option-'));
        expect(options.map(o => o.props['data-testid'])).toEqual(['watch-sort-option-code', 'watch-sort-option-price', 'watch-sort-option-pct', 'watch-sort-option-chg']);
        await act(async () => { all('watch-sort-option-pct')[0]!.findByType('button').props.onClick(); });
        expect(m.shioaji.fetchSnapshots).toHaveBeenCalledTimes(1);
        expect(rowCodes()).toEqual(['DHFK6', 'CDFK6', 'QFFK6']);
        expect(all('watch-sort')[0]!.props['data-sort']).toBe('pct:desc');
        expect(textOf(all('watch-sort-basis')[0]!)).toContain('排序依據 10:00:00');
        expect(all('watch-sort-refresh')[0]!.props.disabled).toBe(true);
        // 再點一次＝反向
        await act(async () => { all('watch-sort')[0]!.props.onClick(); });
        await act(async () => { all('watch-sort-option-pct')[0]!.findByType('button').props.onClick(); });
        expect(rowCodes()).toEqual(['CDFK6', 'QFFK6', 'DHFK6']);
        expect(JSON.parse(localStorage.getItem('sj-mobile-watch-sort-v1')!)).toEqual({ 'fut:near': { key: 'pct', dir: 'asc' } });
        vi.setSystemTime(Date.parse('2026-11-09T02:00:06Z'));
        await act(async () => { view!.update(createElement(FuturesList, { listId: 'fut:near', metric: 'vol', onCycleMetric, onOpen })); });
        expect(all('watch-sort-refresh')[0]!.props.disabled).toBe(false);
        m.shioaji.fetchSnapshots.mockImplementationOnce(async (cs: ContractInfo[]) => cs.map(c => ({ code: c.code, close: 1, change_price: c.code === 'QFFK6' ? -9 : 0, change_rate: c.code === 'QFFK6' ? -9 : 0 })));
        await act(async () => { all('watch-sort-refresh')[0]!.props.onClick(); });
        await settle();
        expect(m.shioaji.fetchSnapshots).toHaveBeenCalledTimes(2);
        expect(rowCodes()).toEqual(['QFFK6', 'DHFK6', 'CDFK6']);
        expect(textOf(all('watch-sort-basis')[0]!)).toContain('排序依據 10:00:06');
    });

    it('排序依據讀取失敗：顯示失敗說明、列維持基準順序', async () => {
        m.shioaji.fetchSnapshots.mockRejectedValue(new Error('timeout'));
        localStorage.setItem('sj-mobile-watch-sort-v1', JSON.stringify({ 'fut:near': { key: 'price', dir: 'desc' } }));
        await render();
        await settle();
        expect(all('watch-sort')[0]!.props['data-sort']).toBe('price:desc');
        expect(textOf(all('watch-sort-basis')[0]!)).toContain('排序資料讀取失敗');
        expect(rowCodes()).toEqual(['DHFK6', 'CDFK6', 'QFFK6']);
        expect(all('watch-sort-refresh')[0]!.props.disabled).toBe(false);
    });
});

describe('createSettledTracker：捲動中進入可見範圍的列，捲動停下後才算可見', () => {
    it('沒有捲動時立即通知；捲動中延到停下 SCROLL_SETTLE_MS 後（仍可見才算）；離開立即通知', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const doc = new EventTarget();
        vi.stubGlobal('document', doc);
        const t = createSettledTracker();
        const seen: string[] = [];
        const a = { code: 'A' }, b = { code: 'B' }, c = { code: 'C' };
        for (const el of [a, b, c]) t.observe(el as unknown as Element, v => seen.push(`${el.code}:${v}`));
        m.io!.cb([{ target: a, isIntersecting: true }]);
        expect(seen).toEqual(['A:true']);
        doc.dispatchEvent(new Event('scroll'));
        m.io!.cb([{ target: b, isIntersecting: true }, { target: c, isIntersecting: true }]);
        m.io!.cb([{ target: a, isIntersecting: false }]);
        expect(seen).toEqual(['A:true', 'A:false']);
        vi.advanceTimersByTime(SCROLL_SETTLE_MS - 10);
        doc.dispatchEvent(new Event('scroll'));
        m.io!.cb([{ target: c, isIntersecting: false }]);
        vi.advanceTimersByTime(SCROLL_SETTLE_MS - 10);
        expect(seen).toEqual(['A:true', 'A:false', 'C:false']);
        vi.advanceTimersByTime(20);
        expect(seen).toEqual(['A:true', 'A:false', 'C:false', 'B:true']);
        t.disconnect();
    });
});
