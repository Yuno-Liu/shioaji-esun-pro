// 通知中心面板（components/notice-center-sheet.tsx）：
// - 新的在上；時間（今天 HH:mm:ss、其他日期加月／日、跨年加年）；種類圖示＋文字（結果未知顯示「待核對」）；空狀態。
// - ［全部清除］兩段式：第一次不清、第二次才 clearNoticeLog；關閉面板或紀錄變動回到第一段。
// - 隱私：與 ToastHost 同一個遮蔽（useRevealTextCompat）——同一則通知在兩邊的輸出逐字一致；開關改變後重新遮蔽；
//   面板不寫入任何儲存。
// - S1：按遍面板內所有按鈕，openTicket／openOrderAction 與 lib 送單、改單、刪單 0 次。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotice, LoggedNotice } from '../../lib/trade';

const h = vi.hoisted(() => ({
    log: [] as LoggedNotice[],
    logListeners: new Set<() => void>(),
    noticeListener: null as ((n: AppNotice) => void) | null,
    accounts: [] as { account_id: string }[],
    clearNoticeLog: vi.fn(),
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

vi.mock('../../lib/trade', () => ({
    getNoticeLog: () => h.log,
    subscribeNoticeLog: (l: () => void) => {
        h.logListeners.add(l);
        return () => { h.logListeners.delete(l); };
    },
    clearNoticeLog: () => {
        h.clearNoticeLog();
        h.log = [];
        h.logListeners.forEach(l => l());
    },
    onNotice: (l: (n: AppNotice) => void) => {
        h.noticeListener = l;
        return () => { h.noticeListener = null; };
    },
    placeQuickOrder: h.send.placeQuickOrder,
    cancelAllOrders: h.send.cancelAllOrders,
}));
vi.mock('../../lib/account-store', () => ({ useAccounts: () => ({ accounts: h.accounts }) }));
vi.mock('../../lib/stream', () => ({ onOrderEvent: () => () => undefined }));
vi.mock('../../lib/order-report', () => ({ describeOrderReport: () => ({ kind: 'info', title: '', lines: [] }) }));
vi.mock('../lib/mobile-store', () => ({ openTicket: h.openTicket, openOrderAction: h.openOrderAction }));
vi.mock('../../lib/shioaji', () => ({
    placeStockOrder: h.send.placeStockOrder,
    placeFuturesOrder: h.send.placeFuturesOrder,
    placeComboOrder: h.send.placeComboOrder,
    cancelOrder: h.send.cancelOrder,
    cancelOrders: h.send.cancelOrders,
    cancelVerifiedOrder: h.send.cancelVerifiedOrder,
    updateOrderPrice: h.send.updateOrderPrice,
    updateOrderQty: h.send.updateOrderQty,
}));
vi.mock('../lib/mobile-order', () => ({ submitMobileOrder: h.send.submitMobileOrder }));

import { secretAccount, secretMoney, setPrivacyMode, setPrivacyMoney } from '../../lib/privacy';
import { resetSheetStackForTest } from '../lib/sheet-stack';
import { NOTICE_EMPTY_TEXT, NOTICE_KIND_TEXT, NoticeCenterSheet, noticeTimeText } from './notice-center-sheet';
import { ToastHost } from './toast-host';

let view: ReactTestRenderer | undefined;
const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(k => text(k as ReactTestInstance | string)).join(''));
const all = (id: string) => view!.root.findAll(n => n.props?.['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => all(id)[0]!;
const titles = () => all('notice-title').map(text);

/** 本地時間（與時區無關的測試） */
const at = (y: number, mo: number, d: number, hh: number, mm: number, ss: number) => new Date(y, mo - 1, d, hh, mm, ss).getTime();
const NOW = at(2026, 11, 8, 10, 0, 0);

function setLog(log: LoggedNotice[]) {
    h.log = log;
    h.logListeners.forEach(l => l());
}
async function render(open = true) {
    await act(async () => { view = create(createElement(NoticeCenterSheet, { open, onClose: () => undefined })); });
}
async function rerender(open: boolean) {
    await act(async () => { view!.update(createElement(NoticeCenterSheet, { open, onClose: () => undefined })); });
}
async function press(id: string) {
    await act(async () => { one(id).props.onClick({ preventDefault() {}, stopPropagation() {} }); });
}

let storageWrites: string[];
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    storageWrites = [];
    const storage = () => ({
        getItem: () => null,
        setItem: (k: string, v: string) => { storageWrites.push(`${k}=${v}`); },
        removeItem: () => undefined,
    });
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('sessionStorage', storage());
    h.log = [];
    h.logListeners.clear();
    h.accounts = [];
    h.clearNoticeLog.mockReset();
    h.openTicket.mockReset();
    h.openOrderAction.mockReset();
    Object.values(h.send).forEach(f => f.mockReset());
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    setPrivacyMode(false);
    setPrivacyMoney(false);
    resetSheetStackForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('noticeTimeText', () => {
    it('今天 HH:mm:ss；其他日期 MM/DD HH:mm:ss；不同年加年', () => {
        expect(noticeTimeText(at(2026, 11, 8, 9, 5, 3), NOW)).toBe('09:05:03');
        expect(noticeTimeText(at(2026, 11, 7, 23, 59, 59), NOW)).toBe('11/07 23:59:59');
        expect(noticeTimeText(at(2025, 12, 31, 8, 0, 0), NOW)).toBe('2025/12/31 08:00:00');
    });
});

describe('清單', () => {
    it('沒有通知：空狀態，沒有清除鍵', async () => {
        await render();
        expect(text(one('notice-empty'))).toBe(NOTICE_EMPTY_TEXT);
        expect(all('notice-clear')).toHaveLength(0);
        expect(all('notice-list')).toHaveLength(0);
    });

    it('新的在上；每則有時間、種類文字與圖示、標題、內文；結果未知為「待核對」', async () => {
        h.log = [
            { kind: 'ok', title: '委託已送出', body: '2330 買進 1 張', ts: at(2026, 11, 7, 13, 0, 0) },
            { kind: 'info', title: '等待 shioaji server…', body: '', ts: at(2026, 11, 8, 9, 0, 1) },
            { kind: 'err', title: '委託結果未知', body: '請到委託頁按「更新」核對', ts: at(2026, 11, 8, 9, 30, 0) },
            { kind: 'err', title: '刪單失敗', body: '已成交', ts: at(2026, 11, 8, 9, 45, 0) },
        ];
        await render();
        expect(titles()).toEqual(['刪單失敗', '委託結果未知', '等待 shioaji server…', '委託已送出']);
        const items = all('notice-item');
        expect(items.map(i => i.props['data-kind'])).toEqual(['err', 'warn', 'info', 'ok']);
        expect(items.map(i => text(i.findByType('time')))).toEqual(['09:45:00', '09:30:00', '09:00:01', '11/07 13:00:00']);
        expect(text(items[1]!)).toContain(NOTICE_KIND_TEXT.warn);
        expect(text(items[0]!)).toContain(NOTICE_KIND_TEXT.err);
        expect(text(items[3]!)).toContain(NOTICE_KIND_TEXT.ok);
        // 沒有內文的那則不渲染空的內文段
        expect(all('notice-body').map(text)).toEqual(['已成交', '請到委託頁按「更新」核對', '2330 買進 1 張']);
        // 圖示只是裝飾（種類有文字）
        for (const i of items) expect(i.findByType('svg').props['aria-hidden']).toBe('true');
    });

    it('面板開著時進來的通知即時出現在最上面', async () => {
        h.log = [{ kind: 'ok', title: '舊', body: '', ts: NOW - 1000 }];
        await render();
        await act(async () => { setLog([...h.log, { kind: 'info', title: '新', body: '', ts: NOW }]); });
        expect(titles()).toEqual(['新', '舊']);
    });
});

describe('全部清除（兩段式）', () => {
    beforeEach(() => {
        h.log = [
            { kind: 'ok', title: 'A', body: '', ts: NOW - 2000 },
            { kind: 'info', title: 'B', body: '', ts: NOW - 1000 },
        ];
    });

    it('第一次只變成確認、第二次才清除；清除後顯示空狀態', async () => {
        await render();
        expect(text(one('notice-clear'))).toBe('全部清除');
        await press('notice-clear');
        expect(h.clearNoticeLog).not.toHaveBeenCalled();
        expect(text(one('notice-clear'))).toBe('確定清除 2 則通知');
        expect(one('notice-clear').props['data-confirming']).toBe('true');
        expect(text(one('notice-clear-hint'))).toContain('無法復原');
        await press('notice-clear');
        expect(h.clearNoticeLog).toHaveBeenCalledTimes(1);
        expect(text(one('notice-empty'))).toBe(NOTICE_EMPTY_TEXT);
    });

    it('關閉面板後回到第一段', async () => {
        await render();
        await press('notice-clear');
        await rerender(false);
        await rerender(true);
        expect(text(one('notice-clear'))).toBe('全部清除');
        await press('notice-clear');
        expect(h.clearNoticeLog).not.toHaveBeenCalled();
    });

    it('確認中有新通知：回到第一段（不會清掉沒看過的那則）', async () => {
        await render();
        await press('notice-clear');
        await act(async () => { setLog([...h.log, { kind: 'err', title: 'C', body: '', ts: NOW }]); });
        expect(text(one('notice-clear'))).toBe('全部清除');
        await press('notice-clear');
        expect(h.clearNoticeLog).not.toHaveBeenCalled();
    });
});

describe('隱私（與 ToastHost 相同的遮蔽，不寫入儲存）', () => {
    const ACCOUNT_ID = '9816502';
    const notice: AppNotice = {
        kind: 'err',
        title: `委託失敗 ${secretAccount(ACCOUNT_ID)}`,
        body: `帳號 ${ACCOUNT_ID} 金額 ${secretMoney('1,234,567')}`,
    };

    it('隱私模式＋遮金額：標題、內文遮成與 toast 逐字相同；不含原始帳號與金額', async () => {
        h.accounts = [{ account_id: ACCOUNT_ID }];
        setPrivacyMode(true);
        setPrivacyMoney(true);
        h.log = [{ ...notice, ts: NOW }];
        await act(async () => { view = create(createElement('div', null, createElement(ToastHost), createElement(NoticeCenterSheet, { open: true, onClose: () => undefined }))); });
        await act(async () => { h.noticeListener!(notice); });
        const toast = view!.root.find(n => n.props?.['data-testid'] === 'toast-item' && typeof n.type === 'string');
        const toastSpans = toast.findAll(n => n.type === 'span').map(text);
        const sheetTitle = text(one('notice-title'));
        const sheetBody = text(one('notice-body'));
        expect(toastSpans).toContain(sheetTitle);
        expect(toastSpans).toContain(sheetBody);
        expect(sheetTitle + sheetBody).not.toContain(ACCOUNT_ID);
        expect(sheetBody).not.toContain('1,234,567');
        expect(storageWrites.filter(w => w.includes('委託失敗') || w.includes(ACCOUNT_ID))).toEqual([]);
    });

    it('渲染時才遮：面板開著時打開隱私模式，立即重新遮蔽', async () => {
        h.accounts = [{ account_id: ACCOUNT_ID }];
        h.log = [{ ...notice, ts: NOW }];
        await render();
        expect(text(one('notice-body'))).toContain(ACCOUNT_ID);
        await act(async () => { setPrivacyMode(true); });
        expect(text(one('notice-body'))).not.toContain(ACCOUNT_ID);
        expect(text(one('notice-title'))).not.toContain(ACCOUNT_ID);
    });
});

describe('S1：面板唯讀', () => {
    it('按遍面板內所有按鈕（含清除兩段、關閉）：openTicket／openOrderAction 與 lib 送單、改單、刪單 0 次', async () => {
        h.log = [
            { kind: 'ok', title: '委託已送出', body: '', ts: NOW - 1000 },
            { kind: 'err', title: '委託結果未知', body: '', ts: NOW },
        ];
        await render();
        for (let round = 0; round < 2; round++) {
            const buttons = view!.root.findAll(n => n.type === 'button');
            expect(buttons.length).toBeGreaterThan(0);
            for (const b of buttons) {
                expect(text(b)).not.toMatch(/買進|賣出|下單|送出|刪單|改價|改量/);
                await act(async () => { b.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); });
            }
        }
        expect(h.openTicket).not.toHaveBeenCalled();
        expect(h.openOrderAction).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(h.send)) expect(fn, name).not.toHaveBeenCalled();
    });
});
