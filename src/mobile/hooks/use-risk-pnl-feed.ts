// src/mobile/hooks/use-risk-pnl-feed.ts — 風控當日損益餵送（規格 §7.5）
//
// 桌面由 src/App.tsx 呼叫 reportDailyPnl()；手機沒有掛載 App.tsx，必須自行餵送，
// 否則「當日虧損上限」在手機上不會生效。掛在殼層的葉節點 <RiskPnlFeed/>（app.tsx），避免每次發布重繪整個殼層。
// 與 src/App.tsx（feed risk engine）同公式：持倉未實現損益＋期貨結算損益。
// 若上游日後把公式抽成共用函式，改為呼叫共用函式。

import { useEffect } from 'react';
import { reportDailyPnl } from '../../lib/risk';
import { useTradingState } from '../../lib/trading-state';

export function useRiskPnlFeed(): void {
    const trading = useTradingState();
    useEffect(() => {
        const unrealized = trading.positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
        const settle = trading.margin?.future_settle_profitloss ?? 0;
        // known：持倉與保證金都已實際讀到才算數（讀到之前的 0 不是損益）
        reportDailyPnl(unrealized + settle, trading.queries.positions.updatedAt !== null && trading.margin !== undefined);
    }, [trading.positions, trading.margin, trading.queries.positions.updatedAt]);
}
