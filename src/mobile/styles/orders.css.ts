// src/mobile/styles/orders.css.ts — 委託頁與委託操作面板（routes/orders-page.tsx、components/order-action-sheet.tsx；規格 §6.5、§7.3、§11）
// 觸控目標 ≥ 44px、輸入字級 ≥ 16px；買賣一律有文字（不只靠顏色），漲跌用 vars.color.up／down。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { INPUT_FONT_SIZE, TOUCH_MIN } from './metrics';

// ---- 頁首 ----

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    marginBottom: vars.space.sm,
});

export const headerTitle = style({
    flex: '1 1 auto',
    margin: 0,
    fontSize: '1.25rem',
    fontWeight: 700,
});

const buttonBase = style({
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '0.9375rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const button = styleVariants({
    neutral: [buttonBase],
    danger: [buttonBase, { borderColor: vars.color.danger, color: vars.color.danger }],
    dangerSolid: [buttonBase, { background: vars.color.danger, borderColor: vars.color.danger, color: '#ffffff' }],
});

// ---- 分頁與帳戶篩選 ----

export const filterRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    flexWrap: 'wrap',
    marginBottom: vars.space.sm,
});

export const tabs = style({
    display: 'flex',
    gap: '6px',
    flex: '1 1 auto',
});

const tabBase = style([buttonBase, { flex: '1 1 0', minWidth: 0 }]);

export const tab = styleVariants({
    on: [tabBase, { background: vars.color.accentDim, borderColor: vars.color.accent }],
    off: [tabBase],
});

export const accountPicker = style({
    flex: '1 1 10rem',
    minHeight: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
});

// ---- 對帳 banner ----

export const banner = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    flexWrap: 'wrap',
    margin: `0 0 ${vars.space.sm}`,
    padding: vars.space.sm,
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.amber}`,
    color: vars.color.amber,
    fontSize: '0.875rem',
});

export const bannerText = style({ flex: '1 1 12rem' });

// ---- 委託列 ----

export const list = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    borderTop: `1px solid ${vars.color.border}`,
});

export const row = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: `${vars.space.sm} 0`,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const line = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    flexWrap: 'wrap',
    fontSize: '0.9375rem',
    fontVariantNumeric: 'tabular-nums',
});

export const code = style({ fontWeight: 700 });

export const sub = style({
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
});

export const warn = style({
    fontSize: '0.8125rem',
    color: vars.color.amber,
});

/** 買賣：文字＋顏色（不只靠顏色） */
export const side = styleVariants({
    Buy: { color: vars.color.up, fontWeight: 700 },
    Sell: { color: vars.color.down, fontWeight: 700 },
});

export const status = style({
    fontSize: '0.8125rem',
    padding: '0 6px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    color: vars.color.mutedForeground,
});

export const reservation = style({
    fontSize: '0.8125rem',
    color: vars.color.amber,
    fontWeight: 600,
});

export const rowActions = style({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '6px',
    flexWrap: 'wrap',
    marginTop: '2px',
});

export const empty = style({
    margin: `${vars.space.lg} 0`,
    textAlign: 'center',
    color: vars.color.mutedForeground,
});

export const footer = style({
    display: 'flex',
    justifyContent: 'center',
    marginTop: vars.space.md,
});

export const cancelAllButton = style([buttonBase, {
    width: '100%',
    minHeight: '52px',
    borderColor: vars.color.danger,
    color: vars.color.danger,
    fontSize: '1rem',
}]);

// ---- 操作面板 ----

export const sheetBody = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
});

export const summary = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: vars.space.sm,
    borderRadius: vars.radius.md,
    background: vars.color.inset,
});

export const menu = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(6rem, 1fr))',
    gap: vars.space.sm,
});

export const menuButton = styleVariants({
    neutral: [buttonBase, { minHeight: '52px', fontSize: '1rem' }],
    danger: [buttonBase, { minHeight: '52px', fontSize: '1rem', borderColor: vars.color.danger, color: vars.color.danger }],
});

export const fieldRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    flexWrap: 'wrap',
});

export const fieldLabel = style({
    flex: '0 0 auto',
    minWidth: '4.5em',
    fontSize: '0.9375rem',
    color: vars.color.mutedForeground,
});

export const stepper = style({
    display: 'grid',
    gridTemplateColumns: `${TOUCH_MIN} minmax(0, 1fr) ${TOUCH_MIN}`,
    alignItems: 'center',
    gap: '6px',
    flex: '1 1 12rem',
});

export const stepButton = style([buttonBase, { fontSize: '1.25rem', fontWeight: 700, padding: 0 }]);

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

export const problem = style({
    margin: 0,
    fontSize: '0.875rem',
    color: vars.color.amber,
});

export const notSent = style({
    margin: 0,
    fontSize: '0.9375rem',
    color: vars.color.danger,
    fontWeight: 600,
});

export const gateRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    flexWrap: 'wrap',
    minHeight: TOUCH_MIN,
    fontSize: '0.875rem',
    color: vars.color.amber,
});

export const checkbox = style({
    width: '22px',
    height: '22px',
    flex: '0 0 auto',
});

export const accountList = style({
    margin: 0,
    paddingLeft: '1.25rem',
    fontSize: '0.9375rem',
});
