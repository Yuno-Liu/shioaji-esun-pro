// src/mobile/lib/account-funds.ts — 帳戶頁資金與交割行事曆的純邏輯（比照桌面 src/components/bottom-dock-account.tsx）
//
// - 期貨風險指標：保證金與指標都 > 0 才有意義；< 100% 危險、< 200% 警示、其餘安全（bottom-dock-account.tsx:163-172）；
//   色條寬度＝min(100, 指標 ÷ 300 × 100)%（:248-258）。
// - 交割行事曆：固定 T+0／T+1／T+2 三列，沒有資料的列補 0（:320-338）。
// - 股票資產市值＝Σ清算價值＋未交割款＋交割戶餘額；有任何待確認原因（快照跨日、成交後未更新、
//   清算價值或未交割款缺）就不給合計（:174-184）。

import { bizDateLabel, settleDateLabel } from '../../lib/settle-date';
import type { Settlement } from '../../lib/shioaji';
import type { Margin } from '../../lib/types/portfolio';

export type RiskLevel = 'none' | 'danger' | 'warn' | 'safe';

export interface MarginRisk {
    /** 原始保證金與風險指標都 > 0 */
    meaningful: boolean;
    value: number;
    level: RiskLevel;
    /** 色條寬度（0–100） */
    barPercent: number;
}

export function marginRisk(margin: Pick<Margin, 'initial_margin' | 'risk_indicator'> | null | undefined): MarginRisk {
    const meaningful = !!margin && margin.initial_margin > 0 && margin.risk_indicator > 0;
    const value = margin?.risk_indicator ?? 0;
    if (!meaningful) return { meaningful: false, value, level: 'none', barPercent: 0 };
    return {
        meaningful,
        value,
        level: value < 100 ? 'danger' : value < 200 ? 'warn' : 'safe',
        barPercent: Math.max(0, Math.min(100, (value / 300) * 100)),
    };
}

/** 模擬環境的保證金：主要欄位全 0（上游行為：sidecar 不打真 API） */
export function marginLooksBlank(margin: Pick<Margin, 'equity' | 'initial_margin' | 'available_margin' | 'today_balance'> | null | undefined): boolean {
    return !!margin && margin.equity === 0 && margin.initial_margin === 0 && margin.available_margin === 0 && margin.today_balance === 0;
}

export interface SettlementSlot {
    t: 0 | 1 | 2;
    /** MM/DD (週X)；server 沒回該列時為本地推算的營業日 */
    dateLabel: string;
    amount: number;
    /** server 有回這一列 */
    reported: boolean;
}

/** 固定 T+0／T+1／T+2 三列（沒有資料補 0） */
export function settlementSlots(rows: readonly Settlement[] | null | undefined, nowMs: number = Date.now()): SettlementSlot[] {
    const byT = new Map((rows ?? []).map(r => [r.T, r]));
    return ([0, 1, 2] as const).map(t => {
        const hit = byT.get(t);
        return {
            t,
            dateLabel: hit ? settleDateLabel(hit.date) : bizDateLabel(t, nowMs),
            amount: hit && Number.isFinite(hit.amount) ? hit.amount : 0,
            reported: !!hit,
        };
    });
}

export interface StockAssetInput {
    /** 交割戶餘額；未取得為 null */
    cash: number | null;
    /** Σ清算價值與是否有列無法計算 */
    liquidation: { value: number; incomplete: boolean };
    /** 未交割款；未取得或無法解析為 null */
    pending: number | null;
    /** 交割款快照之後持倉已變動 */
    settlementsStale: boolean;
    /** 交割戶餘額或交割款為前一日資料 */
    priorDay: boolean;
}

export interface StockAssetSummary {
    /** 資產市值；有待確認原因時為 null */
    total: number | null;
    reasons: string[];
}

export function stockAssetSummary(input: StockAssetInput): StockAssetSummary {
    const reasons = [
        input.cash === null && '交割戶餘額尚未取得',
        input.settlementsStale && '成交後交割款尚未更新，請按更新交割款',
        input.priorDay && '交割戶餘額或交割款為前一日資料，請更新',
        (input.liquidation.incomplete || input.pending === null) && '部分部位清算價值或未交割款尚未取得',
    ].filter((r): r is string => !!r);
    if (reasons.length > 0) return { total: null, reasons };
    return { total: input.liquidation.value + (input.pending ?? 0) + (input.cash ?? 0), reasons };
}

/** 股票部位種類文字（現股／現股賣／融資／融券） */
export function stockPositionKind(p: { cond?: string; direction: string }): string {
    const cond = p.cond || 'Cash';
    if (cond === 'Cash') return p.direction === 'Buy' ? '現股' : '現股賣';
    if (cond === 'MarginTrading') return '融資';
    if (cond === 'ShortSelling') return '融券';
    return cond;
}
