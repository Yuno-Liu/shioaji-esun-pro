// src/mobile/lib/position-text.ts — 持倉的條件、方向、數量與對帳文字（持倉頁與自選頁「持倉」分段共用）
//
// - 原本在 routes/positions-page.tsx；自選頁的「持倉」分段（components/holdings-list.tsx）也要用同一套文字，
//   搬到這裡兩邊共用（positions-page 仍轉出同名函式，既有測試與呼叫端不變）。純函式，不發請求。

import { RECONCILE_REASON_LABELS, type TradingQueryStatus } from '../../lib/trading-state';
import type { ContractInfo } from '../../lib/types/contract';
import type { Position, StockPosition } from '../../lib/types/portfolio';
import { fmtInt, fmtStockLots } from './num-format';

export function isStockPosition(p: Position): p is StockPosition {
    return 'yd_quantity' in p;
}

const STOCK_COND_TEXT: Record<string, string> = { Cash: '現股', MarginTrading: '融資', ShortSelling: '融券' };

/** 條件欄：股票＝現股／融資／融券（其他條件原樣顯示）；期權依商品別 */
export function positionCondText(p: Position, contract?: Pick<ContractInfo, 'security_type'>): string {
    if (isStockPosition(p)) {
        const c = p.cond || 'Cash';
        return STOCK_COND_TEXT[c] ?? c;
    }
    return contract?.security_type === 'OPT' ? '選擇權' : contract?.security_type === 'FUT' ? '期貨' : '期權';
}

export function sideText(direction: string): string {
    return direction === 'Buy' ? '多' : direction === 'Sell' ? '空' : '—';
}

/** 數量：股票以股為單位（張＋股），期權為口 */
export function positionQtyText(p: Position): string {
    return isStockPosition(p) ? fmtStockLots(p.quantity) : `${fmtInt(p.quantity)} 口`;
}

/** 對帳 banner 文字；不需要時回傳 null */
export function reconcileText(q: Pick<TradingQueryStatus, 'needsReconcile' | 'error' | 'reasons'> | undefined): string | null {
    if (!q || (!q.needsReconcile && !q.error)) return null;
    const labels = (q.reasons ?? []).map(r => RECONCILE_REASON_LABELS[r]).filter(Boolean);
    const head = labels.length
        ? `待對帳：${labels.slice(0, 2).join('、')}${labels.length > 2 ? ` 等 ${labels.length} 項` : ''}`
        : q.error ? '持倉查詢失敗' : '待對帳';
    return `${head}——持倉與損益可能不完整，請按「⟳」更新後核對`;
}
