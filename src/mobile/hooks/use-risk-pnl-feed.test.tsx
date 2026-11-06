// 風控當日損益餵送（規格 §7.5、§14.1）：與 src/App.tsx 同公式（持倉 pnl 加總＋期貨結算損益）；
// 持倉或保證金尚未實際讀到時 known = false。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    reportDailyPnl: vi.fn(),
    trading: {} as Record<string, unknown>,
}));
vi.mock('../../lib/risk', () => ({ reportDailyPnl: m.reportDailyPnl }));
vi.mock('../../lib/trading-state', () => ({ useTradingState: () => m.trading }));

import { useRiskPnlFeed } from './use-risk-pnl-feed';

function Probe() {
    useRiskPnlFeed();
    return null;
}

const positions = [
    { id: 1, code: '2330', direction: 'Buy', quantity: 3000, price: 1052.5, last_price: 1085, pnl: 97500, yd_quantity: 0 },
    { id: 2, code: 'TXFL6', direction: 'Buy', quantity: 1, price: 22800, last_price: 22950, pnl: 30000 },
    { id: 3, code: '2317', direction: 'Buy', quantity: 1000, price: 200, last_price: 200, pnl: Number.NaN, yd_quantity: 0 },
];

function trading(over: { positions?: unknown[]; margin?: unknown; updatedAt?: number | null } = {}) {
    return {
        positions: over.positions ?? positions,
        margin: 'margin' in over ? over.margin : { future_settle_profitloss: -2500 },
        queries: { positions: { updatedAt: 'updatedAt' in over ? over.updatedAt : 1_700_000_000_000 } },
    };
}

let view: ReactTestRenderer | undefined;
async function render() {
    await act(async () => { view = create(createElement(Probe)); });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.reportDailyPnl.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('useRiskPnlFeed', () => {
    it('持倉未實現損益加總（NaN 視為 0）＋期貨結算損益；兩者都已讀到時 known = true', async () => {
        m.trading = trading();
        await render();
        expect(m.reportDailyPnl).toHaveBeenLastCalledWith(97500 + 30000 - 2500, true);
    });

    it('持倉尚未讀到（updatedAt 為 null）→ known = false', async () => {
        m.trading = trading({ positions: [], updatedAt: null });
        await render();
        expect(m.reportDailyPnl).toHaveBeenLastCalledWith(-2500, false);
    });

    it('保證金尚未讀到（margin undefined）→ known = false，結算損益以 0 計', async () => {
        m.trading = trading({ margin: undefined });
        await render();
        expect(m.reportDailyPnl).toHaveBeenLastCalledWith(127500, false);
    });

    it('持倉更新時重新餵送', async () => {
        m.trading = trading();
        await render();
        m.trading = trading({ positions: [positions[0]] });
        await act(async () => { view!.update(createElement(Probe)); });
        expect(m.reportDailyPnl).toHaveBeenLastCalledWith(97500 - 2500, true);
    });
});
