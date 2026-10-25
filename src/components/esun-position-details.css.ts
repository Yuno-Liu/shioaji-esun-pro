// src/components/esun-position-details.css.ts — 玉山庫存明細（持倉列展開，fork 元件）
//
// 沿用 bottom-dock 的視覺語言：inset 區塊、display 字型小標、mono 數字、tabular-nums。

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

// 列首的展開按鈕（代碼旁）
export const toggle = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: '4px',
    padding: '0 2px',
    verticalAlign: 'middle',
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: `1px solid transparent`,
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    ':hover': { color: vars.color.foreground, borderColor: vars.color.border },
    selectors: {
        '&[aria-expanded="true"]': { color: vars.color.accent },
    },
});

// 表格模式：整寬的明細列
export const detailCell = style({
    padding: `${vars.space.xs} ${vars.space.sm} ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    textAlign: 'left',
    cursor: 'default',
});

// 卡片模式：卡片下方的明細區
export const cardDetail = style({
    paddingTop: vars.space.xs,
    cursor: 'default',
});

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
});

export const head = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: `2px ${vars.space.sm}`,
    fontFamily: vars.font.display,
    fontSize: '0.64rem',
});

export const tag = style({
    padding: '0 6px',
    borderRadius: vars.radius.sm,
    background: vars.color.muted,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const note = style({
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    lineHeight: 1.5,
});

export const snapshot = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

// 三個區塊（數量／價格／交易成本）：寬版並排，窄版自動換行成單欄
export const sections = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))',
    gap: vars.space.sm,
    minWidth: 0,
});

export const section = style({
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: `${vars.space.xs} ${vars.space.sm}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
});

export const sectionTitle = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    color: vars.color.mutedForeground,
    marginBottom: '2px',
});

export const row = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    lineHeight: 1.6,
});

export const label = style({
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const value = style({
    fontWeight: 600,
    textAlign: 'right',
    whiteSpace: 'nowrap',
});

// 成本推導：一行一個算式，結果欄加粗
export const formula = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'flex-end',
    gap: '0 4px',
    lineHeight: 1.6,
});

export const formulaTerm = style({
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '3px',
    whiteSpace: 'nowrap',
});

export const formulaOp = style({
    color: vars.color.mutedForeground,
});

export const formulaResult = style({
    fontWeight: 600,
});

export const rule = style({
    borderTop: `1px solid ${vars.color.border}`,
    margin: '3px 0',
});

// 明細表：欄位多，自己水平捲動，不撐開外層
export const lotsScroll = style({
    overflowX: 'auto',
    minWidth: 0,
    maxWidth: '100%',
});

export const lots = style({
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
});

export const lotsTh = style({
    textAlign: 'right',
    padding: `2px ${vars.space.sm}`,
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
    selectors: { '&:first-child': { textAlign: 'left' } },
});

export const lotsTd = style({
    textAlign: 'right',
    padding: `2px ${vars.space.sm}`,
    borderBottom: `1px solid rgba(34, 43, 55, 0.5)`,
    whiteSpace: 'nowrap',
    selectors: { '&:first-child': { textAlign: 'left' } },
});

export const empty = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    padding: `${vars.space.xs} 0`,
});
