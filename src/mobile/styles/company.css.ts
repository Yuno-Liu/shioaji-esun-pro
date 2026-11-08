// src/mobile/styles/company.css.ts — 交易頁「公司」分頁（桌面 company-panel 的手機版）
// - 區塊為 groupedBg 卡片（左右內縮 16＋安全區、圓角 12）；含 mutedForeground 小字的格子放 islandBg 中性島（§4.8 規則 7）。
// - 漲跌只用 vars.color.up／down（隨台灣／國際配色），並附 ▲▼ 與正負號；營收組成、營收長條用中性色（不暗示漲跌）。
// - 可點元素 ≥ TOUCH_MIN（compact 晶片以 expandHit 擴張點擊區，換行列距 8px 不重疊）。
// - 只動畫 opacity（圖表淡入）；減少動態時不動畫。iOS 15.4：不用 color-mix、:has()、容器查詢。
import { globalStyle, keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { expandHit } from '../ui/chip.css';
import { elevation, sj } from './theme-vars.css';
import { DUR, EASE, LOW_DPR, MORE_CONTRAST, RADIUS, REDUCED_MOTION, SAFE_LEFT, SAFE_RIGHT, SIZE, SPACE, TOUCH_MIN } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

const HAIRLINE = `0.5px solid ${vars.color.border}`;
const CONTRAST_LINE = `1px solid ${vars.color.borderBright}`;
const HAIRLINE_MEDIA = {
    border: { [LOW_DPR]: { borderWidth: '1px' }, [MORE_CONTRAST]: { border: CONTRAST_LINE } },
    borderTop: { [LOW_DPR]: { borderTopWidth: '1px' }, [MORE_CONTRAST]: { borderTop: CONTRAST_LINE } },
};

export const root = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    padding: `${SPACE.s2} 0 ${SPACE.s4}`,
    minWidth: 0,
});

/** 子分頁（概覽／財務／上下游／來源）列 */
export const subTabs = style({
    padding: `${SPACE.s1} calc(${SPACE.s4} + ${SAFE_RIGHT}) ${SPACE.s1} calc(${SPACE.s4} + ${SAFE_LEFT})`,
    minWidth: 0,
});

export const panel = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    minWidth: 0,
});

// ---- 卡片與區塊標頭 ----

export const card = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    marginLeft: `calc(${SPACE.s4} + ${SAFE_LEFT})`,
    marginRight: `calc(${SPACE.s4} + ${SAFE_RIGHT})`,
    padding: `${SPACE.s3} ${SPACE.s4}`,
    borderRadius: RADIUS.lg,
    background: sj.groupedBg,
    minWidth: 0,
    color: vars.color.foreground,
});

export const sectionHead = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACE.s2,
    minWidth: 0,
});

export const sectionTitle = style({
    margin: 0,
    ...TEXT.headline,
    color: vars.color.foreground,
});

export const sectionMeta = style({
    display: 'inline-flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACE.s1_5,
    marginLeft: 'auto',
    minWidth: 0,
});

export const prose = style({
    margin: 0,
    ...TEXT.body,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

export const footnote = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

export const muted = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

// ---- 標示晶片（文字一律 foreground；狀態色只用在框線，§4.8 規則 4、10） ----

const tagBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    padding: '0.125rem 0.375rem',
    borderRadius: RADIUS.xs,
    border: `1px solid ${vars.color.border}`,
    background: sj.islandBg,
    ...TEXT.caption,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const tag = styleVariants({
    neutral: [tagBase],
    official: [tagBase, { borderColor: vars.color.success }],
    thirdParty: [tagBase, { borderColor: vars.color.amber }],
    accent: [tagBase, { borderColor: vars.color.accent }],
    stale: [tagBase, { borderColor: vars.color.amber }],
});

export const tagIcon = style({
    width: '0.75rem',
    height: '0.75rem',
    flex: '0 0 auto',
});

// ---- 標頭（代碼、名稱、市場、英文簡稱、價格、產業別與研究分類） ----

export const headRow = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: `${SPACE.s1} ${SPACE.s2}`,
    minWidth: 0,
});

export const headCode = style({
    ...NUM.numMd,
    ...NUMERIC,
    color: vars.color.foreground,
});

export const headName = style({
    ...TEXT.headline,
    color: vars.color.foreground,
});

export const headEnglish = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const headPrice = style({
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: SPACE.s1_5,
    marginLeft: 'auto',
});

export const headPriceValue = style({
    ...NUM.numMd,
    ...NUMERIC,
});

export const headPriceChange = style({
    ...NUM.numSm,
    ...NUMERIC,
});

export const crumbs = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACE.s1_5,
    minWidth: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const crumbStrong = style({
    color: vars.color.foreground,
    fontWeight: 600,
});

export const crumbSep = style({
    width: '0.75rem',
    height: '0.75rem',
    flex: '0 0 auto',
    color: vars.color.mutedForeground,
});

/** 漲跌色（只用 up／down；平盤 foreground） */
export const dirText = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.foreground },
});

// ---- 指標（市值、本益比、月營收、毛利率／淨利率） ----

export const kpis = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: SPACE.s2,
    minWidth: 0,
});

export const kpi = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    padding: `${SPACE.s2} ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    minWidth: 0,
});

export const kpiLabel = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const kpiValue = style({
    ...NUM.numMd,
    ...NUMERIC,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

export const kpiSub = style({
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

// ---- 產業鏈位置（上／中／下游直式；每段一列可換行的晶片） ----

export const chain = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    minWidth: 0,
});

export const tierRow = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: SPACE.s2,
    minWidth: 0,
});

export const tierLabel = style({
    flex: '0 0 2.25rem',
    ...TEXT.caption,
    // 對齊晶片（2.25rem）中線
    lineHeight: SIZE.controlCompact,
    color: vars.color.mutedForeground,
});

export const stageWrap = style({
    display: 'flex',
    flexWrap: 'wrap',
    // 列距 8px：compact 晶片的擴張點擊區（上下各 4px）不重疊
    gap: SPACE.s2,
    flex: '1 1 auto',
    minWidth: 0,
});

const chipButton = style([expandHit, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    minHeight: SIZE.controlCompact,
    margin: 0,
    padding: '0 0.625rem',
    borderRadius: RADIUS.md,
    border: HAIRLINE,
    background: sj.elevatedBg,
    boxShadow: elevation.e1,
    ...TEXT.callout,
    color: vars.color.foreground,
    textAlign: 'left',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&[aria-pressed="true"]': { boxShadow: `${elevation.e1}, 0 0 0 2px ${vars.color.accent}` },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
        // 沒有產業鏈資料時不能展開，但文字仍要清楚可讀（不降透明度）
        '&:disabled': { cursor: 'default', boxShadow: 'none' },
    },
    '@media': HAIRLINE_MEDIA.border,
}]);

export const stage = styleVariants({
    own: [chipButton, { background: vars.color.accentDim, borderColor: vars.color.accent, color: vars.color.foreground, fontWeight: 600 }],
    also: [chipButton, { borderStyle: 'dashed', borderColor: vars.color.accent, borderWidth: '1px' }],
    other: [chipButton, { color: vars.color.mutedForeground }],
});

// ---- 營收組成 ----

export const mixBar = style({
    display: 'flex',
    height: '0.625rem',
    borderRadius: RADIUS.pill,
    overflow: 'hidden',
    background: vars.color.muted,
    minWidth: 0,
});

export const mixSegment = style({
    display: 'block',
    height: '100%',
    background: vars.color.accent,
    flex: '0 0 auto',
});

export const mixList = style({
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const mixItem = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minHeight: '1.75rem',
    ...TEXT.subhead,
    color: vars.color.foreground,
});

export const swatch = style({
    flex: '0 0 auto',
    width: '0.625rem',
    height: '0.625rem',
    borderRadius: '2px',
    background: vars.color.accent,
});

export const mixName = style({
    flex: '1 1 auto',
    minWidth: 0,
    overflowWrap: 'anywhere',
});

export const mixPct = style({
    flex: '0 0 auto',
    ...NUM.numSm,
    ...NUMERIC,
});

// ---- 題材 ----

export const themeChips = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: SPACE.s2,
    minWidth: 0,
});

export const themeChip = style([chipButton, {
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 0,
    minHeight: TOUCH_MIN,
    padding: `0.25rem 0.625rem`,
}]);

export const themeName = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    ...TEXT.callout,
    color: vars.color.foreground,
});

export const themeStage = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const starIcon = style({
    width: '0.75rem',
    height: '0.75rem',
    color: vars.color.amber,
    flex: '0 0 auto',
});

// ---- 名單（題材成員、上下游）：中性島內的列 ----

export const list = style({
    display: 'flex',
    flexDirection: 'column',
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    overflow: 'hidden',
    minWidth: 0,
});

export const listHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
    paddingLeft: SPACE.s3,
    ...TEXT.subhead,
    fontWeight: 600,
    color: vars.color.foreground,
});

export const listHeadTitle = style({
    flex: '1 1 auto',
    minWidth: 0,
    overflowWrap: 'anywhere',
});

export const count = style({
    flex: '0 0 auto',
    padding: '0 0.375rem',
    borderRadius: RADIUS.pill,
    background: vars.color.muted,
    ...TEXT.caption,
    ...NUMERIC,
    color: vars.color.foreground,
});

const rowBase = style({
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    columnGap: SPACE.s2,
    rowGap: '0.125rem',
    alignItems: 'baseline',
    width: '100%',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `0.5rem ${SPACE.s3}`,
    boxSizing: 'border-box',
    border: 'none',
    borderTop: HAIRLINE,
    background: 'transparent',
    font: 'inherit',
    color: vars.color.foreground,
    textAlign: 'left',
    minWidth: 0,
    '@media': HAIRLINE_MEDIA.borderTop,
});

export const row = rowBase;

/** 可開交易頁的列（按鈕）：按下延後 80ms 加深（同 primitives.pressableRow） */
export const rowLink = style([rowBase, {
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&::after': {
            content: '""',
            position: 'absolute',
            inset: 0,
            background: vars.color.foreground,
            opacity: 0,
            pointerEvents: 'none',
            transition: `opacity ${DUR.fade}ms ease-out`,
        },
        '&:not(:disabled):active::after': { opacity: 0.08, transition: `opacity 0s linear ${DUR.press}ms` },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
}]);

export const rowName = style({
    display: 'inline-flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: `0 ${SPACE.s1_5}`,
    minWidth: 0,
    ...TEXT.subhead,
    fontWeight: 600,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

export const rowCode = style({
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.accent,
    fontWeight: 600,
});

export const rowEnd = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: SPACE.s1_5,
    justifySelf: 'end',
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const rowDetail = style({
    gridColumn: '1 / -1',
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

export const foreignIcon = style({
    width: '0.75rem',
    height: '0.75rem',
    flex: '0 0 auto',
    alignSelf: 'center',
    color: vars.color.mutedForeground,
});

/** 「顯示全部／收合」 */
export const more = style({
    display: 'block',
    width: '100%',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `0 ${SPACE.s3}`,
    border: 'none',
    borderTop: HAIRLINE,
    background: 'transparent',
    ...TEXT.callout,
    color: vars.color.accent,
    textAlign: 'center',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
    '@media': HAIRLINE_MEDIA.borderTop,
});

// ---- 基本資料、資料時點（dl） ----

export const facts = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(4.5rem, auto) minmax(0, 1fr)',
    columnGap: SPACE.s3,
    rowGap: SPACE.s2,
    margin: 0,
    minWidth: 0,
});

globalStyle(`${facts} > dt`, {
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    alignSelf: 'center',
});

globalStyle(`${facts} > dd`, {
    margin: 0,
    minWidth: 0,
    ...TEXT.subhead,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

export const mono = style({ ...NUMERIC });

// ---- 外部連結（新分頁；≥44px 點擊高度） ----

export const link = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    minHeight: TOUCH_MIN,
    ...TEXT.subhead,
    color: vars.color.accent,
    textDecoration: 'none',
    overflowWrap: 'anywhere',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const linkIcon = style({
    width: '0.75rem',
    height: '0.75rem',
    flex: '0 0 auto',
});

export const sourceList = style({
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const sourceItem = style({
    display: 'flex',
    flexDirection: 'column',
    paddingBottom: SPACE.s1_5,
    minWidth: 0,
    selectors: {
        '& + &': { borderTop: HAIRLINE, paddingTop: SPACE.s1 },
    },
});

export const sourceTitle = style({
    ...TEXT.subhead,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
    padding: `${SPACE.s2} 0`,
});

// ---- 月營收圖（SVG；寬度跟容器，文字在 SVG 外不會被縮放） ----

const fadeIn = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

export const chartBox = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
});

export const chartSvg = style({
    display: 'block',
    width: '100%',
    height: '7.25rem',
    overflow: 'visible',
    animation: `${fadeIn} ${DUR.thumb}ms ${EASE.out}`,
    '@media': { [REDUCED_MOTION]: { animation: 'none' } },
});

export const chartBar = style({ fill: vars.color.mutedForeground });

export const chartZero = style({
    stroke: vars.color.mutedForeground,
    strokeWidth: 1,
    strokeDasharray: '2 3',
    opacity: 0.6,
});

export const chartLine = style({
    fill: 'none',
    stroke: vars.color.accent,
    strokeWidth: 1.5,
});

export const chartAxis = style({
    display: 'flex',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.mutedForeground,
});

export const legend = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${SPACE.s1} ${SPACE.s3}`,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const legendKey = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: SPACE.s1,
});

export const legendBar = style([swatch, { background: vars.color.mutedForeground, opacity: 0.5 }]);
export const legendLine = style({
    display: 'inline-block',
    width: '0.875rem',
    height: '2px',
    borderRadius: '1px',
    background: vars.color.accent,
});

// ---- 小表（可橫向捲動） ----

export const tableScroll = style({
    overflowX: 'auto',
    overflowY: 'hidden',
    minWidth: 0,
    // 橫向捲動交給瀏覽器；垂直仍是頁面捲動
    touchAction: 'pan-x pan-y',
});

export const table = style({
    width: '100%',
    borderCollapse: 'collapse',
    whiteSpace: 'nowrap',
});

globalStyle(`${table} th`, {
    padding: `${SPACE.s1_5} ${SPACE.s2}`,
    ...TEXT.caption,
    color: vars.color.mutedForeground,
    textAlign: 'right',
    borderBottom: HAIRLINE,
});

globalStyle(`${table} td`, {
    padding: `${SPACE.s1_5} ${SPACE.s2}`,
    ...NUM.numSm,
    ...NUMERIC,
    color: vars.color.foreground,
    textAlign: 'right',
});

globalStyle(`${table} tbody tr + tr td`, { borderTop: HAIRLINE });

globalStyle(`${table} th:first-child, ${table} td:first-child`, {
    textAlign: 'left',
    paddingLeft: 0,
});

/** 表格標題（單位等）：靠左、在表格上方，隨表格一起橫向捲動 */
export const tableCaption = style({
    captionSide: 'top',
    textAlign: 'left',
    paddingBottom: SPACE.s1,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    whiteSpace: 'normal',
});

// ---- 估值與體質（財務子分頁頂部） ----

/** 盈餘品質的文字結論（不只靠顏色：現金流高於／低於淨利寫成文字） */
export const valuationNote = style({
    margin: 0,
    ...TEXT.subhead,
    ...NUMERIC,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

// ---- 頁尾（資料標示、版本、離線快取、重新檢查） ----

export const foot = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACE.s2,
    marginLeft: `calc(${SPACE.s4} + ${SAFE_LEFT})`,
    marginRight: `calc(${SPACE.s4} + ${SAFE_RIGHT})`,
    minWidth: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const footText = style({
    display: 'inline-flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACE.s1_5,
    flex: '1 1 12rem',
    minWidth: 0,
});

export const textButton = style({
    flex: '0 0 auto',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `0 ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    border: HAIRLINE,
    background: sj.elevatedBg,
    ...TEXT.callout,
    color: vars.color.foreground,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
    '@media': HAIRLINE_MEDIA.border,
});

/** 錯誤狀態外框（區塊內） */
export const state = style({
    padding: `${SPACE.s2} calc(${SPACE.s4} + ${SAFE_RIGHT}) ${SPACE.s2} calc(${SPACE.s4} + ${SAFE_LEFT})`,
    minWidth: 0,
});
