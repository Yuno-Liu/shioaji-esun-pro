// src/mobile/ui/empty-state.css.ts — 空狀態（設計規格 §6.13）
// 40px 線條圖示（mutedForeground）＋標題＋subhead 說明＋一個主要動作。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { RADIUS, SPACE, TOUCH_MIN } from '../styles/tokens';
import { TEXT } from '../styles/typography.css';

export const root = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: SPACE.s2,
    padding: `${SPACE.s8} ${SPACE.s4}`,
    textAlign: 'center',
    minWidth: 0,
});

export const icon = style({
    width: '40px',
    height: '40px',
    color: vars.color.mutedForeground,
    marginBottom: SPACE.s1,
});

export const title = style({
    margin: 0,
    ...TEXT.headline,
    color: vars.color.foreground,
});

export const description = style({
    margin: 0,
    maxWidth: '22rem',
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

export const action = style({
    marginTop: SPACE.s2,
    minHeight: TOUCH_MIN,
    padding: `0 ${SPACE.s5}`,
    borderRadius: RADIUS.lg,
    border: 'none',
    ...TEXT.callout,
    fontWeight: 600,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
});
