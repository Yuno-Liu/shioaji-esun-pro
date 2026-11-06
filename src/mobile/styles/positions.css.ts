// src/mobile/styles/positions.css.ts — 持倉頁、摘要卡、玉山庫存明細、平倉／加碼說明面板（設計規格 §7.7、§4.8、§6.11）
// 分組型頁面：vars.color.background 底＋GroupedSection 卡片（groupedBg）。多空與損益用 up／down，並一律附文字（多／空、正負號）；
// 淺色主題的漲跌色字只放在卡片（白底）內，不直接放在頁面底色上（§4.8 規則 9）。狀態色（danger／amber／success）不隨配色翻轉，
// amber 不作小字顏色（規則 4）。只動畫 transform（損益條 scaleX）與 opacity（庫存明細淡入）；不用 color-mix()、:has()。
import { globalStyle, keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { fill, focusRing, pressable } from './primitives.css';
import { elevation, sj } from './theme-vars.css';
import { DUR, EASE, LOW_DPR, MORE_CONTRAST, RADIUS, REDUCED_MOTION, SAFE_LEFT, SAFE_RIGHT, SPACE, TOUCH_MIN } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

const INSET_X = `calc(${SPACE.s4} + ${SAFE_LEFT})`;
const INSET_R = `calc(${SPACE.s4} + ${SAFE_RIGHT})`;

// ---- 頁面 ----

/** 分組型頁面：background 底；左右邊距由各區塊自帶（16＋安全區） */
export const page = style({
    boxSizing: 'border-box',
    minHeight: '100%',
    padding: `${SPACE.s1} 0 ${SPACE.s6}`,
    background: vars.color.background,
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    minWidth: 0,
});

/** 頁內非卡片區塊（分段、篩選、說明）的左右邊距 */
export const inset = style({
    paddingLeft: INSET_X,
    paddingRight: INSET_R,
    minWidth: 0,
    selectors: {
        // 內容元件不渲染時（例如 ResumeGateNote 非 stale-data）不佔版面與間距
        '&:empty': { display: 'none' },
    },
});

/** 帳戶＋排序 PopUpButton */
export const filterRow = style([inset, {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACE.s2,
}]);

export const picker = style({
    flex: '0 1 auto',
    maxWidth: '100%',
});

/** 期權未歸類等頁面註腳（頁面底色上：mutedForeground 小字，不含漲跌色） */
export const filterNote = style([inset, {
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
}]);

// ---- 摘要卡 ----

export const summary = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    padding: `${SPACE.s3} ${SPACE.s4}`,
    minWidth: 0,
});

export const summaryCaption = style({
    margin: 0,
    ...TEXT.caption,
    color: vars.color.mutedForeground,
});

export const summaryMain = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: SPACE.s2,
    minWidth: 0,
});

/** 損益合計：numHero；跳價閃爍覆蓋層在這層之下（price-flash host） */
export const summaryValue = style({
    position: 'relative',
    isolation: 'isolate',
    borderRadius: RADIUS.sm,
    padding: `0 ${SPACE.s1}`,
    margin: `0 calc(-1 * ${SPACE.s1})`,
    ...NUM.numHero,
    ...NUMERIC,
});

export const summaryPct = style({
    ...NUM.numMd,
    ...NUMERIC,
});

export const summaryGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: `${SPACE.s3} ${SPACE.s4}`,
    margin: 0,
    selectors: {
        'html[data-sj-font-scale="1.3"] &': { gridTemplateColumns: 'minmax(0, 1fr)' },
    },
});

export const summaryItem = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
});

export const summaryLabel = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

export const summaryItemValue = style({
    margin: 0,
    ...NUM.numMd,
    ...NUMERIC,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

/** 風險指標：數值文字 foreground（等級文字已在括號內），狀態色只給下方進度條 */
export const riskBar = style({
    display: 'block',
    marginTop: SPACE.s1,
});

export const summaryNote = style({
    margin: 0,
    ...TEXT.footnote,
    fontWeight: 400,
    color: vars.color.mutedForeground,
});

/** 漲跌色文字（卡片內；淺色為白底） */
export const tone = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.flat },
});

// ---- 帳戶分組與持倉列 ----

/** 組標頭（GroupedSection header 內；頁面底色上 → 損益小計用 foreground＋正負號，不用漲跌色小字） */
export const groupHeader = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: SPACE.s2,
    rowGap: '0.125rem',
    ...NUMERIC,
});

export const groupTitle = style({
    fontWeight: 600,
    color: vars.color.foreground,
});

export const groupStat = style({
    color: vars.color.mutedForeground,
});

export const groupPnl = style({
    marginLeft: 'auto',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const list = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    minWidth: 0,
});

export const row = style({
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    padding: `0.6875rem ${SPACE.s4}`,
    minWidth: 0,
});

// 列間髮絲線：從文字起點（16px）開始
globalStyle(`${row} + ${row}::before`, {
    content: '""',
    position: 'absolute',
    top: 0,
    left: SPACE.s4,
    right: 0,
    height: 0,
    borderTop: `0.5px solid ${vars.color.border}`,
    pointerEvents: 'none',
    '@media': {
        [LOW_DPR]: { borderTopWidth: '1px' },
        [MORE_CONTRAST]: { borderTop: `1px solid ${vars.color.borderBright}` },
    },
});

/** 第一行：代碼名稱、條件小膠囊、多空膠囊 … 損益（行尾） */
export const rowHead = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: SPACE.s1_5,
    rowGap: SPACE.s1,
    minWidth: 0,
    ...TEXT.headline,
});

export const rowCode = style({
    ...TEXT.headline,
    ...NUMERIC,
});

export const rowName = style({
    ...TEXT.subhead,
    color: vars.color.foreground,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

/** 條件小膠囊（現股／融資／融券／期貨／選擇權）：外框、foreground 文字 */
export const tag = style({
    padding: '0 0.3125rem',
    borderRadius: RADIUS.xs,
    border: `0.5px solid ${vars.color.borderBright}`,
    ...TEXT.footnote,
    lineHeight: 1.5,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
    '@media': {
        [MORE_CONTRAST]: { border: `1px solid ${vars.color.borderBright}` },
    },
});

const sideBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    padding: '0 0.375rem',
    borderRadius: RADIUS.sm,
    ...TEXT.footnote,
    fontWeight: 700,
    lineHeight: 1.5,
    ...NUMERIC,
    whiteSpace: 'nowrap',
});

/** 「多／空 N 張」：實心 up／down＋inkStrong 白字（§4.8 規則 3） */
export const side = styleVariants({
    long: [fill.up.strong, sideBase],
    short: [fill.down.strong, sideBase],
});

/** 玉山分批明細的買進／賣出（明細區內小字：文字＋顏色） */
export const lotSide = styleVariants({
    long: { fontWeight: 700, color: vars.color.up },
    short: { fontWeight: 700, color: vars.color.down },
});

/** 列損益（numMd、漲跌色、正負號）：行尾 */
export const rowPnl = style({
    marginLeft: 'auto',
    ...NUM.numMd,
    ...NUMERIC,
    whiteSpace: 'nowrap',
});

export const rowMeta = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACE.s1_5,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 數字格：均價、現價、報酬率／昨餘、成本、市值（numSm） */
export const rowGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: `${SPACE.s1_5} ${SPACE.s2}`,
    margin: 0,
    selectors: {
        'html[data-sj-font-scale="1.3"] &': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    },
});

export const rowCell = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    overflowWrap: 'anywhere',
});

export const cellLabel = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const cellValue = style({
    margin: 0,
    ...NUM.numSm,
    ...NUMERIC,
    color: vars.color.foreground,
});

/** 損益條：中線為 0，往右＝獲利（up）、往左＝虧損（down）；旁邊一律有損益文字。填色以 scaleX 呈現（不做 width 轉場） */
export const pnlBar = style({
    position: 'relative',
    display: 'block',
    height: '4px',
    borderRadius: '2px',
    background: vars.color.muted,
    overflow: 'hidden',
});

export const pnlBarMid = style({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '50%',
    width: '1px',
    background: vars.color.borderBright,
    zIndex: 1,
});

const pnlFillBase = style({
    position: 'absolute',
    top: 0,
    bottom: 0,
    // 寬度＝整條；scaleX(寬度百分比 ÷ 100) 後從中線往一側延伸（0–50%）
    width: '100%',
    transition: `transform 200ms ${EASE.out}`,
    '@media': {
        [REDUCED_MOTION]: { transition: 'none' },
    },
});

export const pnlBarFill = styleVariants({
    up: [pnlFillBase, { left: '50%', transformOrigin: 'left center', background: vars.color.up }],
    down: [pnlFillBase, { right: '50%', transformOrigin: 'right center', background: vars.color.down }],
});

/** 動作列：［庫存明細］…［平倉］［加碼］［看圖 ›］ */
export const rowActions = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: SPACE.s2,
    marginTop: SPACE.s1,
});

const actionBase = style([pressable, focusRing, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.125rem',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    margin: 0,
    padding: `0 ${SPACE.s3}`,
    borderRadius: RADIUS.lg,
    ...TEXT.callout,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
}]);

/**
 * 平倉：中性外框（不用實心紅綠，避免與新單買賣鍵混淆）；加碼：elevatedBg；看圖：accent 文字鍵。
 * 庫存明細：文字鍵＋旋轉 chevron（aria-expanded）。
 */
export const action = styleVariants({
    close: [actionBase, {
        border: `1px solid ${vars.color.borderBright}`,
        background: 'transparent',
        color: vars.color.foreground,
    }],
    addOn: [actionBase, {
        border: `0.5px solid ${vars.color.border}`,
        background: sj.elevatedBg,
        boxShadow: elevation.e1,
        color: vars.color.foreground,
        '@media': { [MORE_CONTRAST]: { border: `1px solid ${vars.color.borderBright}` } },
    }],
    chart: [actionBase, {
        border: 'none',
        background: 'transparent',
        color: vars.color.accent,
        paddingRight: SPACE.s1,
    }],
    detail: [actionBase, {
        border: 'none',
        background: 'transparent',
        color: vars.color.accent,
        paddingLeft: 0,
        marginRight: 'auto',
    }],
});

export const actionIcon = style({
    width: '1rem',
    height: '1rem',
    flex: '0 0 auto',
});

/** 庫存明細的 chevron：展開時旋轉 90°（transform；減少動態時瞬間） */
export const detailChevron = style([actionIcon, {
    transition: `transform ${DUR.tone}ms ${EASE.out}`,
    selectors: {
        '[aria-expanded="true"] > &': { transform: 'rotate(90deg)' },
    },
    '@media': {
        [REDUCED_MOTION]: { transition: 'none' },
    },
}]);

/** 加碼限制說明：foreground 小字（不在按鈕內） */
export const rowNote = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    textAlign: 'right',
});

// ---- 空狀態 ----

export const emptyWrap = inset;

// ---- 說明面板（平倉、加碼切換帳戶）----

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

export const sheetList = style({
    margin: 0,
    padding: `0.6875rem ${SPACE.s4} 0.6875rem 2rem`,
    ...TEXT.body,
    color: vars.color.foreground,
});

/** 平倉摘要（GroupedSection 內）：代碼、條件、多空、數量 → 市價動作 */
export const sheetSummary = style({
    margin: 0,
    padding: `0.6875rem ${SPACE.s4}`,
    ...TEXT.headline,
    ...NUMERIC,
    color: vars.color.foreground,
});

export const sheetRoute = style({
    margin: 0,
    padding: `0 ${SPACE.s4} 0.6875rem`,
});

/** 說明面板 footer：［取消］［繼續／切換並開啟］ */
export const sheetActions = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: SPACE.s3,
});

// ---- 玉山庫存明細（展開區：立即展開＋150ms 淡入）----

const fadeIn = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

export const detail = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1,
    marginTop: SPACE.s1,
    padding: `${SPACE.s2} ${SPACE.s3} ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    ...TEXT.subhead,
    color: vars.color.foreground,
    animation: `${fadeIn} ${DUR.fade}ms ${EASE.out} both`,
    '@media': {
        [REDUCED_MOTION]: { animation: 'none' },
    },
});

export const detailHead = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACE.s1,
});

export const detailTitle = style({
    margin: `${SPACE.s2} 0 0`,
    ...TEXT.footnote,
    fontWeight: 600,
    color: vars.color.foreground,
});

export const detailGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))',
    gap: `${SPACE.s1_5} ${SPACE.s2}`,
    margin: 0,
});

export const detailItem = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const detailLabel = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const detailValue = style({
    margin: 0,
    ...NUM.numSm,
    ...NUMERIC,
    overflowWrap: 'anywhere',
});

export const detailNote = style({
    margin: 0,
    ...TEXT.footnote,
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
});

export const detailEmpty = style({
    margin: `${SPACE.s1} 0 0`,
    padding: `${SPACE.s2} ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
    animation: `${fadeIn} ${DUR.fade}ms ${EASE.out} both`,
    '@media': {
        [REDUCED_MOTION]: { animation: 'none' },
    },
});

export const formulaList = style({
    margin: 0,
    paddingLeft: '1.25rem',
    lineHeight: 1.6,
    ...NUMERIC,
});

export const lotList = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
});

export const lot = style({
    padding: SPACE.s2,
    borderRadius: RADIUS.md,
    border: `0.5px solid ${vars.color.border}`,
    background: sj.groupedBg,
    '@media': {
        [MORE_CONTRAST]: { border: `1px solid ${vars.color.borderBright}` },
    },
});

export const lotHead = style({
    display: 'flex',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    marginBottom: SPACE.s1,
    ...NUMERIC,
});
