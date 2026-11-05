// src/mobile/styles/order-ticket.css.ts — 下單面板（order-ticket-sheet.tsx，規格 §6.3、§11）
// 版面參考券商 App：方向 → 精簡報價 → 標籤 → 整股／零股 → 條件摘要（可展開）→ 價格 → 數量 → 額度／價金 → 預覽 → 五檔。
// 觸控目標 ≥ 44px、輸入字級 ≥ 16px；買賣一律有文字；方向與漲跌顏色只用 vars.color.up／down（跟著使用者的配色切換）。
// 不用 color-mix()、:has()（iOS 15.4 Safari）；半透明底色一律用 vars 既有的 *Dim（rgba）。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { INPUT_FONT_SIZE, TOUCH_MIN, TRADE_BUTTON_GAP, TRADE_BUTTON_MIN_HEIGHT } from './metrics';

export const form = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
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

// ---- 方向（頂端大字＋買進／賣出分段）----

const bannerBase = style({
    margin: 0,
    fontSize: '1.625rem',
    fontWeight: 800,
    lineHeight: 1.2,
    letterSpacing: '0.04em',
    overflowWrap: 'anywhere',
});

/** 頂端大字方向：買進用 up、賣出用 down；未選方向中性 */
export const directionBanner = styleVariants({
    buy: [bannerBase, { color: vars.color.up }],
    sell: [bannerBase, { color: vars.color.down }],
    none: [bannerBase, { color: vars.color.mutedForeground, fontSize: '1.125rem', fontWeight: 700 }],
});

export const actionRow = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: TRADE_BUTTON_GAP,
});

const actionBase = style({
    minHeight: TRADE_BUTTON_MIN_HEIGHT,
    borderRadius: vars.radius.lg,
    border: '2px solid',
    fontSize: '1.25rem',
    fontWeight: 800,
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

/** 已選：實心；未選：外框＋同色文字（文字一律存在，不只靠顏色） */
export const action = styleVariants({
    buyOn: [actionBase, { background: vars.color.up, borderColor: vars.color.up, color: '#ffffff' }],
    buyOff: [actionBase, { background: vars.color.panel, borderColor: vars.color.up, color: vars.color.up }],
    sellOn: [actionBase, { background: vars.color.down, borderColor: vars.color.down, color: '#ffffff' }],
    sellOff: [actionBase, { background: vars.color.panel, borderColor: vars.color.down, color: vars.color.down }],
});

// ---- 精簡報價列 ----

export const quoteRow = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    flexWrap: 'wrap',
    padding: `${vars.space.xs} ${vars.space.sm}`,
    borderRadius: vars.radius.md,
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
});

export const quoteMain = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: '0 8px',
    flexWrap: 'wrap',
    minWidth: 0,
});

export const quoteName = style({
    fontSize: '1rem',
    fontWeight: 700,
});

const quoteNumBase = style({ fontVariantNumeric: 'tabular-nums', fontWeight: 700 });

export const quotePrice = styleVariants({
    up: [quoteNumBase, { color: vars.color.up, fontSize: '1.125rem' }],
    down: [quoteNumBase, { color: vars.color.down, fontSize: '1.125rem' }],
    flat: [quoteNumBase, { color: vars.color.flat, fontSize: '1.125rem' }],
});

export const quoteChange = styleVariants({
    up: [quoteNumBase, { color: vars.color.up, fontSize: '0.875rem' }],
    down: [quoteNumBase, { color: vars.color.down, fontSize: '0.875rem' }],
    flat: [quoteNumBase, { color: vars.color.flat, fontSize: '0.875rem' }],
});

export const quoteVolume = style({
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
});

// ---- 標籤、帳戶 ----

export const tagRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
});

export const tag = style({
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '24px',
    padding: '0 8px',
    borderRadius: '999px',
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panel,
    fontSize: '0.8125rem',
    fontWeight: 600,
});

export const accountRow = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    fontSize: '0.875rem',
});

// ---- 分段選擇（整股／零股、條件、價別、效期、倉別）----

/** 等寬分段（像 iOS 的 segmented control）：整列平分 */
export const segmented = style({
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: 'minmax(0, 1fr)',
    gap: '4px',
    padding: '3px',
    borderRadius: vars.radius.lg,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
});

const segBase = style({
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.xs}`,
    borderRadius: vars.radius.md,
    border: '1px solid transparent',
    fontSize: '0.9375rem',
    fontWeight: 600,
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const seg = styleVariants({
    on: [segBase, { background: vars.color.panelRaised, borderColor: vars.color.accent, color: vars.color.foreground, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)' }],
    off: [segBase, { background: 'transparent', color: vars.color.mutedForeground }],
});

/** 一般按鈕（使用此價格、重試、改用融券…） */
export const plainButton = style([segBase, {
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    border: `1px solid ${vars.color.borderBright}`,
    padding: `0 ${vars.space.sm}`,
}]);

export const fieldBlock = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
});

export const fieldLabel = style({
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
});

/** 條件摘要列「現股 / 盤中 / ROD ▾」：整列是一個按鈕 */
export const condSummary = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    minHeight: TOUCH_MIN,
    width: '100%',
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panel,
    color: vars.color.foreground,
    fontSize: '1rem',
    fontWeight: 700,
    textAlign: 'left',
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const condPanel = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: vars.space.sm,
    borderRadius: vars.radius.md,
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
});

/** 現股當沖先賣（勾選鍵）：勾選時用賣出色外框＋✓ 文字 */
export const daytradeToggle = styleVariants({
    on: [segBase, { width: '100%', background: vars.color.downDim, borderColor: vars.color.down, color: vars.color.foreground }],
    off: [segBase, { width: '100%', background: vars.color.panelRaised, borderColor: vars.color.borderBright, color: vars.color.foreground }],
});

// ---- 價格／數量 ----

export const priceRow = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(5.5rem, auto) minmax(0, 1fr)',
    alignItems: 'center',
    gap: '6px',
});

export const select = style({
    minHeight: TOUCH_MIN,
    width: '100%',
    boxSizing: 'border-box',
    padding: `0 ${vars.space.xs}`,
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
    fontWeight: 600,
    selectors: {
        '&:disabled': { opacity: 0.6 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '1px' },
    },
});

export const stepper = style({
    display: 'grid',
    gridTemplateColumns: `${TOUCH_MIN} minmax(0, 1fr) ${TOUCH_MIN}`,
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
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
    minWidth: 0,
    boxSizing: 'border-box',
    padding: `0 ${vars.space.xs}`,
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.inset,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
    selectors: {
        '&:disabled': { opacity: 0.6 },
        '&[aria-invalid="true"]': { borderColor: vars.color.amber },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '1px' },
    },
});

/** 數量列：步進＋單位 */
export const qtyRow = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: vars.space.sm,
});

export const unit = style({
    minWidth: '1.5em',
    fontSize: '1rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

/** 即時成交價（漲跌色＋前置符號，不只靠顏色） */
export const livePrice = styleVariants({
    up: { color: vars.color.up, fontVariantNumeric: 'tabular-nums', fontSize: '0.875rem' },
    down: { color: vars.color.down, fontVariantNumeric: 'tabular-nums', fontSize: '0.875rem' },
    flat: { color: vars.color.flat, fontVariantNumeric: 'tabular-nums', fontSize: '0.875rem' },
});

export const quickRow = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(3.75rem, 1fr))',
    gap: '6px',
});

export const quickButton = style([segBase, {
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
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

// ---- 額度、價金、成本 ----

export const infoGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
    gap: '4px 12px',
    padding: `${vars.space.xs} ${vars.space.sm}`,
    borderRadius: vars.radius.md,
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
});

export const infoCell = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
});

export const infoLabel = style({
    fontSize: '0.75rem',
    color: vars.color.mutedForeground,
});

export const infoValue = style({
    fontSize: '1rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
});

export const costRow = style({
    margin: 0,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
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

/** 信用提醒（持倉衝突；只提示） */
export const hintRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    flexWrap: 'wrap',
    fontSize: '0.8125rem',
    color: vars.color.amber,
});

export const feedback = styleVariants({
    cancelled: { margin: 0, fontSize: '0.9375rem', color: vars.color.mutedForeground },
    'not-sent': { margin: 0, fontSize: '0.9375rem', color: vars.color.danger, fontWeight: 600 },
});

// ---- 預覽鍵（方向色＋完整文字）----

const previewBase = style({
    minHeight: TRADE_BUTTON_MIN_HEIGHT,
    width: '100%',
    padding: `${vars.space.xs} ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    border: '2px solid transparent',
    fontSize: '1.0625rem',
    fontWeight: 800,
    lineHeight: 1.3,
    overflowWrap: 'anywhere',
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.foreground}`, outlineOffset: '2px' },
    },
});

export const previewButton = styleVariants({
    buy: [previewBase, { background: vars.color.up, borderColor: vars.color.up, color: '#ffffff' }],
    sell: [previewBase, { background: vars.color.down, borderColor: vars.color.down, color: '#ffffff' }],
    none: [previewBase, { background: vars.color.panelRaised, borderColor: vars.color.borderBright, color: vars.color.mutedForeground }],
});

export const ladderWrap = style({
    marginTop: vars.space.xs,
    paddingTop: vars.space.sm,
    borderTop: `1px solid ${vars.color.border}`,
});
