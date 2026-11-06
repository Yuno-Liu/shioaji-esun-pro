// src/mobile/motion/haptics.ts — 介面觸覺回饋（設計規格 §5.3）
//
// - threshold（滑塊越過門檻）8ms、longPress（長按成立）8ms、bound（步進撞界、不可關閉輕彈）12ms。
// - 只在 ui-settings 的 uiHaptics 為真且 vibrationSupported()（沿用 mobile-device-settings）時呼叫；例外一律吞掉。
// - iOS 一律不執行（也不使用隱藏 switch 觸發觸覺的技巧）。成交震動沿用 vibrateOnFill，不在這裡。

import { vibrationSupported } from '../lib/mobile-device-settings';
import { getMobileUiSettings, isIOSWebKit } from '../lib/ui-settings';

export type HapticKind = 'threshold' | 'longPress' | 'bound';

export const HAPTIC_MS: Readonly<Record<HapticKind, number>> = Object.freeze({ threshold: 8, longPress: 8, bound: 12 });

type VibrateNav = { vibrate?: unknown } | undefined;

/** 回傳是否有呼叫 navigator.vibrate */
export function haptic(kind: HapticKind, n: VibrateNav = typeof navigator === 'undefined' ? undefined : (navigator as unknown as VibrateNav)): boolean {
    try {
        if (isIOSWebKit() || !getMobileUiSettings().uiHaptics || !vibrationSupported(n)) return false;
        (n as { vibrate: (ms: number) => boolean }).vibrate(HAPTIC_MS[kind]);
        return true;
    } catch {
        return false;
    }
}
