// src/mobile/styles/watch-picker.css.ts — 交易頁 ☆「加入自選」清單選擇面板（components/watch-picker-sheet.tsx，延遲載入；設計規格 §7.3）
// - 只由延遲載入的面板 chunk import（不進首屏、也不進交易頁 chunk）。
// - 每列是整列可點的 label＋原生勾選框（點擊區 ≥ TOUCH_MIN；勾選與否是勾選框本身的形狀，不只靠顏色；accent-color 15.4 起支援），
//   清單名稱過長時省略、「（目前）」與檔數不縮；窄螢幕＋大字時檔數換到第二行（flex-wrap）。
import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from './theme-vars.css';
import { RADIUS, SPACE, TOUCH_MIN } from './tokens';
import { NUMERIC, TEXT } from './typography.css';

export const body = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    paddingBottom: SPACE.s2,
    minWidth: 0,
});

export const note = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const list = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    borderRadius: RADIUS.lg,
    background: sj.elevatedBg,
    overflow: 'hidden',
});

globalStyle(`${list} > li + li`, { borderTop: `0.5px solid ${vars.color.border}` });

export const row = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `0 ${SPACE.s2}`,
    width: '100%',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `${SPACE.s2} ${SPACE.s4}`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    ...TEXT.body,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
});

/** 勾選框（原生 checkbox；22px，焦點外框由瀏覽器的 :focus-visible 顯示） */
export const checkbox = style({
    flex: '0 0 auto',
    width: '22px',
    height: '22px',
    margin: 0,
    accentColor: vars.color.accent,
    cursor: 'pointer',
});

export const name = style({
    flex: '1 1 6rem',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const meta = style({
    flex: '0 0 auto',
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.mutedForeground,
});

export const actions = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: SPACE.s2,
});

globalStyle(`${actions} > button`, { flex: '1 1 8rem' });
