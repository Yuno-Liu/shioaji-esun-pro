// src/mobile/components/depth-ladder.tsx — 五檔（買賣同列；規格 §6.2）
//
//  內外盤比 ███████░░░░  58%（內盤）／42%（外盤）     ← 串流有內外盤量時（交易頁與下單面板內嵌都顯示）
//  委買量 │ 買價  │ 賣價  │ 委賣量
//  ▒▒120  │ 1,084 │ 1,085 │   88▒▒   ← 第 i 列＝買 i 與賣 i；量條（VolumeBar）從中線往外長
//    …（5 列）
//    316  │   五檔總量    │  173     ← 買量總和／賣量總和
//  買 65% ████████░░░░ 35% 賣        ← RatioBar（scaleX）
//
// - 資料：useQuote(code) 的 BidAsk；盤中零股時改用 useQuote(code, { oddLot: true })（量以股計）。
//   variant 'page'（交易頁）可切換整股／盤中零股（Segmented toggle）；variant 'ticket'（下單面板內嵌）不顯示切換，由 oddLot prop 決定。
// - 買價、賣價各是獨立的點擊目標：onPick(price, side)，缺省＝openTicket({ code, price, source: 'depth' })
//   ——只帶價，不決定買賣，也不會送單。
// - 自己的未成交限價委託標在該價位所在的那一側（「我 買2」；整股五檔只算整股委託，零股五檔只算零股委託）。

import { useMemo, useRef, useState } from 'react';
import { useQuote } from '../../hooks/use-stream';
import type { ContractInfo } from '../../lib/types/contract';
import type { SseTick } from '../../lib/types/market';
import type { AccountedTrade } from '../../lib/types/order';
import { fmtCompactInt } from '../../lib/utils/format';
import { formatToTick } from '../../lib/utils/ticksize';
import { depthMarkText, depthOrderMarks, priceKey } from '../lib/chart-model';
import { openTicket } from '../lib/mobile-store';
import { innerOuterRatio, splitPercent, toneVsReference, volumeUnit, type SplitPercent } from '../lib/quote-display';
import * as styles from '../styles/trade.css';
import { RatioBar as RatioTrack, VolumeBar } from '../ui/bars';
import { Segmented } from '../ui/segmented';

export const DEPTH_LEVELS = 5;

export interface DepthQuote {
    price: number;
    volume: number;
}

export interface DepthRow {
    /** 1 = 最佳一檔 */
    level: number;
    bid: DepthQuote | null;
    ask: DepthQuote | null;
}

export interface DepthBook {
    /** 固定 5 列；價格 ≤ 0 或缺漏的檔位為 null */
    rows: DepthRow[];
    bidTotal: number;
    askTotal: number;
    /** 買賣兩側都沒有任何有效檔位 */
    empty: boolean;
}

type BidAskLike = { bid_price: readonly (string | number)[]; bid_volume: readonly number[]; ask_price: readonly (string | number)[]; ask_volume: readonly number[] };

function quoteAt(prices: readonly (string | number)[], volumes: readonly number[], i: number): DepthQuote | null {
    const price = Number(prices[i]);
    if (!Number.isFinite(price) || price <= 0) return null;
    const v = Number(volumes[i] ?? 0);
    return { price, volume: Number.isFinite(v) && v > 0 ? v : 0 };
}

/** BidAsk → 5 列（第 i 列＝買 i、賣 i）與兩側總量 */
export function depthBook(bidask: BidAskLike | undefined): DepthBook {
    const rows: DepthRow[] = [];
    let bidTotal = 0;
    let askTotal = 0;
    let any = false;
    for (let i = 0; i < DEPTH_LEVELS; i++) {
        const bid = bidask ? quoteAt(bidask.bid_price, bidask.bid_volume, i) : null;
        const ask = bidask ? quoteAt(bidask.ask_price, bidask.ask_volume, i) : null;
        if (bid) { bidTotal += bid.volume; any = true; }
        if (ask) { askTotal += ask.volume; any = true; }
        rows.push({ level: i + 1, bid, ask });
    }
    return { rows, bidTotal, askTotal, empty: !any };
}

export interface DepthLadderProps {
    code: string;
    contract: ContractInfo | undefined;
    trades: readonly AccountedTrade[];
    /**
     * 點價位時的處理；缺省＝開啟下單面板並帶入價格（交易頁）。
     * 下單面板內嵌五檔時傳入，只把價格帶進面板（不決定買賣、不送單）。
     */
    onPick?: (price: number, side: 'bid' | 'ask') => void;
    /** 'ticket'＝內嵌在下單面板（較精簡、不顯示整股／零股切換，由面板的單位決定） */
    variant?: 'page' | 'ticket';
    /** variant 'ticket' 時由面板指定是否看盤中零股五檔 */
    oddLot?: boolean;
}

/** 五檔兩側的最大單檔量（量條的分母）；沒有量時為 0 */
export function depthMaxVolume(book: DepthBook): number {
    let max = 0;
    for (const r of book.rows) {
        if (r.bid && r.bid.volume > max) max = r.bid.volume;
        if (r.ask && r.ask.volume > max) max = r.ask.volume;
    }
    return max;
}

/** 比例條（左右兩段＋文字百分比；條為 ui/bars 的 RatioBar，scaleX、不依賴 color-mix 等新語法） */
function RatioBar({ split, leftText, rightText, label, testId }: { split: SplitPercent; leftText: string; rightText: string; label: string; testId: string }) {
    return (
        <div className={styles.ratio} data-testid={testId} role='img' aria-label={`${label}：${leftText} ${split.leftPct}%，${rightText} ${split.rightPct}%`}>
            <span className={`${styles.ratioText} ${styles.dirText.up}`} data-testid={`${testId}-left`}>{leftText} {split.leftPct}%</span>
            <span className={styles.ratioTrack}>
                <RatioTrack left={split.leftPct} right={split.rightPct} leftTone='up' rightTone='down' />
            </span>
            <span className={`${styles.ratioText} ${styles.dirText.down}`} data-testid={`${testId}-right`}>{split.rightPct}% {rightText}</span>
        </div>
    );
}

/** 內外盤比：內盤＝以買價成交（賣方主動，用 down 色）、外盤＝以賣價成交（買方主動，用 up 色）；文字標示不只靠顏色 */
function InnerOuterBar({ split }: { split: SplitPercent }) {
    return (
        <div className={styles.innerOuter} data-testid='depth-inner-outer' role='img' aria-label={`內外盤比：內盤 ${split.leftPct}%，外盤 ${split.rightPct}%`}>
            <span className={styles.innerOuterLabel}>內外盤比</span>
            <span className={`${styles.ratioText} ${styles.dirText.down}`} data-testid='depth-inner'>{split.leftPct}%（內盤）</span>
            <span className={styles.ratioTrack}>
                <RatioTrack left={split.leftPct} right={split.rightPct} leftTone='down' rightTone='up' testId='depth-inner-outer-bar' />
            </span>
            <span className={`${styles.ratioText} ${styles.dirText.up}`} data-testid='depth-outer'>{split.rightPct}%（外盤）</span>
        </div>
    );
}

const ODD_ITEMS = [
    { value: 'whole', label: '整股' },
    { value: 'odd', label: '盤中零股', testId: 'depth-odd-toggle' },
] as const;

export function DepthLadder({ code, contract, trades, onPick, variant = 'page', oddLot: oddLotProp }: DepthLadderProps) {
    const ticket = variant === 'ticket';
    // 盤中零股只對股票（整股與零股分開撮合、量以股計）
    const oddCapable = contract?.security_type === 'STK';
    const [oddPref, setOddPref] = useState(false);
    const oddLot = oddCapable && (ticket ? oddLotProp === true : oddPref);
    const quote = useQuote(code, { oddLot });
    const book = useMemo(() => depthBook(quote?.bidask), [quote?.bidask]);
    const orderable = contract ? contract.target_code || contract.code : code;
    const marks = useMemo(() => depthOrderMarks(orderable, trades, oddLot), [orderable, trades, oddLot]);
    const unit = contract ? volumeUnit(contract.security_type, oddLot) : '';
    const fmt = (p: number) => (contract ? formatToTick(contract, p) : String(p));
    const reference = contract?.reference;

    // 內外盤比：試撮期間沿用本元件看過的上一筆真實成交（換商品或整股／零股時重來）
    const lastReal = useRef<{ code: string; oddLot: boolean; tick: SseTick } | null>(null);
    const tick = quote?.tick;
    if (tick && !tick.simtrade) lastReal.current = { code, oddLot, tick };
    const realTick = lastReal.current?.code === code && lastReal.current.oddLot === oddLot ? lastReal.current.tick : undefined;
    // 下單面板內嵌也顯示（設計規格 §7.3、§7.4-11）
    const innerOuter = innerOuterRatio(realTick);
    const bidAsk = splitPercent(book.bidTotal, book.askTotal);
    const maxVolume = depthMaxVolume(book);

    // 盤中零股五檔的價位屬零股撮合簿：面板以盤中零股開啟（整股模式不帶 lot，沿用面板預設）
    const pick = (price: number, side: 'bid' | 'ask') => (onPick
        ? onPick(price, side)
        : openTicket({ code, price, source: 'depth', ...(oddLot ? { lot: 'IntradayOdd' as const } : {}) }));

    const cell = (side: 'bid' | 'ask', level: number, q: DepthQuote | null) => {
        const testId = `depth-${side}-${level}`;
        if (!q) {
            return <div key={side} className={styles.depthCell[side]} data-testid={testId} aria-hidden='true' />;
        }
        const mine = depthMarkText(marks.get(priceKey(q.price)));
        const price = fmt(q.price);
        const vol = fmtCompactInt(q.volume);
        const sideText = side === 'bid' ? '委買' : '委賣';
        const priceEl = (
            <span className={`${styles.depthPrice[side]} ${level === 1 ? styles.depthBest : ''} ${styles.dirText[toneVsReference(q.price, reference)]}`}>
                {price}
                {mine && <span className={styles.ladderMine} data-testid='depth-mine'>{mine}</span>}
            </span>
        );
        const volEl = <span className={styles.depthVol[side]}>{vol}</span>;
        return (
            <button
                key={side}
                type='button'
                className={styles.depthCell[side]}
                onClick={() => pick(q.price, side)}
                aria-label={`${sideText}第${level}檔 ${price}，量 ${vol}${unit ? ` ${unit}` : ''}${mine ? `，${mine}` : ''}。${ticket ? '帶入價格' : '帶入下單面板'}`}
                data-testid={testId}
            >
                {/* 量條從中線往外長：買側 origin right、賣側 origin left（純視覺，aria-hidden） */}
                <VolumeBar value={q.volume} max={maxVolume} side={side === 'bid' ? 'buy' : 'sell'} />
                {side === 'bid' ? <>{volEl}{priceEl}</> : <>{priceEl}{volEl}</>}
            </button>
        );
    };

    return (
        <div className={ticket ? styles.ladderCompact : styles.ladder} data-testid='depth-ladder' data-variant={variant}>
            {!ticket && oddCapable && (
                <div className={styles.ladderToolbar}>
                    <div className={styles.ladderToolbarControl}>
                        <Segmented
                            items={ODD_ITEMS}
                            value={oddLot ? 'odd' : 'whole'}
                            onChange={v => setOddPref(v === 'odd')}
                            semantics='toggle'
                            ariaLabel='五檔：整股或盤中零股'
                            size='compact'
                        />
                    </div>
                </div>
            )}
            {innerOuter && <InnerOuterBar split={innerOuter} />}
            <div className={styles.depthHead} aria-hidden='true'>
                <span className={styles.depthHeadVol}>委買量</span>
                <span className={styles.depthHeadPrice}>買價</span>
                <span className={styles.depthHeadPrice}>賣價</span>
                <span className={styles.depthHeadVolRight}>委賣量</span>
            </div>
            {book.empty
                ? <p className={styles.emptyText}>尚無五檔報價</p>
                : (
                    <>
                        {book.rows.map(r => (
                            <div key={r.level} className={styles.depthRow} data-testid={`depth-row-${r.level}`}>
                                {cell('bid', r.level, r.bid)}
                                {cell('ask', r.level, r.ask)}
                            </div>
                        ))}
                        <div className={styles.depthTotal} data-testid='depth-total' aria-label={`五檔總量：委買 ${fmtCompactInt(book.bidTotal)}，委賣 ${fmtCompactInt(book.askTotal)}${unit ? ` ${unit}` : ''}`}>
                            <span className={styles.depthTotalVol} data-testid='depth-total-bid'>{fmtCompactInt(book.bidTotal)}</span>
                            <span className={styles.depthTotalLabel}>五檔總量{unit && `（${unit}）`}</span>
                            <span className={styles.depthTotalVolRight} data-testid='depth-total-ask'>{fmtCompactInt(book.askTotal)}</span>
                        </div>
                        {bidAsk && <RatioBar split={bidAsk} leftText='買' rightText='賣' label='五檔買賣比' testId='depth-ratio' />}
                    </>
                )}
        </div>
    );
}
