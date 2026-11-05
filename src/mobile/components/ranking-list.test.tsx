// 漲跌幅排行：讀取參數、30 秒快取、15 秒冷卻、排序、點擊導頁、加入自選、空狀態與錯誤狀態
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScannerItem } from '../../lib/types/market';

const m = vi.hoisted(() => ({
    fetchScanner: vi.fn<(type: string, count: number, ascending: boolean) => Promise<unknown>>(),
}));
vi.mock('../../lib/shioaji', () => ({ fetchScanner: m.fetchScanner }));

import {
    getRankingState,
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
async function render(over: Partial<typeof props> = {}) {
    await act(async () => { view = create(createElement(RankingList, { ...props, ...over })); });
    await flush();
}
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
        for (const kind of ['gainers', 'losers', 'volume', 'amount', 'range'] as const) requestRanking(kind);
        await flush();
        expect(m.fetchScanner.mock.calls).toEqual([
            ['ChangePercentRank', RANKING_COUNT, true],
            ['ChangePercentRank', RANKING_COUNT, false],
            ['VolumeRank', RANKING_COUNT, true],
            ['AmountRank', RANKING_COUNT, true],
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
        expect(textOf(byTestId('ranking-change')[0]!)).toBe('▲100.00'); // fmtPrice：< 500 顯示兩位小數
        expect(textOf(byTestId('ranking-pct')[0]!)).toBe('+10.00%');
        expect(textOf(first)).toContain('4.6萬');
    });

    it('跌幅以 ▼ 標示（不只靠顏色）', async () => {
        m.fetchScanner.mockResolvedValue([item('1101', 45, -5)]);
        await render();
        await act(async () => { one('ranking-kind-losers').props.onClick(); });
        await flush();
        expect(m.fetchScanner).toHaveBeenLastCalledWith('ChangePercentRank', 30, false);
        expect(textOf(byTestId('ranking-change')[0]!)).toBe('▼5.00');
        expect(textOf(byTestId('ranking-pct')[0]!)).toBe('-10.00%');
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
