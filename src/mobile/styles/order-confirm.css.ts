// src/mobile/styles/order-confirm.css.ts — 確認面板（order-confirm-sheet.tsx，規格 §6.4、§11）
// 環境大字：正式＝danger、模擬＝accent、未確認＝amber（與 RouteBadge 同一配色）；買賣一律有文字，方向色用 up／down。
// 面板背景的方向著色由 BottomSheet 的 tone 處理（styles/sheet.css.ts panelTone）。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { TOUCH_MIN } from './metrics';

export const content = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
});

const envBase = style({
    display: 'block',
    textAlign: 'center',
    padding: '8px 12px',
    borderRadius: vars.radius.lg,
    border: '2px solid',
    fontSize: '1.5rem',
    fontWeight: 800,
    letterSpacing: '0.08em',
});

export const env = styleVariants({
    production: [envBase, { borderColor: vars.color.danger, color: vars.color.danger, background: vars.color.dangerDim }],
    simulation: [envBase, { borderColor: vars.color.accent, color: vars.color.accent, background: vars.color.accentDim }],
    unknown: [envBase, { borderColor: vars.color.amber, color: vars.color.amber, background: 'transparent' }],
});

const actionBase = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: '0 8px',
    fontSize: '1.375rem',
    fontWeight: 800,
});

export const actionLine = styleVariants({
    up: [actionBase, { color: vars.color.up }],
    down: [actionBase, { color: vars.color.down }],
});

/** 動作大字（含信用名稱）；顏色繼承 actionLine 的方向色 */
export const actionBig = style({
    fontSize: '2rem',
    fontWeight: 800,
    lineHeight: 1.2,
    letterSpacing: '0.04em',
});

export const contractName = style({
    color: vars.color.foreground,
    fontSize: '1.125rem',
    fontWeight: 700,
});

export const contractCode = style({
    color: vars.color.mutedForeground,
    fontSize: '0.9375rem',
    fontWeight: 600,
    fontFamily: vars.font.mono,
});

export const details = style({
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '6px 16px',
    margin: 0,
    padding: '10px 12px',
    borderRadius: vars.radius.lg,
    background: vars.color.inset,
});

export const detailLabel = style({
    margin: 0,
    color: vars.color.mutedForeground,
    fontSize: '0.9375rem',
});

export const detailValue = style({
    margin: 0,
    textAlign: 'right',
    fontSize: '1.0625rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
});

export const detailValueWarn = style([detailValue, { color: vars.color.amber }]);

export const note = style({
    margin: 0,
    color: vars.color.mutedForeground,
    fontSize: '0.9375rem',
    overflowWrap: 'anywhere',
});

export const cancelButton = style({
    minHeight: TOUCH_MIN,
    width: '100%',
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: 'transparent',
    color: vars.color.foreground,
    fontSize: '1rem',
    fontWeight: 600,
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});
