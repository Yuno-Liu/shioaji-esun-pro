// 殼層 v2（設計規格 §6.6、§6.4、§7.1）：
// - 結構：statusWrap／mainWrap（main＋topSlot）／bottomStack（配件槽＋分頁列）／#sj-sheet-root；data-sheet-open 跟隨面板堆疊。
// - 背景隔離：只有面板真的 portal 到 #sj-sheet-root（殼層節點為真實 DOM）時，面板開啟才對狀態列、內容、底部 chrome
//   設 inert＋aria-hidden；原地渲染（測試、無 DOM）時不設。
// - 配件槽高度以 ResizeObserver 寫入 --sj-accessory-h。
// - TabBar：未成交徽章 >99 顯示 99+；needsReconcile 時委託分頁有 amber 點且 aria-label 補「，待對帳」（§10 S8）；
//   再點目前分頁 preventDefault 並捲回頂端（減少動態時不平滑），點其他分頁照常切換。
// - 切換分頁：新分頁模組載入中（Suspense fallback）時，舊頁 portal 到配件槽／上方插槽的內容必須已卸載；
//   同一分頁內換商品不重掛頁面。
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    tradeMounts: 0,
    /** 帳戶頁模組永遠載入中：用來觀察 Suspense fallback 期間的殼層插槽 */
    accountGate: new Promise<never>(() => undefined),
    trading: { trades: [] as { remaining: number }[], queries: { orders: { needsReconcile: false } } } as {
        trades: { remaining: number }[];
        queries?: { orders: { needsReconcile: boolean } };
    },
}));

vi.mock('../lib/stream', () => ({ ensureStream: () => undefined }));
vi.mock('../lib/trading-state', () => ({ useTradingState: () => m.trading }));
vi.mock('../lib/working-order-quantity', () => ({ remainingWorkingOrderQuantity: (t: { remaining: number }) => t.remaining }));
vi.mock('./components/status-bar', () => ({ StatusBar: () => createElement('div', { 'data-testid': 'mock-status-bar' }) }));
vi.mock('./components/toast-host', () => ({ ToastHost: () => createElement('div', { 'data-testid': 'mock-toast-host' }) }));
vi.mock('./components/order-confirm-sheet', () => ({ OrderConfirmSheet: () => createElement('div', { 'data-testid': 'mock-confirm-sheet' }) }));
// 根層玉山環境切換面板（EnvSwitchOverlay）以標記節點呈現開啟狀態與可否關閉；其他面板不渲染
vi.mock('./components/bottom-sheet', async () => {
    const { createElement: h } = await import('react');
    return {
        BottomSheet: (p: { testId?: string; open: boolean; dismissible?: boolean; layer?: string; title?: string }) => (
            p.testId === 'env-switch-overlay' && p.open
                ? h('div', { 'data-testid': 'env-switch-overlay-open', 'data-dismissible': String(p.dismissible), 'data-layer': p.layer, 'data-title': p.title })
                : null
        ),
    };
});
vi.mock('./components/order-ticket-sheet', () => ({ OrderTicketSheet: () => null }));
vi.mock('./components/order-action-sheet', () => ({ OrderActionSheet: () => null }));
vi.mock('./routes/watchlist-page', () => ({
    WatchlistPage: () => createElement('p', { 'data-testid': 'watchlist-page' }),
    preloadWatchEditControls: async () => undefined,
}));
// 交易頁替身：與真頁相同，以 ShellSlot 把交易鍵列放到配件槽、精簡標頭放到上方插槽
vi.mock('./routes/trade-page', async () => {
    const { Fragment, useEffect } = await import('react');
    const { ShellSlot } = await import('./ui/shell-slots');
    return {
        TradePage: ({ code }: { code: string | null }) => {
            useEffect(() => { m.tradeMounts++; }, []);
            return createElement(Fragment, null,
                createElement('p', { 'data-testid': 'trade-page' }, code),
                createElement(ShellSlot, { slot: 'top', children: createElement('div', { 'data-testid': 'trade-compact-header' }) }),
                createElement(ShellSlot, {
                    slot: 'bottom',
                    children: createElement(Fragment, null,
                        createElement('button', { 'data-testid': 'trade-buy' }),
                        createElement('button', { 'data-testid': 'trade-sell' })),
                }));
        },
    };
});
vi.mock('./routes/orders-page', () => ({ OrdersPage: () => createElement('p', { 'data-testid': 'orders-page' }) }));
vi.mock('./routes/market-page', () => ({
    MarketPage: ({ segment }: { segment: string }) => createElement('p', { 'data-testid': 'market-page', 'data-segment': segment }),
}));
vi.mock('./routes/positions-page', () => ({ PositionsPage: () => null }));
vi.mock('./routes/account-page', async () => {
    await m.accountGate;
    return { AccountPage: () => null };
});
vi.mock('./hooks/use-risk-pnl-feed', () => ({ useRiskPnlFeed: () => undefined }));
vi.mock('./hooks/use-fill-sound', () => ({ useFillSound: () => undefined }));
vi.mock('./hooks/use-wake-lock', () => ({ useWakeLock: () => undefined }));
vi.mock('./lib/resume-gate-runtime', () => ({ startResumeGate: () => () => undefined }));
vi.mock('./lib/watchlist-context', () => ({ WatchlistProvider: ({ children }: { children?: unknown }) => children }));

import { MobileShell, tabAriaLabel } from './app';
import { registerSheet, resetSheetStackForTest } from './lib/sheet-stack';
import { getMobileUi, openOrderAction, openTicket, resetMobileUiForTest } from './lib/mobile-store';
import { resetTradingActivityForTest, setEnvSwitch } from './lib/trading-activity';
import { navigate } from './lib/hash-router';

/** 假的 DOM 元素：讓殼層把它當成真實節點（instanceof HTMLElement）而啟用 portal 與背景隔離 */
class FakeElement {
    /** portal 目標：react-dom createPortal 檢查 nodeType；react-test-renderer 把 portal 子節點放進 children */
    nodeType = 1;
    children: { props?: Record<string, unknown>; isHidden?: boolean }[] = [];
    style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    offsetHeight = 0;
    scrollTop = 0;
    scrollTo = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    constructor(public tag: string) {}
}

class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    observed: unknown[] = [];
    disconnect = vi.fn();
    constructor(public cb: () => void) { FakeResizeObserver.instances.push(this); }
    observe(el: unknown) { this.observed.push(el); }
}

let view: ReactTestRenderer | undefined;
let nodes: FakeElement[] = [];

const byTestId = (id: string) => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === id);
const one = (id: string) => byTestId(id)[0]!;
const hostParent = (n: ReactTestInstance): ReactTestInstance => {
    let p = n.parent;
    while (p && typeof p.type !== 'string') p = p.parent;
    return p!;
};
const wrapOf = (id: string) => hostParent(one(id));

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('location', { hash: '#/orders', pathname: '/mobile.html', search: '', reload: vi.fn() });
    resetMobileUiForTest();
    resetSheetStackForTest();
    m.trading = { trades: [], queries: { orders: { needsReconcile: false } } };
    m.tradeMounts = 0;
    nodes = [];
    FakeResizeObserver.instances = [];
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    resetSheetStackForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function openSheet() {
    let entry!: ReturnType<typeof registerSheet>;
    await act(async () => { entry = registerSheet({ layer: 'sheet', getPanel: () => null, isDismissible: () => true, requestClose: () => undefined }); });
    return entry;
}

async function mount(opts: { dom?: boolean } = {}) {
    const createNodeMock = opts.dom
        ? (el: { type: unknown }) => {
            const node = new FakeElement(String(el.type));
            nodes.push(node);
            return node;
        }
        : undefined;
    await act(async () => { view = create(createElement(MobileShell), createNodeMock ? { createNodeMock } : undefined); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

describe('殼層結構', () => {
    it('statusWrap／mainWrap（main＋topSlot）／bottomStack（配件槽＋分頁列）／#sj-sheet-root', async () => {
        await mount();
        const shell = one('mobile-shell');
        expect(shell.props['data-sheet-open']).toBe('false');
        expect(hostParent(wrapOf('mock-status-bar'))).toBe(shell);
        const main = view!.root.find(n => n.type === 'main');
        expect(main.findAll(n => n.props['data-testid'] === 'orders-page')).toHaveLength(1);
        expect(hostParent(main)).toBe(hostParent(one('shell-top-slot')));
        const bottom = one('shell-bottom-stack');
        expect(bottom.findAll(n => n.props['data-testid'] === 'shell-accessory-slot')).toHaveLength(1);
        expect(bottom.findAll(n => n.props['data-testid'] === 'mobile-tab-bar' && typeof n.type === 'string')).toHaveLength(1);
        const sheetRoot = view!.root.find(n => n.props.id === 'sj-sheet-root');
        expect(hostParent(sheetRoot)).toBe(shell);
    });

    it('原地渲染（沒有真實 DOM）：面板開啟只切換 data-sheet-open，不設 inert／aria-hidden', async () => {
        await mount();
        const entry = await openSheet();
        expect(one('mobile-shell').props['data-sheet-open']).toBe('true');
        for (const wrap of [wrapOf('mock-status-bar'), one('shell-bottom-stack')]) {
            expect(wrap.props.inert).toBeUndefined();
            expect(wrap.props['aria-hidden']).toBeUndefined();
        }
        await act(async () => entry.unregister());
        expect(one('mobile-shell').props['data-sheet-open']).toBe('false');
    });

    it('portal 生效（殼層節點為真實 DOM）：面板開啟時狀態列、內容、底部 chrome inert＋aria-hidden，關閉即解除', async () => {
        vi.stubGlobal('HTMLElement', FakeElement);
        await mount({ dom: true });
        const wraps = () => [wrapOf('mock-status-bar'), hostParent(view!.root.find(n => n.type === 'main')), one('shell-bottom-stack')];
        for (const wrap of wraps()) expect(wrap.props.inert).toBeUndefined();

        const entry = await openSheet();
        expect(one('mobile-shell').props['data-sheet-open']).toBe('true');
        for (const wrap of wraps()) {
            expect(wrap.props.inert).toBe(true);
            expect(wrap.props['aria-hidden']).toBe('true');
        }
        // 通知與面板根節點不在 inert 容器內
        expect(hostParent(one('mock-toast-host'))).toBe(one('mobile-shell'));
        expect(hostParent(view!.root.find(n => n.props.id === 'sj-sheet-root'))).toBe(one('mobile-shell'));

        await act(async () => entry.unregister());
        for (const wrap of wraps()) {
            expect(wrap.props.inert).toBeUndefined();
            expect(wrap.props['aria-hidden']).toBeUndefined();
        }
    });

    it('配件槽高度以 ResizeObserver 寫入殼層 --sj-accessory-h', async () => {
        vi.stubGlobal('HTMLElement', FakeElement);
        vi.stubGlobal('ResizeObserver', FakeResizeObserver);
        await mount({ dom: true });
        const observer = FakeResizeObserver.instances[0]!;
        expect(observer.observed).toHaveLength(1);
        const accessory = observer.observed[0] as FakeElement;
        const shellNode = nodes.find(n => n.style.setProperty.mock.calls.length > 0)!;
        expect(shellNode.style.setProperty).toHaveBeenLastCalledWith('--sj-accessory-h', '0px');
        accessory.offsetHeight = 72;
        observer.cb();
        expect(shellNode.style.setProperty).toHaveBeenLastCalledWith('--sj-accessory-h', '72px');
        await act(async () => view!.unmount());
        view = undefined;
        expect(observer.disconnect).toHaveBeenCalled();
        expect(shellNode.style.removeProperty).toHaveBeenCalledWith('--sj-accessory-h');
    });
});

describe('TabBar', () => {
    it('tabAriaLabel：未成交筆數與待對帳', () => {
        expect(tabAriaLabel('委託', 0, false)).toBe('委託');
        expect(tabAriaLabel('委託', 3, false)).toBe('委託（未成交 3 筆）');
        expect(tabAriaLabel('委託', 3, true)).toBe('委託（未成交 3 筆），待對帳');
        expect(tabAriaLabel('委託', 0, true)).toBe('委託，待對帳');
    });

    it('未成交徽章 >99 顯示 99+；needsReconcile 時委託分頁有 amber 點與「待對帳」', async () => {
        m.trading = { trades: Array.from({ length: 120 }, () => ({ remaining: 1 })), queries: { orders: { needsReconcile: true } } };
        await mount();
        expect(one('tab-badge').children).toEqual(['99+']);
        expect(byTestId('tab-reconcile-dot')).toHaveLength(1);
        expect(one('tab-orders').props['aria-label']).toBe('委託（未成交 120 筆），待對帳');
        expect(one('tab-watchlist').props['aria-label']).toBe('自選');
    });

    it('沒有 queries（舊資料形狀）時不顯示待對帳點', async () => {
        m.trading = { trades: [] };
        await mount();
        expect(byTestId('tab-reconcile-dot')).toHaveLength(0);
        expect(byTestId('tab-badge')).toHaveLength(0);
    });

    it('目前分頁 aria-current=page；再點目前分頁 preventDefault 並平滑捲回頂端；點其他分頁不攔', async () => {
        await mount({ dom: true });
        const main = nodes.find(n => n.tag === 'main')!;
        expect(one('tab-orders').props['aria-current']).toBe('page');
        const again = { preventDefault: vi.fn() };
        await act(async () => { one('tab-orders').props.onClick(again); });
        expect(again.preventDefault).toHaveBeenCalledTimes(1);
        expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });

        const other = { preventDefault: vi.fn() };
        await act(async () => { one('tab-positions').props.onClick(other); });
        expect(other.preventDefault).not.toHaveBeenCalled();
    });

    it('6 個分頁依序：自選、交易、市場、委託、持倉、帳戶；分頁列欄數跟著分頁數', async () => {
        await mount();
        const tabs = one('mobile-tab-bar').findAll(n => typeof n.type === 'string' && n.type === 'a');
        expect(tabs.map(t => t.props['data-testid'])).toEqual(['tab-watchlist', 'tab-trade', 'tab-market', 'tab-orders', 'tab-positions', 'tab-account']);
        expect(tabs.map(t => t.props['aria-label'])).toEqual(['自選', '交易', '市場', '委託', '持倉', '帳戶']);
        expect(one('tab-market').props.href).toBe('#/market');
        expect(one('tab-trade').props.href).toBe('#/trade');
        // 欄數寫在 layout.css.ts 的 tabBar（不用 inline style）
        expect(one('mobile-tab-bar').props.style).toBeUndefined();
        const css = readFileSync(new URL('./styles/layout.css.ts', import.meta.url), 'utf8');
        const tabBarBlock = css.slice(css.indexOf('export const tabBar = style('), css.indexOf('export const tab = style('));
        expect(tabBarBlock).toContain("gridTemplateColumns: 'repeat(6, minmax(0, 1fr))'");
        expect(tabBarBlock).not.toContain('repeat(5');
    });

    it('舊書籤 #/sector：顯示市場頁（產業流向分段）、市場分頁 aria-current，hash 正規化為 #/market；再點市場分頁捲回頂端', async () => {
        (location as { hash: string }).hash = '#/sector';
        await mount({ dom: true });
        expect(byTestId('market-page')).toHaveLength(1);
        expect(one('market-page').props['data-segment']).toBe('flow');
        expect(location.hash).toBe('#/market');
        expect(one('tab-market').props['aria-current']).toBe('page');
        expect(one('tab-orders').props['aria-current']).toBeUndefined();
        expect(getMobileUi().activeTab).toBe('market');
        const main = nodes.find(n => n.tag === 'main')!;
        const again = { preventDefault: vi.fn() };
        await act(async () => { one('tab-market').props.onClick(again); });
        expect(again.preventDefault).toHaveBeenCalledTimes(1);
        expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    });

    it('深層連結 #/market/signals：市場頁的盤中異動分段；市場分頁的連結帶回本 session 上次的分段', async () => {
        const store = new Map<string, string>();
        vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
        (location as { hash: string }).hash = '#/market/signals';
        await mount();
        expect(one('market-page').props['data-segment']).toBe('signals');
        expect(location.hash).toBe('#/market/signals');
        expect(one('tab-market').props['aria-current']).toBe('page');
        // 分段記憶由市場頁寫入（這裡是替身、不寫）：沒有紀錄 → 產業流向；有紀錄 → 盤中異動
        expect(one('tab-market').props.href).toBe('#/market');
        store.set('sj-mobile-market-segment', 'signals');
        await act(async () => {
            (location as { hash: string }).hash = '#/orders';
            window.dispatchEvent(new Event('hashchange'));
        });
        expect(one('tab-market').props.href).toBe('#/market/signals');
    });

    it('sessionStorage 不可用時，市場分頁連結回到產業流向（不丟例外）', async () => {
        vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('denied'); } });
        await mount();
        expect(one('tab-market').props.href).toBe('#/market');
    });

    it('減少動態：再點目前分頁直接回頂（behavior auto）', async () => {
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduced-motion'), addEventListener: () => undefined, removeEventListener: () => undefined }));
        await mount({ dom: true });
        const main = nodes.find(n => n.tag === 'main')!;
        await act(async () => { one('tab-orders').props.onClick({ preventDefault: () => undefined }); });
        expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    });
});

describe('切換分頁：舊頁 portal 不殘留', () => {
    const goTo = async (hash: string) => {
        await act(async () => {
            (location as { hash: string }).hash = hash;
            window.dispatchEvent(new Event('hashchange'));
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    };
    /** 殼層插槽的 ref 節點（以 data-testid 對應 createNodeMock 產生的假節點） */
    const slotIds = new Map<FakeElement, string>();
    const slotNode = (testId: string) => [...slotIds].find(([, id]) => id === testId)![0];

    async function mountTrade() {
        slotIds.clear();
        vi.stubGlobal('HTMLElement', FakeElement);
        (location as { hash: string }).hash = '#/trade/2330';
        await act(async () => {
            view = create(createElement(MobileShell), {
                createNodeMock: (el: { type: unknown; props: unknown }) => {
                    const node = new FakeElement(String(el.type));
                    const id = (el.props as Record<string, unknown>)['data-testid'];
                    if (typeof id === 'string') slotIds.set(node, id);
                    nodes.push(node);
                    return node;
                },
            });
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    }
    const portaled = (testId: string) => slotNode(testId).children.map(c => c.props?.['data-testid']);

    it('交易頁 → 帳戶頁（模組載入中）：fallback 期間配件槽與上方插槽是空的', async () => {
        await mountTrade();
        // 前提：交易鍵列與精簡標頭確實 portal 到殼層插槽
        expect(portaled('shell-accessory-slot')).toEqual(['trade-buy', 'trade-sell']);
        expect(portaled('shell-top-slot')).toEqual(['trade-compact-header']);

        await goTo('#/account');
        expect(JSON.stringify(view!.toJSON())).toContain('載入中…');
        expect(slotNode('shell-accessory-slot').children).toEqual([]);
        expect(slotNode('shell-top-slot').children).toEqual([]);
    });

    it('同一分頁內換商品（#/trade/2330 → #/trade/2317）不重掛頁面', async () => {
        await mountTrade();
        expect(m.tradeMounts).toBe(1);
        await goTo('#/trade/2317');
        expect(byTestId('trade-page')[0]!.children).toEqual(['2317']);
        expect(m.tradeMounts).toBe(1);
        expect(portaled('shell-accessory-slot')).toEqual(['trade-buy', 'trade-sell']);
    });

    it('交易頁切換商品（navigate replace）：不新增歷史紀錄、目前商品跟著更新、頁面不重掛', async () => {
        const replaceState = vi.fn((_s: unknown, _t: string, url: string) => {
            (location as { hash: string }).hash = url.slice(url.indexOf('#'));
        });
        vi.stubGlobal('history', { state: null, replaceState });
        await mountTrade();
        expect(getMobileUi().currentCode).toBe('2330');
        await act(async () => { navigate({ name: 'trade', code: '2317' }, { replace: true }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(replaceState).toHaveBeenCalledWith(null, '', '/mobile.html#/trade/2317');
        expect(byTestId('trade-page')[0]!.children).toEqual(['2317']);
        expect(getMobileUi().currentCode).toBe('2317');
        expect(m.tradeMounts).toBe(1);
    });
});

describe('玉山環境切換中：根層面板（CRITICAL-1）', () => {
    const goTo = async (hash: string) => {
        await act(async () => {
            (location as { hash: string }).hash = hash;
            window.dispatchEvent(new Event('hashchange'));
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    };
    afterEach(() => { resetTradingActivityForTest(); });

    it('換頁（返回手勢、改 hash）不會移除面板；不可關閉；切換中不開下單與委託操作面板', async () => {
        (location as { hash: string }).hash = '#/account';
        await mount();
        expect(byTestId('env-switch-overlay-open')).toHaveLength(0);
        await act(async () => { setEnvSwitch({ target: 'PRODUCTION', phase: 'switching' }); });
        // 面板模組延遲載入（帳戶頁 chunk 已帶著它）：等 import 完成
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        await act(async () => { await vi.dynamicImportSettled(); });
        expect(byTestId('env-switch-overlay-open')).toHaveLength(1);
        expect(one('env-switch-overlay-open').props['data-dismissible']).toBe('false');
        expect(one('env-switch-overlay-open').props['data-layer']).toBe('confirm');
        for (const hash of ['#/orders', '#/positions', '#/watchlist', '#/trade/2330']) {
            await goTo(hash);
            expect(byTestId('env-switch-overlay-open')).toHaveLength(1);
        }
        openTicket({ code: '2330', action: 'Buy' });
        openOrderAction('T1', 'cancel');
        expect(getMobileUi().ticket).toBeNull();
        expect(getMobileUi().orderAction).toBeNull();
        // 回應逾時後的結果確認中：仍顯示、仍擋
        await act(async () => { setEnvSwitch({ target: 'PRODUCTION', phase: 'checking' }); });
        expect(one('env-switch-overlay-open').props['data-title']).toBe('環境切換結果確認中');
        openTicket({ code: '2330' });
        expect(getMobileUi().ticket).toBeNull();
        await act(async () => { setEnvSwitch(null); });
        expect(byTestId('env-switch-overlay-open')).toHaveLength(0);
        await act(async () => { openTicket({ code: '2330' }); });
        expect(getMobileUi().ticket).not.toBeNull();
    });
});
