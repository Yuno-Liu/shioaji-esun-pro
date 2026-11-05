// src/mobile/styles/positions.css.ts — 持倉頁與平倉／加碼說明面板（規格 §6.6、§11）
// 顏色一律用 src/theme.css.ts 的 vars；多空與損益用 up／down，並一律附文字（多／空、正負號）。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { INPUT_FONT_SIZE, TOUCH_MIN } from './metrics';

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    marginBottom: vars.space.sm,
});

export const headerTitle = style({
    flex: '1 1 auto',
    margin: 0,
    fontSize: '1.25rem',
    fontWeight: 700,
});

export const accountSelect = style({
    minHeight: TOUCH_MIN,
    maxWidth: '55%',
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
});

export const refreshButton = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.lg,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '1.125rem',
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const banner = styleVariants({
    warn: {
        margin: `0 0 ${vars.space.sm}`,
        padding: `${vars.space.sm} ${vars.space.md}`,
        borderRadius: vars.radius.lg,
        border: `1px solid ${vars.color.amber}`,
        color: vars.color.amber,
        fontSize: '0.875rem',
    },
    info: {
        margin: `0 0 ${vars.space.sm}`,
        padding: `${vars.space.sm} ${vars.space.md}`,
        borderRadius: vars.radius.lg,
        border: `1px solid ${vars.color.border}`,
        color: vars.color.mutedForeground,
        fontSize: '0.875rem',
    },
});

export const summary = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: vars.space.xs,
    margin: `0 0 ${vars.space.sm}`,
    padding: vars.space.md,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    fontSize: '0.9375rem',
});

export const summaryValue = style({
    fontSize: '1.25rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
});

export const estimate = style({
    color: vars.color.mutedForeground,
    fontSize: '0.8125rem',
});

export const tone = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.flat },
});

export const list = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
});

export const row = style({
    padding: vars.space.md,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
});

export const rowHead = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: vars.space.sm,
    rowGap: vars.space.xs,
    fontSize: '1rem',
});

export const rowCode = style({
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
});

export const rowName = style({
    color: vars.color.mutedForeground,
});

export const tag = style({
    padding: '1px 6px',
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.border}`,
    fontSize: '0.8125rem',
});

export const side = styleVariants({
    long: { fontWeight: 700, color: vars.color.up },
    short: { fontWeight: 700, color: vars.color.down },
});

export const rowMeta = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: vars.space.xs,
    marginTop: vars.space.xs,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
});

export const rowNums = style({
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: vars.space.md,
    rowGap: vars.space.xs,
    marginTop: vars.space.xs,
    fontSize: '0.9375rem',
    fontVariantNumeric: 'tabular-nums',
});

export const numLabel = style({
    color: vars.color.mutedForeground,
    marginRight: '4px',
});

export const rowActions = style({
    display: 'flex',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: vars.space.sm,
    marginTop: vars.space.sm,
});

export const rowNote = style({
    margin: `${vars.space.xs} 0 0`,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
    textAlign: 'right',
});

export const empty = style({
    margin: `${vars.space.lg} 0`,
    textAlign: 'center',
    color: vars.color.mutedForeground,
});

// ---- 說明面板（平倉、加碼切換帳戶）----

export const sheetText = style({
    margin: `0 0 ${vars.space.sm}`,
    fontSize: '0.9375rem',
    lineHeight: 1.6,
});

export const sheetList = style({
    margin: `0 0 ${vars.space.sm}`,
    paddingLeft: '1.25rem',
    fontSize: '0.9375rem',
    lineHeight: 1.6,
});

export const sheetSummary = style({
    margin: `0 0 ${vars.space.sm}`,
    padding: vars.space.sm,
    borderRadius: vars.radius.lg,
    background: vars.color.inset,
    fontSize: '1rem',
    fontWeight: 600,
});

export const sheetProblem = style({
    margin: `0 0 ${vars.space.sm}`,
    fontSize: '0.9375rem',
    color: vars.color.amber,
});

export const sheetFeedback = styleVariants({
    cancelled: { margin: `0 0 ${vars.space.sm}`, fontSize: '0.9375rem', color: vars.color.mutedForeground },
    notSent: { margin: `0 0 ${vars.space.sm}`, fontSize: '0.9375rem', color: vars.color.danger },
});

export const sheetActions = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: vars.space.sm,
    marginTop: vars.space.sm,
});
