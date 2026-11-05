// src/mobile/app.tsx — 手機版根元件（規格 §4.2、§5）
//
// - 非 secure context：只顯示 SecureContextGate（不掛載任何會連線的元件或 hook）。
// - secure context：MobileShell —— 狀態列（sticky）＋ hash 路由頁面＋底部 5 分頁，
//   根層掛載 toast host、下單／委託操作／確認面板 host、風控損益餵送、ResumeGate。

import { useEffect } from 'react';
import { Briefcase, ChartCandlestick, ClipboardList, Star, UserRound, type LucideIcon } from 'lucide-react';
import { useTradingState } from '../lib/trading-state';
import { ensureStream } from '../lib/stream';
import type { Trade } from '../lib/types/order';
import { remainingWorkingOrderQuantity } from '../lib/working-order-quantity';
import { OrderActionSheet } from './components/order-action-sheet';
import { OrderConfirmSheet } from './components/order-confirm-sheet';
import { OrderTicketSheet } from './components/order-ticket-sheet';
import { StatusBar } from './components/status-bar';
import { ToastHost } from './components/toast-host';
import { SecureContextGate } from './gate/secure-context-gate';
import { useRiskPnlFeed } from './hooks/use-risk-pnl-feed';
import { formatRoute, isCanonicalHash, navigate, parseHash, useHashRoute, type MobileRoute, type MobileTab } from './lib/hash-router';
import { setActiveTab, setCurrentCode, useMobileUi } from './lib/mobile-store';
import { startResumeGate } from './lib/resume-gate-runtime';
import type { SecureContextDiagnostics } from './lib/secure-context';
import { AccountPage } from './routes/account-page';
import { OrdersPage } from './routes/orders-page';
import { PositionsPage } from './routes/positions-page';
import { TradePage } from './routes/trade-page';
import { WatchlistPage } from './routes/watchlist-page';
import * as layout from './styles/layout.css';

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

    const route = useHashRoute();
    const routeKey = formatRoute(route);
    const ui = useMobileUi();

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

    return (
        <div className={layout.shell} data-testid='mobile-shell'>
            <StatusBar />
            <main className={layout.main}>
                <RoutePage route={route} />
            </main>
            <TabBar active={route.name} currentCode={ui.currentCode} />
            <ToastHost />
            <OrderTicketSheet />
            <OrderActionSheet />
            <OrderConfirmSheet />
        </div>
    );
}

export function MobileApp({ secure, diagnostics }: { secure: boolean; diagnostics?: SecureContextDiagnostics }) {
    if (!secure) return <SecureContextGate diagnostics={diagnostics} />;
    return <MobileShell />;
}
