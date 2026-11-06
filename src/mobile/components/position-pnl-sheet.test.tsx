// 損益計算明細面板的融資利息說明：計到以現價賣出的交割日（T+2、週末順延、未計國定假日）；
// 分批缺價 → 估算並說明以均價計；缺股數 → 未含並說明；持倉列標示同步。只讀面板，不涉及任何送單。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRADING_COST_SETTINGS } from '../../lib/trading-cost-settings';
import type { ContractInfo } from '../../lib/types/contract';
import { computeStockPnl, type MarginLot, type StockPnl } from '../lib/position-pnl';
import { interestNote, PNL_TEXT, pnlTags, PositionPnlSheet } from './position-pnl-sheet';

const NOW = Date.parse('2026-11-06T10:00:00+08:00'); // 週五
const contract = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null, day_trade: 'Yes' } as unknown as ContractInfo;

function marginPnl(marginLots: MarginLot[] | null, shares = 2000): StockPnl {
    const r = computeStockPnl({
        kind: 'margin', shares, avgPrice: 100, lastPrice: 110, contract, now: NOW, todayShares: null, marginLots,
        settings: { ...DEFAULT_TRADING_COST_SETTINGS, marginAnnualRate: 0.0645 },
    });
    if (!r) throw new Error('computeStockPnl returned null');
    return r;
}

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const byTestId = (id: string) => view!.root.findAll(n => n.props?.['data-testid'] === id && typeof n.type === 'string');
async function render(pnl: StockPnl) {
    await act(async () => {
        view = create(createElement(PositionPnlSheet, { summary: '2330 融資 多 2張', pnl, contract, brokerPnl: 20_000, privMoney: false, onClose: () => undefined }));
    });
}

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('融資利息說明', () => {
    it('齊全：金額＋計到 2026-11-10 交割（T+2）並註明未計國定假日', async () => {
        const pnl = marginPnl([{ tradeDate: '2026-10-01', price: 100, shares: 2000 }]);
        expect(pnl.interestStatus).toBe('included');
        await render(pnl);
        // 120,000 × 6.45% × 36 ÷ 365 = 763.4 → 763
        expect(text(byTestId('pnl-interest')[0]!)).toBe('763');
        const note = text(byTestId('pnl-interest-note')[0]!);
        expect(note).toContain('以現價賣出的交割日 2026-11-10');
        expect(note).toContain('T+2');
        expect(note).toContain('週末順延');
        expect(note).toContain('未計國定假日');
        expect(note).toContain('合計 763');
        expect(pnlTags(pnl)).not.toContain(PNL_TEXT.noInterest);
        expect(pnlTags(pnl)).not.toContain(PNL_TEXT.interestEstimated);
    });

    it('分批缺價：仍計入（以均價估算），標「融資利息估算」並說明', async () => {
        const pnl = marginPnl([{ tradeDate: '2026-10-01', price: 100, shares: 1000 }, { tradeDate: '2026-10-01', price: null, shares: 1000 }]);
        expect(pnl.interestStatus).toBe('estimated');
        await render(pnl);
        expect(text(byTestId('pnl-interest')[0]!)).toBe('764');
        expect(text(byTestId('pnl-interest-note')[0]!)).toContain('部分分批缺成交價，該批以持倉均價估算融資金額');
        expect(pnlTags(pnl)).toContain(PNL_TEXT.interestEstimated);
    });

    it('分批缺股數：未含利息並如實說明，持倉列標「未含融資利息」', async () => {
        const pnl = marginPnl([{ tradeDate: '2026-10-01', price: 100, shares: 1000 }, { tradeDate: '2026-10-01', price: 100, shares: null }]);
        expect(pnl.interestStatus).toBe('incomplete');
        await render(pnl);
        expect(text(byTestId('pnl-interest')[0]!)).toBe('分批明細缺股數，未含融資利息');
        expect(text(byTestId('pnl-interest-note')[0]!)).toContain('未含融資利息');
        expect(pnlTags(pnl)).toContain(PNL_TEXT.noInterest);
    });

    it('股數合計不符：估算並說明；非融資沒有利息說明', () => {
        const pnl = marginPnl([{ tradeDate: '2026-10-01', price: 100, shares: 1000 }]);
        expect(pnl.interestStatus).toBe('estimated');
        expect(interestNote(pnl, '382')).toContain('分批明細的股數合計與持倉股數不同');
        expect(interestNote({ ...pnl, kind: 'cash', interestStatus: 'na' }, '0')).toBeNull();
        expect(interestNote({ ...pnl, interestStatus: 'noRate', interestGaps: [] }, '0')).toBeNull();
    });
});
