// src/mobile/app.tsx — 手機版根元件（規格 §4.2、§5）
//
// - 非 secure context：只顯示 SecureContextGate（不掛載任何會連線的元件或 hook）。
// - secure context：MobileShell —— 狀態列（捲動容器外、不透明）＋ hash 路由頁面（main 唯一捲動容器，內容從底部
//   chrome 下方捲過）＋底部 chrome（配件槽＋5 分頁，同一片 bar 材質），根層掛載 toast host、下單／委託操作／確認面板
//   host（portal 到 #sj-sheet-root）、風控損益餵送、ResumeGate、成交音效／震動（useFillSound）與螢幕常亮（useWakeLock）。
// - 殼層結構、插槽、捲動記憶、html 屬性與背景隔離見設計規格 §6.6；main 與其祖先不得有 transform／filter／
//   backdrop-filter／will-change／contain:paint（保護 fixed 全螢幕圖表）。

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Briefcase, ChartCandlestick, ClipboardList, Star, UserRound, type LucideIcon } from 'lucide-react';
import { useTradingState } from '../lib/trading-state';
import { ensureStream } from '../lib/stream';
import type { Trade } from '../lib/types/order';
import { remainingWorkingOrderQuantity } from '../lib/working-order-quantity';
import { OrderConfirmSheet } from './components/order-confirm-sheet';
import { ModuleErrorBoundary, ModuleLoadError, retryableLazy, SheetLoadError } from './components/route-error-boundary';
import { StatusBar } from './components/status-bar';
import { ToastHost } from './components/toast-host';
import { SecureContextGate } from './gate/secure-context-gate';
import { useFillSound } from './hooks/use-fill-sound';
import { useHtmlAttributes } from './hooks/use-html-attributes';
import { useRiskPnlFeed } from './hooks/use-risk-pnl-feed';
import { useWakeLock } from './hooks/use-wake-lock';
import { formatRoute, isCanonicalHash, navigate, parseHash, useHashRoute, type MobileRoute, type MobileTab } from './lib/hash-router';
import { closeOrderAction, closeTicket, setActiveTab, setCurrentCode, useMobileUi } from './lib/mobile-store';
import { startResumeGate } from './lib/resume-gate-runtime';
import { createScrollMemory, ScrollRestorer, useScrollNavigation, useScrollRecorder } from './lib/scroll-memory';
import type { SecureContextDiagnostics } from './lib/secure-context';
import { useSheetStack } from './lib/sheet-stack';
import { WatchlistProvider } from './lib/watchlist-context';
import { prefersReducedMotion } from './motion/prefs';
import { WatchlistPage } from './routes/watchlist-page';
import * as layout from './styles/layout.css';
import { SHELL_VAR } from './styles/tokens';
import { SheetRootContext } from './ui/sheet-context';
import { ShellSlotsContext, type ShellSlotTargets } from './ui/shell-slots';

// 首次載入只含殼層、預設分頁（自選）與確認面板（確認面板必須常駐，requestOrderConfirm 才會結束）。
// 其餘分頁與下單／委託操作面板在第一次用到時才載入，並在首屏完成後閒置時預先抓取（規格 §9.4：首次載入 JS ≤ 400 KB）。
const loadTradePage = () => import('./routes/trade-page');
const loadOrdersPage = () => import('./routes/orders-page');
const loadPositionsPage = () => import('./routes/positions-page');
const loadAccountPage = () => import('./routes/account-page');
const loadTicketSheet = () => import('./components/order-ticket-sheet');
const loadActionSheet = () => import('./components/order-action-sheet');

// retryableLazy：載入失敗後按［重試］會換一個新的 lazy 重新 import（React.lazy 會永久快取失敗的 promise）
const TradePage = retryableLazy(() => loadTradePage().then(m => m.TradePage), 'TradePage');
const OrdersPage = retryableLazy(() => loadOrdersPage().then(m => m.OrdersPage), 'OrdersPage');
const PositionsPage = retryableLazy(() => loadPositionsPage().then(m => m.PositionsPage), 'PositionsPage');
const AccountPage = retryableLazy(() => loadAccountPage().then(m => m.AccountPage), 'AccountPage');
const OrderTicketSheet = retryableLazy(() => loadTicketSheet().then(m => m.OrderTicketSheet), 'OrderTicketSheet');
const OrderActionSheet = retryableLazy(() => loadActionSheet().then(m => m.OrderActionSheet), 'OrderActionSheet');

const ROUTE_MODULES = [TradePage, OrdersPage, PositionsPage, AccountPage];
const resetRouteModules = () => { for (const page of ROUTE_MODULES) page.reset(); };
const resetTicketSheet = () => { OrderTicketSheet.reset(); };
const resetActionSheet = () => { OrderActionSheet.reset(); };

const PREFETCH_DELAY_MS = 1_500;

/**
 * 首屏完成後閒置時預先抓取其餘模組。失敗只吞掉、不重試：預先抓取不經過 lazy 元件，不會讓它們記住失敗；
 * 真正用到時 lazy 會自己 import，若仍失敗由 ModuleErrorBoundary 顯示「載入失敗」與［重試］（不會卸載整個 App）。
 */
function usePrefetchDeferredModules(): void {
    useEffect(() => {
        const run = () => {
            for (const load of [loadTicketSheet, loadTradePage, loadOrdersPage, loadPositionsPage, loadAccountPage, loadActionSheet]) {
                load().catch(() => undefined);
            }
        };
        const timer = setTimeout(() => {
            const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => unknown }).requestIdleCallback;
            if (typeof idle === 'function') idle(run);
            else run();
        }, PREFETCH_DELAY_MS);
        return () => clearTimeout(timer);
    }, []);
}

/** 第一次需要時才掛載（之後保持掛載，讓面板的開關動畫正常） */
function useMountedOnce(wanted: boolean): boolean {
    const [mounted, setMounted] = useState(wanted);
    useEffect(() => {
        if (wanted) setMounted(true);
    }, [wanted]);
    return mounted || wanted;
}

/**
 * 面板開啟時對背景設 inert＋aria-hidden（設計規格 §6.1「背景隔離」）。
 * 只在面板 portal 到 #sj-sheet-root 時生效（BottomSheet v2）；需要暫停時改為 false 即可回到不隔離。
 */
export const SHELL_INERT_ENABLED = true;

type ShellTargets = { sheetRoot: HTMLElement; top: HTMLElement; bottom: HTMLElement };

function isDomElement(el: unknown): el is HTMLElement {
    return typeof HTMLElement !== 'undefined' && el instanceof HTMLElement;
}

/**
 * 殼層節點掛上後才決定 portal 目標：三個節點都是真實 DOM → 元素；否則（react-test-renderer 等）→ 'inline'（原地渲染）。
 * 掛上之前為 null（面板與插槽該幀不渲染）；layout effect 在第一次繪製前完成，不會閃。
 */
function useShellTargets(
    sheetRoot: RefObject<HTMLElement | null>,
    top: RefObject<HTMLElement | null>,
    bottom: RefObject<HTMLElement | null>,
): ShellTargets | 'inline' | null {
    const [targets, setTargets] = useState<ShellTargets | 'inline' | null>(null);
    useLayoutEffect(() => {
        const s = sheetRoot.current;
        const t = top.current;
        const b = bottom.current;
        setTargets(isDomElement(s) && isDomElement(t) && isDomElement(b) ? { sheetRoot: s, top: t, bottom: b } : 'inline');
    }, [sheetRoot, top, bottom]);
    return targets;
}

/** 底部配件槽（交易鍵列）實際高度 → 殼層 --sj-accessory-h（main 底部內距、通知錨點會讓出）；沒有 ResizeObserver 時不做事 */
function useAccessoryHeight(accessory: HTMLElement | null, shell: RefObject<HTMLElement | null>): void {
    useLayoutEffect(() => {
        const host = shell.current;
        if (!accessory || !host || typeof ResizeObserver !== 'function') return undefined;
        let last = -1;
        const write = () => {
            const h = Math.max(0, Math.round(accessory.offsetHeight || 0));
            if (h === last) return;
            last = h;
            host.style.setProperty(SHELL_VAR.accessoryH, `${h}px`);
        };
        write();
        const observer = new ResizeObserver(write);
        observer.observe(accessory);
        return () => {
            observer.disconnect();
            host.style.removeProperty(SHELL_VAR.accessoryH);
        };
    }, [accessory, shell]);
}

function RouteFallback() {
    return <p className={layout.routeLoading} role='status'>載入中…</p>;
}

const TAB_META: Record<MobileTab, { label: string; icon: LucideIcon }> = {
    watchlist: { label: '自選', icon: Star },
    trade: { label: '交易', icon: ChartCandlestick },
    orders: { label: '委託', icon: ClipboardList },
    positions: { label: '持倉', icon: Briefcase },
    account: { label: '帳戶', icon: UserRound },
};

const TAB_ORDER: readonly MobileTab[] = ['watchlist', 'trade', 'orders', 'positions', 'account'];

/** 未成交筆數（委託分頁徽章）：狀態屬 ACTIVE_ORDER_STATUSES 且剩餘量 > 0 */
export function countWorkingOrders(trades: readonly Trade[]): number {
    return trades.reduce((n, t) => n + (remainingWorkingOrderQuantity(t) > 0 ? 1 : 0), 0);
}

/** 分頁的無障礙名稱：未成交筆數與待對帳（「結果未知」的長效提示就地化在委託分頁，設計規格 §6.4） */
export function tabAriaLabel(label: string, badge: number, reconcile: boolean): string {
    const base = badge > 0 ? `${label}（未成交 ${badge} 筆）` : label;
    return reconcile ? `${base}，待對帳` : base;
}

/** 再點目前分頁：捲回頂端（減少動態時不平滑） */
function scrollToTop(target: HTMLElement | null): void {
    if (!target) return;
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
    try {
        if (typeof target.scrollTo === 'function') target.scrollTo({ top: 0, behavior });
        else target.scrollTop = 0;
    } catch {
        target.scrollTop = 0;
    }
}

function TabBar({ active, currentCode, onReselect }: { active: MobileTab; currentCode: string | null; onReselect: () => void }) {
    const trading = useTradingState();
    const working = countWorkingOrders(trading.trades);
    // queries 可能尚未提供（測試替身）：當作不需對帳
    const reconcilePending = !!trading.queries?.orders?.needsReconcile;
    return (
        <nav className={layout.tabBar} aria-label='主要分頁' data-testid='mobile-tab-bar'>
            {TAB_ORDER.map(tab => {
                const { label, icon: Icon } = TAB_META[tab];
                const route: MobileRoute = tab === 'trade' ? { name: 'trade', code: currentCode } : { name: tab };
                const badge = tab === 'orders' && working > 0 ? working : 0;
                const reconcile = tab === 'orders' && reconcilePending;
                const current = active === tab;
                return (
                    <a
                        key={tab}
                        href={formatRoute(route)}
                        className={layout.tab}
                        aria-current={current ? 'page' : undefined}
                        aria-label={tabAriaLabel(label, badge, reconcile)}
                        data-testid={`tab-${tab}`}
                        onClick={e => {
                            // 點擊立即切換（瀏覽器改 hash）、無轉場；再點目前分頁則捲回頂端
                            if (!current) return;
                            e.preventDefault();
                            onReselect();
                        }}
                    >
                        <span className={layout.tabIcon}>
                            <Icon size={24} strokeWidth={current ? 2.25 : 1.75} aria-hidden='true' focusable='false' />
                            {badge > 0 && <span className={layout.tabBadge} aria-hidden='true' data-testid='tab-badge'>{badge > 99 ? '99+' : badge}</span>}
                            {reconcile && <span className={layout.tabDot[badge > 0 ? 'withBadge' : 'alone']} aria-hidden='true' data-testid='tab-reconcile-dot' />}
                        </span>
                        <span>{label}</span>
                    </a>
                );
            })}
        </nav>
    );
}

function RoutePage({ route }: { route: MobileRoute }) {
    switch (route.name) {
        case 'watchlist': return <WatchlistPage />;
        case 'trade': return <TradePage code={route.code} />;
        case 'orders': return <OrdersPage />;
        case 'positions': return <PositionsPage />;
        case 'account': return <AccountPage />;
    }
}

/** secure context 才掛載：所有會連線的 hook 都在這裡以下 */
export function MobileShell() {
    // 與桌面 src/App.tsx 相同：根層確保行情串流已開（ensureStream 冪等；bootstrap 的交易狀態也會開）
    useEffect(ensureStream, []);
    useEffect(() => startResumeGate(), []);
    useRiskPnlFeed();
    useFillSound();
    useWakeLock();
    usePrefetchDeferredModules();

    useHtmlAttributes();

    const route = useHashRoute();
    const routeKey = formatRoute(route);
    const ui = useMobileUi();
    const ticketMounted = useMountedOnce(ui.ticket !== null);
    const actionMounted = useMountedOnce(ui.orderAction !== null);

    // ---- 殼層節點：面板 portal 目標、上方插槽、底部配件槽 ----
    const shellRef = useRef<HTMLDivElement | null>(null);
    const mainRef = useRef<HTMLElement | null>(null);
    const sheetRootRef = useRef<HTMLDivElement | null>(null);
    const topSlotRef = useRef<HTMLDivElement | null>(null);
    const accessoryRef = useRef<HTMLDivElement | null>(null);
    const targets = useShellTargets(sheetRootRef, topSlotRef, accessoryRef);
    const portalActive = targets !== null && targets !== 'inline';
    const sheetRootValue: HTMLElement | null | 'inline' = targets === null ? null : targets === 'inline' ? 'inline' : targets.sheetRoot;
    const slotsValue = useMemo<ShellSlotTargets | 'inline'>(
        () => (targets === null ? { top: null, bottom: null } : targets === 'inline' ? 'inline' : { top: targets.top, bottom: targets.bottom }),
        [targets],
    );
    useAccessoryHeight(portalActive ? targets.bottom : null, shellRef);

    // ---- 面板開啟：底部 chrome 改實心；背景（狀態列、內容、底部 chrome）inert＋aria-hidden ----
    // 只在面板真的 portal 到 #sj-sheet-root 時才隔離，避免把仍原地渲染的面板一起設為 inert。
    const sheetOpen = useSheetStack().depth > 0;
    const isolate = SHELL_INERT_ENABLED && portalActive && sheetOpen;
    const background = isolate ? ({ inert: true, 'aria-hidden': 'true' } as const) : {};

    // ---- 捲動記憶與再點分頁回頂 ----
    const [scrollMemory] = useState(createScrollMemory);
    const getMain = useCallback(() => mainRef.current, []);
    useScrollNavigation(scrollMemory, routeKey);
    useScrollRecorder(getMain, scrollMemory);
    const onReselect = useCallback(() => scrollToTop(mainRef.current), []);

    // 正規化 hash（空白或無法辨識 → #/watchlist），不新增歷史紀錄
    useEffect(() => {
        if (typeof location !== 'undefined' && !isCanonicalHash(location.hash)) navigate(parseHash(location.hash), { replace: true });
    }, [routeKey]);

    // 路由 → UI 狀態；#/trade 沒有代碼時帶回上次的商品
    useEffect(() => {
        const r = parseHash(routeKey);
        setActiveTab(r.name);
        if (r.name !== 'trade') return;
        if (r.code) setCurrentCode(r.code);
        else if (ui.currentCode) navigate({ name: 'trade', code: ui.currentCode }, { replace: true });
    }, [routeKey, ui.currentCode]);

    // 自選清單狀態常駐在殼層：切換分頁回「自選」不重新讀取清單、合約與快照（lib/watchlist-context.tsx）
    return (
        <WatchlistProvider>
            <SheetRootContext.Provider value={sheetRootValue}>
                <ShellSlotsContext.Provider value={slotsValue}>
                    <div ref={shellRef} className={layout.shell} data-testid='mobile-shell' data-sheet-open={sheetOpen ? 'true' : 'false'}>
                        <div className={layout.statusWrap} {...background}>
                            <StatusBar />
                        </div>
                        <div className={layout.mainWrap} {...background}>
                            <main ref={mainRef} className={layout.main}>
                                {/* 錯誤邊界只包延遲載入的區塊：狀態列、分頁列、toast、確認面板在邊界之外，模組載入失敗也不會被卸載 */}
                                <ModuleErrorBoundary
                                    resetKey={route.name}
                                    onRetry={resetRouteModules}
                                    fallback={props => <ModuleLoadError {...props} testId='route-load-error' />}
                                >
                                    {/* key＝分頁名：切換分頁時卸載舊頁樹。否則新分頁模組載入中（suspend）時 React 會把舊頁以隱藏的
                                        Offscreen 保留，而隱藏不及於 portal——舊交易頁 ShellSlot 出去的交易鍵列與精簡標頭會留在底部 chrome
                                        與上方插槽、仍可點擊。同一分頁內換商品（#/trade/2330 → #/trade/2317）分頁名不變，不重掛。 */}
                                    <Suspense key={route.name} fallback={<RouteFallback />}>
                                        <RoutePage route={route} />
                                        {/* 頁面提交後才還原捲動位置（Suspense 顯示 fallback 期間不記錄、不還原） */}
                                        <ScrollRestorer routeKey={routeKey} memory={scrollMemory} getTarget={getMain} />
                                    </Suspense>
                                </ModuleErrorBoundary>
                            </main>
                            <div ref={topSlotRef} className={layout.topSlot} data-testid='shell-top-slot' />
                        </div>
                        <div className={layout.bottomStack} data-testid='shell-bottom-stack' {...background}>
                            <div ref={accessoryRef} className={layout.accessorySlot} data-testid='shell-accessory-slot' />
                            <TabBar active={route.name} currentCode={ui.currentCode} onReselect={onReselect} />
                        </div>
                        <ToastHost />
                        {/* 下單與委託操作面板各自一個邊界：一邊載入失敗不連帶另一邊 */}
                        <ModuleErrorBoundary
                            onRetry={resetTicketSheet}
                            fallback={props => <SheetLoadError {...props} open={ui.ticket !== null} onClose={closeTicket} testId='ticket-load-error' />}
                        >
                            <Suspense fallback={null}>
                                {ticketMounted && <OrderTicketSheet />}
                            </Suspense>
                        </ModuleErrorBoundary>
                        <ModuleErrorBoundary
                            onRetry={resetActionSheet}
                            fallback={props => <SheetLoadError {...props} open={ui.orderAction !== null} onClose={closeOrderAction} testId='action-load-error' />}
                        >
                            <Suspense fallback={null}>
                                {actionMounted && <OrderActionSheet />}
                            </Suspense>
                        </ModuleErrorBoundary>
                        <OrderConfirmSheet />
                        {/* 面板 portal 目標：在 .shell 內（繼承 --sj-* 與 data-sheet-open），不在任何 inert 容器內 */}
                        <div ref={sheetRootRef} id='sj-sheet-root' className={layout.sheetRoot} />
                    </div>
                </ShellSlotsContext.Provider>
            </SheetRootContext.Provider>
        </WatchlistProvider>
    );
}

export function MobileApp({ secure, diagnostics }: { secure: boolean; diagnostics?: SecureContextDiagnostics }) {
    if (!secure) return <SecureContextGate diagnostics={diagnostics} />;
    return <MobileShell />;
}
