// 手機新單流程（規格 §7.1、§14.1）：閘門順序、強制確認、確認後與 beforeDispatch 重驗、成功路徑的送單參數。
// 以 vi.mock 隔離 src/lib，不打任何真實 API；玉山規則用真正的 validateEsunStockOrder（純函式）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { Account } from '../../lib/types/portfolio';

const h = vi.hoisted(() => ({
    live: true,
    captured: { S: undefined, F: undefined } as Record<'S' | 'F', unknown>,
    accountUnchanged: true,
    serverSame: true,
    routeSame: true,
    /** 合約快取的最新內容（beforeDispatch 的現沖檢查用）；undefined＝快取沒有這檔 */
    cachedContract: undefined as unknown,
}));
const m = vi.hoisted(() => ({
    risk: vi.fn((): string | null => null),
    confirm: vi.fn(async (): Promise<boolean> => true),
    placeStock: vi.fn(async (): Promise<unknown> => ({ order: { id: 's1' } })),
    placeFutures: vi.fn(async (): Promise<unknown> => ({ order: { id: 'f1' } })),
    captureServerMode: vi.fn(),
    captureRoute: vi.fn(),
}));

vi.mock('../../lib/contracts-cache', () => ({ getCachedContract: () => h.cachedContract }));
vi.mock('../../hooks/use-order-context', () => ({ ORDER_CONTEXT_CHANGED_MESSAGE: '商品、交易單位或信用條件已變更，已停止後續下單' }));
vi.mock('../../lib/esun', async () => {
    const om = await vi.importActual<typeof import('../../lib/esun/order-mapping')>('../../lib/esun/order-mapping');
    return { isEsunAccount: om.isEsunAccount };
});
vi.mock('../../lib/order-route', async () => {
    const om = await vi.importActual<typeof import('../../lib/esun/order-mapping')>('../../lib/esun/order-mapping');
    return {
        // 與 src/lib/order-route.ts 的 esunStockLegProblem 相同：玉山帳戶才用玉山規則，訊息加「玉山：」
        esunStockLegProblem: (account: Account, contract: ContractInfo, order: Parameters<typeof om.validateEsunStockOrder>[1]) => {
            if (!om.isEsunAccount(account)) return null;
            const p = om.validateEsunStockOrder(contract, order);
            return p ? `玉山：${p}` : null;
        },
        routeConfirmNote: (a: Account) => `送往 ${om.isEsunAccount(a) ? '玉山' : '永豐'} 模擬環境`,
        captureDisplayedRoute: m.captureRoute,
    };
});
vi.mock('../../lib/order-account', () => ({
    ACCOUNT_CHANGED_MESSAGE: '確認期間帳戶已變更或不可用，未送出，請重新確認',
    captureSelectedAccount: (type: 'S' | 'F') => h.captured[type],
    isSelectedAccountUnchanged: () => h.accountUnchanged,
}));
vi.mock('../../lib/order-confirm', () => ({
    accountConfirmLabel: (a: Account) => `${a.broker_id}-***${a.account_id.slice(-4)}`,
    requestOrderConfirm: m.confirm,
}));
vi.mock('../../lib/risk', () => ({ checkOrderAllowed: m.risk }));
vi.mock('../../lib/server-info-store', () => ({
    SERVER_MODE_CHANGED_MESSAGE: '確認期間伺服器或模式已變更，這筆沒有送出，請重新下單',
    captureServerMode: m.captureServerMode,
}));
vi.mock('../../lib/shioaji', () => ({ placeStockOrder: m.placeStock, placeFuturesOrder: m.placeFutures }));
vi.mock('../../lib/trade', () => {
    class OrderConfirmCancelled extends Error {
        readonly mutationNotStarted = true as const;
        constructor() { super('已取消下單'); this.name = 'OrderConfirmCancelled'; }
    }
    return {
        OrderConfirmCancelled,
        assertTradingLive: () => {
            if (!h.live) throw Object.assign(new Error('行情非 LIVE'), { mutationNotStarted: true as const });
        },
    };
});

import { OrderConfirmCancelled } from '../../lib/trade';
import { notStarted } from './errors';
import { buildFuturesLists } from './futures-lists';
import { ESUN_FUTURES_MESSAGE, submitMobileOrder, type MobileOrderGuards } from './mobile-order';
import type { MobileOrderInput } from './mobile-order-types';

const sinoStock = { account_type: 'S', broker_id: '9A95', account_id: '0123456', signed: true, person_id: '', username: '' } as Account;
const esunStock = { account_type: 'S', broker_id: '8840-SIM', account_id: '1123456', signed: true, person_id: '', username: '' } as Account;
const sinoFutures = { account_type: 'F', broker_id: 'F002000', account_id: '7654321', signed: true, person_id: '', username: '' } as Account;
const esunFutures = { ...esunStock, account_type: 'F' } as Account;

const stock = {
    code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null,
    reference: 100, limit_up: 110, limit_down: 90, day_trade: 'Yes',
} as unknown as ContractInfo;
const futures = {
    code: 'TXFL6', name: '台指期', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFL6',
    reference: 22800, limit_up: 25080, limit_down: 20520, day_trade: '', multiplier: 200,
} as unknown as ContractInfo;

function stockInput(account: Account, over: Partial<{ quantity: number; lot: 'Common' | 'IntradayOdd'; price: number; action: 'Buy' | 'Sell'; priceType: 'LMT' | 'MKT' }> = {}): MobileOrderInput {
    const quantity = over.quantity ?? 2;
    const orderLot = over.lot ?? 'Common';
    const action = over.action ?? 'Buy';
    const priceType = over.priceType ?? 'LMT';
    const price = priceType === 'MKT' ? 0 : (over.price ?? 100.5);
    return {
        isFutures: false, contract: stock, displayedAccount: account, action, quantity, price, orderType: 'ROD',
        priceType, orderLot,
        stockOrder: { action, price, quantity, price_type: priceType, order_type: 'ROD', order_lot: orderLot },
    };
}
function futuresInput(account: Account): MobileOrderInput {
    return {
        isFutures: true, contract: futures, displayedAccount: account, action: 'Sell', quantity: 1, price: 22850, orderType: 'ROD',
        priceType: 'LMT', octype: 'Auto',
        futuresOrder: { action: 'Sell', price: 22850, quantity: 1, price_type: 'LMT', order_type: 'ROD', octype: 'Auto' },
    };
}

let resumeOk: boolean;
let contextCurrent: boolean;
const guards: MobileOrderGuards = {
    assertResumeReady: vi.fn(() => {
        if (!resumeOk) throw notStarted('回到前景後正在重新同步行情與委託，這筆沒有送出，請稍候再試');
    }),
    isContextCurrent: vi.fn(() => contextCurrent),
};

const noOrderSent = () => {
    expect(m.placeStock).not.toHaveBeenCalled();
    expect(m.placeFutures).not.toHaveBeenCalled();
};
async function rejection(p: Promise<unknown>): Promise<Error & { mutationNotStarted?: boolean }> {
    try {
        await p;
    } catch (err) {
        return err as Error & { mutationNotStarted?: boolean };
    }
    throw new Error('expected rejection');
}

beforeEach(() => {
    vi.clearAllMocks();
    h.live = true;
    h.captured = { S: sinoStock, F: sinoFutures };
    h.accountUnchanged = true;
    h.serverSame = true;
    h.routeSame = true;
    h.cachedContract = undefined;
    resumeOk = true;
    contextCurrent = true;
    m.risk.mockImplementation(() => null);
    m.confirm.mockImplementation(async () => true);
    m.captureServerMode.mockImplementation(() => () => h.serverSame);
    m.captureRoute.mockImplementation(() => () => {
        if (!h.routeSame) throw Object.assign(new Error('送出前下單帳號或環境已與畫面顯示的不同'), { tradingGateRejected: true });
    });
});

describe('submitMobileOrder — 確認前的閘門', () => {
    it('guards.assertResumeReady 丟出時：不確認、不送單', async () => {
        resumeOk = false;
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err.mutationNotStarted).toBe(true);
        expect(m.confirm).not.toHaveBeenCalled();
        noOrderSent();
    });

    it('串流非 LIVE 時不呼叫 requestOrderConfirm', async () => {
        h.live = false;
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err.mutationNotStarted).toBe(true);
        expect(m.confirm).not.toHaveBeenCalled();
        noOrderSent();
    });

    it('風控擋下時不呼叫 requestOrderConfirm（未送出，帶風控原因）', async () => {
        m.risk.mockImplementation(() => '風控鎖啟動中 — 所有下單已封鎖');
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err).toMatchObject({ message: '風控鎖啟動中 — 所有下單已封鎖', mutationNotStarted: true });
        expect(m.risk).toHaveBeenCalledWith(2, 'Common');
        expect(m.confirm).not.toHaveBeenCalled();
        noOrderSent();
    });

    it('風控以零股換算：傳入單位', async () => {
        m.risk.mockImplementation(() => '超過單筆上限');
        await rejection(submitMobileOrder(stockInput(sinoStock, { lot: 'IntradayOdd', quantity: 300 }), guards));
        expect(m.risk).toHaveBeenCalledWith(300, 'IntradayOdd');
    });

    it('玉山規則錯誤（零股 1,000 股）不確認、不送出', async () => {
        h.captured.S = esunStock;
        const err = await rejection(submitMobileOrder(stockInput(esunStock, { lot: 'IntradayOdd', quantity: 1000 }), guards));
        expect(err.mutationNotStarted).toBe(true);
        expect(err.message).toMatch(/^玉山：零股委託數量必須在 1 至 999 股之間/);
        expect(m.confirm).not.toHaveBeenCalled();
        noOrderSent();
    });

    it('期權＋玉山帳戶在確認前拒絕（不出現確認面板）', async () => {
        h.captured.F = esunFutures;
        const err = await rejection(submitMobileOrder(futuresInput(esunFutures), guards));
        expect(err).toMatchObject({ message: ESUN_FUTURES_MESSAGE, mutationNotStarted: true });
        expect(m.confirm).not.toHaveBeenCalled();
        noOrderSent();
    });

    it('缺少有效下單帳戶：不確認', async () => {
        h.captured.S = undefined;
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err.mutationNotStarted).toBe(true);
        expect(m.confirm).not.toHaveBeenCalled();
    });

    it('顯示路由已和送單帳戶不同：未送出（補上 mutationNotStarted）且不確認', async () => {
        h.routeSame = false;
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err.mutationNotStarted).toBe(true);
        expect(m.confirm).not.toHaveBeenCalled();
        noOrderSent();
    });

    it('面板內容與委託不一致：不確認', async () => {
        const input = stockInput(sinoStock);
        if (input.isFutures) throw new Error('unreachable');
        const err = await rejection(submitMobileOrder({ ...input, quantity: 3 }, guards));
        expect(err.mutationNotStarted).toBe(true);
        expect(m.confirm).not.toHaveBeenCalled();
    });
});

describe('submitMobileOrder — 確認與確認後重驗', () => {
    it('一律呼叫 requestOrderConfirm（強制確認），內容含路由備註與伺服器模式閘門', async () => {
        await submitMobileOrder(stockInput(sinoStock, { lot: 'IntradayOdd', quantity: 300, action: 'Sell' }), guards);
        expect(m.confirm).toHaveBeenCalledTimes(1);
        const [req, opts] = m.confirm.mock.calls[0] as unknown as [Record<string, unknown>, { serverMode: unknown }];
        expect(req).toEqual({
            code: '2330', name: '台積電', action: 'Sell', credit: undefined, price: 100.5, quantity: 300, unit: '股',
            note: 'ROD・盤中零股・送往 永豐 模擬環境', accountLabel: '9A95-***3456',
        });
        expect(opts.serverMode).toBe(m.captureServerMode.mock.results[0]!.value);
    });

    it('市價：price 為 null；整股單位「張」', async () => {
        await submitMobileOrder(stockInput(sinoStock, { priceType: 'MKT' }), guards);
        const [req] = m.confirm.mock.calls[0] as unknown as [Record<string, unknown>];
        expect(req).toMatchObject({ price: null, unit: '張', note: 'ROD・送往 永豐 模擬環境' });
    });

    it('確認取消：不送出且丟出 OrderConfirmCancelled', async () => {
        m.confirm.mockImplementation(async () => false);
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err).toBeInstanceOf(OrderConfirmCancelled);
        expect(err.mutationNotStarted).toBe(true);
        noOrderSent();
    });

    it('確認期間帳戶改變：不送出', async () => {
        m.confirm.mockImplementation(async () => { h.accountUnchanged = false; return true; });
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err).toMatchObject({ message: '確認期間帳戶已變更或不可用，未送出，請重新確認', mutationNotStarted: true });
        noOrderSent();
    });

    it('確認期間伺服器模式改變：不送出', async () => {
        m.confirm.mockImplementation(async () => { h.serverSame = false; return true; });
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err).toMatchObject({ message: '確認期間伺服器或模式已變更，這筆沒有送出，請重新下單', mutationNotStarted: true });
        noOrderSent();
    });

    it('確認期間路由改變：不送出（未送出）', async () => {
        m.confirm.mockImplementation(async () => { h.routeSame = false; return true; });
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err.mutationNotStarted).toBe(true);
        noOrderSent();
    });

    it('確認期間商品或單位改變：不送出', async () => {
        m.confirm.mockImplementation(async () => { contextCurrent = false; return true; });
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err).toMatchObject({ message: '商品、交易單位或信用條件已變更，已停止後續下單', mutationNotStarted: true });
        noOrderSent();
    });

    it('確認期間 ResumeGate 離開 ready：beforeDispatch 丟出且不送單', async () => {
        m.confirm.mockImplementation(async () => { resumeOk = false; return true; });
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err.mutationNotStarted).toBe(true);
        expect(guards.assertResumeReady).toHaveBeenCalledTimes(2);
        noOrderSent();
    });

    it('確認期間串流中斷：不送單', async () => {
        m.confirm.mockImplementation(async () => { h.live = false; return true; });
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err.mutationNotStarted).toBe(true);
        noOrderSent();
    });

    it('確認期間開啟風控鎖：確認後重驗擋下，未送出（帶風控原因）', async () => {
        const locked = '風控鎖啟動中 — 所有下單已封鎖';
        m.confirm.mockImplementation(async () => { m.risk.mockImplementation(() => locked); return true; });
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err).toMatchObject({ message: locked, mutationNotStarted: true });
        expect(m.confirm).toHaveBeenCalledTimes(1);
        noOrderSent();
    });

    it('確認期間當日虧損越過上限（期權）：未送出', async () => {
        const blocked = '當日虧損 -10,000 已達上限 -5,000，下單封鎖';
        m.confirm.mockImplementation(async () => { m.risk.mockImplementation(() => blocked); return true; });
        const err = await rejection(submitMobileOrder(futuresInput(sinoFutures), guards));
        expect(err).toMatchObject({ message: blocked, mutationNotStarted: true });
        expect(m.risk).toHaveBeenLastCalledWith(1, undefined);
        noOrderSent();
    });
});

describe('submitMobileOrder — 送出', () => {
    it('永豐股票：以固定帳戶與 beforeDispatch 呼叫 placeStockOrder，回傳 Trade', async () => {
        const input = stockInput(sinoStock);
        const trade = await submitMobileOrder(input, guards);
        expect(trade).toEqual({ order: { id: 's1' } });
        expect(m.placeStock).toHaveBeenCalledTimes(1);
        const [contract, order, account, opts] = m.placeStock.mock.calls[0] as unknown as [unknown, unknown, unknown, { beforeDispatch: () => void }];
        expect(contract).toBe(stock);
        expect(order).toEqual({ action: 'Buy', price: 100.5, quantity: 2, price_type: 'LMT', order_type: 'ROD', order_lot: 'Common' });
        expect(account).toBe(sinoStock);
        expect(typeof opts.beforeDispatch).toBe('function');
        expect(m.placeFutures).not.toHaveBeenCalled();
    });

    it('玉山股票：同樣呼叫 placeStockOrder（由 lib 內部轉往 bridge），帳戶為玉山帳戶', async () => {
        h.captured.S = esunStock;
        await submitMobileOrder(stockInput(esunStock, { lot: 'IntradayOdd', quantity: 500 }), guards);
        const [, order, account] = m.placeStock.mock.calls[0] as unknown as [unknown, unknown, unknown];
        expect(order).toMatchObject({ quantity: 500, order_lot: 'IntradayOdd', price_type: 'LMT', order_type: 'ROD' });
        expect(account).toBe(esunStock);
        const [req] = m.confirm.mock.calls[0] as unknown as [Record<string, unknown>];
        expect(req).toMatchObject({ unit: '股', note: 'ROD・盤中零股・送往 玉山 模擬環境', accountLabel: '8840-SIM-***3456' });
    });

    it('期權：以固定帳戶呼叫 placeFuturesOrder', async () => {
        await submitMobileOrder(futuresInput(sinoFutures), guards);
        expect(m.placeFutures).toHaveBeenCalledTimes(1);
        const [contract, order, account, opts] = m.placeFutures.mock.calls[0] as unknown as [unknown, unknown, unknown, { beforeDispatch: () => void }];
        expect(contract).toBe(futures);
        expect(order).toEqual({ action: 'Sell', price: 22850, quantity: 1, price_type: 'LMT', order_type: 'ROD', octype: 'Auto' });
        expect(account).toBe(sinoFutures);
        expect(typeof opts.beforeDispatch).toBe('function');
        const [req] = m.confirm.mock.calls[0] as unknown as [Record<string, unknown>];
        expect(req).toMatchObject({ action: 'Sell', unit: '口', price: 22850, note: '限價 ROD・倉別 自動・送往 永豐 模擬環境' });
        expect(req).not.toHaveProperty('priceLabel');
        expect(m.placeStock).not.toHaveBeenCalled();
    });

    it('自選固定清單「股期近月」的列：確認面板與送單都是實際月份合約（CDFK6，不是 CDFR1）', async () => {
        const meta = { security_type: 'FUT', exchange: 'TAIFEX', spec_kind: 'stock_fut', underlying_kind: 'S', underlying_code: '2330', root: 'CDF', multiplier: 2000, reference: 2133, limit_up: 2346, limit_down: 1920, last_trading_date: '2099-12-31' };
        const { near } = buildFuturesLists([
            { ...meta, code: 'CDFR1', name: '台積電期貨 近月', target_code: 'CDFK6' },
            { ...meta, code: 'CDFK6', name: '台積電期貨 202611', target_code: null },
        ] as unknown as ContractInfo[], '2026-11-09');
        const contract = near[0]!.contract;
        const base = futuresInput(sinoFutures);
        await submitMobileOrder({ ...base, contract } as MobileOrderInput, guards);
        const [req] = m.confirm.mock.calls[0] as unknown as [Record<string, unknown>];
        expect(req).toMatchObject({ code: 'CDFK6', name: '台積電期貨 202611' });
        const [sent] = m.placeFutures.mock.calls[0] as unknown as [ContractInfo];
        expect(sent.code).toBe('CDFK6');
        expect(sent.target_code).toBeNull();
    });

    it('期權確認內容與實際送出一致：範圍市價（priceLabel）、實際效期（FOK 不寫成 IOC）、倉別', async () => {
        const base = futuresInput(sinoFutures);
        if (!base.isFutures) throw new Error('unreachable');
        const mkp: MobileOrderInput = {
            ...base, price: 0, orderType: 'FOK', priceType: 'MKP', octype: 'Cover',
            futuresOrder: { ...base.futuresOrder, price: 0, price_type: 'MKP', order_type: 'FOK', octype: 'Cover' },
        };
        await submitMobileOrder(mkp, guards);
        const [req] = m.confirm.mock.calls[0] as unknown as [Record<string, unknown>];
        expect(req).toMatchObject({ price: null, priceLabel: '範圍市價', note: '範圍市價 FOK・倉別 平倉・送往 永豐 模擬環境' });
        const [, order] = m.placeFutures.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
        expect(order).toMatchObject({ price_type: 'MKP', order_type: 'FOK', octype: 'Cover' });

        vi.clearAllMocks();
        m.confirm.mockImplementation(async () => true);
        const mkt: MobileOrderInput = {
            ...base, price: 0, orderType: 'IOC', priceType: 'MKT', octype: 'DayTrade',
            futuresOrder: { ...base.futuresOrder, price: 0, price_type: 'MKT', order_type: 'IOC', octype: 'DayTrade' },
        };
        await submitMobileOrder(mkt, guards);
        const [req2] = m.confirm.mock.calls[0] as unknown as [Record<string, unknown>];
        expect(req2).toMatchObject({ price: null, note: '市價 IOC・倉別 當沖・送往 永豐 模擬環境' });
        expect(req2).not.toHaveProperty('priceLabel');
    });

    it('傳給送單函式的 beforeDispatch 在 ResumeGate 非 ready 時丟出 mutationNotStarted', async () => {
        await submitMobileOrder(stockInput(sinoStock), guards);
        const [, , , opts] = m.placeStock.mock.calls[0] as unknown as [unknown, unknown, unknown, { beforeDispatch: () => void }];
        expect(() => opts.beforeDispatch()).not.toThrow();
        resumeOk = false;
        let thrown: unknown;
        try { opts.beforeDispatch(); } catch (err) { thrown = err; }
        expect(thrown).toMatchObject({ mutationNotStarted: true });
    });

    it('傳給送單函式的 beforeDispatch 在路由改變時丟出 mutationNotStarted', async () => {
        await submitMobileOrder(stockInput(sinoStock), guards);
        const [, , , opts] = m.placeStock.mock.calls[0] as unknown as [unknown, unknown, unknown, { beforeDispatch: () => void }];
        h.routeSame = false;
        let thrown: unknown;
        try { opts.beforeDispatch(); } catch (err) { thrown = err; }
        expect(thrown).toMatchObject({ mutationNotStarted: true, tradingGateRejected: true });
    });

    it('傳給送單函式的 beforeDispatch 在送出前一刻鎖單時丟出 mutationNotStarted（帶風控原因）', async () => {
        await submitMobileOrder(stockInput(sinoStock, { lot: 'IntradayOdd', quantity: 300 }), guards);
        const [, , , opts] = m.placeStock.mock.calls[0] as unknown as [unknown, unknown, unknown, { beforeDispatch: () => void }];
        expect(() => opts.beforeDispatch()).not.toThrow();
        const locked = '風控鎖啟動中 — 所有下單已封鎖';
        m.risk.mockImplementation(() => locked);
        let thrown: unknown;
        try { opts.beforeDispatch(); } catch (err) { thrown = err; }
        expect(thrown).toMatchObject({ message: locked, mutationNotStarted: true });
        expect(m.risk).toHaveBeenLastCalledWith(300, 'IntradayOdd');
    });

    it('送單函式在送出前呼叫 beforeDispatch 被風控擋下：確定未送出（不是結果未知）', async () => {
        // 模擬 lib 送單函式：先呼叫 beforeDispatch，丟出就不發 HTTP、錯誤原樣往上
        let httpSent = false;
        m.placeStock.mockImplementation(async (...args: unknown[]) => {
            (args[3] as { beforeDispatch: () => void }).beforeDispatch();
            httpSent = true;
            return { order: { id: 's1' } };
        });
        // 第 1 次（確認前）、第 2 次（確認後）、第 3 次（submit 內先跑一次 beforeDispatch）放行，第 4 次（送出前一刻）鎖單
        let calls = 0;
        m.risk.mockImplementation(() => (++calls >= 4 ? '超過單筆上限 1（本筆 2）' : null));
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err).toMatchObject({ message: '超過單筆上限 1（本筆 2）', mutationNotStarted: true });
        expect(httpSent).toBe(false);
        expect(m.placeStock).toHaveBeenCalledTimes(1);
    });

    it('風控一直放行：確認前、確認後、beforeDispatch 都檢查，照常送出', async () => {
        m.placeStock.mockImplementation(async (...args: unknown[]) => {
            (args[3] as { beforeDispatch: () => void }).beforeDispatch();
            return { order: { id: 's1' } };
        });
        const trade = await submitMobileOrder(stockInput(sinoStock), guards);
        expect(trade).toEqual({ order: { id: 's1' } });
        expect(m.risk).toHaveBeenCalledTimes(4);
        for (const call of m.risk.mock.calls) expect(call).toEqual([2, 'Common']);
        expect(m.placeStock).toHaveBeenCalledTimes(1);
    });

    it('送單函式的錯誤原樣丟出、不重送（結果未知由 UI 判斷）', async () => {
        const unknownOutcome = Object.assign(new Error('timeout'), { mutationOutcomeUnknown: true });
        m.placeStock.mockImplementation(async () => { throw unknownOutcome; });
        const err = await rejection(submitMobileOrder(stockInput(sinoStock), guards));
        expect(err).toBe(unknownOutcome);
        expect(err.mutationNotStarted).toBeUndefined();
        expect(m.placeStock).toHaveBeenCalledTimes(1);
    });
});

describe('submitMobileOrder — 信用交易與現股當沖先賣（Phase 2）', () => {
    const creditInput = (over: { action: 'Buy' | 'Sell'; cond?: 'MarginTrading' | 'ShortSelling'; daytrade?: boolean; hint?: string }): MobileOrderInput => {
        const base = stockInput(sinoStock, { action: over.action, quantity: 1, price: 100 });
        if (base.isFutures) throw new Error('expected stock input');
        return {
            ...base,
            stockOrder: {
                ...base.stockOrder,
                ...(over.cond ? { order_cond: over.cond } : {}),
                ...(over.daytrade ? { daytrade_short: true } : {}),
            },
            ...(over.hint ? { creditHint: over.hint } : {}),
        };
    };
    beforeEach(() => {
        m.placeStock.mockImplementation(async () => ({ order: { id: 's1' } }));
    });
    const beforeDispatchOf = () => (m.placeStock.mock.calls[0] as unknown as [unknown, unknown, unknown, { beforeDispatch: () => void }])[3].beforeDispatch;

    it('融資買進：確認面板 credit＝融資、note 含信用名稱；送出 order_cond', async () => {
        await submitMobileOrder(creditInput({ action: 'Buy', cond: 'MarginTrading' }), guards);
        const [req] = m.confirm.mock.calls[0] as unknown as [Record<string, unknown>];
        expect(req).toMatchObject({ action: 'Buy', credit: '融資', note: 'ROD・融資・送往 永豐 模擬環境' });
        const [, order] = m.placeStock.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
        expect(order).toMatchObject({ order_cond: 'MarginTrading' });
        expect('daytrade_short' in order).toBe(false);
    });

    it('融券賣出與融券買進（回補）：credit 都是「融券」', async () => {
        await submitMobileOrder(creditInput({ action: 'Sell', cond: 'ShortSelling' }), guards);
        await submitMobileOrder(creditInput({ action: 'Buy', cond: 'ShortSelling' }), guards);
        const reqs = m.confirm.mock.calls.map(c => (c as unknown as [Record<string, unknown>])[0]);
        expect(reqs[0]).toMatchObject({ action: 'Sell', credit: '融券', note: 'ROD・融券・送往 永豐 模擬環境' });
        expect(reqs[1]).toMatchObject({ action: 'Buy', credit: '融券' });
    });

    it('現股當沖先賣：credit 為空、note 加「現股當沖」（比照桌面 §17），送出 daytrade_short true', async () => {
        await submitMobileOrder(creditInput({ action: 'Sell', daytrade: true }), guards);
        const [req] = m.confirm.mock.calls[0] as unknown as [Record<string, unknown>];
        expect(req).toMatchObject({ credit: undefined, note: 'ROD・現股當沖・送往 永豐 模擬環境' });
        const [, order] = m.placeStock.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
        expect(order).toMatchObject({ daytrade_short: true });
        expect('order_cond' in order).toBe(false);
    });

    it('信用提醒附在路由備註之前', async () => {
        await submitMobileOrder(creditInput({ action: 'Buy', hint: '現股買進不會回補融券' }), guards);
        const [req] = m.confirm.mock.calls[0] as unknown as [Record<string, unknown>];
        expect(req).toMatchObject({ note: 'ROD・現股買進不會回補融券・送往 永豐 模擬環境' });
    });

    it('確認前：合約不可當沖時現沖先賣不確認、不送出', async () => {
        const input = creditInput({ action: 'Sell', daytrade: true });
        const err = await rejection(submitMobileOrder({ ...input, contract: { ...stock, day_trade: 'No' } as ContractInfo }, guards));
        expect(err.mutationNotStarted).toBe(true);
        expect(err.message).toContain('不能現股當沖先賣');
        expect(m.confirm).not.toHaveBeenCalled();
        noOrderSent();
    });

    it('beforeDispatch：確認期間最新合約變成不可當沖 → 以 notStarted 拒絕（比照桌面 assertDayTradeStillAllowed）', async () => {
        h.cachedContract = stock;
        await submitMobileOrder(creditInput({ action: 'Sell', daytrade: true }), guards);
        const beforeDispatch = beforeDispatchOf();
        expect(() => beforeDispatch()).not.toThrow();
        h.cachedContract = { ...stock, day_trade: 'OnlyBuy' };
        let thrown: unknown;
        try { beforeDispatch(); } catch (err) { thrown = err; }
        expect(thrown).toMatchObject({ mutationNotStarted: true });
        expect((thrown as Error).message).toContain('不能現股當沖先賣');
    });

    it('beforeDispatch 在確認前就擋：快取已是不可當沖時不送單', async () => {
        h.cachedContract = { ...stock, day_trade: 'No' };
        const err = await rejection(submitMobileOrder(creditInput({ action: 'Sell', daytrade: true }), guards));
        expect(err.mutationNotStarted).toBe(true);
        expect(m.confirm).toHaveBeenCalledTimes(1);
        noOrderSent();
    });

    it('非現沖的委託不檢查當沖（合約不可當沖也照送）', async () => {
        h.cachedContract = { ...stock, day_trade: 'No' };
        await submitMobileOrder(creditInput({ action: 'Sell' }), guards);
        expect(m.placeStock).toHaveBeenCalledTimes(1);
    });
});
