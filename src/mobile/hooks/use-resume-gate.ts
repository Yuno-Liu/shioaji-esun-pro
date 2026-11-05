// src/mobile/hooks/use-resume-gate.ts — ResumeGate 的 React 綁定（規格 §7.4）
// 狀態列、下單面板、確認面板、委託操作面板以此判斷是否允許新單／改價／減量。

import { useSyncExternalStore } from 'react';
import { getResumeGate, subscribeResumeGate, type ResumeGateSnapshot } from '../lib/resume-gate-runtime';

export function useResumeGate(): ResumeGateSnapshot {
    return useSyncExternalStore(subscribeResumeGate, getResumeGate);
}
