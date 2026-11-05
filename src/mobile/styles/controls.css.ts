// src/mobile/styles/controls.css.ts — 共用控制項：按鈕、買賣鍵、滑動確認、徽章（規格 §5.3、§11）
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { REDUCED_MOTION, TOUCH_MIN, TRADE_BUTTON_GAP, TRADE_BUTTON_MIN_HEIGHT } from './metrics';

const buttonBase = style({
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.md}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '1rem',
    fontWeight: 600,
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const button = styleVariants({
    neutral: [buttonBase],
    primary: [buttonBase, { background: vars.color.accent, borderColor: vars.color.accent, color: '#ffffff' }],
    danger: [buttonBase, { background: vars.color.danger, borderColor: vars.color.danger, color: '#ffffff' }],
    ghost: [buttonBase, { background: 'transparent', borderColor: 'transparent' }],
});

/** 買進／賣出兩鍵：高度 ≥ 56px、間距 ≥ 12px；買賣一律有文字，不只靠顏色 */
export const tradeButtonRow = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: TRADE_BUTTON_GAP,
});

const tradeButtonBase = style([buttonBase, {
    minHeight: TRADE_BUTTON_MIN_HEIGHT,
    fontSize: '1.125rem',
    fontWeight: 700,
    color: '#ffffff',
    border: 'none',
}]);

export const tradeButton = styleVariants({
    buy: [tradeButtonBase, { background: vars.color.up }],
    sell: [tradeButtonBase, { background: vars.color.down }],
});

// ---- 滑動確認（slide-to-confirm.tsx）----

export const slideWrap = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
});

export const slideTrack = style({
    position: 'relative',
    height: TRADE_BUTTON_MIN_HEIGHT,
    borderRadius: '28px',
    background: vars.color.muted,
    border: `1px solid ${vars.color.borderBright}`,
    overflow: 'hidden',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'none',
    selectors: {
        '&[data-disabled="true"]': { opacity: 0.5 },
    },
});

export const slideFill = styleVariants({
    neutral: { background: vars.color.accentDim },
    buy: { background: vars.color.upDim },
    sell: { background: vars.color.downDim },
    danger: { background: vars.color.dangerDim },
});

export const slideFillBase = style({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    pointerEvents: 'none',
});

export const slideLabel = style({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: `0 ${TRADE_BUTTON_MIN_HEIGHT}`,
    fontSize: '1rem',
    fontWeight: 600,
    color: vars.color.foreground,
    pointerEvents: 'none',
    textAlign: 'center',
});

const slideHandleBase = style({
    position: 'absolute',
    top: '3px',
    left: '3px',
    width: '48px',
    height: '48px',
    borderRadius: '24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#ffffff',
    fontSize: '1.25rem',
    fontWeight: 700,
    cursor: 'grab',
    touchAction: 'none',
    transition: 'left 180ms ease-out',
    selectors: {
        '&[data-dragging="true"]': { transition: 'none' },
        '&:focus-visible': { outline: `2px solid ${vars.color.foreground}`, outlineOffset: '2px' },
    },
    '@media': { [REDUCED_MOTION]: { transition: 'none' } },
});

export const slideHandle = styleVariants({
    neutral: [slideHandleBase, { background: vars.color.accent }],
    buy: [slideHandleBase, { background: vars.color.up }],
    sell: [slideHandleBase, { background: vars.color.down }],
    danger: [slideHandleBase, { background: vars.color.danger }],
});

export const slideHint = style({
    margin: 0,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
});

export const slideDisabledReason = style({
    margin: 0,
    fontSize: '0.8125rem',
    color: vars.color.amber,
});

// ---- 送單路由徽章（route-badge.tsx）----

const routeBadgeBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: vars.radius.md,
    fontSize: '0.8125rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    border: '1px solid',
});

export const routeBadge = styleVariants({
    /** 正式：醒目的 danger 色框 */
    production: [routeBadgeBase, { borderColor: vars.color.danger, color: vars.color.danger, background: vars.color.dangerDim }],
    /** 模擬：accent 色 */
    simulation: [routeBadgeBase, { borderColor: vars.color.accent, color: vars.color.accent, background: vars.color.accentDim }],
    /** 環境未確認 */
    unknown: [routeBadgeBase, { borderColor: vars.color.amber, color: vars.color.amber, background: 'transparent' }],
});

export const routeBadgeLarge = style({
    fontSize: '1.0625rem',
    padding: '4px 12px',
});
