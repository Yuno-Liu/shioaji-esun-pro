// src/mobile/components/route-badge.tsx — 送單路由徽章「送往 {玉山｜永豐} {模擬｜正式｜環境未確認}」（規格 §5.3）
//
// 券商與環境的判斷與 routeConfirmNote()（src/lib/order-route.ts）同一來源：orderRouteOf()；
// 這裡傳入 hook 取得的即時環境，環境改變時重新渲染。用語差異：確認備註寫「模擬環境」，徽章寫「模擬」。
// 出現位置：下單面板頂端、確認面板、委託列。環境未確認時下單面板的「預覽」必須停用（useOrderRoute 回傳 simulation === undefined）。

import { useEsunEnvironment } from '../../lib/esun';
import { orderRouteOf, routeEnvText, type OrderRoute } from '../../lib/order-route';
import { useServerInfo } from '../../lib/server-info-store';
import type { Account } from '../../lib/types/portfolio';
import * as styles from '../styles/controls.css';

export type RouteTone = 'simulation' | 'production' | 'unknown';

/** 帳戶目前實際送往的券商與環境（即時）；沒有帳戶時回傳 null */
export function useOrderRoute(account: Pick<Account, 'broker_id'> | null | undefined): OrderRoute | null {
    const esun = useEsunEnvironment();
    const info = useServerInfo();
    if (!account) return null;
    return orderRouteOf(account, { esunEnvironment: esun.environment, sinopacSimulation: info?.simulation });
}

export function routeTone(route: OrderRoute | null): RouteTone {
    if (!route) return 'unknown';
    return route.simulation === true ? 'simulation' : route.simulation === false ? 'production' : 'unknown';
}

/** 徽章文字（純函式） */
export function routeBadgeText(route: OrderRoute | null): string {
    if (!route) return '未選擇下單帳戶';
    return `送往 ${route.broker} ${routeEnvText(route.simulation)}`;
}

export function RouteBadge({ account, size = 'sm' }: { account: Account | null | undefined; size?: 'sm' | 'lg' }) {
    const route = useOrderRoute(account);
    const tone = routeTone(route);
    const className = size === 'lg' ? `${styles.routeBadge[tone]} ${styles.routeBadgeLarge}` : styles.routeBadge[tone];
    return (
        <span className={className} data-testid='mobile-route-badge' data-env={tone}>
            {routeBadgeText(route)}
        </span>
    );
}
