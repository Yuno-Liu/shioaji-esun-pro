// src/mobile/ui/bars.tsx — VolumeBar／RatioBar／ProgressBar（設計規格 §6.12）
//
// 數值寫在 React style.transform（非手勢，scaleX），不再用 width／left 轉場。
// 純視覺：一律 aria-hidden；數值文字由呼叫端放在旁邊（不只靠顏色與長度）。

import type { CSSProperties } from 'react';
import * as styles from './bars.css';
import type { BarTone } from './bars.css';

export type { BarTone };

/** 0–1 之間、最多 4 位小數（0.5 → 'scaleX(0.5)'）；非有限數視為 0 */
export function scaleXOf(ratio: number): string {
    const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
    return `scaleX(${Math.round(r * 10000) / 10000})`;
}

const styleOf = (ratio: number): CSSProperties => ({ transform: scaleXOf(ratio) });

// ---- VolumeBar ----

export interface VolumeBarProps {
    /** 本檔量 */
    value: number;
    /** 五檔最大量 */
    max: number;
    side: 'buy' | 'sell';
}

/** 五檔每格背景量條：scaleX(量 ÷ 五檔最大量)；放在 position: relative 的格內 */
export function VolumeBar({ value, max, side }: VolumeBarProps) {
    const ratio = max > 0 ? value / max : 0;
    return <span className={styles.volume[side]} style={styleOf(ratio)} aria-hidden='true' />;
}

// ---- RatioBar ----

export interface RatioBarProps {
    /** 左段百分比（0–100） */
    left: number;
    /** 右段百分比（0–100） */
    right: number;
    leftTone: BarTone;
    rightTone: BarTone;
    testId?: string;
}

/** 比例條：左段 scaleX(L/100) origin left、右段 scaleX(R/100) origin right；百分比文字由呼叫端放在旁邊 */
export function RatioBar({ left, right, leftTone, rightTone, testId }: RatioBarProps) {
    return (
        <span className={styles.track} aria-hidden='true' data-testid={testId}>
            <span className={styles.fillLeft[leftTone]} style={styleOf(left / 100)} />
            <span className={styles.fillRight[rightTone]} style={styleOf(right / 100)} />
        </span>
    );
}

// ---- ProgressBar ----

export interface ProgressBarProps {
    /** 百分比（0–100） */
    percent: number;
    tone?: BarTone;
    /** 由哪一側長出（預設 left） */
    origin?: 'left' | 'right';
    testId?: string;
}

/** 進度條（委託成交進度、持倉損益條）：軌道 aria-hidden，唯一帶 style 的節點是填色（scaleX） */
export function ProgressBar({ percent, tone = 'accent', origin = 'left', testId }: ProgressBarProps) {
    const fill = origin === 'right' ? styles.fillRight[tone] : styles.fillLeft[tone];
    return (
        <span className={styles.track} aria-hidden='true' data-testid={testId}>
            <span className={fill} style={styleOf(percent / 100)} />
        </span>
    );
}
