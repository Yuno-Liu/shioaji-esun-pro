// 交易圖表價格資訊列（lib/chart-readout.ts）：漲跌差額不吸附跳動價位、正負號與 ▲▼、K 線較前一根、日 K 日期、小 store 去重
import { describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { Candle } from '../../lib/types/market';
import { fmtPrice } from '../../lib/utils/format';
import { changeAbsText, chartReadout, createReadoutStore, readoutChange, readoutTime } from './chart-readout';
import { formatQuotePrice } from './num-format';

const stk = { exchange: 'TSE', code: '2330', security_type: 'STK', reference: 1070 } as ContractInfo;
const at = (iso: string) => Date.parse(`${iso}Z`) / 1000;
const bar = (iso: string, close: number): Candle => ({ time: at(iso), open: close, high: close, low: close, close, volume: 1 });

describe('chart-readout', () => {
    it('漲跌：▲▼＋差額、正負號＋2 位小數；平盤沒有箭頭', () => {
        expect(readoutChange(stk, 1080, 1070)).toMatchObject({ dir: 'up', text: '▲10', pct: '+0.93%' });
        expect(readoutChange(stk, 1065, 1070)).toMatchObject({ dir: 'down', text: '▼5', pct: '-0.47%' });
        expect(readoutChange(stk, 1070, 1070)).toMatchObject({ dir: 'flat', text: '0', pct: '0.00%' });
    });

    it('跨級距的差額不吸附到跳動價位（99.9 → 100.5 差 0.6，不是 0.5）', () => {
        expect(readoutChange(stk, 100.5, 99.9)).toMatchObject({ dir: 'up', text: '▲0.6', pct: '+0.60%' });
        expect(readoutChange(stk, 9.99, 10.05)).toMatchObject({ dir: 'down', text: '▼0.06' });
    });

    it('基準不是正數（指數沒有參考價）時沒有漲跌', () => {
        expect(readoutChange(stk, 1080, 0)).toBeNull();
        expect(readoutChange(stk, 1080, NaN)).toBeNull();
        const r = chartReadout([bar('2026-11-05T09:01:00', 1080)], 0, { mode: 'line', daily: false, contract: stk, reference: 0, source: 'tap' });
        expect(r).toMatchObject({ time: '09:01', price: '1,080', change: null, dir: 'flat', ariaLabel: '09:01，價格 1,080' });
    });

    it('走勢以參考價為基準；K 線以前一根收盤、標「較前一根」，第一根沒有漲跌', () => {
        const bars = [bar('2026-11-05T09:01:00', 1075), bar('2026-11-05T13:25:00', 1080)];
        expect(chartReadout(bars, 1, { mode: 'line', daily: false, contract: stk, reference: 1070, source: 'track' })).toMatchObject({
            source: 'track', time: '13:25', priceLabel: '', price: '1,080', dir: 'up', change: { label: '', text: '▲10', pct: '+0.93%' },
        });
        expect(chartReadout(bars, 1, { mode: 'kbar', daily: false, contract: stk, reference: 1070, source: 'tap' })).toMatchObject({
            priceLabel: '收', change: { label: '較前一根', text: '▲5', pct: '+0.47%' },
            ariaLabel: '13:25，收盤 1,080，較前一根 上漲 5，幅度 +0.47%',
        });
        expect(chartReadout(bars, 0, { mode: 'kbar', daily: false, contract: stk, reference: 1070, source: 'tap' })!.change).toBeNull();
        expect(chartReadout(bars, 5, { mode: 'kbar', daily: false, contract: stk, reference: 1070, source: 'tap' })).toBeNull();
    });

    it('日 K 時間顯示 MM/DD', () => {
        expect(readoutTime(at('2026-11-04T00:00:00'), true)).toBe('11/04');
        expect(readoutTime(at('2026-11-04T08:45:00'), false)).toBe('08:45');
    });

    it('小 store：內容相同不通知，改變或清除才通知', () => {
        const s = createReadoutStore();
        const fn = vi.fn();
        const off = s.subscribe(fn);
        const r = chartReadout([bar('2026-11-05T09:01:00', 1080)], 0, { mode: 'line', daily: false, contract: stk, reference: 1070, source: 'tap' });
        s.set(r);
        s.set({ ...r! });
        expect(fn).toHaveBeenCalledTimes(1);
        s.set(null);
        s.set(null);
        expect(fn).toHaveBeenCalledTimes(2);
        off();
        s.set(r);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(s.get()).toBe(r);
    });
});

describe('指數不套股票跳動單位（固定兩位）', () => {
    const ind = { exchange: 'TSE', code: '001', security_type: 'IND', reference: 23333.33 } as ContractInfo;

    it('formatQuotePrice：指數同 fmtPrice(v, 2)，不吸附（23,456.78 不是 23,455）；其他商品同 formatToTick', () => {
        expect(formatQuotePrice(ind, 23456.78)).toBe('23,456.78');
        expect(formatQuotePrice(ind, 23456.78)).toBe(fmtPrice(23456.78, 2));
        expect(formatQuotePrice(ind, 123.4)).toBe('123.40');
        expect(formatQuotePrice(ind, 23456.78, { grouping: false })).toBe('23456.78');
        expect(formatQuotePrice(ind, NaN)).toBe('—');
        expect(formatQuotePrice(stk, 1083)).toBe('1,085');
    });

    it('資訊列：指數價格與漲跌兩位小數（+123.45 不是 ▲125）', () => {
        expect(readoutChange(ind, 23456.78, 23333.33)).toMatchObject({ dir: 'up', text: '▲123.45', abs: '123.45' });
        const r = chartReadout([bar('2026-11-05T09:01:00', 23456.78)], 0, { mode: 'line', daily: false, contract: ind, reference: 23333.33, source: 'tap' });
        expect(r).toMatchObject({ price: '23,456.78', change: { text: '▲123.45' } });
        expect(changeAbsText(ind, 23456.78, 123.45)).toBe('123.45');
    });
});

describe('changeAbsText：漲跌差額不吸附到現價級距', () => {
    it('參考 997 → 1000 是 3（不是 5）；99.9 → 100.5 是 0.6；499.5 → 501 是 1.5', () => {
        expect(changeAbsText(stk, 1000, 3)).toBe('3');
        expect(changeAbsText(stk, 100.5, 0.6)).toBe('0.6');
        expect(changeAbsText(stk, 501, 1.5)).toBe('1.5');
        expect(changeAbsText(stk, 997, -3)).toBe('3');
    });

    it('推不出正數參考價時回傳 null', () => {
        expect(changeAbsText(stk, 10, 10)).toBeNull();
        expect(changeAbsText(stk, 10, NaN)).toBeNull();
    });
});
