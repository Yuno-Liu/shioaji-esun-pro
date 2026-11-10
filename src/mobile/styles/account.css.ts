// src/mobile/styles/account.css.ts — 帳戶頁（規格 §6.7、§11；設計規格 mobile-design.md §7.8、§6.11、§4.8）
//
// GroupedSection 外觀：標題在卡片外（footnote、mutedForeground），卡片 groupedBg、圓角 12、左右內距 16；
// 資訊列 ≥ TOUCH_MIN、列間 0.5px 髮絲線（低密度 1px、提高對比 1px borderBright）。
// 狀態色（成功／錯誤／正式環境）用 success／danger；不隨漲跌配色翻轉。
// amber 小字一律改 foreground 文字，amber 只用於圖示、3px 左側條與框線（§4.8 規則 4）。
// 只動畫 transform／opacity（開關拇指 translateX、開啟底色 opacity、展開內容淡入、chevron 旋轉）；
// 減少動態由 layout.css.ts 全域規則取消，這裡再明確關閉。不使用 color-mix()／:has()。
import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { expandHit } from '../ui/chip.css';
import { focusRing, pressable } from './primitives.css';
import { elevation, sj } from './theme-vars.css';
import { DUR, EASE, INPUT_FONT_SIZE, LOW_DPR, MORE_CONTRAST, RADIUS, REDUCED_MOTION, SIZE, SPACE, TOUCH_MIN } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

// ---- 髮絲線 ----

const HAIRLINE = `0.5px solid ${vars.color.border}`;
const HAIRLINE_CONTRAST = `1px solid ${vars.color.borderBright}`;

const hairlineTopRule = {
    borderTop: HAIRLINE,
    '@media': {
        [LOW_DPR]: { borderTopWidth: '1px' },
        [MORE_CONTRAST]: { borderTop: HAIRLINE_CONTRAST },
    },
} as const;

/** 列間分隔：畫在列的下緣，最後一列不畫 */
const rowDivider = (selector: string) => ({
    borderBottom: HAIRLINE,
    selectors: { [selector]: { borderBottom: 'none' } },
    '@media': {
        [LOW_DPR]: { borderBottomWidth: '1px' },
        [MORE_CONTRAST]: { borderBottom: HAIRLINE_CONTRAST },
    },
});

// ---- 區塊（GroupedSection 外觀） ----

export const card = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    minWidth: 0,
    margin: `0 0 ${SPACE.s6}`,
});

/** 卡片外標題列：footnote 標題＋可選動作（例如「切換帳戶」） */
export const cardHeader = style({
    display: 'flex',
    alignItems: 'flex-end',
    gap: SPACE.s2,
    minWidth: 0,
    padding: `0 ${SPACE.s4}`,
});

export const cardTitle = style({
    flex: '1 1 auto',
    minWidth: 0,
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 卡片本體：groupedBg、圓角 12、左右 16 */
export const cardBody = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    padding: `${SPACE.s1} ${SPACE.s4}`,
    borderRadius: RADIUS.lg,
    background: sj.groupedBg,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

// ---- 可展開區塊：卡片內第一列為展開鍵（整列可點、≥ TOUCH_MIN） ----

export const disclosureRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minWidth: 0,
});

export const disclosureHeading = style({
    flex: '1 1 auto',
    minWidth: 0,
    margin: 0,
    font: 'inherit',
});

/** 可展開區塊的標題鍵（整列皆可點，≥ 44px）；按鈕內只有標題文字與裝飾用 chevron */
export const disclosure = style([focusRing, {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: 0,
    border: 'none',
    borderRadius: RADIUS.md,
    background: 'transparent',
    color: vars.color.foreground,
    ...TEXT.headline,
    textAlign: 'left',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
}]);

/** chevron：收合指向右、展開旋轉 90°（只動畫 transform） */
export const chevron = style({
    flex: '0 0 auto',
    width: '1.125rem',
    height: '1.125rem',
    color: vars.color.mutedForeground,
    transition: `transform ${DUR.fade}ms ${EASE.out}`,
    selectors: {
        // chevron 是展開鍵的直接子節點（不以組合 class 當選擇器）
        '[aria-expanded="true"] > &': { transform: 'rotate(90deg)' },
    },
    '@media': { [REDUCED_MOTION]: { transition: 'none' } },
});

const contentFadeIn = keyframes({
    from: { opacity: 0 },
    to: { opacity: 1 },
});

/** 展開內容：立即出現、150ms 淡入（減少動態不淡入） */
export const collapsibleContent = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBottom: SPACE.s1,
    ...hairlineTopRule,
    animation: `${contentFadeIn} ${DUR.fade}ms ease-out both`,
    '@media': {
        ...hairlineTopRule['@media'],
        [REDUCED_MOTION]: { animation: 'none' },
    },
});

export const subTitle = style({
    margin: `${SPACE.s3} 0 ${SPACE.s1}`,
    ...TEXT.subhead,
    fontWeight: 600,
    color: vars.color.mutedForeground,
});

// ---- 鍵值列（Item：dt／dd），每對 ≥ TOUCH_MIN、髮絲分隔 ----

export const kv = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(6rem, auto) minmax(0, 1fr)',
    columnGap: 0,
    rowGap: 0,
    minWidth: 0,
    margin: 0,
    selectors: {
        // 同一卡片內連續的鍵值組之間也要分隔
        '& + &': { borderTop: HAIRLINE },
    },
});

// 兩欄用同一個行高（rem），不同字級的標籤與數值在列內垂直置中對齊
const ROW_LINE = '1.35rem';

export const term = style({
    minWidth: 0,
    minHeight: TOUCH_MIN,
    boxSizing: 'border-box',
    padding: `${SIZE.rowPadY} ${SPACE.s3} ${SIZE.rowPadY} 0`,
    ...TEXT.subhead,
    lineHeight: ROW_LINE,
    color: vars.color.mutedForeground,
    selectors: {
        '&:not(:first-child)': { borderTop: HAIRLINE },
    },
    '@media': {
        [LOW_DPR]: { borderTopWidth: '1px' },
        [MORE_CONTRAST]: { selectors: { '&:not(:first-child)': { borderTop: HAIRLINE_CONTRAST } } },
    },
});

export const value = style({
    minWidth: 0,
    minHeight: TOUCH_MIN,
    boxSizing: 'border-box',
    margin: 0,
    padding: `${SIZE.rowPadY} 0`,
    ...NUM.numMd,
    ...NUMERIC,
    lineHeight: ROW_LINE,
    color: vars.color.foreground,
    textAlign: 'right',
    overflowWrap: 'anywhere',
    selectors: {
        [`${term}:not(:first-child) + &`]: { borderTop: HAIRLINE },
    },
    '@media': {
        [LOW_DPR]: { borderTopWidth: '1px' },
        [MORE_CONTRAST]: { selectors: { [`${term}:not(:first-child) + &`]: { borderTop: HAIRLINE_CONTRAST } } },
    },
});

/** 數值色：warn 不改文字色（foreground＋amber 圖示，見 account-ui Item） */
export const tone = styleVariants({
    normal: {},
    muted: { color: vars.color.mutedForeground },
    accent: { color: vars.color.accent },
    good: { color: vars.color.success },
    warn: {},
    bad: { color: vars.color.danger },
});

/** warn 數值前的 amber 圖示 */
export const warnIcon = style({
    display: 'inline-block',
    width: '0.875rem',
    height: '0.875rem',
    marginRight: SPACE.s1,
    verticalAlign: '-0.125rem',
    color: vars.color.amber,
});

export const note = style({
    margin: `${SPACE.s2} 0`,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 警示說明：foreground 文字＋3px amber 左側條（淺色 amber 對白不足 4.5:1，不用 amber 小字） */
export const warning = style({
    margin: `${SPACE.s2} 0`,
    padding: `0 0 0 ${SPACE.s2}`,
    borderLeft: `3px solid ${vars.color.amber}`,
    ...TEXT.footnote,
    color: vars.color.foreground,
});

export const actions = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACE.s2,
    margin: `${SPACE.s2} 0`,
});

/** 次要動作鍵：外觀 2.25rem、點擊區擴到 TOUCH_MIN（相鄰元素留 ≥8px）；elevatedBg＋e1 */
export const smallButton = style([expandHit, pressable, focusRing, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    minHeight: SIZE.controlCompact,
    minWidth: SIZE.controlCompact,
    margin: 0,
    padding: `0 ${SPACE.s3}`,
    border: 'none',
    borderRadius: RADIUS.md,
    background: sj.elevatedBg,
    boxShadow: elevation.e1,
    color: vars.color.foreground,
    ...TEXT.callout,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
    '@media': {
        [MORE_CONTRAST]: { boxShadow: `inset 0 0 0 1px ${vars.color.borderBright}` },
    },
}]);

// ---- 帳號槽位 ----

export const slot = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minWidth: 0,
    minHeight: TOUCH_MIN,
    ...rowDivider('&:last-of-type'),
});

export const slotLabel = style({
    flex: '0 0 auto',
    minWidth: '5.5rem',
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

export const slotValue = style({
    flex: '1 1 auto',
    minWidth: 0,
    ...TEXT.headline,
    ...NUMERIC,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

// ---- 設定列（開關、分段、數字） ----

export const settingRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minWidth: 0,
    minHeight: TOUCH_MIN,
    padding: `${SIZE.rowPadY} 0`,
    boxSizing: 'border-box',
    ...TEXT.body,
    ...rowDivider('&:last-child'),
});

export const settingLabel = style({
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
});

export const settingHint = style({
    ...TEXT.footnote,
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
    margin: 0,
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px', borderRadius: '16px' },
        '&:disabled': { cursor: 'not-allowed' },
    },
    '@media': {
        [MORE_CONTRAST]: { selectors: { '&:focus-visible': { outlineWidth: '3px' } } },
    },
});

/** 軌道：關閉 muted＋borderBright 框；開啟以 ::before accent 底色 opacity 淡入（不動畫 background） */
export const switchTrack = style({
    position: 'relative',
    display: 'block',
    width: '51px',
    height: '31px',
    boxSizing: 'border-box',
    borderRadius: '16px',
    background: vars.color.muted,
    border: `1px solid ${vars.color.borderBright}`,
    selectors: {
        '&::before': {
            content: '""',
            position: 'absolute',
            inset: '-1px',
            borderRadius: 'inherit',
            background: vars.color.accent,
            opacity: 0,
            transition: `opacity ${DUR.tone}ms ease-out`,
        },
        [`${switchButton}[aria-checked="true"] &::before`]: { opacity: 1 },
        [`${switchButton}:disabled &`]: { opacity: 0.6 },
    },
    '@media': {
        [REDUCED_MOTION]: { selectors: { '&::before': { transition: 'none' } } },
    },
});

/** 拇指：translateX 取代 left 轉場（只動畫 transform）；開啟時位移 20px（49 − 2 − 25 − 2） */
export const switchThumb = style({
    position: 'absolute',
    top: '2px',
    left: '2px',
    width: '25px',
    height: '25px',
    borderRadius: '50%',
    background: '#ffffff',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.35)',
    transform: 'translateX(0)',
    transition: `transform ${DUR.thumb}ms ${EASE.sheet}`,
    selectors: {
        [`${switchButton}[aria-checked="true"] &`]: { transform: 'translateX(20px)' },
    },
    '@media': {
        [REDUCED_MOTION]: { transition: 'none' },
    },
});

export const settingBlock = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    minWidth: 0,
    padding: `${SPACE.s3} 0`,
    ...TEXT.body,
    ...rowDivider('&:last-child'),
});

export const numberInput = style([focusRing, {
    flex: '0 0 auto',
    width: '7.5rem',
    minHeight: TOUCH_MIN,
    padding: `0 ${SPACE.s2}`,
    borderRadius: RADIUS.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: sj.islandBg,
    color: vars.color.foreground,
    fontSize: INPUT_FONT_SIZE,
    ...NUMERIC,
    textAlign: 'right',
    boxSizing: 'border-box',
    selectors: {
        '&:disabled': { opacity: 0.5 },
    },
}]);

// ---- 風控 ----

const lockBase = {
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s1_5,
    minHeight: TOUCH_MIN,
    margin: `${SPACE.s2} 0 0`,
    padding: `0 ${SPACE.s3}`,
    boxSizing: 'border-box',
    borderRadius: RADIUS.md,
    ...TEXT.headline,
} as const;

export const lockState = styleVariants({
    locked: {
        ...lockBase,
        border: `1px solid ${vars.color.danger}`,
        background: vars.color.dangerDim,
        color: vars.color.danger,
        fontWeight: 700,
    },
    open: {
        ...lockBase,
        background: sj.islandBg,
        color: vars.color.mutedForeground,
    },
});

export const lockedOnBadge = style({
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginLeft: SPACE.s1,
    padding: '1px 6px',
    borderRadius: RADIUS.sm,
    border: `1px solid ${vars.color.success}`,
    color: vars.color.success,
    ...TEXT.caption,
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
});

/** 「只對本裝置有效」說明：中性島（islandBg），foreground footnote */
export const deviceOnly = style({
    margin: `${SPACE.s2} 0`,
    padding: `${SPACE.s2} ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    ...TEXT.footnote,
    color: vars.color.foreground,
});

/** 每日流量條（ProgressBar）外距 */
export const meter = style({
    margin: `${SPACE.s2} 0 0`,
});

export const ua = style({
    gridColumn: '1 / -1',
    margin: 0,
    padding: `0 0 ${SIZE.rowPadY}`,
    fontSize: '0.75rem',
    lineHeight: 1.45,
    fontFamily: vars.font.mono,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
    minWidth: 0,
});

// ---- 共用：漲跌方向文字色（買進／正值用 up、賣出／負值用 down；文字另帶正負號，不只靠顏色） ----

export const dir = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: {},
});

export const badge = style({
    display: 'inline-block',
    marginLeft: SPACE.s1,
    padding: '0 6px',
    borderRadius: RADIUS.sm,
    border: `1px solid ${vars.color.borderBright}`,
    color: vars.color.mutedForeground,
    ...TEXT.caption,
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
});

/** 警示徽章：amber 框線＋foreground 文字（§4.8 規則 4） */
export const badgeWarn = style({ borderColor: vars.color.amber, color: vars.color.foreground });

export const toggleRow = style([focusRing, {
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s1,
    width: '100%',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: 0,
    border: 'none',
    borderRadius: RADIUS.md,
    background: 'transparent',
    color: vars.color.accent,
    ...TEXT.callout,
    textAlign: 'left',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
}]);

// ---- 期貨風險指標（role=meter 外框；填色為 ProgressBar 的 scaleX） ----

export const riskTrack = style({
    margin: `${SPACE.s1} 0 ${SPACE.s2}`,
});

// ---- 交割行事曆 ----

export const settleRow = style({
    display: 'grid',
    gridTemplateColumns: '3.25rem minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: SPACE.s2,
    minHeight: TOUCH_MIN,
    ...NUMERIC,
    ...rowDivider('&:last-of-type'),
});

export const settleTag = style({
    ...TEXT.headline,
});

export const settleDate = style({
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

export const settleAmount = style({
    textAlign: 'right',
    ...NUM.numMd,
    ...NUMERIC,
});

// ---- 今日剩餘交易額度（帳戶頁頂部卡的主值；持倉頁摘要的一行） ----

/** 主值區：caption 標籤＋numHero 金額＋已用／總額度；與下方鍵值列以髮絲線分隔 */
export const limitsHero = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    padding: `${SPACE.s3} 0`,
    minWidth: 0,
    borderBottom: HAIRLINE,
    '@media': {
        [LOW_DPR]: { borderBottomWidth: '1px' },
        [MORE_CONTRAST]: { borderBottom: HAIRLINE_CONTRAST },
    },
});

export const limitsHeroLabel = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const limitsHeroValue = style({
    ...NUM.numHero,
    ...NUMERIC,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

export const limitsHeroSub = style({
    ...TEXT.subhead,
    ...NUMERIC,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

/** 持倉頁摘要的額度列：整列可點（≥44px），標籤靠左、金額靠右，點擊跳到帳戶頁額度卡 */
export const limitsLine = style([pressable, focusRing, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: `0 ${SPACE.s2}`,
    width: '100%',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: 0,
    border: 'none',
    borderTop: HAIRLINE,
    background: 'transparent',
    color: vars.color.foreground,
    textAlign: 'left',
    font: 'inherit',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    '@media': {
        [LOW_DPR]: { borderTopWidth: '1px' },
        [MORE_CONTRAST]: { borderTop: HAIRLINE_CONTRAST },
    },
}]);

export const limitsLineLabel = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const limitsLineValue = style({
    ...NUM.numMd,
    ...NUMERIC,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

export const limitsLineNote = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 玉山估算明細（「上限 L；今日買進 已成交 A＋未成交 B」）：獨占一行、靠右，窄螢幕可換行 */
export const limitsLineSub = style({
    ...TEXT.footnote,
    ...NUMERIC,
    flexBasis: '100%',
    paddingBottom: SPACE.s2,
    color: vars.color.mutedForeground,
    textAlign: 'right',
    overflowWrap: 'anywhere',
});

// ---- 已實現損益 ----

/** 自訂區間：起日／迄日兩欄；字級「大」改單欄（日期欄文字較長，不擠壓） */
export const dateFields = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: SPACE.s2,
    margin: `${SPACE.s2} 0 0`,
    selectors: {
        'html[data-sj-font-scale="1.3"] &': { gridTemplateColumns: 'minmax(0, 1fr)' },
    },
});

/** 可見標籤（footnote）在日期欄上方；整個 label 包住 input */
export const dateField = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1,
    minWidth: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 原生日期欄：沿用 numberInput 外觀（TOUCH_MIN 高、≥16px 字級防 iOS 縮放），撐滿欄寬、靠左 */
export const dateInput = style([numberInput, {
    display: 'block',
    flex: 'none',
    width: '100%',
    minWidth: 0,
    textAlign: 'left',
    selectors: {
        // iOS Safari 的日期值預設置中
        '&::-webkit-date-and-time-value': { textAlign: 'left' },
        '&[aria-invalid="true"]': { borderColor: vars.color.danger },
    },
}]);

export const totalLine = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
    margin: `${SPACE.s1} 0 0`,
    ...NUMERIC,
});

export const totalValue = style({
    ...NUM.numLg,
    ...NUMERIC,
    // 「−$1,866,864」不可在負號後斷行（字級大時負號會單獨落到上一行）；放不下時由左側標籤換行
    whiteSpace: 'nowrap',
});

export const pnlItem = style({
    ...rowDivider('&:last-child'),
});

export const pnlRow = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    alignItems: 'center',
    columnGap: SPACE.s2,
    minHeight: TOUCH_MIN,
    ...NUMERIC,
});

export const pnlCode = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    overflow: 'hidden',
    ...TEXT.headline,
});

/**
 * 商品名稱（名稱為主；載入前為代碼）：完整顯示，放不下時換行（2026-11-11 使用者要求：原本單行省略號，
 * 右側數值欄較寬或字級大時長名稱只剩約四個字）。名稱過長換行時列高會增加。
 */
export const pnlName = style({
    overflowWrap: 'anywhere',
});

/** 名稱下方的代碼、市場或交易類別、日期或時間：同樣完整顯示、放不下時換行 */
export const pnlMeta = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

export const pnlQty = style({
    ...NUM.numSm,
    ...NUMERIC,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const pnlValue = style({
    textAlign: 'right',
    ...NUM.numMd,
    ...NUMERIC,
    whiteSpace: 'nowrap',
});

/** 「≈ 金額」不拆行（退佣合計、退佣後損益、每列退佣小字） */
export const nowrap = style({ whiteSpace: 'nowrap' });

/** 已實現損益列下方的退佣小字（靠右） */
export const pnlRebateLine = style({
    margin: `0 0 ${SPACE.s1}`,
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.mutedForeground,
    textAlign: 'right',
});

/** 明細島：islandBg（含漲跌色小字與 mutedForeground） */
export const detailBox = style({
    margin: `0 0 ${SPACE.s2}`,
    padding: `${SPACE.s2} ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    minWidth: 0,
});

export const fillCard = style({
    padding: `${SPACE.s1_5} 0`,
    borderTop: `1px dashed ${vars.color.border}`,
    ...TEXT.footnote,
    ...NUMERIC,
});

export const fillHead = style({
    display: 'flex',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    fontWeight: 600,
});

// ---- 成交明細（fill-history-card）：360 寬、字級 1.3 時不溢出（名稱單行省略、數值行可換行） ----

/** 交易日分組標題 */
export const fillsDate = style({
    margin: `${SPACE.s2} 0 0`,
    ...TEXT.subhead,
    ...NUMERIC,
    fontWeight: 600,
    color: vars.color.mutedForeground,
});

/** 一筆成交、或依股票／依日期的一列 */
export const fillsRow = style({
    padding: `${SPACE.s1_5} 0`,
    minWidth: 0,
    ...rowDivider('&:last-child'),
});

/** 第一行：名稱（代碼）與右側淨收付 */
export const fillsHead = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: SPACE.s2,
    minWidth: 0,
    ...NUMERIC,
});

/** 次要數值：逐項換行（不撐寬） */
export const fillsFacts = style({
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: SPACE.s3,
    rowGap: '0.125rem',
    minWidth: 0,
    margin: `${SPACE.s1} 0 0`,
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

/** 買／賣徽章：框線與文字用漲跌色（文字另寫「買」「賣」，不只靠顏色） */
export const sideBadge = styleVariants({
    Buy: [badge, { marginLeft: 0, marginRight: SPACE.s1, borderColor: vars.color.up, color: vars.color.up }],
    Sell: [badge, { marginLeft: 0, marginRight: SPACE.s1, borderColor: vars.color.down, color: vars.color.down }],
});
