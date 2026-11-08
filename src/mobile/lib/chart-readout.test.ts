// 交易圖表價格資訊列（lib/chart-readout.ts）：漲跌差額不吸附跳動價位、正負號與 ▲▼、K 線較前一根、日 K 日期、小 store 去重
import { describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { Candle } from '../../lib/types/market';
import { chartReadout, createReadoutStore, readoutChange, readoutTime } from './chart-readout';

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
