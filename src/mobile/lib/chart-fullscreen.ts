// src/mobile/lib/chart-fullscreen.ts — 橫向全螢幕圖表的判斷（規格 Phase 2「橫向全螢幕圖表」）
//
// - 手機轉橫向時自動以 CSS 覆蓋全畫面（iPhone Safari 不支援元素 Fullscreen API）；也可按「全螢幕」手動進入。
// - 只有「手機」轉橫向才自動進入：平板、桌機本來就常是橫向，強制全螢幕會擋住整個交易頁。
// - 方向優先看裝置方向（screen.orientation／window.orientation），最後才看視窗比例：
//   Android 叫出鍵盤時視窗變矮，(orientation: landscape) 會誤判成橫向。

/** 短邊小於這個值（CSS px）才算手機 */
export const PHONE_SHORT_SIDE_MAX = 600;
export const LANDSCAPE_QUERY = '(orientation: landscape)';

export interface OrientationEnv {
    screen?: { width?: number; height?: number; orientation?: { type?: string } };
    orientation?: unknown;
    innerWidth?: number;
    innerHeight?: number;
    matchMedia?: (q: string) => { matches: boolean };
}

/** 目前是否為橫向（裝置方向優先，退回 matchMedia，再退回視窗比例） */
export function isLandscape(env: OrientationEnv): boolean {
    const type = env.screen?.orientation?.type;
    if (typeof type === 'string' && type) return type.startsWith('landscape');
    if (typeof env.orientation === 'number') return Math.abs(env.orientation) === 90;
    try {
        if (typeof env.matchMedia === 'function') return env.matchMedia(LANDSCAPE_QUERY).matches;
    } catch {
        // 舊瀏覽器
    }
    return (env.innerWidth ?? 0) > (env.innerHeight ?? 0);
}

/** 是否為手機尺寸（螢幕短邊） */
export function isPhoneSized(env: OrientationEnv): boolean {
    const w = env.screen?.width ?? env.innerWidth ?? 0;
    const h = env.screen?.height ?? env.innerHeight ?? 0;
    const short = Math.min(w, h);
    return short > 0 && short < PHONE_SHORT_SIDE_MAX;
}

/** 手機轉橫向時自動全螢幕 */
export function shouldAutoFullscreen(env: OrientationEnv | undefined): boolean {
    if (!env) return false;
    return isPhoneSized(env) && isLandscape(env);
}

export function currentOrientationEnv(): OrientationEnv | undefined {
    return typeof window === 'undefined' ? undefined : (window as unknown as OrientationEnv);
}
