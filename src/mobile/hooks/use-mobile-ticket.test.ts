// 下單面板純函式（規格 §6.3、§7.1、§7.2）：即時驗證的 1～7 順序、預估金額、送單輸入、結果分類
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { Account } from '../../lib/types/portfolio';

const m = vi.hoisted(() => ({
    risk: vi.fn((): string | null => null),
    esunLeg: vi.fn((): string | null => null),
    esunBrokers: new Set<string>(),
}));
vi.mock('../../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../../lib/account-store', () => ({ useAccounts: () => ({}) }));
vi.mock('../../lib/order-account', () => ({ captureSelectedAccount: () => undefined }));
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
vi.mock('../components/route-badge', () => ({ useOrderRoute: () => null }));

import { OrderConfirmCancelled } from '../../lib/trade';
import { notStarted } from '../lib/errors';
import {
    buildMobileOrderInput,
    classifyTicketOutcome,
    estimateAmount,
    isOnTick,
    parsePrice,
    TICKET_TEXT,
    ticketProblem,
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
    action: 'Buy', priceType: 'LMT', orderType: 'ROD', orderLot: 'Common', octype: 'Auto', priceText: '100', quantity: 1, ...over,
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
