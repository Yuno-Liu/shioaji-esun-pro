// 交易頁當沖資訊列的純函式（lib/trade-info）：漲跌停狀態（鎖／未鎖／接近）、振幅小條、量比、當沖與處置膠囊；
// 期權與指數只顯示適用的項目（不顯示當沖、量比、處置等股票專屬項目）。
import { describe, expect, it } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import {
    dayTradeChip,
    infoChips,
    limitChip,
    limitKind,
    limitNeedsBook,
    punishChip,
    rangeChip,
    rangeInfo,
    rangePositionText,
    ratioChip,
    showsCredit,
    volumeRatio,
} from './trade-info';

const stock = {
    exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 1070, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0,
} as ContractInfo;
const fut = { ...stock, code: 'TXFL6', exchange: 'TAIFEX', security_type: 'FUT', underlying_kind: 'I', limit_up: 24640, limit_down: 20160, reference: 22400, day_trade: '' } as ContractInfo;
const opt = { ...stock, code: 'TXO22400L6', exchange: 'TAIFEX', security_type: 'OPT', limit_up: 2500, limit_down: 0.1, reference: 260, day_trade: '' } as ContractInfo;
const ind = { ...stock, code: '001', exchange: 'TSE', security_type: 'IND', limit_up: 0, limit_down: 0, reference: 22000, day_trade: '' } as ContractInfo;
const wrt = { ...stock, code: '030392', security_type: 'WRT', limit_up: 0, limit_down: 0, reference: 1.5, day_trade: '' } as ContractInfo;
const oes = { ...stock, code: '6999', exchange: 'OES' } as ContractInfo;

describe('漲跌停狀態', () => {
    it('在漲停：沒有五檔→「漲停」；委買在漲停且委賣已空→「鎖漲停」；委賣仍有掛單→「漲停未鎖」', () => {
        expect(limitKind(stock, 1175, true)).toBe('up');
        expect(limitNeedsBook('up')).toBe(true);
        expect(limitKind(stock, 1175, true, { bid_price: ['1175', '1170'], bid_volume: [520, 30], ask_price: [], ask_volume: [] })).toBe('lockedUp');
        expect(limitKind(stock, 1175, true, { bid_price: ['1175'], bid_volume: [520], ask_price: ['0', '0'], ask_volume: [0, 0] })).toBe('lockedUp');
        expect(limitKind(stock, 1175, true, { bid_price: ['1170'], bid_volume: [10], ask_price: ['1175'], ask_volume: [3] })).toBe('openUp');
        // 五檔兩側都空（盤前、收盤後）→ 無法判斷
        expect(limitKind(stock, 1175, true, { bid_price: [], bid_volume: [], ask_price: [], ask_volume: [] })).toBe('up');
        expect(limitChip('lockedUp')).toEqual({ key: 'limit', text: '鎖漲停', tone: 'up' });
        expect(limitChip('openUp')).toEqual({ key: 'limit', text: '漲停未鎖', tone: 'up' });
        expect(limitChip('up')).toEqual({ key: 'limit', text: '漲停', tone: 'up' });
    });

    it('在跌停：委賣在跌停且委買已空→「鎖跌停」；委買仍有→「跌停未鎖」', () => {
        expect(limitKind(stock, 963, true)).toBe('down');
        expect(limitKind(stock, 963, true, { bid_price: [], bid_volume: [], ask_price: ['963'], ask_volume: [800] })).toBe('lockedDown');
        expect(limitKind(stock, 963, true, { bid_price: ['963'], bid_volume: [5], ask_price: ['964'], ask_volume: [1] })).toBe('openDown');
        expect(limitChip('lockedDown')).toEqual({ key: 'limit', text: '鎖跌停', tone: 'down' });
    });

    it('接近：距停板 ≤ 1%（以參考價計）→「接近漲停」「接近跌停」（不需要五檔）；更遠不顯示', () => {
        expect(limitKind(stock, 1165, true)).toBe('nearUp'); // (1175−1165)÷1070 = 0.93%
        expect(limitKind(stock, 1160, true)).toBeNull(); // 1.40%
        expect(limitKind(stock, 970, true)).toBe('nearDown'); // 0.65%
        expect(limitKind(stock, 1085, true)).toBeNull();
        expect(limitNeedsBook('nearUp')).toBe(false);
        expect(limitChip('nearUp')).toEqual({ key: 'limit', text: '接近漲停', tone: 'warn' });
        expect(limitChip('nearDown')).toEqual({ key: 'limit', text: '接近跌停', tone: 'warn' });
        expect(limitChip(null)).toBeNull();
    });

    it('只看成交或快照價（參考價不判斷）；沒有漲跌停的商品（指數、興櫃、權證 0／0）不顯示', () => {
        expect(limitKind(stock, 1175, false)).toBeNull();
        expect(limitKind(stock, null, true)).toBeNull();
        expect(limitKind(ind, 22000, true)).toBeNull();
        expect(limitKind(oes, 1175, true)).toBeNull();
        expect(limitKind(wrt, 1.5, true)).toBeNull();
        // 期貨照樣判斷
        expect(limitKind(fut, 24640, true)).toBe('up');
        expect(limitKind(fut, 24500, true)).toBe('nearUp');
    });
});

describe('日內振幅位置', () => {
    const v = { reference: 1070, open: 1065, high: 1090, low: 1060, close: 1085 };

    it('股票：以參考價為中心的尺（lib/day-range railScale），振幅＝（高−低）÷參考價', () => {
        const r = rangeInfo(stock, v)!;
        expect(r.amplitudePct).toBeCloseTo((30 / 1070) * 100, 10);
        expect(rangeChip(r)).toEqual({ key: 'range', text: '振幅 2.80%', tone: 'neutral' });
        expect(r.bar.mode).toBe('rail');
        expect(r.bar.reference).toBe(0.5);
        expect(r.bar.ends).toEqual([3, 3]); // 最大偏離 1.87% → ±3% 的尺
        expect(r.bar.close).toBeCloseTo(0.5 + 0.5 * ((15 / 1070) * 100) / 3, 10);
        expect(r.bar.low).toBeLessThan(r.bar.close);
        expect(r.bar.high).toBeGreaterThan(r.bar.close);
        expect(r.bar.dir).toBe('up'); // 現價高於開盤
        expect(r.position).toBeCloseTo(25 / 30, 10);
        expect(rangePositionText(r)).toBe('現價位於今日最低到最高的 83%（接近今日最高）');
    });

    it('指數期用指數期的尺（±2.5% 起）', () => {
        const r = rangeInfo(fut, { reference: 22400, open: 22400, high: 22500, low: 22300, close: 22450 })!;
        expect(r.bar.mode).toBe('rail');
        expect(r.bar.ends).toEqual([2.5, 2.5]);
    });

    it('選擇權、指數、權證：整條是最低到最高（span），仍顯示振幅', () => {
        for (const c of [opt, ind, wrt]) {
            const r = rangeInfo(c, c === opt ? { reference: 260, open: 250, high: 300, low: 240, close: 270 } : c === ind ? { reference: 22000, open: 22010, high: 22200, low: 21900, close: 22100 } : { reference: 1.5, open: 1.5, high: 1.6, low: 1.4, close: 1.55 })!;
            expect(r.bar.mode).toBe('span');
            expect(r.bar.reference).toBeNull();
            expect(r.bar.low).toBe(0);
            expect(r.bar.high).toBe(1);
            expect(r.bar.close).toBeCloseTo(r.position!, 10);
        }
        expect(rangeChip(rangeInfo(ind, { reference: 22000, open: 22010, high: 22200, low: 21900, close: 22100 }))!.text).toBe('振幅 1.36%');
    });

    it('缺高低、參考價或現價時不顯示；高低相同時位置為 null', () => {
        expect(rangeInfo(stock, { ...v, high: null })).toBeNull();
        expect(rangeInfo(stock, { ...v, reference: null })).toBeNull();
        expect(rangeInfo(stock, { ...v, close: null })).toBeNull();
        expect(rangeChip(null)).toBeNull();
        const flat = rangeInfo(stock, { reference: 1070, open: 1070, high: 1070, low: 1070, close: 1070 })!;
        expect(flat.position).toBeNull();
        expect(flat.amplitudePct).toBe(0);
        expect(rangePositionText(flat)).toBe('今日最高與最低相同');
    });
});

describe('量比', () => {
    const snapshot = { datetime: '2026-11-06 09:30:00', yesterday_volume: 20000 };

    it('股票：今日累計量 ÷ 快照的前一交易日量', () => {
        const r = volumeRatio({ secType: 'STK', totalVolume: 23456, source: 'tick', tickDate: '2026/11/06', snapshot });
        expect(r).toBeCloseTo(1.1728, 4);
        expect(ratioChip(r)).toEqual({ key: 'ratio', text: '量比 1.17', tone: 'neutral' });
        expect(volumeRatio({ secType: 'STK', totalVolume: 10000, source: 'snapshot', snapshot })).toBe(0.5);
    });

    it('快照與成交不是同一交易日、缺昨日量、期權與指數 → 不顯示', () => {
        expect(volumeRatio({ secType: 'STK', totalVolume: 23456, source: 'tick', tickDate: '2026/11/09', snapshot })).toBeNull();
        expect(volumeRatio({ secType: 'STK', totalVolume: 23456, source: 'tick', tickDate: '2026/11/06', snapshot: { ...snapshot, yesterday_volume: 0 } })).toBeNull();
        expect(volumeRatio({ secType: 'STK', totalVolume: 23456, source: 'tick', tickDate: '2026/11/06' })).toBeNull();
        expect(volumeRatio({ secType: 'FUT', totalVolume: 80000, source: 'tick', tickDate: '2026/11/06', snapshot })).toBeNull();
        expect(volumeRatio({ secType: 'IND', totalVolume: 1, source: 'index', snapshot })).toBeNull();
        expect(ratioChip(null)).toBeNull();
    });
});

describe('當沖、處置與信用項目只給股票', () => {
    it('可當沖／先賣（STK）', () => {
        expect(dayTradeChip('STK', 'Yes')).toEqual({ key: 'daytrade', text: '可當沖・可先賣', tone: 'neutral' });
        expect(dayTradeChip('STK', 'OnlyBuy')).toEqual({ key: 'daytrade', text: '僅先買後賣', tone: 'warn' });
        expect(dayTradeChip('STK', 'No')).toEqual({ key: 'daytrade', text: '不可當沖', tone: 'warn' });
        expect(dayTradeChip('STK', '')).toBeNull();
    });

    it('期權、指數、權證：不顯示當沖、處置；showsCredit 為 false', () => {
        for (const st of ['FUT', 'OPT', 'IND', 'WRT'] as const) {
            expect(dayTradeChip(st, 'Yes')).toBeNull();
            expect(punishChip(st, true)).toBeNull();
            expect(showsCredit(st)).toBe(false);
        }
        expect(showsCredit('STK')).toBe(true);
        expect(punishChip('STK', true)).toEqual({ key: 'punish', text: '處置股', tone: 'danger' });
        expect(punishChip('STK', false)).toBeNull();
        expect(punishChip('STK', null)).toBeNull();
    });

    it('依序排列並略過不適用的項目', () => {
        const chips = infoChips(dayTradeChip('STK', 'Yes'), limitChip('nearUp'), null, ratioChip(1.2), punishChip('STK', true));
        expect(chips.map(c => c.key)).toEqual(['daytrade', 'limit', 'ratio', 'punish']);
    });

    it('每顆膠囊最長 7 個字（三檔字級、360 寬單顆不需截斷）', () => {
        const texts = [
            ...(['Yes', 'OnlyBuy', 'No'] as const).map(d => dayTradeChip('STK', d)!.text),
            ...(['lockedUp', 'up', 'openUp', 'nearUp', 'lockedDown', 'down', 'openDown', 'nearDown'] as const).map(k => limitChip(k)!.text),
            '振幅 10.00%', ratioChip(12.34)!.text, punishChip('STK', true)!.text,
        ];
        // 中日文一字＝1em、半形一字約 0.6em；footnote 0.75rem、字級 1.3、根 16px → 1em＝15.6px；左右內距與框 0.875rem
        const em = (s: string) => [...s].reduce((w, ch) => w + (/[ -~]/.test(ch) ? 0.6 : 1), 0);
        const widest = Math.max(...texts.map(em)) * 0.75 * 1.3 * 16 + (0.875 * 1.3 * 16);
        // 振幅膠囊另有 2.5rem 小條與 0.25rem 間距
        const rangeWidth = em('振幅 10.00%') * 0.75 * 1.3 * 16 + (2.75 + 0.875) * 1.3 * 16;
        const content = 360 - 32; // 標頭左右各 1rem（16px；padding 用 rem，字級大時更窄：以 1.3 計）
        const contentLarge = 360 - 2 * 16 * 1.3;
        expect(Math.max(widest, rangeWidth)).toBeLessThan(contentLarge);
        expect(contentLarge).toBeLessThan(content);
    });
});
