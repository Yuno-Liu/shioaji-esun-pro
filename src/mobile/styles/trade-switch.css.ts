// src/mobile/styles/trade-switch.css.ts — 交易頁「切換商品」面板（設計規格 §7.2 搜尋面板、§7.3 交易頁）
// 搜尋欄、結果列沿用 watchlist.css.ts（與自選搜尋面板同樣式）；這裡只放面板特有的說明行、分區標題與「目前」標示。
// 只由交易頁（延遲載入）引用，不進首屏。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { SPACE } from './tokens';
import { TEXT } from './typography.css';

/** 搜尋欄下方的說明行 */
export const hint = style({
    margin: `0 0 ${SPACE.s2}`,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 空白查詢時的分區標題（最近查看、自選） */
export const sectionTitle = style({
    margin: `${SPACE.s3} 0 0`,
    ...TEXT.footnote,
    fontWeight: 600,
    color: vars.color.mutedForeground,
});

/** 目前商品的列尾標示（非按鈕） */
export const currentTag = style({
    flex: '0 0 auto',
    ...TEXT.footnote,
    fontWeight: 600,
    color: vars.color.mutedForeground,
});
