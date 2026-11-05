// src/mobile/components/depth-ladder.tsx — 五檔價格梯（規格 §6.2）
//
//  委買量    價格     委賣量
//            1,087      30
//            1,085      88   ← 賣一
//   120     1,084            ← 買一
//
// - 資料：useQuote(code) 的 BidAsk；盤中零股切換時改用 useQuote(code, { oddLot: true })（量以股計）。
// - 點任一價位 → openTicket({ code, price })：只帶價，不決定買賣，也不會送單。
// - 自己的未成交限價委託在對應價位標示「我 買2」（整股五檔只算整股委託，零股五檔只算零股委託）。

import { useMemo, useState } from 'react';
import { useQuote } from '../../hooks/use-stream';
import type { ContractInfo } from '../../lib/types/contract';
import type { AccountedTrade } from '../../lib/types/order';
import { fmtCompactInt } from '../../lib/utils/format';
import { formatToTick } from '../../lib/utils/ticksize';
import { depthMarkText, depthOrderMarks, priceKey } from '../lib/chart-model';
import { openTicket } from '../lib/mobile-store';
import * as styles from '../styles/trade.css';

export interface DepthLevel {
    side: 'ask' | 'bid';
    /** 1 = 最佳一檔 */
    level: number;
    price: number;
    volume: number;
}

/** BidAsk → 由上而下的列：賣五…賣一、買一…買五（價格 ≤ 0 的空檔不列） */
export function depthLevels(bidask: { bid_price: readonly (string | number)[]; bid_volume: readonly number[]; ask_price: readonly (string | number)[]; ask_volume: readonly number[] } | undefined): DepthLevel[] {
    if (!bidask) return [];
    const asks: DepthLevel[] = [];
    for (let i = 0; i < bidask.ask_price.length && i < 5; i++) {
        const price = Number(bidask.ask_price[i]);
        if (Number.isFinite(price) && price > 0) asks.push({ side: 'ask', level: i + 1, price, volume: bidask.ask_volume[i] ?? 0 });
    }
    const bids: DepthLevel[] = [];
    for (let i = 0; i < bidask.bid_price.length && i < 5; i++) {
        const price = Number(bidask.bid_price[i]);
        if (Number.isFinite(price) && price > 0) bids.push({ side: 'bid', level: i + 1, price, volume: bidask.bid_volume[i] ?? 0 });
    }
    return [...asks.reverse(), ...bids];
}

function priceTone(price: number, reference: number | undefined): 'up' | 'down' | 'flat' {
    if (!reference || reference <= 0) return 'flat';
    return price > reference ? 'up' : price < reference ? 'down' : 'flat';
}

export function DepthLadder({ code, contract, trades }: { code: string; contract: ContractInfo | undefined; trades: readonly AccountedTrade[] }) {
    // 盤中零股只對股票（整股與零股分開撮合、量以股計）
    const oddCapable = contract?.security_type === 'STK';
    const [oddPref, setOddPref] = useState(false);
    const oddLot = oddCapable && oddPref;
    const quote = useQuote(code, { oddLot });
    const levels = useMemo(() => depthLevels(quote?.bidask), [quote?.bidask]);
    const orderable = contract ? contract.target_code || contract.code : code;
    const marks = useMemo(() => depthOrderMarks(orderable, trades, oddLot), [orderable, trades, oddLot]);
    const unit = oddLot ? '股' : contract?.security_type === 'STK' ? '張' : contract ? '口' : '';
    const fmt = (p: number) => (contract ? formatToTick(contract, p) : String(p));

    return (
        <div className={styles.ladder} data-testid='depth-ladder'>
            {oddCapable && (
                <div className={styles.ladderToolbar}>
                    <button type='button' className={styles.toggle} aria-pressed={!oddLot} onClick={() => setOddPref(false)}>整股</button>
                    <button type='button' className={styles.toggle} aria-pressed={oddLot} onClick={() => setOddPref(true)} data-testid='depth-odd-toggle'>盤中零股</button>
                </div>
            )}
            <div className={styles.ladderHead} aria-hidden='true'>
                <span>委買量{unit && `（${unit}）`}</span>
                <span>價格</span>
                <span>委賣量{unit && `（${unit}）`}</span>
            </div>
            {levels.length === 0 && <p className={styles.emptyText}>尚無五檔報價</p>}
            {levels.map(l => {
                const mine = depthMarkText(marks.get(priceKey(l.price)));
                const sideText = l.level === 1 ? (l.side === 'ask' ? '賣一' : '買一') : null;
                const price = fmt(l.price);
                const vol = fmtCompactInt(l.volume);
                return (
                    <button
                        key={`${l.side}${l.level}`}
                        type='button'
                        className={styles.ladderRow}
                        onClick={() => openTicket({ code, price: l.price, source: 'depth' })}
                        aria-label={`${l.side === 'ask' ? '委賣' : '委買'}第${l.level}檔 ${price}，量 ${vol}${mine ? `，${mine}` : ''}。帶入下單面板`}
                        data-testid={`depth-${l.side}-${l.level}`}
                    >
                        <span className={styles.ladderVol}>{l.side === 'bid' ? vol : ''}</span>
                        <span className={`${styles.ladderPrice} ${styles.dirText[priceTone(l.price, contract?.reference)]}`}>
                            {price}
                            {sideText && <span className={styles.ladderSideTag}>{sideText}</span>}
                            {mine && <span className={styles.ladderMine} data-testid='depth-mine'>{mine}</span>}
                        </span>
                        <span className={styles.ladderVol}>{l.side === 'ask' ? vol : ''}</span>
                    </button>
                );
            })}
        </div>
    );
}
