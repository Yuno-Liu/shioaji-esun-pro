// src/mobile/styles/resume-gate-note.css.ts — ResumeGate stale-data 說明（勾選了解＋重試同步；規格 §7.4、設計規格 §6.11）
// InlineNote 外觀：islandBg、左側 3px amber 條、TriangleAlert 圖示；文字一律 foreground（§4.8 規則 4：amber 不當小字顏色）。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from './theme-vars.css';
import { RADIUS, SPACE, TOUCH_MIN } from './tokens';
import { TEXT } from './typography.css';

export const box = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1,
    margin: `0 0 ${SPACE.s2}`,
    padding: `${SPACE.s2} ${SPACE.s3} ${SPACE.s2} ${SPACE.s4}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    boxShadow: `inset 3px 0 0 ${vars.color.amber}`,
    color: vars.color.foreground,
    fontSize: TEXT.callout.fontSize,
});

export const reason = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: SPACE.s2,
    margin: 0,
    color: vars.color.foreground,
    lineHeight: 1.5,
});

export const icon = style({
    flex: '0 0 auto',
    marginTop: '0.125em',
    color: vars.color.amber,
});

export const actions = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACE.s2,
});

export const checkboxLabel = style({
    flex: '1 1 auto',
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
    fontSize: TEXT.body.fontSize,
    color: vars.color.foreground,
});

export const checkbox = style({
    width: '22px',
    height: '22px',
    flex: '0 0 auto',
    accentColor: vars.color.accent,
});
