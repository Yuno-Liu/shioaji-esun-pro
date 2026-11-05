// src/mobile/styles/resume-gate-note.css.ts — ResumeGate stale-data 說明（勾選了解＋重試同步；規格 §7.4）
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { TOUCH_MIN } from './metrics';

export const box = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
    margin: `0 0 ${vars.space.sm}`,
    padding: `${vars.space.sm} ${vars.space.md}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.amber}`,
    fontSize: '0.875rem',
});

export const reason = style({
    margin: 0,
    color: vars.color.amber,
    lineHeight: 1.5,
});

export const actions = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: vars.space.sm,
});

export const checkboxLabel = style({
    flex: '1 1 auto',
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    minHeight: TOUCH_MIN,
    fontSize: '0.9375rem',
    color: vars.color.foreground,
});

export const checkbox = style({
    width: '22px',
    height: '22px',
    flex: '0 0 auto',
});
