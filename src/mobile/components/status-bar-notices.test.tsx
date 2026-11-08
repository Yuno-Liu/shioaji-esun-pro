// 狀態列通知鈴（status-bar.tsx）：
// - 無障礙名稱「通知，N 則未讀」（沒有未讀為「通知」）；徽章只是視覺（aria-hidden），超過 99 顯示「99+」。
// - 未讀＝ts 晚於上次開啟／關閉通知中心；開啟即全部已讀；開著時進來的通知關閉後也算已讀；關閉後新的才算未讀。
// - 延遲載入：第一次按鈴才 import 面板（之後不再 import）；載入失敗顯示 SheetLoadError（可關閉、［重試］才重新 import）。
// - 不寫入任何儲存；S1：按遍鈴、載入失敗的按鈕，openTicket／openOrderAction 與 lib 送單、改單、刪單 0 次。
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggedNotice } from '../../lib/trade';

const m = vi.hoisted(() => ({
    log: [] as LoggedNotice[],
    listeners: new Set<() => void>(),
    loads: 0,
    fail: false,
    sheetProps: [] as { open: boolean }[],
    openTicket: vi.fn(),
    openOrderAction: vi.fn(),
    send: {
        placeStockOrder: vi.fn(),
        placeFuturesOrder: vi.fn(),
        cancelOrder: vi.fn(),
        cancelOrders: vi.fn(),
        updateOrderPrice: vi.fn(),
        updateOrderQty: vi.fn(),
        submitMobileOrder: vi.fn(),
        placeQuickOrder: vi.fn(),
        cancelAllOrders: vi.fn(),
    },
}));

vi.mock('../../lib/account-store', () => ({ useAccounts: () => ({ loaded: true, selectedStock: null, selectedFutures: null }) }));
vi.mock('../../lib/contracts-cache', () => ({ useContract: () => undefined }));
vi.mock('../../lib/esun/stream', () => ({ getEsunStreamStatus: () => 'idle' }));
vi.mock('../../lib/order-route', () => ({ routeEnvText: () => '模擬' }));
vi.mock('../../lib/risk', () => ({ setRiskSettings: vi.fn(), useRiskSettings: () => ({ locked: false }) }));
vi.mock('../../lib/stream', () => ({ getLastHeartbeat: () => 0, streamConnectionEpoch: () => 1 }));
vi.mock('../../lib/trade', () => ({
    isFuturesContract: () => false,
    getNoticeLog: () => m.log,
    subscribeNoticeLog: (l: () => void) => {
        m.listeners.add(l);
        return () => { m.listeners.delete(l); };
    },
    placeQuickOrder: m.send.placeQuickOrder,
    cancelAllOrders: m.send.cancelAllOrders,
}));
vi.mock('../../lib/shioaji', () => ({
    placeStockOrder: m.send.placeStockOrder,
    placeFuturesOrder: m.send.placeFuturesOrder,
    cancelOrder: m.send.cancelOrder,
    cancelOrders: m.send.cancelOrders,
    updateOrderPrice: m.send.updateOrderPrice,
    updateOrderQty: m.send.updateOrderQty,
}));
vi.mock('../lib/mobile-order', () => ({ submitMobileOrder: m.send.submitMobileOrder }));
vi.mock('../../lib/privacy', () => ({ usePrivacyMode: () => false }));
vi.mock('../../hooks/use-stream', () => ({ useStreamStatus: () => 'live' }));
vi.mock('../hooks/use-resume-gate', () => ({
    useResumeGate: () => ({ state: 'ready', since: 0, checks: null, staleAcknowledged: false, resumeSeq: 0, message: null }),
}));
vi.mock('../lib/resume-gate-runtime', () => ({ acknowledgeStaleData: vi.fn(), retryResume: vi.fn() }));
vi.mock('../lib/mobile-store', () => ({ useMobileUi: () => ({ currentCode: null }), openTicket: m.openTicket, openOrderAction: m.openOrderAction }));
vi.mock('./account-switch-sheet', () => ({ AccountSwitchSheet: () => null, mobileAccountLabel: () => '' }));
vi.mock('./route-badge', () => ({ useOrderRoute: () => null, routeTone: () => 'unknown' }));
vi.mock('./slide-to-confirm', () => ({ SlideToConfirm: () => null }));
// 面板外殼：開啟時原地渲染內容（看得到 SheetLoadError 的按鈕）
vi.mock('./bottom-sheet', () => ({
    BottomSheet: ({ open, testId, children }: { open: boolean; testId?: string; children?: ReactNode }) =>
        (open ? createElement('div', { 'data-testid': testId }, children) : null),
}));
vi.mock('../lib/deferred-modules', () => ({
    loadNoticeCenterSheet: async () => {
        m.loads++;
        if (m.fail) throw new TypeError('Failed to fetch dynamically imported module: notice-center-sheet.js');
        return {
            NoticeCenterSheet: (props: { open: boolean; onClose: () => void }) => {
                m.sheetProps.push({ open: props.open });
                return props.open
                    ? createElement('button', { type: 'button', 'data-testid': 'stub-sheet-close', onClick: props.onClose }, '關閉')
                    : null;
            },
        };
    },
}));

import { noticeBellLabel } from './status-bar';

// retryableLazy 的載入狀態是模組層的：每個測試重新載入 status-bar（mock 照常套用）
let StatusBar: typeof import('./status-bar').StatusBar;

let view: ReactTestRenderer | undefined;
const all = (id: string): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
const one = (id: string) => all(id)[0]!;
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const bell = () => one('status-notices');
/** 徽章：鈴按鈕內 aria-hidden 的 span */
const badge = () => bell().findAll(n => n.type === 'span' && n.props['aria-hidden'] === 'true');
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const press = async (id: string) => {
    await act(async () => { one(id).props.onClick({ preventDefault() {}, stopPropagation() {} }); });
    await settle();
};

let t = 1_000_000;
function push(n = 1) {
    for (let i = 0; i < n; i++) {
        t += 10;
        m.log = [...m.log, { kind: 'info', title: `通知 ${t}`, body: '', ts: t }];
    }
    m.listeners.forEach(l => l());
}

let storageWrites: string[];
beforeEach(async () => {
    vi.resetModules();
    ({ StatusBar } = await import('./status-bar'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date'] });
    t = 1_000_000;
    vi.setSystemTime(t);
    storageWrites = [];
    const storage = () => ({ getItem: () => null, setItem: (k: string, v: string) => { storageWrites.push(`${k}=${v}`); }, removeItem: () => undefined });
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('sessionStorage', storage());
    m.log = [];
    m.listeners.clear();
    m.loads = 0;
    m.fail = false;
    m.sheetProps = [];
    m.openTicket.mockReset();
    m.openOrderAction.mockReset();
    Object.values(m.send).forEach(f => f.mockReset());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function render() {
    await act(async () => { view = create(createElement(StatusBar)); });
}

describe('通知鈴與未讀數', () => {
    it('noticeBellLabel', () => {
        expect(noticeBellLabel(0)).toBe('通知');
        expect(noticeBellLabel(3)).toBe('通知，3 則未讀');
    });

    it('沒有通知：名稱「通知」、沒有徽章；有 3 則：「通知，3 則未讀」、徽章 3（aria-hidden）；超過 99 顯示 99+', async () => {
        await render();
        expect(bell().props['aria-label']).toBe('通知');
        expect(badge()).toHaveLength(0);
        await act(async () => { push(3); });
        expect(bell().props['aria-label']).toBe('通知，3 則未讀');
        expect(badge().map(textOf)).toEqual(['3']);
        await act(async () => { push(97); });
        expect(bell().props['aria-label']).toBe('通知，100 則未讀');
        expect(badge().map(textOf)).toEqual(['99+']);
    });

    it('開啟即全部已讀；開著時進來的通知關閉後也算已讀；關閉後新的才算未讀', async () => {
        await render();
        await act(async () => { push(2); });
        vi.setSystemTime(t + 1);
        await press('status-notices');
        expect(bell().props['aria-label']).toBe('通知');
        expect(badge()).toHaveLength(0);
        // 開著時又來一則
        await act(async () => { push(1); });
        vi.setSystemTime(t + 1);
        await press('stub-sheet-close');
        expect(m.sheetProps.at(-1)).toEqual({ open: false });
        expect(bell().props['aria-label']).toBe('通知');
        await act(async () => { push(1); });
        expect(bell().props['aria-label']).toBe('通知，1 則未讀');
    });
});

describe('延遲載入', () => {
    it('沒按鈴不載入；第一次按鈴才 import 一次，關閉再開不重複 import', async () => {
        await render();
        await act(async () => { push(1); });
        expect(m.loads).toBe(0);
        expect(m.sheetProps).toHaveLength(0);
        await press('status-notices');
        expect(m.loads).toBe(1);
        expect(m.sheetProps.at(-1)).toEqual({ open: true });
        await press('stub-sheet-close');
        await press('status-notices');
        expect(m.loads).toBe(1);
        expect(m.sheetProps.at(-1)).toEqual({ open: true });
    });

    it('載入失敗：顯示 SheetLoadError（只在要求開啟時）；［重試］才重新 import，成功後顯示面板', async () => {
        m.fail = true;
        await render();
        await press('status-notices');
        expect(m.loads).toBe(1);
        expect(all('notice-load-error')).toHaveLength(1);
        expect(all('status-notices')).toHaveLength(1);
        m.fail = false;
        await press('notice-load-error-body-retry');
        expect(m.loads).toBe(2);
        expect(all('notice-load-error')).toHaveLength(0);
        expect(m.sheetProps.at(-1)).toEqual({ open: true });
    });
});

describe('隱私與 S1', () => {
    it('開關通知中心、通知進出：不寫入 localStorage／sessionStorage', async () => {
        await render();
        await act(async () => { push(3); });
        await press('status-notices');
        await press('stub-sheet-close');
        expect(storageWrites).toEqual([]);
    });

    it('S1：按鈴、載入失敗面板的每個按鈕：openTicket／openOrderAction 與 lib 送單、改單、刪單 0 次', async () => {
        m.fail = true;
        await render();
        await act(async () => { push(2); });
        await press('status-notices');
        for (const b of one('notice-load-error').findAll(n => n.type === 'button')) {
            expect(textOf(b)).not.toMatch(/買進|賣出|下單|送出/);
            await act(async () => { b.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); });
            await settle();
        }
        m.fail = false;
        await press('status-notices');
        for (const b of view!.root.findAll(n => n.type === 'button' && n.props['data-testid'] === 'stub-sheet-close')) {
            await act(async () => { b.props.onClick?.(); });
        }
        expect(m.openTicket).not.toHaveBeenCalled();
        expect(m.openOrderAction).not.toHaveBeenCalled();
        for (const [name, fn] of Object.entries(m.send)) expect(fn, name).not.toHaveBeenCalled();
    });
});
