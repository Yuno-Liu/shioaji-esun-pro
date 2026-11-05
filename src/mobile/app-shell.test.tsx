// 殼層 v2（設計規格 §6.6、§6.4、§7.1）：
// - 結構：statusWrap／mainWrap（main＋topSlot）／bottomStack（配件槽＋分頁列）／#sj-sheet-root；data-sheet-open 跟隨面板堆疊。
// - 背景隔離：只有面板真的 portal 到 #sj-sheet-root（殼層節點為真實 DOM）時，面板開啟才對狀態列、內容、底部 chrome
//   設 inert＋aria-hidden；原地渲染（測試、無 DOM）時不設。
// - 配件槽高度以 ResizeObserver 寫入 --sj-accessory-h。
// - TabBar：未成交徽章 >99 顯示 99+；needsReconcile 時委託分頁有 amber 點且 aria-label 補「，待對帳」（§10 S8）；
//   再點目前分頁 preventDefault 並捲回頂端（減少動態時不平滑），點其他分頁照常切換。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
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
vi.mock('./components/bottom-sheet', () => ({ BottomSheet: () => null }));
vi.mock('./components/order-ticket-sheet', () => ({ OrderTicketSheet: () => null }));
vi.mock('./components/order-action-sheet', () => ({ OrderActionSheet: () => null }));
vi.mock('./routes/watchlist-page', () => ({ WatchlistPage: () => createElement('p', { 'data-testid': 'watchlist-page' }) }));
vi.mock('./routes/trade-page', () => ({ TradePage: () => null }));
vi.mock('./routes/orders-page', () => ({ OrdersPage: () => createElement('p', { 'data-testid': 'orders-page' }) }));
vi.mock('./routes/positions-page', () => ({ PositionsPage: () => null }));
vi.mock('./routes/account-page', () => ({ AccountPage: () => null }));
vi.mock('./hooks/use-risk-pnl-feed', () => ({ useRiskPnlFeed: () => undefined }));
vi.mock('./hooks/use-fill-sound', () => ({ useFillSound: () => undefined }));
vi.mock('./hooks/use-wake-lock', () => ({ useWakeLock: () => undefined }));
vi.mock('./lib/resume-gate-runtime', () => ({ startResumeGate: () => () => undefined }));
vi.mock('./lib/watchlist-context', () => ({ WatchlistProvider: ({ children }: { children?: unknown }) => children }));

import { MobileShell, tabAriaLabel } from './app';
import { registerSheet, resetSheetStackForTest } from './lib/sheet-stack';
import { resetMobileUiForTest } from './lib/mobile-store';

/** 假的 DOM 元素：讓殼層把它當成真實節點（instanceof HTMLElement）而啟用 portal 與背景隔離 */
class FakeElement {
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

    it('減少動態：再點目前分頁直接回頂（behavior auto）', async () => {
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduced-motion'), addEventListener: () => undefined, removeEventListener: () => undefined }));
        await mount({ dom: true });
        const main = nodes.find(n => n.tag === 'main')!;
        await act(async () => { one('tab-orders').props.onClick({ preventDefault: () => undefined }); });
        expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    });
});
