// 交易頁標頭的價格來源（B1 快照、B2 試撮、B8 不用 pct_chg）、統計格、比例條
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types/market';
import { headerQuote, headerStats, innerOuterRatio, limitHit, splitPercent, toneVsReference, volumeUnit } from './quote-display';

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

const liveTick = {
    date: '2026-11-05', time: '13:20:00', close: '2260', price_chg: '0', open: '2250', high: '2285', low: '2235', avg_price: '2254.16',
    volume: 3, total_volume: 36368, total_amount: '81980000000',
};

describe('headerStats', () => {
    it('即時成交：開高低、均價、總量、單量、成交金額取自 tick；參考價取合約', () => {
        expect(headerStats({ reference: 2260, tick: liveTick })).toEqual({
            source: 'tick', open: 2250, high: 2285, low: 2235, reference: 2260, avg: 2254.16,
            totalVolume: 36368, lastVolume: 3, totalAmount: 81980000000,
        });
    });

    it('沒有 tick：改用快照的 open／high／low／average_price／total_volume／volume／total_amount', () => {
        expect(headerStats({ reference: 1070, snapshot: snap({ total_amount: 25300000000 }) })).toEqual({
            source: 'snapshot', open: 1070, high: 1090, low: 1065, reference: 1070, avg: 1080,
            totalVolume: 23456, lastVolume: 5, totalAmount: 25300000000,
        });
    });

    it('來源與 headerQuote 一致：成交早於快照時整組用快照，不逐欄混用', () => {
        const s = headerStats({ reference: 1070, tick: { ...liveTick, time: '09:10:00' }, snapshot: snap() });
        expect(s.source).toBe('snapshot');
        expect(s.totalVolume).toBe(23456);
    });

    it('試撮 tick 不採用；有上一筆真實成交時用它', () => {
        const sim = { close: '1175', simtrade: true, open: '1175', high: '1175', low: '1175', total_volume: 0 };
        expect(headerStats({ reference: 1070, tick: sim }).source).toBe('none');
        expect(headerStats({ reference: 1070, tick: sim, lastRealTick: liveTick }).open).toBe(2250);
    });

    it('合約沒有參考價：由成交價與漲跌推回；缺欄位為 null', () => {
        const s = headerStats({ reference: 0, tick: { close: '105', price_chg: '5' } });
        expect(s).toMatchObject({ reference: 100, open: null, avg: null, totalVolume: null, lastVolume: null, totalAmount: null });
    });

    it('只有參考價：其他欄位 null；指數只取開高低與 index.reference', () => {
        expect(headerStats({ reference: 1070 })).toMatchObject({ source: 'none', reference: 1070, open: null, totalVolume: null });
        expect(headerStats({ reference: 0, index: { close: '23100', reference: '23000', open: '23050', high: '23200', low: '22990' } })).toEqual({
            source: 'index', open: 23050, high: 23200, low: 22990, reference: 23000, avg: null, totalVolume: null, lastVolume: null, totalAmount: null,
        });
    });
});

describe('toneVsReference／limitHit', () => {
    it('相對參考價著色；沒有參考價為 flat', () => {
        expect(toneVsReference(1085, 1070)).toBe('up');
        expect(toneVsReference(1065, 1070)).toBe('down');
        expect(toneVsReference(1070, 1070)).toBe('flat');
        expect(toneVsReference(1085, null)).toBe('flat');
        expect(toneVsReference(null, 1070)).toBe('flat');
    });

    it('成交價等於漲跌停價才標示', () => {
        expect(limitHit(1175, 1175, 963)).toBe('up');
        expect(limitHit(963, 1175, 963)).toBe('down');
        expect(limitHit(1170, 1175, 963)).toBeNull();
        expect(limitHit(null, 1175, 963)).toBeNull();
        expect(limitHit(0, 0, 0)).toBeNull();
    });
});

describe('splitPercent／innerOuterRatio', () => {
    it('四捨五入、相加為 100；總和 0、負值、缺值回傳 null', () => {
        expect(splitPercent(316, 173)).toEqual({ left: 316, right: 173, leftPct: 65, rightPct: 35 });
        expect(splitPercent(1, 0)).toMatchObject({ leftPct: 100, rightPct: 0 });
        expect(splitPercent(0, 0)).toBeNull();
        expect(splitPercent(-1, 5)).toBeNull();
        expect(splitPercent(undefined, 5)).toBeNull();
        expect(splitPercent(NaN, 5)).toBeNull();
    });

    it('內外盤比：內盤＝ask_side_total_vol（賣方主動）、外盤＝bid_side_total_vol（買方主動）；缺欄位或試撮回傳 null', () => {
        expect(innerOuterRatio({ close: '1', bid_side_total_vol: 580, ask_side_total_vol: 420 })).toMatchObject({ left: 420, right: 580, leftPct: 42, rightPct: 58 });
        // 2026-11-12 2313 華通實際資料（09:57 前逐筆成交：tick_type 1 外盤 22,458 張、tick_type 2 內盤 8,281 張；
        // 同時刻串流 tick 的 bid_side 占比為 73%）：外盤 73%、內盤 27%，不是相反
        expect(innerOuterRatio({ close: '211.5', bid_side_total_vol: 22458, ask_side_total_vol: 8281 })).toMatchObject({ leftPct: 27, rightPct: 73 });
        expect(innerOuterRatio({ close: '1' })).toBeNull();
        expect(innerOuterRatio({ close: '1', bid_side_total_vol: 580 })).toBeNull();
        expect(innerOuterRatio({ close: '1', bid_side_total_vol: 580, ask_side_total_vol: 420, simtrade: true })).toBeNull();
        expect(innerOuterRatio(undefined)).toBeNull();
    });

    it('量的單位：股票張、零股股、期權口、指數無', () => {
        expect(volumeUnit('STK')).toBe('張');
        expect(volumeUnit('STK', true)).toBe('股');
        expect(volumeUnit('FUT')).toBe('口');
        // 權證沒有零股：一律以張
        expect(volumeUnit('WRT')).toBe('張');
        expect(volumeUnit('WRT', true)).toBe('張');
        expect(volumeUnit('OPT', true)).toBe('口');
        expect(volumeUnit('IND')).toBe('');
    });
});
