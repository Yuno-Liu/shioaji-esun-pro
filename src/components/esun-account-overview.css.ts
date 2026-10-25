// src/components/esun-account-overview.css.ts — 玉山帳務概覽與已實現損益成本明細（fork 元件）
//
// 沿用 bottom-dock 帳務 tab 的視覺語言：inset 區塊、display 字型小標、mono 數字、tabular-nums。
// 區塊外框、標題、數字列直接用 bottom-dock.css 的 acctSection／acctTitle／fundRow；這裡只放 fork 新增的部分。

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

// 交割行事曆下方的玉山試算提示
export const settleNote = style({
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    lineHeight: 1.6,
    color: vars.color.amber,
    padding: `0 ${vars.space.xs}`,
});

// 區塊內小標（銀行餘額內的資料時間、額度權限內的「權限」分組）
export const subHead = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
    marginTop: '4px',
});

// 非最新資料／快取等狀態小標籤
export const badge = style({
    display: 'inline-block',
    marginLeft: vars.space.xs,
    padding: '0 4px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.body,
    fontSize: '0.58rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const badgeWarn = style({
    color: vars.color.amber,
    borderColor: vars.color.amber,
});

// 權限狀態值（標籤文字，不是數字）
export const statusValue = style({
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    fontWeight: 600,
    textAlign: 'right',
    whiteSpace: 'nowrap',
});

export const statusOff = style({
    color: vars.color.mutedForeground,
    fontWeight: 500,
});

// ---- 已實現損益：玉山列的成本明細 ----

// 掛在已實現損益明細列（grid）內，占滿整列
export const pnlExtra = style({
    gridColumn: '1 / -1',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: 0,
});

export const pnlToggle = style({
    alignSelf: 'flex-start',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    padding: '0 4px',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    ':hover': { color: vars.color.foreground, borderColor: vars.color.border },
    selectors: {
        '&[aria-expanded="true"]': { color: vars.color.accent },
    },
});

export const pnlDetail = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: `${vars.space.xs} ${vars.space.sm}`,
    marginBottom: '4px',
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    minWidth: 0,
});

// 摘要／成本：寬版自動多欄、窄版單欄
export const kvGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(10.5rem, 1fr))',
    columnGap: vars.space.md,
});

// 逐筆成交表：窄版水平捲動，不撐破面板
export const fillsWrap = style({
    overflowX: 'auto',
    maxWidth: '100%',
});

export const fillsTable = style({
    borderCollapse: 'collapse',
    width: '100%',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
});

export const fillsHead = style({
    padding: '2px 6px',
    textAlign: 'right',
    fontFamily: vars.font.display,
    fontSize: '0.58rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
    selectors: { '&:first-child, &:nth-child(2)': { textAlign: 'left' } },
});

export const fillsCell = style({
    padding: '2px 6px',
    textAlign: 'right',
    selectors: { '&:first-child, &:nth-child(2)': { textAlign: 'left' } },
});

// 區塊層的今日交易成本合計
export const costTotalRow = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.7,
});
