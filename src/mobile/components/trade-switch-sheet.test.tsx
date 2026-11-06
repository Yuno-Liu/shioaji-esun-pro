// 交易頁切換商品面板：搜尋（debounce、取消舊查詢）、空白時「最近查看」與「自選」、整列切換、目前商品只關閉、
// 加入自選晶片、代理輸入框的焦點轉移（就緒、減少動態、逾時後備、組字延後）、關閉後退場中暫停查詢。
import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileWatchlist } from '../lib/watchlist-context';

const m = vi.hoisted(() => ({
    searchProducts: vi.fn(),
    wl: null as unknown,
}));
vi.mock('../../lib/product-search', () => ({ searchProducts: m.searchProducts }));
vi.mock('../lib/watchlist-context', () => ({ useOptionalMobileWatchlist: () => m.wl }));

import type { FocusProxy } from '../lib/focus-proxy';
import { RECENT_CODES_KEY } from '../lib/recent-codes';
import { setMotionClockForTest } from '../motion/spring';
import { REDUCED_MOTION } from '../styles/tokens';
import * as wlStyles from '../styles/watchlist.css';
import { InlineNote } from '../ui/inline-note';
import { BottomSheet } from './bottom-sheet';
import { SEARCH_DEBOUNCE_MS } from '../hooks/use-product-search';
import { FOCUS_FALLBACK_MS, TradeSwitchSheet, type TradeSwitchSheetProps } from './trade-switch-sheet';

const tsmc = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', detail: '上市' };
const hon = { code: '2317', name: '鴻海', security_type: 'STK', exchange: 'TSE', detail: '上市' };
const txf = { code: 'TXFR1', name: '台指期近月', security_type: 'FUT', exchange: 'TAIFEX', detail: '' };

let view: ReactTestRenderer | undefined;
let store: Map<string, string>;
const onClose = vi.fn();
const onSelect = vi.fn();
const addSymbol = vi.fn(async () => undefined);

function watchlist(over: Partial<MobileWatchlist> = {}): MobileWatchlist {
    return {
        items: [
            { contract: { code: '2317', name: '鴻海', security_type: 'STK' } },
            { contract: { code: '2330', name: '台積電', security_type: 'STK' } },
        ],
        loading: false,
        structureBusy: false,
        loadError: null,
        addSymbol,
        ...over,
    } as unknown as MobileWatchlist;
}

function props(over: Partial<TradeSwitchSheetProps> = {}): TradeSwitchSheetProps {
    return { open: true, onClose, onSelect, currentCode: '2330', ...over };
}
async function render(over: Partial<TradeSwitchSheetProps> = {}, opts?: { createNodeMock: (el: ReactElement) => unknown }) {
    await act(async () => { view = create(createElement(TradeSwitchSheet, props(over)), opts); });
}
const byTestId = (id: string) => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === id);
const input = () => byTestId('trade-switch-input')[0]!;
async function type(text: string) {
    await act(async () => { input().props.onChange({ target: { value: text } }); });
}
const picks = () => byTestId('trade-switch-pick');
const pickCodes = (listId: string) => byTestId(listId)[0]!.findAll(n => n.props['data-testid'] === 'trade-switch-pick').map(n => n.props['data-code']);
const json = () => JSON.stringify(view!.toJSON());

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    m.searchProducts.mockReset();
    m.wl = watchlist();
    onClose.mockReset();
    onSelect.mockReset();
    addSymbol.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('TradeSwitchSheet 版面', () => {
    it('標題「切換商品」、面板 large；搜尋框在 sticky 搜尋欄內；下方說明一行（搜尋框以 aria-describedby 連到它）', async () => {
        await render();
        const sheet = view!.root.find(n => n.type === BottomSheet);
        expect(sheet.props.title).toBe('切換商品');
        expect(sheet.props.detent).toBe('large');
        expect(sheet.props.testId).toBe('trade-switch-sheet');
        const bar = view!.root.find(n => n.type === 'div' && n.props.className === wlStyles.searchBar);
        expect(bar.findAll(n => n.props['data-testid'] === 'trade-switch-input')).toHaveLength(1);
        expect(input().props.type).toBe('search');
        expect(input().props['aria-label']).toBe('搜尋商品');
        const hint = byTestId('trade-switch-hint')[0]!;
        expect(hint.props.children).toBe('可輸入代碼或名稱（支援部分字詞與模糊比對；加「期」可查期貨）');
        expect(input().props['aria-describedby']).toBe(hint.props.id);
    });
});

describe('TradeSwitchSheet 搜尋', () => {
    it('debounce 後以上限 10 查詢一次', async () => {
        m.searchProducts.mockResolvedValue([tsmc]);
        await render();
        await type('台');
        await type('台積');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1); });
        expect(m.searchProducts).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(m.searchProducts).toHaveBeenCalledTimes(1);
        expect(m.searchProducts.mock.calls[0]![0]).toBe('台積');
        expect(m.searchProducts.mock.calls[0]![1]).toBe(10);
        expect(byTestId('trade-switch-result')).toHaveLength(1);
    });

    it('新輸入取消前一次查詢；晚到的舊結果不覆蓋新結果', async () => {
        let resolveFirst: (v: unknown) => void = () => undefined;
        m.searchProducts
            .mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }))
            .mockResolvedValueOnce([hon]);
        await render();
        await type('23');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        const firstSignal = (m.searchProducts.mock.calls[0]![2] as { signal: AbortSignal }).signal;
        await type('2317');
        expect(firstSignal.aborted).toBe(true);
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        await act(async () => { resolveFirst([tsmc]); });
        expect(byTestId('trade-switch-result')).toHaveLength(1);
        expect(picks().map(p => p.props['data-code'])).toEqual(['2317']);
    });

    it('查詢失敗與找不到時顯示狀態文字', async () => {
        m.searchProducts.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce([]);
        await render();
        await type('zz');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        expect(json()).toContain('搜尋失敗，請稍後再試。');
        await type('zzz');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        expect(json()).toContain('找不到符合的商品。');
    });

    it('整列點擊＝切換（onSelect）；沒有「交易」晶片；列尾「加入自選／已在自選」呼叫既有加入方法', async () => {
        m.searchProducts.mockResolvedValue([hon, txf]);
        await render();
        await type('期');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        expect(byTestId('search-trade')).toHaveLength(0);
        expect(view!.root.findAll(n => n.type === 'button' && n.props.children === '交易')).toHaveLength(0);
        const adds = byTestId('trade-switch-add');
        expect(adds.map(a => a.props.children)).toEqual(['已在自選', '加入自選']);
        expect(adds[0]!.props.disabled).toBe(true);
        expect(adds.map(a => a.props['aria-label'])).toEqual(['2317 已在自選', 'TXFR1 加入自選']);
        await act(async () => { adds[1]!.props.onClick(); });
        expect(addSymbol).toHaveBeenCalledWith('TXFR1', 'FUT', undefined);
        const pick = picks().find(p => p.props['data-code'] === 'TXFR1')!;
        expect(pick.props['aria-label']).toBe('切換到 TXFR1 台指期近月');
        await act(async () => { pick.props.onClick(); });
        expect(onSelect).toHaveBeenCalledWith('TXFR1');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('加入失敗以 InlineNote（role=alert）顯示在該列', async () => {
        m.searchProducts.mockResolvedValue([txf]);
        addSymbol.mockRejectedValueOnce(new Error('自選清單更新中'));
        await render();
        await type('台指');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        await act(async () => { byTestId('trade-switch-add')[0]!.props.onClick(); });
        const note = view!.root.findAll(n => n.type === InlineNote);
        expect(note).toHaveLength(1);
        expect(note[0]!.props.role).toBe('alert');
        expect(json()).toContain('自選清單更新中');
    });

    it('目前商品標「目前」（aria-current）；點了只關閉、不切換', async () => {
        m.searchProducts.mockResolvedValue([tsmc]);
        await render();
        await type('2330');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        const pick = picks()[0]!;
        expect(pick.props['aria-current']).toBe('true');
        expect(pick.props['aria-label']).toBe('2330 台積電（目前商品）');
        expect(json()).toContain('目前');
        await act(async () => { pick.props.onClick(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('不在 WatchlistProvider 內：沒有加入晶片，照常搜尋與切換', async () => {
        m.wl = null;
        m.searchProducts.mockResolvedValue([hon]);
        await render();
        await type('鴻');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        expect(byTestId('trade-switch-add')).toHaveLength(0);
        await act(async () => { picks()[0]!.props.onClick(); });
        expect(onSelect).toHaveBeenCalledWith('2317');
    });
});

describe('TradeSwitchSheet 空白查詢：最近查看與自選', () => {
    it('兩區都顯示且可一點切換；自選取自已載入的清單（不查詢）', async () => {
        store.set(RECENT_CODES_KEY, JSON.stringify([
            { code: '2330', name: '台積電', securityType: 'STK' },
            { code: 'TXFR1', name: '台指期近月', securityType: 'FUT' },
        ]));
        await render();
        expect(json()).toContain('最近查看');
        expect(json()).toContain('自選');
        expect(pickCodes('trade-switch-recent')).toEqual(['2330', 'TXFR1']);
        expect(pickCodes('trade-switch-watchlist')).toEqual(['2317', '2330']);
        expect(m.searchProducts).not.toHaveBeenCalled();
        const recentTx = byTestId('trade-switch-recent')[0]!.find(n => n.props['data-code'] === 'TXFR1');
        await act(async () => { recentTx.props.onClick(); });
        expect(onSelect).toHaveBeenLastCalledWith('TXFR1');
        const watchHon = byTestId('trade-switch-watchlist')[0]!.find(n => n.props['data-code'] === '2317');
        await act(async () => { watchHon.props.onClick(); });
        expect(onSelect).toHaveBeenLastCalledWith('2317');
        // 目前商品在兩區都標示，點了只關閉
        const recentCurrent = byTestId('trade-switch-recent')[0]!.find(n => n.props['data-code'] === '2330');
        expect(recentCurrent.props['aria-current']).toBe('true');
        await act(async () => { recentCurrent.props.onClick(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledTimes(2);
    });

    it('有輸入時隱藏兩區', async () => {
        store.set(RECENT_CODES_KEY, JSON.stringify([{ code: '2330', name: '台積電' }]));
        m.searchProducts.mockResolvedValue([]);
        await render();
        await type('x');
        expect(byTestId('trade-switch-recent')).toHaveLength(0);
        expect(byTestId('trade-switch-watchlist')).toHaveLength(0);
    });

    it('localStorage 壞資料：沒有最近查看區，自選區照常', async () => {
        store.set(RECENT_CODES_KEY, '{not json');
        await render();
        expect(byTestId('trade-switch-recent')).toHaveLength(0);
        expect(json()).not.toContain('最近查看');
        expect(pickCodes('trade-switch-watchlist')).toEqual(['2317', '2330']);
    });

    it('localStorage 讀取丟錯、自選為空或不在 provider 內：兩區都不顯示', async () => {
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => undefined });
        m.wl = watchlist({ items: [] });
        await render();
        expect(byTestId('trade-switch-recent')).toHaveLength(0);
        expect(byTestId('trade-switch-watchlist')).toHaveLength(0);
        await act(async () => view!.unmount());
        m.wl = null;
        await render();
        expect(byTestId('trade-switch-watchlist')).toHaveLength(0);
    });
});

describe('TradeSwitchSheet 代理輸入框的焦點轉移', () => {
    const fakeProxy = () => ({ engage: vi.fn(), release: vi.fn(() => '') }) satisfies FocusProxy;
    const inputNode = { focus: vi.fn() };
    const inputOnlyMock = (el: ReactElement) => ((el.props as Record<string, unknown>)['data-testid'] === 'trade-switch-input' ? inputNode : null);

    it('同步模式（面板立即就緒）：release 到真正的搜尋框，並清掉 ref（只轉一次）', async () => {
        const proxy = fakeProxy();
        const ref = { current: proxy as FocusProxy | null };
        await render({ focusProxy: ref }, { createNodeMock: inputOnlyMock });
        expect(proxy.release).toHaveBeenCalledTimes(1);
        expect(proxy.release).toHaveBeenCalledWith(inputNode);
        expect(ref.current).toBeNull();
        await type('2');
        expect(proxy.release).toHaveBeenCalledTimes(1);
    });

    it('轉移前已打進代理輸入框的字帶進搜尋框並照常查詢', async () => {
        m.searchProducts.mockResolvedValue([tsmc]);
        const proxy = { engage: vi.fn(), release: vi.fn(() => '台積') } satisfies FocusProxy;
        const ref = { current: proxy as FocusProxy | null };
        await render({ focusProxy: ref }, { createNodeMock: inputOnlyMock });
        expect(input().props.value).toBe('台積');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        expect(m.searchProducts.mock.calls[0]![0]).toBe('台積');
    });

    it('代理輸入框正在組字（release 回傳 null）：保留 ref、不重複 release；延後轉移完成時帶入確定的文字並清掉 ref', async () => {
        m.searchProducts.mockResolvedValue([tsmc]);
        let late: ((typed: string) => void) | undefined;
        const proxy = { engage: vi.fn(), release: vi.fn((): string | null => null), onDeferred: vi.fn((cb: (t: string) => void) => { late = cb; }) } satisfies FocusProxy;
        const ref = { current: proxy as FocusProxy | null };
        await render({ focusProxy: ref }, { createNodeMock: inputOnlyMock });
        expect(proxy.release).toHaveBeenCalledTimes(1);
        expect(proxy.release).toHaveBeenCalledWith(inputNode);
        expect(proxy.onDeferred).toHaveBeenCalledTimes(1);
        expect(ref.current).toBe(proxy); // 父層關閉時仍能以 release() 取消
        await act(async () => { view!.update(createElement(TradeSwitchSheet, props({ focusProxy: ref }))); });
        expect(proxy.release).toHaveBeenCalledTimes(1);
        await act(async () => { late!('台積'); });
        expect(ref.current).toBeNull();
        expect(input().props.value).toBe('台積');
        await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
        expect(m.searchProducts.mock.calls[0]![0]).toBe('台積');
    });

    describe('可動畫（假時鐘）', () => {
        let now = 0;
        let frames = new Map<number, (t: number) => void>();
        let nextId = 1;
        const animMock = (el: ReactElement) => {
            const p = el.props as Record<string, unknown>;
            if (p['data-testid'] === 'trade-switch-input') return inputNode;
            return { style: {}, isConnected: true, getBoundingClientRect: () => ({ height: 600, width: 390 }), focus: vi.fn(), contains: () => false };
        };
        const step = async (ms = 16) => {
            await act(async () => {
                now += ms;
                const fs = Array.from(frames.values());
                frames = new Map();
                fs.forEach(f => f(now));
            });
        };
        /** 進場跑完（否則面板還在起點，關閉時退場彈簧立即到位、直接卸載） */
        const settleEntry = async () => {
            for (let t = 0; t < 1500 && byTestId('trade-switch-sheet')[0]?.props['data-phase'] !== 'open'; t += 16) await step();
            expect(byTestId('trade-switch-sheet')[0]!.props['data-phase']).toBe('open');
        };
        beforeEach(() => {
            now = 1000;
            frames = new Map();
            nextId = 1;
            setMotionClockForTest({
                now: () => now,
                frame: cb => { const id = nextId++; frames.set(id, cb); return id; },
                cancel: id => { frames.delete(id); },
            });
        });
        afterEach(() => { setMotionClockForTest(null); });

        it('進場動畫中不轉移；進場完成（settled）後才 release 到搜尋框', async () => {
            const proxy = fakeProxy();
            const ref = { current: proxy as FocusProxy | null };
            await render({ focusProxy: ref }, { createNodeMock: animMock });
            expect(byTestId('trade-switch-sheet')[0]!.props['data-phase']).toBe('entering');
            expect(proxy.release).not.toHaveBeenCalled();
            for (let t = 0; t < 1500 && proxy.release.mock.calls.length === 0; t += 16) await step();
            expect(byTestId('trade-switch-sheet')[0]!.props['data-phase']).toBe('open');
            expect(proxy.release).toHaveBeenCalledWith(inputNode);
        });

        it('一直沒有就緒：最晚 FOCUS_FALLBACK_MS 後轉移', async () => {
            const proxy = fakeProxy();
            const ref = { current: proxy as FocusProxy | null };
            await render({ focusProxy: ref }, { createNodeMock: animMock });
            await act(async () => { vi.advanceTimersByTime(FOCUS_FALLBACK_MS - 1); });
            expect(proxy.release).not.toHaveBeenCalled();
            await act(async () => { vi.advanceTimersByTime(1); });
            expect(proxy.release).toHaveBeenCalledWith(inputNode);
        });

        it('關閉後退場中：debounce 中的查詢不再發出', async () => {
            m.searchProducts.mockResolvedValue([tsmc]);
            await render({}, { createNodeMock: animMock });
            await settleEntry();
            await type('台積');
            await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50); });
            await act(async () => { view!.update(createElement(TradeSwitchSheet, props({ open: false }))); });
            expect(byTestId('trade-switch-sheet-closing')).toHaveLength(1);
            await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 4); });
            expect(m.searchProducts).not.toHaveBeenCalled();
        });

        it('關閉後退場中：進行中的查詢被 abort，晚到的結果不換掉退場中的畫面（也不清空）', async () => {
            let resolveSecond: (v: unknown) => void = () => undefined;
            m.searchProducts
                .mockResolvedValueOnce([tsmc])
                .mockImplementationOnce(() => new Promise(r => { resolveSecond = r; }));
            await render({}, { createNodeMock: animMock });
            await settleEntry();
            await type('台積');
            await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
            expect(picks().map(p => p.props['data-code'])).toEqual(['2330']);
            await type('2317');
            await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
            expect(m.searchProducts).toHaveBeenCalledTimes(2);
            const signal = (m.searchProducts.mock.calls[1]![2] as { signal: AbortSignal }).signal;
            expect(signal.aborted).toBe(false);
            await act(async () => { view!.update(createElement(TradeSwitchSheet, props({ open: false }))); });
            expect(signal.aborted).toBe(true);
            await act(async () => { resolveSecond([hon]); });
            await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 4); });
            expect(byTestId('trade-switch-sheet-closing')).toHaveLength(1);
            expect(picks().map(p => p.props['data-code'])).toEqual(['2330']);
            expect(m.searchProducts).toHaveBeenCalledTimes(2);
        });

        it('減少動態：不等淡入，立即轉移', async () => {
            vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === REDUCED_MOTION, addEventListener: () => undefined, removeEventListener: () => undefined }));
            const proxy = fakeProxy();
            const ref = { current: proxy as FocusProxy | null };
            await render({ focusProxy: ref }, { createNodeMock: animMock });
            expect(byTestId('trade-switch-sheet')[0]!.props['data-phase']).toBe('entering');
            expect(proxy.release).toHaveBeenCalledWith(inputNode);
        });
    });
});
