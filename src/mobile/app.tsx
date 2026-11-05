// src/mobile/app.tsx — 手機版根元件（規格 §4.2、§5）
//
// - 非 secure context：只顯示 SecureContextGate（不掛載任何會連線的元件或 hook）。
// - secure context：MobileShell —— 狀態列（sticky）＋ hash 路由頁面＋底部 5 分頁，
//   根層掛載 toast host、下單／委託操作／確認面板 host、風控損益餵送、ResumeGate、
//   成交音效／震動（useFillSound）與螢幕常亮（useWakeLock，依帳戶頁「本裝置」設定）。

import { lazy, Suspense, useEffect, useState } from 'react';
import { Briefcase, ChartCandlestick, ClipboardList, Star, UserRound, type LucideIcon } from 'lucide-react';
import { useTradingState } from '../lib/trading-state';
import { ensureStream } from '../lib/stream';
import type { Trade } from '../lib/types/order';
import { remainingWorkingOrderQuantity } from '../lib/working-order-quantity';
import { OrderConfirmSheet } from './components/order-confirm-sheet';
import { StatusBar } from './components/status-bar';
import { ToastHost } from './components/toast-host';
import { SecureContextGate } from './gate/secure-context-gate';
import { useFillSound } from './hooks/use-fill-sound';
import { useRiskPnlFeed } from './hooks/use-risk-pnl-feed';
import { useWakeLock } from './hooks/use-wake-lock';
import { formatRoute, isCanonicalHash, navigate, parseHash, useHashRoute, type MobileRoute, type MobileTab } from './lib/hash-router';
import { setActiveTab, setCurrentCode, useMobileUi } from './lib/mobile-store';
import { startResumeGate } from './lib/resume-gate-runtime';
import type { SecureContextDiagnostics } from './lib/secure-context';
import { WatchlistProvider } from './lib/watchlist-context';
import { WatchlistPage } from './routes/watchlist-page';
import * as layout from './styles/layout.css';

// 首次載入只含殼層、預設分頁（自選）與確認面板（確認面板必須常駐，requestOrderConfirm 才會結束）。
// 其餘分頁與下單／委託操作面板在第一次用到時才載入，並在首屏完成後閒置時預先抓取（規格 §9.4：首次載入 JS ≤ 400 KB）。
const loadTradePage = () => import('./routes/trade-page');
const loadOrdersPage = () => import('./routes/orders-page');
const loadPositionsPage = () => import('./routes/positions-page');
const loadAccountPage = () => import('./routes/account-page');
const loadTicketSheet = () => import('./components/order-ticket-sheet');
const loadActionSheet = () => import('./components/order-action-sheet');

const TradePage = lazy(() => loadTradePage().then(m => ({ default: m.TradePage })));
const OrdersPage = lazy(() => loadOrdersPage().then(m => ({ default: m.OrdersPage })));
const PositionsPage = lazy(() => loadPositionsPage().then(m => ({ default: m.PositionsPage })));
const AccountPage = lazy(() => loadAccountPage().then(m => ({ default: m.AccountPage })));
const OrderTicketSheet = lazy(() => loadTicketSheet().then(m => ({ default: m.OrderTicketSheet })));
const OrderActionSheet = lazy(() => loadActionSheet().then(m => ({ default: m.OrderActionSheet })));

const PREFETCH_DELAY_MS = 1_500;

/** 首屏完成後閒置時預先抓取其餘模組（失敗無妨：真正用到時會再載一次） */
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

function TabBar({ active, currentCode }: { active: MobileTab; currentCode: string | null }) {
    const trading = useTradingState();
    const working = countWorkingOrders(trading.trades);
    return (
        <nav className={layout.tabBar} aria-label='主要分頁' data-testid='mobile-tab-bar'>
            {TAB_ORDER.map(tab => {
                const { label, icon: Icon } = TAB_META[tab];
                const route: MobileRoute = tab === 'trade' ? { name: 'trade', code: currentCode } : { name: tab };
                const badge = tab === 'orders' && working > 0 ? working : 0;
                return (
                    <a
                        key={tab}
                        href={formatRoute(route)}
                        className={layout.tab}
                        aria-current={active === tab ? 'page' : undefined}
                        aria-label={badge ? `${label}（未成交 ${badge} 筆）` : label}
                        data-testid={`tab-${tab}`}
                    >
                        <Icon size={22} aria-hidden='true' />
                        <span>{label}</span>
                        {badge > 0 && <span className={layout.tabBadge} aria-hidden='true'>{badge > 99 ? '99+' : badge}</span>}
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

    const route = useHashRoute();
    const routeKey = formatRoute(route);
    const ui = useMobileUi();
    const ticketMounted = useMountedOnce(ui.ticket !== null);
    const actionMounted = useMountedOnce(ui.orderAction !== null);

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
            <div className={layout.shell} data-testid='mobile-shell'>
                <StatusBar />
                <main className={layout.main}>
                    <Suspense fallback={<RouteFallback />}>
                        <RoutePage route={route} />
                    </Suspense>
                </main>
                <TabBar active={route.name} currentCode={ui.currentCode} />
                <ToastHost />
                <Suspense fallback={null}>
                    {ticketMounted && <OrderTicketSheet />}
                    {actionMounted && <OrderActionSheet />}
                </Suspense>
                <OrderConfirmSheet />
            </div>
        </WatchlistProvider>
    );
}

export function MobileApp({ secure, diagnostics }: { secure: boolean; diagnostics?: SecureContextDiagnostics }) {
    if (!secure) return <SecureContextGate diagnostics={diagnostics} />;
    return <MobileShell />;
}
