// 自選頁（規格 §6.1、§9.4）：只有可見列呼叫 useQuote；離開畫面卸載；每列重繪以 100 ms 節流；
// 點列開交易頁、長按開操作面板（移除、移動）；清單切換。
import { createElement, useSyncExternalStore } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
    const quotes = new Map<string, unknown>();
    const listeners = new Set<() => void>();
    return {
        quotes,
        listeners,
        emit: () => listeners.forEach(l => l()),
        useQuoteCalls: [] as { code: string | null; options: unknown }[],
        navigate: vi.fn(),
        removeSymbol: vi.fn(async () => undefined),
        reorderSymbol: vi.fn(),
        addSymbol: vi.fn(async () => undefined),
        setActiveList: vi.fn(),
        retryLoad: vi.fn(),
        searchProducts: vi.fn(async () => []),
        wl: {} as Record<string, unknown>,
    };
});

vi.mock('../../hooks/use-stream', () => ({
    useQuote: (code: string | null, options: unknown) => {
        m.useQuoteCalls.push({ code, options });
        return useSyncExternalStore(
            (l: () => void) => { m.listeners.add(l); return () => { m.listeners.delete(l); }; },
            () => (code ? m.quotes.get(code) : undefined),
        );
    },
}));
vi.mock('../../hooks/use-watchlist', () => ({ useWatchlist: () => m.wl }));
vi.mock('../../lib/product-search', () => ({ searchProducts: m.searchProducts }));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));

import { createVisibilityTracker, LONG_PRESS_MS, rowQuoteView, WATCH_REPAINT_MS, WatchlistPage, WatchQuoteProbe } from './watchlist-page';

// ---- 假的 IntersectionObserver：測試手動決定哪些元素可見 ----
type Entry = { target: object; isIntersecting: boolean };
class FakeIO {
    static instances: FakeIO[] = [];
    observed = new Set<object>();
    constructor(public cb: (entries: Entry[]) => void, public opts?: unknown) { FakeIO.instances.push(this); }
    observe(el: object) { this.observed.add(el); }
    unobserve(el: object) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
}
const nodes = new Map<string, object>();
function nodeMock(el: { type: unknown; props: unknown }) {
    const element = el as { type: unknown; props: Record<string, unknown> };
    if (element.type === 'li' && typeof element.props['data-code'] === 'string') {
        const code = element.props['data-code'] as string;
        const node = nodes.get(code) ?? { code };
        nodes.set(code, node);
        return node;
    }
    return {};
}
async function setVisible(code: string, visible: boolean) {
    const io = FakeIO.instances.at(-1)!;
    await act(async () => { io.cb([{ target: nodes.get(code)!, isIntersecting: visible }]); });
}

const contract = (code: string, name: string, reference: number) => ({ code, name, reference, security_type: 'STK', exchange: 'TSE', target_code: null });
const items = [
    { contract: contract('2330', '台積電', 1000) },
    { contract: contract('2317', '鴻海', 200) },
    { contract: contract('2454', '聯發科', 1200) },
];

let view: ReactTestRenderer | undefined;
async function render() {
    await act(async () => { view = create(createElement(WatchlistPage), { createNodeMock: nodeMock }); });
}
const quoteCodes = () => new Set(m.useQuoteCalls.map(c => c.code));
const probes = () => view!.root.findAll(n => n.type === WatchQuoteProbe).map(n => n.props.code as string);
const rowButton = (code: string): ReactTestInstance =>
    view!.root.find(n => n.type === 'li' && n.props['data-code'] === code).find(n => n.props['data-testid'] === 'watch-row-button');
const priceText = (code: string) =>
    view!.root.find(n => n.type === 'li' && n.props['data-code'] === code).find(n => n.props['data-testid'] === 'watch-price').props.children as string;
const tick = (close: string, chg: string) => ({ tick: { close, price_chg: chg }, index: undefined });

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('IntersectionObserver', FakeIO);
    FakeIO.instances = [];
    nodes.clear();
    m.quotes.clear();
    m.listeners.clear();
    m.useQuoteCalls.length = 0;
    m.navigate.mockClear();
    m.removeSymbol.mockClear();
    m.reorderSymbol.mockClear();
    m.setActiveList.mockClear();
    m.wl = {
        items,
        loading: false,
        structureBusy: false,
        loadError: false,
        retryLoad: m.retryLoad,
        addSymbol: m.addSymbol,
        removeSymbol: m.removeSymbol,
        reorderSymbol: m.reorderSymbol,
        serverLists: [{ id: 'a', name: '我的自選', contracts: [] }, { id: 'b', name: '期貨', contracts: [] }],
        activeListId: 'a',
        setActiveList: m.setActiveList,
    };
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('rowQuoteView', () => {
    it('uses tick price change and reference (never pct_chg)', () => {
        const v = rowQuoteView({ reference: 1000 }, undefined, { tick: { close: '1015', price_chg: '15', pct_chg: '150' } as never });
        expect(v).toMatchObject({ close: 1015, chg: 15, dir: 'up' });
        expect(v.pct).toBeCloseTo(1.5);
    });
    it('index quote derives change from its own reference', () => {
        const v = rowQuoteView({ reference: 0 }, undefined, { index: { close: '22000', reference: '22100' } as never });
        expect(v).toMatchObject({ close: 22000, chg: -100, dir: 'down' });
    });
    it('falls back to the snapshot close when no live quote', () => {
        const v = rowQuoteView({ reference: 200 }, { close: 200, change_rate: 0 } as never, undefined);
        expect(v).toMatchObject({ close: 200, chg: 0, dir: 'flat' });
    });
});

describe('createVisibilityTracker', () => {
    it('reports unsupported when IntersectionObserver is missing', () => {
        vi.stubGlobal('IntersectionObserver', undefined);
        expect(createVisibilityTracker().supported).toBe(false);
    });
});

describe('WatchlistPage visible-row subscription', () => {
    it('does not call useQuote for rows that are not visible', async () => {
        await render();
        expect(FakeIO.instances).toHaveLength(1);
        expect(FakeIO.instances[0]!.observed.size).toBe(3);
        expect(m.useQuoteCalls).toHaveLength(0);
        expect(probes()).toEqual([]);
    });

    it('subscribes only the visible rows, with narrow quotes', async () => {
        await render();
        await setVisible('2317', true);
        expect(probes()).toEqual(['2317']);
        expect(quoteCodes()).toEqual(new Set(['2317']));
        expect(m.useQuoteCalls.every(c => (c.options as { narrow?: boolean }).narrow === true)).toBe(true);
    });

    it('unmounts the quote probe when a row leaves the screen (release handled by quote-ownership grace)', async () => {
        await render();
        await setVisible('2330', true);
        await setVisible('2454', true);
        expect(probes().sort()).toEqual(['2330', '2454']);
        await setVisible('2330', false);
        expect(probes()).toEqual(['2454']);
        m.useQuoteCalls.length = 0;
        m.quotes.set('2330', tick('1010', '10'));
        m.quotes.set('2454', tick('1210', '10'));
        await act(async () => { m.emit(); });
        expect(quoteCodes()).toEqual(new Set(['2454']));
    });

    it('throttles row repaint to WATCH_REPAINT_MS', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await render();
        await setVisible('2330', true);
        m.quotes.set('2330', tick('1001', '1'));
        await act(async () => { m.emit(); });
        await act(async () => { vi.advanceTimersByTime(0); });
        expect(priceText('2330')).toBe('1,001');
        // 100 ms 內連續三筆：畫面不變，到期後只顯示最後一筆
        for (const [i, px] of ['1002', '1003', '1004'].entries()) {
            m.quotes.set('2330', tick(px, String(i + 2)));
            await act(async () => { m.emit(); });
            await act(async () => { vi.advanceTimersByTime(10); });
        }
        expect(priceText('2330')).toBe('1,001');
        await act(async () => { vi.advanceTimersByTime(WATCH_REPAINT_MS); });
        expect(priceText('2330')).toBe('1,004');
    });

    it('without IntersectionObserver only the first rows subscribe', async () => {
        vi.stubGlobal('IntersectionObserver', undefined);
        await render();
        expect(probes().sort()).toEqual(['2317', '2330', '2454']);
    });
});

describe('WatchlistPage interactions', () => {
    it('tapping a row opens the trade page', async () => {
        await render();
        await act(async () => { rowButton('2317').props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'trade', code: '2317' });
    });

    it('long press opens actions instead of navigating; remove needs a second tap', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await render();
        const btn = rowButton('2330');
        await act(async () => { btn.props.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 10, clientY: 10 }); });
        await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS); });
        await act(async () => { rowButton('2330').props.onPointerUp(); rowButton('2330').props.onClick(); });
        expect(m.navigate).not.toHaveBeenCalled();
        const remove = () => view!.root.find(n => n.props['data-testid'] === 'watch-remove');
        await act(async () => { remove().props.onClick(); });
        expect(m.removeSymbol).not.toHaveBeenCalled();
        await act(async () => { remove().props.onClick(); });
        expect(m.removeSymbol).toHaveBeenCalledWith('2330');
    });

    it('moving the finger cancels the long press', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await render();
        const btn = rowButton('2330');
        await act(async () => { btn.props.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 10, clientY: 10 }); });
        await act(async () => { rowButton('2330').props.onPointerMove({ pointerId: 1, clientX: 10, clientY: 40 }); });
        await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS * 2); });
        expect(view!.root.findAll(n => n.props['data-testid'] === 'watch-actions')).toHaveLength(0);
    });

    it('actions sheet moves a row down via reorderSymbol', async () => {
        await render();
        await act(async () => { view!.root.find(n => n.props['data-testid'] === 'watch-edit').props.onClick(); });
        const more = view!.root.findAll(n => n.props['data-testid'] === 'watch-more');
        await act(async () => { more[0]!.props.onClick(); });
        const down = view!.root.find(n => n.type === 'button' && n.props.children === '下移');
        await act(async () => { down.props.onClick(); });
        expect(m.reorderSymbol).toHaveBeenCalledWith('2330', '2317');
    });

    it('switching lists calls setActiveList', async () => {
        await render();
        const picker = view!.root.find(n => n.props['data-testid'] === 'watch-list-picker');
        await act(async () => { picker.props.onChange({ target: { value: 'b' } }); });
        expect(m.setActiveList).toHaveBeenCalledWith('b');
    });
});
