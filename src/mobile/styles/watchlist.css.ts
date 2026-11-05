// src/mobile/styles/watchlist.css.ts — 自選、排行與搜尋面板（設計規格 §7.2、§4.7、§4.8、§6.12–§6.14）
// - 頁面表面 contentBg（淺色主題含漲跌色文字的清單放白底，§4.8 規則 9）；頁首與分段用 ui/* 共用元件。
// - 列 56px：左 headline 代碼＋subhead 名稱；右 numMd 價格（漲跌色＋PriceFlash 覆蓋層）＋漲跌膠囊
//   （實心 up／down＋inkStrong 白字 numSm 600，min-width 4.75rem、高 1.75rem、圓角 6；平盤 elevatedBg＋foreground）。
// - 髮絲線左內縮 16；捲動容器內的列用 pressableRow（延後 80ms 加深）。
// - 顏色只用 vars／sj；漲跌只用 vars.color.up／down 並附 ▲▼ 或正負號；不用 color-mix()、:has()、linear()；
//   只動畫 opacity（按壓、骨架、跳價閃爍皆由共用元件處理）。
import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from './theme-vars.css';
import { LOW_DPR, MORE_CONTRAST, RADIUS, SAFE_LEFT, SAFE_RIGHT, SIZE, SPACE, TOUCH_MIN } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

/** 頁面左右邊距（＋安全區；main 已讓出安全區時 env() 在直式為 0） */
const PAD_X = SPACE.s4;
const HAIRLINE = `0.5px solid ${vars.color.border}`;

// ---- 頁面 ----

export const page = style({
    minHeight: '100%',
    paddingBottom: SPACE.s6,
    background: sj.contentBg,
    color: vars.color.foreground,
});

/** 頁首下方的控制區（分段、清單切換、說明）：左右 16 */
export const controls = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    padding: `${SPACE.s1} calc(${PAD_X} + ${SAFE_RIGHT}) ${SPACE.s2} calc(${PAD_X} + ${SAFE_LEFT})`,
    minWidth: 0,
});

/** 清單切換（PopUpButton）靠左，不撐滿 */
export const listPicker = style({
    alignSelf: 'flex-start',
    maxWidth: '100%',
});

export const listName = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 狀態與錯誤區（InlineNote 等）：左右 16 */
export const stateBlock = style({
    padding: `${SPACE.s2} calc(${PAD_X} + ${SAFE_RIGHT}) 0 calc(${PAD_X} + ${SAFE_LEFT})`,
});

// ---- 表頭（商品｜指標切換鍵） ----

export const listHeader = style([{
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    minHeight: '28px',
    padding: `0 calc(${PAD_X} + ${SAFE_RIGHT}) 0 calc(${PAD_X} + ${SAFE_LEFT})`,
    borderBottom: HAIRLINE,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    '@media': {
        [LOW_DPR]: { borderBottomWidth: '1px' },
        [MORE_CONTRAST]: { borderBottom: `1px solid ${vars.color.borderBright}` },
    },
}]);

/**
 * 指標切換鍵：外觀 28px 文字鍵，點擊區以 ::before 上下擴到 TOUCH_MIN（左右各擴 8px）。
 * 表頭上下沒有其他可點元素（上方為控制區留白、下方為列），擴張點擊區不與相鄰元素重疊。
 */
export const metricToggle = style({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: SPACE.s1,
    minHeight: '28px',
    margin: 0,
    padding: 0,
    border: 'none',
    background: 'transparent',
    ...TEXT.footnote,
    fontWeight: 600,
    color: vars.color.accent,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&::before': {
            content: '""',
            position: 'absolute',
            left: '-8px',
            right: '-8px',
            top: `calc((28px - ${TOUCH_MIN}) / 2)`,
            bottom: `calc((28px - ${TOUCH_MIN}) / 2)`,
        },
    },
});

export const metricIcon = style({
    width: '0.875rem',
    height: '0.875rem',
    flex: '0 0 auto',
});

// ---- 清單與列 ----

export const list = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
});

/** 列容器：髮絲線畫在列底、從文字起點（左 16）開始；最後一列不畫 */
export const rowItem = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'stretch',
    minWidth: 0,
    selectors: {
        '&:not(:last-child)::after': {
            content: '""',
            position: 'absolute',
            left: `calc(${PAD_X} + ${SAFE_LEFT})`,
            right: 0,
            bottom: 0,
            height: 0,
            borderBottom: HAIRLINE,
            pointerEvents: 'none',
        },
    },
    '@media': {
        [LOW_DPR]: { selectors: { '&:not(:last-child)::after': { borderBottomWidth: '1px' } } },
        [MORE_CONTRAST]: { selectors: { '&:not(:last-child)::after': { borderBottom: `1px solid ${vars.color.borderBright}` } } },
    },
});

/** 整列可點（開交易頁），長按開操作面板；禁止 iOS 長按選字／彈出選單 */
export const row = style({
    flex: '1 1 auto',
    minWidth: 0,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    alignItems: 'center',
    columnGap: SPACE.s3,
    minHeight: '56px',
    margin: 0,
    padding: `${SPACE.s1_5} calc(${PAD_X} + ${SAFE_RIGHT}) ${SPACE.s1_5} calc(${PAD_X} + ${SAFE_LEFT})`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    textAlign: 'left',
    font: 'inherit',
    cursor: 'pointer',
    touchAction: 'pan-y',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    WebkitTapHighlightColor: 'transparent',
    outline: 'none',
    selectors: {
        '&:focus-visible': { boxShadow: `inset 0 0 0 2px ${vars.color.accent}` },
    },
    '@media': {
        [MORE_CONTRAST]: { selectors: { '&:focus-visible': { boxShadow: `inset 0 0 0 3px ${vars.color.accent}` } } },
    },
});

/** 編輯模式（列尾有「⋯」）：右邊距交給「⋯」鍵 */
export const rowEditing = style({
    paddingRight: SPACE.s1,
});

export const rowName = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0.0625rem',
    minWidth: 0,
});

export const rowTitleLine = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s1_5,
    minWidth: 0,
});

export const rowCode = style({
    ...TEXT.headline,
    ...NUMERIC,
    color: vars.color.foreground,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const rowSub = style({
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

/** 試撮（simtrade）徽章：揭示價不是成交，文字＋amber 框線（小字一律 foreground，§4.8 規則 4） */
export const simBadge = style({
    flex: '0 0 auto',
    padding: '0 0.25rem',
    borderRadius: RADIUS.xs,
    border: `1px solid ${vars.color.amber}`,
    ...TEXT.caption,
    color: vars.color.foreground,
});

/** 價格欄：價格（＋閃爍覆蓋層）與第二行 */
export const priceCell = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.0625rem',
    minWidth: 0,
});

/** 價格：numMd、漲跌色；閃爍覆蓋層的定位基準（ui/price-flash.css 的 host 另行套用） */
export const rowPrice = style({
    padding: '0 0.25rem',
    margin: '0 -0.25rem',
    borderRadius: RADIUS.xs,
    ...NUM.numMd,
    ...NUMERIC,
    textAlign: 'right',
    whiteSpace: 'nowrap',
});

/** 價格下的第二行（排行的漲跌、量）：numSm */
export const priceSub = style({
    ...NUM.numSm,
    ...NUMERIC,
    whiteSpace: 'nowrap',
    textAlign: 'right',
});

export const tone = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.flat },
});

const pillBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    boxSizing: 'border-box',
    minWidth: '4.75rem',
    height: '1.75rem',
    padding: `0 ${SPACE.s2}`,
    borderRadius: RADIUS.sm,
    ...NUM.numSm,
    ...NUMERIC,
    fontWeight: 600,
    whiteSpace: 'nowrap',
});

/**
 * 漲跌膠囊：up／down 為實心填色＋inkStrong 白字（搭配 primitives 的 fill.<tone>.strong 提供底色與疊黑）；
 * flat 與無方向指標（總量）為 elevatedBg＋foreground。
 */
export const pill = styleVariants({
    up: [pillBase],
    down: [pillBase],
    flat: [pillBase, { background: sj.elevatedBg, color: vars.color.foreground, boxShadow: `inset 0 0 0 0.5px ${vars.color.border}` }],
});

/** 列尾鍵（編輯模式「⋯」、排行「＋」）：IconButton 44×44，靠右對齊頁邊距 */
export const rowTrailing = style({
    alignSelf: 'center',
    marginRight: `calc(${SPACE.s1} + ${SAFE_RIGHT})`,
    color: vars.color.mutedForeground,
});

// ---- 長按操作面板 ----

export const actionSheet = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s4,
    paddingTop: SPACE.s1,
});

// GroupedSection 預設左右內縮 16（頁面用）；面板 body 已有內距，這裡歸零（同 order-action.css.ts）
globalStyle(`${actionSheet} section`, { marginLeft: 0, marginRight: 0 });

/** 買／賣方向小膠囊（ListRow leading；文字＋實心 up／down，fill.<tone>.strong 提供底色） */
export const sideBadge = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.5rem',
    height: '1.5rem',
    borderRadius: RADIUS.sm,
    ...TEXT.caption,
    fontWeight: 700,
});

/** 移除列：與 ListRow 同版面，文字 danger（狀態色，不隨配色翻轉） */
export const dangerRow = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `0.6875rem ${SPACE.s4}`,
    border: 'none',
    background: 'transparent',
    ...TEXT.headline,
    color: vars.color.danger,
    textAlign: 'left',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
});

// ---- 排行（ranking-list.tsx） ----

export const rankControls = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    padding: `0 calc(${PAD_X} + ${SAFE_RIGHT}) ${SPACE.s2} calc(${PAD_X} + ${SAFE_LEFT})`,
    minWidth: 0,
});

export const rankMeta = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
    minWidth: 0,
});

/** 「更新於 hh:mm:ss」：caption 字級改 footnote（mutedForeground 在 contentBg 上） */
export const rankMetaText = style({
    flex: '1 1 auto',
    minWidth: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 更新鍵：compact 外觀（2.25rem）＋點擊區擴到 TOUCH_MIN（ui/chip.css 的 expandHit） */
export const rankRefresh = style({
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: SIZE.controlCompact,
    padding: `0 ${SPACE.s3}`,
    margin: 0,
    borderRadius: RADIUS.md,
    border: `0.5px solid ${vars.color.border}`,
    background: sj.elevatedBg,
    color: vars.color.foreground,
    ...TEXT.callout,
    ...NUMERIC,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
    '@media': {
        [MORE_CONTRAST]: { border: `1px solid ${vars.color.borderBright}` },
    },
});

/** 排行列：名次｜名稱代碼（＋量）｜成交價＋漲跌｜漲跌%膠囊 */
export const rankRow = style([row, {
    gridTemplateColumns: '1.5rem minmax(0, 1fr) auto auto',
    paddingRight: SPACE.s1,
}]);

export const rankNo = style({
    ...NUM.numSm,
    ...NUMERIC,
    color: vars.color.mutedForeground,
    textAlign: 'center',
});

// ---- 搜尋面板（search-sheet.tsx） ----

/** 搜尋欄：面板 body 內 sticky 頂端；不透明（面板底色），不模糊（§4.6：sticky 列不用 backdrop-filter） */
export const searchBar = style({
    position: 'sticky',
    top: 0,
    zIndex: 1,
    margin: `0 calc(-1 * ${vars.space.md})`,
    padding: `${SPACE.s1} ${vars.space.md} ${SPACE.s2}`,
    background: vars.color.panel,
});

export const searchInput = style({
    display: 'block',
    width: '100%',
    minHeight: TOUCH_MIN,
    padding: `0 ${SPACE.s3}`,
    boxSizing: 'border-box',
    borderRadius: RADIUS.md,
    border: `1px solid ${vars.color.border}`,
    background: sj.islandBg,
    color: vars.color.foreground,
    // 輸入字級 ≥16px（避免 iOS 聚焦放大）
    fontSize: 'max(16px, 1rem)',
    WebkitAppearance: 'none',
    appearance: 'none',
    selectors: {
        '&::placeholder': { color: vars.color.mutedForeground },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
    '@media': {
        [MORE_CONTRAST]: { border: `1px solid ${vars.color.borderBright}` },
    },
});

export const searchStatus = style({
    margin: `${SPACE.s2} 0`,
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

export const resultList = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
});

export const resultItem = style({
    position: 'relative',
    minWidth: 0,
    selectors: {
        '&:not(:last-child)': { borderBottom: HAIRLINE },
    },
    '@media': {
        [LOW_DPR]: { selectors: { '&:not(:last-child)': { borderBottomWidth: '1px' } } },
        [MORE_CONTRAST]: { selectors: { '&:not(:last-child)': { borderBottom: `1px solid ${vars.color.borderBright}` } } },
    },
});

export const resultRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minHeight: '56px',
    minWidth: 0,
});

/** 結果主鍵（開交易頁）：與自選列同樣式（代碼 headline＋名稱、第二行種類） */
export const resultMain = style({
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: '0.0625rem',
    alignSelf: 'stretch',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `${SPACE.s1_5} 0`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    textAlign: 'left',
    font: 'inherit',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    outline: 'none',
    selectors: {
        '&:focus-visible': { boxShadow: `inset 0 0 0 2px ${vars.color.accent}`, borderRadius: RADIUS.md },
    },
});

export const resultName = style({
    ...TEXT.headline,
    fontWeight: 400,
    color: vars.color.foreground,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

/** 結果列尾的晶片（加入自選、交易）：沿用 ui/chip.css 的 chip 外觀，再固定不換行 */
export const resultChip = style({
    flex: '0 0 auto',
});

/** 加入失敗訊息：小字一律 foreground，amber 只用於左側條（§4.8 規則 4） */
export const resultMessage = style({
    margin: `0 0 ${SPACE.s2}`,
});
