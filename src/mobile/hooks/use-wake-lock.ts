// src/mobile/hooks/use-wake-lock.ts — 依「本裝置」設定啟停螢幕常亮（規格 Phase 3、選配）
//
// 掛在 MobileShell（secure context 才掛；Wake Lock API 本身也只在 secure context 提供）。
// 開關開啟 → 動態載入 lib/wake-lock 再 startWakeLock()（頁面可見才持有、回前景重取、隱藏釋放）；關閉或卸載 → 釋放。
// - lib/wake-lock 不在首屏（§13）：開關關閉（預設）或瀏覽器不支援時不載入；帳戶頁的設定區塊另行匯入它顯示狀態
//   （同一個模組實例），不支援的說明由 wakeLockSupported() 決定，不靠狀態值。
// - 載入完成前關掉開關或卸載：不啟動。載入失敗（離線、chunk 抓不到）：這次不啟用，下次切換開關或重新掛載再試。

import { useEffect } from 'react';
import { useMobileDeviceSettings, wakeLockSupported } from '../lib/mobile-device-settings';

type WakeLockModule = typeof import('../lib/wake-lock');
/** 本 hook 載入過的模組：關閉開關時用來把狀態設回 off（沒載入過時狀態本來就是初始值） */
let loaded: WakeLockModule | null = null;
const loadWakeLock = (): Promise<WakeLockModule> => import('../lib/wake-lock').then(m => (loaded = m));

export function useWakeLock(): void {
    const { wakeLock } = useMobileDeviceSettings();
    useEffect(() => {
        if (!wakeLock || !wakeLockSupported()) {
            loaded?.setWakeLockIdle(wakeLockSupported());
            return;
        }
        let stop: (() => void) | null = null;
        let cancelled = false;
        loadWakeLock().then(m => { if (!cancelled) stop = m.startWakeLock(); }, () => undefined);
        return () => {
            cancelled = true;
            stop?.();
        };
    }, [wakeLock]);
}
