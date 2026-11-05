// src/mobile/styles/sheet.css.ts — 共用底部面板（bottom-sheet.tsx）
import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { REDUCED_MOTION, SAFE_BOTTOM, SAFE_LEFT, SAFE_RIGHT, TOUCH_MIN, Z } from './metrics';

const fadeIn = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const slideUp = keyframes({ from: { transform: 'translateY(100%)' }, to: { transform: 'translateY(0)' } });

export const backdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: Z.sheet,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.5)',
    animation: `${fadeIn} 160ms ease-out`,
    '@media': { [REDUCED_MOTION]: { animation: 'none' } },
});

export const backdropConfirm = style({ zIndex: Z.confirm });

export const panel = style({
    position: 'relative',
    width: '100%',
    maxWidth: '640px',
    maxHeight: 'calc(100% - 24px)',
    display: 'flex',
    flexDirection: 'column',
    background: vars.color.panel,
    color: vars.color.foreground,
    borderTopLeftRadius: '14px',
    borderTopRightRadius: '14px',
    borderTop: `1px solid ${vars.color.borderBright}`,
    boxShadow: '0 -8px 24px rgba(0, 0, 0, 0.35)',
    paddingBottom: SAFE_BOTTOM,
    paddingLeft: SAFE_LEFT,
    paddingRight: SAFE_RIGHT,
    animation: `${slideUp} 200ms ease-out`,
    touchAction: 'pan-y',
    '@media': { [REDUCED_MOTION]: { animation: 'none' } },
});

/**
 * 買賣方向著色（bottom-sheet.tsx 的 tone）：在 panel 底色上疊兩層方向淡色（upDim／downDim 本身是半透明 rgba），
 * 不用 color-mix()，iOS 15.4 Safari 也能顯示；四種主題（深淺色 × 台灣／國際配色）都跟著 vars 走。
 * 頂框加粗成方向色，色弱或強光下仍有形狀線索；文字另由面板內的大字方向說明（不只靠顏色）。
 * 必須定義在 panel 之後：同權重時後者的 background-image 蓋過 panel 的 background 簡寫。
 */
const toneBase = style({ borderTopWidth: '4px', borderTopStyle: 'solid' });
export const panelTone = styleVariants({
    buy: [toneBase, {
        backgroundImage: `linear-gradient(${vars.color.upDim}, ${vars.color.upDim}), linear-gradient(${vars.color.upDim}, ${vars.color.upDim})`,
        borderTopColor: vars.color.up,
    }],
    sell: [toneBase, {
        backgroundImage: `linear-gradient(${vars.color.downDim}, ${vars.color.downDim}), linear-gradient(${vars.color.downDim}, ${vars.color.downDim})`,
        borderTopColor: vars.color.down,
    }],
});

/** 拖曳區（把手＋標題）：在這裡往下滑關閉；touch-action none 避免與頁面捲動衝突 */
export const grabArea = style({
    flex: '0 0 auto',
    touchAction: 'none',
    cursor: 'grab',
    paddingTop: '8px',
});

export const handle = style({
    width: '40px',
    height: '5px',
    margin: '0 auto 4px',
    borderRadius: '3px',
    background: vars.color.borderBright,
});

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    minHeight: TOUCH_MIN,
    padding: `0 ${vars.space.md}`,
});

export const title = style({
    flex: '1 1 auto',
    margin: 0,
    fontSize: '1.0625rem',
    fontWeight: 700,
});

export const closeButton = style({
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: '1rem',
});

export const body = style({
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    padding: `0 ${vars.space.md} ${vars.space.md}`,
    overscrollBehavior: 'contain',
});
