// src/mobile/components/ticket/ticket-conditions.tsx — 股票的單位與條件（整股／零股、信用、盤中／盤後、效期、現沖先賣）
//
//   [ 整股 | 零股 ]
//   [ 現股 / 盤中 / ROD                 ▾ ]   ← 摘要列，點開三組分段
//     信用條件 [ 現股 | 融資 | 融券 ]          （買進時融券顯示「融券（回補）」；借券類不提供，§12）
//     交易時段 [ 盤中 | 盤後 ]                 （整股的盤後＝盤後定價，不提供；零股：盤中＝IntradayOdd、盤後＝Odd）
//     效期     [ ROD | IOC | FOK ]
//     [ 現股當沖先賣 ]                         （只在 賣出＋整股＋現股＋可當沖；已勾選時一律顯示以便取消）
//
// 規則比照桌面 src/components/order-ticket.tsx:1058-1222：切換買賣不改信用條件；不合規則的組合保留並由
// use-mobile-ticket 的 ticketProblem 顯示原因（停用預覽），這裡不自動改成別的條件。

import { useState } from 'react';
import { lotLabel, ODD_LOT_MAX_SHARES } from '../../../lib/odd-lot';
import { ORDER_TYPES, orderTypeDisabledReason } from '../../../lib/order-conditions';
import type { ContractInfo } from '../../../lib/types/contract';
import { condLabel, TICKET_TEXT, type MobileTicket, type TicketCond } from '../../hooks/use-mobile-ticket';
import * as styles from '../../styles/order-ticket.css';

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

export function TicketStockConditions({ t, contract }: { t: MobileTicket; contract: ContractInfo }) {
    const { fields, busy, odd } = t;
    const [open, setOpen] = useState(t.presetConditions);
    const daytradeVisible = fields.daytradeShort
        ? fields.action !== 'Buy'
        : fields.action === 'Sell' && fields.orderLot === 'Common' && fields.orderCond === 'Cash';

    return (
        <>
            <div className={styles.segmented} role='group' aria-label='整股或零股'>
                <button
                    type='button'
                    className={!odd ? styles.seg.on : styles.seg.off}
                    aria-pressed={!odd}
                    disabled={busy}
                    onClick={() => t.setOrderLot('Common')}
                >
                    整股
                </button>
                <button
                    type='button'
                    className={odd ? styles.seg.on : styles.seg.off}
                    aria-pressed={odd}
                    disabled={busy}
                    onClick={() => { if (!odd) t.setOrderLot('IntradayOdd'); }}
                >
                    零股
                </button>
            </div>

            <button
                type='button'
                className={styles.condSummary}
                aria-expanded={open}
                aria-label={`交易條件：${conditionSummary(t)}，${open ? '收合' : '展開'}`}
                data-testid='ticket-cond-summary'
                onClick={() => setOpen(v => !v)}
            >
                <span>{conditionSummary(t)}</span>
                <span aria-hidden='true'>{open ? '▴' : '▾'}</span>
            </button>

            {open && (
                <div className={styles.condPanel} data-testid='ticket-cond-panel'>
                    <div className={styles.fieldBlock}>
                        <span className={styles.fieldLabel}>信用條件{odd ? '（零股只能現股）' : ''}</span>
                        <div className={styles.segmented} role='group' aria-label='信用條件'>
                            {CONDS.map(cond => {
                                const blocked = odd && cond !== 'Cash';
                                return (
                                    <button
                                        key={cond}
                                        type='button'
                                        className={fields.orderCond === cond ? styles.seg.on : styles.seg.off}
                                        aria-pressed={fields.orderCond === cond}
                                        disabled={busy || blocked}
                                        title={blocked ? TICKET_TEXT.oddCreditOnly : undefined}
                                        onClick={() => t.setOrderCond(cond)}
                                    >
                                        {condLabel(cond, fields.action)}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className={styles.fieldBlock}>
                        <span className={styles.fieldLabel}>交易時段</span>
                        <div className={styles.segmented} role='group' aria-label='交易時段'>
                            <button
                                type='button'
                                className={fields.orderLot !== 'Odd' ? styles.seg.on : styles.seg.off}
                                aria-pressed={fields.orderLot !== 'Odd'}
                                disabled={busy}
                                onClick={() => { if (fields.orderLot === 'Odd') t.setOrderLot('IntradayOdd'); }}
                            >
                                盤中
                            </button>
                            <button
                                type='button'
                                className={fields.orderLot === 'Odd' ? styles.seg.on : styles.seg.off}
                                aria-pressed={fields.orderLot === 'Odd'}
                                disabled={busy || !odd}
                                title={!odd ? TICKET_TEXT.afterHoursCommon : TICKET_TEXT.oddAfterSession}
                                onClick={() => { if (fields.orderLot === 'IntradayOdd') t.setOrderLot('Odd'); }}
                            >
                                盤後
                            </button>
                        </div>
                        {!odd && <span className={styles.muted} data-testid='ticket-after-hours-note'>{TICKET_TEXT.afterHoursCommon}</span>}
                    </div>

                    <div className={styles.fieldBlock}>
                        <span className={styles.fieldLabel}>效期</span>
                        <div className={styles.segmented} role='group' aria-label='效期'>
                            {ORDER_TYPES.map(ot => {
                                const reason = orderTypeDisabledReason(ot, odd);
                                return (
                                    <button
                                        key={ot}
                                        type='button'
                                        className={fields.orderType === ot ? styles.seg.on : styles.seg.off}
                                        aria-pressed={fields.orderType === ot}
                                        disabled={busy || !!reason}
                                        title={reason ?? undefined}
                                        onClick={() => t.setOrderType(ot)}
                                    >
                                        {ot}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {daytradeVisible && (
                        <div className={styles.fieldBlock}>
                            <button
                                type='button'
                                className={fields.daytradeShort ? styles.daytradeToggle.on : styles.daytradeToggle.off}
                                aria-pressed={fields.daytradeShort}
                                disabled={busy || (!fields.daytradeShort && !t.daytradeShortEligible)}
                                data-testid='ticket-daytrade'
                                onClick={() => t.setDaytradeShort(!fields.daytradeShort)}
                            >
                                {fields.daytradeShort ? '✓ 現沖先賣（當日回補）' : '現股當沖先賣'}
                            </button>
                            {contract.day_trade !== 'Yes' && (
                                <span className={styles.muted}>
                                    {fields.daytradeShort ? '此股票目前不可現股當沖先賣，請取消勾選' : '此股票不可現股當沖先賣'}
                                </span>
                            )}
                        </div>
                    )}
                </div>
            )}

            {odd && (
                <span className={styles.muted} data-testid='ticket-odd-note'>
                    {lotLabel(fields.orderLot)}：以股計（1～{ODD_LOT_MAX_SHARES} 股）· 限價 ROD · 僅現股，不可融資券或當沖
                    {fields.orderLot === 'Odd' ? ` · ${TICKET_TEXT.oddAfterSession}` : ''}
                </span>
            )}
        </>
    );
}
