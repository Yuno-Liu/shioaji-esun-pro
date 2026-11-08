// 「市場」分頁（routes/market-page.tsx）：
// - 標題「市場」＋分段［產業流向｜盤中異動］（tabs 語意）；沒有第三段。
// - 產業流向分段＝產業頁（帶入市場頁首）；切到盤中異動時產業頁卸載（其訂閱隨之釋放），盤中異動以 lazy chunk 載入。
// - 切換分段只 navigate(replace)；目前分段寫入 sessionStorage（例外不外拋）。
// - 盤中異動 chunk：掛載後閒置預載 1 次；省流量／慢速網路不預載。
// - S1：按遍頁首按鈕，openTicket／openOrderAction 0 次。
import { createElement, useEffect, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    navigate: vi.fn(),
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    sectorMounts: 0,
    sectorUnmounts: 0,
    schedule: vi.fn((_tasks: readonly (() => Promise<unknown>)[]) => () => undefined),
    constrained: false,
}));

vi.mock('./sector-page', () => ({
    SectorPage: ({ header }: { header?: ReactNode }) => {
        useEffect(() => {
            m.sectorMounts++;
            return () => { m.sectorUnmounts++; };
        }, []);
        return createElement('div', { 'data-testid': 'sector-page' }, header);
    },
}));
vi.mock('../components/market/market-signals', () => ({ MarketSignals: () => createElement('p', { 'data-testid': 'market-signals' }) }));
vi.mock('../lib/idle-prefetch', () => ({
    constrainedNetwork: () => m.constrained,
    currentConnection: () => undefined,
    schedulePrefetchSequence: m.schedule,
}));
vi.mock('../lib/hash-router', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), navigate: m.navigate }));
vi.mock('../lib/mobile-store', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    openTicket: m.openTicket,
    openOrderAction: m.openOrderAction,
}));

let view: ReactTestRenderer | undefined;
let session: Map<string, string>;

const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const byTestId = (id: string) => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === id);
const one = (id: string) => byTestId(id)[0]!;

async function flush() {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

async function render(segment: 'flow' | 'signals') {
    const { MarketPage } = await import('./market-page');
    await act(async () => {
        if (view) view.update(createElement(MarketPage, { segment }));
        else view = create(createElement(MarketPage, { segment }));
    });
    await flush();
}

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    session = new Map();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v); } });
    m.navigate.mockReset();
    m.openTicket.mockReset();
    m.openOrderAction.mockReset();
    m.sectorMounts = 0;
    m.sectorUnmounts = 0;
    m.schedule.mockClear();
    m.constrained = false;
});

afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('市場頁', () => {
    it('產業流向：產業頁帶入「市場」頁首與兩段分段（沒有第三段），記住分段', async () => {
        await render('flow');
        expect(byTestId('sector-page')).toHaveLength(1);
        const h1 = view!.root.findAll(n => n.type === 'h1');
        expect(h1.map(textOf)).toEqual(['市場']);
        const tabs = one('market-segment').findAll(n => n.type === 'button');
        expect(tabs.map(textOf)).toEqual(['產業流向', '盤中異動']);
        expect(one('market-segment').props.role).toBe('tablist');
        expect(one('market-seg-flow').props['aria-selected']).toBe(true);
        expect(session.get('sj-mobile-market-segment')).toBe('flow');
    });

    it('切換分段只 navigate(replace)；點目前分段不導覽', async () => {
        await render('flow');
        await act(async () => { one('market-seg-flow').props.onClick(); });
        expect(m.navigate).not.toHaveBeenCalled();
        await act(async () => { one('market-seg-signals').props.onClick(); });
        expect(m.navigate.mock.calls).toEqual([[{ name: 'market', segment: 'signals' }, { replace: true }]]);
    });

    it('盤中異動：產業頁卸載（釋放其訂閱）、載入盤中異動 chunk；回到產業流向時重新掛載產業頁', async () => {
        await render('flow');
        expect(m.sectorMounts).toBe(1);
        await render('signals');
        expect(m.sectorUnmounts).toBe(1);
        expect(byTestId('sector-page')).toHaveLength(0);
        expect(byTestId('market-signals')).toHaveLength(1);
        expect(one('market-seg-signals').props['aria-selected']).toBe(true);
        expect(view!.root.findAll(n => n.type === 'h1').map(textOf)).toEqual(['市場']);
        expect(session.get('sj-mobile-market-segment')).toBe('signals');
        await render('flow');
        expect(m.sectorMounts).toBe(2);
        expect(byTestId('market-signals')).toHaveLength(0);
    });

    it('盤中異動 chunk 在市場頁掛載後預載（不必切到該分段）；省流量時不預載', async () => {
        await render('flow');
        expect(m.schedule).toHaveBeenCalledTimes(1);
        const tasks = m.schedule.mock.calls[0]![0];
        expect(tasks).toHaveLength(1);
        await expect(tasks[0]!()).resolves.toBeUndefined();
        expect(byTestId('market-signals')).toHaveLength(0);
        // 切換分段不再排一次
        await render('signals');
        expect(m.schedule).toHaveBeenCalledTimes(1);

        await act(async () => view?.unmount());
        view = undefined;
        m.constrained = true;
        await render('flow');
        expect(m.schedule).toHaveBeenCalledTimes(1);
    });

    it('sessionStorage 不可用：照常顯示', async () => {
        vi.stubGlobal('sessionStorage', { setItem: () => { throw new Error('denied'); } });
        await render('signals');
        expect(byTestId('market-signals')).toHaveLength(1);
    });

    it('S1：按遍頁首按鈕，沒有任何下單入口', async () => {
        await render('signals');
        for (const b of view!.root.findAll(n => n.type === 'button')) {
            expect(textOf(b)).not.toMatch(/買進|賣出|下單|送出/);
            await act(async () => { b.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); });
        }
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        expect(m.navigate.mock.calls).toEqual([[{ name: 'market', segment: 'flow' }, { replace: true }]]);
    });
});

describe('切換分段的焦點', () => {
    async function mountWithNodes(segment: 'flow' | 'signals', focus: () => void, query: (sel: string) => unknown) {
        const { MarketPage } = await import('./market-page');
        const wrap = { contains: (node: unknown) => node === active, querySelector: (sel: string) => { query(sel); return { focus }; } };
        await act(async () => {
            view = create(createElement(MarketPage, { segment }), {
                createNodeMock: el => ((el.props as { children?: { props?: { testId?: string } } })?.children?.props?.testId === 'market-segment' ? wrap : {}),
            });
        });
        await flush();
    }
    const active = { tag: 'focused-segment' };

    it('焦點在分段上時切換：新頁首掛載後焦點移到新選取的分段', async () => {
        vi.stubGlobal('document', { activeElement: active });
        const focus = vi.fn();
        const query = vi.fn();
        await mountWithNodes('flow', focus, query);
        await act(async () => { one('market-seg-signals').props.onClick(); });
        expect(m.navigate).toHaveBeenCalledWith({ name: 'market', segment: 'signals' }, { replace: true });
        const { MarketPage } = await import('./market-page');
        await act(async () => { view!.update(createElement(MarketPage, { segment: 'signals' })); });
        await flush();
        expect(query).toHaveBeenCalledWith('[data-testid="market-seg-signals"]');
        expect(focus).toHaveBeenCalledTimes(1);
    });

    it('焦點不在分段上（例如觸控點擊沒有聚焦）：不搶焦點', async () => {
        vi.stubGlobal('document', { activeElement: { tag: 'body' } });
        const focus = vi.fn();
        await mountWithNodes('flow', focus, () => undefined);
        await act(async () => { one('market-seg-signals').props.onClick(); });
        const { MarketPage } = await import('./market-page');
        await act(async () => { view!.update(createElement(MarketPage, { segment: 'signals' })); });
        await flush();
        expect(focus).not.toHaveBeenCalled();
    });
});
