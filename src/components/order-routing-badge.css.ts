// src/components/order-routing-badge.css.ts — fork：面板實際路由徽章（券商＋環境）
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const base = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    flexShrink: 0,
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    padding: '1px 5px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    cursor: 'default',
});

export const badge = styleVariants({
    simulation: [base],
    production: [base, { color: vars.color.danger, borderColor: vars.color.danger }],
    unknown: [base, { color: vars.color.amber, borderColor: vars.color.amber }],
});

export const diverged = style({
    color: vars.color.amber,
    fontWeight: 700,
});

export const hint = style({
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
});
