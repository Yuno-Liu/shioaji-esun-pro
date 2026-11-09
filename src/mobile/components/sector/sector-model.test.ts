// 產業流向分頁的純資料邏輯：列組成、流向狀態、五種排序（null 排最後）、流入／流出前 3、格式。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SLOTS, type GroupFlow } from '../../../lib/chain-flow';
import {
    buildSectorRows,
    flowShown,
    flowStatusOf,
    fmtCalculatedAt,
    fmtSectorMoney,
    fmtSectorPct,
    DEFAULT_SECTOR_SORT,
    gainRank,
    nextSectorSort,
    readSectorSort,
    SECTOR_SORT_STORAGE_KEY,
    sortSectorRows,
    sortSectorRowsBy,
    writeSectorSort,
    topFlows,
    toneOf,
    visibleFlow,
    type SectorRow,
} from './sector-model';

function flow(netAt: Record<number, number>, turnoverAt: Record<number, number>, flow5 = 0): GroupFlow {
    const net = new Float64Array(SESSION_SLOTS);
    const turnover = new Float64Array(SESSION_SLOTS);
    for (const [i, v] of Object.entries(netAt)) net[Number(i)] = v;
    for (const [i, v] of Object.entries(turnoverAt)) turnover[Number(i)] = v;
    const cumNet = new Float64Array(SESSION_SLOTS);
    let run = 0;
    for (let i = 0; i < SESSION_SLOTS; i += 1) {
        run += net[i]!;
        cumNet[i] = run;
    }
    return { count: 10, turnover, net, cumNet, flow5, turnover5: 0, accel: null, total: 0, pct: null, volumeRatio: null, breadth: { up: 0, flat: 0, down: 0 } };
}

const g = (category: string, name: string, value: number) => ({ category, name, item_count: 5, value });

describe('buildSectorRows', () => {
    it('合併成交值與加權漲跌、計算成交值占比、帶入流向', () => {
        const rows = buildSectorRows(
            'IX0001',
            [g('24', '半導體業', 300), g('28', '金融保險業', 100)],
            [g('24', '半導體業', 1.5), g('13', '電子零組件業', -0.2)],
            key => (key === 'IX0001:24' ? flow({ 60: 10, 61: -4 }, { 60: 20, 61: 8 }, 6) : null),
            61,
        );
        const by = new Map(rows.map(r => [r.key, r]));
        expect(by.get('IX0001:24')).toMatchObject({ name: '半導體業', pct: 1.5, amount: 300, share: 0.75 });
        expect(by.get('IX0001:24')!.flow).toMatchObject({ flow5: 6, net: 6, turnover: 28, series: [10, 6] });
        expect(by.get('IX0001:28')).toMatchObject({ pct: null, amount: 100, share: 0.25, flow: null });
        expect(by.get('IX0001:13')).toMatchObject({ pct: -0.2, amount: null, share: null });
    });
});

describe('flowStatusOf', () => {
    const live = { flow: { flow5: 0, turnover5: 0, net: 0, turnover: 5, series: [] } } as unknown as SectorRow;
    const baseline = { flow: { flow5: 0, turnover5: 0, net: 0, turnover: 0, series: [] } } as unknown as SectorRow;
    it('量到成交值增量才顯示流向（盤中 live、收盤後 ended）；收盤且沒有量測 closed；盤中只有基準或沒有記錄時 waiting', () => {
        expect(flowStatusOf([live], 'continuous_trading')).toBe('live');
        // 收盤（含收盤集合競價那一包標示 closed）不清掉已量到的流向
        expect(flowStatusOf([live], 'closed')).toBe('ended');
        expect(flowStatusOf([baseline], 'closed')).toBe('closed');
        expect(flowStatusOf([], 'closed')).toBe('closed');
        expect(flowStatusOf([baseline], 'continuous_trading')).toBe('waiting');
        expect(flowStatusOf([], undefined)).toBe('waiting');
    });

    it('ended 時流向照常可見，closed／waiting 時隱藏', () => {
        expect(visibleFlow(live, 'ended')).toBe(live.flow);
        expect(visibleFlow(live, 'live')).toBe(live.flow);
        expect(visibleFlow(live, 'closed')).toBeNull();
        expect(visibleFlow(live, 'waiting')).toBeNull();
        expect(flowShown('ended')).toBe(true);
        expect(flowShown('closed')).toBe(false);
    });
});

afterEach(() => vi.unstubAllGlobals());

describe('sortSectorRows／topFlows', () => {
    const mk = (category: string, pct: number | null, amount: number | null, net: number | null): SectorRow => ({
        key: `IX0001:${category}`,
        category,
        name: category,
        count: 1,
        pct,
        amount,
        share: null,
        flow: net === null ? null : { flow5: 0, turnover5: 0, net, turnover: 1, series: [] },
    });
    const rows = [mk('a', 1, 100, 5), mk('b', -2, 300, -7), mk('c', null, 200, null), mk('d', 3, null, 2), mk('e', 0, 50, -1)];
    const order = (sort: Parameters<typeof sortSectorRows>[1], status: Parameters<typeof sortSectorRows>[2] = 'live') =>
        sortSectorRows(rows, sort, status).map(r => r.category);

    it('五種排序，沒有值的排最後', () => {
        expect(order('inflow')).toEqual(['a', 'd', 'e', 'b', 'c']);
        expect(order('outflow')).toEqual(['b', 'e', 'd', 'a', 'c']);
        expect(order('gain')).toEqual(['d', 'a', 'e', 'b', 'c']);
        expect(order('loss')).toEqual(['b', 'e', 'a', 'd', 'c']);
        expect(order('amount')).toEqual(['b', 'c', 'a', 'e', 'd']);
    });

    it('流向不可用時資金流入／流出依成交值排列', () => {
        expect(order('inflow', 'closed')).toEqual(order('amount'));
        expect(order('outflow', 'waiting')).toEqual(order('amount'));
    });

    it('前 3：流入只取淨流入 > 0、流出只取 < 0；流向不可用時為空', () => {
        const t = topFlows(rows, 'live');
        expect(t.inflow.map(r => r.category)).toEqual(['a', 'd']);
        expect(t.outflow.map(r => r.category)).toEqual(['b', 'e']);
        expect(topFlows(rows, 'closed')).toEqual({ inflow: [], outflow: [] });
        expect(topFlows(rows, 'ended')).toEqual(t);
    });

    it('漲幅名次只算有漲跌的產業', () => {
        expect(gainRank(rows, 'IX0001:a')).toEqual({ rank: 2, of: 4 });
        expect(gainRank(rows, 'IX0001:c')).toBeNull();
    });

    it('使用者排序：預設資金流向由流入到流出＝原本的預設；反向時沒有資料的仍在最後', () => {
        const by = (key: Parameters<typeof nextSectorSort>[1], dir: 'asc' | 'desc', status: Parameters<typeof sortSectorRows>[2] = 'live') =>
            sortSectorRowsBy(rows, { key, dir }, status).map(r => r.category);
        expect(DEFAULT_SECTOR_SORT).toEqual({ key: 'flow', dir: 'desc' });
        expect(by('flow', 'desc')).toEqual(order('inflow'));
        expect(by('flow', 'asc')).toEqual(order('outflow'));
        expect(by('pct', 'desc')).toEqual(order('gain'));
        expect(by('pct', 'asc')).toEqual(order('loss'));
        expect(by('amount', 'desc')).toEqual(['b', 'c', 'a', 'e', 'd']);
        expect(by('amount', 'asc')).toEqual(['e', 'a', 'c', 'b', 'd']);
        // 近 5 分：flow5 全為 0 → 同值依成交值；沒有流向的 c 在最後
        expect(by('flow5', 'desc')).toEqual(['b', 'a', 'e', 'd', 'c']);
        expect(by('flow5', 'asc')).toEqual(['b', 'a', 'e', 'd', 'c']);
        // 流向不可用：兩個方向都依成交值
        expect(by('flow', 'asc', 'closed')).toEqual(order('amount'));
    });

    it('點目前的選項反向、其他選項由大到小；偏好讀寫（格式不對用預設）', () => {
        expect(nextSectorSort(DEFAULT_SECTOR_SORT, 'flow')).toEqual({ key: 'flow', dir: 'asc' });
        expect(nextSectorSort({ key: 'flow', dir: 'asc' }, 'flow')).toEqual({ key: 'flow', dir: 'desc' });
        expect(nextSectorSort({ key: 'flow', dir: 'asc' }, 'amount')).toEqual({ key: 'amount', dir: 'desc' });
        const data = new Map<string, string>();
        vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } });
        expect(readSectorSort()).toEqual(DEFAULT_SECTOR_SORT);
        writeSectorSort({ key: 'amount', dir: 'asc' });
        expect(readSectorSort()).toEqual({ key: 'amount', dir: 'asc' });
        localStorage.setItem(SECTOR_SORT_STORAGE_KEY, '{bad');
        expect(readSectorSort()).toEqual(DEFAULT_SECTOR_SORT);
        localStorage.setItem(SECTOR_SORT_STORAGE_KEY, JSON.stringify({ key: 'inflow', dir: 'desc' }));
        expect(readSectorSort()).toEqual(DEFAULT_SECTOR_SORT);
        // 儲存空間不可用：讀用預設、寫不拋錯
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
        expect(readSectorSort()).toEqual(DEFAULT_SECTOR_SORT);
        expect(() => writeSectorSort({ key: 'pct', dir: 'desc' })).not.toThrow();
    });
});

describe('格式', () => {
    it('漲跌附 ▲▼ 與正負號；金額兆／億／萬；資料時間', () => {
        expect(fmtSectorPct(1.234)).toBe('▲+1.23%');
        expect(fmtSectorPct(-0.5)).toBe('▼−0.50%');
        expect(fmtSectorPct(0)).toBe('0.00%');
        expect(fmtSectorPct(null)).toBe('—');
        expect(fmtSectorMoney(3e11)).toBe('3000 億');
        expect(fmtSectorMoney(-5e8, true)).toBe('−5.00 億');
        expect(fmtSectorMoney(1.2e9, true)).toBe('+12.0 億');
        expect(fmtSectorMoney(2.5e12)).toBe('2.50 兆');
        expect(fmtSectorMoney(35_000)).toBe('4 萬');
        expect(fmtSectorMoney(0, true)).toBe('0');
        expect(fmtSectorMoney(Number.NaN)).toBe('—');
        expect(fmtCalculatedAt('2026-11-06T13:30:05.123456+08:00')).toBe('13:30:05');
        expect(fmtCalculatedAt(undefined)).toBeNull();
        expect(toneOf(2)).toBe('up');
        expect(toneOf(-2)).toBe('down');
        expect(toneOf(0)).toBe('flat');
        expect(toneOf(null)).toBe('flat');
    });
});
