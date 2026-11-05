// 手機確認面板（規格 §6.4、§14.1）：停用條件與桌面相同（awaitingMode、simulation === null、serverChanged、
// livePriceCode 無即時價）、顯示環境與路由、ResumeGate 離開 ready（含 resumeSeq 改變）自動取消、
// 滑動完成只 resolve(true) 一次、取消 resolve(false)、卸載時不讓 promise 懸置。
// lib/order-confirm 以假佇列取代（同一個 subscribe／getPending／resolve 介面），不打任何真實 API。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderConfirmRequest } from '../../lib/order-confirm';

const q = vi.hoisted(() => ({
    pending: null as unknown,
    listeners: new Set<() => void>(),
    resolve: vi.fn(),
    priv: false,
}));
const m = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock('../../lib/order-confirm', () => ({
    subscribeOrderConfirm: (l: () => void) => {
        q.listeners.add(l);
        return () => { q.listeners.delete(l); };
    },
    getPendingOrderConfirm: () => q.pending,
    // 與 lib 相同：沒有待確認就直接 return（重複呼叫無害）；有就先清空再通知
    resolveOrderConfirm: (approved: boolean) => {
        q.resolve(approved);
        if (!q.pending) return;
        q.pending = null;
        q.listeners.forEach(l => l());
    },
    privacyAccountLabel: (label: string, priv: boolean) => (priv ? label.replace(/\*+\d{2}(\d{2})$/, '•••••$1') : label),
}));
vi.mock('../../lib/privacy', () => ({ usePrivacyMode: () => q.priv }));
vi.mock('../../lib/trade', () => ({ notify: m.notify }));

import { getResumeGate, setResumeGateForTest } from '../lib/resume-gate-runtime';
import { CONFIRM_TEXT, confirmActionText, OrderConfirmSheet } from './order-confirm-sheet';

const base: OrderConfirmRequest = {
    code: '2330',
    name: '台積電',
    action: 'Buy',
    price: 1085,
    quantity: 2,
    unit: '張',
    note: 'ROD・送往 永豐 模擬環境',
    accountLabel: '9A95-***3456',
    simulation: true,
    awaitingMode: false,
};

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
const byTestId = (id: string) => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => {
    const found = byTestId(id)[0];
    if (!found) throw new Error(`${id} not found`);
    return found;
};
const sheetOpen = () => byTestId('order-confirm-sheet').length > 0;
const handle = () => one('confirm-slide-handle');
const slideDisabled = () => handle().props['aria-disabled'] === true;

async function emit(next: OrderConfirmRequest | null) {
    await act(async () => {
        q.pending = next;
        q.listeners.forEach(l => l());
    });
}
async function render() {
    await act(async () => { view = create(createElement(OrderConfirmSheet)); });
}
async function slideToEnd() {
    await act(async () => { handle().props.onKeyDown({ key: 'End', preventDefault: vi.fn() }); });
    await act(async () => { handle().props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() }); });
}
async function gate(next: Parameters<typeof setResumeGateForTest>[0]) {
    await act(async () => { setResumeGateForTest(next); });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    q.pending = null;
    q.listeners.clear();
    q.resolve.mockReset();
    q.priv = false;
    m.notify.mockReset();
    setResumeGateForTest(null);
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
});

describe('OrderConfirmSheet — 內容', () => {
    it('沒有待確認時不顯示', async () => {
        await render();
        expect(sheetOpen()).toBe(false);
    });

    it('顯示環境大字、動作、商品、價格、數量＋單位、帳戶與 note（含路由）', async () => {
        await render();
        await emit(base);
        expect(sheetOpen()).toBe(true);
        expect(text(one('confirm-env'))).toBe('模擬環境');
        expect(text(one('confirm-action'))).toBe('買進台積電2330');
        expect(text(one('confirm-price'))).toBe('1,085');
        expect(text(one('confirm-qty'))).toBe('2 張');
        expect(text(one('confirm-account'))).toBe('9A95-***3456');
        expect(text(one('confirm-note'))).toContain('送往 永豐 模擬環境');
        expect(byTestId('confirm-live-price')).toHaveLength(0);
        expect(slideDisabled()).toBe(false);
        expect(handle().props['aria-label']).toBe('滑動確認 買進 2330');
    });

    it('正式環境、信用動作（融券賣出）、市價', async () => {
        await render();
        await emit({ ...base, action: 'Sell', credit: '融券', price: null, simulation: false, note: 'ROD・融券・送往 玉山 正式環境' });
        expect(text(one('confirm-env'))).toBe('正式環境');
        expect(text(one('confirm-action'))).toContain('融券賣出');
        expect(text(one('confirm-price'))).toBe('市價');
        expect(text(one('confirm-note'))).toContain('送往 玉山 正式環境');
    });

    it('有 priceLabel 時用 priceLabel；隱私模式重遮帳號', async () => {
        q.priv = true;
        await render();
        await emit({ ...base, priceLabel: '1,080～1,085' });
        expect(text(one('confirm-price'))).toBe('1,080～1,085');
        expect(text(one('confirm-account'))).toBe('9A95-•••••56');
    });
});

describe('OrderConfirmSheet — 滑動停用條件（同桌面 order-confirm-dialog.tsx:113）', () => {
    it('awaitingMode：停用並顯示「確認伺服器模式中…」', async () => {
        await render();
        await emit({ ...base, simulation: null, awaitingMode: true });
        expect(slideDisabled()).toBe(true);
        expect(text(one('confirm-slide'))).toContain(CONFIRM_TEXT.awaitingMode);
        await slideToEnd();
        expect(q.resolve).not.toHaveBeenCalled();
    });

    it('awaitingMode＋modeUnavailable：顯示無法確認模式', async () => {
        await render();
        await emit({ ...base, simulation: null, awaitingMode: true, modeUnavailable: true });
        expect(slideDisabled()).toBe(true);
        expect(text(one('confirm-slide'))).toContain(CONFIRM_TEXT.modeUnavailable);
    });

    it('simulation === null：停用，環境顯示未確認', async () => {
        await render();
        await emit({ ...base, simulation: null, awaitingMode: false });
        expect(slideDisabled()).toBe(true);
        expect(text(one('confirm-env'))).toBe('環境未確認');
    });

    it('serverChanged：停用並顯示「伺服器或模式已變更，這筆不會送出，請取消後重新下單」', async () => {
        await render();
        await emit(base);
        expect(slideDisabled()).toBe(false);
        await emit({ ...base, serverChanged: true });
        expect(slideDisabled()).toBe(true);
        expect(text(one('confirm-slide'))).toContain('伺服器或模式已變更，這筆不會送出，請取消後重新下單');
        await slideToEnd();
        expect(q.resolve).not.toHaveBeenCalled();
    });

    it('有 livePriceCode 但沒有即時價：顯示「行情中斷」並停用', async () => {
        await render();
        await emit({ ...base, livePriceCode: '2330' });
        expect(text(one('confirm-live-price'))).toBe('行情中斷');
        expect(slideDisabled()).toBe(true);
    });
});

describe('OrderConfirmSheet — 送出與取消', () => {
    it('滑動完成只 resolve(true) 一次', async () => {
        await render();
        await emit(base);
        await slideToEnd();
        expect(q.resolve).toHaveBeenCalledTimes(1);
        expect(q.resolve).toHaveBeenCalledWith(true);
        expect(sheetOpen()).toBe(false);
    });

    it('下一筆委託有新的滑動狀態（resetKey 依每筆 request 區分）', async () => {
        await render();
        await emit(base);
        await slideToEnd();
        await emit({ ...base, code: '2317', name: '鴻海' });
        expect(slideDisabled()).toBe(false);
        await slideToEnd();
        expect(q.resolve.mock.calls).toEqual([[true], [true]]);
    });

    it('「取消」鍵 resolve(false)', async () => {
        await render();
        await emit(base);
        const cancel = view!.root.findAll(n => n.type === 'button' && text(n) === '取消')[0]!;
        await act(async () => { cancel.props.onClick(); });
        expect(q.resolve).toHaveBeenCalledWith(false);
        expect(q.resolve).not.toHaveBeenCalledWith(true);
        expect(sheetOpen()).toBe(false);
    });

    it('點背景 resolve(false)', async () => {
        await render();
        await emit(base);
        const backdrop = one('order-confirm-sheet-backdrop');
        await act(async () => { backdrop.props.onClick({ target: 1, currentTarget: 1 }); });
        expect(q.resolve).toHaveBeenCalledWith(false);
    });

    it('卸載時仍有待確認：resolve(false)，不讓 promise 懸置', async () => {
        await render();
        await emit(base);
        await act(async () => view!.unmount());
        view = undefined;
        expect(q.resolve).toHaveBeenCalledWith(false);
    });
});

describe('OrderConfirmSheet — ResumeGate', () => {
    it('離開 ready（resyncing）時自動 resolve(false) 並提示；T2 再呼叫一次 resolve(false) 無害', async () => {
        await render();
        await emit(base);
        await gate({ state: 'resyncing', resumeSeq: getResumeGate().resumeSeq + 1 });
        expect(q.resolve).toHaveBeenCalledWith(false);
        expect(sheetOpen()).toBe(false);
        expect(m.notify).toHaveBeenCalledTimes(1);
        expect(m.notify.mock.calls[0]![0]).toMatchObject({ title: CONFIRM_TEXT.resyncCancelled });
        expect(CONFIRM_TEXT.resyncCancelled).toBe('畫面已重新同步，這筆確認已取消、沒有送出');
        // T2 進入 resyncing 時也會呼叫 resolveOrderConfirm(false)：沒有待確認時 lib 直接 return
        await act(async () => {
            const { resolveOrderConfirm } = await import('../../lib/order-confirm');
            resolveOrderConfirm(false);
        });
        expect(m.notify).toHaveBeenCalledTimes(1);
    });

    it('resumeSeq 改變（即使狀態已回到 ready）也自動取消', async () => {
        await render();
        await emit(base);
        await gate({ state: 'ready', resumeSeq: getResumeGate().resumeSeq + 1 });
        expect(q.resolve).toHaveBeenCalledWith(false);
        expect(sheetOpen()).toBe(false);
    });

    it('stale-data 且未勾選了解：自動取消；已勾選則保留', async () => {
        await render();
        await emit(base);
        await gate({ state: 'stale-data', staleAcknowledged: true });
        expect(q.resolve).not.toHaveBeenCalled();
        expect(sheetOpen()).toBe(true);
        await gate({ state: 'stale-data', staleAcknowledged: false });
        expect(q.resolve).toHaveBeenCalledWith(false);
    });

    it('出現時 ResumeGate 已不允許：立即取消，不能滑動送出', async () => {
        await gate({ state: 'failed', message: 'x' });
        await render();
        await emit(base);
        expect(q.resolve).toHaveBeenCalledWith(false);
        expect(q.resolve).not.toHaveBeenCalledWith(true);
        expect(sheetOpen()).toBe(false);
    });
});

describe('OrderConfirmSheet — 依方向著色與動作大字', () => {
    const panelTone = () => one('order-confirm-sheet').props['data-tone'];

    it('買進：整個面板 tone＝buy；賣出：tone＝sell', async () => {
        await render();
        await emit(base);
        expect(panelTone()).toBe('buy');
        await emit(null);
        await emit({ ...base, action: 'Sell' });
        expect(panelTone()).toBe('sell');
        expect(text(one('confirm-action'))).toBe('賣出台積電2330');
    });

    it('動作含信用名稱：融資買進、融券賣出、融券買進（回補）、現股當沖賣出', async () => {
        await render();
        await emit({ ...base, credit: '融資', note: 'ROD・融資・送往 永豐 模擬環境' });
        expect(text(one('confirm-action'))).toBe('融資買進台積電2330');
        expect(handle().props['aria-label']).toBe('滑動確認 融資買進 2330');
        await emit(null);
        await emit({ ...base, action: 'Sell', note: 'ROD・現股當沖・送往 永豐 模擬環境' });
        expect(text(one('confirm-action'))).toBe('現股當沖賣出台積電2330');
        expect(panelTone()).toBe('sell');
    });

    it('confirmActionText 純函式', () => {
        expect(confirmActionText({ action: 'Buy' })).toBe('買進');
        expect(confirmActionText({ action: 'Sell', credit: '融券' })).toBe('融券賣出');
        expect(confirmActionText({ action: 'Buy', credit: '融券' })).toBe('融券買進（回補）');
        expect(confirmActionText({ action: 'Sell', credit: '融資' })).toBe('融資賣出');
        expect(confirmActionText({ action: 'Sell', note: 'ROD・現股當沖・送往 永豐 模擬環境' })).toBe('現股當沖賣出');
        // 只認完整的「現股當沖」段；買進不會是當沖先賣
        expect(confirmActionText({ action: 'Buy', note: 'ROD・現股當沖' })).toBe('買進');
        expect(confirmActionText({ action: 'Sell', note: 'ROD・非現股當沖說明' })).toBe('賣出');
    });
});
