// src/mobile/styles/trade.css.ts — 交易頁：標頭、圖表、五檔、明細、底部買賣鍵（規格 §6.2、§11）
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { TOUCH_MIN } from './metrics';

export const page = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100%',
});

// ---- 標頭 ----

export const header = style({
    padding: `${vars.space.sm} ${vars.space.md} ${vars.space.xs}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
});

export const titleRow = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: vars.space.sm,
    flexWrap: 'wrap',
});

export const title = style({
    margin: 0,
    fontSize: '1.125rem',
    fontWeight: 700,
});

export const subtle = style({
    color: vars.color.mutedForeground,
    fontSize: '0.8125rem',
});

export const priceRow = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: vars.space.sm,
    flexWrap: 'wrap',
    fontVariantNumeric: 'tabular-nums',
});

export const lastPrice = style({
    fontSize: '1.625rem',
    fontWeight: 700,
    fontFamily: vars.font.mono,
});

export const dirText = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.foreground },
});

export const change = style({
    fontSize: '0.9375rem',
    fontWeight: 600,
    fontFamily: vars.font.mono,
});

export const infoRow = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: `2px ${vars.space.sm}`,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const infoUp = style({ color: vars.color.up });
export const infoDown = style({ color: vars.color.down });

// ---- 分段切換（週期列、五檔／明細） ----

export const segmentRow = style({
    display: 'flex',
    gap: '2px',
    padding: `0 ${vars.space.sm}`,
    overflowX: 'auto',
    scrollbarWidth: 'none',
    borderBottom: `1px solid ${vars.color.border}`,
});

export const segment = style({
    flex: '1 0 auto',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    border: 'none',
    borderBottom: '2px solid transparent',
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: '0.9375rem',
    selectors: {
        '&[aria-pressed="true"], &[aria-selected="true"]': { color: vars.color.foreground, fontWeight: 700, borderBottomColor: vars.color.accent },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

// ---- 圖表 ----

export const chartWrap = style({
    position: 'relative',
    height: '42dvh',
    minHeight: '220px',
    maxHeight: '520px',
    // 單指水平平移、雙指縮放交給 lightweight-charts（handleScroll／handleScale）；垂直滑動仍可捲動頁面
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
});

export const chartHost = style({
    position: 'absolute',
    inset: 0,
});

export const chartOverlay = style({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: vars.space.sm,
    color: vars.color.mutedForeground,
    fontSize: '0.875rem',
    pointerEvents: 'none',
});

export const chartOverlayAction = style({
    pointerEvents: 'auto',
});

export const chartNote = style({
    margin: 0,
    padding: `2px ${vars.space.md}`,
    fontSize: '0.75rem',
    color: vars.color.mutedForeground,
});

/** 委託線標籤：可見膠囊較小，但點擊區至少 44px 高 */
export const orderLabel = style({
    position: 'absolute',
    left: vars.space.xs,
    transform: 'translateY(-50%)',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: 0,
    border: 'none',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    zIndex: 2,
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

const orderPillBase = style({
    padding: '2px 8px',
    borderRadius: vars.radius.md,
    fontSize: '0.75rem',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    color: '#ffffff',
    fontVariantNumeric: 'tabular-nums',
});

export const orderPill = styleVariants({
    buy: [orderPillBase, { background: vars.color.up }],
    sell: [orderPillBase, { background: vars.color.down }],
});

/** 長按放開後浮出的「以 X 買進／賣出」 */
export const pickBar = style({
    position: 'absolute',
    left: vars.space.sm,
    right: vars.space.sm,
    bottom: vars.space.sm,
    zIndex: 3,
    display: 'grid',
    gridTemplateColumns: '1fr 1fr auto',
    gap: vars.space.sm,
    padding: vars.space.sm,
    borderRadius: vars.radius.lg,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
});

const pickButtonBase = style({
    minHeight: TOUCH_MIN,
    borderRadius: vars.radius.lg,
    border: 'none',
    color: '#ffffff',
    fontSize: '0.9375rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.foreground}`, outlineOffset: '2px' },
    },
});

export const pickButton = styleVariants({
    buy: [pickButtonBase, { background: vars.color.up }],
    sell: [pickButtonBase, { background: vars.color.down }],
    cancel: [pickButtonBase, { background: 'transparent', color: vars.color.mutedForeground, minWidth: TOUCH_MIN, padding: `0 ${vars.space.sm}` }],
});

// ---- 五檔 ----

export const ladder = style({
    display: 'flex',
    flexDirection: 'column',
    padding: `${vars.space.xs} ${vars.space.md}`,
    fontVariantNumeric: 'tabular-nums',
});

export const ladderHead = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1.2fr 1fr',
    fontSize: '0.75rem',
    color: vars.color.mutedForeground,
    padding: `${vars.space.xs} 0`,
});

export const ladderRow = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1.2fr 1fr',
    alignItems: 'center',
    minHeight: TOUCH_MIN,
    width: '100%',
    padding: 0,
    border: 'none',
    borderBottom: `1px solid ${vars.color.border}`,
    background: 'transparent',
    color: vars.color.foreground,
    fontSize: '0.9375rem',
    textAlign: 'center',
    selectors: {
        '&:active': { background: vars.color.muted },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

export const ladderVol = style({
    fontFamily: vars.font.mono,
});

export const ladderPrice = style({
    fontFamily: vars.font.mono,
    fontWeight: 600,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    lineHeight: 1.2,
});

export const ladderSideTag = style({
    fontSize: '0.6875rem',
    color: vars.color.mutedForeground,
    fontWeight: 400,
});

export const ladderMine = style({
    display: 'inline-block',
    marginTop: '1px',
    padding: '0 6px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.accent}`,
    color: vars.color.accent,
    fontSize: '0.6875rem',
    fontWeight: 700,
});

export const ladderToolbar = style({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: vars.space.xs,
    paddingTop: vars.space.xs,
});

export const toggle = style({
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.md}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: '0.875rem',
    selectors: {
        '&[aria-pressed="true"]': { background: vars.color.accentDim, borderColor: vars.color.accent, color: vars.color.accent, fontWeight: 700 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const emptyText = style({
    margin: 0,
    padding: `${vars.space.md} 0`,
    textAlign: 'center',
    color: vars.color.mutedForeground,
    fontSize: '0.875rem',
});

// ---- 明細 ----

export const tickList = style({
    listStyle: 'none',
    margin: 0,
    padding: `0 ${vars.space.md}`,
    fontVariantNumeric: 'tabular-nums',
    fontFamily: vars.font.mono,
    fontSize: '0.875rem',
});

export const tickRow = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 0.8fr 2.5em',
    alignItems: 'center',
    minHeight: '32px',
    borderBottom: `1px solid ${vars.color.border}`,
});

export const tickTime = style({ color: vars.color.mutedForeground });
export const tickNum = style({ textAlign: 'right' });
export const tickSide = style({ textAlign: 'right', fontSize: '0.75rem', fontFamily: vars.font.body });

// ---- 持倉摘要、未成交、底部買賣鍵 ----

export const summary = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: `${vars.space.sm} ${vars.space.md}`,
    borderTop: `1px solid ${vars.color.border}`,
    fontSize: '0.875rem',
    fontVariantNumeric: 'tabular-nums',
});

export const workingLink = style({
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: TOUCH_MIN,
    color: vars.color.accent,
    textDecoration: 'none',
    fontWeight: 600,
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const tradeBar = style({
    position: 'sticky',
    bottom: 0,
    zIndex: 5,
    marginTop: 'auto',
    padding: `${vars.space.sm} ${vars.space.md}`,
    background: vars.color.panel,
    borderTop: `1px solid ${vars.color.border}`,
});

export const tradeBarNote = style({
    margin: `0 0 ${vars.space.xs}`,
    fontSize: '0.8125rem',
    color: vars.color.amber,
});
