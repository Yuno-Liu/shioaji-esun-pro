// src/mobile/lib/secure-context.ts — secure context 偵測（規格 R1、§3.1）
//
// 手機只能經 HTTPS 使用：非 secure context 沒有 Web Locks，src/lib/shared-stream.ts 會 fail-closed
// （不建立 EventSource），assertTradingLive() 永遠擋單。偵測不通過時只顯示說明頁，不建立任何連線。
// 純函式＋可注入環境，方便單元測試；不 import src/lib，避免在非 secure context 載入時觸發副作用。

export interface SecureContextDiagnostics {
    /** window.isSecureContext */
    isSecureContext: boolean;
    /** navigator.locks.request 是否存在（Web Locks；只在 secure context 提供） */
    webLocks: boolean;
    /** BroadcastChannel 是否存在（iOS Safari 15.4+） */
    broadcastChannel: boolean;
    userAgent: string;
    /** 建置版本（__SHIOAJI_BUILD_VERSION__） */
    buildVersion: string;
    /** 目前來源（scheme://host[:port]），方便使用者判斷是否用了 http:// */
    origin: string;
}

/** 可注入的環境（預設為瀏覽器全域） */
export interface SecureContextEnv {
    isSecureContext?: boolean;
    navigator?: { locks?: { request?: unknown }; userAgent?: string };
    BroadcastChannel?: unknown;
    location?: { origin?: string };
}

function buildVersion(): string {
    return typeof __SHIOAJI_BUILD_VERSION__ === 'string' ? __SHIOAJI_BUILD_VERSION__ : 'unknown';
}

function browserEnv(): SecureContextEnv {
    const g = globalThis as unknown as SecureContextEnv;
    return {
        isSecureContext: g.isSecureContext,
        navigator: typeof navigator === 'undefined' ? undefined : (navigator as unknown as SecureContextEnv['navigator']),
        BroadcastChannel: g.BroadcastChannel,
        location: typeof location === 'undefined' ? undefined : location,
    };
}

/** 讀取診斷資訊（不建立任何連線） */
export function readSecureContextDiagnostics(env: SecureContextEnv = browserEnv()): SecureContextDiagnostics {
    return {
        isSecureContext: env.isSecureContext === true,
        webLocks: typeof env.navigator?.locks?.request === 'function',
        broadcastChannel: typeof env.BroadcastChannel === 'function',
        userAgent: env.navigator?.userAgent ?? '',
        buildVersion: buildVersion(),
        origin: env.location?.origin ?? '',
    };
}

/** 三項全部成立才可啟動連線與交易畫面 */
export function isMobileSecure(d: Pick<SecureContextDiagnostics, 'isSecureContext' | 'webLocks' | 'broadcastChannel'>): boolean {
    return d.isSecureContext && d.webLocks && d.broadcastChannel;
}
