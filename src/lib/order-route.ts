// src/lib/order-route.ts — fork：多券商（永豐／玉山）下單面板的路由顯示與送單閘門。
// 上游面板只在掛鉤處呼叫這裡的函式，fork 的規則集中在這個檔案，降低同步上游時的衝突。
//
// - 帳號選單鎖定：主視窗由頂欄統一控管帳號；「跟隨頂欄」的面板鎖定選單，
//   popout（沒有頂欄）與已固定帳號的面板保留選單，可以改回跟隨。
// - 路由顯示：面板依市場槽位（selectedStock／selectedFutures）送單，可能與頂欄
//   顯示的帳號不同，面板要自己標出實際送往的券商與環境。
// - 送單閘門：按下送出時記下畫面顯示的帳號與玉山環境，送出前再讀一次目前的實際
//   路由；不同就不送（避免 stale closure 或切換途中送單）。閃電／圖表的帳號由各自的
//   accountRef（每次渲染更新）比對，這裡只補玉山環境。

import { getAccountState } from './account-store';
import { canTrade } from './account-tradable';
import { esunTradeService, isEsunAccount, validateEsunStockOrder } from './esun';
import { accountMatches } from './flash-account';
import { knownServerInfo } from './server-info-store';
import type { ContractBase } from './types/contract';
import type { StockOrderReq } from './types/order';
import type { Account } from './types/portfolio';
import { isChildWindow } from './window-role';

type AccountIdentity = Pick<Account, 'account_type' | 'broker_id' | 'account_id'>;

export const HEADER_LOCK_TITLE = '帳號由頂欄統一控管切換';
export const ROUTE_CHANGED_MESSAGE = '送出前下單帳號或環境已與畫面顯示的不同（可能剛由頂欄切換），這筆沒有送出，請確認後重新下單';

/**
 * 帳號選單是否鎖定：只有主視窗裡「跟隨頂欄」的面板才鎖。popout 沒有頂欄、
 * 已固定帳號的面板要能改回跟隨，兩者都保留選單。
 */
export function headerAccountLocked(following = true): boolean {
    return following && !isChildWindow();
}

/** 頂欄顯示的帳號（與 account-store getActiveAccount 同一規則；面板測試常只 mock 部分 API，故不直接 import） */
export function headerAccountOf(state: { selectedAccount?: Account | null; selectedStock?: Account | null; selectedFutures?: Account | null }): Account | null {
    return state.selectedAccount ?? state.selectedStock ?? state.selectedFutures ?? null;
}

function esunSimulation(environment: string | undefined): boolean | undefined {
    return environment === 'SIMULATION' ? true : environment === 'PRODUCTION' ? false : undefined;
}

export interface OrderRoute {
    esun: boolean;
    /** 顯示用券商名稱 */
    broker: string;
    /** true＝模擬、false＝正式、undefined＝尚未確認 */
    simulation: boolean | undefined;
}

/**
 * 這個帳號實際送往的券商與環境（玉山看 esunTradeService，永豐看 /info 的 simulation）。
 * React 元件傳入 hook 取得的 `live`，讓環境改變時重新渲染。
 */
export function orderRouteOf(
    account: Pick<Account, 'broker_id'>,
    live?: { esunEnvironment: string; sinopacSimulation: boolean | undefined },
): OrderRoute {
    const esun = isEsunAccount(account);
    return {
        esun,
        broker: esun ? '玉山' : '永豐',
        simulation: esun
            ? esunSimulation(live ? live.esunEnvironment : esunTradeService.getSnapshot().environment)
            : live ? live.sinopacSimulation : knownServerInfo()?.simulation,
    };
}

export function routeEnvText(simulation: boolean | undefined): string {
    return simulation === true ? '模擬' : simulation === false ? '正式' : '環境未確認';
}

/** 確認視窗補一句實際路由（例：送往 玉山 模擬環境） */
export function routeConfirmNote(account: Pick<Account, 'broker_id'> | null | undefined): string | undefined {
    if (!account) return undefined;
    const route = orderRouteOf(account);
    return `送往 ${route.broker} ${route.simulation === undefined ? '（環境未確認）' : `${routeEnvText(route.simulation)}環境`}`;
}

/**
 * 記下帳號目前的玉山環境；之後環境變了（例如由模擬切到正式、或切換中）回傳 false。
 * 永豐帳號的模式由上游 captureServerMode 把關，這裡固定回傳 true。
 */
export function captureRouteEnv(account: Pick<Account, 'broker_id'> | null | undefined): () => boolean {
    if (!account || !isEsunAccount(account)) return () => true;
    const environment = esunTradeService.getSnapshot().environment;
    return () => esunSimulation(environment) !== undefined && esunTradeService.getSnapshot().environment === environment;
}

/**
 * 下單票：畫面顯示的帳號必須仍是這個市場目前實際路由（市場槽位）的帳號，且環境沒變。
 * 回傳的檢查在送單前（確認後、beforeDispatch）呼叫，不符就丟出 tradingGateRejected。
 */
export function captureDisplayedRoute(displayed: AccountIdentity & Pick<Account, 'broker_id'> | null | undefined, market: 'S' | 'F'): () => void {
    const sameEnv = captureRouteEnv(displayed);
    return () => {
        const state = getAccountState();
        const routed = market === 'S' ? state.selectedStock : state.selectedFutures;
        if (!displayed || !routed || !canTrade(routed) || !accountMatches(routed, displayed) || !sameEnv()) {
            throw Object.assign(new Error(ROUTE_CHANGED_MESSAGE), { tradingGateRejected: true });
        }
    };
}

/** 分倉／單筆送出前：玉山那一腿先用玉山規則驗證（永豐帳號回傳 null，交給上游規則） */
export function esunStockLegProblem(
    account: Pick<Account, 'broker_id'> | null | undefined,
    contract: ContractBase,
    order: Omit<StockOrderReq, 'price_type'> & { price_type: string },
): string | null {
    if (!isEsunAccount(account)) return null;
    const problem = validateEsunStockOrder(contract, order as StockOrderReq);
    return problem ? `玉山：${problem}` : null;
}

/** 查詢 key 的環境維度：只有包含玉山帳號的查詢才帶玉山環境（永豐帳務不因玉山切換而重抓） */
export function esunEnvKey(accounts: readonly Pick<Account, 'broker_id'>[], environment: string): string {
    return accounts.some(a => isEsunAccount(a)) ? `:${environment}` : '';
}
