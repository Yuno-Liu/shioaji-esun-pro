// src/mobile/lib/fill-audio.ts — 手機成交音效播放器（含 iOS 手勢解鎖）
//
// 為什麼不直接呼叫 src/lib/sounds.ts 的 playDeal()：
// - iOS／iPadOS Safari 的 AudioContext 必須在使用者手勢（touchend／click 等）內 resume，之後才會出聲。
// - sounds.ts 的 AudioContext 是模組私有、在第一次播放時才惰性建立，沒有「不出聲解鎖」的入口；
//   在手勢內呼叫它的任何 play*() 都會真的發出聲音。在不修改 src/lib 的前提下無法於手勢內解鎖那個 context。
// 因此這裡實作同音色的小型播放器（與 playDeal 相同：880 Hz 0.12 秒＋0.09 秒後 1320 Hz 0.18 秒，sine、音量 0.12），
// 開關沿用 sounds.ts 的 soundEnabled()（localStorage 'sj-pro-sound'，與桌面共用同一個開關）。
//
// 解鎖：第一次 pointerdown／touchend／click 時（capture、passive）建立 context、resume，並播放 1 個 sample 的靜音 buffer
// （舊版 iOS 需要在手勢內「開始播放」才算解鎖），不發出聲音；context 進入 running 後移除監聽。
// 回前景時 iOS 可能把 context 改成 suspended／interrupted：播放時發現不是 running 就嘗試 resume 並重新掛上解鎖監聽。
// context 不是 running 時不排程音效（審查 M-PLAT-5）：suspended 的 currentTime 凍結，已排程的 oscillator 會在之後
// 某次無關的觸控解鎖時才補響，使用者會誤以為那時才成交。只有 resume 在 RESUME_GRACE_MS 內完成（例如「試聽」
// 在同一次點擊內先解鎖再播放）才補播；逾時就直接略過這一聲。
// 監聽只掛一次（armFillAudioUnlock 冪等）。頁面隱藏時不播。

import { soundEnabled } from '../../lib/sounds';

type AudioCtor = new () => AudioContext;

const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'click'] as const;
const LISTEN_OPTS: AddEventListenerOptions = { capture: true, passive: true };
/** 播放時 context 不是 running：resume 在這段時間內完成才補播，否則略過（避免之後解鎖時補響） */
export const RESUME_GRACE_MS = 1_000;

let ctx: AudioContext | null = null;
let armedTarget: EventTarget | null = null;

function audioCtor(): AudioCtor | null {
    const g = globalThis as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
    return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function ensureContext(): AudioContext | null {
    if (ctx) return ctx;
    const Ctor = audioCtor();
    if (!Ctor) return null;
    try {
        ctx = new Ctor();
    } catch {
        ctx = null;
    }
    return ctx;
}

function isRunning(ac: AudioContext | null): boolean {
    return !!ac && ac.state === 'running';
}

function pageHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function onGesture(): void {
    unlockFillAudio();
}

function disarm(): void {
    const target = armedTarget;
    if (!target) return;
    armedTarget = null;
    for (const type of UNLOCK_EVENTS) target.removeEventListener(type, onGesture, LISTEN_OPTS);
}

/**
 * 在使用者手勢內呼叫：建立／resume AudioContext 並播放靜音 buffer，不發出聲音。
 * 音效關閉時不建立 context（之後在設定區打開開關時會在該手勢內再呼叫一次）。
 * 回傳 context 目前是否已是 running。
 */
export function unlockFillAudio(): boolean {
    if (!soundEnabled()) return false;
    const ac = ensureContext();
    if (!ac) return false;
    try {
        if (ac.state !== 'running') {
            void ac.resume().then(() => { if (isRunning(ac)) disarm(); }, () => undefined);
        }
        const buffer = ac.createBuffer(1, 1, 22050);
        const src = ac.createBufferSource();
        src.buffer = buffer;
        src.connect(ac.destination);
        src.start(0);
    } catch {
        // 解鎖失敗：保留監聽，下一次手勢再試
    }
    if (isRunning(ac)) disarm();
    return isRunning(ac);
}

/**
 * 掛上一次性的手勢解鎖監聽（冪等：已掛上就不重複掛）。回傳移除函式。
 * target 預設為 window（測試可注入）。
 */
export function armFillAudioUnlock(target: EventTarget | undefined = typeof window === 'undefined' ? undefined : window): () => void {
    if (!target) return () => undefined;
    if (armedTarget) return disarm;
    if (isRunning(ctx)) return () => undefined;
    armedTarget = target;
    for (const type of UNLOCK_EVENTS) target.addEventListener(type, onGesture, LISTEN_OPTS);
    return disarm;
}

function tone(ac: AudioContext, freq: number, startAt: number, duration: number, volume = 0.12): void {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t0 = ac.currentTime + startAt;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
}

function now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function playChime(ac: AudioContext): void {
    tone(ac, 880, 0, 0.12);
    tone(ac, 1320, 0.09, 0.18);
}

/**
 * 成交音效（與桌面 playDeal 同音色）。音效關閉、頁面隱藏或沒有 Web Audio 時不播。
 * context 不是 running（iOS 未有手勢、回前景後被暫停）時不排程：嘗試 resume 並重新掛上解鎖監聽，
 * resume 在 RESUME_GRACE_MS 內完成才補播，否則這一聲略過（不會在之後解鎖時補響）。
 * 回傳是否已立即排程音訊（非 running 時回傳 false）。
 */
export function playFillSound(): boolean {
    if (!soundEnabled() || pageHidden()) return false;
    const ac = ensureContext();
    if (!ac) return false;
    try {
        if (ac.state !== 'running') {
            const requestedAt = now();
            void ac.resume().then(() => {
                if (!isRunning(ac) || pageHidden() || !soundEnabled()) return;
                if (now() - requestedAt > RESUME_GRACE_MS) return;
                try {
                    playChime(ac);
                } catch {
                    // 補播失敗：略過這一聲
                }
            }, () => undefined);
            armFillAudioUnlock();
            return false;
        }
        playChime(ac);
        return true;
    } catch {
        return false;
    }
}

/** 測試用：丟掉 context 並移除監聽 */
export function resetFillAudioForTest(): void {
    disarm();
    ctx = null;
}
