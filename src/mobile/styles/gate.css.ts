// src/mobile/styles/gate.css.ts — 「需要 HTTPS」說明頁（規格 R1）
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { SAFE_BOTTOM, SAFE_LEFT, SAFE_RIGHT, SAFE_TOP } from './metrics';

export const page = style({
    height: ['100%', '100dvh'],
    overflowY: 'auto',
    padding: `calc(${SAFE_TOP} + 24px) calc(${SAFE_RIGHT} + 16px) calc(${SAFE_BOTTOM} + 24px) calc(${SAFE_LEFT} + 16px)`,
    background: vars.color.background,
    color: vars.color.foreground,
    lineHeight: 1.6,
});

export const title = style({
    margin: `0 0 ${vars.space.md}`,
    fontSize: '1.5rem',
    fontWeight: 700,
    color: vars.color.danger,
});

export const section = style({ marginBottom: vars.space.lg });
export const heading = style({ margin: `0 0 ${vars.space.sm}`, fontSize: '1.0625rem', fontWeight: 700 });
export const text = style({ margin: `0 0 ${vars.space.sm}` });
export const list = style({ margin: 0, paddingLeft: '1.25rem' });
export const code = style({ fontFamily: vars.font.mono, fontSize: '0.875rem', wordBreak: 'break-all' });

export const diag = style({
    margin: 0,
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: `${vars.space.xs} ${vars.space.md}`,
    padding: vars.space.md,
    borderRadius: vars.radius.lg,
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    fontSize: '0.875rem',
});

export const term = style({ color: vars.color.mutedForeground });
export const value = style({ margin: 0, fontFamily: vars.font.mono, wordBreak: 'break-all' });
export const flag = styleVariants({
    ok: { color: vars.color.success, fontWeight: 700 },
    bad: { color: vars.color.danger, fontWeight: 700 },
});
