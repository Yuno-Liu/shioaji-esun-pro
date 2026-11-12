// 下單面板精簡報價（ticket-quote-row）：漲跌差額不吸附到現價級距（2026-11-13 稽核）
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../../lib/types/contract';

const h = vi.hoisted(() => ({ quote: undefined as unknown }));
vi.mock('../../../hooks/use-stream', () => ({ useQuote: () => h.quote }));

import { TicketQuoteRow, ticketChangeText } from './ticket-quote-row';

const stock = { exchange: 'TSE', code: '2330', security_type: 'STK', name: '台積電', reference: 997, limit_up: 1095, limit_down: 898 } as ContractInfo;
let view: ReactTestRenderer | undefined;
const textOf = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('ticketChangeText', () => {
    it('997 → 1000 是 +3（不是 +5）；99.9 → 100.5 是 +0.6；499.5 → 501 是 +1.5；下跌帶負號', () => {
        expect(ticketChangeText(stock, 1000, 3)).toBe('+3');
        expect(ticketChangeText(stock, 100.5, 0.6)).toBe('+0.6');
        expect(ticketChangeText(stock, 501, 1.5)).toBe('+1.5');
        expect(ticketChangeText(stock, 997, -3)).toBe('-3');
    });

    it('推不出參考價（沒有現價）時退回現價級距的格式', () => {
        expect(ticketChangeText(stock, null, 3)).toBe('3.00');
    });
});

describe('TicketQuoteRow', () => {
    it('參考 997、成交 1000：漲跌顯示 ▲+3', async () => {
        h.quote = { tick: { close: '1000', price_chg: '3', volume: 2, total_volume: 1234 } };
        await act(async () => { view = create(createElement(TicketQuoteRow, { contract: stock, snapshot: undefined })); });
        const change = view!.root.find(n => n.props['data-testid'] === 'ticket-quote-change' && typeof n.type === 'string');
        expect(textOf(change)).toBe('▲+3 +0.30%');
        const vol = view!.root.find(n => n.props['data-testid'] === 'ticket-quote-volume' && typeof n.type === 'string');
        expect(textOf(vol)).toBe('單:2　總:1,234 張');
    });
});
