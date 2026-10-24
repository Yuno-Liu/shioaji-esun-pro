// src/components/order-routing-badge.tsx — fork：面板上標出「實際送往」的券商與環境。
// 面板依市場槽位送單，可能與頂欄顯示的帳號不同（例如頂欄選玉山證券、期貨面板走永豐期貨），
// 不同時加上「≠頂欄」並在 tooltip 說明。
import { useAccounts } from '../lib/account-store';
import { esunWireBrokerId, isEsunAccount, useEsunEnvironment } from '../lib/esun';
import { accountMatches } from '../lib/flash-account';
import { headerAccountOf, orderRouteOf, routeEnvText } from '../lib/order-route';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import { useServerInfo } from '../lib/server-info-store';
import type { Account } from '../lib/types/portfolio';
import { isChildWindow } from '../lib/window-role';
import * as styles from './order-routing-badge.css';

// 玉山帳戶鍵的 -SIM 後綴只用於區分環境，畫面顯示實際分公司代號
const accountLabel = (a: Account, priv: boolean) => `${isEsunAccount(a) ? esunWireBrokerId(a.broker_id) : a.broker_id}-${maskAccountId(a.account_id, priv)}`;

export function OrderRoutingBadge({ account }: { account: Account | null | undefined }) {
    const esun = useEsunEnvironment();
    const info = useServerInfo();
    const priv = usePrivacyMode();
    const state = useAccounts();
    if (!account) return null;
    const route = orderRouteOf(account, { esunEnvironment: esun.environment, sinopacSimulation: info?.simulation });
    const env = routeEnvText(route.simulation);
    const header = isChildWindow() ? null : headerAccountOf(state);
    const diverged = !!header && !accountMatches(header, account);
    const id = accountLabel(account, priv);
    const headerId = header ? `${isEsunAccount(header) ? '玉山' : '永豐'} ${accountLabel(header, priv)}` : '';
    const title = `實際送單：${route.broker} ${id}（${route.simulation === undefined ? '環境未確認' : `${env}環境`}）`
        + (diverged ? `\n頂欄目前為 ${headerId}；${account.account_type === 'F' ? '期貨' : '證券'}委託改走上列帳號` : '');
    const tone = route.simulation === true ? 'simulation' : route.simulation === false ? 'production' : 'unknown';
    return (
        <span className={styles.badge[tone]} data-testid='order-route' data-env={tone} title={title}>
            {route.broker}·{env}
            {diverged && <span className={styles.diverged}>≠頂欄</span>}
        </span>
    );
}

/** 只看單一帳戶的面板（例如持股類股）標出資料範圍 */
export function AccountScopeLabel({ account, className }: { account: Account | null | undefined; className?: string }) {
    const priv = usePrivacyMode();
    if (!account) return null;
    const label = `${isEsunAccount(account) ? '玉山' : '永豐'} ${accountLabel(account, priv)}`;
    return <span className={className} data-testid='account-scope' title={`只計入 ${label} 的持股（依頂欄的證券帳戶）`}>範圍：{label}</span>;
}

