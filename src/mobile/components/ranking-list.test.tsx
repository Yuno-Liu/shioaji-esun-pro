// 漲跌幅排行：讀取參數、30 秒快取、15 秒冷卻、排序、點擊導頁、加入自選、空狀態與錯誤狀態；
// 與自選共用列元件（components/quote-row.tsx）：兩行列、依漲跌著色、迷你走勢、處置徽章、快速下單鍵（S1）。
// 迷你走勢的合約：合約快取有的直接用；沒有的「可見＋開關開啟」列經 ensureContract 解析（同時 ≤2、不可見／關閉時取消未開始的）。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScannerItem } from '../../lib/types/market';

const m = vi.hoisted(() => ({
    fetchScanner: vi.fn<(type: string, count: number, ascending: boolean) => Promise<unknown>>(),
    fetchKbars: vi.fn(),
    /** 處置清單（regulatory_punish）走 lib/api 的 apiGet */
    apiGet: vi.fn(),
    /** 合約快取（contracts-cache 替身）：ensureContract 成功時寫入並通知 useContract */
    cached: new Map<string, unknown>(),
    cacheListeners: new Set<() => void>(),
    /** ensureContract 呼叫（每次＝最多 1 個合約 GET；真正的 ensureContract 另有同代碼去重） */
    ensureContract: vi.fn<(code: string, type?: string) => Promise<unknown>>(),
    contractPending: new Map<string, { resolve: () => void; reject: (e: unknown) => void }>(),
    resolveContract: vi.fn(),
    // S1：lib 的送單／改單／刪單函式（排行的任何入口都不得呼叫）
    placeStockOrder: vi.fn(),
    placeFuturesOrder: vi.fn(),
    placeComboOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelOrders: vi.fn(),
    cancelVerifiedOrder: vi.fn(),
    cancelComboOrder: vi.fn(),
    updateOrderPrice: vi.fn(),
    updateOrderQty: vi.fn(),
    requestOrderConfirm: vi.fn(),
}));
vi.mock('../../lib/shioaji', () => ({
    fetchScanner: m.fetchScanner,
    fetchKbars: m.fetchKbars,
    resolveContract: m.resolveContract,
    placeStockOrder: m.placeStockOrder,
    placeFuturesOrder: m.placeFuturesOrder,
    placeComboOrder: m.placeComboOrder,
    cancelOrder: m.cancelOrder,
    cancelOrders: m.cancelOrders,
    cancelVerifiedOrder: m.cancelVerifiedOrder,
    cancelComboOrder: m.cancelComboOrder,
    updateOrderPrice: m.updateOrderPrice,
    updateOrderQty: m.updateOrderQty,
}));
vi.mock('../../lib/order-confirm', () => ({ requestOrderConfirm: m.requestOrderConfirm }));
vi.mock('../../lib/api', () => ({ apiGet: m.apiGet }));
vi.mock('../../lib/contracts-cache', async () => {
    const { useSyncExternalStore } = await import('react');
    const subscribe = (l: () => void) => { m.cacheListeners.add(l); return () => { m.cacheListeners.delete(l); }; };
    return {
        getCachedContract: (code: string) => m.cached.get(code),
        useContract: (code: string | null) => useSyncExternalStore(subscribe, () => (code ? m.cached.get(code) : undefined)),
        ensureContract: m.ensureContract,
    };
});

import { getMobileUi, resetMobileUiForTest } from '../lib/mobile-store';
import { SPARK_CONTRACT_RETRY_MS, resetSparkContractsForTest, sparkContractQueueStats } from '../lib/ranking-spark-contracts';
import { PUNISH_PATH, resetPunishedCodesForTest } from '../lib/regulatory-punish';
import { resetWatchPrefsForTest, setWatchSparklineEnabled } from '../lib/watch-prefs';
import { resetSparklinesForTest } from '../lib/watch-sparkline-data';
import * as wlStyles from '../styles/watchlist.css';
import { Segmented } from '../ui/segmented';
import { QuoteRow } from './quote-row';

import {
    filterRanking,
    getRankingState,
    isEtfCode,
    isWarrantCode,
    RANKING_CACHE_MS,
    RANKING_COOLDOWN_MS,
    RANKING_COUNT,
    RANKING_DEFS,
    rankingChangePct,
    rankingPriceRange,
    RankingList,
    requestRanking,
    resetRankingForTest,
    sortRanking,
} from './ranking-list';

const T0 = new Date('2026-11-06T10:00:00+08:00').getTime();

function item(code: string, close: number, change: number, extra: Partial<ScannerItem> = {}): ScannerItem {
    return {
        code, name: `名稱${code}`, date: '2026-11-06', close, open: close, high: close, low: close,
        change_price: change, change_type: change > 0 ? 2 : change < 0 ? 4 : 3, average_price: close,
        price_range: 0, rank_value: 0, total_volume: 1000, total_amount: close * 1000 * 1000,
        volume_ratio: 1, yesterday_volume: 1000, tick_type: 1, buy_price: close, sell_price: close, ...extra,
    };
}

/** 讓 fetchScanner 的 promise 結算並重繪 */
async function flush() {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

let view: ReactTestRenderer | undefined;
const props = {
    watchedCodes: new Set<string>(),
    canAdd: true,
    onAdd: vi.fn(async (_code: string) => undefined),
    onOpen: vi.fn(),
};
async function render(over: Partial<typeof props> = {}, opts?: Parameters<typeof create>[1]) {
    await act(async () => { view = create(createElement(RankingList, { ...props, ...over }), opts); });
    await flush();
}
const stockContract = (code: string) => ({ code, name: `名稱${code}`, security_type: 'STK', exchange: 'OTC', target_code: null, reference: 100 });
const byTestId = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => byTestId(id)[0]!;
const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(T0);
    resetRankingForTest();
    m.fetchScanner.mockReset();
    m.fetchScanner.mockResolvedValue([]);
    props.onAdd.mockClear();
    props.onOpen.mockClear();
    m.apiGet.mockReset();
    m.apiGet.mockResolvedValue({ code: [] });
    m.fetchKbars.mockReset();
    m.fetchKbars.mockResolvedValue({ datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [], Amount: [] });
    m.resolveContract.mockReset();
    m.cached.clear();
    m.contractPending.clear();
    m.ensureContract.mockReset();
    m.ensureContract.mockImplementation(code => new Promise<unknown>((resolve, reject) => {
        m.contractPending.set(code, {
            resolve: () => {
                const c = stockContract(code);
                m.cached.set(code, c);
                m.cacheListeners.forEach(l => l());
                resolve(c);
            },
            reject,
        });
    }));
    resetSparkContractsForTest();
    resetPunishedCodesForTest();
    resetSparklinesForTest();
    resetWatchPrefsForTest();
    resetMobileUiForTest();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('sortRanking', () => {
    const a = item('A', 110, 10); // +10%
    const b = item('B', 105, 5); // +5%
    const c = item('C', 90, -10); // −10%
    const d = item('D', 100, 0); // 0%
    const bad = item('X', 0, 0); // 參考價 0：無法計算

    it('漲幅由大到小、跌幅由小到大；無法計算的排最後', () => {
        expect(sortRanking('gainers', [c, bad, b, a, d]).map(i => i.code)).toEqual(['A', 'B', 'D', 'C', 'X']);
        expect(sortRanking('losers', [a, bad, b, c, d]).map(i => i.code)).toEqual(['C', 'D', 'B', 'A', 'X']);
    });

    it('成交量、成交值由大到小；同值保留伺服器順序', () => {
        const v1 = item('V1', 100, 0, { total_volume: 500, total_amount: 1, high: 101, low: 99 });
        const v2 = item('V2', 100, 0, { total_volume: 900, total_amount: 3, high: 110, low: 95 });
        const v3 = item('V3', 100, 0, { total_volume: 500, total_amount: 2, high: 100, low: 100 });
        expect(sortRanking('volume', [v1, v2, v3]).map(i => i.code)).toEqual(['V2', 'V1', 'V3']);
        expect(sortRanking('amount', [v1, v2, v3]).map(i => i.code)).toEqual(['V2', 'V3', 'V1']);
    });

    it('高低價差（DayRangeRank）保留伺服器名次，不依振幅%重排；價差優先用伺服器 price_range', () => {
        // 伺服器依絕對價差排序：高價股價差 60（振幅 3%）在前，低價股價差 3（振幅 10%）在後
        const hi = item('HI', 2000, 0, { high: 2030, low: 1970, price_range: 60 });
        const lo = item('LO', 30, 0, { high: 31.5, low: 28.5, price_range: 3 });
        expect(sortRanking('range', [hi, lo]).map(i => i.code)).toEqual(['HI', 'LO']);
        expect(rankingPriceRange(hi)).toBe(60);
        expect(rankingPriceRange({ ...lo, price_range: undefined as unknown as number })).toBeCloseTo(3);
        expect(RANKING_DEFS.find(d => d.kind === 'range')!.label).toBe('高低價差');
    });

    it('漲跌幅由漲跌與參考價計算', () => {
        expect(rankingChangePct(item('A', 110, 10))).toBeCloseTo(10);
        expect(rankingChangePct(item('X', 0, 0))).toBeUndefined();
    });
});

describe('requestRanking（快取與冷卻）', () => {
    it('各排行的 fetchScanner 參數（伺服器 ascending 相反：true＝由大到小）', async () => {
        for (const kind of ['gainers', 'losers', 'priceUp', 'priceDown', 'volume', 'amount', 'ticks', 'range'] as const) requestRanking(kind);
        await flush();
        expect(m.fetchScanner.mock.calls).toEqual([
            ['ChangePercentRank', RANKING_COUNT, true],
            ['ChangePercentRank', RANKING_COUNT, false],
            ['ChangePriceRank', RANKING_COUNT, true],
            ['ChangePriceRank', RANKING_COUNT, false],
            ['VolumeRank', RANKING_COUNT, true],
            ['AmountRank', RANKING_COUNT, true],
            ['TickCountRank', RANKING_COUNT, true],
            ['DayRangeRank', RANKING_COUNT, true],
        ]);
        expect(RANKING_COUNT).toBe(30);
    });

    it('30 秒內用快取，過期才重新讀取', async () => {
        m.fetchScanner.mockResolvedValue([item('A', 110, 10)]);
        expect(requestRanking('gainers')).toBe(true);
        await flush();
        expect(getRankingState('gainers').items?.map(i => i.code)).toEqual(['A']);
        vi.setSystemTime(T0 + RANKING_CACHE_MS - 1);
        expect(requestRanking('gainers')).toBe(false);
        vi.setSystemTime(T0 + RANKING_CACHE_MS + 1);
        expect(requestRanking('gainers')).toBe(true);
        expect(m.fetchScanner).toHaveBeenCalledTimes(2);
    });

    it('手動更新忽略快取，但 15 秒冷卻內不發出；讀取中也不重複發出', async () => {
        let resolve!: (v: unknown) => void;
        m.fetchScanner.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
        expect(requestRanking('volume')).toBe(true);
        expect(requestRanking('volume', { force: true })).toBe(false); // 讀取中
        resolve([]);
        await flush();
        vi.setSystemTime(T0 + RANKING_COOLDOWN_MS - 1);
        expect(requestRanking('volume', { force: true })).toBe(false);
        vi.setSystemTime(T0 + RANKING_COOLDOWN_MS);
        expect(requestRanking('volume', { force: true })).toBe(true);
        expect(m.fetchScanner).toHaveBeenCalledTimes(2);
    });

    it('失敗：記錄錯誤，冷卻內自動讀取也不重試', async () => {
        m.fetchScanner.mockRejectedValueOnce(new Error('HTTP 500'));
        requestRanking('range');
        await flush();
        expect(getRankingState('range')).toMatchObject({ loading: false, error: 'HTTP 500', items: null });
        expect(requestRanking('range')).toBe(false);
        vi.setSystemTime(T0 + RANKING_COOLDOWN_MS);
        expect(requestRanking('range')).toBe(true);
    });
});

describe('RankingList', () => {
    it('掛載即讀取漲幅排行並顯示名次、名稱代碼、成交價、漲跌與漲跌%', async () => {
        m.fetchScanner.mockResolvedValue([item('2317', 210, 10), item('2330', 1100, 100, { total_volume: 45678 })]);
        await render();
        expect(m.fetchScanner).toHaveBeenCalledWith('ChangePercentRank', 30, true);
        const rows = byTestId('ranking-row');
        expect(rows.map(r => r.props['data-code'])).toEqual(['2330', '2317']); // 10% > 5%
        const first = byTestId('ranking-row-button')[0]!;
        expect(first.props['aria-label']).toContain('第 1 名 2330 名稱2330');
        expect(first.props['aria-label']).toContain('漲 ▲100');
        expect(textOf(first)).toContain('1,100');
        // 第二行「漲跌 漲跌幅」純文字（與自選同版面；fmtPrice：< 500 顯示兩位小數）
        expect(textOf(byTestId('ranking-change')[0]!)).toBe('+100.00 +10.00%');
        expect(textOf(first)).toContain('4.6萬');
    });

    it('跌幅以 ▼ 標示（不只靠顏色）', async () => {
        m.fetchScanner.mockResolvedValue([item('1101', 45, -5)]);
        await render();
        await act(async () => { one('ranking-kind-losers').props.onClick(); });
        await flush();
        expect(m.fetchScanner).toHaveBeenLastCalledWith('ChangePercentRank', 30, false);
        // 可見文字以負號、無障礙名稱以 ▼ 標示方向
        expect(textOf(byTestId('ranking-change')[0]!)).toBe('-5.00 -10.00%');
        expect(byTestId('ranking-row-button')[0]!.props['aria-label']).toContain('跌 ▼5.00 -10.00%');
    });

    it('切換種類再切回來用快取，不重新讀取', async () => {
        await render();
        await act(async () => { one('ranking-kind-volume').props.onClick(); });
        await flush();
        await act(async () => { one('ranking-kind-gainers').props.onClick(); });
        await flush();
        expect(m.fetchScanner.mock.calls.map(c => c[0])).toEqual(['ChangePercentRank', 'VolumeRank']);
    });

    it('卸載再掛載（切換分頁）30 秒內不重新讀取，並保留上次選的種類', async () => {
        await render();
        await act(async () => { one('ranking-kind-amount').props.onClick(); });
        await flush();
        await act(async () => view!.unmount());
        await render();
        expect(one('ranking-kind-amount').props['aria-selected']).toBe(true);
        expect(m.fetchScanner).toHaveBeenCalledTimes(2);
    });

    it('更新鍵：冷卻中停用並顯示秒數，冷卻結束可再讀取', async () => {
        await render();
        expect(one('ranking-refresh').props.disabled).toBe(true);
        expect(textOf(one('ranking-refresh'))).toBe('⟳ 更新（15）');
        await act(async () => { vi.advanceTimersByTime(RANKING_COOLDOWN_MS); });
        expect(one('ranking-refresh').props.disabled).toBe(false);
        await act(async () => { one('ranking-refresh').props.onClick(); });
        await flush();
        expect(m.fetchScanner).toHaveBeenCalledTimes(2);
    });

    it('點一列開交易頁', async () => {
        m.fetchScanner.mockResolvedValue([item('2330', 1100, 100)]);
        await render();
        await act(async () => { byTestId('ranking-row-button')[0]!.props.onClick(); });
        expect(props.onOpen).toHaveBeenCalledWith('2330');
    });

    it('加入自選：呼叫 onAdd；已在自選的列停用；不可加入時停用', async () => {
        m.fetchScanner.mockResolvedValue([item('2330', 1100, 100), item('2317', 210, 10)]);
        await render({ watchedCodes: new Set(['2317']) });
        const adds = () => byTestId('ranking-add');
        expect(adds()[1]!.props.disabled).toBe(true);
        expect(adds()[1]!.props['aria-label']).toBe('2317 已在自選');
        await act(async () => { adds()[0]!.props.onClick(); });
        expect(props.onAdd).toHaveBeenCalledWith('2330');

        await act(async () => view!.unmount());
        await render({ canAdd: false });
        expect(byTestId('ranking-add').every(b => b.props.disabled === true)).toBe(true);
    });

    it('加入自選失敗顯示原因', async () => {
        m.fetchScanner.mockResolvedValue([item('2330', 1100, 100)]);
        await render({ onAdd: vi.fn(async () => { throw new Error('自選清單更新中，請稍後再試'); }) });
        await act(async () => { byTestId('ranking-add')[0]!.props.onClick(); });
        expect(textOf(one('ranking-add-error'))).toBe('2330 加入自選失敗：自選清單更新中，請稍後再試');
    });

    it('空狀態', async () => {
        await render();
        expect(byTestId('ranking-empty')).toHaveLength(1);
        expect(byTestId('ranking-list')).toHaveLength(0);
    });

    it('錯誤狀態：顯示原因，重試鍵受冷卻限制', async () => {
        m.fetchScanner.mockRejectedValueOnce(new Error('連線逾時'));
        await render();
        expect(textOf(one('ranking-error'))).toContain('排行讀取失敗：連線逾時');
        expect(one('ranking-retry').props.disabled).toBe(true);
        await act(async () => { vi.advanceTimersByTime(RANKING_COOLDOWN_MS); });
        m.fetchScanner.mockResolvedValueOnce([item('2330', 1100, 100)]);
        await act(async () => { one('ranking-retry').props.onClick(); });
        await flush();
        expect(byTestId('ranking-error')).toHaveLength(0);
        expect(byTestId('ranking-row')).toHaveLength(1);
    });

    it('頁面在背景時不讀取，回前景才讀', async () => {
        const listeners = new Map<string, () => void>();
        const doc = {
            visibilityState: 'hidden',
            addEventListener: (t: string, fn: () => void) => { listeners.set(t, fn); },
            removeEventListener: (t: string) => { listeners.delete(t); },
        };
        vi.stubGlobal('document', doc);
        await render();
        expect(m.fetchScanner).not.toHaveBeenCalled();
        doc.visibilityState = 'visible';
        await act(async () => { listeners.get('visibilitychange')!(); });
        await flush();
        expect(m.fetchScanner).toHaveBeenCalledTimes(1);
    });
});

// ---- B3c 排行現代化（設計規格 §7.2）----

describe('RankingList — v2 版面', () => {
    it('種類為 Segmented scroll 變體（tablist／tab 語意不變）', async () => {
        await render();
        const list = view!.root.find(n => n.type === Segmented);
        expect(list.props.variant).toBe('scroll');
        expect(list.props.semantics).toBe('tabs');
        const tablist = view!.root.find(n => n.props.role === 'tablist' && typeof n.type === 'string');
        expect(tablist.props['aria-label']).toBe('排行種類');
        const tabs = tablist.findAll(n => n.props.role === 'tab' && n.type === 'button');
        expect(tabs.map(t => t.props.children)).toEqual(RANKING_DEFS.map(d => d.label));
        expect(one('ranking-kind-gainers').props['aria-selected']).toBe(true);
    });

    it('依漲跌著色（與自選相同，不再用實心膠囊）：價格與「漲跌 漲跌幅」上漲 up、平盤 flat、下跌 down', async () => {
        m.fetchScanner.mockResolvedValue([item('2330', 1100, 100), item('1101', 45, -5), item('2002', 30, 0)]);
        await render();
        const change = byTestId('ranking-change');
        expect(change.map(textOf)).toEqual(['+100.00 +10.00%', '0.00 0.00%', '-5.00 -10.00%']);
        expect(change[0]!.props.className).toContain(wlStyles.tone.up);
        expect(change[1]!.props.className).toContain(wlStyles.tone.flat);
        expect(change[2]!.props.className).toContain(wlStyles.tone.down);
        const price = byTestId('ranking-price');
        expect(price[0]!.parent!.props.className).toContain(wlStyles.tone.up);
        expect(price[2]!.parent!.props.className).toContain(wlStyles.tone.down);
        expect(byTestId('ranking-pct')).toHaveLength(0);
    });

    it('讀取中（尚無資料）顯示骨架（role=status＋視覺隱藏文字）', async () => {
        m.fetchScanner.mockImplementationOnce(() => new Promise(() => undefined));
        await render();
        const skeleton = byTestId('ranking-loading');
        expect(skeleton).toHaveLength(1);
        expect(skeleton[0]!.props.role).toBe('status');
        expect(textOf(skeleton[0]!)).toContain('排行讀取中…');
    });

    it('已有資料時讀取失敗：顯示原因但不顯示重試（保留舊名單）', async () => {
        m.fetchScanner.mockResolvedValueOnce([item('2330', 1100, 100)]).mockRejectedValueOnce(new Error('HTTP 502'));
        await render();
        await act(async () => { vi.advanceTimersByTime(RANKING_COOLDOWN_MS); });
        await act(async () => { one('ranking-refresh').props.onClick(); });
        await flush();
        expect(textOf(one('ranking-error'))).toContain('排行讀取失敗：HTTP 502');
        expect(one('ranking-error').props.role).toBe('alert');
        expect(byTestId('ranking-retry')).toHaveLength(0);
        expect(byTestId('ranking-row')).toHaveLength(1);
    });
});

// ---- 與自選共用列元件（使用者要求「排行的顯示方式也要跟自選一樣」）----

const ORDER_FNS = [
    'placeStockOrder', 'placeFuturesOrder', 'placeComboOrder', 'cancelOrder', 'cancelOrders',
    'cancelVerifiedOrder', 'cancelComboOrder', 'updateOrderPrice', 'updateOrderQty', 'requestOrderConfirm',
] as const;

describe('RankingList — 與自選相同的兩行列', () => {
    const rowOf = (code: string) => view!.root.find(n => n.props['data-testid'] === 'ranking-row' && n.props['data-code'] === code && typeof n.type === 'string');
    const inRow = (code: string, id: string) => rowOf(code).findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
    /** 讓走勢的動態 import 與 K 線讀取結算 */
    const settle = async () => {
        for (let i = 0; i < 10; i++) {
            await act(async () => { await vi.dynamicImportSettled(); await Promise.resolve(); });
        }
    };

    it('共用 QuoteRow：第一行名次（小字）＋名稱，第二行代碼＋附加資訊；名次也寫進無障礙名稱', async () => {
        m.fetchScanner.mockResolvedValue([item('2330', 1100, 100, { total_volume: 45678 }), item('2317', 210, 10)]);
        await render();
        const rows = view!.root.findAll(n => n.type === QuoteRow);
        expect(rows.map(r => r.props.testPrefix)).toEqual(['ranking', 'ranking']);
        expect(inRow('2330', 'ranking-rank').map(textOf)).toEqual(['1']);
        expect(inRow('2330', 'ranking-rank')[0]!.props['aria-hidden']).toBe('true');
        expect(inRow('2330', 'ranking-name').map(textOf)).toEqual(['名稱2330']);
        expect(inRow('2330', 'ranking-code').map(textOf)).toEqual(['2330']);
        expect(inRow('2330', 'ranking-extra').map(textOf)).toEqual(['量 4.6萬']);
        expect(inRow('2317', 'ranking-rank').map(textOf)).toEqual(['2']);
        // 排行資料沒有交易所：合約快取沒有時不顯示市場標記
        expect(inRow('2330', 'ranking-market')).toHaveLength(0);
        expect(inRow('2330', 'ranking-row-button')[0]!.props['aria-label']).toMatch(/^第 1 名 2330 名稱2330，1,100，漲 ▲100.00 \+10.00%，總量 4.6萬$/);
    });

    it('種類的特定數值在第二行：成交值排行顯示值、高低價差排行顯示價差（振幅只在無障礙名稱）', async () => {
        m.fetchScanner.mockResolvedValue([item('2330', 1000, 0, { total_amount: 1.5e9, high: 1030, low: 970, price_range: 60 })]);
        await render();
        await act(async () => { one('ranking-kind-amount').props.onClick(); });
        await flush();
        expect(inRow('2330', 'ranking-extra').map(textOf)).toEqual(['值 15.0億']);
        expect(inRow('2330', 'ranking-row-button')[0]!.props['aria-label']).toContain('，成交值 15.0億');
        await act(async () => { one('ranking-kind-range').props.onClick(); });
        await flush();
        expect(inRow('2330', 'ranking-extra').map(textOf)).toEqual(['價差 60.00']);
        expect(inRow('2330', 'ranking-row-button')[0]!.props['aria-label']).toContain('，價差 60.00（振幅 6.00%）');
    });

    it('加入自選：星號鍵（44px IconButton）；已在自選為實心星號、停用；點按只呼叫 onAdd', async () => {
        m.fetchScanner.mockResolvedValue([item('2330', 1100, 100), item('2317', 210, 10)]);
        await render({ watchedCodes: new Set(['2317']) });
        const add = (code: string) => inRow(code, 'ranking-add')[0]!;
        expect(add('2330').props['aria-label']).toBe('2330 加入自選');
        expect(add('2330').props.className).not.toContain(wlStyles.starOn);
        expect(add('2317').props['aria-label']).toBe('2317 已在自選');
        expect(add('2317').props.className).toContain(wlStyles.starOn);
        expect(add('2317').props.disabled).toBe(true);
        await act(async () => { add('2330').props.onClick(); });
        expect(props.onAdd).toHaveBeenCalledWith('2330');
        expect(props.onOpen).not.toHaveBeenCalled();
        // 加入中：其他列的星號暫時停用（同時只加入一檔）
        let release!: () => void;
        await act(async () => view!.unmount());
        await render({ onAdd: vi.fn(() => new Promise<undefined>(r => { release = () => r(undefined); })) });
        await act(async () => { add('2330').props.onClick(); });
        expect(add('2330').props['aria-label']).toBe('2330 加入自選中');
        expect(add('2317').props.disabled).toBe(true);
        await act(async () => { release(); });
        expect(add('2317').props.disabled).toBe(false);
    });

    it('快速下單鍵（S1）：列尾、不在列按鈕內；只開下單面板（不帶方向、source other），不導頁、lib 送單函式 0 次', async () => {
        m.fetchScanner.mockResolvedValue([item('2330', 1100, 100)]);
        await render();
        for (const k of ORDER_FNS) m[k].mockClear();
        expect(inRow('2330', 'ranking-row-button')[0]!.findAll(n => n.props['data-testid'] === 'ranking-row-ticket')).toHaveLength(0);
        const ticket = inRow('2330', 'ranking-row-ticket');
        expect(ticket).toHaveLength(1);
        expect(ticket[0]!.props['aria-label']).toBe('下單 2330 名稱2330');
        await act(async () => { ticket[0]!.props.onClick(); });
        expect(getMobileUi().ticket).toMatchObject({ code: '2330', action: null, price: null, source: 'other' });
        expect(getMobileUi().orderAction).toBeNull();
        expect(props.onOpen).not.toHaveBeenCalled();
        expect(props.onAdd).not.toHaveBeenCalled();
        for (const k of ORDER_FNS) expect(m[k], k).not.toHaveBeenCalled();
    });

    it('處置徽章：與自選共用處置清單（有排行資料時讀 1 次）；處置股顯示徽章並寫入無障礙名稱', async () => {
        m.apiGet.mockResolvedValue({ code: ['2317'] });
        m.fetchScanner.mockResolvedValue([item('2330', 1100, 100), item('2317', 210, 10)]);
        await render();
        await flush();
        expect(m.apiGet.mock.calls.map(c => c[0])).toEqual([PUNISH_PATH]);
        expect(inRow('2317', 'ranking-punish').map(textOf)).toEqual(['處置']);
        expect(inRow('2330', 'ranking-punish')).toHaveLength(0);
        expect(inRow('2317', 'ranking-row-button')[0]!.props['aria-label']).toContain('處置股');
    });

    it('沒有排行資料時不讀處置清單', async () => {
        await render();
        await flush();
        expect(m.apiGet).not.toHaveBeenCalled();
    });

    it('迷你走勢：合約快取裡的股票直接讀 K 線；不在快取的可見列解析一次合約後顯示市場標記與走勢；同一套每檔每時段上限', async () => {
        m.cached.set('2330', { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null, reference: 1000 });
        m.fetchScanner.mockResolvedValue([item('2330', 1100, 100), item('2317', 210, 10)]);
        await render();
        await settle();
        // 合約快取有交易所：顯示市場標記並讀一次 K 線
        expect(inRow('2330', 'ranking-market').map(textOf)).toEqual(['市']);
        expect(m.fetchKbars).toHaveBeenCalledTimes(1);
        expect((m.fetchKbars.mock.calls[0]![0] as { code: string }).code).toBe('2330');
        // 不在快取的列：解析中是同尺寸空白佔位（na），沒有市場標記、不讀 K 線；只解析這一檔
        const blank = inRow('2317', 'ranking-spark-blank');
        expect(blank).toHaveLength(1);
        expect(blank[0]!.props['data-spark']).toBe('na');
        expect(blank[0]!.props.className).toBe(wlStyles.spark);
        expect(inRow('2317', 'ranking-market')).toHaveLength(0);
        expect(m.ensureContract.mock.calls).toEqual([['2317']]);
        // 解析成功：顯示市場標記並讀一次 K 線
        await act(async () => { m.contractPending.get('2317')!.resolve(); });
        await settle();
        expect(inRow('2317', 'ranking-market').map(textOf)).toEqual(['櫃']);
        expect(m.fetchKbars.mock.calls.map(c => (c[0] as { code: string }).code)).toEqual(['2330', '2317']);
        // 重新掛載：合約與 K 線都在模組層快取，不再解析、不再讀
        await act(async () => view!.unmount());
        await render();
        await settle();
        expect(m.ensureContract).toHaveBeenCalledTimes(1);
        expect(m.fetchKbars).toHaveBeenCalledTimes(2);
    });

    it('帳戶頁關閉走勢時：不掛載走勢欄、不讀 K 線', async () => {
        setWatchSparklineEnabled(false);
        m.cached.set('2330', { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null, reference: 1000 });
        m.fetchScanner.mockResolvedValue([item('2330', 1100, 100)]);
        await render();
        await settle();
        expect(inRow('2330', 'ranking-spark-blank')).toHaveLength(0);
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-spark')).toHaveLength(0);
        expect(m.fetchKbars).not.toHaveBeenCalled();
        expect(inRow('2330', 'ranking-row-button')[0]!.props.className).toContain(wlStyles.rowNoSpark);
    });
});

describe('RankingList — 迷你走勢的合約解析（排行沒有交易所）', () => {
    const codes = ['A1', 'A2', 'A3', 'A4', 'A5'];
    const rowOf = (code: string) => view!.root.find(n => n.props['data-testid'] === 'ranking-row' && n.props['data-code'] === code && typeof n.type === 'string');
    const inRow = (code: string, id: string) => rowOf(code).findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
    const settle = async () => {
        for (let i = 0; i < 10; i++) {
            await act(async () => { await vi.dynamicImportSettled(); await Promise.resolve(); });
        }
    };
    const calls = () => m.ensureContract.mock.calls.map(c => c[0]);
    const resolveOne = async (code: string) => {
        await act(async () => { m.contractPending.get(code)!.resolve(); });
        await settle();
    };
    // 漲幅 A1 > A2 > … > A5（名次與 codes 同序）
    const rankingItems = () => codes.map((code, i) => item(code, 100 + (codes.length - i), codes.length - i));

    it('同時最多 2 個解析；一個結束才開始下一個；全部可見時每檔各 1 次；送單／改單／刪單 0 次', async () => {
        m.fetchScanner.mockResolvedValue(rankingItems());
        await render();
        await settle();
        expect(calls()).toEqual(['A1', 'A2']);
        expect(sparkContractQueueStats()).toEqual({ running: 2, queued: 3 });
        await resolveOne('A1');
        expect(calls()).toEqual(['A1', 'A2', 'A3']);
        expect(sparkContractQueueStats().running).toBe(2);
        await act(async () => { m.contractPending.get('A2')!.reject(new Error('404')); });
        await settle();
        expect(calls()).toEqual(['A1', 'A2', 'A3', 'A4']);
        await resolveOne('A3');
        await resolveOne('A4');
        expect(calls()).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
        await resolveOne('A5');
        expect(sparkContractQueueStats()).toEqual({ running: 0, queued: 0 });
        // 成功的顯示市場標記與走勢；失敗的維持空白佔位、沒有市場標記
        for (const code of ['A1', 'A3', 'A4', 'A5']) expect(inRow(code, 'ranking-market').map(textOf), code).toEqual(['櫃']);
        expect(inRow('A2', 'ranking-market')).toHaveLength(0);
        expect(inRow('A2', 'ranking-spark-blank')[0]!.props['data-spark']).toBe('na');
        expect(new Set(m.fetchKbars.mock.calls.map(c => (c[0] as { code: string }).code))).toEqual(new Set(['A1', 'A3', 'A4', 'A5']));
        // 合約 GET 總數＝不在快取的可見代碼數（5），每檔 1 次
        expect(m.ensureContract).toHaveBeenCalledTimes(5);
        for (const k of ORDER_FNS) expect(m[k], k).not.toHaveBeenCalled();
    });

    it('走勢開關關閉：0 個解析；解析中途關閉：排隊中的取消，已送出的不再追加', async () => {
        setWatchSparklineEnabled(false);
        m.fetchScanner.mockResolvedValue(rankingItems());
        await render();
        await settle();
        expect(m.ensureContract).not.toHaveBeenCalled();
        await act(async () => view!.unmount());

        setWatchSparklineEnabled(true);
        await render();
        await settle();
        expect(calls()).toEqual(['A1', 'A2']);
        await act(async () => { setWatchSparklineEnabled(false); });
        expect(sparkContractQueueStats()).toEqual({ running: 2, queued: 0 });
        await resolveOne('A1');
        await resolveOne('A2');
        expect(m.ensureContract).toHaveBeenCalledTimes(2);
        expect(m.fetchKbars).not.toHaveBeenCalled();
    });

    it('已在合約快取：0 個解析', async () => {
        for (const code of codes) m.cached.set(code, stockContract(code));
        m.fetchScanner.mockResolvedValue(rankingItems());
        await render();
        await settle();
        expect(m.ensureContract).not.toHaveBeenCalled();
        expect(inRow('A1', 'ranking-market').map(textOf)).toEqual(['櫃']);
    });

    it('卸載（離開排行）：排隊中的取消', async () => {
        m.fetchScanner.mockResolvedValue(rankingItems());
        await render();
        await settle();
        expect(sparkContractQueueStats()).toEqual({ running: 2, queued: 3 });
        await act(async () => view!.unmount());
        view = undefined;
        expect(sparkContractQueueStats()).toEqual({ running: 2, queued: 0 });
        await act(async () => { m.contractPending.get('A1')!.resolve(); m.contractPending.get('A2')!.resolve(); });
        expect(m.ensureContract).toHaveBeenCalledTimes(2);
    });

    describe('可見度（IntersectionObserver）', () => {
        type Entry = { target: object; isIntersecting: boolean };
        class FakeIO {
            static instances: FakeIO[] = [];
            constructor(public cb: (entries: Entry[]) => void) { FakeIO.instances.push(this); }
            observe() { /* 測試以 setVisible 決定 */ }
            unobserve() { /* 同上 */ }
            disconnect() { /* 同上 */ }
        }
        const nodes = new Map<string, object>();
        const createNodeMock = (el: { type: unknown; props: Record<string, unknown> }) => {
            const code = el.props['data-code'];
            if (el.type === 'li' && typeof code === 'string') {
                const node = nodes.get(code) ?? { code };
                nodes.set(code, node);
                return node;
            }
            return {};
        };
        const setVisible = async (visible: boolean, ...list: string[]) => {
            const io = FakeIO.instances.at(-1)!;
            await act(async () => { io.cb(list.map(code => ({ target: nodes.get(code)!, isIntersecting: visible }))); });
            await settle();
        };
        beforeEach(() => {
            vi.stubGlobal('IntersectionObserver', FakeIO);
            FakeIO.instances = [];
            nodes.clear();
        });

        it('不可見列不解析；列離開畫面時取消未開始的解析，再次可見才排隊', async () => {
            m.fetchScanner.mockResolvedValue(rankingItems());
            await render({}, { createNodeMock: createNodeMock as never });
            await settle();
            expect(m.ensureContract).not.toHaveBeenCalled();
            await setVisible(true, 'A1', 'A2', 'A3', 'A4');
            expect(calls()).toEqual(['A1', 'A2']);
            expect(sparkContractQueueStats()).toEqual({ running: 2, queued: 2 });
            await setVisible(false, 'A3', 'A4');
            expect(sparkContractQueueStats()).toEqual({ running: 2, queued: 0 });
            // 已送出的解析即使列離開畫面也照樣完成並寫入快取（無法中止），之後不追加
            await setVisible(false, 'A1');
            await resolveOne('A1');
            await resolveOne('A2');
            expect(calls()).toEqual(['A1', 'A2']);
            // A1 回到畫面：已在快取，不再解析
            await setVisible(true, 'A1');
            expect(calls()).toEqual(['A1', 'A2']);
            expect(inRow('A1', 'ranking-market').map(textOf)).toEqual(['櫃']);
            // A3 再次可見：排隊並開始
            await setVisible(true, 'A3');
            expect(calls()).toEqual(['A1', 'A2', 'A3']);
        });

        it('解析失敗：同一代碼 5 分鐘內進出畫面都不重試；之後再可見才重試一次', async () => {
            m.fetchScanner.mockResolvedValue(rankingItems());
            await render({}, { createNodeMock: createNodeMock as never });
            await settle();
            await setVisible(true, 'A1');
            expect(calls()).toEqual(['A1']);
            await act(async () => { m.contractPending.get('A1')!.reject(new Error('Network')); });
            await settle();
            await setVisible(false, 'A1');
            await setVisible(true, 'A1');
            expect(calls()).toEqual(['A1']);
            vi.setSystemTime(Date.now() + SPARK_CONTRACT_RETRY_MS);
            await setVisible(false, 'A1');
            await setVisible(true, 'A1');
            expect(calls()).toEqual(['A1', 'A1']);
        });
    });
});
// ---- P1：漲跌價差、成交筆數排行與前端篩選（不發新請求）----

describe('RankingList — 漲價差、跌價差、成交筆數', () => {
    it('漲價差由大到小、跌價差由小到大（依漲跌元，不依漲跌幅）；成交筆數保留伺服器名次', () => {
        const hiPx = item('HI', 1100, 50); // +50 元（+4.76%）
        const loPx = item('LO', 22, 2); // +2 元（+10%）
        const dn = item('DN', 900, -30);
        const bad = item('X', 0, 0, { change_price: Number.NaN });
        expect(sortRanking('priceUp', [loPx, bad, dn, hiPx]).map(i => i.code)).toEqual(['HI', 'LO', 'DN', 'X']);
        expect(sortRanking('priceDown', [hiPx, loPx, bad, dn]).map(i => i.code)).toEqual(['DN', 'LO', 'HI', 'X']);
        expect(sortRanking('ticks', [loPx, dn, hiPx]).map(i => i.code)).toEqual(['LO', 'DN', 'HI']);
    });

    it('種類標籤與順序；切到新種類各讀一次、帶正確參數（伺服器 ascending 相反）', async () => {
        expect(RANKING_DEFS.map(d => d.label)).toEqual(['漲幅', '跌幅', '漲價差', '跌價差', '成交量', '成交值', '成交筆數', '高低價差']);
        await render();
        for (const k of ['priceUp', 'priceDown', 'ticks', 'priceUp'] as const) {
            await act(async () => { one(`ranking-kind-${k}`).props.onClick(); });
            await flush();
        }
        // 最後切回漲價差：30 秒快取內不再讀
        expect(m.fetchScanner.mock.calls).toEqual([
            ['ChangePercentRank', 30, true],
            ['ChangePriceRank', 30, true],
            ['ChangePriceRank', 30, false],
            ['TickCountRank', 30, true],
        ]);
    });
});

describe('排行篩選（純函式）', () => {
    it('ETF：00 開頭（含 6 碼、債券、槓桿反向）', () => {
        for (const c of ['0050', '00878', '006208', '00679B', '00631L']) expect(isEtfCode(c), c).toBe(true);
        for (const c of ['2330', '1101', '8069']) expect(isEtfCode(c), c).toBe(false);
    });

    it('權證：6 碼、03–08 或 7 開頭；股票、ETF、ETN、特別股不算', () => {
        for (const c of ['030001', '08123P', '700123', '73012P']) expect(isWarrantCode(c), c).toBe(true);
        for (const c of ['2330', '0050', '006208', '020000', '2881A', '6488']) expect(isWarrantCode(c), c).toBe(false);
    });

    it('過濾後名次維持原名次；處置名單未取得（null）時不排除處置股', () => {
        const list = [item('2330', 100, 1), item('0050', 100, 1), item('2317', 100, 1), item('030001', 1, 0.1)];
        const all = { noPunished: true, noEtf: true, noWarrant: true };
        expect(filterRanking(list, all, new Set(['2317'])).map(x => [x.item.code, x.rank])).toEqual([['2330', 1]]);
        expect(filterRanking(list, all, null).map(x => [x.item.code, x.rank])).toEqual([['2330', 1], ['2317', 3]]);
        expect(filterRanking(list, { noPunished: false, noEtf: false, noWarrant: false }, new Set(['2317']))).toHaveLength(4);
    });
});

describe('RankingList — 篩選晶片', () => {
    const codes = () => byTestId('ranking-row').map(r => r.props['data-code']);
    const rank = (code: string) => {
        const row = byTestId('ranking-row').find(r => r.props['data-code'] === code)!;
        return textOf(row.findAll(n => n.props['data-testid'] === 'ranking-rank' && typeof n.type === 'string')[0]!);
    };
    const list = () => [item('2330', 110, 10), item('0050', 105, 5), item('2317', 103, 3), item('030001', 1.01, 0.01)];

    it('三個切換鍵（aria-pressed、可見文字、群組名稱）；排除後名次不變、狀態列寫出排除檔數；不發新請求', async () => {
        m.apiGet.mockResolvedValue({ code: ['2317'] });
        m.fetchScanner.mockResolvedValue(list());
        await render();
        await flush();
        const group = one('ranking-filters');
        expect(group.props.role).toBe('group');
        expect(group.props['aria-label']).toBe('排行篩選');
        const btn = (k: string) => one(`ranking-filter-${k}`);
        expect(['noPunished', 'noEtf', 'noWarrant'].map(k => textOf(btn(k)))).toEqual(['排除處置', '排除 ETF', '排除權證']);
        expect(['noPunished', 'noEtf', 'noWarrant'].map(k => btn(k).props['aria-pressed'])).toEqual([false, false, false]);
        expect(codes()).toEqual(['2330', '0050', '2317', '030001']);

        await act(async () => { btn('noEtf').props.onClick(); });
        expect(btn('noEtf').props['aria-pressed']).toBe(true);
        expect(codes()).toEqual(['2330', '2317', '030001']);
        expect(rank('2317')).toBe('3');
        expect(textOf(one('ranking-updated'))).toContain('・已排除 1 檔・');

        await act(async () => { btn('noPunished').props.onClick(); });
        await act(async () => { btn('noWarrant').props.onClick(); });
        expect(codes()).toEqual(['2330']);
        expect(textOf(one('ranking-updated'))).toContain('・已排除 3 檔・');

        // 再按一次關閉
        await act(async () => { btn('noEtf').props.onClick(); });
        expect(codes()).toEqual(['2330', '0050']);
        expect(rank('0050')).toBe('2');

        // 請求數：排行 1、處置清單 1（篩選只在前端過濾）
        expect(m.fetchScanner).toHaveBeenCalledTimes(1);
        expect(m.apiGet.mock.calls.map(c => c[0])).toEqual([PUNISH_PATH]);
    });

    it('篩選跨種類與重新掛載保留；切換種類仍套用', async () => {
        m.fetchScanner.mockResolvedValue(list());
        await render();
        await act(async () => { one('ranking-filter-noEtf').props.onClick(); });
        await act(async () => { one('ranking-kind-volume').props.onClick(); });
        await flush();
        expect(codes()).not.toContain('0050');
        await act(async () => view!.unmount());
        await render();
        expect(one('ranking-filter-noEtf').props['aria-pressed']).toBe(true);
        expect(codes()).not.toContain('0050');
    });

    it('處置名單尚未取得：排除處置不隱藏任何列，並說明原因', async () => {
        m.apiGet.mockRejectedValue(new Error('HTTP 503'));
        m.fetchScanner.mockResolvedValue(list());
        await render();
        await flush();
        await act(async () => { one('ranking-filter-noPunished').props.onClick(); });
        expect(codes()).toEqual(['2330', '0050', '2317', '030001']);
        expect(textOf(one('ranking-filter-punish-pending'))).toContain('處置名單尚未取得');
        expect(one('ranking-filter-punish-pending').props.role).toBe('status');
    });

    it('全部被排除：顯示篩選空狀態（不是「沒有排行資料」）', async () => {
        m.fetchScanner.mockResolvedValue([item('0050', 105, 5), item('00878', 22, 0.2)]);
        await render();
        await act(async () => { one('ranking-filter-noEtf').props.onClick(); });
        expect(byTestId('ranking-filtered-empty')).toHaveLength(1);
        expect(byTestId('ranking-empty')).toHaveLength(0);
        expect(byTestId('ranking-list')).toHaveLength(0);
    });

    it('S1：篩選鍵與新種類分段只過濾／切換，不開下單或委託面板、送單／改單／刪單 0 次', async () => {
        m.fetchScanner.mockResolvedValue(list());
        await render();
        for (const k of ORDER_FNS) m[k].mockClear();
        for (const f of ['noPunished', 'noEtf', 'noWarrant', 'noEtf']) {
            await act(async () => { one(`ranking-filter-${f}`).props.onClick(); });
        }
        for (const k of ['priceUp', 'priceDown', 'ticks'] as const) {
            await act(async () => { one(`ranking-kind-${k}`).props.onClick(); });
            await flush();
        }
        expect(getMobileUi().ticket).toBeNull();
        expect(getMobileUi().orderAction).toBeNull();
        expect(props.onOpen).not.toHaveBeenCalled();
        expect(props.onAdd).not.toHaveBeenCalled();
        for (const k of ORDER_FNS) expect(m[k], k).not.toHaveBeenCalled();
    });
});
