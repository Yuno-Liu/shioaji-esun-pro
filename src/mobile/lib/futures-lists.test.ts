// 固定清單「股期近月」「股期遠月」的資料（lib/futures-lists.ts）：
// - 範圍：一般（乘數 2000）＋小型（100）股票期貨；調整型（其他乘數）、ETF 期貨、指數期貨不列。
// - 近月取 R1、遠月取 R2 的 target_code（實際月份）；列代碼是實際月份代碼、合約是實際月份那一筆（target_code null）；
//   沒有 R2 的標的不出現在遠月；最後交易日已過不列；順序：標的代號 → 一般在小型前。
// - 讀取：同一個台北日 1 次請求（兩個分頁共用）；日期改變後重新讀取；失敗不快取。
// 合約資料為合成的小型樣本（格式比照 /api/v1/data/contracts/futures）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';

const m = vi.hoisted(() => ({ fetchFutures: vi.fn(), contractListeners: [] as ((e: Record<string, unknown>) => void)[] }));
vi.mock('../../lib/shioaji', () => ({ fetchFutures: m.fetchFutures }));
vi.mock('../../lib/stream', () => ({
    onContractEvent: (l: (e: Record<string, unknown>) => void) => { m.contractListeners.push(l); return () => undefined; },
}));

import { buildFuturesLists, compareFuturesRows, FUTURES_LISTS, loadFuturesLists, msToTaipeiMidnight, peekFuturesLists, resetFuturesListsForTest, taipeiDate } from './futures-lists';

const fut = (code: string, over: Partial<ContractInfo> = {}): ContractInfo => ({
    code,
    name: code,
    security_type: 'FUT',
    exchange: 'TAIFEX',
    target_code: null,
    currency: 'TWD',
    reference: 100,
    limit_up: 110,
    limit_down: 90,
    day_trade: '',
    update_date: '2026-11-09',
    category: '',
    margin_trading_balance: 0,
    short_selling_balance: 0,
    spec_kind: 'stock_fut',
    underlying_kind: 'S',
    multiplier: 2000,
    last_trading_date: '2026-11-18',
    ...over,
});

/** 一個標的的 R1、R2 與兩個實際月份 */
function family(root: string, under: string, name: string, mult: number, opts: { r2?: boolean; spec?: string; kind?: string } = {}): ContractInfo[] {
    const common = { root, underlying_code: under, multiplier: mult, spec_kind: opts.spec ?? 'stock_fut', underlying_kind: opts.kind ?? 'S' };
    const rows = [
        fut(`${root}R1`, { ...common, name: `${name} 近月`, target_code: `${root}K6`, reference: 101 }),
        fut(`${root}K6`, { ...common, name: `${name} 202611`, reference: 101, delivery_month: '202611' }),
        fut(`${root}L6`, { ...common, name: `${name} 202612`, reference: 102, delivery_month: '202612', last_trading_date: '2026-12-16' }),
    ];
    if (opts.r2 !== false) rows.push(fut(`${root}R2`, { ...common, name: `${name} 次月`, target_code: `${root}L6`, reference: 102 }));
    return rows;
}

const ALL: ContractInfo[] = [
    ...family('QFF', '2330', '小型台積電期貨', 100),
    ...family('CDF', '2330', '台積電期貨', 2000),
    ...family('DHF', '2317', '鴻海期貨', 2000),
    ...family('DE1', '2303', '聯電期貨', 2000, { r2: false }),
    // 調整型契約（乘數不是 2000／100）
    ...family('CD1', '2330', '台積電期貨（調整）', 2020),
    // ETF 期貨、指數期貨
    ...family('NYF', '0050', '元大台灣50期貨', 10000, { spec: 'etf_fut' }),
    ...family('TXF', 'IX0001', '臺股期貨', 200, { spec: 'index_fut', kind: 'I' }),
];

beforeEach(() => {
    resetFuturesListsForTest();
    m.fetchFutures.mockReset();
});

describe('buildFuturesLists', () => {
    it('只列一般＋小型股票期貨；近月對到 R1 的實際月份，遠月對到 R2；順序為標的代號、一般在小型前', () => {
        const { near, next } = buildFuturesLists(ALL, '2026-11-09');
        expect(near.map(r => r.code)).toEqual(['DE1K6', 'DHFK6', 'CDFK6', 'QFFK6']);
        expect(near.map(r => [r.under, r.mult])).toEqual([['2303', 2000], ['2317', 2000], ['2330', 2000], ['2330', 100]]);
        // 沒有 R2 的標的（2303）不在遠月
        expect(next.map(r => r.code)).toEqual(['DHFL6', 'CDFL6', 'QFFL6']);
        expect(next.map(r => r.contract.delivery_month)).toEqual(['202612', '202612', '202612']);
    });

    it('列代碼與合約都是實際月份（target_code null）；名稱去掉月份；調整型、ETF、指數期貨都不列', () => {
        const { near, next } = buildFuturesLists(ALL, '2026-11-09');
        const cdf = near.find(r => r.under === '2330' && r.mult === 2000)!;
        expect(cdf.code).toBe('CDFK6');
        expect(cdf.contract.code).toBe('CDFK6');
        expect(cdf.contract.target_code).toBeNull();
        expect(cdf.contract.name).toBe('台積電期貨 202611');
        expect(cdf.name).toBe('台積電期貨');
        expect(near.find(r => r.mult === 100)!.name).toBe('小型台積電期貨');
        const codes = [...near, ...next].map(r => r.code);
        for (const excluded of ['CD1K6', 'CD1L6', 'NYFK6', 'NYFL6', 'TXFK6', 'TXFL6']) expect(codes).not.toContain(excluded);
        // 沒有任何連續月代碼
        expect(codes.some(c => /R[12]$/.test(c))).toBe(false);
    });

    it('實際月份那一筆缺少時以 R1 換成實際代碼；最後交易日已過的不列；重複的實際代碼只列一次', () => {
        const onlyR1 = fut('ABFR1', { root: 'ABF', underlying_code: '1101', name: '台泥期貨 近月', target_code: 'ABFK6' });
        const expired = fut('OLDR1', { root: 'OLD', underlying_code: '1102', target_code: 'OLDJ6', last_trading_date: '2026-10-21' });
        const { near } = buildFuturesLists([onlyR1, expired, onlyR1], '2026-11-09');
        expect(near).toHaveLength(1);
        expect(near[0]!.code).toBe('ABFK6');
        expect(near[0]!.contract.code).toBe('ABFK6');
        expect(near[0]!.contract.target_code).toBeNull();
        expect(near[0]!.name).toBe('台泥期貨');
    });

    it('不是陣列或缺代碼的資料不會丟錯', () => {
        expect(buildFuturesLists(null as unknown as ContractInfo[])).toEqual({ near: [], next: [] });
        expect(buildFuturesLists([{} as ContractInfo, ...family('DHF', '2317', '鴻海期貨', 2000)], '2026-11-09').near).toHaveLength(1);
    });

    it('compareFuturesRows：標的代號 → 一般在小型前 → 代碼', () => {
        const rows = [
            { under: '2330', mult: 100, code: 'QFFK6' },
            { under: '2317', mult: 2000, code: 'DHFK6' },
            { under: '2330', mult: 2000, code: 'CDFK6' },
        ];
        expect([...rows].sort(compareFuturesRows).map(r => r.code)).toEqual(['DHFK6', 'CDFK6', 'QFFK6']);
    });

    it('固定清單 id 與標籤', () => {
        expect(FUTURES_LISTS.map(l => [l.id, l.label])).toEqual([['fut:near', '股期近月'], ['fut:next', '股期遠月']]);
    });
});

describe('loadFuturesLists：依台北日期快取', () => {
    const day1 = Date.parse('2026-11-09T01:00:00Z'); // 台北 09:00
    const sameDayLate = Date.parse('2026-11-09T15:59:00Z'); // 台北 23:59
    const day2 = Date.parse('2026-11-09T16:00:30Z'); // 台北 11/10 00:00

    it('台北日期與到午夜的毫秒數', () => {
        expect(taipeiDate(day1)).toBe('2026-11-09');
        expect(taipeiDate(sameDayLate)).toBe('2026-11-09');
        expect(taipeiDate(day2)).toBe('2026-11-10');
        expect(msToTaipeiMidnight(sameDayLate)).toBe(60_000);
    });

    it('同一個台北日只發 1 次請求（並行與之後的呼叫共用）；日期改變後重新讀取', async () => {
        m.fetchFutures.mockResolvedValue(ALL);
        const [a, b] = await Promise.all([loadFuturesLists(day1), loadFuturesLists(day1)]);
        expect(a).toBe(b);
        await loadFuturesLists(sameDayLate);
        expect(m.fetchFutures).toHaveBeenCalledTimes(1);
        expect(m.fetchFutures).toHaveBeenCalledWith({});
        expect(peekFuturesLists(day1)).toBe(a);
        expect(peekFuturesLists(day2)).toBeUndefined();
        await loadFuturesLists(day2);
        expect(m.fetchFutures).toHaveBeenCalledTimes(2);
    });

    it('伺服器推送期貨合約清單變更（base_changed，FUT 或不分類）：清掉快取、不立即請求，下次讀取才重新請求', async () => {
        m.fetchFutures.mockResolvedValue(ALL);
        await loadFuturesLists(day1);
        expect(m.contractListeners).toHaveLength(1);
        const emit = (e: Record<string, unknown>) => m.contractListeners.forEach(l => l(e));
        emit({ base_changed: false, info_changed: true, security_type: 'FUT' });
        emit({ base_changed: true, info_changed: false, security_type: 'STK' });
        expect(peekFuturesLists(day1)).toBeDefined();
        emit({ base_changed: true, info_changed: false, security_type: 'FUT' });
        expect(peekFuturesLists(day1)).toBeUndefined();
        expect(m.fetchFutures).toHaveBeenCalledTimes(1);
        await loadFuturesLists(day1);
        expect(m.fetchFutures).toHaveBeenCalledTimes(2);
        emit({ base_changed: true, info_changed: false, security_type: null });
        expect(peekFuturesLists(day1)).toBeUndefined();
        // 監聽只註冊一次
        expect(m.contractListeners).toHaveLength(1);
    });

    it('失敗不快取：下次呼叫重新讀取', async () => {
        m.fetchFutures.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(ALL);
        await expect(loadFuturesLists(day1)).rejects.toThrow('503');
        expect(peekFuturesLists(day1)).toBeUndefined();
        const data = await loadFuturesLists(day1);
        expect(data.near.length).toBe(4);
        expect(m.fetchFutures).toHaveBeenCalledTimes(2);
    });
});
