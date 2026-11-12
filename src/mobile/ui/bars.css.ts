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

/** 量條底部實心邊條的高度（像框線，用 px，不隨字級） */
export const VOLUME_EDGE = '3px';

const volumeBase = style([scaleBase, {
    transition: `transform ${DUR.bar}ms linear`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'left bottom',
    backgroundSize: `100% ${VOLUME_EDGE}`,
}]);

/**
 * 買側 origin right（由右往左長）、賣側 origin left。
 * - 填色維持單層 upDim／downDim：價格（漲跌色、numMd 一般字級）疊在量條上，深色紅字對單層買進量條 4.54:1，
 *   再加深就低於 4.5:1（§4.8）。
 * - 量的長短改由底部 VOLUME_EDGE 實心 up／down 邊條標示（2026-11-12：深色主題的淡色填色對 panel 只有約 1.1:1，
 *   看不清楚）；邊條對 panel 深色紅 5.02、綠 7.31，達圖形 3:1。列高 TOUCH_MIN、文字垂直置中，邊條不與文字重疊。
 *   邊條是同一元素的 background-image，跟著 scaleX 一起縮放。
 */
export const volume = styleVariants({
    buy: [volumeBase, { transformOrigin: 'right center', backgroundColor: vars.color.upDim, backgroundImage: `linear-gradient(${vars.color.up}, ${vars.color.up})` }],
    sell: [volumeBase, { transformOrigin: 'left center', backgroundColor: vars.color.downDim, backgroundImage: `linear-gradient(${vars.color.down}, ${vars.color.down})` }],
});

// ---- 共用軌道（RatioBar、ProgressBar） ----

/**
 * 軌道底色 muted 與深色主題卡片（groupedBg＝muted）相同（1.00:1），看不出軌道長度；
 * 加 1px mutedForeground 內框：對卡片 深色 4.92:1、淺色 5.38:1。填色是子元素，畫在內框之上。
 */
export const track = style({
    position: 'relative',
    display: 'block',
    width: '100%',
    height: '6px',
    borderRadius: '3px',
    overflow: 'hidden',
    background: vars.color.muted,
    boxShadow: `inset 0 0 0 1px ${vars.color.mutedForeground}`,
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
