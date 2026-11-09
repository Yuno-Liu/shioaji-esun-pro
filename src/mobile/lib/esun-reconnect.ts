// src/mobile/lib/esun-reconnect.ts — 手機玉山「一般重新連線」（規格 §2.5、§6.7、§9.1、Phase 2）
//
// - 只呼叫 esunTradeService.reconnect()：絕不帶 force、不切換環境（強制重試只在桌面處理，§12；環境切換見 esun-env-switch.ts）。
// - 60 秒冷卻在模組層：不論成功或失敗，從按下確認起算；帳戶頁重新掛載仍有效（玉山登入 10 次／分、300 次／日、
//   密碼錯 3 次鎖帳，server/esun_trade_server.py）。
// - 進行中、玉山環境切換中、冷卻中、bridge 未連線、登入熔斷鎖定（loginLocked）時一律不送出。
// - 結果通知用語比照桌面 src/components/header-env-menu.tsx 的 runEsunReconnect：
//   失敗「玉山重新連線失敗」＋錯誤內容；成功「玉山重新連線」＋「已重新登入玉山證券（模擬環境／正式環境）」。
//   成功後 invalidateAllQueries()（與桌面相同）；委託權威重讀由 trading-state 的 session 代次 hook 負責，不在此重複。

import { useSyncExternalStore } from 'react';
import { invalidateAllQueries } from '../../hooks/use-query';
import { esunTradeService, type EsunBridgeHealth, type EsunReconnectResult } from '../../lib/esun';
import { notify } from '../../lib/trade';

export const ESUN_RECONNECT_COOLDOWN_MS = 60_000;

/** 確認面板的鎖帳提醒 */
export const ESUN_RECONNECT_WARNING = '密碼錯誤 3 次會被玉山鎖帳，請確認設定正確再重試';

/** 重新連線成功但讀不到 health 時的重讀排程（毫秒；比照桌面 ESUN_HEALTH_RECHECK_DELAYS） */
export const ESUN_HEALTH_RECHECK_DELAYS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

export type EsunReconnectBlock = 'running' | 'switching' | 'cooldown' | 'no-bridge' | 'locked' | 'not-needed';

interface ReconnectState {
    running: boolean;
    /** 最近一次送出的時間（epoch ms）；0＝本次開啟網頁後尚未送出 */
    lastAttemptAt: number;
}

let state: ReconnectState = { running: false, lastAttemptAt: 0 };
const listeners = new Set<() => void>();

function setState(next: Partial<ReconnectState>): void {
    state = { ...state, ...next };
    listeners.forEach(l => l());
}

export function getEsunReconnectState(): ReconnectState {
    return state;
}

export function useEsunReconnectState(): ReconnectState {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => { listeners.delete(l); };
        },
        getEsunReconnectState,
        getEsunReconnectState,
    );
}

/** 冷卻剩餘秒數（無條件進位；0＝可再按） */
export function esunReconnectCooldownSec(now: number = Date.now(), s: ReconnectState = state): number {
    if (!s.lastAttemptAt) return 0;
    const left = s.lastAttemptAt + ESUN_RECONNECT_COOLDOWN_MS - now;
    return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** bridge 已連線但券商登入不在（未登入或 token 失效）：需要重新連線（同桌面 esunSessionLost） */
export function esunSessionLost(h: EsunBridgeHealth | null | undefined): boolean {
    return !!h && (h.loggedIn === false || h.sessionExpired === true);
}

/** 不能重新連線的原因（依優先順序）；null＝可以 */
export function esunReconnectBlock(health: EsunBridgeHealth | null | undefined, now: number = Date.now(), s: ReconnectState = state): EsunReconnectBlock | null {
    if (s.running) return 'running';
    // 玉山環境切換進行中（帳戶 › 連線的環境切換）：bridge 會回 ESUN_SESSION_BUSY，先擋下
    if (esunTradeService.getSnapshot().switching) return 'switching';
    if (!health) return 'no-bridge';
    if (health.loginLocked) return 'locked';
    if (esunReconnectCooldownSec(now, s) > 0) return 'cooldown';
    if (!esunSessionLost(health)) return 'not-needed';
    return null;
}

function envText(env: string | null | undefined): string {
    return env === 'SIMULATION' ? '模擬環境' : env === 'PRODUCTION' ? '正式環境' : '';
}

/**
 * 使用者在確認面板按下確定後呼叫。被擋下（進行中、冷卻、未連線、鎖定、不需要）時不送出、回 null。
 * 送出後一定開始 60 秒冷卻；結果以 notify 通知並回傳（呼叫端依 health 是否為 null 決定是否顯示「狀態確認中」）。
 */
export async function runEsunReconnect(now: () => number = Date.now): Promise<EsunReconnectResult | null> {
    if (esunReconnectBlock(esunTradeService.getBridgeHealth(), now()) !== null) return null;
    setState({ running: true, lastAttemptAt: now() });
    try {
        // 一般重新連線：不帶任何參數（絕不帶 force）
        const res = await esunTradeService.reconnect();
        if (!res.ok) {
            notify({ kind: 'err', title: '玉山重新連線失敗', body: res.error || '玉山重新連線失敗' });
            return res;
        }
        invalidateAllQueries();
        const env = envText(res.environment);
        notify({ kind: 'ok', title: '玉山重新連線', body: `已重新登入玉山證券${env ? `（${env}）` : ''}` });
        return res;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notify({ kind: 'err', title: '玉山重新連線失敗', body: message });
        return { ok: false, health: esunTradeService.getBridgeHealth(), error: message };
    } finally {
        setState({ running: false });
    }
}

/** 測試用：清除冷卻與進行中狀態 */
export function resetEsunReconnectForTest(): void {
    state = { running: false, lastAttemptAt: 0 };
    listeners.clear();
}
