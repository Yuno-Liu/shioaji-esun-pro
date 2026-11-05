// src/mobile/components/ticket/ticket-conditions.tsx — 股票的單位與條件（設計規格 §7.4-4）
//
//   [ 整股 | 零股 ]          [ 現股 / 盤中 / ROD   ⌄ ]   ← 同列（grid 1fr 1fr）：compact 分段＋條件摘要鈕
//   ┌ 中性島（展開時）──────────────────────────────┐
//   │ 信用條件 [ 現股 | 融資 | 融券 ]   （買進時融券顯示「融券（回補）」；借券類不提供）
//   │ 交易時段 [ 盤中 | 盤後 ]           （整股的盤後＝盤後定價，不提供；零股：盤中＝IntradayOdd、盤後＝Odd）
//   │ 效期     [ ROD | IOC | FOK ]
//   │ [ 現股當沖先賣 ]                   （只在 賣出＋整股＋現股＋可當沖；已勾選時一律顯示以便取消）
//   └──────────────────────────────────────────────┘
//
// - 停用原因寫在各組下方的 footnote 並以 aria-describedby 關聯（觸控看不到 title）。
// - 展開／收合高度立即改變、內容 150ms 淡入（不做高度動畫）；箭頭旋轉 200ms（減少動態時瞬間）。
// 規則比照桌面 src/components/order-ticket.tsx:1058-1222：切換買賣不改信用條件；不合規則的組合保留並由
// use-mobile-ticket 的 ticketProblem 顯示原因（停用預覽），這裡不自動改成別的條件。

import { Check, ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { lotLabel, ODD_LOT_MAX_SHARES } from '../../../lib/odd-lot';
import { ORDER_TYPES, orderTypeDisabledReason } from '../../../lib/order-conditions';
import type { ContractInfo } from '../../../lib/types/contract';
import type { OrderType } from '../../../lib/types/order';
import { condLabel, TICKET_TEXT, type MobileTicket, type TicketCond } from '../../hooks/use-mobile-ticket';
import { focusRing, pressable } from '../../styles/primitives.css';
import * as styles from '../../styles/order-ticket.css';
import { Segmented } from '../../ui/segmented';

const CONDS: readonly TicketCond[] = ['Cash', 'MarginTrading', 'ShortSelling'];

/** 摘要列文字：「現股 / 盤中 / ROD」（勾選現沖先賣時加「現沖先賣」） */
export function conditionSummary(t: Pick<MobileTicket, 'fields'>): string {
    const { fields } = t;
    return [
        condLabel(fields.orderCond, fields.action),
        fields.orderLot === 'Odd' ? '盤後' : '盤中',
        fields.orderType,
        fields.daytradeShort && fields.action !== 'Buy' ? '現沖先賣' : null,
    ].filter(Boolean).join(' / ');
}

/** 效期分段的停用原因（去重後以「；」串接）；沒有停用段回 null */
export function orderTypeNote(odd: boolean): string | null {
    const reasons = new Set<string>();
    for (const ot of ORDER_TYPES) {
        const r = orderTypeDisabledReason(ot, odd);
        if (r) reasons.add(r);
    }
    return reasons.size > 0 ? [...reasons].join('；') : null;
}

export function TicketStockConditions({ t, contract }: { t: MobileTicket; contract: ContractInfo }) {
    const { fields, busy, odd } = t;
    const [open, setOpen] = useState(t.presetConditions);
    const sessionNoteId = useId();
    const daytradeVisible = fields.daytradeShort
        ? fields.action !== 'Buy'
        : fields.action === 'Sell' && fields.orderLot === 'Common' && fields.orderCond === 'Cash';
    const summary = conditionSummary(t);
    const typeNote = orderTypeNote(odd);

    return (
        <>
            <div className={styles.condRow}>
                <Segmented
                    semantics='toggle'
                    size='compact'
                    ariaLabel='整股或零股'
                    items={[{ value: 'Common', label: '整股' }, { value: 'Odd', label: '零股' }]}
                    value={odd ? 'Odd' : 'Common'}
                    disabled={busy}
                    onChange={v => {
                        if (v === 'Common') t.setOrderLot('Common');
                        else if (!odd) t.setOrderLot('IntradayOdd');
                    }}
                />
                <button
                    type='button'
                    className={`${styles.condSummary} ${pressable} ${focusRing}`}
                    aria-expanded={open}
                    aria-label={`交易條件：${summary}，${open ? '收合' : '展開'}`}
                    data-testid='ticket-cond-summary'
                    onClick={() => setOpen(v => !v)}
                >
                    <span className={styles.condSummaryText}>{summary}</span>
                    <ChevronDown className={styles.chevron} aria-hidden='true' focusable='false' />
                </button>
            </div>

            {open && (
                <div className={styles.condPanel} data-testid='ticket-cond-panel'>
                    <div className={styles.fieldBlock}>
                        <span className={styles.islandLabel}>信用條件</span>
                        <Segmented
                            semantics='toggle'
                            size='compact'
                            ariaLabel='信用條件'
                            items={CONDS.map(cond => ({ value: cond, label: condLabel(cond, fields.action), disabled: odd && cond !== 'Cash' }))}
                            value={fields.orderCond}
                            disabled={busy}
                            note={odd ? TICKET_TEXT.oddCreditOnly : undefined}
                            onChange={cond => t.setOrderCond(cond)}
                        />
                    </div>

                    <div className={styles.fieldBlock}>
                        <span className={styles.islandLabel}>交易時段</span>
                        <Segmented
                            semantics='toggle'
                            size='compact'
                            ariaLabel='交易時段'
                            items={[{ value: 'intraday', label: '盤中' }, { value: 'after', label: '盤後', disabled: !odd }]}
                            value={fields.orderLot === 'Odd' ? 'after' : 'intraday'}
                            disabled={busy}
                            describedBy={!odd ? sessionNoteId : undefined}
                            onChange={v => {
                                if (v === 'intraday' && fields.orderLot === 'Odd') t.setOrderLot('IntradayOdd');
                                else if (v === 'after' && fields.orderLot === 'IntradayOdd') t.setOrderLot('Odd');
                            }}
                        />
                        {!odd && <p className={styles.islandNote} id={sessionNoteId} data-testid='ticket-after-hours-note'>{TICKET_TEXT.afterHoursCommon}</p>}
                    </div>

                    <div className={styles.fieldBlock}>
                        <span className={styles.islandLabel}>效期</span>
                        <Segmented<OrderType>
                            semantics='toggle'
                            size='compact'
                            ariaLabel='效期'
                            items={ORDER_TYPES.map(ot => ({ value: ot, label: ot, disabled: !!orderTypeDisabledReason(ot, odd) }))}
                            value={fields.orderType}
                            disabled={busy}
                            note={typeNote ?? undefined}
                            onChange={ot => t.setOrderType(ot)}
                        />
                    </div>

                    {daytradeVisible && (
                        <div className={styles.fieldBlock}>
                            <button
                                type='button'
                                className={`${fields.daytradeShort ? styles.daytradeToggle.on : styles.daytradeToggle.off} ${pressable} ${focusRing}`}
                                aria-pressed={fields.daytradeShort}
                                disabled={busy || (!fields.daytradeShort && !t.daytradeShortEligible)}
                                data-testid='ticket-daytrade'
                                onClick={() => t.setDaytradeShort(!fields.daytradeShort)}
                            >
                                {fields.daytradeShort ? <Check className={styles.checkIcon} aria-hidden='true' focusable='false' /> : null}
                                {fields.daytradeShort ? '現沖先賣（當日回補）' : '現股當沖先賣'}
                            </button>
                            {contract.day_trade !== 'Yes' && (
                                <p className={styles.islandNote}>
                                    {fields.daytradeShort ? '此股票目前不可現股當沖先賣，請取消勾選' : '此股票不可現股當沖先賣'}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {odd && (
                <p className={styles.footnote} data-testid='ticket-odd-note'>
                    {lotLabel(fields.orderLot)}：以股計（1～{ODD_LOT_MAX_SHARES} 股）· 限價 ROD · 僅現股，不可融資券或當沖
                    {fields.orderLot === 'Odd' ? ` · ${TICKET_TEXT.oddAfterSession}` : ''}
                </p>
            )}
        </>
    );
}
