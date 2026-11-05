// src/mobile/styles/chart.css.ts — 交易圖表外框、圖例、工具列、橫向全螢幕、指標面板（規格 §6.2、§11、Phase 2／3）
//
// 交易頁其餘樣式在 trade.css.ts（交易頁擁有）；圖表新增的樣式一律放這裡。
// 顏色一律用 theme vars（買進 up、賣出 down）；觸控目標 ≥ 44px；輸入字級 ≥ 16px；
// 不用 color-mix()／:has()（iOS 15.4 Safari）；不加動畫（不必另處理 prefers-reduced-motion）。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { INPUT_FONT_SIZE, SAFE_BOTTOM, SAFE_LEFT, SAFE_RIGHT, SAFE_TOP, TOUCH_MIN, Z } from './metrics';

/** 每個副圖增加的高度（px）；trade-chart 也用這個值設定副圖高度 */
export const PANE_HEIGHT_PX = 96;
/** 全螢幕覆蓋層：蓋過狀態列、底部分頁與交易頁買賣列，但在底部面板（下單、指標）之下 */
export const Z_CHART_FULLSCREEN = Z.bars + 40;

// ---- 外框 ----

export const root = style({
    position: 'relative',
});

/** 全螢幕：固定定位覆蓋全畫面，留安全區 */
export const rootFullscreen = style({
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: Z_CHART_FULLSCREEN,
    display: 'flex',
    flexDirection: 'column',
    background: vars.color.background,
    color: vars.color.foreground,
    paddingTop: SAFE_TOP,
    paddingBottom: SAFE_BOTTOM,
    paddingLeft: SAFE_LEFT,
    paddingRight: SAFE_RIGHT,
    overscrollBehavior: 'contain',
});

const frameBase = style({
    position: 'relative',
    // 單指水平平移、雙指縮放交給 lightweight-charts（handleScroll／handleScale）；垂直滑動仍可捲動頁面
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
});

/** 一般模式：依副圖數量加高（不支援 dvh 時退回 vh） */
export const frame = styleVariants({
    0: [frameBase, { height: ['42vh', '42dvh'], minHeight: '220px', maxHeight: '520px' }],
    1: [frameBase, { height: [`calc(42vh + ${PANE_HEIGHT_PX}px)`, `calc(42dvh + ${PANE_HEIGHT_PX}px)`], minHeight: `${220 + PANE_HEIGHT_PX}px`, maxHeight: `${520 + PANE_HEIGHT_PX}px` }],
    2: [frameBase, { height: [`calc(42vh + ${PANE_HEIGHT_PX * 2}px)`, `calc(42dvh + ${PANE_HEIGHT_PX * 2}px)`], minHeight: `${220 + PANE_HEIGHT_PX * 2}px`, maxHeight: `${520 + PANE_HEIGHT_PX * 2}px` }],
});

/** 全螢幕：填滿工具列與買賣列之間；所有觸控手勢交給圖表（不捲動底下的頁面） */
export const frameFullscreen = style([frameBase, {
    flex: '1 1 auto',
    minHeight: 0,
    touchAction: 'none',
}]);

// ---- 圖例（左上角：指標名稱＋最新值；長按追蹤時顯示該根的值） ----

export const legend = style({
    position: 'absolute',
    top: '4px',
    left: vars.space.sm,
    right: '64px', // 留給右側價格軸
    zIndex: 1,
    display: 'flex',
    flexWrap: 'wrap',
    gap: `0 ${vars.space.sm}`,
    fontSize: '0.6875rem',
    lineHeight: 1.5,
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.mutedForeground,
    pointerEvents: 'none',
});

export const legendItem = style({
    whiteSpace: 'nowrap',
});

export const legendName = style({
    fontWeight: 700,
});

export const legendValue = style({
    color: vars.color.foreground,
});

// ---- 工具列 ----

/** 圖表下方：說明文字＋「指標」「全螢幕」 */
export const toolRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `0 ${vars.space.sm} 0 ${vars.space.md}`,
});

export const toolNote = style({
    flex: '1 1 auto',
    minWidth: 0,
    margin: 0,
    fontSize: '0.75rem',
    color: vars.color.mutedForeground,
});

export const toolButton = style({
    flex: '0 0 auto',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    border: 'none',
    background: 'transparent',
    color: vars.color.accent,
    fontSize: '0.875rem',
    fontWeight: 600,
    selectors: {
        '&:disabled': { color: vars.color.mutedForeground, fontWeight: 400 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

/** 全螢幕上方列：週期＋指標＋退出 */
export const fsBar = style({
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    padding: `0 ${vars.space.xs}`,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
});

export const fsTitle = style({
    flex: '0 1 auto',
    minWidth: 0,
    padding: `0 ${vars.space.sm}`,
    fontSize: '0.875rem',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const fsPeriods = style({
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    gap: '2px',
    overflowX: 'auto',
    scrollbarWidth: 'none',
});

export const fsPeriod = style({
    flex: '0 0 auto',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    border: 'none',
    borderBottom: '2px solid transparent',
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: '0.875rem',
    selectors: {
        '&[aria-pressed="true"]': { color: vars.color.foreground, fontWeight: 700, borderBottomColor: vars.color.accent },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

/** 明顯的「退出」鍵 */
export const exitButton = style({
    flex: '0 0 auto',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.md}`,
    marginLeft: vars.space.xs,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '0.9375rem',
    fontWeight: 700,
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

/** 全螢幕下方：買進／賣出（只開下單面板；文字標示，不只靠顏色） */
export const fsTradeRow = style({
    flex: '0 0 auto',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
    padding: `${vars.space.xs} ${vars.space.sm}`,
    borderTop: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
});

const fsTradeButtonBase = style({
    minHeight: TOUCH_MIN,
    borderRadius: vars.radius.lg,
    border: 'none',
    color: '#ffffff',
    fontSize: '1rem',
    fontWeight: 700,
    selectors: {
        '&:disabled': { opacity: 0.5 },
        '&:focus-visible': { outline: `2px solid ${vars.color.foreground}`, outlineOffset: '2px' },
    },
});

export const fsTradeButton = styleVariants({
    buy: [fsTradeButtonBase, { background: vars.color.up }],
    sell: [fsTradeButtonBase, { background: vars.color.down }],
});

// ---- 指標面板（indicator-sheet.tsx） ----

export const sheetNote = style({
    margin: `0 0 ${vars.space.sm}`,
    padding: vars.space.sm,
    borderRadius: vars.radius.md,
    background: vars.color.muted,
    color: vars.color.mutedForeground,
    fontSize: '0.8125rem',
});

export const section = style({
    display: 'flex',
    flexDirection: 'column',
    marginBottom: vars.space.md,
});

export const sectionHead = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    margin: `0 0 ${vars.space.xs}`,
    fontSize: '0.9375rem',
    fontWeight: 700,
});

export const sectionCount = style({
    fontSize: '0.8125rem',
    fontWeight: 400,
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const limitNote = style({
    margin: `0 0 ${vars.space.xs}`,
    color: vars.color.amber,
    fontSize: '0.8125rem',
});

export const activeList = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: vars.space.xs,
    marginBottom: vars.space.sm,
});

/** 已啟用的指標（點一下編輯參數） */
export const activeChip = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '0.875rem',
    fontFamily: vars.font.mono,
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const swatchDot = style({
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    flex: '0 0 auto',
});

export const emptyActive = style({
    margin: `0 0 ${vars.space.sm}`,
    color: vars.color.mutedForeground,
    fontSize: '0.8125rem',
});

export const defRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    minHeight: TOUCH_MIN,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const defText = style({
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    padding: `${vars.space.xs} 0`,
});

export const defName = style({
    fontSize: '0.9375rem',
});

export const defShort = style({
    marginLeft: '6px',
    color: vars.color.mutedForeground,
    fontSize: '0.8125rem',
    fontFamily: vars.font.mono,
});

export const defDesc = style({
    color: vars.color.mutedForeground,
    fontSize: '0.75rem',
});

export const smallButton = style({
    flex: '0 0 auto',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.md}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: 'transparent',
    color: vars.color.accent,
    fontSize: '0.875rem',
    fontWeight: 600,
    selectors: {
        '&:disabled': { color: vars.color.mutedForeground, borderColor: vars.color.border, fontWeight: 400 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const dangerButton = style([smallButton, {
    color: vars.color.danger,
}]);

export const toggleRow = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    minHeight: TOUCH_MIN,
    marginBottom: vars.space.sm,
    fontSize: '0.9375rem',
});

export const footer = style({
    display: 'flex',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    paddingTop: vars.space.sm,
});

// ---- 參數編輯 ----

export const editHead = style({
    margin: `0 0 ${vars.space.sm}`,
    fontSize: '1rem',
    fontWeight: 700,
});

export const paramRow = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    marginBottom: vars.space.sm,
});

export const paramLabel = style({
    fontSize: '0.875rem',
});

export const paramControls = style({
    display: 'grid',
    gridTemplateColumns: `${TOUCH_MIN} 1fr ${TOUCH_MIN}`,
    gap: vars.space.xs,
    alignItems: 'center',
});

export const stepButton = style({
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '1.25rem',
    lineHeight: 1,
    selectors: {
        '&:disabled': { color: vars.color.mutedForeground },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const paramInput = style({
    minHeight: TOUCH_MIN,
    width: '100%',
    boxSizing: 'border-box',
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.inset,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
    fontFamily: vars.font.mono,
    textAlign: 'center',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '1px' },
    },
});

export const paramHint = style({
    color: vars.color.mutedForeground,
    fontSize: '0.75rem',
});

export const swatchRow = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: vars.space.xs,
    marginBottom: vars.space.sm,
});

/** 顏色選擇：按鈕 44px，以外框＋「已選」文字標示（不只靠顏色） */
export const swatchButton = style({
    position: 'relative',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    borderRadius: vars.radius.lg,
    border: `2px solid ${vars.color.border}`,
    padding: 0,
    color: '#ffffff',
    fontSize: '0.6875rem',
    fontWeight: 700,
    selectors: {
        '&[aria-pressed="true"]': { borderColor: vars.color.foreground },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});
