// src/mobile/lib/esun-env-switch.ts — 手機玉山「模擬／正式環境切換」（規格 §2.5、§6.7；設計規格 §7.8、§10 S1）
//
// - 只呼叫 esunTradeService.switchEnvironment(target)（POST /esun/auth/environment）：不送、不改、不刪任何委託（S1）。
// - 成功後比照桌面 src/components/header-env-menu.tsx 的 runEsunSwitch：invalidateAllQueries()＋
//   refreshTradingStateForModeChange()，通知用語相同。玉山帳戶換成新環境的帳戶（模擬帳戶 broker_id 帶 -SIM）與
//   選取帳戶的對應由 esunTradeService 內部（syncEsunAccountsToStore → replaceExternalAccountsForBroker）處理，與桌面同一條路徑。
//   成功之後的步驟各自包住：任何一步丟錯都不會把已成功的切換回報成失敗。
// - 環境相關的手機快取不需另外清：交易額度（broker_id:account_id）、按需查詢（玉山帳務概覽含環境、已實現損益含環境）、
//   交割款（account_type:broker_id:account_id）的鍵都隨 -SIM 帳戶或環境改變，切換後讀新鍵、不會顯示另一個環境的資料。
// - 切換狀態放在首屏的 lib/trading-activity.ts：根層 EnvSwitchOverlay 顯示不可關閉的面板（換頁不會消失），
//   openTicket／openOrderAction 不開面板，所有送單路徑在送出前 assertNoEnvSwitch()。
// - 回應逾時、連線中斷或閘道錯誤時 bridge 可能仍在切換：不直接回報失敗，改為「結果確認中」——
//   依 ESUN_HEALTH_RECHECK_DELAYS 重讀 health，看到目標環境＝已切換；一直是原環境＝未切換；一直讀不到＝結果未知。
//   確認期間閘門不放開、面板不可關閉。bridge 明確回錯誤（409 委託處理中、設定檔不存在、登入失敗…）時只再讀一次 health 核對。
// - 擋下條件（esunSwitchBlock，依優先順序）：切換進行中、重新連線進行中、bridge 未連線／停止／狀態異常／登入熔斷鎖定、
//   目標設定檔不存在、已是目前環境、下單面板／委託操作面板開啟、委託確認進行中、多選出清進行中、新單／平倉送出中、
//   刪改單送出中。面板開啟時顯示，按下確認（滑動／按鈕）的當下 runEsunEnvSwitch 再以同一函式判斷一次。

import { invalidateAllQueries } from '../../hooks/use-query';
import { esunTradeService, type EsunBridgeHealth, type EsunEnvironment, type EsunSwitchResult } from '../../lib/esun';
import { getPendingOrderConfirm } from '../../lib/order-confirm';
import { notify } from '../../lib/trade';
import { isEsunAccount } from '../../lib/esun/order-mapping';
import { getTradingState, refreshTradingStateForModeChange, type TradingState } from '../../lib/trading-state';
import { isBatchExitActive } from './batch-exit-auth';
import { ESUN_HEALTH_RECHECK_DELAYS, getEsunReconnectState } from './esun-reconnect';
import { getMobileUi } from './mobile-store';
import {
    getEnvSwitch,
    orderDispatchInFlight,
    setEnvSwitch,
    subscribeTradingActivity,
    tradeMutationInFlight,
    useTradingActivity,
} from './trading-activity';

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
    | 'dispatch'
    | 'mutation'
    | 'remote-switch'
    | 'reconcile';

export function getEsunEnvSwitching(): EsunEnvironment | null {
    return getEnvSwitch()?.target ?? null;
}

export function useEsunEnvSwitching(): EsunEnvironment | null {
    return useTradingActivity().envSwitch?.target ?? null;
}

/** 擋下條件會改變的來源（元件訂閱後重算 esunSwitchBlock）：切換狀態、送單計數、刪改單 */
export const subscribeEsunSwitchSources = subscribeTradingActivity;

/** bridge 探測：'checking'＝面板開啟後重新讀 health 中；'down'＝讀不到（bridge 停止或未連線）；'ok'＝讀到 */
export type BridgeProbe = 'checking' | 'down' | 'ok';

/**
 * 不能切換到 target 的原因（依優先順序）；null＝可以。
 * probe 省略＝只看已知的 health（區塊列表）；面板內一律帶入開啟時重新讀取的結果。
 */
export function esunSwitchBlock(target: EsunEnvironment, probe?: BridgeProbe, now: number = Date.now()): EsunSwitchBlock | null {
    if (getEnvSwitch() !== null || esunTradeService.getSnapshot().switching) return 'running';
    if (getEsunReconnectState().running || esunTradeService.isReconnecting()) return 'reconnecting';
    if (probe === 'checking') return 'checking';
    const health = esunTradeService.getBridgeHealth();
    if (!health || probe === 'down') return 'no-bridge';
    if (bridgeSwitching(health)) return 'remote-switch';
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
    if (orderDispatchInFlight()) return 'dispatch';
    if (tradeMutationInFlight(now)) return 'mutation';
    if (esunReconcilePending()) return 'reconcile';
    return null;
}

/** bridge 的 /esun/health envSwitchInProgress（另一個裝置或分頁正在切換；舊版 bridge 沒有這個欄位＝false） */
export function bridgeSwitching(health: EsunBridgeHealth | null | undefined): boolean {
    return (health as { envSwitchInProgress?: unknown } | null | undefined)?.envSwitchInProgress === true;
}

/**
 * 有牽涉玉山的待對帳：委託或持倉 needsReconcile，且原因訊息是玉山的（玉山／bridge 開頭的訊息，src/lib/esun/dispatch.ts），
 * 或有「刪改單結果待確認」且交易狀態裡有玉山委託（原因沒有帳戶資訊，保守視為牽涉玉山）。
 * 換環境後舊環境的玉山帳戶就讀不到，這些結果再也無法核對，所以先擋下切換。
 */
export function esunReconcilePending(state: Pick<TradingState, 'queries' | 'trades'> = getTradingState()): boolean {
    for (const scope of ['orders', 'positions'] as const) {
        const q = state.queries?.[scope];
        if (!q?.needsReconcile) continue;
        if (/玉山|bridge/.test(q.error ?? '')) return true;
        if (q.reasons.includes('mutation-outcome') && (state.trades ?? []).some(t => isEsunAccount(t.account))) return true;
    }
    return false;
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
        case 'dispatch': return '委託送出中（下單或平倉），請等待結果再切換環境。';
        case 'mutation': return '刪單／改單送出中，請等待結果再切換環境。';
        case 'remote-switch': return '另一個裝置或分頁正在切換玉山環境，請等它完成。';
        case 'reconcile': return '玉山委託或持倉有待對帳的項目，請先到委託頁按「更新」核對完成再切換環境（切換後就讀不到原環境的帳戶）。';
    }
}

/** switched＝已切換（含確認後才知道的）；failed＝確定沒有切換；unknown＝無法確認 */
export type EsunSwitchOutcome = 'switched' | 'failed' | 'unknown';

export interface EsunEnvSwitchResult {
    outcome: EsunSwitchOutcome;
    /** failed／unknown 的說明（面板內顯示） */
    error?: string;
}

/** 回應逾時、連線中斷、閘道錯誤、回應格式錯誤：bridge 可能仍在切換或已切換 */
export function isAmbiguousSwitchError(message: string): boolean {
    return /回應逾時|無法連線|回應格式錯誤|HTTP 5\d\d|已有更新的 session/.test(message);
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * 以 health 確認實際結果：看到目標環境＝switched；讀得到、是原環境且 bridge 沒有在切換（envSwitchInProgress 為假）＝failed；
 * 最後一次讀到時 bridge 仍在切換、或一直讀不到＝unknown（definite＝bridge 明確拒絕了這次請求：沒看到目標環境就是 failed）。
 */
async function verifySwitch(target: EsunEnvironment, delays: readonly number[], definite: boolean): Promise<EsunSwitchOutcome> {
    let last: 'none' | 'switching' | 'old' = 'none';
    for (const delay of delays) {
        if (delay > 0) await wait(delay);
        const health = await esunTradeService.refreshHealth().catch(() => null);
        if (!health) continue;
        if (health.environment === target) return 'switched';
        last = bridgeSwitching(health) ? 'switching' : 'old';
    }
    // bridge 明確拒絕了這次請求（409 忙碌、設定檔不存在、登入失敗…）：這次一定沒有切換
    if (definite || last === 'old') return 'failed';
    return 'unknown';
}

/** 成功之後（同桌面）：每一步各自包住，丟錯也不會把成功回報成失敗 */
function afterSwitch(target: EsunEnvironment, activeConfigFile: string | null | undefined, confirmedByHealth: boolean): void {
    try { invalidateAllQueries(); } catch { /* 查詢失效失敗不影響切換結果 */ }
    try { void Promise.resolve(refreshTradingStateForModeChange()).catch(() => undefined); } catch { /* 同上 */ }
    try {
        const file = activeConfigFile ?? esunTradeService.getConfigProfiles()[target]?.fileName;
        notify({
            kind: 'ok',
            title: '環境切換',
            body: `已切換玉山證券至${ESUN_ENV_LABEL[target]}${file ? `（${file}）` : ''}${confirmedByHealth ? '；回應遺失，已由 bridge 狀態確認' : ''}`,
        });
    } catch { /* 通知失敗不影響切換結果 */ }
}

/**
 * 使用者在確認面板滑動（正式）或按下確定（模擬）後呼叫。當下再判斷一次擋下條件：被擋下時不送出、回 null（並通知原因）。
 * 結果以 notify 通知並回傳：switched／failed（環境不變）／unknown（請使用者到帳戶 › 連線確認）。同一時間只送一個。
 * delays：結果不明時重讀 health 的排程（測試可注入）。
 */
export async function runEsunEnvSwitch(
    target: EsunEnvironment,
    probe?: BridgeProbe,
    delays: readonly number[] = ESUN_HEALTH_RECHECK_DELAYS,
): Promise<EsunEnvSwitchResult | null> {
    const block = esunSwitchBlock(target, probe);
    if (block !== null) {
        if (block !== 'running') notify({ kind: 'err', title: '環境切換未送出', body: esunSwitchBlockText(block, target) });
        return null;
    }
    const label = ESUN_ENV_LABEL[target];
    setEnvSwitch({ target, phase: 'switching' });
    try {
        let res: EsunSwitchResult | null = null;
        let thrown: string | null = null;
        // 只有送出本身在 try 裡：成功之後的步驟丟錯不會變成「失敗」
        try {
            res = await esunTradeService.switchEnvironment(target);
        } catch (err) {
            thrown = err instanceof Error ? err.message : String(err);
        }
        if (res?.ok && res.bridgeUpdated !== false) {
            afterSwitch(target, res.activeConfigFile, false);
            return { outcome: 'switched' };
        }
        const error = thrown ?? res?.error ?? `無法切換至${label}`;
        const ambiguous = thrown !== null || res?.ok === true || isAmbiguousSwitchError(error);
        setEnvSwitch({ target, phase: 'checking' });
        const outcome = await verifySwitch(target, ambiguous ? delays : [0], !ambiguous);
        if (outcome === 'switched') {
            afterSwitch(target, null, true);
            return { outcome };
        }
        if (outcome === 'failed') {
            const body = ambiguous ? `${error}（已由 bridge 狀態確認仍為原環境）` : error;
            try { notify({ kind: 'err', title: '環境切換失敗', body }); } catch { /* ignore */ }
            return { outcome, error: body };
        }
        const unknown = `${error}；無法確認玉山 bridge 是否已切換，請到帳戶 › 連線確認目前環境後再操作`;
        try { notify({ kind: 'err', title: '環境切換結果未知', body: unknown }); } catch { /* ignore */ }
        return { outcome, error: unknown };
    } finally {
        setEnvSwitch(null);
    }
}
