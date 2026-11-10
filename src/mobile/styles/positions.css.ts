// src/mobile/styles/positions.css.ts — 持倉頁、摘要卡、玉山庫存明細、平倉／加碼說明面板（設計規格 §7.7、§4.8、§6.11）
// 分組型頁面：vars.color.background 底＋GroupedSection 卡片（groupedBg）。多空與損益用 up／down，並一律附文字（多／空、正負號）；
// 淺色主題的漲跌色字只放在卡片（白底）內，不直接放在頁面底色上（§4.8 規則 9）。狀態色（danger／amber／success）不隨配色翻轉，
// amber 不作小字顏色（規則 4）。只動畫 transform（損益條 scaleX）與 opacity（庫存明細淡入）；不用 color-mix()、:has()。
import { globalStyle, keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { fill, focusRing, pressable, pressableRow } from './primitives.css';
import { elevation, sj } from './theme-vars.css';
import { DUR, EASE, LOW_DPR, MORE_CONTRAST, RADIUS, REDUCED_MOTION, SAFE_LEFT, SAFE_RIGHT, SPACE, TOUCH_MIN } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

const INSET_X = `calc(${SPACE.s4} + ${SAFE_LEFT})`;
const INSET_R = `calc(${SPACE.s4} + ${SAFE_RIGHT})`;

/** 展開區淡入（玉山庫存明細、精簡列展開）；減少動態時不動畫 */
const fadeIn = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

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

/** 「≈ 金額」不拆行（摘要卡的已含預估退佣） */
export const nowrap = style({ whiteSpace: 'nowrap' });

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

// ---- 淨損益與損益兩平價 ----

/** 券商原始損益（rowMeta 行尾小字，方便與淨損益對照；不用漲跌色） */
export const brokerPnl = style({
    marginLeft: 'auto',
    ...NUMERIC,
    whiteSpace: 'nowrap',
});

/** 「損益兩平」列：整列可點開計算明細（中性島底、44pt 觸控高度） */
export const pnlInfo = style([pressable, focusRing, {
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    width: '100%',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `${SPACE.s1} ${SPACE.s2} ${SPACE.s1} ${SPACE.s3}`,
    border: 'none',
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    color: vars.color.foreground,
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    minWidth: 0,
}]);

export const pnlInfoBody = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    flex: '1 1 auto',
    minWidth: 0,
});

export const pnlInfoMain = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: SPACE.s1_5,
    ...TEXT.footnote,
});

export const pnlInfoLabel = style({
    color: vars.color.mutedForeground,
});

export const pnlInfoValue = style({
    ...NUM.numSm,
    ...NUMERIC,
    fontWeight: 600,
    color: vars.color.foreground,
});

/** 現價與兩平價的關係（文字，不只靠顏色） */
export const pnlInfoRel = style({
    color: vars.color.foreground,
});

export const pnlTagList = style({
    listStyle: 'none',
    display: 'flex',
    flexWrap: 'wrap',
    gap: SPACE.s1,
    margin: 0,
    padding: 0,
});

/** 期權列「券商損益・未扣費稅」、股票列無法計算的原因 */
export const pnlNote = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

// ---- 精簡檢視（「詳細｜精簡」切換；預設詳細）----

/** 篩選列行尾的「詳細｜精簡」分段（compact 尺寸；點擊區仍為 TOUCH_MIN） */
export const viewToggle = style({
    flex: '0 0 auto',
    width: '7.5rem',
    marginLeft: 'auto',
});

/** 精簡模式的摘要卡：內距、間距與合計字級縮小 */
export const summaryTight = style([summary, {
    gap: SPACE.s2,
    padding: `${SPACE.s2} ${SPACE.s4}`,
}]);

export const summaryValueTight = style([summaryValue, {
    ...NUM.numLg,
}]);

globalStyle(`${summaryTight} ${summaryGrid}`, { rowGap: SPACE.s2 });

/** 一個部位一列（約 60px，比照自選列）；展開時同一個 li 內接既有詳細卡片 */
export const compactItem = style({
    position: 'relative',
    minWidth: 0,
});

// 列間髮絲線：同詳細列，從文字起點（16px）開始
globalStyle(`${compactItem} + ${compactItem}::before`, {
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

/**
 * 精簡列本體（整列一顆按鈕，aria-expanded）：名稱與代碼｜損益與報酬率｜chevron
 * 左欄最窄＝其 min-content（第二行最寬的一項：代碼／條件／多空數量；名稱不計入），不會被右欄擠到截斷數量。
 */
export const compactRow = style([pressableRow, {
    display: 'grid',
    gridTemplateColumns: 'minmax(min-content, 1fr) auto auto',
    alignItems: 'center',
    columnGap: SPACE.s3,
    rowGap: '0.125rem',
    boxSizing: 'border-box',
    width: '100%',
    minHeight: '60px',
    margin: 0,
    padding: `${SPACE.s2} ${SPACE.s3} ${SPACE.s2} ${SPACE.s4}`,
    border: 'none',
    borderRadius: 0,
    background: 'transparent',
    color: vars.color.foreground,
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    outline: 'none',
    selectors: {
        '&:focus-visible': { boxShadow: `inset 0 0 0 2px ${vars.color.accent}` },
    },
    '@media': {
        [MORE_CONTRAST]: { selectors: { '&:focus-visible': { boxShadow: `inset 0 0 0 3px ${vars.color.accent}` } } },
    },
}]);

export const compactLeft = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0.0625rem',
    minWidth: 0,
});

/**
 * 第一行：名稱（headline 500、單行省略）。空間不足時由這裡省略吸收。
 * width 0＋minWidth 100%：不計入左欄的 min-content（長名稱不撐寬欄位），版面上仍佔滿整欄。
 */
export const compactName = style({
    ...TEXT.headline,
    fontWeight: 500,
    width: 0,
    minWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

/** 第二行：代碼、條件小膠囊、方向與數量（文字＋顏色）。各項不縮不省略；放不下時整項換行，不裁切 */
export const compactMeta = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: SPACE.s1_5,
    rowGap: '0.125rem',
    minWidth: 0,
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const compactCode = style({
    ...NUMERIC,
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
});

/** 條件小膠囊（與 tag 併用）：不縮 */
export const compactTag = style({
    flex: '0 0 auto',
});

/** 方向與數量（「多 3張+500股」「空 12 口」）：不縮、不換行、不省略（數量被截斷會誤讀） */
const compactSideBase = style({
    fontWeight: 700,
    ...NUMERIC,
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
});

export const compactSide = styleVariants({
    long: [compactSideBase, { color: vars.color.up }],
    short: [compactSideBase, { color: vars.color.down }],
});

export const compactRight = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.0625rem',
    minWidth: 0,
    textAlign: 'right',
});

export const compactPnl = style({
    ...NUM.numMd,
    ...NUMERIC,
    whiteSpace: 'nowrap',
});

/**
 * 右側第二行：報酬率（或現價）＋兩平狀態文字（已過兩平／未達兩平，不只靠顏色）。
 * 放不下時狀態文字換到下一行（不裁切）；字級「大」固定上下排列，讓左欄保有空間。
 */
export const compactSub = style({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'baseline',
    columnGap: SPACE.s1,
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    selectors: {
        'html[data-sj-font-scale="1.3"] &': { flexDirection: 'column', alignItems: 'flex-end' },
    },
});

/**
 * 第二列（橫跨名稱與損益兩欄，不含 chevron 欄）：現價＋兩平價（期權為均價）。
 * 各項不縮不省略（價格被截斷會誤讀），放不下時整項換行；360 寬、字級 1.3 仍不水平捲動。
 */
export const compactPrices = style({
    gridColumn: '1 / 3',
    gridRow: 2,
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: SPACE.s3,
    rowGap: '0.125rem',
    minWidth: 0,
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

/** 展開提示：收合時朝右、展開時朝下（transform；減少動態時瞬間）；跨兩列垂直置中 */
export const compactChevron = style([actionIcon, {
    gridColumn: 3,
    gridRow: '1 / span 2',
    color: vars.color.mutedForeground,
    transition: `transform ${DUR.tone}ms ${EASE.out}`,
    selectors: {
        '[aria-expanded="true"] > &': { transform: 'rotate(90deg)' },
    },
    '@media': {
        [REDUCED_MOTION]: { transition: 'none' },
    },
}]);

/** 展開後的既有詳細卡片內容（不重複第一行；淡入，減少動態時不動畫） */
export const compactDetail = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    padding: `0 ${SPACE.s4} 0.6875rem`,
    minWidth: 0,
    animation: `${fadeIn} ${DUR.fade}ms ${EASE.out} both`,
    '@media': {
        [REDUCED_MOTION]: { animation: 'none' },
    },
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

// ---- 多選市價出清：選取模式與底部工具列（設計規格 §7.7、§10 S10；預覽／進度面板的樣式在 batch-exit.css.ts）----

/** 勾選鍵（button role=checkbox）：觸控區 TOUCH_MIN，內含 22px 方框；停用時降低不透明度並另有原因文字 */
export const selectCheck = style([pressable, focusRing, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
}]);

/** 勾選方框：未勾＝外框；勾選或部分勾選＝accent 實心＋白色圖示（selectBoxOn） */
export const selectBox = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    width: '1.375rem',
    height: '1.375rem',
    borderRadius: RADIUS.xs,
    border: `1.5px solid ${vars.color.borderBright}`,
    background: vars.color.panel,
});

export const selectBoxOn = style([fill.accent.large, {
    borderColor: 'transparent',
}]);

export const selectIcon = style({
    width: '1rem',
    height: '1rem',
    strokeWidth: 3,
});

/** 部分勾選（aria-checked=mixed）的橫線 */
export const selectDash = style({
    width: '0.625rem',
    height: '2px',
    borderRadius: '1px',
    background: 'currentColor',
});

/** 詳細列選取模式的第一行：勾選鍵在最前（左邊緣與文字起點對齊，觸控區往左延伸到列內距） */
export const rowSelectCheck = style({
    marginLeft: `calc(-1 * ${SPACE.s3})`,
    marginTop: `calc(-1 * ${SPACE.s2})`,
    marginBottom: `calc(-1 * ${SPACE.s2})`,
});

/** 精簡列選取模式：勾選鍵＋列本體 */
export const compactSelectable = style({
    display: 'flex',
    alignItems: 'stretch',
    minWidth: 0,
    paddingLeft: SPACE.s1,
});

// 列本體在勾選鍵右側：佔滿剩餘寬度、左內距縮小；選取模式不展開，去掉 chevron 欄（讓出勾選鍵佔用的寬度，360 寬字級大不溢出）
globalStyle(`${compactSelectable} > ${compactRow}`, {
    flex: '1 1 auto',
    width: 'auto',
    paddingLeft: SPACE.s1,
    gridTemplateColumns: 'minmax(min-content, 1fr) auto',
});

globalStyle(`${compactSelectable} ${compactChevron}`, { display: 'none' });

/** 不能列入批次的原因（列內小字，不只靠停用外觀） */
export const selectReason = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 精簡列的原因：與列文字起點對齊（勾選鍵右側） */
export const compactSelectReason = style({
    padding: `0 ${SPACE.s4} ${SPACE.s2} calc(${SPACE.s1} + ${TOUCH_MIN})`,
});

/** 組標頭的「全選」：勾選鍵＋文字（標頭在頁面底色上，文字用 foreground） */
export const groupSelect = style([selectCheck, {
    gap: SPACE.s1,
    paddingRight: SPACE.s2,
    ...TEXT.footnote,
    fontWeight: 600,
}]);

/** 標頭「選取」切換鍵（aria-pressed）：accent 文字鍵 */
export const headerToggle = style([actionBase, {
    border: 'none',
    background: 'transparent',
    color: vars.color.accent,
    padding: `0 ${SPACE.s2}`,
    selectors: {
        '&[aria-pressed="true"]': { color: vars.color.foreground },
    },
}]);

/** 底部配件槽（ShellSlot bottom，bar 材質上文字一律 foreground） */
export const selectBar = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    padding: `${SPACE.s2} ${INSET_R} ${SPACE.s2} ${INSET_X}`,
    minWidth: 0,
});

export const selectBarRow = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACE.s2,
    minWidth: 0,
});

export const selectBarCount = style({
    flex: '1 1 auto',
    minWidth: 0,
    ...TEXT.callout,
    fontWeight: 600,
    ...NUMERIC,
    color: vars.color.foreground,
});

/** 「市價出清 N 筆」：danger 外框（不用實心紅綠，避免與新單買賣鍵混淆）；只開預覽面板，仍需滑動 */
export const clearOutButton = style([actionBase, {
    width: '100%',
    border: `1px solid ${vars.color.danger}`,
    background: vars.color.panel,
    color: vars.color.foreground,
}]);

export const textButton = style([actionBase, {
    border: 'none',
    background: 'transparent',
    color: vars.color.accent,
    padding: `0 ${SPACE.s2}`,
}]);
