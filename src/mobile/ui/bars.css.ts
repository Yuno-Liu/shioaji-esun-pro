// src/mobile/ui/bars.css.ts — 量條、比例條、進度條（設計規格 §6.12）
// 只動畫 transform（scaleX）：取代 trade.css.ts／orders.css.ts／account.css.ts 的 width 轉場。
// 減少動態由 layout.css.ts 全域規則取消轉場，這裡再明確關閉一次。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { DUR, EASE, REDUCED_MOTION } from '../styles/tokens';

const scaleBase = style({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: '100%',
    pointerEvents: 'none',
    '@media': {
        [REDUCED_MOTION]: { transition: 'none' },
    },
});

// ---- VolumeBar（五檔每格背景量條） ----

const volumeBase = style([scaleBase, {
    transition: `transform ${DUR.bar}ms linear`,
}]);

/** 買側 origin right（由右往左長）、賣側 origin left；upDim／downDim 淡色 */
export const volume = styleVariants({
    buy: [volumeBase, { transformOrigin: 'right center', background: vars.color.upDim }],
    sell: [volumeBase, { transformOrigin: 'left center', background: vars.color.downDim }],
});

// ---- 共用軌道（RatioBar、ProgressBar） ----

export const track = style({
    position: 'relative',
    display: 'block',
    width: '100%',
    height: '6px',
    borderRadius: '3px',
    overflow: 'hidden',
    background: vars.color.muted,
});

const fillBase = style([scaleBase, {
    transition: `transform 200ms ${EASE.out}`,
}]);

export type BarTone = 'up' | 'down' | 'accent' | 'success' | 'amber' | 'danger' | 'flat';

const TONE_COLOR: Record<BarTone, string> = {
    up: vars.color.up,
    down: vars.color.down,
    accent: vars.color.accent,
    success: vars.color.success,
    amber: vars.color.amber,
    danger: vars.color.danger,
    flat: vars.color.flat,
};

export const fillLeft = styleVariants(TONE_COLOR, color => [fillBase, { transformOrigin: 'left center', background: color }]);
export const fillRight = styleVariants(TONE_COLOR, color => [fillBase, { transformOrigin: 'right center', background: color }]);
