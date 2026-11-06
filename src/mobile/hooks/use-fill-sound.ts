// src/mobile/hooks/use-fill-sound.ts — 成交回饋：音效＋（選配）震動（規格 §2.1、§5.5、Phase 2）
//
// 比照桌面 src/components/event-toasts.tsx:61：onOrderEvent 的報告經 describeOrderReport 判定為成交（deal）時播放。
// 只對成交出聲／震動（委託回報、錯誤不出聲，避免手機上過度打擾）。頁面隱藏時兩者都不觸發。
// 掛在 MobileShell（secure context 才掛）；音效開關沿用 sounds.ts，震動開關在 lib/mobile-device-settings。
// 成交震動只由這裡觸發（toast-host 已不再自行震動），所以帳戶頁的震動開關可以完全關掉震動。

import { useEffect } from 'react';
import { describeOrderReport, type OrderEventReport } from '../../lib/order-report';
import { onOrderEvent } from '../../lib/stream';
import { armFillAudioUnlock, playFillSound } from '../lib/fill-audio';
import { vibrateOnFill } from '../lib/mobile-device-settings';

function pageVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/** 單一回報的回饋：成交且頁面可見 → 音效（開關由 sounds.ts 決定）＋震動（開關由本裝置設定決定） */
export function fillFeedback(ev: OrderEventReport): { sound: boolean; vibrate: boolean } {
    if (!pageVisible() || describeOrderReport(ev).kind !== 'deal') return { sound: false, vibrate: false };
    return { sound: playFillSound(), vibrate: vibrateOnFill() };
}

export function useFillSound(): void {
    useEffect(() => {
        const disarm = armFillAudioUnlock();
        const off = onOrderEvent((ev) => { fillFeedback(ev); });
        return () => {
            off();
            disarm();
        };
    }, []);
}
