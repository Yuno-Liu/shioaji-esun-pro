// src/mobile/start.ts — 手機入口的啟動副作用（規格 §4.5；由 main.tsx 呼叫，獨立成檔方便單元測試）
//
// 1) 主題（深淺色、紅漲綠跌、字級）沿用桌面設定；手機第一次啟動時字級預設「小」（lib/font-default.ts，只套用一次）。
// 2) 一律開啟「手動下單確認」：placeQuickOrder／placeStockExitByShares 內部依 confirmManualOrders 決定是否跳確認
//    （src/lib/trade.ts）；新單由 mobile-order.ts 直接呼叫 requestOrderConfirm，不受此設定影響。
//    同源的其他視窗（例如桌面）關掉時，risk.ts 的 storage 同步會把設定帶進來，這裡立即改回開啟。
// 3) 清除桌面 Agent 的活動紀錄（localStorage 'sj-agent-activity-v1'）：手機平倉與全部刪單經 lib/trade.ts
//    會把委託內容寫進去，手機沒有任何介面讀它。只清紀錄，不動 'sj-agent-observe'（與桌面共用的觀察開關）。
// 4) 只有 secure context 才 bootstrap()：web 模式會檢查 /api/v1/health → 啟動交易狀態（含行情串流）→ 訂閱委託回報。
//    非 secure context 不建立任何連線，由 SecureContextGate 顯示 HTTPS 說明。
//
// 刻意不呼叫（規格 §12）：startTriggerEngine、startBracketRuntime、startOddSpreadService、
// startBackgroundExecution、startConditionalRuntime、startAnalytics。

import { clearActivity } from '../lib/activity';
import { bootstrap } from '../lib/boot';
import { getRiskSettings, setRiskSettings, subscribeRiskSettings } from '../lib/risk';
import { initTheme } from '../lib/theme-store';
import { applyMobileFontDefault } from './lib/font-default';

const AGENT_ACTIVITY_KEY = 'sj-agent-activity-v1';

/**
 * 清除桌面 Agent 活動紀錄。lib/activity.ts 已在 boot → trade 的靜態匯入中載入，模組初始化時把舊紀錄讀進記憶體，
 * 下一次 trackActivity 會整份寫回；所以用 clearActivity() 同時清記憶體與 storage，再直接移除一次 key 作為備援。
 * 讀寫失敗（私密瀏覽、儲存被封鎖）一律忽略，不影響啟動。
 */
export function clearAgentActivityLog(): void {
    try {
        clearActivity();
    } catch {
        // ignore
    }
    try {
        localStorage.removeItem(AGENT_ACTIVITY_KEY);
    } catch {
        // ignore
    }
}

let confirmPinned = false;

/** 讓 confirmManualOrders 維持開啟（手機不允許關閉，規格 R4） */
export function pinManualOrderConfirm(): void {
    if (!getRiskSettings().confirmManualOrders) setRiskSettings({ confirmManualOrders: true });
    if (confirmPinned) return;
    confirmPinned = true;
    subscribeRiskSettings(() => {
        if (!getRiskSettings().confirmManualOrders) setRiskSettings({ confirmManualOrders: true });
    });
}

export function startMobile(secure: boolean): void {
    initTheme();
    // 非 secure context 也執行（純畫面設定，不建立連線）
    applyMobileFontDefault();
    pinManualOrderConfirm();
    clearAgentActivityLog();
    if (secure) bootstrap();
}
