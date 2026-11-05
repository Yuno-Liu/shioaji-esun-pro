// 交易圖表線條模型（規格 §6.2、§14.1）：只畫目前商品、有剩餘量的限價委託；modified_price 優先；
// 近月別名對應；成本線；漲跌停只對股票；另含五檔「我 買2」標記、MA、走勢時段整形、即時 K 棒 label。
import { describe, expect, it } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { Candle } from '../../lib/types/market';
import type { AccountedTrade, OrderStatusName } from '../../lib/types/order';
import type { AccountedPosition } from '../../lib/types/portfolio';
import {
    chartPriceLines,
    depthMarkText,
    depthOrderMarks,
    intradayBars,
    lastMovingAverage,
    limitLines,
    liveBarTime,
    movingAverage,
    positionCostLines,
    priceKey,
    priceLinesKey,
    referenceLines,
    workingOrderLines,
} from './chart-model';

interface TradeOpts {
    id?: string;
    code?: string;
    target?: string | null;
    secType?: 'STK' | 'FUT';
    action?: 'Buy' | 'Sell';
    price?: number;
    priceType?: string;
    qty?: number;
    deal?: number;
    cancel?: number;
    status?: OrderStatusName;
    modified?: number;
    lot?: string;
}

function trade(o: TradeOpts = {}): AccountedTrade {
    const id = o.id ?? 'o1';
    return {
        contract: { exchange: o.secType === 'FUT' ? 'TAIFEX' : 'TSE', code: o.code ?? '2330', security_type: o.secType ?? 'STK', target_code: o.target ?? null },
        order: {
            id,
            seqno: '1',
            ordno: 'A0001',
            action: o.action ?? 'Buy',
            price: o.price ?? 1080,
            quantity: o.qty ?? 2,
            price_type: o.priceType ?? 'LMT',
            ...(o.lot ? { order_lot: o.lot } : {}),
        },
        status: {
            id,
            status: o.status ?? 'Submitted',
            status_code: '',
            order_quantity: o.qty ?? 2,
            deal_quantity: o.deal ?? 0,
            cancel_quantity: o.cancel ?? 0,
            modified_price: o.modified ?? 0,
            msg: '',
            deals: [],
        },
    };
}

function position(code: string, direction: 'Buy' | 'Sell', quantity: number, price: number): AccountedPosition {
    return { id: 1, code, direction, quantity, price, last_price: price, pnl: 0, yd_quantity: 0 };
}

function contract(over: Partial<ContractInfo> = {}): ContractInfo {
    return {
        exchange: 'TSE',
        code: '2330',
        security_type: 'STK',
        target_code: null,
        name: '台積電',
        currency: 'TWD',
        limit_up: 1175,
        limit_down: 963,
        reference: 1070,
        day_trade: 'Yes',
        update_date: '2026/11/05',
        category: '24',
        margin_trading_balance: 0,
        short_selling_balance: 0,
        ...over,
    };
}

describe('workingOrderLines', () => {
    it('只畫目前商品、仍在工作中且有剩餘量的限價委託', () => {
        const lines = workingOrderLines('2330', [
            trade({ id: 'mine', qty: 3, deal: 1 }),
            trade({ id: 'other-code', code: '2317' }),
            trade({ id: 'filled', status: 'Filled', deal: 2 }),
            trade({ id: 'cancelled', status: 'Cancelled', cancel: 2 }),
            trade({ id: 'no-remaining', qty: 2, deal: 1, cancel: 1 }),
            trade({ id: 'market', priceType: 'MKT', price: 0 }),
            trade({ id: 'sell', action: 'Sell', price: 1090, qty: 1 }),
        ]);
        expect(lines.map(l => l.tradeId)).toEqual(['mine', 'sell']);
        expect(lines[0]).toEqual({ key: 'order:mine', price: 1080, kind: 'order-buy', label: '買 2 @1,080', tradeId: 'mine' });
        expect(lines[1]).toMatchObject({ kind: 'order-sell', label: '賣 1 @1,090' });
    });

    it('PartFilled／PendingSubmit 仍算工作中', () => {
        const lines = workingOrderLines('2330', [
            trade({ id: 'part', status: 'PartFilled', qty: 5, deal: 2 }),
            trade({ id: 'pending', status: 'PendingSubmit' }),
        ]);
        expect(lines.map(l => [l.tradeId, l.label])).toEqual([['part', '買 3 @1,080'], ['pending', '買 2 @1,080']]);
    });

    it('改價後以 modified_price 為準', () => {
        const [line] = workingOrderLines('2330', [trade({ price: 1080, modified: 1075 })]);
        expect(line!.price).toBe(1075);
        expect(line!.label).toBe('買 2 @1,075');
        // modified_price 為 0 表示未改價
        expect(workingOrderLines('2330', [trade({ price: 1080, modified: 0 })])[0]!.price).toBe(1080);
    });

    it('近月別名：別名頁面（TXFR1→TXFF6）也畫得出以實際月份送出的委託', () => {
        const alias = contract({ code: 'TXFR1', target_code: 'TXFF6', security_type: 'FUT', exchange: 'TAIFEX' });
        const orderable = alias.target_code || alias.code;
        const trades = [
            // 委託回報的合約是實際月份
            trade({ id: 'actual', code: 'TXFF6', secType: 'FUT', price: 23000, qty: 1 }),
            // 回報若帶別名＋target_code，同樣以 target_code 比對
            trade({ id: 'aliased', code: 'TXFR1', target: 'TXFF6', secType: 'FUT', price: 22990, qty: 1, action: 'Sell' }),
            // 次月不應出現在近月頁
            trade({ id: 'next-month', code: 'TXFG6', secType: 'FUT', price: 23100, qty: 1 }),
        ];
        expect(workingOrderLines(orderable, trades).map(l => l.tradeId)).toEqual(['actual', 'aliased']);
        expect(chartPriceLines({ contract: alias, trades, positions: [] }).filter(l => l.tradeId).map(l => l.tradeId)).toEqual(['actual', 'aliased']);
    });

    it('零股委託的數量標「股」', () => {
        expect(workingOrderLines('2330', [trade({ lot: 'IntradayOdd', qty: 300 })])[0]!.label).toBe('買 300股 @1,080');
    });
});

describe('positionCostLines', () => {
    it('目前商品的均價（多空分開、數量加權）', () => {
        const lines = positionCostLines('2330', [
            position('2330', 'Buy', 2000, 1050),
            position('2330', 'Buy', 1000, 1057.5),
            position('2317', 'Buy', 1000, 200),
            position('2330', 'Sell', 1000, 1100),
        ]);
        expect(lines).toEqual([
            { key: 'cost:Buy', price: 1052.5, kind: 'cost', label: '成本 1,052.5' },
            { key: 'cost:Sell', price: 1100, kind: 'cost', label: '空單成本 1,100' },
        ]);
    });

    it('沒有持倉、數量或均價為 0 時不畫', () => {
        expect(positionCostLines('2330', [])).toEqual([]);
        expect(positionCostLines('2330', [position('2330', 'Buy', 0, 1050), position('2330', 'Buy', 1000, 0)])).toEqual([]);
    });

    it('期貨持倉以實際月份比對（別名頁面也看得到成本線）', () => {
        const alias = contract({ code: 'TXFR1', target_code: 'TXFF6', security_type: 'FUT', exchange: 'TAIFEX', limit_up: 25000, limit_down: 20000, reference: 22500 });
        const lines = chartPriceLines({ contract: alias, trades: [], positions: [position('TXFF6', 'Buy', 1, 22400)] });
        expect(lines.filter(l => l.kind === 'cost')).toEqual([{ key: 'cost:Buy', price: 22400, kind: 'cost', label: '成本 22,400' }]);
    });
});

describe('limitLines／referenceLines', () => {
    it('漲跌停只對股票', () => {
        expect(limitLines(contract())).toEqual([
            { key: 'limit-up', price: 1175, kind: 'limit-up', label: '漲停' },
            { key: 'limit-down', price: 963, kind: 'limit-down', label: '跌停' },
        ]);
        expect(limitLines(contract({ security_type: 'FUT' }))).toEqual([]);
        expect(limitLines(contract({ security_type: 'OPT' }))).toEqual([]);
        expect(limitLines(contract({ security_type: 'IND' }))).toEqual([]);
    });

    it('沒有漲跌停值時不畫', () => {
        expect(limitLines(contract({ limit_up: 0, limit_down: 0 }))).toEqual([]);
    });

    it('參考價線（任何商品；參考價為 0 不畫）', () => {
        expect(referenceLines(contract())).toEqual([{ key: 'reference', price: 1070, kind: 'reference', label: '參考' }]);
        expect(referenceLines(contract({ reference: 0 }))).toEqual([]);
    });

    it('chartPriceLines 合併全部線條；期貨不含漲跌停', () => {
        const stock = chartPriceLines({ contract: contract(), trades: [trade()], positions: [position('2330', 'Buy', 3000, 1052.5)] });
        expect(stock.map(l => l.kind)).toEqual(['reference', 'limit-up', 'limit-down', 'cost', 'order-buy']);
        const fut = chartPriceLines({ contract: contract({ code: 'TXFF6', security_type: 'FUT' }), trades: [], positions: [] });
        expect(fut.map(l => l.kind)).toEqual(['reference']);
    });

    it('priceLinesKey 隨價格與標籤變化', () => {
        const a = priceLinesKey(workingOrderLines('2330', [trade()]));
        expect(priceLinesKey(workingOrderLines('2330', [trade()]))).toBe(a);
        expect(priceLinesKey(workingOrderLines('2330', [trade({ modified: 1075 })]))).not.toBe(a);
        expect(priceLinesKey(workingOrderLines('2330', [trade({ deal: 1 })]))).not.toBe(a);
    });
});

describe('depthOrderMarks', () => {
    it('依價位加總自己的剩餘量；整股與零股分開', () => {
        const trades = [
            trade({ id: 'a', price: 1084, qty: 2 }),
            trade({ id: 'b', price: 1084, qty: 1, action: 'Sell' }),
            trade({ id: 'c', price: 1085, qty: 3, deal: 1 }),
            trade({ id: 'odd', price: 1084, qty: 300, lot: 'IntradayOdd' }),
            trade({ id: 'mkt', priceType: 'MKT', price: 0 }),
        ];
        const board = depthOrderMarks('2330', trades, false);
        expect(depthMarkText(board.get(priceKey('1084.0')))).toBe('我 買2 賣1');
        expect(depthMarkText(board.get(priceKey(1085)))).toBe('我 買2');
        expect(board.get(priceKey(1083))).toBeUndefined();
        const odd = depthOrderMarks('2330', trades, true);
        expect(depthMarkText(odd.get(priceKey(1084)))).toBe('我 買300');
        expect(odd.size).toBe(1);
    });

    it('改價後標在新價位', () => {
        const board = depthOrderMarks('2330', [trade({ price: 1080, modified: 1083 })], false);
        expect([...board.keys()]).toEqual([priceKey(1083)]);
    });

    it('depthMarkText 沒有量時回傳 null', () => {
        expect(depthMarkText(undefined)).toBeNull();
        expect(depthMarkText({ buy: 0, sell: 0 })).toBeNull();
    });
});

describe('movingAverage', () => {
    const bars = [1, 2, 3, 4, 5, 6].map((close, i) => ({ time: 60 * (i + 1), close }));

    it('前 period-1 根沒有值', () => {
        expect(movingAverage(bars, 5)).toEqual([{ time: 300, value: 3 }, { time: 360, value: 4 }]);
        expect(movingAverage(bars, 20)).toEqual([]);
        expect(movingAverage(bars, 0)).toEqual([]);
    });

    it('lastMovingAverage 與完整計算的最後一點相同', () => {
        expect(lastMovingAverage(bars, 5)).toEqual({ time: 360, value: 4 });
        expect(lastMovingAverage(bars.slice(0, 4), 5)).toBeNull();
    });
});

describe('intradayBars', () => {
    const c = (time: number, close: number, volume = 1): Candle => ({ time, open: close, high: close, low: close, close, volume });

    it('只留時段內的 K 棒，收盤 grace 內的定盤併入最後一根', () => {
        const win = { start: 1000, end: 1180 };
        const out = intradayBars([c(940, 1), c(1000, 2), c(1060, 3), c(1120, 4), c(1180, 5), c(1240, 6, 2), c(1500, 7)], win, 240);
        expect(out.map(b => b.time)).toEqual([1060, 1120, 1180]);
        expect(out[2]).toMatchObject({ close: 6, high: 6, low: 5, volume: 3 });
    });
});

describe('liveBarTime', () => {
    it('close-label-right：N 分 K 為 floor+N，日 K 為日曆日', () => {
        // 09:00:30 的成交 → 1 分 K label 09:01、5 分 K label 09:05
        const t = 9 * 3600 + 30;
        expect(liveBarTime(1, t)).toBe(9 * 3600 + 60);
        expect(liveBarTime(5, t)).toBe(9 * 3600 + 300);
        expect(liveBarTime(60, t)).toBe(10 * 3600);
        expect(liveBarTime(1440, 86400 * 3 + t)).toBe(86400 * 3);
    });
});
