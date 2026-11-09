// src/mobile/components/ticket/ticket-info.tsx — 下單面板的資訊列：剩餘交易額度、預估價金（名目價值）、交易成本（估）
//
// - 剩餘交易額度：只有證券帳戶（期貨帳戶不顯示）；useTradingLimits(account) 的快取與節流由 hook 處理，
//   依信用條件取 現股 trading_available／融資 margin_available／融券 short_available。
//   融資賣出（償還）、融券買進（回補）是了結單：不顯示信用剩餘額度，改說明不占融資／融券額度。
//   玉山帳戶（limitsAreCapsOnly）只有額度上限：現股顯示「估算剩餘額度 X 元」與「上限 L；今日買進 已成交 A＋未成交 B」
//   （useEsunLimitEstimate，與帳戶頁額度卡、持倉頁一行同一個估算；不另發查詢）；融資／融券照舊只顯示「…額度上限 X 元
//   （玉山不提供剩餘額度）」，不可稱剩餘或可用。
//   模擬環境或非 08:30–15:00 時 lib 回全 0（limitsLookEmpty）→ 顯示「—」並說明，不顯示「剩餘 0 元」。
// - 預估價金：沿用 use-mobile-ticket 的 estimateAmount（股票不含手續費與稅；期權為名目價值、不估保證金）。
// - 交易成本：股票限價單才估（比照桌面 CostEstimate），重用 src/components/trade-cost-summary.tsx 的 tradeCostText
//   與 src/lib/trading-cost-settings.ts 的使用者設定（手續費折數、退佣、融資利率、借券費率），一律標示「估」。
// - 金額在「遮蔽金額」模式下以 maskMoney 遮蔽。
// - 版面（設計規格 §7.4-8）：三者放在同一個中性島（islandBg）兩欄；標籤與備註 mutedForeground 只出現在島內。

import { tradeCostText } from '../../../components/trade-cost-summary';
import { isOddLot } from '../../../lib/odd-lot';
import { maskMoney, usePrivacyMoney } from '../../../lib/privacy';
import type { TradingLimits } from '../../../lib/shioaji';
import { useTradingCostSettings } from '../../../lib/trading-cost-settings';
import type { ContractInfo } from '../../../lib/types/contract';
import type { Account } from '../../../lib/types/portfolio';
import { parsePrice, sendsDaytradeShort, type TicketFields } from '../../hooks/use-mobile-ticket';
import { useEsunLimitEstimate } from '../../hooks/use-esun-limit-estimate';
import { availableLimitFor, limitsAreCapsOnly, limitsLookEmpty, useTradingLimits } from '../../hooks/use-trading-limits';
import { ESUN_ESTIMATE_TEXT, esunBreakdownText, esunEstimateFlags } from '../../lib/esun-limit-estimate';
import * as styles from '../../styles/order-ticket.css';

export const LIMIT_TEXT = {
    empty: '模擬環境或非交易時段（08:30–15:00）沒有額度資料',
    loading: '讀取中…',
    error: '額度暫時無法取得',
    /** 融資賣出（償還）、融券買進（回補）：了結信用部位，不顯示信用剩餘額度（T5） */
    closingCredit: '了結信用部位不占融資／融券額度',
    /** 玉山只提供額度上限，沒有已用／剩餘（F4:F1） */
    capsOnly: '玉山不提供剩餘額度',
    /** 玉山現股：估算剩餘的標籤 */
    esunEstimate: `${ESUN_ESTIMATE_TEXT.label}額度`,
} as const;

const LIMIT_LABEL: Record<TicketFields['orderCond'], string> = {
    Cash: '剩餘交易額度',
    MarginTrading: '融資剩餘額度',
    ShortSelling: '融券剩餘額度',
};

/** 玉山帳戶：只能稱「上限」（不可稱剩餘或可用） */
const CAP_LABEL: Record<TicketFields['orderCond'], string> = {
    Cash: '交易額度上限',
    MarginTrading: '融資額度上限',
    ShortSelling: '融券額度上限',
};

const CLOSING_LABEL: Record<Exclude<TicketFields['orderCond'], 'Cash'>, string> = {
    MarginTrading: '融資額度',
    ShortSelling: '融券額度',
};

/**
 * 融資賣出（償還）、融券買進（回補）：了結信用部位，不新增也不占融資／融券額度
 * （與 src/lib/credit-eligibility.ts creditOpensFor 相同的規則：只有融資買進、融券賣出會新增信用部位）。
 */
export function closesCreditPosition(fields: Pick<TicketFields, 'action' | 'orderCond'>): boolean {
    return (fields.orderCond === 'MarginTrading' && fields.action === 'Sell')
        || (fields.orderCond === 'ShortSelling' && fields.action === 'Buy');
}

/** 依券商取額度：玉山只有上限（lib 把可用補成上限，不可當剩餘顯示）；永豐取剩餘（available） */
function limitValueFor(limits: TradingLimits, cond: TicketFields['orderCond'], capsOnly: boolean): number | null {
    if (!capsOnly) return availableLimitFor(limits, cond);
    const value = cond === 'MarginTrading' ? limits.margin_limit : cond === 'ShortSelling' ? limits.short_limit : limits.trading_limit;
    return Number.isFinite(value) ? value : null;
}

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
    const esunEstimate = useEsunLimitEstimate(isFutures ? null : account, limits.data);
    const settings = useTradingCostSettings();

    const capsOnly = limitsAreCapsOnly(account);
    const closing = closesCreditPosition(fields);
    let limitLabel = capsOnly ? CAP_LABEL[fields.orderCond] : LIMIT_LABEL[fields.orderCond];
    let limitValue = '—';
    let limitNote: string | null = null;
    if (!isFutures) {
        if (closing && fields.orderCond !== 'Cash') {
            // 了結單：不顯示融資／融券剩餘（或上限），只說明不占額度
            limitLabel = CLOSING_LABEL[fields.orderCond];
            limitNote = LIMIT_TEXT.closingCredit;
        } else if (capsOnly && fields.orderCond === 'Cash' && esunEstimate) {
            // 玉山現股：估算剩餘（只扣今日買進）
            const money = (v: number) => `${maskMoney(fmtAmount(v), privMoney)} 元`;
            limitLabel = LIMIT_TEXT.esunEstimate;
            limitValue = money(esunEstimate.remaining);
            limitNote = [esunBreakdownText(esunEstimate, money), ...esunEstimateFlags(esunEstimate)].join('；') + `（${ESUN_ESTIMATE_TEXT.short}）`;
        } else if (limits.data && !limitsLookEmpty(limits.data)) {
            const v = limitValueFor(limits.data, fields.orderCond, capsOnly);
            limitValue = v === null ? '—' : `${maskMoney(fmtAmount(v), privMoney)} 元`;
            if (capsOnly) limitNote = `（${LIMIT_TEXT.capsOnly}）`;
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
        <div className={styles.infoIsland} data-testid='ticket-info'>
            {!isFutures && (
                <div className={styles.infoCell} data-testid='ticket-limit'>
                    <span className={styles.infoLabel}>{limitLabel}</span>
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
            {cost && (
                <p className={styles.costRow} data-testid='ticket-cost' title='依「交易成本」設定的手續費折數、退佣方式、融資年利率與借券費率估算'>
                    交易成本（估）：{maskMoney(cost, privMoney)}
                </p>
            )}
        </div>
    );
}
