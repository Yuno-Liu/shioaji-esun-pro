// src/mobile/components/company/live-price.ts — 公司分頁的價格（標頭、市值、本益比、股價淨值比共用）
//
// 股票用本頁已訂閱的同一檔報價（refcount 共用，不新增訂閱）與快照 store；個股期權的標的公司同桌面訂閱標的報價。
// 分頁隱藏（active=false）時呼叫 useQuote(null)、不讀快照，不隨成交重繪；沒有即時成交時用 shioaji-data 每日收盤。
// 只在小元件內呼叫（SummaryCard、估值卡的 P/B 格），每筆成交只重繪呼叫它的元件。

import { useSyncExternalStore } from 'react';
import { useQuote } from '../../../hooks/use-stream';
import type { MarketDaily } from '../../../lib/company-data/types';
import { getMarketSnapshot, subscribeMarketSnapshots } from '../../../lib/market-snapshot-store';
import type { ContractInfo } from '../../../lib/types/contract';
import { headerQuote } from '../../lib/quote-display';

export interface LivePrice {
    price: number | null;
    change: number | null;
    pct: number | null;
    /** null＝即時（成交或快照）；否則為每日收盤的日期 */
    closeDate: string | null;
}

export function useLivePrice(contract: ContractInfo, sameCode: boolean, active: boolean, code: string, market: MarketDaily | null): LivePrice {
    // 股票：本頁同一檔（refcount 共用）；個股期權：同桌面訂閱標的公司的報價（code）。
    // 分頁隱藏時傳 null（不跟著成交重繪；股票的標頭仍持有同一檔的 refcount，標的報價則釋放）
    const live = sameCode && active;
    const underlyingLive = !sameCode && active;
    const quote = useQuote(live ? contract.code : underlyingLive ? code : null, { narrow: true });
    const snapshot = useSyncExternalStore(subscribeMarketSnapshots, () => (live ? getMarketSnapshot(contract) : undefined));
    if (live || underlyingLive) {
        // 標的：沒有合約參考價（漲跌幅以串流自身的參考計算，同 headerQuote）、不讀衍生商品的快照
        const q = headerQuote({ reference: live ? contract.reference : undefined, tick: quote?.tick, index: quote?.index, snapshot });
        if ((q.source === 'tick' || q.source === 'snapshot') && q.price !== null) {
            return { price: q.price, change: q.change, pct: q.pct, closeDate: null };
        }
    }
    const daily = market?.quotes[code];
    return { price: daily?.close ?? null, change: null, pct: null, closeDate: daily?.date ?? null };
}
