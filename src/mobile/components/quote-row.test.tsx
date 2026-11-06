// 自選與排行共用的商品列：testid 前綴、固定行情（排行）與即時行情（自選，只有可見列掛載探針）、
// 列尾下單鍵／佔位／自訂列尾、長按只在有 onLongPress 時、名次等前置小字與第二行附加資訊。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../motion/haptics', () => ({ haptic: vi.fn(() => false) }));

import * as wlStyles from '../styles/watchlist.css';
import { LONG_PRESS_MS, QuoteRow, type QuoteRowProps } from './quote-row';

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
