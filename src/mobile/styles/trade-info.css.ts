// src/mobile/styles/trade-info.css.ts — 交易頁「當沖資訊列」與「籌碼與當沖」面板（設計規格 §7.3、§11）
//
// - 資訊列是標頭內、統計格與漲跌停列之下的一顆整列按鈕：一般文件流（不用 fixed／sticky／absolute、不設 z-index、
//   沒有負邊界），不會蓋住圖表與五檔，也不改五檔、分頁列的寬度預算（trade.css.ts 不動）。
// - 點擊區 ≥ TOUCH_MIN；膠囊可換行、單顆不截斷（nowrap＋最長約 7 個字，三檔字級 360 寬都放得下）。
// - 狀態以文字表達，顏色只是框線輔助；不動畫（按壓層在減少動態時也不淡入淡出）。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { focusRing, pressableRow } from './primitives.css';
import { sj } from './theme-vars.css';
import { MORE_CONTRAST, RADIUS, REDUCED_MOTION, SPACE, TOUCH_MIN } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

// ---- 資訊列 ----

export const strip = style([pressableRow, focusRing, {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${SPACE.s1} ${SPACE.s1_5}`,
    boxSizing: 'border-box',
    width: '100%',
    minWidth: 0,
    minHeight: TOUCH_MIN,
    margin: `${SPACE.s1} 0 0`,
    padding: `${SPACE.s1} 0`,
    border: 'none',
    borderRadius: RADIUS.md,
    background: 'transparent',
    color: vars.color.foreground,
    font: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    '@media': {
        [REDUCED_MOTION]: { selectors: { '&::after, &:not(:disabled):active::after': { transition: 'none' } } },
    },
}]);

/** 膠囊：外框＋foreground 文字（小字不著色；狀態看文字，框線色只是輔助） */
const chipBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: SPACE.s1,
    maxWidth: '100%',
    minHeight: '1.5rem',
    boxSizing: 'border-box',
    padding: '0 0.375rem',
    borderRadius: RADIUS.sm,
    border: `1px solid ${vars.color.borderBright}`,
    ...TEXT.footnote,
    fontWeight: 500,
    lineHeight: 1.35,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
    ...NUMERIC,
});

const TONE_BORDER = {
    neutral: vars.color.borderBright,
    warn: vars.color.amber,
    danger: vars.color.danger,
    up: vars.color.up,
    down: vars.color.down,
} as const;

export const chip = styleVariants(TONE_BORDER, color => [chipBase, {
    borderColor: color,
    '@media': { [MORE_CONTRAST]: { borderWidth: '2px' } },
}]);

/** 停板（鎖／未鎖）加粗：同時有文字「鎖漲停」等 */
export const chipStrong = style({ fontWeight: 700 });

/** 日內振幅小條：軌道（border 色）＋最低到最高段（相對開盤著色）＋現價刻線（foreground）＋參考價刻線 */
export const bar = style({
    position: 'relative',
    display: 'inline-block',
    flex: '0 0 auto',
    width: '2.5rem',
    height: '0.375rem',
    borderRadius: '999px',
    background: vars.color.border,
});

export const barSpan = styleVariants({
    up: { background: vars.color.up },
    down: { background: vars.color.down },
    flat: { background: vars.color.mutedForeground },
}, tone => [{
    position: 'absolute',
    top: 0,
    bottom: 0,
    minWidth: '2px',
    borderRadius: '999px',
}, tone]);

export const barRef = style({
    position: 'absolute',
    top: '-0.125rem',
    bottom: '-0.125rem',
    left: '50%',
    width: '1px',
    background: vars.color.mutedForeground,
});

export const barMark = style({
    position: 'absolute',
    top: '-0.1875rem',
    bottom: '-0.1875rem',
    width: '2px',
    marginLeft: '-1px',
    borderRadius: '1px',
    background: vars.color.foreground,
});

/** 列尾「說明 ›」：可點的提示文字 */
export const more = style({
    marginLeft: 'auto',
    padding: `0 ${SPACE.s1}`,
    ...TEXT.footnote,
    fontWeight: 600,
    color: vars.color.accent,
    whiteSpace: 'nowrap',
});

// ---- 「籌碼與當沖」面板 ----

export const sheetBody = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    minWidth: 0,
});

export const sectionTitle = style({
    margin: `${SPACE.s1} 0 0`,
    ...TEXT.footnote,
    fontWeight: 600,
    color: vars.color.foreground,
});

export const grid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))',
    gap: `${SPACE.s1_5} ${SPACE.s2}`,
    margin: 0,
});

export const item = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const label = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const value = style({
    margin: 0,
    ...NUM.numSm,
    ...NUMERIC,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

/** 停資、停券、處置等需要注意的值：左側 amber／danger 條＋文字（不只靠顏色） */
export const valueTone = styleVariants({
    warn: { boxShadow: `inset 3px 0 0 ${vars.color.amber}`, paddingLeft: SPACE.s1_5 },
    danger: { boxShadow: `inset 3px 0 0 ${vars.color.danger}`, paddingLeft: SPACE.s1_5 },
});

export const note = style({
    margin: 0,
    ...TEXT.footnote,
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
});

export const status = style({
    margin: 0,
    padding: `${SPACE.s2} ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    ...TEXT.subhead,
    color: vars.color.foreground,
});

export const rules = style({
    margin: 0,
    paddingLeft: '1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    ...TEXT.subhead,
    lineHeight: 1.5,
    color: vars.color.foreground,
});
