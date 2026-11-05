// src/mobile/styles/layout.css.ts — 手機殼層版面：100dvh、安全區、底部分頁（規格 §5.1、§11）
import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { INPUT_FONT_SIZE, REDUCED_MOTION, SAFE_BOTTOM, SAFE_LEFT, SAFE_RIGHT, TOUCH_MIN, Z } from './metrics';

// 只由手機入口載入：不影響桌面 index.html
globalStyle('html', {
    WebkitTextSizeAdjust: '100%',
    textSizeAdjust: '100%',
});

globalStyle('body', {
    overscrollBehavior: 'none',
    WebkitTapHighlightColor: 'transparent',
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', sans-serif",
});

// iOS Safari 對字級 < 16px 的輸入欄位聚焦時會自動放大
globalStyle('input, select, textarea', {
    fontSize: INPUT_FONT_SIZE,
});

globalStyle('*, *::before, *::after', {
    '@media': {
        [REDUCED_MOTION]: {
            animationDuration: '0.01ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.01ms !important',
        },
    },
});

export const shell = style({
    display: 'flex',
    flexDirection: 'column',
    // 不用 100vh（行動瀏覽器網址列會讓 100vh 超出可視區）；不支援 dvh 時退回 100%
    height: ['100%', '100dvh'],
    width: '100%',
    overflow: 'hidden',
    background: vars.color.background,
    color: vars.color.foreground,
});

export const main = style({
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    WebkitOverflowScrolling: 'touch',
    paddingLeft: SAFE_LEFT,
    paddingRight: SAFE_RIGHT,
});

export const tabBar = style({
    position: 'sticky',
    bottom: 0,
    zIndex: Z.bars,
    flex: '0 0 auto',
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    background: vars.color.panel,
    borderTop: `1px solid ${vars.color.border}`,
    paddingBottom: SAFE_BOTTOM,
    paddingLeft: SAFE_LEFT,
    paddingRight: SAFE_RIGHT,
});

export const tab = style({
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '2px',
    minHeight: '52px',
    minWidth: TOUCH_MIN,
    color: vars.color.mutedForeground,
    textDecoration: 'none',
    fontSize: '0.75rem',
    selectors: {
        '&[aria-current="page"]': { color: vars.color.accent, fontWeight: 600 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

export const tabBadge = style({
    position: 'absolute',
    top: '4px',
    left: 'calc(50% + 6px)',
    minWidth: '18px',
    height: '18px',
    padding: '0 5px',
    borderRadius: '9px',
    background: vars.color.danger,
    color: '#ffffff',
    fontSize: '0.6875rem',
    fontWeight: 700,
    lineHeight: '18px',
    textAlign: 'center',
});

export const page = style({
    padding: `${vars.space.md} ${vars.space.md} ${vars.space.lg}`,
});

export const pageTitle = style({
    margin: `0 0 ${vars.space.sm}`,
    fontSize: '1.25rem',
    fontWeight: 700,
});

export const placeholder = style({
    margin: 0,
    color: vars.color.mutedForeground,
});
