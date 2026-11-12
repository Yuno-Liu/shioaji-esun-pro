// 自選與排行共用的商品列：testid 前綴、固定行情（排行）與即時行情（自選，只有可見列掛載探針）、
// 列尾下單鍵／佔位／自訂列尾、長按只在有 onLongPress 時、名次等前置小字與第二行附加資訊。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../motion/haptics', () => ({ haptic: vi.fn(() => false) }));

import * as wlStyles from '../styles/watchlist.css';
import { dayRangePosition, LONG_PRESS_MS, QuoteRow, rowQuoteView, type QuoteRowProps, type RowQuoteView } from './quote-row';

let view: ReactTestRenderer | undefined;
const base: QuoteRowProps = {
    testPrefix: 'ranking',
    code: '2330',
    name: '台積電',
    tag: '市',
    tradable: true,
    index: 0,
    tracker: { supported: false, observe: () => () => undefined, disconnect: () => undefined },
    metric: 'pct',
    spark: false,
    sparkContract: null,
    punished: false,
    staticView: { close: 1100, chg: 100, pct: 10, dir: 'up', simtrade: false, vol: 45678 },
    onOpen: vi.fn(),
};
async function render(over: Partial<QuoteRowProps> = {}) {
    await act(async () => { view = create(createElement('ul', null, createElement(QuoteRow, { ...base, ...over }))); });
}
const all = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('QuoteRow：漲停／跌停（§7.2）', () => {
    const limits = { reference: 1000, security_type: 'STK' as const, limit_up: 1100, limit_down: 900 };
    const priceBox = (p = 'ranking') => all(`${p}-price`)[0]!.parent!;

    it('成交價等於漲停：價格格改實心 up 底＋白字與「漲停」小標（limitPrice.up）、無障礙名稱含漲停', async () => {
        await render({ quoteContract: limits });
        expect(priceBox().props.className).toContain(wlStyles.limitPrice.up);
        expect(priceBox().props.className).not.toContain(wlStyles.tone.up);
        expect(all('ranking-row-button')[0]!.props['aria-label']).toBe('2330 台積電 上市，漲停 1,100，漲 ▲100.00 +10.00%，總量 4.6萬');
        // 第二行仍是漲跌色文字
        expect(all('ranking-change')[0]!.props.className).toContain(wlStyles.tone.up);
    });

    it('跌停：實心 down 底＋「跌停」；容差內的浮點值也算', async () => {
        await render({ quoteContract: limits, staticView: { close: 900.0000001, chg: -100, pct: -10, dir: 'down', simtrade: false } });
        expect(priceBox().props.className).toContain(wlStyles.limitPrice.down);
        expect(all('ranking-row-button')[0]!.props['aria-label']).toContain('，跌停 900，');
    });

    it('自選即時行情：快照收盤在漲停時標示，試撮價在漲停時不標示', async () => {
        await render({ testPrefix: 'watch', staticView: undefined, quoteContract: limits, snapshot: { close: 1100 } as never });
        expect(priceBox('watch').props.className).toContain(wlStyles.limitPrice.up);
        expect(all('watch-row-button')[0]!.props['aria-label']).toContain('，漲停 1,100，');
        await act(async () => view!.unmount());
        await render({ quoteContract: limits, staticView: { close: 1100, chg: 100, pct: 10, dir: 'up', simtrade: true } });
        expect(priceBox().props.className).not.toContain(wlStyles.limitPrice.up);
        expect(priceBox().props.className).toContain(wlStyles.tone.up);
        expect(all('ranking-row-button')[0]!.props['aria-label']).not.toContain('漲停');
    });

    it('沒有漲跌停（排行未解析合約、漲跌停 0）、指數、未到漲跌停：不標示', async () => {
        for (const quoteContract of [undefined, { reference: 0 }, { ...limits, limit_up: 0, limit_down: 0 }, { ...limits, security_type: 'IND' as const }]) {
            await render({ quoteContract });
            expect(priceBox().props.className).not.toContain(wlStyles.limitPrice.up);
            expect(priceBox().props.className).toContain(wlStyles.tone.up);
            await act(async () => view!.unmount());
        }
        await render({ quoteContract: limits, staticView: { close: 1095, chg: 95, pct: 9.5, dir: 'up', simtrade: false } });
        expect(priceBox().props.className).not.toContain(wlStyles.limitPrice.up);
    });
});

describe('QuoteRow', () => {
    it('testid 以前綴開頭；固定行情顯示價格與「漲跌 漲跌幅」並依漲跌著色', async () => {
        await render();
        expect(all('ranking-row')).toHaveLength(1);
        expect(textOf(all('ranking-price')[0]!)).toBe('1,100');
        expect(textOf(all('ranking-change')[0]!)).toBe('+100.00 +10.00%');
        expect(all('ranking-change')[0]!.props.className).toContain(wlStyles.tone.up);
        expect(textOf(all('ranking-market')[0]!)).toBe('市');
        expect(all('ranking-row-button')[0]!.props['aria-label']).toBe('2330 台積電 上市，1,100，漲 ▲100.00 +10.00%，總量 4.6萬');
    });

    it('前置小字（名次）在名稱前、附加資訊在第二行；無障礙名稱前後綴', async () => {
        await render({ lead: createElement('span', { 'data-testid': 'lead' }, '3'), metaExtra: createElement('span', { 'data-testid': 'extra' }, '量 4.6萬'), ariaPrefix: '第 3 名 ', ariaSuffix: '，附註' });
        const name = all('ranking-name')[0]!;
        expect(name.props.className).toBe(wlStyles.rowTitleFlex);
        expect(name.parent!.props.className).toBe(wlStyles.rowTitleLead);
        expect(textOf(name.parent!)).toBe('3台積電');
        expect(all('extra')[0]!.parent!.props.className).toBe(wlStyles.rowMeta);
        const label = all('ranking-row-button')[0]!.props['aria-label'] as string;
        expect(label.startsWith('第 3 名 2330 台積電')).toBe(true);
        expect(label.endsWith('，附註')).toBe(true);
    });

    it('列尾：可交易＋onTicket 時下單鍵（不在列按鈕內），否則同寬空白佔位；trailing 可整個取代', async () => {
        const onTicket = vi.fn();
        await render({ onTicket });
        expect(all('ranking-row-button')[0]!.findAll(n => n.props['data-testid'] === 'ranking-row-ticket')).toHaveLength(0);
        await act(async () => { all('ranking-row-ticket')[0]!.props.onClick(); });
        expect(onTicket).toHaveBeenCalledWith('2330');
        expect(base.onOpen).not.toHaveBeenCalled();
        await act(async () => view!.unmount());
        await render({ tradable: false, onTicket });
        expect(all('ranking-row-ticket')).toHaveLength(0);
        expect(all('ranking-row-ticket-spacer')).toHaveLength(1);
        await act(async () => view!.unmount());
        await render({ onTicket, trailing: createElement('span', { 'data-testid': 'custom' }) });
        expect(all('custom')).toHaveLength(1);
        expect(all('ranking-row-ticket')).toHaveLength(0);
    });

    it('沒有 onLongPress（排行）時長按不做事、點按照常開啟；有 onLongPress（自選）時長按不開啟', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const onOpen = vi.fn();
        await render({ onOpen });
        const press = async () => {
            const btn = all('ranking-row-button')[0]!;
            await act(async () => { btn.props.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 0, clientY: 0 }); });
            await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS); });
            await act(async () => { all('ranking-row-button')[0]!.props.onClick(); });
        };
        await press();
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(all('ranking-row-button')[0]!.props.onContextMenu).toBeUndefined();
        await act(async () => view!.unmount());
        const onLongPress = vi.fn();
        await render({ onOpen, onLongPress, testPrefix: 'watch' });
        const btn = all('watch-row-button')[0]!;
        await act(async () => { btn.props.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 0, clientY: 0 }); });
        await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS); });
        await act(async () => { all('watch-row-button')[0]!.props.onClick(); });
        expect(onLongPress).toHaveBeenCalledWith('2330');
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('即時行情：只有可見列掛載探針；沒有 IntersectionObserver 時前 20 列視為可見', async () => {
        const Probe = vi.fn(() => null);
        await render({ staticView: undefined, quoteContract: { reference: 1000, security_type: 'STK' }, probe: Probe, index: 0 });
        expect(Probe).toHaveBeenCalled();
        expect(all('ranking-row')[0]!.props['data-visible']).toBe('true');
        await act(async () => view!.unmount());
        Probe.mockClear();
        await render({ staticView: undefined, quoteContract: { reference: 1000, security_type: 'STK' }, probe: Probe, index: 25 });
        expect(Probe).not.toHaveBeenCalled();
    });

    it('走勢欄：沒有合約時是同尺寸空白佔位（na）；spark 關閉時不掛載', async () => {
        await render({ spark: true, sparkContract: null });
        expect(all('ranking-spark-blank')[0]!.props['data-spark']).toBe('na');
        expect(all('ranking-row-button')[0]!.props.className).toContain(wlStyles.rowWithSpark);
        await act(async () => view!.unmount());
        await render({ spark: false });
        expect(all('ranking-spark-blank')).toHaveLength(0);
        expect(all('ranking-row-button')[0]!.props.className).toContain(wlStyles.rowNoSpark);
    });
});

// ---- P1：日內區間小條（首屏：只用列已有的高低價，不發請求）----

describe('日內區間小條', () => {
    const view0: RowQuoteView = { close: 100, chg: 1, pct: 1, dir: 'up', simtrade: false, vol: 10, high: 104, low: 99 };

    it('rowQuoteView：高低價以即時 tick 優先（字串轉數字），其次指數、快照；無效值（0、非數字）為 undefined', () => {
        const snapshot = { high: 105, low: 98, close: 100, total_volume: 5, change_rate: 0 } as never;
        const tick = { close: '101', high: '103.5', low: '99', price_chg: '1', total_volume: 7, simtrade: false } as never;
        expect(rowQuoteView({ reference: 100 }, snapshot, { tick, index: undefined })).toMatchObject({ high: 103.5, low: 99 });
        const index = { close: '23000', reference: '22900', high: '23100', low: '22850' } as never;
        expect(rowQuoteView({ reference: 0, security_type: 'IND' }, undefined, { tick: undefined, index })).toMatchObject({ high: 23100, low: 22850 });
        expect(rowQuoteView({ reference: 100 }, snapshot, undefined)).toMatchObject({ high: 105, low: 98 });
        const bad = rowQuoteView({ reference: 100 }, { ...(snapshot as object), high: 0, low: Number.NaN } as never, undefined);
        expect(bad.high).toBeUndefined();
        expect(bad.low).toBeUndefined();
        expect(rowQuoteView({ reference: 100 }, undefined, undefined)).toMatchObject({ high: undefined, low: undefined });
    });

    it('dayRangePosition：0＝最低、1＝最高，超出夾住；缺資料、最高＝最低、試撮為 null', () => {
        expect(dayRangePosition(view0)).toBeCloseTo(0.2);
        expect(dayRangePosition({ ...view0, close: 99 })).toBe(0);
        expect(dayRangePosition({ ...view0, close: 104 })).toBe(1);
        expect(dayRangePosition({ ...view0, close: 110 })).toBe(1);
        expect(dayRangePosition({ ...view0, close: 90 })).toBe(0);
        expect(dayRangePosition({ ...view0, high: 100, low: 100 })).toBeNull();
        expect(dayRangePosition({ ...view0, high: undefined })).toBeNull();
        expect(dayRangePosition({ ...view0, low: undefined })).toBeNull();
        expect(dayRangePosition({ ...view0, close: undefined })).toBeNull();
        expect(dayRangePosition({ ...view0, simtrade: true })).toBeNull();
    });

    it('有高低價：價格欄內（絕對定位的裝飾，aria-hidden）以 --p 標記位置；無障礙名稱寫出最低、最高與位置', async () => {
        await render({ staticView: view0 });
        const bar = all('ranking-range');
        expect(bar).toHaveLength(1);
        expect(bar[0]!.props.className).toBe(wlStyles.dayRange);
        expect(bar[0]!.props['aria-hidden']).toBe('true');
        expect(bar[0]!.props.style).toEqual({ '--p': '20%' });
        // 在價格欄內（不新增 grid 欄、不佔名稱欄）；不是可點的元素
        expect(bar[0]!.parent!.props.className).toBe(wlStyles.priceCell);
        expect(bar[0]!.type).toBe('span');
        expect(bar[0]!.props.onClick).toBeUndefined();
        expect(all('ranking-row-button')[0]!.props['aria-label']).toBe(
            '2330 台積電 上市，100.00，漲 ▲1.00 +1.00%，總量 10，今日最低 99.00 最高 104.00，現價位於區間 20%',
        );
    });

    it('最高＝最低、缺資料、試撮：不顯示小條，無障礙名稱不提區間', async () => {
        for (const over of [{ high: 100, low: 100 }, { high: undefined, low: undefined }, { simtrade: true }]) {
            await render({ staticView: { ...view0, ...over } });
            expect(all('ranking-range'), JSON.stringify(over)).toHaveLength(0);
            expect(all('ranking-row-button')[0]!.props['aria-label']).not.toContain('今日最低');
            await act(async () => view!.unmount());
            view = undefined;
        }
    });

    it('S1：點列只開交易頁（onOpen），小條不攔點擊、不開下單面板', async () => {
        const onOpen = vi.fn();
        const onTicket = vi.fn();
        await render({ staticView: view0, onOpen, onTicket });
        await act(async () => { all('ranking-row-button')[0]!.props.onClick(); });
        expect(onOpen).toHaveBeenCalledWith('2330');
        expect(onTicket).not.toHaveBeenCalled();
    });
});

// ---- 2026-11-13 稽核：盤前／跨夜的參考價、只有快照的列、選擇權與興櫃的停板、試撮時的總量 ----

describe('rowQuoteView：報價自身的參考價（盤前／跨夜）', () => {
    // 昨日參考 100、收 110；今日合約參考已換成 110
    const today = { reference: 110, security_type: 'STK' as const };

    it('有 tick：漲跌幅分母用 現價 − price_chg（10/100＝10%，不是 10/110＝9.09%）', () => {
        const v = rowQuoteView(today, undefined, { tick: { close: '110', price_chg: '10', total_volume: 5 } as never });
        expect(v).toMatchObject({ close: 110, chg: 10, dir: 'up', ref: 100 });
        expect(v.pct).toBeCloseTo(10, 10);
    });

    it('只有快照：漲跌、漲跌幅用快照的 change_price／change_rate（與標頭、watch-sort 一致），不是 收盤 − 合約參考價＝0', () => {
        const v = rowQuoteView(today, { close: 110, change_price: 10, change_rate: 10, total_volume: 7 } as never, undefined);
        expect(v).toMatchObject({ close: 110, chg: 10, pct: 10, dir: 'up', ref: 100, vol: 7 });
    });

    it('快照沒有 change_price 時才退回合約參考價', () => {
        expect(rowQuoteView(today, { close: 121, change_rate: 0 } as never, undefined)).toMatchObject({ chg: 11, ref: 110 });
    });
});

describe('rowQuoteView：試撮時的總量', () => {
    const c = { reference: 1000, security_type: 'STK' as const };
    const sim = { close: '1050', price_chg: '50', simtrade: true, total_volume: 3 } as never;

    it('價格維持試撮價（徽章），總量改用上一筆真實成交的 total_volume', () => {
        const v = rowQuoteView(c, { close: 1000, change_price: 0, change_rate: 0, total_volume: 900 } as never, { tick: sim }, { close: '1010', price_chg: '10', total_volume: 12345 } as never);
        expect(v).toMatchObject({ close: 1050, simtrade: true, vol: 12345 });
    });

    it('試撮中且本列沒看過真實成交（盤前）：不顯示總量（盤前快照可能是前一交易日的量）；非試撮只有快照時照常用快照', () => {
        const v = rowQuoteView(c, { close: 1000, change_price: 0, change_rate: 0, total_volume: 900 } as never, { tick: sim });
        expect(v).toMatchObject({ close: 1050, simtrade: true });
        expect(v.vol).toBeUndefined();
        expect(rowQuoteView(c, undefined, { tick: sim }).vol).toBeUndefined();
        expect(rowQuoteView(c, { close: 1000, change_price: 0, change_rate: 0, total_volume: 900 } as never, {}).vol).toBe(900);
    });

    it('QuoteRow：先收到真實成交、再收到試撮 tick 時，第二行總量沿用真實成交', async () => {
        vi.useFakeTimers();
        let push: ((q: unknown) => void) | undefined;
        const Probe = ({ onQuote }: { onQuote: (q: never) => void }) => { push = onQuote as never; return null; };
        await render({ testPrefix: 'watch', staticView: undefined, quoteContract: c, probe: Probe as never, metric: 'vol' });
        await act(async () => { push!({ tick: { close: '1010', price_chg: '10', total_volume: 12345 } }); vi.advanceTimersByTime(200); });
        expect(textOf(all('watch-change')[0]!)).toBe('1.2萬');
        await act(async () => { push!({ tick: sim }); vi.advanceTimersByTime(200); });
        expect(all('watch-simtrade')).toHaveLength(1);
        expect(textOf(all('watch-price')[0]!)).toBe('1,050');
        expect(textOf(all('watch-change')[0]!)).toBe('1.2萬');
    });
});

describe('QuoteRow：選擇權與興櫃不標漲停／跌停', () => {
    const priceBox = () => all('ranking-price')[0]!.parent!;

    it('選擇權（跌停只是最小跳動的地板）、興櫃（沒有漲跌停）：價格等於停板價也不標示', async () => {
        const opt = { reference: 5, security_type: 'OPT' as const, exchange: 'TAIFEX' as const, limit_up: 1500, limit_down: 0.1 };
        await render({ quoteContract: opt, staticView: { close: 0.1, chg: -4.9, pct: -98, dir: 'down', simtrade: false } });
        expect(priceBox().props.className).not.toContain(wlStyles.limitPrice.down);
        expect(all('ranking-row-button')[0]!.props['aria-label']).not.toContain('跌停');
        await act(async () => view!.unmount());
        const oes = { reference: 1000, security_type: 'STK' as const, exchange: 'OES' as const, limit_up: 1100, limit_down: 900 };
        await render({ quoteContract: oes });
        expect(priceBox().props.className).not.toContain(wlStyles.limitPrice.up);
        expect(all('ranking-row-button')[0]!.props['aria-label']).not.toContain('漲停');
    });
});
