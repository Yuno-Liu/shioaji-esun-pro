// 下單面板純函式（規格 §6.3、§7.1、§7.2）：即時驗證的 1～7 順序、預估金額、送單輸入、結果分類；
// 面板退場凍結期間的「未送出」改走通知（設計規格 §7.4 第 13 點、§10 S4）
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { Account } from '../../lib/types/portfolio';

const m = vi.hoisted(() => ({
    risk: vi.fn((): string | null => null),
    esunLeg: vi.fn((): string | null => null),
    esunBrokers: new Set<string>(),
    // 只有 hook 渲染案例會設定；預設與純函式測試原本的 mock 相同（undefined／{}／null）
    captured: undefined as unknown,
    accounts: {} as Record<string, unknown>,
    route: null as unknown,
}));
vi.mock('../../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../../hooks/use-display-book', () => ({ useSnapshotBaseline: () => ({ snapshot: undefined }) }));
vi.mock('../../lib/account-store', () => ({ useAccounts: () => m.accounts }));
vi.mock('../../lib/order-account', () => ({ captureSelectedAccount: () => m.captured }));
vi.mock('../../lib/account-tradable', () => ({ canTrade: (a: Account | null | undefined) => !!a && a.signed }));
vi.mock('../../lib/esun', () => ({ isEsunAccount: (a?: { broker_id: string } | null) => !!a && m.esunBrokers.has(a.broker_id) }));
vi.mock('../../lib/order-route', () => ({ esunStockLegProblem: m.esunLeg }));
vi.mock('../../lib/risk', () => ({ checkOrderAllowed: m.risk, useRiskSettings: () => ({}) }));
vi.mock('../../lib/trade', () => {
    class OrderConfirmCancelled extends Error {
        readonly mutationNotStarted = true as const;
    }
    return { notify: vi.fn(), OrderConfirmCancelled };
});
vi.mock('../../lib/order-outcome', () => ({ reconcileAfterUnknownOutcome: vi.fn() }));
vi.mock('../../lib/tick-bands', () => ({ bandTickFor: () => undefined, prefetchTickBands: () => undefined }));
vi.mock('../lib/mobile-order', () => ({ submitMobileOrder: vi.fn() }));
vi.mock('../components/route-badge', () => ({ useOrderRoute: () => m.route }));

import { CREDIT_TEXT, ODD_LOT_TEXT } from '../../lib/odd-lot';
import { notify, OrderConfirmCancelled } from '../../lib/trade';
import { submitMobileOrder } from '../lib/mobile-order';
import type { TicketRequest } from '../lib/mobile-store';
import { SheetPresenceContext, type SheetPresence } from '../ui/sheet-context';
import { notStarted } from '../lib/errors';
import {
    buildMobileOrderInput,
    canConfirmPrice,
    classifyTicketOutcome,
    condLabel,
    confirmedPriceSeq,
    daytradeShortEligible,
    defaultTicketPrice,
    oddLotMarketPrice,
    openingPriceSeq,
    openingTicketPrice,
    estimateAmount,
    firstPositivePrice,
    initialTicketFields,
    isOnTick,
    NOT_SENT_TITLE,
    marketPrice,
    parsePrice,
    previewLabel,
    PRICE_UNCONFIRMED,
    realTradePrice,
    seededPriceSeq,
    stockOrderOf,
    TICKET_TEXT,
    ticketActionText,
    ticketProblem,
    useMobileTicket,
    withinLimits,
    type TicketCheck,
    type TicketFields,
} from './use-mobile-ticket';

const stock = {
    code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null,
    reference: 100, limit_up: 110, limit_down: 90, day_trade: 'Yes',
} as unknown as ContractInfo;
const futures = {
    code: 'TXFL6', name: '台指期', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFL6',
    reference: 22800, limit_up: 25080, limit_down: 20520, day_trade: '', multiplier: 200, tick: 1,
} as unknown as ContractInfo;
const stockAccount: Account = { account_type: 'S', broker_id: '9A95', account_id: '0123456', signed: true, person_id: '', username: '' };
const futuresAccount: Account = { account_type: 'F', broker_id: 'F002000', account_id: '7654321', signed: true, person_id: '', username: '' };

const fields = (over: Partial<TicketFields> = {}): TicketFields => ({
    action: 'Buy', priceType: 'LMT', orderType: 'ROD', orderLot: 'Common', orderCond: 'Cash', daytradeShort: false, octype: 'Auto', priceText: '100', quantity: 1, ...over,
});
const check = (over: Partial<TicketCheck> = {}): TicketCheck => ({
    contract: stock,
    account: stockAccount,
    selected: stockAccount,
    fields: fields(),
    priceStale: false,
    tradingLive: true,
    gate: { state: 'ready', staleAcknowledged: false, message: null },
    routeSimulation: true,
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    m.risk.mockReturnValue(null);
    m.esunLeg.mockReturnValue(null);
    m.esunBrokers.clear();
});

describe('ticketProblem（§6.3 驗證順序）', () => {
    it('passes a valid stock order', () => {
        expect(ticketProblem(check())).toBeNull();
        expect(m.risk).toHaveBeenCalledWith(1, 'Common');
        expect(m.esunLeg).toHaveBeenCalledWith(stockAccount, stock, expect.objectContaining({ price: 100, order_lot: 'Common', price_type: 'LMT' }));
    });

    it('reports the first failing rule in order 1 → 7', () => {
        // 全部都有問題時，帳戶（1）優先
        m.risk.mockReturnValue('已鎖單');
        const allBad = check({
            account: undefined,
            fields: fields({ priceText: '100.3' }),
            tradingLive: false,
            routeSimulation: undefined,
        });
        expect(ticketProblem(allBad)).toBe(TICKET_TEXT.noStockAccount);
        // 2 風控優先於 5 價格、6 連線、7 環境
        expect(ticketProblem({ ...allBad, account: stockAccount })).toBe('已鎖單');
        m.risk.mockReturnValue(null);
        // 4 股票規則（玉山優先）
        m.esunLeg.mockReturnValueOnce('玉山：整股上限 499 張');
        expect(ticketProblem({ ...allBad, account: stockAccount })).toBe('玉山：整股上限 499 張');
        // 5 價格
        expect(ticketProblem({ ...allBad, account: stockAccount })).toBe(TICKET_TEXT.priceTick);
        // 6 連線
        expect(ticketProblem({ ...allBad, account: stockAccount, fields: fields() })).toBe(TICKET_TEXT.notLive);
        // 7 環境
        expect(ticketProblem({ ...allBad, account: stockAccount, fields: fields(), tradingLive: true })).toBe(TICKET_TEXT.envUnknown);
    });

    it('checks account tradability, market, selection and E.SUN futures', () => {
        expect(ticketProblem(check({ account: { ...stockAccount, signed: false }, selected: { ...stockAccount, signed: false } }))).toBe(TICKET_TEXT.notTradable);
        expect(ticketProblem(check({ account: futuresAccount, selected: futuresAccount }))).toBe(TICKET_TEXT.marketMismatch);
        expect(ticketProblem(check({ selected: { ...stockAccount, account_id: '999' } }))).toBe(TICKET_TEXT.accountChanged);
        m.esunBrokers.add('ESUN');
        const esunF = { ...futuresAccount, broker_id: 'ESUN' };
        expect(ticketProblem(check({ contract: futures, account: esunF, selected: esunF, fields: fields({ priceText: '22800' }) }))).toBe(TICKET_TEXT.esunFutures);
        expect(ticketProblem(check({ contract: futures, account: undefined, fields: fields({ priceText: '22800' }) }))).toBe(TICKET_TEXT.noFuturesAccount);
    });

    it('round 3 (2a): E.SUN switching blocks only E.SUN stock accounts', () => {
        m.esunBrokers.add('ESUN');
        const esunS = { ...stockAccount, broker_id: 'ESUN' };
        expect(ticketProblem(check({ account: esunS, selected: esunS, esunSwitching: true }))).toBe(TICKET_TEXT.esunSwitching);
        expect(ticketProblem(check({ esunSwitching: true }))).toBeNull(); // 永豐照常
        expect(ticketProblem(check({ account: esunS, selected: esunS, esunSwitching: false }))).not.toBe(TICKET_TEXT.esunSwitching);
        m.esunBrokers.delete('ESUN');
    });

    it('validates quantity, odd-lot rules and futures conditions', () => {
        expect(ticketProblem(check({ fields: fields({ quantity: 0 }) }))).toBe(TICKET_TEXT.quantity);
        expect(ticketProblem(check({ fields: fields({ orderLot: 'IntradayOdd', priceType: 'MKT', orderType: 'IOC' }) }))).toMatch(/零股/);
        expect(ticketProblem(check({ fields: fields({ orderLot: 'IntradayOdd', quantity: 1000 }) }))).toMatch(/零股數量/);
        expect(ticketProblem(check({ contract: futures, account: futuresAccount, selected: futuresAccount, fields: fields({ priceText: '22800', octype: 'Bogus' as never }) }))).toMatch(/倉別/);
        expect(m.risk).toHaveBeenLastCalledWith(1, undefined);
    });

    it('validates limit price: required, tick, limit band (stocks only), stale', () => {
        expect(ticketProblem(check({ fields: fields({ priceText: '' }) }))).toBe(TICKET_TEXT.priceRequired);
        expect(ticketProblem(check({ fields: fields({ priceText: '111' }) }))).toBe(TICKET_TEXT.priceRange);
        expect(ticketProblem(check({ fields: fields({ priceText: '89.9' }) }))).toBe(TICKET_TEXT.priceRange);
        expect(ticketProblem(check({ priceStale: true }))).toBe(TICKET_TEXT.priceStale);
        // 市價不檢查價格
        expect(ticketProblem(check({ fields: fields({ priceType: 'MKT', orderType: 'IOC', priceText: '' }), priceStale: true }))).toBeNull();
        // 期貨不檢查漲跌停（交易所另有規則），只檢查升降單位
        expect(ticketProblem(check({ contract: futures, account: futuresAccount, selected: futuresAccount, fields: fields({ priceText: '26000' }) }))).toBeNull();
    });

    it('ResumeGate: resyncing / failed block; stale-data needs acknowledgement', () => {
        expect(ticketProblem(check({ gate: { state: 'resyncing', staleAcknowledged: false, message: null } }))).toBe(TICKET_TEXT.resyncing);
        expect(ticketProblem(check({ gate: { state: 'failed', staleAcknowledged: false, message: '逾時' } }))).toBe('逾時');
        expect(ticketProblem(check({ gate: { state: 'stale-data', staleAcknowledged: false, message: null } }))).toBe(TICKET_TEXT.staleData);
        expect(ticketProblem(check({ gate: { state: 'stale-data', staleAcknowledged: true, message: null } }))).toBeNull();
    });
});

describe('helpers', () => {
    it('買一／賣一取第一個有價格的檔位：第 1 檔是市價單（價格 0）時跳過', () => {
        // 1785 光洋科鎖漲停：委買第 1 檔市價 3,350 張 → 買一＝第 2 檔 86.9；委賣全空 → 沒有賣一
        expect(firstPositivePrice(['0', '86.9', '86.8', '86.7', '86.6'])).toBe(86.9);
        expect(firstPositivePrice(['0', '0', '0', '0', '0'])).toBeNull();
        expect(firstPositivePrice(['984', '983'])).toBe(984);
        expect(firstPositivePrice([])).toBeNull();
        expect(firstPositivePrice(undefined)).toBeNull();
    });

    it('parses prices and checks tick / band', () => {
        expect(parsePrice('1,085.5')).toBe(1085.5);
        expect(parsePrice('')).toBeNaN();
        expect(parsePrice('abc')).toBeNaN();
        expect(isOnTick(stock, 100.5)).toBe(true);
        expect(isOnTick(stock, 100.3)).toBe(false);
        expect(isOnTick(stock, 99.9)).toBe(true);
        expect(withinLimits(stock, 110)).toBe(true);
        expect(withinLimits(stock, 110.5)).toBe(false);
        expect(withinLimits({ limit_up: 0, limit_down: 0 }, 999)).toBe(true);
    });

    it('estimates stock amount (shares) and futures notional (multiplier)', () => {
        expect(estimateAmount(stock, fields({ quantity: 2 }), null)).toEqual({ value: 200_000, byLastPrice: false });
        expect(estimateAmount(stock, fields({ orderLot: 'IntradayOdd', quantity: 300 }), null)).toEqual({ value: 30_000, byLastPrice: false });
        expect(estimateAmount(stock, fields({ priceType: 'MKT', quantity: 1 }), 101)).toEqual({ value: 101_000, byLastPrice: true });
        expect(estimateAmount(stock, fields({ priceType: 'MKT' }), null).value).toBeNull();
        expect(estimateAmount(futures, fields({ priceText: '22800', quantity: 3 }), null).value).toBe(22800 * 200 * 3);
        expect(estimateAmount(stock, fields({ quantity: 0 }), null).value).toBeNull();
    });

    it('builds the stock input: market price 0, no order_cond / daytrade_short', () => {
        const input = buildMobileOrderInput(stock, stockAccount, { ...fields({ priceType: 'MKT', orderType: 'IOC', quantity: 3 }), action: 'Sell' });
        expect(input).toMatchObject({ isFutures: false, price: 0, priceType: 'MKT', orderLot: 'Common', displayedAccount: stockAccount, action: 'Sell', quantity: 3, orderType: 'IOC' });
        if (input.isFutures) throw new Error('expected stock input');
        expect(input.stockOrder).toEqual({ action: 'Sell', price: 0, quantity: 3, price_type: 'MKT', order_type: 'IOC', order_lot: 'Common' });
        expect(Object.keys(input.stockOrder)).not.toContain('order_cond');
        expect(Object.keys(input.stockOrder)).not.toContain('daytrade_short');
    });

    it('builds the futures input', () => {
        const input = buildMobileOrderInput(futures, futuresAccount, { ...fields({ priceText: '22801', octype: 'New', quantity: 2 }), action: 'Buy' });
        expect(input).toMatchObject({ isFutures: true, price: 22801, priceType: 'LMT', octype: 'New' });
        if (!input.isFutures) throw new Error('expected futures input');
        expect(input.futuresOrder).toEqual({ action: 'Buy', price: 22801, quantity: 2, price_type: 'LMT', order_type: 'ROD', octype: 'New' });
    });

    it('classifies outcomes: cancelled → not-sent → unknown', () => {
        expect(classifyTicketOutcome(new OrderConfirmCancelled())).toBe('cancelled');
        expect(classifyTicketOutcome(notStarted('x'))).toBe('not-sent');
        expect(classifyTicketOutcome(Object.assign(new Error('t'), { mutationOutcomeUnknown: true }))).toBe('unknown');
        expect(classifyTicketOutcome(new Error('network'))).toBe('unknown');
        expect(classifyTicketOutcome('boom')).toBe('unknown');
    });
});

describe('價格來源（B1、B2）', () => {
    it('realTradePrice excludes simtrade ticks', () => {
        expect(realTradePrice({ close: '100', simtrade: false })).toBe(100);
        expect(realTradePrice({ close: '100' })).toBe(100);
        expect(realTradePrice({ close: '105', simtrade: true })).toBeNull();
        expect(realTradePrice({ close: '0' })).toBeNull();
        expect(realTradePrice(undefined)).toBeNull();
    });

    it('marketPrice: real trade, then snapshot close, never the reference', () => {
        expect(marketPrice(101, { close: 98 })).toEqual({ price: 101, source: 'trade' });
        expect(marketPrice(null, { close: 98 })).toEqual({ price: 98, source: 'snapshot' });
        expect(marketPrice(null, { close: 0 })).toBeNull();
        expect(marketPrice(null, undefined)).toBeNull();
    });

    it('defaultTicketPrice: ticket price → trade → snapshot → reference', () => {
        expect(defaultTicketPrice(99.5, 101, { close: 98 }, stock)).toEqual({ price: 99.5, source: 'ticket' });
        expect(defaultTicketPrice(undefined, 101, { close: 98 }, stock)).toEqual({ price: 101, source: 'trade' });
        expect(defaultTicketPrice(null, null, { close: 98 }, stock)).toEqual({ price: 98, source: 'snapshot' });
        expect(defaultTicketPrice(null, null, undefined, stock)).toEqual({ price: 100, source: 'reference' });
        expect(defaultTicketPrice(null, null, undefined, { reference: 0 } as ContractInfo)).toBeNull();
    });

    it('盤中零股只看零股行情：零股成交 → 零股委買賣中價／單邊 → null，絕不退回整股（T1、#204）', () => {
        const round = (p: number) => Math.round(p * 2) / 2;
        expect(oddLotMarketPrice(100.5, { bidask: { bid_price: ['99'], ask_price: ['101'] } }, round)).toEqual({ price: 100.5, source: 'trade' });
        expect(oddLotMarketPrice(null, { bidask: { bid_price: ['100'], ask_price: ['101'] } }, round)).toEqual({ price: 100.5, source: 'oddQuote' });
        expect(oddLotMarketPrice(null, { bidask: { bid_price: [], ask_price: ['101'] } }, round)).toEqual({ price: 101, source: 'oddQuote' });
        expect(oddLotMarketPrice(null, undefined, round)).toBeNull();
        expect(oddLotMarketPrice(null, { bidask: { bid_price: [], ask_price: [] } }, round)).toBeNull();
    });

    it('帶入盤中零股開啟時不以整股成交／快照／參考價帶價，只用帶入價（T1）', () => {
        expect(openingTicketPrice({ price: null, lot: 'IntradayOdd' }, false, 101, { close: 98 }, stock)).toBeNull();
        expect(openingTicketPrice({ price: 100.5, lot: 'IntradayOdd' }, false, 101, { close: 98 }, stock)).toEqual({ price: 100.5, source: 'ticket' });
        expect(openingTicketPrice({ price: null, lot: 'Odd' }, false, 101, { close: 98 }, stock)).toEqual({ price: 101, source: 'trade' });
        expect(openingTicketPrice({ price: null }, false, null, { close: 98 }, stock)).toEqual({ price: 98, source: 'snapshot' });
    });
});

describe('價格確認與 ResumeGate（A-2）', () => {
    it('a price seeded while not ready is unconfirmed (never equals any resumeSeq)', () => {
        expect(seededPriceSeq({ state: 'ready', resumeSeq: 3 })).toBe(3);
        expect(seededPriceSeq({ state: 'resyncing', resumeSeq: 3 })).toBe(PRICE_UNCONFIRMED);
        expect(seededPriceSeq({ state: 'stale-data', resumeSeq: 3 })).toBe(PRICE_UNCONFIRMED);
        expect(seededPriceSeq({ state: 'failed', resumeSeq: 3 })).toBe(PRICE_UNCONFIRMED);
        expect(PRICE_UNCONFIRMED).toBeLessThan(0);
    });

    it('openTicket 帶入的價格以帶入當下為準：帶入後才開始的重新同步，掛載時已 ready 也是未確認（M-PLAT-4）', () => {
        // 帶入後（openedAt 1000）在 1500 開始同步、掛載時已回 ready → 未確認
        expect(openingPriceSeq({ state: 'ready', resumeSeq: 1, resyncStartedAt: 1500 }, 1000, true)).toBe(PRICE_UNCONFIRMED);
        expect(openingPriceSeq({ state: 'ready', resumeSeq: 1, resyncStartedAt: 1000 }, 1000, true)).toBe(PRICE_UNCONFIRMED);
        // 帶入前就開始的同步、從未同步過、或面板自己帶入的價格 → 以掛載當下的 gate 為準
        expect(openingPriceSeq({ state: 'ready', resumeSeq: 1, resyncStartedAt: 900 }, 1000, true)).toBe(1);
        expect(openingPriceSeq({ state: 'ready', resumeSeq: 0 }, 1000, true)).toBe(0);
        expect(openingPriceSeq({ state: 'ready', resumeSeq: 1, resyncStartedAt: 1500 }, 1000, false)).toBe(1);
        expect(openingPriceSeq({ state: 'ready', resumeSeq: 1, resyncStartedAt: 1500 }, undefined, true)).toBe(1);
        expect(openingPriceSeq({ state: 'resyncing', resumeSeq: 1, resyncStartedAt: 900 }, 1000, true)).toBe(PRICE_UNCONFIRMED);
    });

    it('user confirmation counts only when the stream has recovered (ready / stale-data)', () => {
        expect(confirmedPriceSeq({ state: 'ready', resumeSeq: 2 })).toBe(2);
        expect(confirmedPriceSeq({ state: 'stale-data', resumeSeq: 2 })).toBe(2);
        expect(confirmedPriceSeq({ state: 'resyncing', resumeSeq: 2 })).toBe(PRICE_UNCONFIRMED);
        expect(confirmedPriceSeq({ state: 'failed', resumeSeq: 2 })).toBe(PRICE_UNCONFIRMED);
        expect(canConfirmPrice({ state: 'resyncing' })).toBe(false);
    });
});

describe('信用交易與盤後零股（Phase 2，比照桌面 order-ticket.tsx）', () => {
    it('送單參數：order_cond 只在非現股時送；daytrade_short 只在 賣出＋現股＋整股＋勾選 時送 true', () => {
        expect(stockOrderOf(fields({ orderCond: 'MarginTrading' }), 'Buy')).toEqual({
            action: 'Buy', price: 100, quantity: 1, price_type: 'LMT', order_type: 'ROD', order_lot: 'Common', order_cond: 'MarginTrading',
        });
        expect(stockOrderOf(fields({ orderCond: 'ShortSelling' }), 'Sell').order_cond).toBe('ShortSelling');
        const dt = stockOrderOf(fields({ daytradeShort: true }), 'Sell');
        expect(dt.daytrade_short).toBe(true);
        expect('order_cond' in dt).toBe(false);
        // 買進時勾選的當沖不送（與桌面相同）
        expect('daytrade_short' in stockOrderOf(fields({ daytradeShort: true }), 'Buy')).toBe(false);
        // 零股或信用＋當沖：不送 daytrade_short（驗證會先擋下，見下一個測試）
        expect('daytrade_short' in stockOrderOf(fields({ daytradeShort: true, orderLot: 'IntradayOdd' }), 'Sell')).toBe(false);
        expect('daytrade_short' in stockOrderOf(fields({ daytradeShort: true, orderCond: 'MarginTrading' }), 'Sell')).toBe(false);
    });

    it('驗證用使用者的意圖：不合規則的組合顯示原因（不會被悄悄拿掉後送出）', () => {
        expect(ticketProblem(check({ fields: fields({ orderLot: 'IntradayOdd', orderCond: 'MarginTrading' }) }))).toBe(ODD_LOT_TEXT.cond);
        expect(ticketProblem(check({ fields: fields({ orderLot: 'Odd', action: 'Sell', daytradeShort: true }) }))).toBe(ODD_LOT_TEXT.daytrade);
        expect(ticketProblem(check({ fields: fields({ action: 'Sell', orderCond: 'MarginTrading', daytradeShort: true }) }))).toBe(CREDIT_TEXT.daytradeCond);
        expect(ticketProblem(check({ contract: { ...stock, day_trade: 'OnlyBuy' } as ContractInfo, fields: fields({ action: 'Sell', daytradeShort: true }) }))).toBe(CREDIT_TEXT.daytradeStock);
        expect(ticketProblem(check({ fields: fields({ action: 'Sell', daytradeShort: true }) }))).toBeNull();
        // 融資、融券（含融券買進＝回補）都可以
        expect(ticketProblem(check({ fields: fields({ orderCond: 'MarginTrading' }) }))).toBeNull();
        expect(ticketProblem(check({ fields: fields({ orderCond: 'ShortSelling' }) }))).toBeNull();
        expect(ticketProblem(check({ fields: fields({ action: 'Sell', orderCond: 'ShortSelling' }) }))).toBeNull();
        // 玉山規則拿到的也是意圖（含現股 order_cond 與 daytrade_short）
        ticketProblem(check({ fields: fields({ action: 'Sell', daytradeShort: true }) }));
        expect(m.esunLeg).toHaveBeenLastCalledWith(stockAccount, stock, expect.objectContaining({ order_cond: 'Cash', daytrade_short: true }));
    });

    it('盤後零股：order_lot Odd、限價 ROD、無 order_cond；風控以零股換算', () => {
        const odd = fields({ orderLot: 'Odd', quantity: 300 });
        expect(ticketProblem(check({ fields: odd }))).toBeNull();
        expect(m.risk).toHaveBeenLastCalledWith(300, 'Odd');
        const input = buildMobileOrderInput(stock, stockAccount, { ...odd, action: 'Buy' });
        if (input.isFutures) throw new Error('expected stock input');
        expect(input.orderLot).toBe('Odd');
        expect(input.stockOrder).toEqual({ action: 'Buy', price: 100, quantity: 300, price_type: 'LMT', order_type: 'ROD', order_lot: 'Odd' });
        expect(ticketProblem(check({ fields: fields({ orderLot: 'Odd', priceType: 'MKT', orderType: 'IOC' }) }))).toMatch(/零股/);
    });

    it('現沖先賣可勾選條件：賣出＋整股＋現股＋day_trade Yes', () => {
        expect(daytradeShortEligible(stock, fields({ action: 'Sell' }))).toBe(true);
        expect(daytradeShortEligible(stock, fields({ action: 'Buy' }))).toBe(false);
        expect(daytradeShortEligible(stock, fields({ action: null }))).toBe(false);
        expect(daytradeShortEligible(stock, fields({ action: 'Sell', orderLot: 'IntradayOdd' }))).toBe(false);
        expect(daytradeShortEligible(stock, fields({ action: 'Sell', orderCond: 'MarginTrading' }))).toBe(false);
        expect(daytradeShortEligible({ day_trade: 'OnlyBuy' }, fields({ action: 'Sell' }))).toBe(false);
        expect(daytradeShortEligible({ day_trade: 'No' }, fields({ action: 'Sell' }))).toBe(false);
    });

    it('動作文字與預覽鍵文字', () => {
        expect(ticketActionText(fields(), false)).toBe('買進');
        expect(ticketActionText(fields({ action: 'Sell' }), false)).toBe('賣出');
        expect(ticketActionText(fields({ orderCond: 'MarginTrading' }), false)).toBe('融資買進');
        expect(ticketActionText(fields({ action: 'Sell', orderCond: 'ShortSelling' }), false)).toBe('融券賣出');
        expect(ticketActionText(fields({ orderCond: 'ShortSelling' }), false)).toBe('融券買進（回補）');
        expect(ticketActionText(fields({ action: 'Sell', daytradeShort: true }), false)).toBe('現股當沖賣出');
        expect(ticketActionText(fields({ action: null }), false)).toBe('');
        expect(ticketActionText(fields({ action: 'Sell' }), true)).toBe('賣出');
        expect(condLabel('ShortSelling', 'Buy')).toBe('融券（回補）');
        expect(condLabel('ShortSelling', 'Sell')).toBe('融券');
        expect(previewLabel(stock, fields({ priceText: '2240' }), false)).toBe('預覽買進委託 · 2330 · 1 張 · 限價 2,240');
        expect(previewLabel(stock, fields({ action: 'Sell', orderCond: 'MarginTrading', quantity: 3, priceType: 'MKT' }), false)).toBe('預覽融資賣出委託 · 2330 · 3 張 · 市價');
        expect(previewLabel(stock, fields({ orderLot: 'IntradayOdd', quantity: 300, priceText: '99.5' }), false)).toBe('預覽買進委託 · 2330 · 300 股 · 限價 99.5');
        expect(previewLabel(futures, fields({ priceText: '22800', quantity: 2 }), true)).toBe('預覽買進委託 · TXFL6 · 2 口 · 限價 22,800');
        expect(previewLabel(stock, fields({ action: null }), false)).toBe('請先選擇買進或賣出');
    });

    it('openTicket 帶入的 lot／cond／daytradeShort 只在開啟時帶入，不合規則也照樣保留（由驗證說明）', () => {
        const preset = initialTicketFields({ action: 'Sell', lot: 'IntradayOdd', cond: 'MarginTrading', daytradeShort: true }, stock, 100);
        expect(preset).toMatchObject({ orderLot: 'IntradayOdd', orderCond: 'MarginTrading', daytradeShort: true, priceType: 'LMT', orderType: 'ROD' });
        expect(ticketProblem(check({ fields: preset }))).toBe(ODD_LOT_TEXT.cond);
        expect(initialTicketFields({ action: null }, stock, null)).toMatchObject({ orderLot: 'Common', orderCond: 'Cash', daytradeShort: false, priceText: '' });
        // 期權不帶入股票欄位
        expect(initialTicketFields({ action: 'Buy', lot: 'Odd', cond: 'ShortSelling', daytradeShort: true }, futures, 22800)).toMatchObject({ orderLot: 'Common', orderCond: 'Cash', daytradeShort: false });
    });

    it('信用提醒附在送單輸入（確認面板備註用）', () => {
        const input = buildMobileOrderInput(stock, stockAccount, { ...fields(), action: 'Buy' }, '現股買進不會回補融券');
        expect(input).toMatchObject({ isFutures: false, creditHint: '現股買進不會回補融券' });
        expect('creditHint' in buildMobileOrderInput(stock, stockAccount, { ...fields(), action: 'Buy' }, null)).toBe(false);
    });
});

describe('面板退場凍結（設計規格 §7.4 第 13 點、§10 S4）', () => {
    type Ticket = ReturnType<typeof useMobileTicket>;
    let view: ReactTestRenderer | undefined;
    let t: Ticket | undefined;
    const ticket: TicketRequest = { code: '2330', action: 'Buy', price: 100, source: 'button', seq: 1 };
    const Probe = () => { t = useMobileTicket(ticket, stock); return null; };
    const presence = (exiting: boolean): SheetPresence => ({
        phase: exiting ? 'exiting' : 'open', settled: !exiting, shownAt: 0, isExiting: () => exiting,
    });
    async function mount(exiting: boolean, wrap = true) {
        const probe = createElement(Probe);
        const el: ReactNode = wrap ? createElement(SheetPresenceContext.Provider, { value: presence(exiting) }, probe) : probe;
        await act(async () => { view = create(el as Parameters<typeof create>[0]); });
    }

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        m.captured = stockAccount;
        m.accounts = { selectedStock: stockAccount, selectedFutures: undefined };
        m.route = { esun: false, broker: '永豐', simulation: true };
        vi.mocked(submitMobileOrder).mockRejectedValue(notStarted('風控鎖單中'));
    });
    afterEach(async () => {
        await act(async () => view?.unmount());
        view = undefined;
        t = undefined;
        m.captured = undefined;
        m.accounts = {};
        m.route = null;
        vi.unstubAllGlobals();
    });

    it('退場中遇到「未送出」→ 以通知告知，不寫進即將消失的面板', async () => {
        await mount(true);
        expect(t!.problem).toBeNull();
        await act(async () => { await t!.submit(); });
        expect(submitMobileOrder).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledWith({ kind: 'err', title: NOT_SENT_TITLE, body: '風控鎖單中' });
        expect(t!.feedback).toBeNull();
    });

    it('面板開啟中遇到「未送出」→ 顯示在面板上（行為不變）', async () => {
        await mount(false);
        await act(async () => { await t!.submit(); });
        expect(t!.feedback).toEqual({ kind: 'not-sent', text: '未送出：風控鎖單中' });
        expect(notify).not.toHaveBeenCalled();
    });

    it('不在面板內（預設 presence）時行為不變', async () => {
        await mount(false, false);
        await act(async () => { await t!.submit(); });
        expect(t!.feedback).toEqual({ kind: 'not-sent', text: '未送出：風控鎖單中' });
        expect(notify).not.toHaveBeenCalled();
    });

    it('退場中遇到「已取消」→ 不寫回饋', async () => {
        vi.mocked(submitMobileOrder).mockRejectedValue(new OrderConfirmCancelled());
        await mount(true);
        await act(async () => { await t!.submit(); });
        expect(t!.feedback).toBeNull();
        expect(notify).not.toHaveBeenCalled();
    });
});
