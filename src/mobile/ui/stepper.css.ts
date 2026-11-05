// src/mobile/ui/stepper.css.ts — 步進輸入（設計規格 §6.9）
// 版面 [－][輸入][＋]：鍵 TOUCH_MIN 正方、elevatedBg＋1px borderBright＋e1、圓角 8；輸入框 islandBg、numLg、置中、
// aria-invalid 時 amber 框。flash 覆蓋層只動畫 opacity（WAAPI）；減少動態改靜態外框。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { elevation, sj } from '../styles/theme-vars.css';
import { INPUT_FONT_SIZE, MORE_CONTRAST, RADIUS, TOUCH_MIN } from '../styles/tokens';
import { NUM, NUMERIC, TEXT } from '../styles/typography.css';

export const root = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const row = style({
    display: 'grid',
    gridTemplateColumns: `${TOUCH_MIN} minmax(0, 1fr) ${TOUCH_MIN}`,
    alignItems: 'stretch',
    gap: '0.375rem',
    minWidth: 0,
});

export const key = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    margin: 0,
    padding: 0,
    borderRadius: RADIUS.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: sj.elevatedBg,
    boxShadow: elevation.e1,
    color: vars.color.foreground,
    fontSize: '1.25rem',
    fontWeight: 600,
    lineHeight: 1,
    cursor: 'pointer',
    // 按住連續步進：不觸發 iOS 長按選單、不選字、不雙擊縮放
    touchAction: 'manipulation',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
});

/** 輸入框外層：撞界時以 transform 橫移（JS 寫 style.transform） */
export const field = style({
    position: 'relative',
    minWidth: 0,
});

export const input = style({
    display: 'block',
    width: '100%',
    height: TOUCH_MIN,
    margin: 0,
    padding: '0 0.5rem',
    boxSizing: 'border-box',
    borderRadius: RADIUS.md,
    border: `1px solid ${vars.color.border}`,
    background: sj.islandBg,
    color: vars.color.foreground,
    ...NUM.numLg,
    ...NUMERIC,
    // numLg 1.25rem；仍以 INPUT_FONT_SIZE 保底 ≥16px（iOS 聚焦不放大）
    fontSize: `max(${INPUT_FONT_SIZE}, ${NUM.numLg.fontSize})`,
    textAlign: 'center',
    outline: 'none',
    selectors: {
        '&:focus-visible, &:focus': { borderColor: vars.color.accent },
        '&[aria-invalid="true"]': { borderColor: vars.color.amber },
        '&:disabled': { opacity: 0.6 },
    },
    '@media': {
        [MORE_CONTRAST]: { borderColor: vars.color.borderBright },
    },
});

/** 有單位時右側留位 */
export const inputWithUnit = style({
    paddingRight: '2rem',
});

export const unit = style({
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: '0.625rem',
    display: 'flex',
    alignItems: 'center',
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    pointerEvents: 'none',
});

/** 外部帶入價格時的 accent 外框（只動畫 opacity） */
export const flash = style({
    position: 'absolute',
    inset: 0,
    borderRadius: RADIUS.md,
    boxShadow: `inset 0 0 0 2px ${vars.color.accent}`,
    opacity: 0,
    pointerEvents: 'none',
    selectors: {
        '&[data-static="true"]': { opacity: 1 },
    },
});

/** 撞界說明（role=status；小字用 foreground，不用 amber 小字） */
export const boundNote = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.foreground,
    textAlign: 'center',
    selectors: {
        // 空白時不佔高度（live region 不能 display:none，否則插入文字時可能不宣告）
        '&:not(:empty)': { paddingTop: '0.25rem' },
    },
});
