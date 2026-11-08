// src/mobile/lib/hash-router.ts — 極簡 hash 路由（規格 §4.2、§5.1）
//
// 為什麼用 hash：nginx 的 SPA fallback 會把未知路徑導向桌面 index.html，
// `#/trade/2330` 這類 hash 路由不會落到桌面版。
// 路由：#/watchlist（預設）、#/trade/:code、#/market（產業流向）、#/market/signals（盤中異動）、#/orders、#/positions、#/account。
// 舊書籤 #/sector 解析為 #/market（App 以 replace 正規化，不新增歷史紀錄）。
// 解析與組字串是純函式；useHashRoute() 只訂閱 hashchange。

import { useSyncExternalStore } from 'react';

export type MobileRoute =
    | { name: 'watchlist' }
    /** code 為 null：交易分頁尚未選商品（例如直接點底部「交易」） */
    | { name: 'trade'; code: string | null }
    /** 底部分頁「市場」：flow＝產業流向（#/market）、signals＝盤中異動（#/market/signals） */
    | { name: 'market'; segment: MarketSegment }
    | { name: 'orders' }
    | { name: 'positions' }
    | { name: 'account' };

export type MarketSegment = 'flow' | 'signals';

export type MobileTab = MobileRoute['name'];

export const MOBILE_TABS: readonly MobileTab[] = ['watchlist', 'trade', 'market', 'orders', 'positions', 'account'];

/** 「市場」分頁上次的分段（本 session；sessionStorage，讀寫失敗時回到產業流向）。寫入在市場頁（延遲載入）。 */
export const MARKET_SEGMENT_KEY = 'sj-mobile-market-segment';

export function lastMarketSegment(): MarketSegment {
    try {
        return sessionStorage.getItem(MARKET_SEGMENT_KEY) === 'signals' ? 'signals' : 'flow';
    } catch {
        return 'flow';
    }
}

export const DEFAULT_ROUTE: MobileRoute = { name: 'watchlist' };

/** 商品代碼白名單：英數與 . _ -，最長 32 字（防止任意字串進入 API 查詢） */
const CODE_RE = /^[A-Za-z0-9._-]{1,32}$/;

export function isValidProductCode(code: string): boolean {
    return CODE_RE.test(code);
}

function decode(segment: string): string | null {
    try {
        return decodeURIComponent(segment);
    } catch {
        return null;
    }
}

/**
 * 解析 location.hash（可含或不含開頭的 #）。
 * 無法辨識的路由一律回到預設（自選）；交易頁的商品代碼不合法時 code 為 null。
 */
export function parseHash(hash: string): MobileRoute {
    const raw = hash.replace(/^#/, '').replace(/^\/+/, '');
    // 去掉 query（#/trade/2330?x=1）與結尾斜線
    const path = raw.split('?')[0]!.replace(/\/+$/, '');
    const [head, ...rest] = path.split('/');
    switch (head) {
        case 'market':
        case 'sector':
            if (rest.length === 0) return { name: 'market', segment: 'flow' };
            return head === 'market' && rest.length === 1 && rest[0] === 'signals' ? { name: 'market', segment: 'signals' } : DEFAULT_ROUTE;
        case 'watchlist':
        case 'orders':
        case 'positions':
        case 'account':
            return rest.length === 0 ? { name: head } : DEFAULT_ROUTE;
        case 'trade': {
            if (rest.length === 0) return { name: 'trade', code: null };
            if (rest.length > 1) return { name: 'trade', code: null };
            const code = decode(rest[0]!);
            return { name: 'trade', code: code && isValidProductCode(code) ? code : null };
        }
        default:
            return DEFAULT_ROUTE;
    }
}

/** 路由 → hash 字串（含 #） */
export function formatRoute(route: MobileRoute): string {
    if (route.name === 'trade') {
        return route.code && isValidProductCode(route.code) ? `#/trade/${encodeURIComponent(route.code)}` : '#/trade';
    }
    if (route.name === 'market') return route.segment === 'signals' ? '#/market/signals' : '#/market';
    return `#/${route.name}`;
}

/** 目前 hash 是否已是正規形式（否則 App 啟動時以 replace 改寫成正規 hash） */
export function isCanonicalHash(hash: string): boolean {
    return formatRoute(parseHash(hash)) === (hash.startsWith('#') ? hash : `#${hash}`);
}

export function sameRoute(a: MobileRoute, b: MobileRoute): boolean {
    return formatRoute(a) === formatRoute(b);
}

/** 導覽：replace 不新增歷史紀錄（用於正規化與重新導向） */
export function navigate(route: MobileRoute, opts: { replace?: boolean } = {}): void {
    if (typeof location === 'undefined') return;
    const next = formatRoute(route);
    if (location.hash === next) return;
    if (opts.replace && typeof history !== 'undefined') {
        // replaceState 不觸發 hashchange，自行通知訂閱者
        history.replaceState(history.state, '', `${location.pathname}${location.search}${next}`);
        notifyHashListeners();
    } else {
        location.hash = next;
    }
}

const hashListeners = new Set<() => void>();
function notifyHashListeners() {
    hashListeners.forEach(l => l());
}

function subscribeHash(listener: () => void): () => void {
    hashListeners.add(listener);
    if (typeof window !== 'undefined') window.addEventListener('hashchange', listener);
    return () => {
        hashListeners.delete(listener);
        if (typeof window !== 'undefined') window.removeEventListener('hashchange', listener);
    };
}

function readHash(): string {
    return typeof location === 'undefined' ? '' : location.hash;
}

/** 目前路由（hash 變化時重新渲染） */
export function useHashRoute(): MobileRoute {
    const hash = useSyncExternalStore(subscribeHash, readHash, () => '');
    return parseHash(hash);
}
