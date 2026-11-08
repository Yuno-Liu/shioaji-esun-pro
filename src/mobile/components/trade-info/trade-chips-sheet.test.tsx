// 「籌碼與當沖」說明面板（唯讀）：
// - 請求紀律：credit_enquire 與 short_stock_sources 只在面板開啟、而且是股票時讀；每檔每個交易日各最多 1 次
//   （關閉再開、卸載再掛載都不重讀；失敗也不重試）；換商品或過了台北午夜才重讀。期權、指數 0 次。
// - 內容：融資／融券成數、可否（停資、停券原因）、券源、資券餘額、處置、當沖規則；期權與指數不顯示信用項目。
// - S1：面板內按遍所有按鈕，openTicket／openOrderAction 與 lib 送單、改單、刪單函式 0 次。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../../../lib/types/contract';

const m = vi.hoisted(() => ({
    apiPost: vi.fn(),
    apiGet: vi.fn(),
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    send: {
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        placeComboOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelOrders: vi.fn(),
        cancelVerifiedOrder: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
        submitMobileOrder: vi.fn(),
        placeQuickOrder: vi.fn(),
        cancelAllOrders: vi.fn(),
    },
}));
vi.mock('../../../lib/api', () => ({ apiPost: m.apiPost, apiGet: m.apiGet }));
vi.mock('../../lib/mobile-store', () => ({ openTicket: m.openTicket, openOrderAction: m.openOrderAction }));
vi.mock('../../../lib/shioaji', () => ({
    placeStockOrder: m.send.placeStockOrder,
    placeFuturesOrder: m.send.placeFuturesOrder,
    placeComboOrder: m.send.placeComboOrder,
    cancelOrder: m.send.cancelOrder,
    cancelOrders: m.send.cancelOrders,
    cancelVerifiedOrder: m.send.cancelVerifiedOrder,
    updateOrderPrice: m.send.updateOrderPrice,
    updateOrderQty: m.send.updateOrderQty,
}));
vi.mock('../../lib/mobile-order', () => ({ submitMobileOrder: m.send.submitMobileOrder }));
vi.mock('../../../lib/trade', () => ({ placeQuickOrder: m.send.placeQuickOrder, cancelAllOrders: m.send.cancelAllOrders }));

import { resetCreditEnquireCache } from '../../../lib/credit-eligibility';
import { resetTradeChipsForTest, SHORT_SOURCES_PATH } from '../../lib/trade-chips';
import { creditAbilityText, TradeChipsSheet } from './trade-chips-sheet';

const CREDIT_PATH = '/api/v1/data/credit_enquire';

const stock = {
    exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD',
    limit_up: 1175, limit_down: 963, reference: 1070, day_trade: 'Yes', update_date: '', category: '',
    margin_trading_balance: 12345, short_selling_balance: 678,
} as ContractInfo;
const fut = { ...stock, code: 'TXFL6', name: '臺股期貨', exchange: 'TAIFEX', security_type: 'FUT', day_trade: '' } as ContractInfo;
const opt = { ...stock, code: 'TXO22400L6', name: '臺指選擇權', exchange: 'TAIFEX', security_type: 'OPT', day_trade: '' } as ContractInfo;
const ind = { ...stock, code: '001', name: '加權指數', security_type: 'IND', day_trade: '' } as ContractInfo;

const creditRow = (code: string, over: Record<string, number> = {}) => ({
    stock_id: code, system: 'HE', update_time: '2026-11-06 08:00:00',
    margin_unit: 4000, short_unit: 3000, margin_loan_ratio: 60, short_margin_ratio: 90, ...over,
});

let view: ReactTestRenderer | undefined;
const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(k => text(k as ReactTestInstance | string)).join(''));
const all = (id: string) => view!.root.findAll(n => n.props?.['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => all(id)[0]!;
const calls = (path: string) => m.apiPost.mock.calls.filter(c => c[0] === path).length;
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

function el(contract: ContractInfo, open = true, punished: boolean | null = false) {
    return createElement(TradeChipsSheet, { open, onClose: () => undefined, contract, punished });
}
async function render(contract: ContractInfo, open = true, punished: boolean | null = false) {
    await act(async () => { view = create(el(contract, open, punished)); });
    await settle();
}
async function rerender(contract: ContractInfo, open = true, punished: boolean | null = false) {
    await act(async () => { view!.update(el(contract, open, punished)); });
    await settle();
}
async function unmount() {
    await act(async () => view?.unmount());
    view = undefined;
}

function okResponses(over: Record<string, number> = {}) {
    m.apiPost.mockImplementation(async (path: string, body: { contracts: { code: string }[] }) => {
        const code = body.contracts[0]!.code;
        if (path === CREDIT_PATH) return [creditRow(code, over)];
        if (path === SHORT_SOURCES_PATH) return [{ code, short_stock_source: 58260, datetime: '2026-11-06 08:00:00' }];
        throw new Error(`unexpected ${path}`);
    });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T10:00:00+08:00'));
    resetCreditEnquireCache();
    resetTradeChipsForTest();
    m.apiPost.mockReset();
    m.apiGet.mockReset();
    m.openTicket.mockReset();
    m.openOrderAction.mockReset();
    Object.values(m.send).forEach(f => f.mockReset());
});
afterEach(async () => {
    await unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('請求紀律（每檔每個交易日各最多 1 次）', () => {
    it('沒開面板不讀；開啟後 credit_enquire 與券源各 1 次，帶這一檔的合約', async () => {
        okResponses();
        await render(stock, false);
        expect(m.apiPost).not.toHaveBeenCalled();
        await rerender(stock, true);
        expect(calls(CREDIT_PATH)).toBe(1);
        expect(calls(SHORT_SOURCES_PATH)).toBe(1);
        const key = { security_type: 'STK', exchange: 'TSE', code: '2330' };
        expect(m.apiPost).toHaveBeenCalledWith(CREDIT_PATH, { contracts: [key] });
        expect(m.apiPost).toHaveBeenCalledWith(SHORT_SOURCES_PATH, { contracts: [key] });
        expect(m.apiGet).not.toHaveBeenCalled();
    });

    it('關閉再開、卸載再掛載：同一檔同一天不重讀', async () => {
        okResponses();
        await render(stock);
        await rerender(stock, false);
        await rerender(stock, true);
        await unmount();
        await render(stock);
        expect(calls(CREDIT_PATH)).toBe(1);
        expect(calls(SHORT_SOURCES_PATH)).toBe(1);
        expect(text(one('trade-chips-margin-ratio'))).toBe('60%');
    });

    it('失敗：顯示查詢失敗，關閉再開、重新掛載都不重試', async () => {
        m.apiPost.mockRejectedValue(new Error('503'));
        await render(stock);
        expect(text(one('trade-chips-credit-status'))).toContain('查詢失敗');
        expect(text(one('trade-chips-source'))).toContain('查詢失敗');
        await rerender(stock, false);
        await rerender(stock, true);
        await unmount();
        await render(stock);
        await unmount();
        await render(stock);
        expect(calls(CREDIT_PATH)).toBe(1);
        expect(calls(SHORT_SOURCES_PATH)).toBe(1);
    });

    it('失敗後按［重新查詢］：只重讀失敗的那一項、每按一次各 1 次；成功後顯示結果、按鍵消失', async () => {
        // 融資融券成功、券源失敗
        m.apiPost.mockImplementation(async (path: string, body: { contracts: { code: string }[] }) => {
            if (path === CREDIT_PATH) return [creditRow(body.contracts[0]!.code)];
            throw new Error('503');
        });
        await render(stock);
        expect(all('trade-chips-credit')).toHaveLength(1);
        expect(text(one('trade-chips-source'))).toContain('查詢失敗');
        expect(text(one('trade-chips-retry'))).toBe('重新查詢融資融券與券源');
        // 再失敗一次：仍只有使用者按才讀
        await act(async () => { one('trade-chips-retry').props.onClick(); });
        await settle();
        expect(calls(CREDIT_PATH)).toBe(1);
        expect(calls(SHORT_SOURCES_PATH)).toBe(2);
        expect(text(one('trade-chips-source'))).toContain('查詢失敗');
        okResponses();
        await act(async () => { one('trade-chips-retry').props.onClick(); });
        await settle();
        expect(calls(CREDIT_PATH)).toBe(1);
        expect(calls(SHORT_SOURCES_PATH)).toBe(3);
        expect(text(one('trade-chips-source'))).toBe('58,260');
        expect(all('trade-chips-retry')).toHaveLength(0);
        // 關閉再開、重新掛載：不再讀
        await rerender(stock, false);
        await rerender(stock, true);
        expect(calls(SHORT_SOURCES_PATH)).toBe(3);
    });

    it('換商品才讀新的一檔；過了台北午夜（新交易日）才重讀同一檔', async () => {
        okResponses();
        await render(stock);
        await unmount();
        await render({ ...stock, code: '2317', name: '鴻海' });
        expect(calls(CREDIT_PATH)).toBe(2);
        expect(calls(SHORT_SOURCES_PATH)).toBe(2);
        await unmount();
        await render(stock);
        expect(calls(CREDIT_PATH)).toBe(2);
        await unmount();
        vi.setSystemTime(new Date('2026-11-09T08:30:00+08:00'));
        await render(stock);
        expect(calls(CREDIT_PATH)).toBe(3);
        expect(calls(SHORT_SOURCES_PATH)).toBe(3);
    });

    it('期貨、選擇權、指數：開著也 0 次，且不顯示信用相關項目', async () => {
        okResponses();
        for (const c of [fut, opt, ind]) {
            await render(c);
            expect(all('trade-chips-credit')).toHaveLength(0);
            expect(all('trade-chips-credit-status')).toHaveLength(0);
            expect(all('trade-chips-source')).toHaveLength(0);
            expect(all('trade-chips-margin-balance')).toHaveLength(0);
            expect(all('trade-chips-punish')).toHaveLength(0);
            expect(all('trade-chips-daytrade')).toHaveLength(0);
            expect(all('trade-chips-rules')).toHaveLength(1);
            await unmount();
        }
        expect(m.apiPost).not.toHaveBeenCalled();
        expect(m.apiGet).not.toHaveBeenCalled();
    });
});

describe('內容', () => {
    it('股票：成數、可否、券源、資券餘額、處置、當沖資格與規則', async () => {
        okResponses();
        await render(stock, true, true);
        expect(text(one('trade-chips-margin'))).toBe('可融資');
        expect(text(one('trade-chips-short'))).toBe('可融券');
        expect(text(one('trade-chips-margin-ratio'))).toBe('60%');
        expect(text(one('trade-chips-short-ratio'))).toBe('90%');
        expect(text(one('trade-chips-source'))).toBe('58,260');
        expect(text(one('trade-chips-margin-balance'))).toBe('12,345');
        expect(text(one('trade-chips-short-balance'))).toBe('678');
        expect(text(one('trade-chips-punish'))).toContain('處置股');
        expect(text(one('trade-chips-daytrade'))).toBe('可現股當沖：可先買後賣，也可先賣後買');
        const rules = text(one('trade-chips-rules'));
        expect(rules).toContain('現股當沖先賣');
        expect(rules).toContain('0.15%'); // 一般股票減半
        expect(rules).toContain('2027-12-31');
    });

    it('停資、停券：顯示原因（成數或單位為 0）', async () => {
        okResponses({ margin_loan_ratio: 0, short_unit: 0 });
        await render(stock);
        expect(text(one('trade-chips-margin'))).toBe('停資（融資成數為 0）');
        expect(text(one('trade-chips-short'))).toBe('停券（融券單位為 0）');
        expect(creditAbilityText(undefined, 'MarginTrading').text).toBe('無法確認（由券商端判斷）');
        expect(creditAbilityText(creditRow('2330', { margin_loan_ratio: 0, margin_unit: 0 }), 'MarginTrading').text).toBe('停資（融資成數為 0、融資單位為 0）');
    });

    it('回覆沒有這一檔：顯示無資料，不拿別檔的值', async () => {
        m.apiPost.mockResolvedValue([creditRow('2317')]);
        await render(stock);
        expect(text(one('trade-chips-credit-status'))).toContain('無資料');
    });

    it('當沖狀態：僅先買後賣、不可當沖', async () => {
        okResponses();
        await render({ ...stock, day_trade: 'OnlyBuy' });
        expect(text(one('trade-chips-daytrade'))).toBe('僅可先買後賣：不能現股當沖先賣');
        await unmount();
        await render({ ...stock, day_trade: 'No' });
        expect(text(one('trade-chips-daytrade'))).toBe('不可現股當沖');
    });
});

describe('資料時間與焦點', () => {
    it('融資融券與券源顯示資料時間，並註明下單時券商會重新查詢', async () => {
        okResponses();
        await render(stock);
        expect(text(one('trade-chips-credit-time'))).toBe('資料時間 11/06 08:00；下單時券商會重新查詢，以下單當下為準。');
        expect(text(one('trade-chips-source-note'))).toContain('資料時間 11/06 08:00');
    });

    it('按［重新查詢］：按鍵消失前把焦點移到「融資融券」標題（不掉到面板外）', async () => {
        m.apiPost.mockRejectedValue(new Error('503'));
        const focus = vi.fn();
        await act(async () => {
            view = create(el(stock), { createNodeMock: n => ((n.props as Record<string, unknown>)['data-testid'] === 'trade-chips-credit-title' ? { focus } : {}) });
        });
        await settle();
        okResponses();
        await act(async () => { one('trade-chips-retry').props.onClick(); });
        expect(focus).toHaveBeenCalledTimes(1);
        expect(one('trade-chips-credit-title').props.tabIndex).toBe(-1);
    });
});

describe('S1：面板唯讀', () => {
    it('按遍面板內所有按鈕：openTicket／openOrderAction 與 lib 送單、改單、刪單 0 次', async () => {
        okResponses();
        await render(stock, true, true);
        const buttons = view!.root.findAll(n => n.type === 'button');
        expect(buttons.length).toBeGreaterThan(0);
        for (const b of buttons) {
            expect(text(b)).not.toMatch(/買進|賣出|下單|送出/);
            await act(async () => { b.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); });
        }
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });

    it('查詢失敗時（有［重新查詢］）按遍所有按鈕：同樣 0 次送單相關呼叫', async () => {
        m.apiPost.mockRejectedValue(new Error('503'));
        await render(stock, true, null);
        expect(all('trade-chips-retry')).toHaveLength(1);
        for (const b of view!.root.findAll(n => n.type === 'button')) {
            expect(text(b)).not.toMatch(/買進|賣出|下單|送出/);
            await act(async () => { b.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); });
        }
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });
});
