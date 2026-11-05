// src/mobile/styles/order-ticket.css.ts — 下單面板（order-ticket-sheet.tsx，規格 §6.3、§11）
// 觸控目標 ≥ 44px、輸入字級 ≥ 16px；買賣一律有文字，漲跌用 vars.color.up／down。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { INPUT_FONT_SIZE, TOUCH_MIN, TRADE_BUTTON_GAP, TRADE_BUTTON_MIN_HEIGHT } from './metrics';

export const form = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
});

export const headerRow = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    flexWrap: 'wrap',
});

export const contractName = style({
    fontSize: '1.0625rem',
    fontWeight: 700,
});

export const accountRow = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    fontSize: '0.9375rem',
});

export const muted = style({
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
});

export const row = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    flexWrap: 'wrap',
});

export const label = style({
    flex: '0 0 auto',
    minWidth: '2.5em',
    fontSize: '0.9375rem',
    color: vars.color.mutedForeground,
});

// ---- 買進／賣出 ----

export const actionRow = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: TRADE_BUTTON_GAP,
});

const actionBase = style({
    minHeight: TRADE_BUTTON_MIN_HEIGHT,
    borderRadius: vars.radius.lg,
    border: '2px solid',
    fontSize: '1.125rem',
    fontWeight: 700,
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

/** 已選：實心；未選：外框＋同色文字（文字一律存在，不只靠顏色） */
export const action = styleVariants({
    buyOn: [actionBase, { background: vars.color.up, borderColor: vars.color.up, color: '#ffffff' }],
    buyOff: [actionBase, { background: 'transparent', borderColor: vars.color.up, color: vars.color.up }],
    sellOn: [actionBase, { background: vars.color.down, borderColor: vars.color.down, color: '#ffffff' }],
    sellOff: [actionBase, { background: 'transparent', borderColor: vars.color.down, color: vars.color.down }],
});

// ---- 分段選擇（單位、條件、價別、效期、倉別）----

export const segGroup = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
});

const segBase = style({
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.borderBright}`,
    fontSize: '0.9375rem',
    fontWeight: 600,
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const seg = styleVariants({
    on: [segBase, { background: vars.color.accentDim, borderColor: vars.color.accent, color: vars.color.foreground }],
    off: [segBase, { background: vars.color.panelRaised, color: vars.color.foreground }],
});

// ---- 價格／數量步進 ----

export const stepper = style({
    display: 'grid',
    gridTemplateColumns: `${TOUCH_MIN} minmax(0, 1fr) ${TOUCH_MIN}`,
    alignItems: 'center',
    gap: '6px',
    flex: '1 1 12rem',
});

export const stepButton = style({
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '1.25rem',
    fontWeight: 700,
    selectors: {
        '&:disabled': { opacity: 0.45 },
    },
});

export const input = style({
    minHeight: TOUCH_MIN,
    width: '100%',
    boxSizing: 'border-box',
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.inset,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
    selectors: {
        '&:disabled': { opacity: 0.6 },
        '&[aria-invalid="true"]': { borderColor: vars.color.amber },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '1px' },
    },
});

export const unit = style({
    fontSize: '0.9375rem',
    color: vars.color.mutedForeground,
});

/** 即時成交價（漲跌色＋前置符號，不只靠顏色） */
export const livePrice = styleVariants({
    up: { color: vars.color.up, fontVariantNumeric: 'tabular-nums', fontSize: '0.9375rem' },
    down: { color: vars.color.down, fontVariantNumeric: 'tabular-nums', fontSize: '0.9375rem' },
    flat: { color: vars.color.flat, fontVariantNumeric: 'tabular-nums', fontSize: '0.9375rem' },
});

export const quickRow = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(4.25rem, 1fr))',
    gap: '6px',
});

export const quickButton = style([segBase, {
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '0.875rem',
}]);

export const staleRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    flexWrap: 'wrap',
    color: vars.color.amber,
    fontSize: '0.875rem',
});

export const divider = style({
    border: 'none',
    borderTop: `1px solid ${vars.color.border}`,
    margin: `${vars.space.xs} 0`,
    width: '100%',
});

export const estimate = style({
    fontSize: '0.9375rem',
    fontVariantNumeric: 'tabular-nums',
});

export const checkboxRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    minHeight: TOUCH_MIN,
    fontSize: '0.9375rem',
    color: vars.color.amber,
});

export const checkbox = style({
    width: '22px',
    height: '22px',
    flex: '0 0 auto',
});

/** 停用原因（第一個）＝琥珀色提示 */
export const problem = style({
    margin: 0,
    fontSize: '0.875rem',
    color: vars.color.amber,
});

export const feedback = styleVariants({
    cancelled: { margin: 0, fontSize: '0.9375rem', color: vars.color.mutedForeground },
    'not-sent': { margin: 0, fontSize: '0.9375rem', color: vars.color.danger, fontWeight: 600 },
});

export const previewButton = style({
    minHeight: TRADE_BUTTON_MIN_HEIGHT,
    width: '100%',
    borderRadius: vars.radius.lg,
    border: 'none',
    background: vars.color.accent,
    color: '#ffffff',
    fontSize: '1.0625rem',
    fontWeight: 700,
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.foreground}`, outlineOffset: '2px' },
    },
});
