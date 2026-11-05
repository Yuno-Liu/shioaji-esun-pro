// src/mobile/styles/account.css.ts — 帳戶頁（規格 §6.7、§11）
// 狀態色（成功／錯誤／正式環境）用 success／danger；不隨漲跌配色翻轉。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { INPUT_FONT_SIZE, TOUCH_MIN } from './metrics';

export const card = style({
    margin: `0 0 ${vars.space.md}`,
    padding: vars.space.md,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
});

export const cardHeader = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    marginBottom: vars.space.sm,
});

export const cardTitle = style({
    flex: '1 1 auto',
    margin: 0,
    fontSize: '1.0625rem',
    fontWeight: 700,
});

export const subTitle = style({
    margin: `${vars.space.sm} 0 ${vars.space.xs}`,
    fontSize: '0.9375rem',
    fontWeight: 700,
    color: vars.color.mutedForeground,
});

export const kv = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(7rem, auto) 1fr',
    columnGap: vars.space.sm,
    rowGap: vars.space.xs,
    margin: 0,
    fontSize: '0.9375rem',
});

export const term = style({ color: vars.color.mutedForeground });

export const value = style({
    margin: 0,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    wordBreak: 'break-all',
});

export const tone = styleVariants({
    normal: {},
    muted: { color: vars.color.mutedForeground },
    accent: { color: vars.color.accent },
    good: { color: vars.color.success },
    warn: { color: vars.color.amber },
    bad: { color: vars.color.danger },
});

export const note = style({
    margin: `${vars.space.sm} 0 0`,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
});

export const warning = style({
    margin: `${vars.space.sm} 0 0`,
    fontSize: '0.8125rem',
    color: vars.color.amber,
});

export const actions = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: vars.space.sm,
    marginTop: vars.space.sm,
});

export const smallButton = style({
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
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

// ---- 帳號槽位 ----

export const slot = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    minHeight: TOUCH_MIN,
    borderBottom: `1px solid ${vars.color.border}`,
    selectors: { '&:last-of-type': { borderBottom: 'none' } },
});

export const slotLabel = style({
    flex: '0 0 auto',
    minWidth: '5.5rem',
    color: vars.color.mutedForeground,
    fontSize: '0.875rem',
});

export const slotValue = style({
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

// ---- 設定列（開關、分段、數字） ----

export const settingRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    minHeight: '52px',
    borderBottom: `1px solid ${vars.color.border}`,
    selectors: { '&:last-child': { borderBottom: 'none' } },
});

export const settingLabel = style({
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
});

export const settingHint = style({
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
});

/** 開關（role=switch）：外框 ≥ 44pt 觸控區，內部軌道 51×31 */
export const switchButton = style({
    flex: '0 0 auto',
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '60px',
    minHeight: TOUCH_MIN,
    padding: 0,
    border: 'none',
    background: 'transparent',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px', borderRadius: '16px' },
        '&:disabled': { cursor: 'not-allowed' },
    },
});

export const switchTrack = style({
    position: 'relative',
    width: '51px',
    height: '31px',
    borderRadius: '16px',
    background: vars.color.muted,
    border: `1px solid ${vars.color.borderBright}`,
    transition: 'background 160ms ease-out',
    selectors: {
        [`${switchButton}[aria-checked="true"] &`]: { background: vars.color.success, borderColor: vars.color.success },
        [`${switchButton}:disabled &`]: { opacity: 0.6 },
    },
});

export const switchThumb = style({
    position: 'absolute',
    top: '2px',
    left: '2px',
    width: '25px',
    height: '25px',
    borderRadius: '50%',
    background: '#ffffff',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.35)',
    transition: 'left 160ms ease-out',
    selectors: {
        [`${switchButton}[aria-checked="true"] &`]: { left: '22px' },
    },
});

export const segmented = style({
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: '1fr',
    gap: '2px',
    padding: '2px',
    borderRadius: vars.radius.lg,
    background: vars.color.muted,
    width: '100%',
});

export const segment = style({
    minHeight: TOUCH_MIN,
    padding: `0 ${vars.space.xs}`,
    border: 'none',
    borderRadius: vars.radius.md,
    background: 'transparent',
    color: vars.color.foreground,
    fontSize: '0.9375rem',
    selectors: {
        '&[aria-pressed="true"]': { background: vars.color.panelRaised, fontWeight: 700, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)' },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

export const settingBlock = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
    padding: `${vars.space.sm} 0`,
    borderBottom: `1px solid ${vars.color.border}`,
    selectors: { '&:last-child': { borderBottom: 'none' } },
});

export const numberInput = style({
    flex: '0 0 auto',
    width: '7.5rem',
    minHeight: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.inset,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
    textAlign: 'right',
    boxSizing: 'border-box',
    selectors: {
        '&:disabled': { opacity: 0.5 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '1px' },
    },
});

// ---- 風控 ----

export const lockState = styleVariants({
    locked: {
        display: 'flex',
        alignItems: 'center',
        gap: vars.space.xs,
        padding: vars.space.sm,
        borderRadius: vars.radius.lg,
        border: `1px solid ${vars.color.danger}`,
        background: vars.color.dangerDim,
        color: vars.color.danger,
        fontWeight: 700,
    },
    open: {
        display: 'flex',
        alignItems: 'center',
        gap: vars.space.xs,
        padding: vars.space.sm,
        borderRadius: vars.radius.lg,
        border: `1px solid ${vars.color.border}`,
        color: vars.color.mutedForeground,
    },
});

export const lockedOnBadge = style({
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.success}`,
    color: vars.color.success,
    fontSize: '0.8125rem',
    fontWeight: 700,
    whiteSpace: 'nowrap',
});

export const deviceOnly = style({
    margin: `${vars.space.sm} 0 0`,
    padding: vars.space.sm,
    borderRadius: vars.radius.md,
    background: vars.color.muted,
    fontSize: '0.8125rem',
    color: vars.color.foreground,
});

export const meter = style({
    position: 'relative',
    height: '6px',
    marginTop: vars.space.xs,
    borderRadius: '3px',
    background: vars.color.muted,
    overflow: 'hidden',
});

export const meterFill = styleVariants({
    normal: { position: 'absolute', top: 0, bottom: 0, left: 0, background: vars.color.accent },
    warning: { position: 'absolute', top: 0, bottom: 0, left: 0, background: vars.color.amber },
    danger: { position: 'absolute', top: 0, bottom: 0, left: 0, background: vars.color.danger },
    muted: { position: 'absolute', top: 0, bottom: 0, left: 0, background: vars.color.borderBright },
});

export const ua = style({
    gridColumn: '1 / -1',
    margin: 0,
    fontSize: '0.75rem',
    fontFamily: vars.font.mono,
    color: vars.color.mutedForeground,
    wordBreak: 'break-all',
});

// ---- 共用：漲跌方向文字色（買進／正值用 up、賣出／負值用 down；文字另帶正負號，不只靠顏色） ----

export const dir = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: {},
});

/** 可展開區塊的標題鍵（整列皆可點，≥ 44px） */
export const disclosure = style({
    flex: '1 1 auto',
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: vars.space.xs,
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    fontSize: '1.0625rem',
    fontWeight: 700,
    textAlign: 'left',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px', borderRadius: vars.radius.md },
    },
});

export const badge = style({
    display: 'inline-block',
    marginLeft: vars.space.xs,
    padding: '0 6px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.borderBright}`,
    color: vars.color.mutedForeground,
    fontSize: '0.75rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
});

export const badgeWarn = style({ borderColor: vars.color.amber, color: vars.color.amber });

export const toggleRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    width: '100%',
    minHeight: TOUCH_MIN,
    marginTop: vars.space.xs,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: '0.875rem',
    textAlign: 'left',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px', borderRadius: vars.radius.md },
    },
});

// ---- 期貨風險指標色條 ----

export const riskTrack = style({
    position: 'relative',
    height: '8px',
    margin: `${vars.space.xs} 0 0`,
    borderRadius: '4px',
    background: vars.color.muted,
    overflow: 'hidden',
});

const riskFillBase = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: '4px',
    transition: 'width 200ms ease-out',
    '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } },
} as const;

export const riskFill = styleVariants({
    danger: { ...riskFillBase, background: vars.color.danger },
    warn: { ...riskFillBase, background: vars.color.amber },
    safe: { ...riskFillBase, background: vars.color.success },
    none: { ...riskFillBase, background: 'transparent' },
});

// ---- 交割行事曆 ----

export const settleRow = style({
    display: 'grid',
    gridTemplateColumns: '3.25rem 1fr auto',
    alignItems: 'center',
    columnGap: vars.space.sm,
    minHeight: '2.25rem',
    borderBottom: `1px solid ${vars.color.border}`,
    fontVariantNumeric: 'tabular-nums',
    selectors: { '&:last-of-type': { borderBottom: 'none' } },
});

export const settleTag = style({
    fontWeight: 700,
    fontSize: '0.875rem',
});

export const settleDate = style({
    color: vars.color.mutedForeground,
    fontSize: '0.875rem',
});

export const settleAmount = style({
    textAlign: 'right',
    fontWeight: 600,
});

// ---- 已實現損益 ----

export const totalLine = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    margin: `${vars.space.sm} 0 0`,
    fontVariantNumeric: 'tabular-nums',
});

export const totalValue = style({
    fontSize: '1.25rem',
    fontWeight: 700,
});

export const pnlItem = style({
    borderBottom: `1px solid ${vars.color.border}`,
    selectors: { '&:last-child': { borderBottom: 'none' } },
});

export const pnlRow = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    alignItems: 'center',
    columnGap: vars.space.sm,
    minHeight: TOUCH_MIN,
    fontVariantNumeric: 'tabular-nums',
});

export const pnlCode = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    overflow: 'hidden',
});

export const pnlMeta = style({
    fontSize: '0.75rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const pnlQty = style({
    fontSize: '0.875rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const pnlValue = style({
    textAlign: 'right',
    fontWeight: 600,
    whiteSpace: 'nowrap',
});

export const detailBox = style({
    margin: `0 0 ${vars.space.sm}`,
    padding: vars.space.sm,
    borderRadius: vars.radius.md,
    background: vars.color.inset,
});

export const fillCard = style({
    padding: `${vars.space.xs} 0`,
    borderTop: `1px dashed ${vars.color.border}`,
    fontSize: '0.8125rem',
});

export const fillHead = style({
    display: 'flex',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    fontWeight: 600,
});
