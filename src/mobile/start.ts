// src/mobile/start.ts — 手機入口的啟動副作用（規格 §4.5；由 main.tsx 呼叫，獨立成檔方便單元測試）
//
// 1) 主題（深淺色、紅漲綠跌、字級）沿用桌面設定。
// 2) 一律開啟「手動下單確認」：placeQuickOrder／placeStockExitByShares 內部依 confirmManualOrders 決定是否跳確認
//    （src/lib/trade.ts）；新單由 mobile-order.ts 直接呼叫 requestOrderConfirm，不受此設定影響。
//    同源的其他視窗（例如桌面）關掉時，risk.ts 的 storage 同步會把設定帶進來，這裡立即改回開啟。
// 3) 只有 secure context 才 bootstrap()：web 模式會檢查 /api/v1/health → 啟動交易狀態（含行情串流）→ 訂閱委託回報。
//    非 secure context 不建立任何連線，由 SecureContextGate 顯示 HTTPS 說明。
//
// 刻意不呼叫（規格 §12）：startTriggerEngine、startBracketRuntime、startOddSpreadService、
// startBackgroundExecution、startConditionalRuntime、startAnalytics。

import { bootstrap } from '../lib/boot';
import { getRiskSettings, setRiskSettings, subscribeRiskSettings } from '../lib/risk';
import { initTheme } from '../lib/theme-store';

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
    pinManualOrderConfirm();
    if (secure) bootstrap();
}
