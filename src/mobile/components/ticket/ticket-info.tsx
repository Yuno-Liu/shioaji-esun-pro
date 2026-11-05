// src/mobile/components/ticket/ticket-info.tsx — 下單面板的資訊列：剩餘交易額度、預估價金（名目價值）、交易成本（估）
//
// - 剩餘交易額度：只有證券帳戶（期貨帳戶不顯示）；useTradingLimits(account) 的快取與節流由 hook 處理，
//   依信用條件取 現股 trading_available／融資 margin_available／融券 short_available。
//   模擬環境或非 08:30–15:00 時 lib 回全 0（limitsLookEmpty）→ 顯示「—」並說明，不顯示「剩餘 0 元」。
// - 預估價金：沿用 use-mobile-ticket 的 estimateAmount（股票不含手續費與稅；期權為名目價值、不估保證金）。
// - 交易成本：股票限價單才估（比照桌面 CostEstimate），重用 src/components/trade-cost-summary.tsx 的 tradeCostText
//   與 src/lib/trading-cost-settings.ts 的使用者設定（手續費折數、退佣、融資利率、借券費率），一律標示「估」。
// - 金額在「遮蔽金額」模式下以 maskMoney 遮蔽。

import { tradeCostText } from '../../../components/trade-cost-summary';
import { isOddLot } from '../../../lib/odd-lot';
import { maskMoney, usePrivacyMoney } from '../../../lib/privacy';
import { useTradingCostSettings } from '../../../lib/trading-cost-settings';
import type { ContractInfo } from '../../../lib/types/contract';
import type { Account } from '../../../lib/types/portfolio';
import { parsePrice, sendsDaytradeShort, type TicketFields } from '../../hooks/use-mobile-ticket';
import { availableLimitFor, limitsLookEmpty, useTradingLimits } from '../../hooks/use-trading-limits';
import * as styles from '../../styles/order-ticket.css';

export const LIMIT_TEXT = {
    empty: '模擬環境或非交易時段（08:30–15:00）沒有額度資料',
    loading: '讀取中…',
    error: '額度暫時無法取得',
} as const;

const LIMIT_LABEL: Record<TicketFields['orderCond'], string> = {
    Cash: '剩餘交易額度',
    MarginTrading: '融資剩餘額度',
    ShortSelling: '融券剩餘額度',
};

const fmtAmount = (v: number) => Math.round(v).toLocaleString('en-US');

export interface TicketInfoProps {
    contract: ContractInfo;
    /** 開啟時固定的送單帳戶 */
    account: Account | undefined;
    fields: TicketFields;
    isFutures: boolean;
    estimate: { value: number | null; byLastPrice: boolean };
}

export function TicketInfo({ contract, account, fields, isFutures, estimate }: TicketInfoProps) {
    const privMoney = usePrivacyMoney();
    const limits = useTradingLimits(isFutures ? null : account);
    const settings = useTradingCostSettings();

    let limitValue = '—';
    let limitNote: string | null = null;
    if (!isFutures) {
        if (limits.data && !limitsLookEmpty(limits.data)) {
            const v = availableLimitFor(limits.data, fields.orderCond);
            limitValue = v === null ? '—' : `${maskMoney(fmtAmount(v), privMoney)} 元`;
        } else if (limits.data) {
            limitNote = LIMIT_TEXT.empty;
        } else if (limits.loading) {
            limitValue = LIMIT_TEXT.loading;
        } else if (limits.error) {
            limitNote = LIMIT_TEXT.error;
        }
    }

    const price = fields.priceType === 'LMT' ? parsePrice(fields.priceText) : NaN;
    const cost = !isFutures && fields.action && price > 0
        ? tradeCostText({
            contract,
            action: fields.action,
            price,
            qty: fields.quantity,
            odd: isOddLot(fields.orderLot),
            daytrade: sendsDaytradeShort(fields, fields.action),
            orderCond: fields.orderCond,
        }, settings)
        : null;

    return (
        <>
            <div className={styles.infoGrid}>
                {!isFutures && (
                    <div className={styles.infoCell} data-testid='ticket-limit'>
                        <span className={styles.infoLabel}>{LIMIT_LABEL[fields.orderCond]}</span>
                        <span className={styles.infoValue}>{limitValue}</span>
                        {limitNote && <span className={styles.muted}>{limitNote}</span>}
                    </div>
                )}
                <div className={styles.infoCell} data-testid='ticket-estimate'>
                    <span className={styles.infoLabel}>{isFutures ? '名目價值' : '預估價金'}</span>
                    <span className={styles.infoValue}>
                        {estimate.value === null ? '—' : `${maskMoney(fmtAmount(estimate.value), privMoney)} 元`}
                    </span>
                    <span className={styles.muted}>
                        {isFutures ? '（價格 × 契約乘數 × 口數，不含保證金）' : '（不含手續費、稅）'}
                        {estimate.byLastPrice ? '・市價以成交價估' : ''}
                    </span>
                </div>
            </div>
            {cost && (
                <p className={styles.costRow} data-testid='ticket-cost' title='依「交易成本」設定的手續費折數、退佣方式、融資年利率與借券費率估算'>
                    交易成本（估）：{maskMoney(cost, privMoney)}
                </p>
            )}
        </>
    );
}
