// 交易頁標頭的價格來源（B1 快照、B2 試撮、B8 不用 pct_chg）
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types/market';
import { headerQuote } from './quote-display';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
    code: '2330', exchange: 'TSE', datetime: '2026-11-05 13:30:00.000000', open: 1070, high: 1090, low: 1065, close: 1085,
    average_price: 1080, buy_price: 1080, buy_volume: 1, sell_price: 1085, sell_volume: 1, volume: 5, total_volume: 23456,
    amount: 0, total_amount: 0, change_price: 15, change_rate: 1.4, change_type: 'Up', tick_type: 'Buy', volume_ratio: 1, yesterday_volume: 1,
    ...over,
});

describe('headerQuote', () => {
    it('即時成交：漲跌幅以 price_chg 與參考價推算，不用 pct_chg（B8）', () => {
        // 股票串流 pct_chg 的單位是 ％×100：140 代表 1.40%
        const q = headerQuote({ reference: 1070, tick: { date: '2026-11-05', time: '10:00:00', close: '1085', price_chg: '15', pct_chg: '140', total_volume: 99 } as never });
        expect(q).toMatchObject({ price: 1085, change: 15, dir: 'up', source: 'tick', totalVolume: 99, sim: null });
        expect(q.pct).toBeCloseTo((15 / 1070) * 100, 10);
    });

    it('沒有 tick 時用快照的收盤、漲跌、漲跌幅、總量（B1）', () => {
        const q = headerQuote({ reference: 1070, snapshot: snap() });
        expect(q).toEqual({ price: 1085, change: 15, pct: 1.4, dir: 'up', source: 'snapshot', totalVolume: 23456, sim: null });
    });

    it('連快照都沒有：顯示參考價並標示來源，不顯示漲跌（B1）', () => {
        expect(headerQuote({ reference: 1070 })).toEqual({ price: 1070, change: null, pct: null, dir: 'flat', source: 'reference', totalVolume: null, sim: null });
        expect(headerQuote({ reference: 0 }).source).toBe('none');
    });

    it('試撮揭示不當成交價：改用快照，揭示價只放在 sim（B2）', () => {
        const q = headerQuote({ reference: 1070, tick: { close: '1175', price_chg: '105', simtrade: true, total_volume: 0 }, snapshot: snap() });
        expect(q).toMatchObject({ price: 1085, source: 'snapshot', sim: { price: 1175, change: 105 } });
    });

    it('試撮時有上一筆真實成交（比快照新）就用它（B2）', () => {
        const q = headerQuote({
            reference: 1070,
            tick: { date: '2026-11-05', time: '13:26:00', close: '1175', simtrade: true },
            lastRealTick: { date: '2026-11-05', time: '13:24:59', close: '1080', price_chg: '10', total_volume: 500 },
            snapshot: snap({ datetime: '2026-11-05 09:30:00.000000' }),
        });
        expect(q).toMatchObject({ price: 1080, change: 10, source: 'tick', totalVolume: 500, sim: { price: 1175 } });
    });

    it('成交早於快照時間時用快照（回前景後重取的快照較新）', () => {
        const q = headerQuote({
            reference: 1070,
            tick: { date: '2026-11-05', time: '09:10:00', close: '1072', price_chg: '2' },
            snapshot: snap({ datetime: '2026-11-05 13:30:00.000000' }),
        });
        expect(q.source).toBe('snapshot');
    });

    it('指數：以 index.reference 計算漲跌與漲跌幅', () => {
        const q = headerQuote({ reference: 0, index: { close: '23100', reference: '23000' } });
        expect(q).toMatchObject({ price: 23100, change: 100, source: 'index', totalVolume: null });
        expect(q.pct).toBeCloseTo((100 / 23000) * 100, 10);
    });
});
