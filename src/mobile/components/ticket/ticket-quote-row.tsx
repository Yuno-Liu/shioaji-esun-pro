// src/mobile/components/ticket/ticket-quote-row.tsx — 下單面板的精簡報價（中性島；設計規格 §7.4-2）
//
//   ▲1,085   ▲+15 +1.40%   快照                 單:46　總:36,368 張
//
// - 商品名稱與代碼已在面板標題，這裡不再重複。
// - 價格來源與漲跌計算沿用 lib/quote-display.ts 的 headerQuote（排除試撮、成交早於快照時用快照、最後才用參考價）。
// - 成交價相對參考價著色（vars.color.up／down）並加 ▲▼ 符號（不只靠顏色）；漲跌色小字只放在中性島內（§4.8 規則 7）。
// - 「單」＝最近一筆真實成交的單量；「總」＝累計成交量。股票整股以張、期權以口。文字格式不變。

import { useRef } from 'react';
import { useQuote } from '../../../hooks/use-stream';
import type { ContractInfo } from '../../../lib/types/contract';
import type { Snapshot } from '../../../lib/types/market';
import { formatToTick } from '../../../lib/utils/ticksize';
import { headerQuote, type HeaderTick } from '../../lib/quote-display';
import * as styles from '../../styles/order-ticket.css';

const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US');

export function TicketQuoteRow({ contract, snapshot }: { contract: ContractInfo; snapshot: Snapshot | null | undefined }) {
    const quote = useQuote(contract.code);
    const tick = quote?.tick as (HeaderTick & { volume?: number }) | undefined;
    const lastReal = useRef<(HeaderTick & { volume?: number }) | undefined>(undefined);
    if (tick && tick.simtrade !== true && Number(tick.close) > 0) lastReal.current = tick;
    const reference = Number(contract.reference) > 0 ? Number(contract.reference) : undefined;
    const q = headerQuote({ reference, tick, lastRealTick: lastReal.current, snapshot: snapshot ?? undefined });
    const sign = q.dir === 'up' ? '▲' : q.dir === 'down' ? '▼' : '';
    const plus = (v: number) => (v > 0 ? '+' : '');
    const single = q.source === 'tick' ? Number(lastReal.current?.volume) : NaN;
    const unit = contract.security_type === 'STK' || contract.security_type === 'WRT' ? '張' : '口';

    return (
        <div className={styles.quoteRow} data-testid='ticket-quote'>
            <span className={styles.quoteMain}>
                <span className={styles.quotePrice[q.dir]} data-testid='ticket-quote-price'>
                    {q.price === null ? '—' : `${sign}${formatToTick(contract, q.price)}`}
                </span>
                {q.change !== null && (
                    <span className={styles.quoteChange[q.dir]} data-testid='ticket-quote-change'>
                        {sign}{plus(q.change)}{formatToTick(contract, q.change, { at: q.price ?? undefined })}
                        {q.pct !== null && ` ${plus(q.pct)}${q.pct.toFixed(2)}%`}
                    </span>
                )}
                {q.source === 'reference' && <span className={styles.muted}>參考價</span>}
                {q.source === 'snapshot' && <span className={styles.muted}>快照</span>}
            </span>
            <span className={styles.quoteVolume} data-testid='ticket-quote-volume'>
                單:{Number.isFinite(single) && single > 0 ? fmtInt(single) : '—'}　總:{q.totalVolume !== null ? fmtInt(q.totalVolume) : '—'} {unit}
            </span>
        </div>
    );
}
