// src/mobile/lib/esun-env-switch.ts — 手機玉山「模擬／正式環境切換」（規格 §2.5、§6.7；設計規格 §7.8、§10 S1）
//
// - 只呼叫 esunTradeService.switchEnvironment(target)（POST /esun/auth/environment）：不送、不改、不刪任何委託（S1）。
// - 成功後比照桌面 src/components/header-env-menu.tsx 的 runEsunSwitch：invalidateAllQueries()＋
//   refreshTradingStateForModeChange()，通知用語相同。玉山帳戶換成新環境的帳戶（模擬帳戶 broker_id 帶 -SIM）與
//   選取帳戶的對應由 esunTradeService 內部（syncEsunAccountsToStore → replaceExternalAccountsForBroker）處理，與桌面同一條路徑。
// - 環境相關的手機快取不需另外清：交易額度（broker_id:account_id）、按需查詢（玉山帳務概覽含環境、已實現損益含環境）、
//   交割款（account_type:broker_id:account_id）的鍵都隨 -SIM 帳戶或環境改變，切換後讀新鍵、不會顯示另一個環境的資料。
// - 擋下條件（esunSwitchBlock，依優先順序）：切換進行中、重新連線進行中、bridge 未連線／停止／狀態異常／登入熔斷鎖定、
//   目標設定檔不存在、已是目前環境、下單面板／委託操作面板開啟、委託確認進行中、多選出清進行中、刪改單送出中。
//   面板開啟時顯示，按下確認（滑動／按鈕）的當下 runEsunEnvSwitch 再以同一函式判斷一次。

import { useSyncExternalStore } from 'react';
import { invalidateAllQueries } from '../../hooks/use-query';
import { esunTradeService, type EsunBridgeHealth, type EsunEnvironment, type EsunSwitchResult } from '../../lib/esun';
import { getPendingOrderConfirm } from '../../lib/order-confirm';
import { notify } from '../../lib/trade';
import { onTradeMutation } from '../../lib/trade-mutations';
import { refreshTradingStateForModeChange } from '../../lib/trading-state';
import { isBatchExitActive } from './batch-exit-auth';
import { getEsunReconnectState } from './esun-reconnect';
import { getMobileUi } from './mobile-store';

export const ESUN_ENV_LABEL: Record<EsunEnvironment, string> = { SIMULATION: '模擬環境', PRODUCTION: '正式環境' };

/** 切換至正式環境面板的警示（設計規格 §10 S1） */
export const ESUN_PRODUCTION_WARNING = '正式環境的委託是真實下單，會動用真實資金與庫存';

export type EsunSwitchBlock =
    | 'running'
    | 'reconnecting'
    | 'checking'
    | 'no-bridge'
    | 'locked'
    | 'unhealthy'
    | 'unavailable'
    | 'current'
    | 'ticket'
    | 'order-action'
    | 'confirm'
    | 'batch'
    | 'mutation';

// ---- 刪改單送出中（lib/trade-mutations 的 begin／settled 事件，含同源其他分頁） ----
// 視窗在 settled 前關閉時不會有 settled：超過這個時間的 begin 視為已結束（刪改單請求本身的逾時遠短於此）
export const MUTATION_STALE_MS = 120_000;
const mutations = new Map<string, number>();
const mutationListeners = new Set<() => void>();
onTradeMutation(event => {
    if (event.phase === 'begin') mutations.set(event.token, Date.now());
    else mutations.delete(event.token);
    mutationListeners.forEach(l => l());
});

function mutationInFlight(now: number): boolean {
    for (const [token, at] of mutations) {
        if (now - at >= MUTATION_STALE_MS) mutations.delete(token);
    }
    return mutations.size > 0;
}

// ---- 切換狀態（模組層：重新掛載仍有效，防連點） ----
let running: EsunEnvironment | null = null;
const listeners = new Set<() => void>();
const setRunning = (next: EsunEnvironment | null) => {
    running = next;
    listeners.forEach(l => l());
};

export function getEsunEnvSwitching(): EsunEnvironment | null {
    return running;
}

export function useEsunEnvSwitching(): EsunEnvironment | null {
    return useSyncExternalStore(
        l => {
            listeners.add(l);
            return () => { listeners.delete(l); };
        },
        getEsunEnvSwitching,
        getEsunEnvSwitching,
    );
}

/** 擋下條件會改變的來源（元件訂閱後重算 esunSwitchBlock） */
export function subscribeEsunSwitchSources(listener: () => void): () => void {
    listeners.add(listener);
    mutationListeners.add(listener);
    return () => {
        listeners.delete(listener);
        mutationListeners.delete(listener);
    };
}

/** bridge 探測：'checking'＝面板開啟後重新讀 health 中；'down'＝讀不到（bridge 停止或未連線）；'ok'＝讀到 */
export type BridgeProbe = 'checking' | 'down' | 'ok';

/**
 * 不能切換到 target 的原因（依優先順序）；null＝可以。
 * probe 省略＝只看已知的 health（區塊列表）；面板內一律帶入開啟時重新讀取的結果。
 */
export function esunSwitchBlock(target: EsunEnvironment, probe?: BridgeProbe, now: number = Date.now()): EsunSwitchBlock | null {
    if (running !== null || esunTradeService.getSnapshot().switching) return 'running';
    if (getEsunReconnectState().running || esunTradeService.isReconnecting()) return 'reconnecting';
    if (probe === 'checking') return 'checking';
    const health = esunTradeService.getBridgeHealth();
    if (!health || probe === 'down') return 'no-bridge';
    if (health.loginLocked) return 'locked';
    if (health.ok === false) return 'unhealthy';
    if (!esunTradeService.isEnvironmentAvailable(target)) return 'unavailable';
    const snap = esunTradeService.getSnapshot();
    if (snap.environmentKnown && snap.environment === target) return 'current';
    const ui = getMobileUi();
    if (ui.ticket !== null) return 'ticket';
    if (ui.orderAction !== null) return 'order-action';
    if (getPendingOrderConfirm() !== null) return 'confirm';
    if (isBatchExitActive()) return 'batch';
    if (mutationInFlight(now)) return 'mutation';
    return null;
}

/** 擋下原因的說明文字 */
export function esunSwitchBlockText(block: EsunSwitchBlock, target: EsunEnvironment, health: EsunBridgeHealth | null = esunTradeService.getBridgeHealth()): string {
    switch (block) {
        case 'running': return '玉山環境切換中…';
        case 'reconnecting': return '玉山重新連線進行中，完成後才能切換環境。';
        case 'checking': return '正在確認玉山 bridge 狀態…';
        case 'no-bridge': return '玉山 bridge 未連線或已停止，無法切換環境。';
        case 'locked': return `玉山登入熔斷鎖定中${health?.loginLockReason ? `（${health.loginLockReason}）` : ''}，請到桌面版處理後再切換。`;
        case 'unhealthy': return `玉山 bridge 狀態異常${health?.problems?.length ? `（${health.problems.join('；')}）` : ''}，無法切換環境。`;
        case 'unavailable': {
            const expected = esunTradeService.getConfigProfiles()[target]?.expectedFileName || `esun-config.${target.toLowerCase()}.ini`;
            return `bridge 沒有提供 ${expected} 設定檔，不能切換至${ESUN_ENV_LABEL[target]}。`;
        }
        case 'current': return `目前已是${ESUN_ENV_LABEL[target]}。`;
        case 'ticket': return '下單面板開啟中，請先關閉再切換環境。';
        case 'order-action': return '委託操作面板開啟中，請先關閉再切換環境。';
        case 'confirm': return '委託確認進行中，請先完成或取消再切換環境。';
        case 'batch': return '多選出清進行中，完成或停止後才能切換環境。';
        case 'mutation': return '刪單／改單送出中，請等待結果再切換環境。';
    }
}

/**
 * 使用者在確認面板滑動（正式）或按下確定（模擬）後呼叫。當下再判斷一次擋下條件：被擋下時不送出、回 null（並通知原因）。
 * 結果以 notify 通知（用語同桌面）並回傳；失敗回 ok:false（環境不變）。同一時間只送一個。
 */
export async function runEsunEnvSwitch(target: EsunEnvironment, probe?: BridgeProbe): Promise<EsunSwitchResult | null> {
    const block = esunSwitchBlock(target, probe);
    if (block !== null) {
        if (block !== 'running') notify({ kind: 'err', title: '環境切換未送出', body: esunSwitchBlockText(block, target) });
        return null;
    }
    setRunning(target);
    const label = ESUN_ENV_LABEL[target];
    try {
        const res = await esunTradeService.switchEnvironment(target);
        if (!res.ok) {
            notify({ kind: 'err', title: '環境切換失敗', body: res.error || `無法切換至${label}` });
            return res;
        }
        invalidateAllQueries();
        void refreshTradingStateForModeChange();
        if (res.bridgeUpdated === false) {
            notify({ kind: 'err', title: '環境切換未確認', body: '玉山 bridge 沒有確認環境切換；請確認 bridge 狀態後重試' });
            return res;
        }
        const file = res.activeConfigFile ?? esunTradeService.getConfigProfiles()[target]?.fileName;
        notify({ kind: 'ok', title: '環境切換', body: `已切換玉山證券至${label}${file ? `（${file}）` : ''}` });
        return res;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notify({ kind: 'err', title: '環境切換失敗', body: message });
        return { ok: false, environment: esunTradeService.getEnvironment(), entry: esunTradeService.getEntryUrl(), bridgeUpdated: false, error: message };
    } finally {
        setRunning(null);
    }
}

/** 測試用：清除進行中狀態與刪改單紀錄 */
export function resetEsunEnvSwitchForTest(): void {
    running = null;
    mutations.clear();
    listeners.clear();
    mutationListeners.clear();
}
