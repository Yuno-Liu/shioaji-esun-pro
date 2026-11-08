// src/mobile/styles/batch-exit.css.ts — 持倉「多選市價出清」預覽與進度面板（components/batch-exit-sheet.tsx，延遲載入；設計規格 §7.7）
// 獨立成檔：面板 chunk 不 import positions.css（否則兩個 chunk 共用的樣式模組會被拆成新 chunk，首屏的預載清單變長）。
// 環境標籤與每筆狀態一律有文字，不只靠顏色；沒有動畫。
import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { fill, focusRing, pressable } from './primitives.css';
import { RADIUS, SPACE, TOUCH_MIN } from './tokens';
import { NUMERIC, TEXT } from './typography.css';

export const sheetBody = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    minWidth: 0,
});

// GroupedSection 預設左右內縮 16（頁面用）；面板 body 已有內距，這裡歸零
globalStyle(`${sheetBody} section`, { marginLeft: 0, marginRight: 0 });

export const sheetText = style({
    margin: 0,
    ...TEXT.body,
    color: vars.color.foreground,
});

const buttonBase = style([pressable, focusRing, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    margin: 0,
    padding: `0 ${SPACE.s3}`,
    borderRadius: RADIUS.lg,
    ...TEXT.callout,
    fontWeight: 600,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
}]);

/** 「停止剩餘」「完成」：中性外框（不用實心紅綠） */
export const outlineButton = style([buttonBase, {
    border: `1px solid ${vars.color.borderBright}`,
    background: 'transparent',
    color: vars.color.foreground,
}]);

/** 「取消」：accent 文字鍵 */
export const textButton = style([buttonBase, {
    border: 'none',
    background: 'transparent',
    color: vars.color.accent,
}]);

/** 出清面板：組標頭（券商、遮蔽帳號、環境標籤） */
export const batchGroupHead = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACE.s2,
    padding: `0.6875rem ${SPACE.s4} 0`,
    ...TEXT.subhead,
    fontWeight: 600,
    ...NUMERIC,
    color: vars.color.foreground,
});

const envBase = style({
    padding: '0 0.375rem',
    borderRadius: RADIUS.xs,
    ...TEXT.footnote,
    fontWeight: 700,
    lineHeight: 1.5,
    whiteSpace: 'nowrap',
});

/** 環境標籤（文字＋顏色）：正式 danger 實心、模擬 accent 實心、未確認外框 */
export const envTag = styleVariants({
    production: [envBase, fill.danger.strong],
    simulation: [envBase, fill.accent.strong],
    unknown: [envBase, { border: `1px solid ${vars.color.borderBright}`, color: vars.color.foreground }],
});

export const batchList = style({
    listStyle: 'none',
    margin: 0,
    padding: `0 ${SPACE.s4} 0.6875rem`,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const batchItem = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    padding: `${SPACE.s2} 0`,
    minWidth: 0,
    selectors: {
        '& + &': { borderTop: `0.5px solid ${vars.color.border}` },
    },
});

export const batchItemHead = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: SPACE.s2,
    ...TEXT.body,
    ...NUMERIC,
    color: vars.color.foreground,
});

export const batchAction = style({
    fontWeight: 700,
    whiteSpace: 'nowrap',
});

export const batchLeg = style({
    margin: 0,
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.mutedForeground,
});

/** 每筆狀態（文字，不只靠顏色） */
export const batchStatus = styleVariants({
    waiting: { color: vars.color.mutedForeground },
    sending: { color: vars.color.foreground, fontWeight: 600 },
    sent: { color: vars.color.foreground, fontWeight: 600 },
    'not-sent': { color: vars.color.danger, fontWeight: 600 },
    skipped: { color: vars.color.mutedForeground, fontWeight: 600 },
    unknown: { color: vars.color.danger, fontWeight: 700 },
});

export const batchStatusLine = style({
    margin: 0,
    ...TEXT.footnote,
});

export const footerStack = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
});
