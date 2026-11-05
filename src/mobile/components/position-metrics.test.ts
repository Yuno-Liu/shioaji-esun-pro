// 持倉頁純計算：市場分段、報酬率、成本與市值、排序、摘要、帳戶分組小計、期貨風險指標、損益條寬度。
// 全部為合成資料（帳號、代號、金額皆非真實）。
import { describe, expect, it } from 'vitest';
import type { ContractInfo } from '../../lib/types/contract';
import type { Account, AccountedPosition } from '../../lib/types/portfolio';
import {
    filterByMarket,
    futuresRiskOf,
    groupPositionsByAccount,
    pnlBarWidth,
    positionCost,
    positionMarketValue,
    positionReturnPct,
    positionSegment,
    sortPositions,
    summarizePositions,
} from './position-metrics';

const accS: Account = { account_type: 'S', broker_id: '9A95', account_id: 'S0001', person_id: '', signed: true, username: '' };
const accS2: Account = { account_type: 'S', broker_id: '8840', account_id: 'E0001', person_id: '', signed: true, username: '' };
const accF: Account = { account_type: 'F', broker_id: 'F002000', account_id: 'F0001', person_id: '', signed: true, username: '' };

const stock = (over: Record<string, unknown> = {}) =>
    ({ id: 1, code: '9901', direction: 'Buy', quantity: 2000, price: 100, last_price: 110, pnl: 20_000, yd_quantity: 2000, cond: 'Cash', account: accS, ...over }) as AccountedPosition;
const fut = (over: Record<string, unknown> = {}) =>
    ({ id: 2, code: 'FUT1', direction: 'Buy', quantity: 1, price: 20_000, last_price: 20_200, pnl: 40_000, account: accF, ...over }) as AccountedPosition;
const opt = (over: Record<string, unknown> = {}) =>
    ({ id: 3, code: 'OPT1', direction: 'Sell', quantity: 2, price: 50, last_price: 40, pnl: 1_000, account: accF, ...over }) as AccountedPosition;

const contracts: Record<string, Pick<ContractInfo, 'security_type'>> = { '9901': { security_type: 'STK' }, FUT1: { security_type: 'FUT' }, OPT1: { security_type: 'OPT' } };
const contractOf = (code: string) => contracts[code];

describe('市場分段', () => {
    it('positionSegment：股票看持倉型別；期權看商品 security_type；未載入回 null', () => {
        expect(positionSegment(stock())).toBe('stock');
        expect(positionSegment(fut(), { security_type: 'FUT' })).toBe('futures');
        expect(positionSegment(opt(), { security_type: 'OPT' })).toBe('options');
        expect(positionSegment(fut())).toBeNull();
    });

    it('filterByMarket：全部不篩；股票不受期權商品資料影響；未歸類筆數', () => {
        const rows = [stock(), fut(), opt()];
        expect(filterByMarket(rows, 'all', () => undefined)).toEqual({ rows, unclassified: 0 });
        expect(filterByMarket(rows, 'stock', () => undefined)).toEqual({ rows: [rows[0]], unclassified: 0 });
        expect(filterByMarket(rows, 'futures', contractOf)).toEqual({ rows: [rows[1]], unclassified: 0 });
        expect(filterByMarket(rows, 'options', contractOf)).toEqual({ rows: [rows[2]], unclassified: 0 });
        expect(filterByMarket(rows, 'futures', code => (code === 'FUT1' ? contracts.FUT1 : undefined))).toEqual({ rows: [rows[1]], unclassified: 1 });
    });
});

describe('列的數值', () => {
    it('成本＝均價×|股數|、市值＝|股數|×現價（融券也為正）；期權回 null', () => {
        expect(positionCost(stock())).toBe(200_000);
        expect(positionMarketValue(stock())).toBe(220_000);
        expect(positionMarketValue(stock({ direction: 'Sell', cond: 'ShortSelling' }))).toBe(220_000);
        expect(positionMarketValue(stock({ last_price: 0 }))).toBeNull();
        expect(positionCost(stock({ price: 0 }))).toBeNull();
        expect(positionCost(fut())).toBeNull();
        expect(positionMarketValue(fut())).toBeNull();
    });

    it('報酬率：股票＝損益÷成本（含費稅時與損益同號）；期貨依方向；算不出回 null', () => {
        expect(positionReturnPct(stock())).toBeCloseTo(10);
        expect(positionReturnPct(stock({ pnl: -201, price: 54.9, last_price: 55.2, quantity: 9000 }))).toBeCloseTo(-0.0407, 3);
        expect(positionReturnPct(fut())).toBeCloseTo(1);
        expect(positionReturnPct(opt())).toBeCloseTo(20); // 賣方：(40 − 50) ÷ 50 × −1
        expect(positionReturnPct(stock({ price: 0 }))).toBeNull();
        expect(positionReturnPct(stock({ quantity: 0 }))).toBeNull();
        expect(positionReturnPct(fut({ last_price: 0 }))).toBeNull();
    });
});

describe('排序', () => {
    const a = stock({ id: 1, code: 'B', pnl: 5_000, price: 100, quantity: 1000, last_price: 105 }); // 5%、105,000
    const b = stock({ id: 2, code: 'A', pnl: 30_000, price: 50, quantity: 3000, last_price: 60 }); // 20%、180,000
    const c = fut({ id: 3, code: 'C', pnl: -1_000, price: 0 }); // 報酬率、市值皆 null
    const rows = [a, b, c];

    it('default 保持券商順序且不改原陣列', () => {
        const out = sortPositions(rows, 'default');
        expect(out).toEqual(rows);
        expect(out).not.toBe(rows);
    });

    it('損益、報酬率、市值由大到小（null 排最後）；代碼由小到大', () => {
        expect(sortPositions(rows, 'pnl').map(p => p.code)).toEqual(['A', 'B', 'C']);
        expect(sortPositions(rows, 'return').map(p => p.code)).toEqual(['A', 'B', 'C']);
        expect(sortPositions([c, a, b], 'value').map(p => p.code)).toEqual(['A', 'B', 'C']);
        expect(sortPositions(rows, 'code').map(p => p.code)).toEqual(['A', 'B', 'C']);
        expect(rows.map(p => p.code)).toEqual(['B', 'A', 'C']);
    });
});

describe('摘要與分組小計', () => {
    it('summarizePositions：損益合計、股票市值；全部為股票時才有報酬率合計', () => {
        const mixed = summarizePositions([stock(), fut()]);
        expect(mixed).toMatchObject({ count: 2, pnl: 60_000, marketValue: { value: 220_000, incomplete: false }, stockCost: 200_000, pnlPct: null });
        const stocks = summarizePositions([stock(), stock({ id: 9, code: '9902', pnl: -10_000 })]);
        expect(stocks.pnlPct).toBeCloseTo(2.5); // 10,000 ÷ 400,000
        const futOnly = summarizePositions([fut()]);
        expect(futOnly.marketValue).toBeNull();
        expect(futOnly.stockCost).toBeNull();
        expect(summarizePositions([]).pnlPct).toBeNull();
    });

    it('summarizePositions：缺現價的列略過並標示不完整', () => {
        const s = summarizePositions([stock(), stock({ id: 9, last_price: Number.NaN })]);
        expect(s.marketValue).toEqual({ value: 220_000, incomplete: true });
    });

    it('groupPositionsByAccount：依帳戶第一次出現的順序分組；小計筆數、損益、股票市值', () => {
        const rows = [stock(), fut(), stock({ id: 4, account: accS2, pnl: -5_000 }), stock({ id: 5, code: '9903', pnl: 1_000 }), opt(), stock({ id: 6, account: undefined, pnl: 7 })];
        const groups = groupPositionsByAccount(rows);
        expect(groups.map(g => g.key)).toEqual(['S:9A95:S0001', 'F:F002000:F0001', 'S:8840:E0001', '']);
        expect(groups[0]).toMatchObject({ count: 2, pnl: 21_000, value: { value: 440_000, incomplete: false }, account: accS });
        expect(groups[0]!.rows.map(p => p.id)).toEqual([1, 5]);
        expect(groups[1]).toMatchObject({ count: 2, pnl: 41_000, value: null });
        expect(groups[2]).toMatchObject({ count: 1, pnl: -5_000 });
        expect(groups[3]!.account).toBeUndefined();
        expect(groups[3]!.count).toBe(1);
    });
});

describe('期貨風險與損益條', () => {
    it('futuresRiskOf：沒有保證金回 null；原始保證金或風險指標為 0 時無意義；<100 危險、<200 注意', () => {
        expect(futuresRiskOf(undefined)).toBeNull();
        expect(futuresRiskOf({ equity: 0, initial_margin: 0, risk_indicator: 0 })).toEqual({ equity: 0, risk: null, level: null });
        expect(futuresRiskOf({ equity: 100, initial_margin: 50, risk_indicator: 80 })).toEqual({ equity: 100, risk: 80, level: 'danger' });
        expect(futuresRiskOf({ equity: 100, initial_margin: 50, risk_indicator: 150 })?.level).toBe('warn');
        expect(futuresRiskOf({ equity: 100, initial_margin: 50, risk_indicator: 200 })?.level).toBe('ok');
        expect(futuresRiskOf({ equity: Number.NaN, initial_margin: 50, risk_indicator: 300 })?.equity).toBeNull();
    });

    it('pnlBarWidth：以最大 |損益| 為 50%；缺值或最大值為 0 回 0', () => {
        expect(pnlBarWidth(100, 200)).toBe(25);
        expect(pnlBarWidth(-200, 200)).toBe(50);
        expect(pnlBarWidth(500, 200)).toBe(50);
        expect(pnlBarWidth(100, 0)).toBe(0);
        expect(pnlBarWidth(Number.NaN, 100)).toBe(0);
    });
});
