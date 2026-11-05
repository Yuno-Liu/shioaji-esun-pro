// src/mobile/ui/grouped.css.ts — 分組卡片與列（設計規格 §6.11）
// GroupedSection：卡片左右內縮 16、圓角 12、groupedBg；header／footer 為卡片外 footnote（mutedForeground）；
//                 列間髮絲線從文字起點（16px）開始。
// ListRow：min-height TOUCH_MIN、內距 11px 16px；可點列＝按鈕（只放 title）以 ::before 撐滿整列作點擊區，
//          按下延後 80ms 才加深（同 primitives.pressableRow，捲動開始時瀏覽器取消 :active 就不會閃）。
// ValueRow：左 mutedForeground、右 foreground num；warn 加 amber 圖示，文字仍 foreground。
import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from '../styles/theme-vars.css';
import { DUR, LOW_DPR, MORE_CONTRAST, RADIUS, SAFE_LEFT, SAFE_RIGHT, SPACE, TOUCH_MIN } from '../styles/tokens';
import { NUM, NUMERIC, TEXT } from '../styles/typography.css';

export const section = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    marginLeft: `calc(${SPACE.s4} + ${SAFE_LEFT})`,
    marginRight: `calc(${SPACE.s4} + ${SAFE_RIGHT})`,
    minWidth: 0,
});

export const sectionHeader = style({
    margin: 0,
    padding: `0 ${SPACE.s4}`,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const sectionFooter = sectionHeader;

export const card = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    borderRadius: RADIUS.lg,
    background: sj.groupedBg,
    // 列的按壓加深與髮絲線不超出圓角
    overflow: 'hidden',
});

// 列間髮絲線：從文字起點開始（左 16px），畫在後一列的上緣
globalStyle(`${card} > * + *`, {
    position: 'relative',
});
globalStyle(`${card} > * + *::after`, {
    content: '""',
    position: 'absolute',
    top: 0,
    left: SPACE.s4,
    right: 0,
    height: 0,
    borderTop: `0.5px solid ${vars.color.border}`,
    pointerEvents: 'none',
    '@media': {
        [LOW_DPR]: { borderTopWidth: '1px' },
        [MORE_CONTRAST]: { borderTop: `1px solid ${vars.color.borderBright}` },
    },
});

// ---- ListRow ----

export const row = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s3,
    minHeight: TOUCH_MIN,
    padding: `0.6875rem ${SPACE.s4}`,
    boxSizing: 'border-box',
    minWidth: 0,
    color: vars.color.foreground,
});

export const leading = style({
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    color: vars.color.mutedForeground,
});

export const body = style({
    flex: '1 1 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
});

export const title = style({
    ...TEXT.headline,
    color: vars.color.foreground,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

/** 可點列的標題按鈕：只放 title 文字；::before 撐滿整列（點擊區與按壓加深） */
export const titleButton = style([{
    display: 'block',
    width: '100%',
    margin: 0,
    padding: 0,
    border: 'none',
    background: 'transparent',
    textAlign: 'left',
    font: 'inherit',
    ...TEXT.headline,
    color: vars.color.foreground,
    textDecoration: 'none',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    outline: 'none',
    selectors: {
        '&::before': {
            content: '""',
            position: 'absolute',
            inset: 0,
            background: vars.color.foreground,
            opacity: 0,
            transition: `opacity ${DUR.fade}ms ease-out`,
        },
        '&:not(:disabled):active::before': {
            opacity: 0.08,
            transition: `opacity 0s linear ${DUR.press}ms`,
        },
        // 按鈕本身 overflow hidden：焦點環畫在撐滿整列的 ::before 上
        '&:focus-visible::before': { boxShadow: `inset 0 0 0 2px ${vars.color.accent}` },
        '&:disabled': { color: vars.color.mutedForeground, cursor: 'default' },
    },
}]);

export const subtitle = style({
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
    minWidth: 0,
});

/** 列尾：在撐滿整列的點擊區之上（內含的按鈕仍可單獨點） */
export const trailing = style({
    position: 'relative',
    zIndex: 1,
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    color: vars.color.mutedForeground,
    ...TEXT.subhead,
});

export const chevron = style({
    flex: '0 0 auto',
    width: '1rem',
    height: '1rem',
    color: vars.color.mutedForeground,
    // 指示用，不攔點擊（讓整列點擊區接手）
    pointerEvents: 'none',
});

// ---- ValueRow ----

export const valueRow = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: SPACE.s3,
    minHeight: TOUCH_MIN,
    padding: `0.6875rem ${SPACE.s4}`,
    boxSizing: 'border-box',
    minWidth: 0,
});

export const valueLabel = style({
    flex: '0 1 auto',
    minWidth: 0,
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

export const value = style({
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: SPACE.s1,
    ...NUM.numMd,
    ...NUMERIC,
    color: vars.color.foreground,
    textAlign: 'right',
});

export const warnIcon = style({
    flex: '0 0 auto',
    width: '0.875rem',
    height: '0.875rem',
    color: vars.color.amber,
    alignSelf: 'center',
});
