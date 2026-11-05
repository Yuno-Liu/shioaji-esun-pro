// src/mobile/hooks/use-wake-lock.ts — 依「本裝置」設定啟停螢幕常亮（規格 Phase 3、選配）
//
// 掛在 MobileShell（secure context 才掛；Wake Lock API 本身也只在 secure context 提供）。
// 開關開啟 → startWakeLock()（頁面可見才持有、回前景重取、隱藏釋放）；關閉或卸載 → 釋放。

import { useEffect } from 'react';
import { useMobileDeviceSettings, wakeLockSupported } from '../lib/mobile-device-settings';
import { setWakeLockIdle, startWakeLock } from '../lib/wake-lock';

export function useWakeLock(): void {
    const { wakeLock } = useMobileDeviceSettings();
    useEffect(() => {
        if (!wakeLock || !wakeLockSupported()) {
            setWakeLockIdle(wakeLockSupported());
            return;
        }
        return startWakeLock();
    }, [wakeLock]);
}
