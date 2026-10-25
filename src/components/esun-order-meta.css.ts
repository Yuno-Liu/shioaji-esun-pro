// src/components/esun-order-meta.css.ts — 委託列的玉山預約／委託時間標示（fork 專屬樣式）
// 視覺沿用 bottom-dock 的 statusChip／priceDualSub：小字、膠囊徽章，顏色全走 theme token。

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

// 限制寬度：徽章與時間放不下時換行（各自過長則省略），不把委託表的 CANCEL 欄推出水平捲動區
export const meta = style({
    display: 'inline-flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: '4px',
    rowGap: '1px',
    maxWidth: '7.5rem',
    minWidth: 0,
    marginLeft: '4px',
    verticalAlign: 'middle',
    cursor: 'help',
});

const clipped = {
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
} as const;

// 預約徽章：與 statusChip 同尺寸，使用 accent 色區分預約來源
export const reservation = style({
    ...clipped,
    display: 'inline-block',
    padding: '1px 6px',
    fontSize: '0.6rem',
    fontWeight: 500,
    borderRadius: '999px',
    color: vars.color.accent,
    background: vars.color.accentDim,
});

export const time = style({
    ...clipped,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
});
