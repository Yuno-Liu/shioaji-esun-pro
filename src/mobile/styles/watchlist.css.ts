// src/mobile/styles/watchlist.css.ts — 自選頁與搜尋面板（規格 §6.1、§11）
// 顏色一律用 src/theme.css.ts 的 vars；漲跌用 up／down（隨使用者的台灣／國際配色），並一律附 ▲▼ 文字。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { INPUT_FONT_SIZE, TOUCH_MIN } from './metrics';

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    marginBottom: vars.space.sm,
});

export const headerTitle = style({
    flex: '1 1 auto',
    margin: 0,
    fontSize: '1.25rem',
    fontWeight: 700,
});

export const iconButton = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    border: 'none',
    borderRadius: vars.radius.lg,
    background: 'transparent',
    color: vars.color.foreground,
    selectors: {
        '&[aria-pressed="true"]': { background: vars.color.accentDim, color: vars.color.accent },
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

export const listPicker = style({
    width: '100%',
    minHeight: TOUCH_MIN,
    marginBottom: vars.space.sm,
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
});

export const listName = style({
    margin: `0 0 ${vars.space.sm}`,
    color: vars.color.mutedForeground,
    fontSize: '0.875rem',
});

export const list = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    borderTop: `1px solid ${vars.color.border}`,
});

export const rowItem = style({
    display: 'flex',
    alignItems: 'stretch',
    borderBottom: `1px solid ${vars.color.border}`,
});

/** 整列可點（開交易頁），長按開操作面板；禁止 iOS 長按選字／彈出選單 */
export const row = style({
    flex: '1 1 auto',
    minWidth: 0,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    alignItems: 'center',
    columnGap: vars.space.sm,
    minHeight: '56px',
    padding: `${vars.space.xs} ${vars.space.xs}`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    textAlign: 'left',
    font: 'inherit',
    touchAction: 'pan-y',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    selectors: {
        '&:active': { background: vars.color.muted },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

export const rowName = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const rowCode = style({
    fontWeight: 700,
    fontSize: '1rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const rowSub = style({
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const rowPrice = style({
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 700,
    fontSize: '1.0625rem',
    textAlign: 'right',
});

export const rowChange = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    minWidth: '5.5rem',
    fontVariantNumeric: 'tabular-nums',
    fontSize: '0.875rem',
});

export const tone = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.flat },
});

export const rowMore = style([iconButton, {
    flex: '0 0 auto',
    color: vars.color.mutedForeground,
}]);

export const state = style({
    margin: `${vars.space.md} 0`,
    color: vars.color.mutedForeground,
    textAlign: 'center',
});

export const stateActions = style({
    display: 'flex',
    justifyContent: 'center',
    gap: vars.space.sm,
    marginTop: vars.space.sm,
});

export const error = style({
    margin: `${vars.space.sm} 0`,
    color: vars.color.danger,
    fontSize: '0.875rem',
});

// ---- 長按操作面板 ----

export const actionList = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
});

export const actionNote = style({
    margin: 0,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
});

// ---- 搜尋面板（search-sheet.tsx）----

export const searchInput = style({
    width: '100%',
    minHeight: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.inset,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
    boxSizing: 'border-box',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '1px' },
    },
});

export const searchStatus = style({
    margin: `${vars.space.sm} 0`,
    color: vars.color.mutedForeground,
    fontSize: '0.875rem',
});

export const resultList = style({
    listStyle: 'none',
    margin: `${vars.space.sm} 0 0`,
    padding: 0,
});

export const resultRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    minHeight: '56px',
    borderBottom: `1px solid ${vars.color.border}`,
});

export const resultMain = style({
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    minHeight: TOUCH_MIN,
    justifyContent: 'center',
    padding: `0 ${vars.space.xs}`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    textAlign: 'left',
    font: 'inherit',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

export const resultButton = style({
    flex: '0 0 auto',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '0.875rem',
    fontWeight: 600,
    selectors: {
        '&:disabled': { opacity: 0.5 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const resultMessage = style({
    margin: `${vars.space.xs} 0 0`,
    fontSize: '0.8125rem',
    color: vars.color.amber,
});
