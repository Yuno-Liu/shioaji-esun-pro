// src/components/trade-cost-summary.tsx — 下單面板股票成本列（fork 元件）
//
// 上游 order-ticket 的 CostEstimate 在股票分支只掛一行呼叫這裡；依「設定 → 風控 → 交易成本」的
// 手續費折數／退佣方式、融資年利率、借券費率估算，並依信用條件（現股、融資、融券）組字。
// 全部為估算：融資成數用法定上限（上市 6 成、上櫃 5 成），不含個股調降與國定假日。

import type { ContractInfo } from '../lib/types/contract';
import type { Action, StockOrderCond } from '../lib/types/order';
import { priceCents, stockSellTax, stockTaxRate } from '../lib/utils/contract-cost';
import { fmtPrice } from '../lib/utils/format';
import {
    discountText,
    marginFinancing,
    marginFinancingRatio,
    marginInterest,
    shortSellingFee,
    stockFeeBreakdown,
    useTradingCostSettings,
    type TradingCostSettings,
} from '../lib/trading-cost-settings';
import * as styles from './order-ticket.css';

export interface TradeCostInput {
    contract: ContractInfo;
    action: Action;
    price: number;
    qty: number;
    odd: boolean;
    daytrade: boolean;
    orderCond: StockOrderCond;
}

const yuan = (v: number) => fmtPrice(v, 0);

/** 成本列文字（純函式，方便測試）；price／qty 不合法回 null */
export function tradeCostText(input: TradeCostInput, settings: TradingCostSettings): string | null {
    const { contract, action, price, qty, odd, daytrade, orderCond } = input;
    if (!price || !Number.isFinite(price) || price <= 0 || qty <= 0) return null;
    const shares = odd ? qty : qty * 1000;
    const cents = priceCents(price) * shares;
    const amount = cents / 100;
    const fee = stockFeeBreakdown(cents, { odd }, settings);
    const baseTaxRate = stockTaxRate(contract);
    // 一般股票當沖賣出減半；ETF 與權證固定 0.1%。
    const taxRate = baseTaxRate === 0.003 && daytrade ? 0.0015 : baseTaxRate;
    const tax = action === 'Sell' ? stockSellTax(cents, taxRate) : 0;

    const feeText = fee.rebate > 0
        ? `手續費 交割 ≈ ${fee.charged}，退佣後 ≈ ${fee.net}`
        : settings.rebateMode === 'instant' && settings.feeDiscount < 1
            ? `手續費 ≈ ${fee.charged}（${discountText(settings.feeDiscount)} 折）`
            : `手續費 ≈ ${fee.charged}`;
    const parts = [`金額 ${yuan(amount)}`, feeText];
    const notes = ['估算'];
    if (action === 'Sell') parts.push(`證交稅 ≈ ${tax}`);

    if (orderCond === 'MarginTrading' && action === 'Buy') {
        const financing = marginFinancing(cents, contract.exchange);
        if (!financing) {
            parts.push('融資金額無法估算（僅上市櫃可融資）');
        } else {
            const ratio = marginFinancingRatio(contract.exchange)!;
            parts.push(`融資金額 ≈ ${yuan(financing.financed)}（${contract.exchange === 'TSE' ? '上市' : '上櫃'} ${ratio * 10} 成估算）`);
            parts.push(`自備款 ≈ ${yuan(financing.selfFunded)}`);
            parts.push(`預估應付 ≈ ${yuan(financing.selfFunded + fee.charged)}`);
            const daily = marginInterest(financing.financed, 1, settings);
            parts.push(daily === null ? '設定融資年利率以估算利息' : `每日利息 ≈ ${yuan(daily)}`);
        }
    } else if (orderCond === 'MarginTrading') {
        parts.push(`預估應收 ≈ ${yuan(amount - fee.charged - tax)}`);
        notes.push('未扣融資本金與利息');
    } else if (orderCond === 'ShortSelling' && action === 'Sell') {
        const borrow = shortSellingFee(cents, settings);
        parts.push(`借券費 ≈ ${borrow}`);
        parts.push(`預估應收 ≈ ${yuan(amount - fee.charged - tax - borrow)}`);
        notes.push('另需繳融券保證金，未計');
    } else if (orderCond === 'ShortSelling') {
        parts.push(`預估應付 ≈ ${yuan(amount + fee.charged)}`);
        notes.push('保證金與賣出價款另行退還，未計');
    } else if (action === 'Buy') {
        parts.push(`預估應付 ≈ ${yuan(amount + fee.charged)}`);
    } else {
        parts.push(`預估應收 ≈ ${yuan(amount - fee.charged - tax)}`);
    }
    return `${parts.join(' · ')}（${notes.join('；')}）`;
}

/** 下單面板股票成本列 */
export function TradeCostSummary(props: Omit<TradeCostInput, 'price'> & { price: number | null }) {
    const settings = useTradingCostSettings();
    const text = props.price === null ? null : tradeCostText({ ...props, price: props.price }, settings);
    if (text === null) return null;
    return (
        <span className={styles.costRow} title='依「設定 → 風控 → 交易成本」的手續費折數、退佣方式、融資年利率與借券費率估算'>
            {text}
        </span>
    );
}
