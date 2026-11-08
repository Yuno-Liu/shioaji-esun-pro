// src/mobile/components/trade-info/trade-info-strip.tsx — 交易頁「當沖資訊列」（設計規格 §7.3）
//
// 標頭（統計格、漲跌停列）之下的一顆整列按鈕，膠囊可換行、不截斷，依序：
//   可當沖／先賣 → 漲跌停狀態 → 日內振幅位置（小條）→ 量比 → 處置。
// 只有股票顯示當沖、量比、處置；期權與指數只顯示適用的項目（lib/trade-info）。
// 點擊只開唯讀的「籌碼與當沖」說明面板（交易安全 S1：不呼叫 openTicket／openOrderAction 或任何送單函式）。
// 資料全部來自標頭已有的報價、快照與合約，不發新請求；只有價位在停板時才讀完整報價（含五檔）判斷是否鎖住，
// 與五檔共用同一檔的訂閱（refcount），平常資訊列不隨五檔重繪。
// 報價與合約不是同一交易日（quoteRef 與合約參考價差半個跳動以上；lib/trade-info sameTradingDay）時不判停板、
// 小條改畫最低到最高、振幅以報價自身的參考價計（同桌面 quote-board）。

import type { ReactNode } from 'react';
import { useQuote } from '../../../hooks/use-stream';
import type { ContractInfo } from '../../../lib/types/contract';
import {
    dayTradeChip,
    infoChips,
    limitChip,
    limitKind,
    limitNeedsBook,
    punishChip,
    rangeChip,
    rangeInfo,
    rangePositionText,
    ratioChip,
    sameTradingDay,
    volumeRatio,
    type InfoChip,
    type RangeInfo,
} from '../../lib/trade-info';
import type { HeaderStats } from '../../lib/quote-display';
import { srOnly } from '../../styles/primitives.css';
import * as styles from '../../styles/trade-info.css';

export interface TradeInfoStripProps {
    code: string;
    contract: ContractInfo;
    /** 標頭主價（headerQuote） */
    price: number | null;
    /** 主價來自成交或快照（參考價、指數不判斷漲跌停） */
    priceIsTrade: boolean;
    /** 報價自身的參考價（現價 − 串流或快照的漲跌）；沒有時 undefined */
    quoteRef?: number;
    /** 標頭統計格（開高低、參考價、累計量與來源） */
    stats: Pick<HeaderStats, 'source' | 'open' | 'high' | 'low' | 'reference' | 'totalVolume'>;
    /** 採用的真實成交日期（量比比對快照日期） */
    tickDate?: string;
    snapshot?: { datetime?: string; yesterday_volume?: number };
    /** 是否在處置名單（非股票、尚未取得為 null） */
    punished: boolean | null;
    /** 面板是否開啟（aria-expanded） */
    open: boolean;
    onOpen: () => void;
}

const pct = (v: number) => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(1)}%`;

function RangeBar({ info }: { info: RangeInfo }) {
    const { bar } = info;
    return (
        <span className={styles.bar} aria-hidden='true' data-testid='trade-info-bar' data-mode={bar.mode}>
            <span className={styles.barSpan[bar.dir ?? 'flat']} style={{ left: pct(bar.low), width: pct(bar.high - bar.low) }} />
            {bar.reference !== null && <span className={styles.barRef} />}
            <span className={styles.barMark} style={{ left: pct(bar.close) }} />
        </span>
    );
}

function Chip({ chip, children }: { chip: InfoChip; children?: ReactNode }) {
    const strong = chip.key === 'limit' && (chip.tone === 'up' || chip.tone === 'down');
    return (
        <span className={`${styles.chip[chip.tone]}${strong ? ` ${styles.chipStrong}` : ''}`} data-testid={`trade-info-${chip.key}`}>
            {children}
            {chip.text}
        </span>
    );
}

/** 價位在停板：讀完整報價（含五檔）判斷鎖住與否；只在這時掛載 */
function LimitChipWithBook({ code, contract, price }: { code: string; contract: ContractInfo; price: number }) {
    const quote = useQuote(code);
    const chip = limitChip(limitKind(contract, price, true, quote?.bidask));
    return chip ? <Chip chip={chip} /> : null;
}

export function TradeInfoStrip({ code, contract, price, priceIsTrade, quoteRef, stats, tickDate, snapshot, punished, open, onOpen }: TradeInfoStripProps) {
    const st = contract.security_type;
    const sameDay = sameTradingDay(contract, quoteRef);
    const kind = limitKind(contract, price, priceIsTrade && sameDay);
    const range = rangeInfo(
        contract,
        { reference: sameDay ? stats.reference : quoteRef ?? null, open: stats.open, high: stats.high, low: stats.low, close: price },
        sameDay,
    );
    const ratio = volumeRatio({ secType: st, totalVolume: stats.totalVolume, source: stats.source, tickDate, snapshot });
    const dayTrade = dayTradeChip(st, contract.day_trade);
    const limit = limitChip(kind);
    const rangeC = rangeChip(range);
    const chips = infoChips(dayTrade, limit, rangeC, ratioChip(ratio), punishChip(st, punished));
    // 指數沒有任何項目時不佔版面；股票、期權一律顯示（面板有融資融券、當沖規則）
    if (st === 'IND' && chips.length === 0) return null;

    return (
        <button
            type='button'
            className={styles.strip}
            onClick={() => onOpen()}
            aria-haspopup='dialog'
            aria-expanded={open}
            data-testid='trade-info-strip'
        >
            {chips.map(c => {
                if (c.key === 'limit' && limitNeedsBook(kind) && price !== null) {
                    return <LimitChipWithBook key='limit' code={code} contract={contract} price={price} />;
                }
                if (c.key === 'range' && range) {
                    return (
                        <Chip key='range' chip={c}>
                            <RangeBar info={range} />
                            <span className={srOnly}>{`${rangePositionText(range)}，`}</span>
                        </Chip>
                    );
                }
                return <Chip key={c.key} chip={c} />;
            })}
            {chips.length === 0 && <span className={styles.chip.neutral}>籌碼與當沖</span>}
            <span className={styles.more} aria-hidden='true'>說明 ›</span>
            <span className={srOnly}>，開啟籌碼與當沖說明</span>
        </button>
    );
}
