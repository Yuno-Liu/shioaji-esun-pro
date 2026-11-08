// src/mobile/styles/chart.css.ts — 交易圖表外框、圖例、工具列、橫向全螢幕、指標面板（規格 §6.2、§11、Phase 2／3；設計規格 §7.3）
//
// 交易頁其餘樣式在 trade.css.ts（交易頁擁有）；圖表新增的樣式一律放這裡。
// 顏色一律用 theme vars（買進 up、賣出 down；實心以 primitives fill＋inkLarge）；觸控目標 ≥ 44px；輸入字級 ≥ 16px；
// 價量用系統字 tabular（不用等寬字族）；不用 color-mix()／:has()（iOS 15.4 Safari）。
// 全螢幕上下列為不透明 panel（canvas 上方不模糊）；進出不加動畫（沿用）。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { INPUT_FONT_SIZE, SAFE_BOTTOM, SAFE_LEFT, SAFE_RIGHT, SAFE_TOP, TOUCH_MIN, TRADE_BUTTON_GAP, Z } from './metrics';
import { fill, focusRing, hairlineBottom, hairlineTop, pressable } from './primitives.css';
import { elevation, sj } from './theme-vars.css';
import { RADIUS, SIZE, SPACE } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

/** 每個副圖增加的高度（px）；trade-chart 也用這個值設定副圖高度 */
export const PANE_HEIGHT_PX = 96;
/** 全螢幕覆蓋層：蓋過狀態列、底部分頁與交易頁買賣列，但在底部面板（下單、指標）之下 */
export const Z_CHART_FULLSCREEN = Z.bars + 40;
/** 圖表（lightweight-charts）字型：與 body 相同的系統字族（手機未載 JetBrains Mono，§4.7） */
export const CHART_FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', sans-serif";

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
    // 走勢：量＋分時買賣力＋大單／小單買賣力
    3: [frameBase, { height: [`calc(42vh + ${PANE_HEIGHT_PX * 3}px)`, `calc(42dvh + ${PANE_HEIGHT_PX * 3}px)`], minHeight: `${220 + PANE_HEIGHT_PX * 3}px`, maxHeight: `${520 + PANE_HEIGHT_PX * 3}px` }],
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
    left: SPACE.s2,
    right: '64px', // 留給右側價格軸
    // 程式庫的上層 canvas（十字線）是 z-index 2：圖例要同層（DOM 在後）才蓋得過，
    // 否則圖例裡的按鈕（資訊列 ✕、「漲跌停範圍」）點下去落在 canvas 上。圖例本身 pointer-events none，不擋圖表
    zIndex: 2,
    display: 'flex',
    flexWrap: 'wrap',
    gap: `0 ${SPACE.s2}`,
    ...TEXT.caption,
    fontWeight: 500,
    lineHeight: 1.5,
    ...NUMERIC,
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

// ---- 價格資訊列（點選或長按追蹤：時間＋價格＋漲跌＋漲跌%；圖例的第一列，下方圖例往下排，不重疊） ----

/** 獨佔圖例的一整列（圖例右側已留給價格軸） */
export const readout = style({
    flex: '1 0 100%',
    display: 'flex',
    minWidth: 0,
});

/** 含漲跌色小字：放在 islandBg 中性島（§4.8 規則 7）；放不下時以組為單位換行，不截斷 */
export const readoutPill = style({
    display: 'inline-flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `0 ${SPACE.s2}`,
    maxWidth: '100%',
    padding: `0 0 0 ${SPACE.s1_5}`,
    borderRadius: RADIUS.sm,
    background: sj.islandBg,
    color: vars.color.foreground,
});

/** 漲跌＋✕：同一組不拆行 */
export const readoutTail = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: SPACE.s1,
    whiteSpace: 'nowrap',
});

export const readoutTime = style({
    whiteSpace: 'nowrap',
    color: vars.color.mutedForeground,
});

export const readoutPrice = style({
    whiteSpace: 'nowrap',
    fontWeight: 700,
});

/** ✕：圖例整體不接觸控（pointer-events none），只有這顆接；點擊區以 ::before 擴到 TOUCH_MIN 見方 */
export const readoutClose = style([focusRing, {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '1.5rem',
    minHeight: '1.5em',
    padding: 0,
    margin: 0,
    border: 'none',
    borderRadius: RADIUS.sm,
    background: 'transparent',
    color: vars.color.mutedForeground,
    font: 'inherit',
    pointerEvents: 'auto',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&::before': {
            content: '""',
            position: 'absolute',
            top: `min(0px, calc((100% - ${TOUCH_MIN}) / 2))`,
            bottom: `min(0px, calc((100% - ${TOUCH_MIN}) / 2))`,
            left: `min(0px, calc((100% - ${TOUCH_MIN}) / 2))`,
            right: `min(0px, calc((100% - ${TOUCH_MIN}) / 2))`,
        },
    },
}]);

/** 「漲跌停範圍」標示（走勢主圖圖例第一個）：點一下回到自動範圍。圖例不接觸控，只有這顆接；點擊區以 ::before 擴到 TOUCH_MIN */
export const rangeBadge = style([focusRing, {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    margin: 0,
    padding: `0 ${SPACE.s1_5}`,
    border: `0.5px solid ${vars.color.borderBright}`,
    borderRadius: RADIUS.sm,
    background: sj.islandBg,
    color: vars.color.foreground,
    font: 'inherit',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    pointerEvents: 'auto',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&::before': {
            content: '""',
            position: 'absolute',
            top: `min(0px, calc((100% - ${TOUCH_MIN}) / 2))`,
            bottom: `min(0px, calc((100% - ${TOUCH_MIN}) / 2))`,
            left: 0,
            right: 0,
        },
    },
}]);

// ---- 工具列 ----

/** 圖表下方：說明文字＋「指標」「全螢幕」Chip */
export const toolRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
    padding: `${SPACE.s1} ${SPACE.s4}`,
});

export const toolNote = style({
    flex: '1 1 auto',
    minWidth: 0,
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 工具鍵（Chip 的附加樣式：不收縮） */
export const toolButton = style({
    flex: '0 0 auto',
});

/** 全螢幕上方列：名稱＋週期 Segmented＋指標＋退出（實心 panel，canvas 上方不模糊） */
export const fsBar = style([hairlineBottom, {
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
    padding: `${SPACE.s1} ${SPACE.s2}`,
    background: vars.color.panel,
}]);

export const fsTitle = style({
    flex: '0 1 auto',
    minWidth: 0,
    padding: `0 ${SPACE.s1}`,
    ...TEXT.subhead,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const fsPeriods = style({
    flex: '1 1 auto',
    minWidth: 0,
    maxWidth: '26rem',
});

/** 明顯的「退出」鍵（elevatedBg＋髮絲框） */
export const exitButton = style([pressable, focusRing, {
    flex: '0 0 auto',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${SPACE.s4}`,
    borderRadius: RADIUS.lg,
    border: `0.5px solid ${vars.color.borderBright}`,
    background: sj.elevatedBg,
    boxShadow: elevation.e1,
    color: vars.color.foreground,
    ...TEXT.callout,
    fontWeight: 600,
}]);

/** 全螢幕下方：買進／賣出（只開下單面板；文字標示，不只靠顏色）；CONTROL_LARGE、間距 12、實心 panel */
export const fsTradeRow = style([hairlineTop, {
    flex: '0 0 auto',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: TRADE_BUTTON_GAP,
    padding: `8px ${SPACE.s4}`,
    background: vars.color.panel,
}]);

/** 1.1875rem 粗體（actionLabel）→ inkLarge 疊黑（大字門檻） */
const fsTradeButtonBase = style([pressable, focusRing, {
    minHeight: SIZE.controlLarge,
    borderRadius: RADIUS.lg,
    border: 'none',
    color: '#ffffff',
    ...TEXT.actionLabel,
    selectors: {
        '&:disabled': { opacity: 0.45 },
    },
}]);

export const fsTradeButton = styleVariants({
    buy: [fsTradeButtonBase, fill.up.large],
    sell: [fsTradeButtonBase, fill.down.large],
});

// ---- 指標面板（indicator-sheet.tsx） ----

export const sheetNote = style({
    marginBottom: SPACE.s3,
});

export const section = style({
    display: 'flex',
    flexDirection: 'column',
    marginBottom: SPACE.s4,
});

export const sectionHead = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    margin: `0 0 ${SPACE.s1_5}`,
    ...TEXT.headline,
});

export const sectionCount = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    ...NUMERIC,
});

/** 上限說明：foreground 文字（淺色 amber 對白只有 3.44，不用 amber 小字），左側 3px amber 條 */
export const limitNote = style({
    margin: `0 0 ${SPACE.s2}`,
    padding: `${SPACE.s1} ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    boxShadow: `inset 3px 0 0 ${vars.color.amber}`,
    color: vars.color.foreground,
    ...TEXT.subhead,
});

export const activeList = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: SPACE.s1_5,
    marginBottom: SPACE.s2,
});

/** 已啟用的指標（點一下編輯參數） */
export const activeChip = style([pressable, focusRing, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: TOUCH_MIN,
    padding: `0 ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    border: `0.5px solid ${vars.color.borderBright}`,
    background: sj.elevatedBg,
    boxShadow: elevation.e1,
    color: vars.color.foreground,
    ...TEXT.callout,
    ...NUMERIC,
}]);

export const swatchDot = style({
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    flex: '0 0 auto',
});

export const emptyActive = style({
    margin: `0 0 ${SPACE.s2}`,
    color: vars.color.mutedForeground,
    ...TEXT.subhead,
});

export const defRow = style([hairlineBottom, {
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
}]);

export const defText = style({
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    padding: `${SPACE.s1_5} 0`,
});

export const defName = style({
    ...TEXT.body,
    lineHeight: 1.35,
});

export const defShort = style({
    marginLeft: '6px',
    color: vars.color.mutedForeground,
    ...TEXT.subhead,
});

export const defDesc = style({
    color: vars.color.mutedForeground,
    ...TEXT.footnote,
});

export const smallButton = style([pressable, focusRing, {
    flex: '0 0 auto',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${SPACE.s4}`,
    borderRadius: RADIUS.md,
    border: `0.5px solid ${vars.color.borderBright}`,
    background: sj.elevatedBg,
    color: vars.color.accent,
    ...TEXT.callout,
    fontWeight: 600,
    selectors: {
        '&:disabled': { color: vars.color.mutedForeground, borderColor: vars.color.border, fontWeight: 400, opacity: 0.6 },
    },
}]);

export const dangerButton = style([smallButton, {
    color: vars.color.danger,
}]);

export const toggleRow = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
    marginBottom: SPACE.s3,
    ...TEXT.body,
});

export const footer = style({
    display: 'flex',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: SPACE.s2,
    paddingTop: SPACE.s2,
});

// ---- 參數編輯 ----

export const editHead = style({
    margin: `0 0 ${SPACE.s3}`,
    ...TEXT.headline,
});

export const paramRow = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1,
    marginBottom: SPACE.s3,
});

export const paramLabel = style({
    ...TEXT.footnote,
    fontWeight: 500,
    color: vars.color.foreground,
});

export const paramControls = style({
    display: 'grid',
    gridTemplateColumns: `${TOUCH_MIN} 1fr ${TOUCH_MIN}`,
    gap: SPACE.s2,
    alignItems: 'center',
});

/** 步進鍵：與 ui/stepper 同外觀（elevatedBg＋borderBright 髮絲＋e1、圓角 8） */
export const stepButton = style([pressable, focusRing, {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    borderRadius: RADIUS.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: sj.elevatedBg,
    boxShadow: elevation.e1,
    color: vars.color.foreground,
    fontSize: '1.25rem',
    lineHeight: 1,
    selectors: {
        '&:disabled': { color: vars.color.mutedForeground, opacity: 0.45 },
    },
}]);

export const paramInput = style({
    minHeight: TOUCH_MIN,
    width: '100%',
    boxSizing: 'border-box',
    padding: `0 ${SPACE.s2}`,
    borderRadius: RADIUS.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: sj.islandBg,
    color: vars.color.foreground,
    ...NUM.numMd,
    ...NUMERIC,
    fontSize: INPUT_FONT_SIZE,
    textAlign: 'center',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '1px' },
    },
});

export const paramHint = style({
    color: vars.color.mutedForeground,
    ...TEXT.footnote,
});

export const swatchRow = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: SPACE.s1_5,
    marginBottom: SPACE.s3,
});

/** 顏色選擇：按鈕 44px，以外框＋「已選」文字標示（不只靠顏色） */
export const swatchButton = style([focusRing, {
    position: 'relative',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    borderRadius: RADIUS.md,
    border: `2px solid ${vars.color.border}`,
    padding: 0,
    color: '#ffffff',
    ...TEXT.caption,
    fontWeight: 700,
    selectors: {
        '&[aria-pressed="true"]': { borderColor: vars.color.foreground },
    },
}]);
