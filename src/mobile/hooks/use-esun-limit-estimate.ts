// src/mobile/hooks/use-esun-limit-estimate.ts — 玉山「估算剩餘」交易額度（帳戶頁額度卡、持倉頁摘要一行、下單面板共用）
//
// 計算規則見 lib/esun-limit-estimate.ts（只扣買進；已成交＋未成交；結果未知以未成交計）。
// 資料只來自既有的共用狀態：額度上限＝useTradingLimits 的快取（玉山只有上限），委託＝useTradingState().trades
// （委託查詢＋SSE 回報即時投影）。委託新增、成交、刪改單時交易狀態一更新就重算，不另發任何查詢、不送任何委託。
// 不是玉山帳戶、沒有額度資料或額度看起來是空的（模擬環境／非交易時段，limitsLookEmpty）時回 null。

import { useMemo } from 'react';
import { getCachedContract } from '../../lib/contracts-cache';
import { isEsunAccount } from '../../lib/esun/order-mapping';
import type { TradingLimits } from '../../lib/shioaji';
import { useTradingState } from '../../lib/trading-state';
import type { Account } from '../../lib/types/portfolio';
import { estimateEsunRemaining, type EsunLimitEstimate } from '../lib/esun-limit-estimate';
import { limitsLookEmpty } from './use-trading-limits';

type EstimateAccount = Pick<Account, 'broker_id' | 'account_id' | 'account_type'>;

function limitUpOf(code: string): number | undefined {
    return getCachedContract(code)?.limit_up;
}

/** 玉山證券帳戶的估算剩餘；其他情況回 null */
export function useEsunLimitEstimate(account: EstimateAccount | null | undefined, data: TradingLimits | null | undefined): EsunLimitEstimate | null {
    const { trades, queries } = useTradingState();
    const orders = queries?.orders;
    const ordersLoaded = !!orders && orders.updatedAt !== null && orders.updatedAt !== undefined;
    const reconcile = !!orders?.needsReconcile;
    const esun = !!account && account.account_type === 'S' && isEsunAccount(account);
    const limit = data?.trading_limit;
    const brokerId = account?.broker_id;
    const accountId = account?.account_id;
    const usable = esun && !!data && !limitsLookEmpty(data) && typeof limit === 'number' && Number.isFinite(limit);
    // 台北日序：跨日後下一次重繪就重算（不沿用前一日把昨天委託算成「今日」的結果）
    const taipeiDay = Math.floor((Date.now() + 8 * 3_600_000) / 86_400_000);
    return useMemo(() => {
        if (!usable || brokerId === undefined || accountId === undefined) return null;
        return estimateEsunRemaining({
            limit: limit as number,
            account: { broker_id: brokerId, account_id: accountId },
            trades: trades ?? [],
            ordersLoaded,
            ordersNeedReconcile: reconcile,
            limitUpOf,
            now: Date.now(),
        });
    }, [usable, limit, brokerId, accountId, trades, ordersLoaded, reconcile, taipeiDay]);
}
