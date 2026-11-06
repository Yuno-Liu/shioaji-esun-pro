// src/mobile/ui/inline-note.css.ts — 就地說明（設計規格 §6.11、§4.8 規則 4）
// islandBg、左側 3px tone 條、圖示（TriangleAlert／CircleX／Info）、foreground 文字、可選動作鍵（≥44px）。
// amber 只用於圖示與左側條（淺色 amber 對白只有 3.44），小字一律 foreground。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from '../styles/theme-vars.css';
import { MORE_CONTRAST, RADIUS, SPACE, TOUCH_MIN } from '../styles/tokens';
import { TEXT } from '../styles/typography.css';

const TONE = { warn: vars.color.amber, danger: vars.color.danger, info: vars.color.accent } as const;

const noteBase = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: SPACE.s2,
    minWidth: 0,
    padding: `${SPACE.s2} ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    color: vars.color.foreground,
    ...TEXT.subhead,
});

export const note = styleVariants(TONE, color => [noteBase, {
    // 左側 3px 條用 inset 陰影（不佔版面、不動畫）
    boxShadow: `inset 3px 0 0 ${color}`,
    '@media': {
        [MORE_CONTRAST]: { boxShadow: `inset 3px 0 0 ${color}, inset 0 0 0 1px ${vars.color.borderBright}` },
    },
}]);

export const icon = styleVariants(TONE, color => ({
    flex: '0 0 auto',
    width: '1rem',
    height: '1rem',
    marginTop: '0.125rem',
    color,
}));

export const content = style({
    flex: '1 1 auto',
    minWidth: 0,
    alignSelf: 'center',
});

export const action = style({
    flex: '0 0 auto',
    alignSelf: 'center',
    minHeight: TOUCH_MIN,
    margin: `-${SPACE.s2} -${SPACE.s1} -${SPACE.s2} 0`,
    padding: `0 ${SPACE.s2}`,
    border: 'none',
    borderRadius: RADIUS.md,
    background: 'transparent',
    color: vars.color.accent,
    ...TEXT.callout,
    fontWeight: 600,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
});
