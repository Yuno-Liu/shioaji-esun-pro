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
    // 批次出清授權（lib/batch-exit-auth）比對帳戶標籤用；格式同 lib（分公司-***末四碼）
    accountConfirmLabel: (a: { broker_id: string; account_id: string }) => `${a.broker_id}-***${a.account_id.slice(-4)}`,
}));
vi.mock('../../lib/privacy', () => ({ usePrivacyMode: () => q.priv }));
vi.mock('../../lib/trade', () => ({ notify: m.notify }));

import { abortBatchExit, armBatchExit, BATCH_STOPPED, batchExitAbortReason, setBatchExit, type ExpectedConfirm } from '../lib/batch-exit-auth';
import { getResumeGate, setResumeGateForTest } from '../lib/resume-gate-runtime';
import { CONFIRM_TEXT, confirmActionText, OrderConfirmSheet } from './order-confirm-sheet';
import type { ReactElement } from 'react';
import { setMotionClockForTest } from '../motion/spring';
import { SlideToConfirm } from './slide-to-confirm';

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
    setBatchExit(false);
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

describe('OrderConfirmSheet — S6 環境橫幅（confirm-env）', () => {
    const envNode = () => one('confirm-env');
    const hasIcon = () => envNode().findAll(n => n.type === 'svg').length > 0;

    it('正式：danger 實心＋ShieldAlert；模擬：accent 無圖示；未確認：amber；文字仍為 confirmEnvText()', async () => {
        await render();
        await emit({ ...base, simulation: false });
        expect(text(envNode())).toBe('正式環境');
        expect(envNode().props['data-env']).toBe('production');
        expect(hasIcon()).toBe(true);
        await emit(null);
        await emit(base);
        expect(text(envNode())).toBe('模擬環境');
        expect(envNode().props['data-env']).toBe('simulation');
        expect(hasIcon()).toBe(false);
        await emit(null);
        await emit({ ...base, simulation: null });
        expect(text(envNode())).toBe('環境未確認');
        expect(envNode().props['data-env']).toBe('unknown');
        expect(slideDisabled()).toBe(true);
    });

    it('同一筆的環境改變（模式更新換掉 request）時橫幅跟著更新', async () => {
        await render();
        await emit({ ...base, simulation: null, awaitingMode: true });
        expect(envNode().props['data-env']).toBe('unknown');
        await emit({ ...base, simulation: false });
        expect(text(envNode())).toBe('正式環境');
        expect(envNode().props['data-env']).toBe('production');
        expect(slideDisabled()).toBe(false);
    });

    it('S6：環境橫幅在不捲動的 pinned 固定區（不在可捲動的 body 內）、早於動作列；滑塊與取消在 footer', async () => {
        await render();
        await emit(base);
        const isHost = (n: ReactTestInstance) => typeof n.type === 'string';
        const body = view!.root.find(n => n.props['data-sheet-body'] !== undefined && isHost(n));
        // 視窗很矮時 body 會捲動：環境橫幅不能在 body 內（滑塊在固定 footer 仍可操作，環境必須一直看得到）
        expect(body.findAll(n => n.props['data-testid'] === 'confirm-env')).toHaveLength(0);
        expect(body.findAll(n => n.props['data-testid'] === 'confirm-action' && isHost(n))).toHaveLength(1);
        const pinned = view!.root.find(n => n.props['data-sheet-pinned'] !== undefined && isHost(n));
        expect(pinned.findAll(n => n.props['data-testid'] === 'confirm-env' && isHost(n))).toHaveLength(1);
        // pinned 是 panel 的直接子元素、文件順序在 body 之前（畫面上在動作列之上）
        expect(pinned.parent!.props.role).toBe('dialog');
        const order = pinned.parent!.findAll(n => isHost(n) && (n.props['data-sheet-pinned'] !== undefined || n.props['data-sheet-body'] !== undefined));
        expect(order).toEqual([pinned, body]);
        const footer = view!.root.find(n => n.props['data-sheet-footer'] !== undefined && typeof n.type === 'string');
        expect(footer.findAll(n => n.props['data-testid'] === 'confirm-slide-handle')).toHaveLength(1);
        expect(footer.findAll(n => n.type === 'button' && text(n) === '取消')).toHaveLength(1);
    });
});

describe('OrderConfirmSheet — S4 退場凍結（createNodeMock＋假時鐘）', () => {
    let now = 0;
    let frames = new Map<number, (t: number) => void>();
    let nextFrameId = 1;
    const createNodeMock = (_el: ReactElement) => ({
        style: {},
        isConnected: true,
        getBoundingClientRect: () => ({ height: 420, width: 390 }),
        focus: vi.fn(),
        contains: () => false,
    });
    const step = async (ms = 16) => {
        await act(async () => {
            now += ms;
            const fs = Array.from(frames.values());
            frames = new Map();
            fs.forEach(f => f(now));
        });
    };
    const settle = async (ms = 1500) => { for (let t = 0; t < ms; t += 16) await step(); };
    const renderAnimated = async () => {
        await act(async () => { view = create(createElement(OrderConfirmSheet), { createNodeMock }); });
    };
    const slide = () => view!.root.find(n => n.type === SlideToConfirm);
    const panel = (id: string) => byTestId(id).find(n => n.props.role === 'dialog');
    const track = () => view!.root.find(n => typeof n.type === 'string' && n.props['data-armed'] !== undefined);
    const ptr = (clientX: number) => ({ pointerId: 1, clientX, currentTarget: { setPointerCapture: vi.fn() } });

    beforeEach(() => {
        now = 1000;
        frames = new Map();
        nextFrameId = 1;
        setMotionClockForTest({
            now: () => now,
            frame: cb => { const id = nextFrameId++; frames.set(id, cb); return id; },
            cancel: id => { frames.delete(id); },
        });
    });
    afterEach(async () => {
        await act(async () => view?.unmount());
        view = undefined;
        setMotionClockForTest(null);
    });

    it('核准後立即退場：testId 改 -closing、inert＋aria-hidden、滑塊 disabled、再觸發 onConfirm 不會第二次 resolve(true)', async () => {
        await renderAnimated();
        await emit(base);
        await settle();
        expect(panel('order-confirm-sheet')!.props['data-phase']).toBe('open');
        const firstConfirm = slide().props.onConfirm as () => void;

        await slideToEnd();
        expect(q.resolve.mock.calls).toEqual([[true]]);
        // lib 已清空 pending：立即沿原路退場，不等待 lib
        expect(sheetOpen()).toBe(false);
        const closing = panel('order-confirm-sheet-closing')!;
        expect(closing.props.inert).toBe(true);
        expect(closing.props['aria-hidden']).toBe('true');
        expect(closing.props['data-phase']).toBe('exiting');
        // 退場中仍顯示最後一筆（lastEntryRef）
        expect(text(one('confirm-action'))).toBe('買進台積電2330');
        expect(text(one('confirm-env'))).toBe('模擬環境');
        // open 為假 → 滑塊 disabled（即使 BottomSheet 凍結了 children／footer）
        expect(slide().props.disabled).toBe(true);
        expect(slideDisabled()).toBe(true);

        // 第二次觸發：舊的 onConfirm、目前的 onConfirm、鍵盤、取消鈕都不會再 resolve
        await act(async () => { firstConfirm(); });
        await act(async () => { (slide().props.onConfirm as () => void)(); });
        await slideToEnd();
        const cancelBtn = view!.root.findAll(n => n.type === 'button' && text(n) === '取消')[0]!;
        await act(async () => { cancelBtn.props.onClick(); });
        expect(q.resolve.mock.calls).toEqual([[true]]);

        await step(64);
        expect(panel('order-confirm-sheet-closing')).toBeDefined();
        await settle();
        expect(view!.toJSON()).toBeNull();
        expect(q.resolve.mock.calls).toEqual([[true]]);
    });

    it('取消後同樣退場；退場中點暗化幕、取消鈕不會重複 resolve', async () => {
        await renderAnimated();
        await emit(base);
        await settle();
        const cancelBtn = () => view!.root.findAll(n => n.type === 'button' && text(n) === '取消')[0]!;
        await act(async () => { cancelBtn().props.onClick(); });
        expect(q.resolve.mock.calls).toEqual([[false]]);
        expect(panel('order-confirm-sheet-closing')).toBeDefined();
        await act(async () => { cancelBtn().props.onClick(); });
        await act(async () => { one('order-confirm-sheet-closing-backdrop').props.onClick({ target: 1, currentTarget: 1 }); });
        expect(q.resolve.mock.calls).toEqual([[false]]);
        await settle();
        expect(view!.toJSON()).toBeNull();
    });

    it('退場中新請求到達：新 entry id、滑塊重置、armDelay 重新計時；舊畫面的 onConfirm 不會核准新的一筆', async () => {
        await renderAnimated();
        await emit(base);
        await settle();
        await slideToEnd();
        expect(q.resolve.mock.calls).toEqual([[true]]);
        await step(48);
        const oldKey = slide().props.resetKey;
        const oldConfirm = slide().props.onConfirm as () => void;
        expect(panel('order-confirm-sheet-closing')).toBeDefined();

        await emit({ ...base, code: '2317', name: '鴻海' });
        const reopened = panel('order-confirm-sheet')!;
        expect(reopened).toBeDefined();
        expect(reopened.props['data-phase']).toBe('entering');
        expect(reopened.props.inert).toBeUndefined();
        expect(text(one('confirm-action'))).toBe('買進鴻海2317');
        // 新 entry：resetKey 不同、滑塊歸零並重新啟用
        expect(slide().props.resetKey).not.toBe(oldKey);
        expect(slide().props.disabled).toBe(false);
        expect(handle().props['aria-valuenow']).toBe(0);
        expect(slideDisabled()).toBe(false);
        expect(text(one('confirm-slide'))).not.toContain('已確認');
        // armDelay 重新計時：進場中且未滿 300ms → 按下無效
        expect(track().props['data-armed']).toBe('false');
        await act(async () => { handle().props.onPointerDown(ptr(0)); });
        expect(handle().props['data-dragging']).toBe('false');

        // 舊畫面的 approve（舊 entry id）不會核准新的一筆
        await act(async () => { oldConfirm(); });
        expect(q.resolve.mock.calls).toEqual([[true]]);

        await settle();
        expect(panel('order-confirm-sheet')!.props['data-phase']).toBe('open');
        expect(track().props['data-armed']).toBe('true');
        await slideToEnd();
        expect(q.resolve.mock.calls).toEqual([[true], [true]]);
        await settle();
        expect(view!.toJSON()).toBeNull();
    });

    it('退場結束後清空快取：下一筆從頭進場（entering），內容為新的一筆', async () => {
        await renderAnimated();
        await emit(base);
        await settle();
        await emit(null);
        expect(panel('order-confirm-sheet-closing')).toBeDefined();
        await settle();
        expect(view!.toJSON()).toBeNull();
        await emit({ ...base, action: 'Sell', simulation: false });
        expect(panel('order-confirm-sheet')!.props['data-phase']).toBe('entering');
        expect(panel('order-confirm-sheet')!.props['data-tone']).toBe('sell');
        expect(text(one('confirm-env'))).toBe('正式環境');
        expect(slideDisabled()).toBe(false);
    });
});

describe('OrderConfirmSheet — 持倉多選市價出清（lib/batch-exit-auth，§10 S10）', () => {
    const acc = { account_type: 'S', broker_id: '9A95', account_id: '1233456', person_id: 'A', signed: true, username: '' };
    const expected: ExpectedConfirm = { code: '2330', action: 'Sell', quantity: 3500, unit: '股', credit: undefined, account: acc, simulation: true };
    // 與 lib placeStockExitByShares 的確認請求相同（市價、股、帳戶標籤 9A95-***3456）
    const exitReq: OrderConfirmRequest = { ...base, action: 'Sell', price: null, quantity: 3500, unit: '股', note: '拆為 3 張市價＋500 股盤中零股限價' };
    const start = async (arm = true) => {
        await act(async () => {
            setBatchExit(true);
            if (arm) armBatchExit(expected);
        });
    };

    it('沒有批次：一般單照常顯示面板、不自動核准', async () => {
        await render();
        await emit(exitReq);
        expect(sheetOpen()).toBe(true);
        expect(q.resolve).not.toHaveBeenCalled();
    });

    it('批次中相符：不渲染面板（也不閃現），自動 resolve(true) 一次', async () => {
        await render();
        await start();
        await emit(exitReq);
        expect(q.resolve.mock.calls).toEqual([[true]]);
        expect(byTestId('order-confirm-sheet')).toHaveLength(0);
        expect(byTestId('order-confirm-sheet-closing')).toHaveLength(0);
        expect(byTestId('confirm-slide-handle')).toHaveLength(0);
        expect(view!.toJSON()).toBeNull();
    });

    it('批次中不符（數量）：不渲染，resolve(false) 並中止批次', async () => {
        await render();
        await start();
        await emit({ ...exitReq, quantity: 3000 });
        expect(q.resolve.mock.calls).toEqual([[false]]);
        expect(view!.toJSON()).toBeNull();
        expect(batchExitAbortReason()).toBe('quantity');
    });

    it('批次中沒有 arm 的請求（其他流程）：resolve(false)', async () => {
        await render();
        await start(false);
        await emit(exitReq);
        expect(q.resolve.mock.calls).toEqual([[false]]);
        expect(view!.toJSON()).toBeNull();
    });

    it('批次中 awaitingMode：等待、不渲染；模式取得（同一筆換新 request）後相符 → resolve(true)', async () => {
        await render();
        await start();
        await emit({ ...exitReq, simulation: null, awaitingMode: true });
        expect(q.resolve).not.toHaveBeenCalled();
        expect(view!.toJSON()).toBeNull();
        await emit(exitReq);
        expect(q.resolve.mock.calls).toEqual([[true]]);
    });

    it('批次中 awaitingMode 超過 10 秒：resolve(false)', async () => {
        vi.useFakeTimers();
        try {
            await render();
            await start();
            await emit({ ...exitReq, simulation: null, awaitingMode: true });
            await act(async () => { vi.advanceTimersByTime(10_000); });
            expect(q.resolve.mock.calls).toEqual([[false]]);
            expect(batchExitAbortReason()).toBe('timeout');
        } finally {
            vi.useRealTimers();
        }
    });

    it('批次中 awaitingMode 時使用者停止或離開持倉頁（abortBatchExit）：立即 resolve(false)，模式取得後也不核准', async () => {
        await render();
        await start();
        await emit({ ...exitReq, simulation: null, awaitingMode: true });
        expect(q.resolve).not.toHaveBeenCalled();
        await act(async () => { abortBatchExit(BATCH_STOPPED); });
        expect(q.resolve.mock.calls).toEqual([[false]]);
        expect(batchExitAbortReason()).toBe(BATCH_STOPPED);
        expect(view!.toJSON()).toBeNull();
    });

    it('批次中 ResumeGate 不允許：不核准，由既有 ResumeGate 檢查取消', async () => {
        await gate({ state: 'resyncing', resumeSeq: getResumeGate().resumeSeq + 1 });
        await render();
        await start();
        await emit(exitReq);
        expect(q.resolve).toHaveBeenCalledWith(false);
        expect(q.resolve).not.toHaveBeenCalledWith(true);
    });

    it('批次開始前正在退場的一般面板：批次中不再顯示；批次結束後的一般單照常顯示並需滑動', async () => {
        await render();
        await emit(base);
        await emit(null);
        await start();
        expect(view!.toJSON()).toBeNull();
        await act(async () => { setBatchExit(false); });
        await emit(base);
        expect(sheetOpen()).toBe(true);
        expect(q.resolve).not.toHaveBeenCalled();
        await slideToEnd();
        expect(q.resolve.mock.calls).toEqual([[true]]);
    });
});
