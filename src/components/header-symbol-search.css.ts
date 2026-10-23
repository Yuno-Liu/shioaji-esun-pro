// src/components/header-symbol-search.css.ts — 頂欄常駐快速商品搜尋框與下拉建議清單

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const HEADER_ITEM_H = '25px';

export const wrap = style({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    height: HEADER_ITEM_H,
    flexShrink: 0,
});

export const inputShell = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: HEADER_ITEM_H,
    boxSizing: 'border-box',
    padding: '0 8px',
    width: '13.5rem',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.inset,
    color: vars.color.foreground,
    transition: 'border-color 0.12s, width 0.15s, box-shadow 0.12s',
    selectors: {
        '&:hover': {
            borderColor: vars.color.borderBright,
        },
        '&:focus-within': {
            borderColor: vars.color.accent,
            boxShadow: `0 0 0 1px ${vars.color.accentDim}`,
            width: '16rem',
        },
    },
    '@media': {
        '(max-width: 1200px)': {
            width: '10.5rem',
            selectors: {
                '&:focus-within': {
                    width: '13rem',
                },
            },
        },
    },
});

export const searchIcon = style({
    color: vars.color.mutedForeground,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
});

export const input = style({
    flex: 1,
    minWidth: 0,
    height: '100%',
    padding: 0,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    '::placeholder': {
        color: vars.color.mutedForeground,
        fontWeight: 400,
    },
});

export const kbdBadge = style({
    fontFamily: vars.font.mono,
    fontSize: '0.58rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: '3px',
    padding: '0 4px',
    lineHeight: '15px',
    height: '15px',
    flexShrink: 0,
    userSelect: 'none',
    pointerEvents: 'none',
});

export const clearBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    padding: 0,
    border: 'none',
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': {
        color: vars.color.foreground,
        background: vars.color.muted,
    },
});

export const dropdown = style({
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: 0,
    zIndex: 230,
    width: '22rem',
    maxWidth: 'calc(100vw - 24px)',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 14px 36px rgba(0, 0, 0, 0.45)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
});

export const sectionHeader = style({
    padding: `5px ${vars.space.sm}`,
    fontSize: '0.62rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
});

export const list = style({
    maxHeight: '18rem',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
});

const rowBase = {
    display: 'grid',
    gridTemplateColumns: '4.4rem minmax(0, 1fr) auto auto',
    alignItems: 'center',
    columnGap: vars.space.xs,
    padding: `6px ${vars.space.sm}`,
    cursor: 'pointer',
    color: vars.color.foreground,
    fontSize: '0.74rem',
    borderBottom: `1px solid ${vars.color.border}`,
    transition: 'background 0.1s',
};

export const row = style({
    ...rowBase,
    background: 'transparent',
    ':hover': {
        background: vars.color.muted,
    },
});

export const rowActive = style({
    ...rowBase,
    background: vars.color.accentDim,
});

export const code = style({
    fontFamily: vars.font.mono,
    fontWeight: 700,
    fontSize: '0.74rem',
    color: vars.color.foreground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const name = style({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.74rem',
    color: vars.color.foreground,
});

export const detail = style({
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    padding: '0 4px',
});

export const linkedTag = style({
    fontFamily: vars.font.display,
    fontSize: '0.58rem',
    fontWeight: 600,
    color: vars.color.accent,
    background: vars.color.accentDim,
    border: `1px solid ${vars.color.accent}`,
    borderRadius: vars.radius.sm,
    padding: '0 4px',
    lineHeight: '16px',
    whiteSpace: 'nowrap',
});

export const watchBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 6px',
    height: '20px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'all 0.12s',
    ':hover': {
        color: vars.color.accent,
        borderColor: vars.color.accent,
        background: vars.color.accentDim,
    },
    ':disabled': {
        opacity: 0.55,
        cursor: 'default',
    },
});

export const watchedTag = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    padding: '1px 5px',
    whiteSpace: 'nowrap',
});

export const statusRow = style({
    padding: `${vars.space.sm} ${vars.space.md}`,
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
});

export const errorRow = style({
    padding: `6px ${vars.space.sm}`,
    fontSize: '0.68rem',
    color: vars.color.danger,
    borderTop: `1px solid ${vars.color.border}`,
    background: vars.color.dangerDim,
});

export const footer = style({
    padding: `4px ${vars.space.sm}`,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    background: vars.color.panel,
    borderTop: `1px solid ${vars.color.border}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: vars.space.xs,
    whiteSpace: 'nowrap',
});
