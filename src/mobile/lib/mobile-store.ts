// src/mobile/lib/mobile-store.ts — 手機版 UI 狀態（規格 §4.2）
//
// 只放「畫面狀態」：目前商品、目前分頁、下單面板開啟狀態與帶入的價格／方向、委託操作面板的目標。
// **不放任何交易資料**（委託、持倉、帳戶、伺服器模式都以 src/lib 的 store 為準），
// 也不放送單用的帳戶——送單帳戶一律在送出時由 src/lib 擷取與重驗（規格 §7.1）。

import { useSyncExternalStore } from 'react';
import type { Action, StockOrderCond } from '../../lib/types/order';
import type { MobileTab } from './hash-router';

/** 下單面板可帶入的股票單位：整股、盤中零股、盤後零股 */
export type TicketLot = 'Common' | 'IntradayOdd' | 'Odd';

/** 下單面板可帶入的股票信用條件（借券類不在手機提供，規格 §12） */
export type TicketCond = Extract<StockOrderCond, 'Cash' | 'MarginTrading' | 'ShortSelling'>;

/** 下單面板（order-ticket-sheet.tsx，T4）的開啟要求 */
export interface TicketRequest {
    /** 開啟時的商品代碼（行情代碼；連續月別名如 TXFR1 亦可，送單時由 src/lib 換成實際月份） */
    code: string;
    /** 帶入的方向；null＝由使用者在面板上選（例如五檔價位只帶價、不決定買賣） */
    action: Action | null;
    /** 帶入的價格（只在開啟時帶入一次，之後不自動跟價）；null＝面板用最新成交價 */
    price: number | null;
    /** 帶入價格的來源，面板可用來顯示提示 */
    source: 'button' | 'chart' | 'depth' | 'position' | 'other';
    /** 每次開啟遞增；面板以此判斷「這是一次新的開啟」並重新初始化欄位 */
    seq: number;
    /**
     * openTicket 的時間（Date.now()）。面板與 ResumeGate 的 resyncStartedAt 比較：帶入之後開始過重新同步，
     * 帶入的價格一律標示「價格可能過期」（面板可能延後掛載，不能以掛載當下為準）。缺省＝不比較。
     */
    openedAt?: number;
    /**
     * 只在開啟時帶入一次的股票預設（持倉「加碼」用）；缺省＝面板自己的預設（整股、現股、不當沖）。
     * 面板仍須依規則驗證（例如融券／當沖先賣只限整股、當沖先賣只限賣出＋現股＋可當沖），不合規則時不得送出。
     */
    lot?: TicketLot;
    cond?: TicketCond;
    daytradeShort?: boolean;
}

/** 委託操作面板（order-action-sheet.tsx，T6）要開啟的動作 */
export type OrderActionKind = 'menu' | 'price' | 'qty' | 'cancel';

export interface OrderActionRequest {
    /** Trade.order.id */
    tradeId: string;
    kind: OrderActionKind;
    seq: number;
}

export interface MobileUiState {
    /** 目前商品（交易分頁顯示的商品）；null＝尚未選擇 */
    currentCode: string | null;
    /** 目前分頁（由 app.tsx 依 hash 路由同步） */
    activeTab: MobileTab;
    /** 下單面板：null＝關閉 */
    ticket: TicketRequest | null;
    /** 委託操作面板：null＝關閉 */
    orderAction: OrderActionRequest | null;
}

const CODE_KEY = 'sj-mobile-current-code';

function loadCode(): string | null {
    try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(CODE_KEY);
        return raw && /^[A-Za-z0-9._-]{1,32}$/.test(raw) ? raw : null;
    } catch {
        return null;
    }
}

let state: MobileUiState = { currentCode: loadCode(), activeTab: 'watchlist', ticket: null, orderAction: null };
let seq = 0;
const listeners = new Set<() => void>();

function set(next: Partial<MobileUiState>) {
    state = { ...state, ...next };
    listeners.forEach(l => l());
}

export function getMobileUi(): MobileUiState {
    return state;
}

export function subscribeMobileUi(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useMobileUi(): MobileUiState {
    return useSyncExternalStore(subscribeMobileUi, getMobileUi);
}

/** 設定目前商品（記在本機，重新開啟時回到上次的商品） */
export function setCurrentCode(code: string | null): void {
    if (code === state.currentCode) return;
    try {
        if (code) localStorage.setItem(CODE_KEY, code);
        else localStorage.removeItem(CODE_KEY);
    } catch {
        // 無法寫入時只在本次有效
    }
    set({ currentCode: code });
}

export function setActiveTab(tab: MobileTab): void {
    if (tab !== state.activeTab) set({ activeTab: tab });
}

/**
 * 開啟下單面板並帶入方向／價格。只開面板，**不會送單**；
 * 面板內仍需「預覽 → 確認面板滑動確認」才會送出。
 */
export function openTicket(req: {
    code: string;
    action?: Action | null;
    price?: number | null;
    source?: TicketRequest['source'];
    lot?: TicketLot;
    cond?: TicketCond;
    daytradeShort?: boolean;
}): void {
    const ticket: TicketRequest = {
        code: req.code,
        action: req.action ?? null,
        price: req.price ?? null,
        source: req.source ?? 'other',
        seq: ++seq,
        openedAt: Date.now(),
    };
    if (req.lot) ticket.lot = req.lot;
    if (req.cond) ticket.cond = req.cond;
    if (req.daytradeShort) ticket.daytradeShort = true;
    set({ ticket });
}

export function closeTicket(): void {
    if (state.ticket) set({ ticket: null });
}

export function openOrderAction(tradeId: string, kind: OrderActionKind = 'menu'): void {
    set({ orderAction: { tradeId, kind, seq: ++seq } });
}

export function closeOrderAction(): void {
    if (state.orderAction) set({ orderAction: null });
}

/** 測試用：重設為初始狀態 */
export function resetMobileUiForTest(): void {
    state = { currentCode: null, activeTab: 'watchlist', ticket: null, orderAction: null };
    listeners.forEach(l => l());
}
