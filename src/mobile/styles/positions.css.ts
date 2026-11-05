// src/mobile/styles/positions.css.ts — 持倉頁與平倉／加碼說明面板（規格 §6.6、§11）
// 顏色一律用 src/theme.css.ts 的 vars；多空與損益用 up／down，並一律附文字（多／空、正負號）。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { INPUT_FONT_SIZE, TOUCH_MIN } from './metrics';

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

export const accountSelect = style({
    minHeight: TOUCH_MIN,
    maxWidth: '55%',
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
});

export const refreshButton = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.lg,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '1.125rem',
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const banner = styleVariants({
    warn: {
        margin: `0 0 ${vars.space.sm}`,
        padding: `${vars.space.sm} ${vars.space.md}`,
        borderRadius: vars.radius.lg,
        border: `1px solid ${vars.color.amber}`,
        color: vars.color.amber,
        fontSize: '0.875rem',
    },
    info: {
        margin: `0 0 ${vars.space.sm}`,
        padding: `${vars.space.sm} ${vars.space.md}`,
        borderRadius: vars.radius.lg,
        border: `1px solid ${vars.color.border}`,
        color: vars.color.mutedForeground,
        fontSize: '0.875rem',
    },
});

export const summary = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
    margin: `0 0 ${vars.space.sm}`,
    padding: vars.space.md,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    fontSize: '0.9375rem',
});

export const summaryMain = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: vars.space.xs,
});

export const summaryLabel = style({
    color: vars.color.mutedForeground,
    fontSize: '0.8125rem',
});

export const summaryGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(8.5rem, 1fr))',
    gap: vars.space.xs,
    margin: 0,
});

export const summaryItem = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const summaryItemValue = style({
    margin: 0,
    fontSize: '1rem',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
});

export const summaryNote = style({
    margin: 0,
    color: vars.color.mutedForeground,
    fontSize: '0.8125rem',
    fontWeight: 400,
});

/** 風險等級：狀態色（不隨漲跌配色翻轉），並一律附文字 */
export const risk = styleVariants({
    danger: { color: vars.color.danger },
    warn: { color: vars.color.amber },
    ok: {},
});

export const summaryValue = style({
    fontSize: '1.25rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
});

export const estimate = style({
    color: vars.color.mutedForeground,
    fontSize: '0.8125rem',
});

export const tone = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.flat },
});

export const list = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
});

export const row = style({
    padding: vars.space.md,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
});

export const rowHead = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: vars.space.sm,
    rowGap: vars.space.xs,
    fontSize: '1rem',
});

export const rowCode = style({
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
});

export const rowName = style({
    color: vars.color.mutedForeground,
});

export const tag = style({
    padding: '1px 6px',
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.border}`,
    fontSize: '0.8125rem',
});

export const side = styleVariants({
    long: { fontWeight: 700, color: vars.color.up },
    short: { fontWeight: 700, color: vars.color.down },
});

export const rowMeta = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: vars.space.xs,
    marginTop: vars.space.xs,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
});

export const rowNums = style({
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: vars.space.md,
    rowGap: vars.space.xs,
    marginTop: vars.space.xs,
    fontSize: '0.9375rem',
    fontVariantNumeric: 'tabular-nums',
});

export const numLabel = style({
    color: vars.color.mutedForeground,
    marginRight: '4px',
});

export const rowActions = style({
    display: 'flex',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: vars.space.sm,
    marginTop: vars.space.sm,
});

export const rowNote = style({
    margin: `${vars.space.xs} 0 0`,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
    textAlign: 'right',
});

export const empty = style({
    margin: `${vars.space.lg} 0`,
    textAlign: 'center',
    color: vars.color.mutedForeground,
});

// ---- 說明面板（平倉、加碼切換帳戶）----

export const sheetText = style({
    margin: `0 0 ${vars.space.sm}`,
    fontSize: '0.9375rem',
    lineHeight: 1.6,
});

export const sheetList = style({
    margin: `0 0 ${vars.space.sm}`,
    paddingLeft: '1.25rem',
    fontSize: '0.9375rem',
    lineHeight: 1.6,
});

export const sheetSummary = style({
    margin: `0 0 ${vars.space.sm}`,
    padding: vars.space.sm,
    borderRadius: vars.radius.lg,
    background: vars.color.inset,
    fontSize: '1rem',
    fontWeight: 600,
});

export const sheetProblem = style({
    margin: `0 0 ${vars.space.sm}`,
    fontSize: '0.9375rem',
    color: vars.color.amber,
});

export const sheetFeedback = styleVariants({
    cancelled: { margin: `0 0 ${vars.space.sm}`, fontSize: '0.9375rem', color: vars.color.mutedForeground },
    notSent: { margin: `0 0 ${vars.space.sm}`, fontSize: '0.9375rem', color: vars.color.danger },
});

export const sheetActions = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: vars.space.sm,
    marginTop: vars.space.sm,
});

// ---- 篩選與排序 ----

export const filterRow = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: vars.space.sm,
    marginBottom: vars.space.sm,
});

export const segment = style({
    display: 'flex',
    flex: '1 1 16rem',
    minWidth: 0,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    overflow: 'hidden',
});

const segmentButtonBase = style({
    flex: '1 1 0',
    minWidth: 0,
    minHeight: TOUCH_MIN,
    padding: `0 ${vars.space.xs}`,
    border: 'none',
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '0.9375rem',
    selectors: {
        '&:not(:first-child)': { borderLeft: `1px solid ${vars.color.border}` },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

export const segmentButton = styleVariants({
    off: [segmentButtonBase],
    on: [segmentButtonBase, { background: vars.color.accent, color: '#ffffff', fontWeight: 700 }],
});

export const sortSelect = style({
    minHeight: TOUCH_MIN,
    flex: '0 1 auto',
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
});

export const filterNote = style({
    margin: `0 0 ${vars.space.sm}`,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
});

// ---- 帳戶分組 ----

export const group = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    marginBottom: vars.space.md,
});

export const groupHeader = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: vars.space.sm,
    rowGap: '2px',
    padding: `0 ${vars.space.xs}`,
    fontSize: '0.875rem',
});

export const groupTitle = style({
    fontWeight: 700,
});

export const groupStat = style({
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

// ---- 持倉列：數字格與損益條 ----

export const rowGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: `${vars.space.xs} ${vars.space.sm}`,
    margin: `${vars.space.sm} 0 0`,
    fontSize: '0.9375rem',
    fontVariantNumeric: 'tabular-nums',
});

export const rowCell = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    overflowWrap: 'anywhere',
});

export const cellLabel = style({
    color: vars.color.mutedForeground,
    fontSize: '0.75rem',
});

export const cellValue = style({
    margin: 0,
});

/** 損益條：中線為 0，向右＝獲利（up）、向左＝虧損（down）；旁邊一律有損益文字 */
export const pnlBar = style({
    position: 'relative',
    height: '6px',
    marginTop: vars.space.sm,
    borderRadius: '3px',
    background: vars.color.inset,
    overflow: 'hidden',
});

export const pnlBarMid = style({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '50%',
    width: '1px',
    background: vars.color.borderBright,
});

const pnlFillBase = style({
    position: 'absolute',
    top: 0,
    bottom: 0,
});

export const pnlBarFill = styleVariants({
    up: [pnlFillBase, { left: '50%', background: vars.color.up }],
    down: [pnlFillBase, { right: '50%', background: vars.color.down }],
});

export const detailToggle = style({
    minHeight: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.lg,
    background: 'transparent',
    color: vars.color.foreground,
    fontSize: '0.875rem',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

// ---- 玉山庫存明細（展開區）----

export const detail = style({
    marginTop: vars.space.sm,
    padding: vars.space.sm,
    borderRadius: vars.radius.lg,
    background: vars.color.inset,
    fontSize: '0.875rem',
});

export const detailHead = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: vars.space.xs,
});

export const detailTitle = style({
    margin: `${vars.space.sm} 0 ${vars.space.xs}`,
    fontSize: '0.875rem',
    fontWeight: 700,
});

export const detailGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))',
    gap: `${vars.space.xs} ${vars.space.sm}`,
    margin: 0,
});

export const detailItem = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const detailLabel = style({
    color: vars.color.mutedForeground,
    fontSize: '0.75rem',
});

export const detailValue = style({
    margin: 0,
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
});

export const detailNote = style({
    margin: `${vars.space.xs} 0 0`,
    color: vars.color.mutedForeground,
    fontSize: '0.8125rem',
    lineHeight: 1.5,
});

export const detailEmpty = style({
    margin: `${vars.space.sm} 0 0`,
    padding: vars.space.sm,
    borderRadius: vars.radius.lg,
    background: vars.color.inset,
    color: vars.color.mutedForeground,
    fontSize: '0.875rem',
});

export const formulaList = style({
    margin: 0,
    paddingLeft: '1.25rem',
    lineHeight: 1.6,
    fontVariantNumeric: 'tabular-nums',
});

export const lotList = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
});

export const lot = style({
    padding: vars.space.sm,
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
});

export const lotHead = style({
    display: 'flex',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    marginBottom: vars.space.xs,
    fontVariantNumeric: 'tabular-nums',
});
